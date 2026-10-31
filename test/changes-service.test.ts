/**
 * Unit tests for the merged `workspaceChanges` service.
 *
 * The jj recorder and the built-in recorder are scripted fakes: these tests
 * cover the merge rules (which summary wins, how files are deduplicated and
 * sorted, how totals are approximated, how comparisons are routed) without a
 * repository or a running Host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types';
import type { TurnChangesRecorder } from '../src/changes-recorder.ts';
import { createChangesService, type BridgeOptions, type ChangesServiceLike } from '../src/changes-service.ts';

/** One listed changed file with display defaulting to the path. */
function file(path: string, added = 1, deleted = 0, display = path): WorkspaceChangedFile {
  return { path, display, added, deleted };
}

/** Counts overriding what the listed files add up to. */
interface SummaryCounts {
  readonly total?: number;
  readonly added?: number;
  readonly deleted?: number;
}

/**
 * Build one summary.
 *
 * @param turn - the turn the summary describes.
 * @param cwd - the working directory its paths resolve against.
 * @param files - listed files in display order.
 * @param counts - explicit totals (defaults to sums over the listed files).
 * @returns the summary.
 */
function summaryOf(
  turn: number,
  cwd: string,
  files: WorkspaceChangedFile[],
  counts: SummaryCounts = {},
): WorkspaceChangesSummary {
  return {
    turn,
    cwd,
    files,
    total: counts.total ?? files.length,
    added: counts.added ?? files.reduce((sum, entry) => sum + entry.added, 0),
    deleted: counts.deleted ?? files.reduce((sum, entry) => sum + entry.deleted, 0),
  };
}

/** One trivial text comparison for the given path. */
function textDiff(path: string, display = path): WorkspaceFileDiff {
  return { kind: 'text', path, display, before: true, after: true, hunks: [], coarse: false };
}

/** Scripted jj recorder: the `TurnChangesRecorder` subset the bridge uses. */
interface FakeRecorder {
  readonly instance: TurnChangesRecorder;
  /** Summaries by announced sequence. */
  readonly summaries: Map<number, WorkspaceChangesSummary>;
  /** Summaries by turn (`summaryForTurn`). */
  readonly turnSummaries: Map<number, WorkspaceChangesSummary>;
  /** Comparisons by `${seq}:${index}` (`diff`). */
  readonly seqDiffs: Map<string, WorkspaceFileDiff>;
  /** Comparisons by `${turn}:${index}` (`diffForTurn`). */
  readonly turnDiffs: Map<string, WorkspaceFileDiff>;
  readonly seqDiffCalls: Array<{ readonly seq: number; readonly index: number }>;
  readonly turnDiffCalls: Array<{ readonly turn: number; readonly index: number }>;
}

/**
 * Build a scripted recorder.
 *
 * @returns the scripted recorder and its recorded calls.
 */
function makeFakeRecorder(): FakeRecorder {
  const summaries = new Map<number, WorkspaceChangesSummary>();
  const turnSummaries = new Map<number, WorkspaceChangesSummary>();
  const seqDiffs = new Map<string, WorkspaceFileDiff>();
  const turnDiffs = new Map<string, WorkspaceFileDiff>();
  const seqDiffCalls: FakeRecorder['seqDiffCalls'] = [];
  const turnDiffCalls: FakeRecorder['turnDiffCalls'] = [];
  const instance = {
    summary: (_sessionId: string, seq: number) => summaries.get(seq),
    summaryForTurn: (_sessionId: string, turn: number) => turnSummaries.get(turn),
    diff: async (_sessionId: string, seq: number, index: number) => {
      seqDiffCalls.push({ seq, index });
      return seqDiffs.get(`${seq}:${index}`);
    },
    diffForTurn: async (_sessionId: string, turn: number, index: number) => {
      turnDiffCalls.push({ turn, index });
      return turnDiffs.get(`${turn}:${index}`);
    },
  } as unknown as TurnChangesRecorder;
  return { instance, summaries, turnSummaries, seqDiffs, turnDiffs, seqDiffCalls, turnDiffCalls };
}

/** Scripted built-in recorder service. */
interface FakeUpstream {
  readonly service: ChangesServiceLike;
  /** Summaries by announced sequence. */
  readonly summaries: Map<number, WorkspaceChangesSummary>;
  /** Comparisons by `${seq}:${index}`. */
  readonly diffs: Map<string, WorkspaceFileDiff>;
  /** Every `summary` call sequence, in call order. */
  readonly summaryCalls: number[];
  /** Every `diff` call, in call order. */
  readonly diffCalls: Array<{ readonly seq: number; readonly index: number }>;
}

/**
 * Build a scripted built-in service.
 *
 * @returns the fake service and the calls it observed.
 */
function makeFakeUpstream(): FakeUpstream {
  const summaries = new Map<number, WorkspaceChangesSummary>();
  const diffs = new Map<string, WorkspaceFileDiff>();
  const summaryCalls: number[] = [];
  const diffCalls: FakeUpstream['diffCalls'] = [];
  const service: ChangesServiceLike = {
    summary(_sessionId, seq) {
      summaryCalls.push(seq);
      return summaries.get(seq);
    },
    async diff(_sessionId, seq, index) {
      diffCalls.push({ seq, index });
      return diffs.get(`${seq}:${index}`);
    },
  };
  return { service, summaries, diffs, summaryCalls, diffCalls };
}

/** Inputs for one bridge instance. */
interface BridgeParts {
  readonly recorder: FakeRecorder;
  readonly upstream?: FakeUpstream;
  readonly observedTurn?: (sessionId: string, seq: number) => number | undefined;
  readonly upstreamSeqs?: (sessionId: string, turn: number) => readonly number[];
  readonly maxFiles?: number;
}

/**
 * Build the bridge under test.
 *
 * @param parts - the scripted recorders, turn lookups, and file cap.
 * @returns the merged service.
 */
function makeBridge(parts: BridgeParts): ChangesServiceLike {
  const options: BridgeOptions = {
    recorder: parts.recorder.instance,
    upstream: parts.upstream?.service,
    observedTurn: parts.observedTurn ?? (() => undefined),
    upstreamSeqs: parts.upstreamSeqs ?? (() => []),
    maxFiles: parts.maxFiles ?? 10,
  };
  return createChangesService(options);
}

test('returns the built-in summary when no turn can be observed', () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const base = summaryOf(1, '/repo', [file('a.txt')]);
  upstream.summaries.set(31, base);
  const service = makeBridge({ recorder, upstream });
  assert.equal(service.summary('s1', 31), base);
  assert.deepEqual(upstream.summaryCalls, [31]);
});

test('returns undefined when neither recorder knows the sequence', () => {
  const recorder = makeFakeRecorder();
  assert.equal(makeBridge({ recorder }).summary('s1', 31), undefined);
  const upstream = makeFakeUpstream();
  assert.equal(makeBridge({ recorder, upstream }).summary('s1', 31), undefined);
});

test("serves the jj recorder's own event without asking the upstream service", () => {
  const recorder = makeFakeRecorder();
  const own = summaryOf(2, '/repo', [file('a.txt', 3)]);
  recorder.summaries.set(5, own);
  let observed = 0;
  const service = makeBridge({
    recorder,
    observedTurn: () => {
      observed += 1;
      return undefined;
    },
  });
  assert.equal(service.summary('s1', 5), own);
  assert.equal(observed, 0);
});

test('merges a built-in event aliased to the jj turn: own wins, extras appended and sorted', () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const own = summaryOf(3, '/repo', [file('a.txt', 5), file('b.txt', 1)]);
  const base = summaryOf(3, '/repo', [file('a.txt', 9), file('z.txt', 4, 1)]);
  recorder.turnSummaries.set(3, own);
  upstream.summaries.set(100, base);
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: (_sessionId, seq) => (seq === 100 ? 3 : undefined),
    upstreamSeqs: () => [90, 100],
  });

  const merged = service.summary('s1', 100);
  assert.ok(merged !== undefined);
  assert.equal(merged.turn, 3);
  assert.equal(merged.cwd, '/repo');
  assert.deepEqual(
    merged.files.map((entry) => entry.path),
    ['a.txt', 'b.txt', 'z.txt'],
    'own files first, then upstream-only files, ordered by display',
  );
  assert.deepEqual(merged.files[0], file('a.txt', 5), 'the jj entry wins on a duplicate path');
  assert.deepEqual(merged.files[2], file('z.txt', 4, 1), 'the upstream entry is copied as-is');
  assert.equal(merged.total, 3, '2 jj + 0 omitted upstream + 1 upstream-only');
  assert.equal(merged.added, 10, '6 jj plus the 4 upstream-only lines');
  assert.equal(merged.deleted, 1);
  assert.deepEqual(upstream.summaryCalls, [100], 'the newest candidate is defined, so scanning stops');
});

test('keeps the jj oversized placeholder when the built-in recorder saw the same file', async () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const oversized: WorkspaceChangedFile = {
    path: 'big.bin',
    display: 'big.bin',
    added: 0,
    deleted: 0,
    oversized: true,
  };
  recorder.turnSummaries.set(4, summaryOf(4, '/repo', [oversized]));
  // The Git-based recorder snapshots untracked files of any size, so it would
  // report real counts; jj refused to snapshot the file, and its placeholder wins.
  upstream.summaries.set(40, summaryOf(4, '/repo', [file('big.bin', 10, 2)]));
  recorder.turnDiffs.set('4:0', { kind: 'oversized', path: 'big.bin', display: 'big.bin' });
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 4,
    upstreamSeqs: () => [40],
  });

  const merged = service.summary('s1', 40);
  assert.ok(merged !== undefined);
  assert.deepEqual(merged.files, [oversized], 'the jj entry keeps the oversized marker and zero counts');
  assert.equal(merged.added, 0);
  assert.equal(merged.deleted, 0);
  assert.deepEqual(await service.diff('s1', 40, 0, new AbortController().signal), {
    kind: 'oversized',
    path: 'big.bin',
    display: 'big.bin',
  });
  assert.deepEqual(recorder.turnDiffCalls, [{ turn: 4, index: 0 }]);
  assert.deepEqual(upstream.diffCalls, [], 'the built-in comparison is never asked for the duplicate');
});

test('deduplicates files whose paths resolve to the same absolute path across cwds', () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const own = summaryOf(4, '/repo/sub', [{ path: '../a.txt', display: '../a.txt', added: 2, deleted: 0 }]);
  const base = summaryOf(4, '/repo', [file('a.txt', 7)]);
  recorder.turnSummaries.set(4, own);
  upstream.summaries.set(50, base);
  const merged = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 4,
    upstreamSeqs: () => [50],
  }).summary('s1', 50);

  assert.ok(merged !== undefined);
  assert.equal(merged.files.length, 1);
  assert.deepEqual(merged.files[0], { path: '../a.txt', display: '../a.txt', added: 2, deleted: 0 });
  assert.equal(merged.total, 1);
  assert.equal(merged.added, 2);
  assert.equal(merged.deleted, 0);
});

test('uses the newest defined built-in summary for a turn', () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const older = summaryOf(5, '/repo', [file('older.txt', 1)]);
  const newer = summaryOf(5, '/repo', [file('newer.txt', 2)]);
  recorder.turnSummaries.set(5, summaryOf(5, '/repo', [file('own.txt')]));
  upstream.summaries.set(20, older);
  upstream.summaries.set(40, newer);
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 5,
    upstreamSeqs: () => [20, 30, 40],
  });

  const merged = service.summary('s1', 40);
  assert.ok(merged !== undefined);
  assert.deepEqual(
    merged.files.map((entry) => entry.path),
    ['newer.txt', 'own.txt'],
  );
  assert.equal(merged.total, 2);
  assert.deepEqual(upstream.summaryCalls, [40], 'the newest defined candidate wins');

  const onlyOlder = makeFakeUpstream();
  onlyOlder.summaries.set(20, older);
  const fallback = makeBridge({
    recorder,
    upstream: onlyOlder,
    observedTurn: () => 5,
    upstreamSeqs: () => [20, 30, 40],
  }).summary('s1', 20);
  assert.ok(fallback !== undefined);
  assert.deepEqual(
    fallback.files.map((entry) => entry.path),
    ['older.txt', 'own.txt'],
    'undefined candidates are skipped until a defined summary appears',
  );
  assert.deepEqual(onlyOlder.summaryCalls, [40, 30, 20]);
});

test('respects the merged maxFiles cap while keeping the approximated total', () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  recorder.turnSummaries.set(2, summaryOf(2, '/repo', [file('a.txt'), file('b.txt')]));
  upstream.summaries.set(10, summaryOf(2, '/repo', [file('c.txt'), file('d.txt')]));
  const merged = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 2,
    upstreamSeqs: () => [10],
    maxFiles: 3,
  }).summary('s1', 10);

  assert.ok(merged !== undefined);
  assert.deepEqual(
    merged.files.map((entry) => entry.path),
    ['a.txt', 'b.txt', 'c.txt'],
  );
  assert.equal(merged.total, 4);
});

test('returns the jj summary when the turn has no built-in summary', () => {
  const recorder = makeFakeRecorder();
  const own = summaryOf(6, '/repo', [file('a.txt')]);
  recorder.turnSummaries.set(6, own);
  const service = makeBridge({ recorder, observedTurn: () => 6 });
  assert.equal(service.summary('s1', 99), own);
});

test('returns undefined when the observed turn has no summary at all', () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const service = makeBridge({ recorder, upstream, observedTurn: () => 9, upstreamSeqs: () => [1] });
  assert.equal(service.summary('s1', 1), undefined);
});

test('routes a jj file comparison to the recorder by turn and local index', async () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  recorder.turnSummaries.set(3, summaryOf(3, '/repo', [file('a.txt'), file('b.txt')]));
  upstream.summaries.set(100, summaryOf(3, '/repo', [file('b.txt'), file('z.txt')]));
  const ownDiff = textDiff('a.txt');
  recorder.turnDiffs.set('3:0', ownDiff);
  const signal = new AbortController().signal;
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 3,
    upstreamSeqs: () => [100],
  });

  const diff = await service.diff('s1', 100, 0, signal);
  assert.equal(diff, ownDiff);
  assert.deepEqual(recorder.turnDiffCalls, [{ turn: 3, index: 0 }]);
  assert.deepEqual(upstream.diffCalls, []);
});

test('routes an upstream-only file to the built-in service with its own seq and index', async () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  recorder.turnSummaries.set(3, summaryOf(3, '/repo', [file('a.txt'), file('b.txt')]));
  upstream.summaries.set(100, summaryOf(3, '/repo', [file('b.txt'), file('z.txt')]));
  const upstreamDiff = textDiff('z.txt');
  upstream.diffs.set('100:1', upstreamDiff);
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 3,
    upstreamSeqs: () => [100],
  });

  const diff = await service.diff('s1', 100, 2, new AbortController().signal);
  assert.equal(diff, upstreamDiff);
  assert.deepEqual(upstream.diffCalls, [{ seq: 100, index: 1 }], 'the built-in file keeps its own index');
  assert.deepEqual(recorder.turnDiffCalls, []);
});

test('falls back to the announcing sequence when the index is out of range', async () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  recorder.turnSummaries.set(3, summaryOf(3, '/repo', [file('a.txt')]));
  upstream.summaries.set(100, summaryOf(3, '/repo', [file('z.txt')]));
  const fallback = textDiff('whatever.txt');
  upstream.diffs.set('100:9', fallback);
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: () => 3,
    upstreamSeqs: () => [100],
  });

  const diff = await service.diff('s1', 100, 9, new AbortController().signal);
  assert.equal(diff, fallback);
  assert.deepEqual(upstream.diffCalls, [{ seq: 100, index: 9 }]);
});

test('resolves undefined when the index cannot be routed and no upstream service exists', async () => {
  const recorder = makeFakeRecorder();
  recorder.turnSummaries.set(3, summaryOf(3, '/repo', [file('a.txt')]));
  const service = makeBridge({ recorder, observedTurn: () => 3 });
  assert.equal(await service.diff('s1', 99, 4, new AbortController().signal), undefined);
});

test("returns the jj recorder's diff for its own sequence without a merge", async () => {
  const recorder = makeFakeRecorder();
  const upstream = makeFakeUpstream();
  const ownDiff = textDiff('a.txt');
  recorder.seqDiffs.set('5:0', ownDiff);
  let observed = 0;
  const service = makeBridge({
    recorder,
    upstream,
    observedTurn: () => {
      observed += 1;
      return undefined;
    },
  });

  assert.equal(await service.diff('s1', 5, 0, new AbortController().signal), ownDiff);
  assert.equal(observed, 0);
  assert.deepEqual(upstream.diffCalls, []);
});

test('the service structurally satisfies the workspaceChanges contract', () => {
  const service: Pick<WorkspaceChanges, 'summary' | 'diff'> = makeBridge({ recorder: makeFakeRecorder() });
  assert.equal(typeof service.summary, 'function');
  assert.equal(typeof service.diff, 'function');
});
