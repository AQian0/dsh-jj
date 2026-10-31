/**
 * Host-entry integration: the `jj-changes` row composes DSH's built-in
 * workspace-change recorder with a jj recorder and serves the merged summary
 * through the `workspaceChanges` service.
 *
 * These tests run a real Cordis context with a minimal in-process subprocess
 * capability (the real `@deepseek-ai/dsh-subprocess-local` provider is not a
 * test dependency) and real jj/Git repositories created by the shared fixture
 * helpers. They are the end-to-end evidence that a turn inside a jj workspace
 * produces the changed-files card data with correct line counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
// Type-only: loads the `workspaceChanges` Context augmentation and the service types.
import type {} from '@deepseek-ai/dsh-workspace-changes/types';
import { resolveConfig } from '../src/config.ts';
import type { ChangesConfig } from '../src/changes.ts';
import {
  initGit,
  initJjColocated,
  initJjNative,
  makeFixture,
  makeTempRoot,
  mustRun,
  writeJjConfig,
} from './helpers/fixtures.ts';

/** Structural view of one collected stdout/stderr reader the subprocess spec yields. */
interface CollectedReader {
  readFrom(from: number): { readonly text: string; readonly lossy: boolean };
}

/** Structural view of the spawn spec the plugin's runners pass. */
interface SpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdio: {
    readonly stdin: 'ignore' | { readonly data: string };
    readonly stdout: { readonly maxBytes: number };
    readonly stderr: { readonly maxBytes: number };
  };
  readonly graceMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
}

/** Structural view of the live handle the subprocess capability returns. */
interface SpawnHandle {
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  readonly collected: { readonly stdout?: CollectedReader; readonly stderr?: CollectedReader };
  terminate(): void;
  waitForExit(): Promise<boolean>;
}

/** In-process subprocess capability: enough of the DSH seam for jj and Git runs. */
interface FakeSubprocess {
  resolveExecutable(name: string, base: undefined, signal: AbortSignal): Promise<string>;
  spawn(spec: SpawnSpec): SpawnHandle;
}

/** Latency hooks that script the subprocess timings a test needs. */
interface FakeSubprocessHooks {
  /** Delay every Git spawn by this many milliseconds (slows the built-in recorder). */
  readonly delayGitMs?: number;
  /** Delay the first jj working-copy snapshot (`jj log -r @`) spawn by this many milliseconds. */
  readonly delayFirstSnapshotMs?: number;
  /** Collect every spawned argv here (used to prove `off` starts no jj process). */
  readonly spawns?: string[];
}

/** Whether argv[0] is the Git executable (the built-in recorder's subprocess calls). */
function isGitProgram(program: string | undefined): boolean {
  return program !== undefined && basename(program) === 'git';
}

/** Whether one spawn is the working-copy snapshot command `readCommit` runs. */
function isSnapshotSpawn(spec: SpawnSpec): boolean {
  const argv = spec.argv;
  return argv.includes('log') && argv.includes('--no-graph') && argv.includes('@');
}

/**
 * Build the fake subprocess capability over `node:child_process`.
 *
 * @param env - extra environment entries layered over `process.env` for every spawn.
 * @param hooks - optional timing delays used by the race/ordering tests.
 * @returns a capability object with `resolveExecutable` and `spawn`.
 */
function createFakeSubprocess(
  env: Readonly<Record<string, string>> = {},
  hooks: FakeSubprocessHooks = {},
): FakeSubprocess {
  let snapshotDelayed = false;
  return {
    async resolveExecutable(name: string): Promise<string> {
      const found = spawnSync('sh', ['-c', `command -v ${JSON.stringify(name)}`], { encoding: 'utf8' });
      const executable = found.stdout.trim();
      if (executable.length === 0) throw new Error(`executable not found: ${name}`);
      return executable;
    },
    spawn(spec: SpawnSpec): SpawnHandle {
      const [command, ...args] = spec.argv;
      hooks.spawns?.push(spec.argv.join(' '));
      let stdout = '';
      let stderr = '';
      let child: ReturnType<typeof spawn> | undefined;
      let terminated = false;
      let resolveDone: (outcome: { readonly exitCode: number | null; readonly signal: string | null }) => void = () =>
        undefined;
      const done = new Promise<{ readonly exitCode: number | null; readonly signal: string | null }>((resolve) => {
        resolveDone = resolve;
      });
      const launch = (): void => {
        const { stdin } = spec.stdio;
        child = spawn(command as string, args, {
          cwd: spec.cwd,
          env: { ...process.env, ...env, ...spec.env },
          stdio: [typeof stdin === 'object' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
        if (typeof stdin === 'object') child.stdin?.end(stdin.data);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', () => resolveDone({ exitCode: null, signal: null }));
        child.on('close', (code, signal) => resolveDone({ exitCode: code, signal }));
        if (terminated) child.kill('SIGKILL');
        if (spec.signal !== undefined) {
          if (spec.signal.aborted) child.kill('SIGKILL');
          else spec.signal.addEventListener('abort', () => child?.kill('SIGKILL'), { once: true });
        }
      };
      let delayMs = 0;
      if (hooks.delayGitMs !== undefined && isGitProgram(command)) delayMs = hooks.delayGitMs;
      else if (!snapshotDelayed && hooks.delayFirstSnapshotMs !== undefined && isSnapshotSpawn(spec)) {
        snapshotDelayed = true;
        delayMs = hooks.delayFirstSnapshotMs;
      }
      if (delayMs > 0) setTimeout(launch, delayMs);
      else launch();
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
        terminate: () => {
          terminated = true;
          child?.kill('SIGKILL');
        },
        waitForExit: async () => true,
      };
    },
  };
}

/** One fake top-level Session: appends events, notifies `session/event`, and numbers sequences. */
interface FakeSession {
  readonly id: string;
  readonly header: { readonly cwd: string; readonly origin: 'user'; readonly delegationDepth: 0 };
  append(type: string, data: unknown): { readonly seq: number };
}

/** Structural view of one summary the Host route serves. */
interface WorkspaceSummaryLike {
  readonly turn: number;
  readonly cwd: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly display: string;
    readonly added: number;
    readonly deleted: number;
    readonly binary?: true;
    readonly oversized?: true;
  }>;
  readonly total: number;
  readonly added: number;
  readonly deleted: number;
}

/** Structural view of one comparison the Host route serves. */
interface WorkspaceDiffLike {
  readonly kind: 'text' | 'binary' | 'oversized';
  readonly hunks?: ReadonlyArray<{ readonly lines: readonly string[] }>;
}

/** Structural view of the Host service the deliverables rows inject. */
interface WorkspaceChangesLike {
  summary(id: string, seq: number): WorkspaceSummaryLike | undefined;
  diff(id: string, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceDiffLike | undefined>;
}

/** Harness around one Cordis context and one fake Session. */
interface HostHarness {
  readonly ctx: Context;
  readonly session: FakeSession;
  /** Append one host-side Session event (never a workspace/changes event). */
  send(type: string, data: unknown): void;
  /** Workspace-change events appended by any recorder, in sequence order. */
  readonly changeEvents: ReadonlyArray<{ readonly seq: number; readonly turn?: number }>;
  /** Every subprocess argv this entry spawned since mount. */
  readonly spawns: readonly string[];
  /** The Host service the deliverables rows would inject. */
  summary(seq: number): WorkspaceSummaryLike | undefined;
  diff(seq: number, index: number): Promise<WorkspaceDiffLike | undefined>;
}

/** Provide one service on a bare Cordis context without the typed overloads. */
function provide(ctx: Context, name: string, value: unknown): void {
  (ctx as unknown as { provide(name: string, value?: unknown): unknown }).provide(name, value);
}

/** Dispatch one event and await every async listener (the host's turn-stopping dispatch). */
async function dispatch(ctx: Context, name: string, payload: unknown): Promise<void> {
  await (ctx as unknown as { parallel(name: string, ...args: unknown[]): Promise<void> }).parallel(name, payload);
}

/** Dispatch one event serially, awaiting each listener in registration order (the real Host's dispatch). */
async function dispatchSerial(ctx: Context, name: string, payload: unknown): Promise<void> {
  await (ctx as unknown as { serial(name: string, ...args: unknown[]): Promise<void> }).serial(name, payload);
}

/** Compose one waterfall event through its listeners and the final `next` callback. */
async function waterfall(ctx: Context, name: string, ...args: unknown[]): Promise<unknown> {
  return (ctx as unknown as { waterfall(name: string, ...args: unknown[]): unknown }).waterfall(name, ...args);
}

/** Emit one event synchronously. */
function emit(ctx: Context, name: string, ...args: unknown[]): void {
  (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(name, ...args);
}

/**
 * Mount the `jj-changes` entry on a real Cordis context and create one fake Session.
 *
 * @param cwd - Session working directory.
 * @param jjConfig - path to a hermetic `jj` config (identity for snapshot commits).
 * @param config - entry configuration.
 * @param hooks - optional subprocess latency hooks used by the race/ordering tests.
 * @returns the harness driving the Session and reading the Host service.
 */
async function mountHost(
  cwd: string,
  jjConfig: string,
  config: ChangesConfig = {},
  hooks: FakeSubprocessHooks = {},
): Promise<HostHarness> {
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  const spawns: string[] = [];
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: jjConfig }, { ...hooks, spawns }));
  provide(ctx, 'fs', { processPath: (target: unknown) => String(target) });
  provide(ctx, 'jj', { operations: { config: resolveConfig({}) } });
  await entry.apply(ctx, config);
  const service = ctx.get('workspaceChanges', false) as WorkspaceChangesLike | undefined;
  const events: Array<{ type: string; seq: number; data: unknown; turn?: number }> = [];
  let seq = 0;
  const record = (type: string, data: unknown): { readonly seq: number } => {
    const turn = turnOf(data);
    const event = { type, seq: ++seq, data, ...(turn === undefined ? {} : { turn }) };
    events.push(event);
    emit(ctx, 'session/event', session, event);
    return event;
  };
  const session: FakeSession = {
    id: 'session-entry-test',
    header: { cwd, origin: 'user', delegationDepth: 0 },
    append: record,
  };
  if (service !== undefined) {
    assert.equal(typeof service.summary, 'function');
  }
  return {
    ctx,
    session,
    send: record,
    get changeEvents() {
      return events.filter((event) => event.type === 'workspace/changes');
    },
    get spawns() {
      return spawns;
    },
    summary(changeSeq: number) {
      return service?.summary(session.id, changeSeq);
    },
    async diff(changeSeq: number, index: number) {
      return service?.diff(session.id, changeSeq, index, AbortSignal.timeout(2_000));
    },
  };
}

/** Read the turn number off one event payload. */
function turnOf(data: unknown): number | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const turn = (data as { turn?: unknown }).turn;
  return typeof turn === 'number' ? turn : undefined;
}

/** Wait for the recorder's queued snapshots and diffs to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** Let Cordis fibers start/refuse (plugin activation and inject gating). */
async function tick(milliseconds = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Simulate one Host file-tool mutation through the seams the built-in recorder
 * captures: `tools/pre-execute` registers the recorder for the execution, then
 * `fs/write-intent` captures the pre-image right before the write happens.
 *
 * @param harness - mounted Host harness.
 * @param path - absolute path the file tool targets.
 * @param mutate - the filesystem write the tool performs after the intent.
 */
async function simulateFileToolCapture(harness: HostHarness, path: string, mutate: () => void): Promise<void> {
  const exec = { agent: { session: harness.session }, callId: `call-${basename(path)}` };
  await waterfall(harness.ctx, 'tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  await waterfall(harness.ctx, 'fs/write-intent', path, exec, async () => ({ kind: 'write' }));
  mutate();
}

/**
 * Build a colocated fixture with one tracked file and one gitignored file.
 *
 * @param t - test context owning the temporary root.
 * @param label - temporary-root label.
 * @returns the repository path and its fixture.
 */
async function makeMergeFixture(
  t: Parameters<typeof makeFixture>[0],
  label: string,
): Promise<{ readonly fixture: ReturnType<typeof makeFixture>; readonly repo: string }> {
  const fixture = makeFixture(t, label);
  const repo = await initJjColocated(fixture.run, fixture.path('repo'));
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(repo, 'tracked.txt'), 'one\n');
  writeFileSync(join(repo, 'ignored.txt'), 'old\n');
  await mustRun(fixture.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fixture.run, ['jj', 'new'], repo);
  return { fixture, repo };
}

/** The paths a served summary lists. */
function summaryPaths(summary: WorkspaceSummaryLike | undefined): string[] {
  return summary?.files.map((file) => file.path) ?? [];
}

/**
 * Run one complete scripted turn: turn start, mutation, tool result, the
 * awaited turn-stopping hook, then turn end.
 *
 * @param harness - mounted Host harness.
 * @param turn - turn number.
 * @param mutate - filesystem mutation performed between start and stop.
 * @returns the sequence of the latest workspace/changes event of the turn.
 */
async function runTurn(harness: HostHarness, turn: number, mutate: () => void): Promise<number> {
  harness.send('turn/start', { turn });
  await settle();
  mutate();
  harness.send('tool/result', { turn, step: 1 });
  await dispatch(harness.ctx, 'agent/turn-stopping', { agent: { session: harness.session }, turn });
  harness.send('turn/end', { turn });
  await settle();
  const last = harness.changeEvents.filter((event) => event.turn === turn).at(-1);
  assert.ok(last !== undefined, 'a workspace/changes event must be appended during the turn');
  return last.seq;
}

test('jj-native workspace: the changed-files card is served from jj snapshots', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-native');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'gone.txt'), 'bye\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root));

  const seq = await runTurn(harness, 1, () => {
    appendFileSync(join(repo, 'keep.txt'), 'three\nfour\n');
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    rmSync(join(repo, 'gone.txt'));
  });
  const summary = harness.summary(seq);
  assert.ok(summary !== undefined, 'the Host must serve a summary for the jj event');
  assert.equal(summary.cwd, repo);
  const byPath = new Map(summary.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath.get('keep.txt'), { path: 'keep.txt', display: 'keep.txt', added: 2, deleted: 0 });
  assert.deepEqual(byPath.get('new.txt'), { path: 'new.txt', display: 'new.txt', added: 1, deleted: 0 });
  assert.deepEqual(byPath.get('gone.txt'), { path: 'gone.txt', display: 'gone.txt', added: 0, deleted: 1 });
  assert.equal(summary.total, 3);
  assert.equal(summary.added, 3);
  assert.equal(summary.deleted, 1);

  const keepIndex = summary.files.findIndex((file) => file.path === 'keep.txt');
  const diff = await harness.diff(seq, keepIndex);
  assert.ok(diff !== undefined);
  assert.equal(diff.kind, 'text');
  assert.deepEqual(diff.hunks?.[0]?.lines, [' one', ' two', '+three', '+four']);
});

test('jj-native workspace: a new oversized file is listed as an oversized card entry', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-oversized');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'keep.txt'), 'one\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root));

  const seq = await runTurn(harness, 1, () => {
    appendFileSync(join(repo, 'keep.txt'), 'two\n');
    // Over jj's default `snapshot.max-new-file-size` (1 MiB): jj refuses to snapshot it.
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0x61));
  });
  const summary = harness.summary(seq);
  assert.ok(summary !== undefined);
  assert.equal(summary.total, 2);
  assert.equal(summary.added, 1, 'the oversized file contributes no line counts');
  const big = summary.files.find((file) => file.path === 'big.bin');
  assert.ok(big !== undefined, 'the file jj refused to snapshot must still be listed');
  assert.deepEqual(big, { path: 'big.bin', display: 'big.bin', added: 0, deleted: 0, oversized: true });
  const index = summary.files.findIndex((file) => file.path === 'big.bin');
  assert.deepEqual(await harness.diff(seq, index), { kind: 'oversized', path: 'big.bin', display: 'big.bin' });

  const keep = summary.files.find((file) => file.path === 'keep.txt');
  assert.deepEqual(keep, { path: 'keep.txt', display: 'keep.txt', added: 1, deleted: 0 });
});

test('jj-native workspace: a turn that only creates an oversized file still produces a card', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-oversized-only');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'keep.txt'), 'one\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root));

  const seq = await runTurn(harness, 1, () => {
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0x61));
  });
  const summary = harness.summary(seq);
  assert.ok(summary !== undefined, 'the card is recorded even though the working-copy commit did not move');
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.files, [{ path: 'big.bin', display: 'big.bin', added: 0, deleted: 0, oversized: true }]);
  assert.deepEqual(await harness.diff(seq, 0), { kind: 'oversized', path: 'big.bin', display: 'big.bin' });
});

test('colocated workspace: jj data wins and the built-in Git record is merged without duplicates', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-colocated');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'a.txt'), 'alpha\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root));

  const seq = await runTurn(harness, 1, () => {
    appendFileSync(join(repo, 'a.txt'), 'beta\n');
  });
  const summary = harness.summary(seq);
  assert.ok(summary !== undefined);
  assert.equal(summary.files.length, 1, 'a file both recorders saw is listed once');
  assert.equal(summary.files[0]?.path, 'a.txt');
  assert.equal(summary.files[0]?.added, 1);
  assert.equal(summary.added, 1);
  assert.equal(summary.total, 1);
});

test('colocated workspace: jj keeps the oversized marker even though Git sees the file', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-oversized-colocated');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'keep.txt'), 'one\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root));

  const seq = await runTurn(harness, 1, () => {
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
  });
  const summary = harness.summary(seq);
  assert.ok(summary !== undefined);
  assert.equal(summary.total, 1);
  // The built-in Git recorder can see the 2 MiB file and would report counts for
  // it; the merge keeps the jj entry, so the card consistently says "too large".
  assert.deepEqual(summary.files, [{ path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true }]);
  assert.deepEqual(await harness.diff(seq, 0), { kind: 'oversized', path: 'big.txt', display: 'big.txt' });
});

test('colocated workspace: the Host last event (serial dispatch) carries the merged view', async (t) => {
  const { fixture, repo } = await makeMergeFixture(t, 'dsh-jj-changes-entry-merge-serial');
  const harness = await mountHost(repo, writeJjConfig(fixture.root));

  harness.send('turn/start', { turn: 1 });
  await settle();
  // A file-tool write of a gitignored file reaches the card only through the
  // built-in recorder's capture path; the tracked edit is visible to both.
  await simulateFileToolCapture(harness, join(repo, 'ignored.txt'), () => {
    appendFileSync(join(repo, 'ignored.txt'), 'ignored\n');
  });
  appendFileSync(join(repo, 'tracked.txt'), 'two\n');
  harness.send('tool/result', { turn: 1, step: 1 });
  // The real Host dispatches `agent/turn-stopping` with `dispatch.serial`:
  // listeners run in registration order, so the built-in recorder appends first
  // and the jj recorder appends last. The card asks for that last sequence.
  await dispatchSerial(harness.ctx, 'agent/turn-stopping', { agent: { session: harness.session }, turn: 1 });
  harness.send('turn/end', { turn: 1 });
  await settle();

  const events = harness.changeEvents.filter((event) => event.turn === 1);
  assert.equal(events.length, 2, 'both recorders announce the turn');
  const last = events.at(-1);
  assert.ok(last !== undefined);
  const summary = harness.summary(last.seq);
  assert.ok(summary !== undefined, 'the last event sequence must resolve to a merged summary');
  assert.deepEqual(
    summaryPaths(summary).sort(),
    ['ignored.txt', 'tracked.txt'],
    'the built-in-only capture and the jj change are both listed on the last sequence',
  );
  assert.deepEqual(harness.summary(events[0]!.seq), summary, 'either sequence serves the same merged view');
  assert.deepEqual(
    summary.files.find((file) => file.path === 'ignored.txt'),
    { path: 'ignored.txt', display: 'ignored.txt', added: 1, deleted: 0 },
  );
  assert.deepEqual(
    summary.files.find((file) => file.path === 'tracked.txt'),
    { path: 'tracked.txt', display: 'tracked.txt', added: 1, deleted: 0 },
    'jj data wins for a file both recorders saw',
  );
  const ignoredIndex = summary.files.findIndex((file) => file.path === 'ignored.txt');
  const diff = await harness.diff(last.seq, ignoredIndex);
  assert.equal(diff?.kind, 'text', 'the merged comparison routes the built-in-only file to the built-in recorder');
});

test('colocated workspace: the merged view is served when the built-in recorder appends last', async (t) => {
  const { fixture, repo } = await makeMergeFixture(t, 'dsh-jj-changes-entry-merge-parallel');
  // Delay every Git spawn: the built-in recorder's Git snapshots take far longer
  // than the jj commands, so under a concurrent Host dispatch the jj recorder
  // appends first and the built-in recorder appends last.
  const harness = await mountHost(repo, writeJjConfig(fixture.root), {}, { delayGitMs: 200 });

  harness.send('turn/start', { turn: 1 });
  await settle();
  await simulateFileToolCapture(harness, join(repo, 'ignored.txt'), () => {
    appendFileSync(join(repo, 'ignored.txt'), 'ignored\n');
  });
  appendFileSync(join(repo, 'tracked.txt'), 'two\n');
  harness.send('tool/result', { turn: 1, step: 1 });
  await dispatch(harness.ctx, 'agent/turn-stopping', { agent: { session: harness.session }, turn: 1 });
  harness.send('turn/end', { turn: 1 });
  await settle();

  const events = harness.changeEvents.filter((event) => event.turn === 1);
  assert.equal(events.length, 2, 'both recorders announce the turn');
  const last = events.at(-1);
  assert.ok(last !== undefined);
  const summary = harness.summary(last.seq);
  assert.ok(summary !== undefined);
  assert.deepEqual(summaryPaths(summary).sort(), ['ignored.txt', 'tracked.txt']);
  assert.deepEqual(harness.summary(events[0]!.seq), summary, 'the earlier sequence serves the same merged view too');
});

test('jj-native workspace: the first tool write waits for the turn-start snapshot', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-snapshot-barrier');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'keep.txt'), 'one\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  // The turn-start snapshot takes 400 ms (a cold cache / large workspace). A tool
  // write that overtook it would be folded into the baseline and disappear.
  const harness = await mountHost(repo, writeJjConfig(fx.root), {}, { delayFirstSnapshotMs: 400 });

  harness.send('turn/start', { turn: 1 });
  const exec = { agent: { session: harness.session }, callId: 'call-1' };
  await waterfall(harness.ctx, 'tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  writeFileSync(join(repo, 'raced.txt'), 'hello\n');
  harness.send('tool/result', { turn: 1, step: 1 });
  await dispatchSerial(harness.ctx, 'agent/turn-stopping', { agent: { session: harness.session }, turn: 1 });
  harness.send('turn/end', { turn: 1 });
  await settle();

  const events = harness.changeEvents.filter((event) => event.turn === 1);
  assert.equal(events.length, 1, 'the write lands after the baseline, so the turn has a card');
  const summary = harness.summary(events[0]!.seq);
  assert.deepEqual(summaryPaths(summary), ['raced.txt'], 'the first tool write is not folded into the baseline');
  assert.deepEqual(summary?.files[0], { path: 'raced.txt', display: 'raced.txt', added: 1, deleted: 0 });
});

test('plain Git repository: the built-in recorder still serves the summary', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-git');
  const repo = await initGit(fx.run, fx.path('repo'));
  await mustRun(fx.run, ['git', 'config', 'user.name', 'dsh-jj test'], repo);
  await mustRun(fx.run, ['git', 'config', 'user.email', 'dsh-jj@example.invalid'], repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  await mustRun(fx.run, ['git', 'add', '-A'], repo);
  await mustRun(fx.run, ['git', 'commit', '-m', 'init'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root));

  const seq = await runTurn(harness, 1, () => {
    appendFileSync(join(repo, 'a.txt'), 'two\n');
  });
  const summary = harness.summary(seq);
  assert.ok(summary !== undefined, 'the built-in Git recorder must still produce a summary');
  assert.equal(summary.files[0]?.path, 'a.txt');
  assert.equal(summary.added, 1);
});

test('workspaceChanges: off keeps an inject: [workspaceChanges] row active', async (t) => {
  const fx = makeTempRoot('dsh-jj-changes-entry-off-inject');
  t.after(() => fx.cleanup());
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: writeJjConfig(fx.dir) }));
  provide(ctx, 'fs', { processPath: (target: unknown) => String(target) });
  provide(ctx, 'jj', { operations: { config: resolveConfig({}) } });
  await entry.apply(ctx, { workspaceChanges: 'off' });

  // The Host's deliverables row declares `inject: ['workspaceChanges']`; Cordis
  // keeps such a plugin pending until the service exists. The off-mode empty
  // service must satisfy that inject (present/open routes + file-reference prompt).
  let applied = 0;
  (ctx as unknown as { plugin(plugin: unknown): unknown }).plugin({
    name: 'deliverables-inject-probe',
    inject: ['workspaceChanges'],
    apply: () => {
      applied += 1;
    },
  });
  await tick();
  assert.equal(applied, 1, 'the inject-satisfied deliverables row activates with the off-mode service');

  // Negative control: the same row stays pending without any provider, which is
  // exactly the defect the read-only service avoids.
  const bare = new Context();
  let bareApplied = 0;
  (bare as unknown as { plugin(plugin: unknown): unknown }).plugin({
    name: 'deliverables-inject-probe',
    inject: ['workspaceChanges'],
    apply: () => {
      bareApplied += 1;
    },
  });
  await tick();
  assert.equal(bareApplied, 0, 'without a provider the deliverables row would stay pending');
  (ctx as unknown as { scope?: { dispose?: () => void } }).scope?.dispose?.();
});

test('workspaceChanges: off serves an empty service without recording', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes-entry-off');
  // A real jj-native workspace: if the off branch had registered a recorder or a
  // Session listener, `turn/start` would start a baseline snapshot command.
  const repo = await initJjNative(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'keep.txt'), 'one\n');
  await mustRun(fx.run, ['jj', 'describe', '-m', 'init'], repo);
  await mustRun(fx.run, ['jj', 'new'], repo);
  const harness = await mountHost(repo, writeJjConfig(fx.root), { workspaceChanges: 'off' });
  const service = harness.ctx.get('workspaceChanges', false) as WorkspaceChangesLike | undefined;
  assert.ok(service !== undefined, 'mode off still provides the read-only service the deliverables row injects');
  assert.equal(service.summary(harness.session.id, 1), undefined);
  assert.equal(await service.diff(harness.session.id, 1, 0, new AbortController().signal), undefined);

  harness.send('turn/start', { turn: 1 });
  await tick();
  writeFileSync(join(repo, 'created.txt'), 'hello\n');
  harness.send('tool/result', { turn: 1, step: 1 });
  await dispatchSerial(harness.ctx, 'agent/turn-stopping', { agent: { session: harness.session }, turn: 1 });
  harness.send('turn/end', { turn: 1 });
  await tick();
  assert.deepEqual(harness.changeEvents, [], 'off must not append workspace/changes events');
  assert.deepEqual(harness.spawns, [], 'off must not create a recorder/reader or spawn any jj or git process');
});

test('workspaceChanges: off leaves an existing provider in place', async (t) => {
  const fx = makeTempRoot('dsh-jj-changes-entry-off-existing');
  t.after(() => fx.cleanup());
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  /** Warnings this row reported (the default logger buffer drops warn-level records). */
  const logs: unknown[] = [];
  (ctx as unknown as { logger: { exporter(exporter: unknown): void } }).logger.exporter({
    levels: { default: 3 },
    export: (message: unknown) => logs.push(message),
  });
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: writeJjConfig(fx.dir) }));
  provide(ctx, 'fs', { processPath: (target: unknown) => String(target) });
  provide(ctx, 'jj', { operations: { config: resolveConfig({}) } });
  const existing = { summary: () => undefined, diff: async () => undefined };
  provide(ctx, 'workspaceChanges', existing);
  await entry.apply(ctx, { workspaceChanges: 'off' });
  assert.equal(
    ctx.get('workspaceChanges', false),
    existing,
    'the other provider keeps ownership; no duplicate provide',
  );
  assert.match(JSON.stringify(logs), /another plugin already provides/, 'the row warns instead of replacing it');
  (ctx as unknown as { scope?: { dispose?: () => void } }).scope?.dispose?.();
});

test('workspaceChanges: builtin provides the unmodified built-in service', async (t) => {
  const fx = makeTempRoot('dsh-jj-changes-entry-builtin');
  t.after(() => fx.cleanup());
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: writeJjConfig(fx.dir) }));
  provide(ctx, 'fs', { processPath: (target: unknown) => String(target) });
  provide(ctx, 'jj', { operations: { config: resolveConfig({}) } });
  await entry.apply(ctx, { workspaceChanges: 'builtin' });
  assert.notEqual(ctx.get('workspaceChanges', false), undefined, 'mode builtin provides the built-in service');
});

test('an existing provider is left alone instead of failing the profile', async (t) => {
  const fx = makeTempRoot('dsh-jj-changes-entry-existing');
  t.after(() => fx.cleanup());
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: writeJjConfig(fx.dir) }));
  provide(ctx, 'fs', { processPath: (target: unknown) => String(target) });
  provide(ctx, 'jj', { operations: { config: resolveConfig({}) } });
  const existing = { summary: () => undefined, diff: async () => undefined };
  provide(ctx, 'workspaceChanges', existing);
  await entry.apply(ctx, {});
  assert.equal(ctx.get('workspaceChanges', false), existing, 'the other provider must keep ownership');
});
