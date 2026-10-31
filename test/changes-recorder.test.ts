/**
 * Unit tests for the jj per-turn change recorder.
 *
 * The reader is a scripted fake, so these tests cover the recording rules
 * (baseline, tool-result gate, unchanged working copy, fail-open, disposal)
 * without a real jj process. Repository-format parsing is covered by the
 * changes-diff/changes-jj tests and the Host-entry integration test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceDiffHunk } from '@deepseek-ai/dsh-workspace-changes/types';
import { TurnChangesRecorder, type ChangesSessionLike } from '../src/changes-recorder.ts';
import type { JjChangesReader, ParsedChange, ParsedChangeStatus, SnapshotCommit } from '../src/changes-types.ts';

/** One Session event appended by the fake Session. */
interface RecordedEvent {
  readonly type: string;
  readonly data: unknown;
  readonly seq: number;
}

/** Fake `Session`: appends events and hands out increasing sequence numbers. */
interface FakeSession extends ChangesSessionLike {
  readonly events: RecordedEvent[];
}

/**
 * Build one fake Session.
 *
 * @param id - Session id used as the recorder's key.
 * @returns the fake Session with its collected events.
 */
function makeSession(id: string): FakeSession {
  const events: RecordedEvent[] = [];
  let seq = 0;
  return {
    id,
    events,
    append(type: string, data: unknown) {
      const event = { type, data, seq: (seq += 1) };
      events.push(event);
      return event;
    },
  };
}

/** One scripted reader result: a value, a thrown error, or a deferred promise. */
type Step<T> = { readonly value: T } | { readonly error: Error } | { readonly wait: Promise<T> };

/** Reader calls observed by the fake. */
interface ReaderCalls {
  readonly commits: Array<{ readonly cwd: string; readonly signal: AbortSignal | undefined }>;
  readonly diffs: Array<{ readonly cwd: string; readonly from: string; readonly to: string }>;
}

/** Fake `JjChangesReader` plus the calls it observed. */
interface FakeReader {
  readonly reader: JjChangesReader;
  readonly calls: ReaderCalls;
}

/** One scripted snapshot: a bare commit id (no refusal) or a full snapshot. */
type ScriptedCommit = string | SnapshotCommit | undefined;

/** Normalize a scripted snapshot: the bare-id shorthand carries no refused file. */
function normalizeCommit(value: ScriptedCommit): SnapshotCommit | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? { id: value, refused: [] } : value;
}

/**
 * Build a fake reader driven by a script; running out of scripted steps throws,
 * which makes an unexpected extra read show up as a warning failure.
 *
 * @param script - scripted results consumed in call order.
 * @returns the reader and the observed call log.
 */
function makeReader(script: {
  readonly commits: Step<ScriptedCommit>[];
  readonly diffs: Step<readonly ParsedChange[] | undefined>[];
}): FakeReader {
  const calls: ReaderCalls = { commits: [], diffs: [] };
  const reader: JjChangesReader = {
    async readCommit(options) {
      calls.commits.push({ cwd: options.cwd, signal: options.signal });
      const step = script.commits.shift();
      if (step === undefined) throw new Error('unscripted readCommit');
      return normalizeCommit(await resolveStep(step));
    },
    async readDiff(options) {
      calls.diffs.push({ cwd: options.cwd, from: options.from, to: options.to });
      const step = script.diffs.shift();
      if (step === undefined) throw new Error('unscripted readDiff');
      return resolveStep(step);
    },
  };
  return { reader, calls };
}

/**
 * Resolve one scripted step.
 *
 * @param step - the scripted value, error, or deferred promise.
 * @returns the resolved value.
 */
async function resolveStep<T>(step: Step<T>): Promise<T> {
  if ('error' in step) throw step.error;
  if ('wait' in step) return step.wait;
  return step.value;
}

/** Deferred value the test resolves by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/**
 * Create a promise and its manual resolver.
 *
 * @returns the deferred value.
 */
function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}

/** Let the recorder's queued microtasks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Recorder under test plus its fake reader and collected warnings. */
interface Harness {
  readonly recorder: TurnChangesRecorder;
  readonly reader: FakeReader;
  readonly warnings: string[];
}

/**
 * Build a recorder over the fake reader.
 *
 * @param script - scripted reader results.
 * @param bounds - overrides for the file caps and home directory.
 * @returns the recorder harness.
 */
function makeRecorder(
  script: {
    readonly commits: Step<ScriptedCommit>[];
    readonly diffs: Step<readonly ParsedChange[] | undefined>[];
  },
  bounds: { readonly maxFiles?: number; readonly maxFileBytes?: number; readonly home?: string } = {},
): Harness {
  const reader = makeReader(script);
  const warnings: string[] = [];
  const recorder = new TurnChangesRecorder({
    reader: reader.reader,
    maxFiles: bounds.maxFiles ?? 10,
    maxFileBytes: bounds.maxFileBytes ?? 4096,
    home: bounds.home ?? '/home/test',
    warn: (message) => warnings.push(message),
  });
  return { recorder, reader, warnings };
}

/** Options for one scripted `ParsedChange`. */
interface ParsedFileOptions {
  readonly path: string;
  readonly status?: ParsedChangeStatus;
  readonly oldPath?: string;
  readonly added?: number;
  readonly deleted?: number;
  readonly binary?: boolean;
  readonly hunks?: readonly WorkspaceDiffHunk[];
  readonly diffBytes?: number;
}

/**
 * Build one scripted parsed change.
 *
 * @param options - fields overriding the `modified` default.
 * @returns the parsed change.
 */
function parsedFile(options: ParsedFileOptions): ParsedChange {
  return {
    status: options.status ?? 'modified',
    path: options.path,
    ...(options.oldPath === undefined ? {} : { oldPath: options.oldPath }),
    added: options.added ?? 0,
    deleted: options.deleted ?? 0,
    binary: options.binary ?? false,
    hunks: options.hunks ?? [],
    diffBytes: options.diffBytes ?? 16,
  };
}

/** One hunk with the given body and line spans. */
function hunk(
  lines: readonly string[],
  spans: { readonly oldLines: number; readonly newLines: number },
): WorkspaceDiffHunk {
  return { oldStart: 1, oldLines: spans.oldLines, newStart: 1, newLines: spans.newLines, lines: [...lines] };
}

/**
 * Open one turn, note one tool result, and await the record.
 *
 * @param harness - recorder under test.
 * @param session - the Session.
 * @param turn - turn number (default 1).
 * @param paths - working directory and workspace root (default `/repo`).
 */
async function recordTurn(
  harness: Harness,
  session: FakeSession,
  turn = 1,
  paths: { readonly cwd?: string; readonly root?: string } = {},
): Promise<void> {
  const cwd = paths.cwd ?? '/repo';
  const root = paths.root ?? '/repo';
  harness.recorder.startTurn(session, { turn, cwd, root });
  harness.recorder.noteToolResult(session, turn, 7);
  await harness.recorder.stopping(session, turn);
}

test('records one workspace/changes event with a display-sorted summary', async () => {
  const hunks = [hunk([' one', '+two'], { oldLines: 1, newLines: 2 })];
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [
      {
        value: [parsedFile({ path: 'b.txt', added: 2 }), parsedFile({ path: 'a.txt', added: 1, deleted: 1, hunks })],
      },
    ],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);

  assert.equal(session.events.length, 1);
  const event = session.events[0];
  assert.equal(event.type, 'workspace/changes');
  assert.deepEqual(event.data, { turn: 1 });
  assert.equal(recorderSummary(harness, session, event).total, 2);

  const summary = harness.recorder.summary(session.id, event.seq);
  assert.ok(summary !== undefined);
  assert.equal(summary.turn, 1);
  assert.equal(summary.cwd, '/repo');
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['a.txt', 'b.txt'],
    'files are sorted by display path',
  );
  assert.deepEqual(summary.files[0], { path: 'a.txt', display: 'a.txt', added: 1, deleted: 1 });
  assert.deepEqual(summary.files[1], { path: 'b.txt', display: 'b.txt', added: 2, deleted: 0 });
  assert.equal(summary.total, 2);
  assert.equal(summary.added, 3, 'the complete added count, including listed files');
  assert.equal(summary.deleted, 1);
  assert.equal(summary.snapshot, undefined, 'the jj recorder has no Git tree ids');
  assert.deepEqual(harness.reader.calls.diffs, [{ cwd: '/repo', from: 'base', to: 'end' }]);
  assert.equal(harness.recorder.ownsSeq(session.id, event.seq), true);
  assert.equal(harness.recorder.ownsSeq(session.id, event.seq + 100), false);
});

test('appends nothing when the working-copy commit did not change', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'same' }, { value: 'same' }],
    diffs: [],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  assert.equal(session.events.length, 0);
  assert.equal(harness.reader.calls.commits.length, 2, 'the turn-end commit was still read');
  assert.equal(harness.reader.calls.diffs.length, 0);
  assert.deepEqual(harness.warnings, []);
});

test('lists a new file jj refused to snapshot as an oversized entry', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: { id: 'end', refused: ['/repo/big.bin'] } }],
    diffs: [{ value: [parsedFile({ path: 'a.txt', added: 2 })] }],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['a.txt', 'big.bin'],
    'the refused file is merged into the display-sorted list',
  );
  const index = summary.files.findIndex((file) => file.path === 'big.bin');
  assert.deepEqual(summary.files[index], {
    path: 'big.bin',
    display: 'big.bin',
    added: 0,
    deleted: 0,
    oversized: true,
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.added, 2, 'the oversized file contributes no line counts');
  assert.equal(summary.deleted, 0);
  const diff = await harness.recorder.diff(session.id, 1, index, new AbortController().signal);
  assert.deepEqual(diff, { kind: 'oversized', path: 'big.bin', display: 'big.bin' });
});

test('records a refused file even though it leaves the working-copy commit untouched', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'same' }, { value: { id: 'same', refused: ['/repo/big.bin'] } }],
    diffs: [],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  assert.equal(session.events.length, 1, 'something changed even though the commit id did not move');
  assert.equal(harness.reader.calls.diffs.length, 0, 'there is no diff to read');
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(summary.files, [{ path: 'big.bin', display: 'big.bin', added: 0, deleted: 0, oversized: true }]);
  assert.equal(summary.total, 1);
});

test('does not list a refused file that already existed at turn start', async () => {
  const harness = makeRecorder({
    commits: [
      { value: { id: 'base', refused: ['/repo/old.bin'] } },
      { value: { id: 'end', refused: ['/repo/old.bin', '/repo/new.bin'] } },
    ],
    diffs: [{ value: [parsedFile({ path: 'a.txt', added: 1 })] }],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['a.txt', 'new.bin'],
    'only the refusal that appeared during this turn is recorded',
  );
});

test('resolves a refused path through the same display rules as a diff entry', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: { id: 'end', refused: ['/repo/sub/big.bin', '/repo/root.bin'] } }],
    diffs: [{ value: [parsedFile({ path: 'sub/b.txt', added: 1 })] }],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session, 1, { cwd: '/repo/sub', root: '/repo' });
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(
    summary.files.map((file) => [file.path, file.display]),
    [
      ['/repo/root.bin', '../root.bin'],
      ['b.txt', 'b.txt'],
      ['big.bin', 'big.bin'],
    ],
    'refused files use the working-directory-relative path and display',
  );
});

test('does not duplicate a refused path that a diff entry also reports', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: { id: 'end', refused: ['/repo/a.txt'] } }],
    diffs: [{ value: [parsedFile({ path: 'a.txt', added: 1 })] }],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(summary.files, [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 0 }]);
  assert.equal(summary.total, 1, 'the diff entry wins over the defensive refusal entry');
});

test('appends nothing when the turn ran no tool', async () => {
  const harness = makeRecorder({ commits: [{ value: 'base' }], diffs: [] });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  await harness.recorder.stopping(session, 1);
  await settle();
  assert.equal(session.events.length, 0);
  assert.equal(harness.reader.calls.commits.length, 1, 'no turn-end snapshot is read');
});

test('ignores a tool result noted for a different turn', async () => {
  const harness = makeRecorder({ commits: [{ value: 'base' }], diffs: [] });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 2, 9);
  await harness.recorder.stopping(session, 1);
  await settle();
  assert.equal(session.events.length, 0);
});

test('fails open when the baseline read throws, reporting one warning', async () => {
  const harness = makeRecorder({ commits: [{ error: new Error('jj exploded\nsecond line') }], diffs: [] });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 1, 7);
  await assert.doesNotReject(harness.recorder.stopping(session, 1));
  assert.equal(session.events.length, 0);
  assert.equal(harness.warnings.length, 1);
  assert.ok(harness.warnings[0].startsWith('workspace-changes: jj: '));
  assert.ok(harness.warnings[0].includes('jj exploded second line'), 'newlines are collapsed');
  assert.equal(harness.warnings[0].includes('\n'), false);
});

test('fails open when the baseline read resolves nothing', async () => {
  const harness = makeRecorder({ commits: [{ value: undefined }], diffs: [] });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  assert.equal(session.events.length, 0);
  assert.deepEqual(harness.warnings, []);
});

test('appends nothing when the turn diff is unavailable or empty', async () => {
  for (const diff of [undefined, [] as readonly ParsedChange[]]) {
    const harness = makeRecorder({
      commits: [{ value: 'base' }, { value: 'end' }],
      diffs: [{ value: diff }],
    });
    const session = makeSession('s1');
    await recordTurn(harness, session);
    assert.equal(session.events.length, 0);
    assert.deepEqual(harness.warnings, []);
  }
});

test('a failed diff read warns and does not poison the next turn', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }, { value: 'base2' }, { value: 'end2' }],
    diffs: [{ error: new Error('stale working copy') }, { value: [parsedFile({ path: 'a.txt', added: 1 })] }],
  });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 1, 3);
  await harness.recorder.stopping(session, 1);
  assert.equal(session.events.length, 0);
  assert.equal(harness.warnings.length, 1);
  assert.ok(harness.warnings[0].includes('stale working copy'));

  harness.recorder.startTurn(session, { turn: 2, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 2, 8);
  await harness.recorder.stopping(session, 2);
  assert.equal(session.events.length, 1);
  assert.deepEqual(session.events[0].data, { turn: 2 });
});

test('stopping resolves only after the queued event exists', async () => {
  const gate = deferred<readonly ParsedChange[]>();
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [{ wait: gate.promise }],
  });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 1, 7);
  const pending = harness.recorder.stopping(session, 1);
  await settle();
  assert.equal(session.events.length, 0, 'the event waits for the finished diff');
  gate.resolve([parsedFile({ path: 'a.txt', added: 1 })]);
  await pending;
  assert.equal(session.events.length, 1);
});

test('end() records when stopping was never called and never appends twice', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [{ value: [parsedFile({ path: 'a.txt', added: 1 })] }],
  });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 1, 7);
  harness.recorder.end(session, 1);
  await settle();
  assert.equal(session.events.length, 1, 'the fallback is the only record');

  harness.recorder.end(session, 1);
  await settle();
  assert.equal(session.events.length, 1, 'the fallback does not append after a record');

  const second = makeSession('s2');
  const scripted = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [{ value: [parsedFile({ path: 'b.txt', added: 1 })] }],
  });
  scripted.recorder.startTurn(second, { turn: 5, cwd: '/repo', root: '/repo' });
  scripted.recorder.noteToolResult(second, 5, 2);
  await scripted.recorder.stopping(second, 5);
  scripted.recorder.end(second, 5);
  await settle();
  assert.equal(second.events.length, 1, 'end() after stopping appends nothing');
});

test('caps the listed files but keeps the complete counts', async () => {
  const harness = makeRecorder(
    {
      commits: [{ value: 'base' }, { value: 'end' }],
      diffs: [
        {
          value: [
            parsedFile({ path: 'a.txt', added: 1 }),
            parsedFile({ path: 'b.txt', added: 2 }),
            parsedFile({ path: 'c.txt', added: 3, deleted: 4 }),
          ],
        },
      ],
    },
    { maxFiles: 2 },
  );
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['a.txt', 'b.txt'],
  );
  assert.equal(summary.total, 3);
  assert.equal(summary.added, 6, 'the omitted file still counts toward the added sum');
  assert.equal(summary.deleted, 4, 'the omitted file still counts toward the deleted sum');
});

test('lists binary files with zero counts and refuses their comparison', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [
      {
        value: [
          parsedFile({ path: 'image.bin', binary: true, added: 9, deleted: 4, diffBytes: 32 }),
          parsedFile({ path: 'script.ts', added: 1 }),
        ],
      },
    ],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(summary.files[0], {
    path: 'image.bin',
    display: 'image.bin',
    added: 0,
    deleted: 0,
    binary: true,
  });
  assert.equal(summary.added, 1, 'the binary file contributes no line counts');
  assert.equal(summary.deleted, 0);

  const signal = new AbortController().signal;
  const diff = await harness.recorder.diff(session.id, 1, 0, signal);
  assert.deepEqual(diff, { kind: 'binary', path: 'image.bin', display: 'image.bin' });
});

test('serves an oversized diff refusal while keeping the reported counts', async () => {
  const harness = makeRecorder(
    {
      commits: [{ value: 'base' }, { value: 'end' }],
      diffs: [
        {
          value: [
            parsedFile({ path: 'big.txt', added: 3, deleted: 1, diffBytes: 65 }),
            parsedFile({ path: 'edge.txt', added: 1, diffBytes: 64 }),
          ],
        },
      ],
    },
    { maxFileBytes: 64 },
  );
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(summary.files[0], { path: 'big.txt', display: 'big.txt', added: 3, deleted: 1 });
  const signal = new AbortController().signal;
  assert.deepEqual(await harness.recorder.diff(session.id, 1, 0, signal), {
    kind: 'oversized',
    path: 'big.txt',
    display: 'big.txt',
  });
  assert.equal((await harness.recorder.diff(session.id, 1, 1, signal))?.kind, 'text');
});

test('serves text hunks with sides derived from the change status', async () => {
  const addedHunk = hunk(['+one'], { oldLines: 0, newLines: 1 });
  const deletedHunk = hunk(['-one'], { oldLines: 1, newLines: 0 });
  const modifiedHunk = hunk([' one', '-two', '+three'], { oldLines: 2, newLines: 2 });
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [
      {
        value: [
          parsedFile({ path: 'added.txt', status: 'added', hunks: [addedHunk], added: 1 }),
          parsedFile({ path: 'deleted.txt', status: 'deleted', hunks: [deletedHunk], deleted: 1 }),
          parsedFile({ path: 'modified.txt', status: 'modified', hunks: [modifiedHunk], added: 1, deleted: 1 }),
          parsedFile({
            path: 'renamed.txt',
            status: 'renamed',
            oldPath: 'old.txt',
            hunks: [modifiedHunk],
            added: 1,
            deleted: 1,
          }),
        ],
      },
    ],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const signal = new AbortController().signal;

  const added = await harness.recorder.diff(session.id, 1, 0, signal);
  assert.deepEqual(added, {
    kind: 'text',
    path: 'added.txt',
    display: 'added.txt',
    before: false,
    after: true,
    hunks: [addedHunk],
    coarse: false,
  });
  const deleted = await harness.recorder.diff(session.id, 1, 1, signal);
  assert.equal(deleted?.kind === 'text' && deleted.before, true);
  assert.equal(deleted?.kind === 'text' && deleted.after, false);
  for (const index of [2, 3]) {
    const diff = await harness.recorder.diff(session.id, 1, index, signal);
    assert.equal(diff?.kind === 'text' && diff.before, true, 'modified and renamed files existed before');
    assert.equal(diff?.kind === 'text' && diff.after, true, 'modified and renamed files exist after');
  }

  assert.equal(await harness.recorder.diff(session.id, 1, 99, signal), undefined);
  assert.equal(await harness.recorder.diff(session.id, 999, 0, signal), undefined);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await harness.recorder.diff(session.id, 1, 0, aborted.signal), undefined);
});

test('resolves paths from a working directory below the workspace root', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'base' }, { value: 'end' }],
    diffs: [
      {
        value: [parsedFile({ path: 'a.txt', added: 1 }), parsedFile({ path: 'sub/b.txt', added: 2 })],
      },
    ],
  });
  const session = makeSession('s1');
  await recordTurn(harness, session, 1, { cwd: '/repo/sub', root: '/repo' });
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.equal(summary.cwd, '/repo/sub');
  assert.deepEqual(summary.files[0], {
    path: '/repo/a.txt',
    display: '../a.txt',
    added: 1,
    deleted: 0,
  });
  assert.deepEqual(summary.files[1], {
    path: 'b.txt',
    display: 'b.txt',
    added: 2,
    deleted: 0,
  });
});

test('uses a home-relative display for a file outside the workspace', async () => {
  const harness = makeRecorder(
    {
      commits: [{ value: 'base' }, { value: 'end' }],
      diffs: [{ value: [parsedFile({ path: '../home/test/notes.md', added: 1 })] }],
    },
    { home: '/home/test' },
  );
  const session = makeSession('s1');
  await recordTurn(harness, session);
  const summary = harness.recorder.summary(session.id, 1);
  assert.ok(summary !== undefined);
  assert.deepEqual(summary.files[0], {
    path: '/home/test/notes.md',
    display: '~/notes.md',
    added: 1,
    deleted: 0,
  });
});

test('keeps two Sessions independent and forgets one without touching the other', async () => {
  const harness = makeRecorder({
    commits: [{ value: 'a-base' }, { value: 'a-end' }, { value: 'b-base' }, { value: 'b-end' }],
    diffs: [
      { value: [parsedFile({ path: 'only-a.txt', added: 1 })] },
      { value: [parsedFile({ path: 'only-b.txt', added: 2 })] },
    ],
  });
  const sessionA = makeSession('a');
  const sessionB = makeSession('b');
  await recordTurn(harness, sessionA);
  await recordTurn(harness, sessionB);

  assert.equal(harness.recorder.ownsSeq('a', 1), true);
  assert.equal(harness.recorder.ownsSeq('b', 1), true);
  assert.equal(harness.recorder.ownsSeq('a', 2), false, 'sequence spaces are per Session');
  const summaryA = harness.recorder.summary('a', 1);
  const summaryB = harness.recorder.summary('b', 1);
  assert.deepEqual(
    summaryA?.files.map((file) => file.path),
    ['only-a.txt'],
  );
  assert.deepEqual(
    summaryB?.files.map((file) => file.path),
    ['only-b.txt'],
  );

  harness.recorder.forget('a');
  assert.equal(harness.recorder.summary('a', 1), undefined);
  assert.equal(harness.recorder.summaryForTurn('a', 1), undefined);
  assert.equal(harness.recorder.ownsSeq('a', 1), false);
  assert.equal(await harness.recorder.diffForTurn('a', 1, 0, new AbortController().signal), undefined);
  assert.deepEqual(
    harness.recorder.summary('b', 1)?.files.map((file) => file.path),
    ['only-b.txt'],
    'the other Session keeps its record',
  );
});

test('dispose aborts queued reads and turns every later call into a no-op', async () => {
  const gate = deferred<string>();
  const harness = makeRecorder({ commits: [{ wait: gate.promise }], diffs: [] });
  const session = makeSession('s1');
  harness.recorder.startTurn(session, { turn: 1, cwd: '/repo', root: '/repo' });
  await settle();
  assert.equal(harness.reader.calls.commits.length, 1);
  const signal = harness.reader.calls.commits[0].signal;
  assert.ok(signal !== undefined);

  harness.recorder.dispose();
  assert.equal(signal.aborted, true, 'the queued read is cancelled');
  gate.resolve('base');
  await settle();
  assert.equal(session.events.length, 0);
  assert.deepEqual(harness.warnings, [], 'cancellation after disposal stays silent');

  assert.equal(harness.recorder.summary('s1', 1), undefined);
  assert.equal(harness.recorder.summaryForTurn('s1', 1), undefined);
  assert.equal(harness.recorder.ownsSeq('s1', 1), false);
  assert.equal(await harness.recorder.diff('s1', 1, 0, new AbortController().signal), undefined);
  assert.equal(await harness.recorder.diffForTurn('s1', 1, 0, new AbortController().signal), undefined);
  await assert.doesNotReject(harness.recorder.stopping(session, 1));
  harness.recorder.startTurn(session, { turn: 2, cwd: '/repo', root: '/repo' });
  harness.recorder.noteToolResult(session, 2, 4);
  harness.recorder.end(session, 2);
  harness.recorder.forget('s1');
  await settle();
  assert.equal(session.events.length, 0);
});

/**
 * Read a summary through the recorder and assert it exists.
 *
 * @param harness - recorder under test.
 * @param session - the Session that appended the event.
 * @param event - the appended event.
 * @returns the summary.
 */
function recorderSummary(
  harness: Harness,
  session: FakeSession,
  event: RecordedEvent,
): NonNullable<ReturnType<TurnChangesRecorder['summary']>> {
  const summary = harness.recorder.summary(session.id, event.seq);
  assert.ok(summary !== undefined);
  return summary;
}
