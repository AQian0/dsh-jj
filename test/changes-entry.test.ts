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
import { join } from 'node:path';
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

/**
 * Build the fake subprocess capability over `node:child_process`.
 *
 * @param env - extra environment entries layered over `process.env` for every spawn.
 * @returns a capability object with `resolveExecutable` and `spawn`.
 */
function createFakeSubprocess(env: Readonly<Record<string, string>> = {}): FakeSubprocess {
  return {
    async resolveExecutable(name: string): Promise<string> {
      const found = spawnSync('sh', ['-c', `command -v ${JSON.stringify(name)}`], { encoding: 'utf8' });
      const executable = found.stdout.trim();
      if (executable.length === 0) throw new Error(`executable not found: ${name}`);
      return executable;
    },
    spawn(spec: SpawnSpec): SpawnHandle {
      const [command, ...args] = spec.argv;
      const child = spawn(command as string, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
        child.on('error', () => resolve({ exitCode: null, signal: null }));
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
      });
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) child.kill('SIGKILL');
        else spec.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      }
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
        terminate: () => {
          child.kill('SIGKILL');
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
 * @returns the harness driving the Session and reading the Host service.
 */
async function mountHost(cwd: string, jjConfig: string, config: ChangesConfig = {}): Promise<HostHarness> {
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: jjConfig }));
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

test('workspaceChanges: off leaves the service unprovided', async (t) => {
  const fx = makeTempRoot('dsh-jj-changes-entry-off');
  t.after(() => fx.cleanup());
  const entry = await import('../src/changes.ts');
  const ctx = new Context();
  provide(ctx, 'subprocess', createFakeSubprocess({ JJ_CONFIG: writeJjConfig(fx.dir) }));
  provide(ctx, 'fs', { processPath: (target: unknown) => String(target) });
  provide(ctx, 'jj', { operations: { config: resolveConfig({}) } });
  await entry.apply(ctx, { workspaceChanges: 'off' });
  assert.equal(ctx.get('workspaceChanges', false), undefined, 'mode off must not provide the service');
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
