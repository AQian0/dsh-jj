/**
 * `JjService` lifecycle tests plus operation-layer regressions that only need a
 * fake runner: dispose must cancel in-flight jj work (the abort tier of the
 * disposal ladder), the detect TTL cache must be observable, `headOperationId`
 * must read the operation log without snapshotting, and an unusable jj must not
 * be reported as "no integration target found".
 *
 * The service tests drive `JjService` over a real Cordis `Context` whose
 * `subprocess` service is a recording double, so no host runtime is needed; the
 * head-operation test uses the real `jj` binary through `createCommandRunJj`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { resolveConfig } from '../src/config.ts';
import { createCommandRunJj, JjError } from '../src/jj-command.ts';
import { JjOperations, JjService } from '../src/service.ts';
import type { JjRunResult, RunJjOptions } from '../src/types.ts';
import { assertToolchain, initJjColocated, makeFixture, makeTempRoot, mustRun } from './helpers/fixtures.ts';

/** A `jj`/`git` run result shaped like the contract runner returns. */
type RunOutcome = JjRunResult;

/** One spawn request the fake subprocess service received. */
interface SpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/** How the fake subprocess settles one spawn. */
interface FakeOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface FakeHandle {
  readonly done: Promise<FakeOutcome>;
  readonly collected: {
    readonly stdout: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } };
    readonly stderr: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } };
  };
  terminate(): void;
  waitForExit(): Promise<boolean>;
}

/** Delivery shape accepted by `createRunJj` (a structural subset of the real service). */
interface FakeSubprocess {
  readonly specs: SpawnSpec[];
  spawn(spec: SpawnSpec): FakeHandle;
}

function reader(text: string) {
  return { readFrom: (_fromByte: number) => ({ text, nextOffset: text.length, lossy: false }) };
}

/** Subprocess double whose spawns succeed immediately with the same stdout. */
function immediateSubprocess(stdout = ''): FakeSubprocess {
  const specs: SpawnSpec[] = [];
  return {
    specs,
    spawn(spec) {
      specs.push(spec);
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: reader(stdout), stderr: reader('') },
        terminate: () => {},
        waitForExit: async () => true,
      };
    },
  };
}

/** Subprocess double whose spawns hang until their abort signal fires. */
function hangingSubprocess(): FakeSubprocess {
  const specs: SpawnSpec[] = [];
  return {
    specs,
    spawn(spec) {
      specs.push(spec);
      let settle: (outcome: FakeOutcome) => void = () => {};
      const done = new Promise<FakeOutcome>((resolve) => {
        settle = resolve;
      });
      const abort = (): void => settle({ exitCode: null, signal: 'SIGTERM' });
      if (spec.signal?.aborted === true) abort();
      else spec.signal?.addEventListener('abort', abort, { once: true });
      return {
        done,
        collected: { stdout: reader(''), stderr: reader('') },
        terminate: () => {},
        waitForExit: async () => true,
      };
    },
  };
}

/** Subprocess double whose first `jj --version` probe fails and later ones succeed. */
function flakyVersionSubprocess(): FakeSubprocess {
  const specs: SpawnSpec[] = [];
  let jjVersionCalls = 0;
  return {
    specs,
    spawn(spec) {
      specs.push(spec);
      const isJjVersion = spec.argv[0] === 'jj' && spec.argv.includes('--version');
      if (isJjVersion) jjVersionCalls += 1;
      const failFirst = isJjVersion && jjVersionCalls === 1;
      return {
        done: Promise.resolve(failFirst ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null }),
        collected: {
          stdout: reader(failFirst ? '' : 'jj 0.46.0\n'),
          stderr: reader(failFirst ? 'transient probe failure' : ''),
        },
        terminate: () => {},
        waitForExit: async () => true,
      };
    },
  };
}

/** Build a throwaway root context that provides the fake subprocess service. */
function serviceContext(subprocess: FakeSubprocess): { ctx: Context; dispose(): Promise<void> } {
  const ctx = new Context();
  // The loose `provide(name: string, value?: any)` overload keeps the fake double
  // outside the real `SubprocessRuntime` type while remaining structurally usable.
  const subprocessName: string = 'subprocess';
  ctx.provide(subprocessName, subprocess);
  return { ctx, dispose: async () => await ctx.fiber.dispose() };
}

/** Poll until `predicate` holds (bounded), so tests never sleep blindly. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the fake subprocess to start');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

test('JjService: detect caches for detectCacheTtlMs, warm always refreshes, and peek is a miss before any probe', async (t) => {
  const temp = makeTempRoot('dsh-jj-service-cache');
  t.after(() => temp.cleanup());
  const subprocess = immediateSubprocess('jj 0.46.0\n');
  const { ctx, dispose } = serviceContext(subprocess);
  const service = new JjService(ctx, { detectCacheTtlMs: 40, timeoutMs: 5_000, graceMs: 50 });

  assert.equal(service.peek(temp.dir), undefined, 'a cold cache must report a miss (guard fail-open)');
  const first = await service.detect(temp.dir);
  const spawnsAfterFirst = subprocess.specs.length;
  assert.ok(spawnsAfterFirst > 0, 'the first detection spawns the probes');
  assert.ok(service.peek(temp.dir) !== undefined, 'detect fills the synchronous peek cache');

  const cached = await service.detect(temp.dir);
  assert.equal(cached, first, 'a TTL hit returns the cached descriptor');
  assert.equal(subprocess.specs.length, spawnsAfterFirst, 'a TTL hit spawns nothing');

  await service.warm(temp.dir);
  assert.ok(subprocess.specs.length > spawnsAfterFirst, 'warm is a forced refresh even inside the TTL');

  const spawnsAfterWarm = subprocess.specs.length;
  await service.detect(temp.dir);
  assert.equal(subprocess.specs.length, spawnsAfterWarm, 'the warm result is cached again');

  await new Promise((resolve) => setTimeout(resolve, 60));
  await service.detect(temp.dir);
  assert.ok(subprocess.specs.length > spawnsAfterWarm, 'an expired entry is re-probed');

  await dispose();
  assert.equal(service.peek(temp.dir), undefined, 'disposal clears the cache');
});

test('JjService: dispose aborts in-flight jj work instead of waiting for the timeout', async (t) => {
  const temp = makeTempRoot('dsh-jj-service-dispose');
  t.after(() => temp.cleanup());
  const subprocess = hangingSubprocess();
  const { ctx, dispose } = serviceContext(subprocess);
  // An unwired dispose would block on the fake spawn until this timeout elapses; the
  // test races against a much shorter deadline instead of ever waiting for it, so the
  // regression shows up as a fast failure rather than a 5 s hang.
  const service = new JjService(ctx, { timeoutMs: 5_000, graceMs: 50, maxOutputBytes: 4_096 });

  const inFlight = service.detect(temp.dir);
  await waitUntil(() => subprocess.specs.length > 0);
  assert.equal(subprocess.specs[0]?.signal?.aborted, false, 'the spawn starts abortable but not aborted');

  const started = Date.now();
  const disposal = dispose();
  const outcome = await Promise.race([
    inFlight.then(
      (descriptor) => ({ settled: true, descriptor }),
      (error: unknown) => ({ settled: false, error }),
    ),
    delay(1_500),
  ]);
  assert.notEqual(outcome, 'timeout', 'dispose must abort the in-flight detection');
  assert.equal(await Promise.race([disposal.then(() => 'disposed'), delay(1_500)]), 'disposed', 'dispose settles promptly');
  assert.ok(Date.now() - started < 1_500, 'dispose does not wait for the configured timeout');
  assert.ok(subprocess.specs.every((spec) => spec.signal?.aborted === true), 'every spawn received the lifetime abort');
  assert.equal(service.peek(temp.dir), undefined);
});

test('headOperationId reads the operation log with --ignore-working-copy and creates no operation (real jj)', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-head-op');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  // Leave an unsnapshotted working-copy change: reading the head operation must not
  // snapshot it (the guard calls this on every shell command, so ops must not grow).
  await fx.run(['bash', '-c', 'printf dirty > dirty.txt'], { cwd: repo, timeoutMs: 5_000 });
  const operations = new JjOperations({ runJj: createCommandRunJj(fx.run, resolveConfig({})), config: {} });

  const readOperationIds = async (): Promise<string[]> => {
    const result = await mustRun(
      fx.run,
      ['jj', '--no-pager', '--color=never', 'op', 'log', '-n', '50', '--no-graph', '--ignore-working-copy', '-T', 'self.id() ++ "\\n"'],
      repo,
    );
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  const before = await readOperationIds();
  const head = await operations.headOperationId(repo);
  const after = await readOperationIds();
  assert.equal(after.length, before.length, 'reading the head id must not create an operation');
  assert.equal(after[0], before[0], 'the recorded head stays stable');
  assert.equal(head, before[0], 'headOperationId returns the newest recorded operation id');
});

test('headOperationId reads the operation log without snapshotting (fake runner argv)', async () => {
  const calls: string[][] = [];
  const operations = new JjOperations({
    runJj: async (options: RunJjOptions) => {
      calls.push([...options.argv]);
      return { exitCode: 0, signal: null, stdout: 'deadbeef\n', stderr: '', truncated: false, killedByTimeout: false };
    },
  });
  assert.equal(await operations.headOperationId('/repo'), 'deadbeef');
  assert.equal(calls[0]?.[0], 'op');
  assert.ok(calls[0]?.includes('--ignore-working-copy'), 'the guard path must not snapshot the working copy');
  assert.ok(calls[0]?.includes('--no-graph'));
});

test('undo: an unreadable head operation gives an actionable hint, never `jj op restore unknown`', async () => {
  const calls: string[][] = [];
  const operations = new JjOperations({
    runJj: async (options: RunJjOptions) => {
      calls.push([...options.argv]);
      if (calls.length === 1) {
        return { exitCode: 1, signal: null, stdout: '', stderr: 'op log is unavailable', truncated: false, killedByTimeout: false };
      }
      return { exitCode: 0, signal: null, stdout: 'Undo successful', stderr: '', truncated: false, killedByTimeout: false };
    },
  });
  const result = await operations.undo('/repo', undefined);
  assert.equal(result.mode, 'undo');
  assert.equal(calls.length, 2, 'one head read plus the undo itself');
  assert.equal(calls[0]?.includes('--ignore-working-copy'), false, 'undo snapshots first so the rollback target is the exact undone operation');
  assert.equal(result.headOperationId, 'unknown');
  assert.doesNotMatch(result.message, /op restore unknown/);
  assert.match(result.message, /jj_op_log/);
  assert.match(result.message, /Undo successful/);
});

test('handoff: an unusable jj surfaces JJ_NOT_INSTALLED instead of "no integration target"', async () => {
  const missing: RunOutcome = {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: 'spawn jj ENOENT',
    truncated: false,
    killedByTimeout: false,
  };
  const operations = new JjOperations({ runJj: async () => missing, config: {} });
  await assert.rejects(
    () => operations.handoff('/repo', {}),
    (error: unknown) => {
      assert.ok(error instanceof JjError, `expected a JjError, got: ${String(error)}`);
      assert.equal(error.code, 'JJ_NOT_INSTALLED');
      assert.doesNotMatch(error.message, /found no usable integration target/);
      return true;
    },
  );
});

test('tryReadAt still maps an unresolvable revset to the actionable fallback error', async () => {
  const badRevset: RunOutcome = {
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: "Error: Revision `nope` doesn't exist",
    truncated: false,
    killedByTimeout: false,
  };
  const operations = new JjOperations({ runJj: async () => badRevset, config: {} });
  await assert.rejects(
    () => operations.resolveHandoffTarget('/repo', { destination: 'nope', configured: 'trunk()' }),
    /does not resolve in this repository/,
  );
});

test('JjService: concurrent detect/warm calls for one cwd share a single probe', async (t) => {
  const temp = makeTempRoot('dsh-jj-service-inflight');
  t.after(() => temp.cleanup());

  // Baseline: one completed detection = one batch of probe spawns.
  const baselineSubprocess = immediateSubprocess('jj 0.46.0\n');
  const baseline = serviceContext(baselineSubprocess);
  const baselineService = new JjService(baseline.ctx, { timeoutMs: 5_000, graceMs: 50 });
  await baselineService.detect(temp.dir);
  const singleProbeSpawns = baselineSubprocess.specs.length;
  assert.ok(singleProbeSpawns > 0);
  await baseline.dispose();

  const subprocess = immediateSubprocess('jj 0.46.0\n');
  const { ctx, dispose } = serviceContext(subprocess);
  const service = new JjService(ctx, { timeoutMs: 5_000, graceMs: 50 });
  const descriptors = await Promise.all([
    service.detect(temp.dir),
    service.detect(temp.dir),
    service.detect(temp.dir),
  ]);
  assert.equal(subprocess.specs.length, singleProbeSpawns, 'three concurrent detect calls run one probe batch');
  assert.ok(descriptors.every((descriptor) => descriptor === descriptors[0]), 'all callers share the descriptor');

  const afterDetect = subprocess.specs.length;
  await Promise.all([service.warm(temp.dir), service.warm(temp.dir)]);
  assert.equal(subprocess.specs.length - afterDetect, singleProbeSpawns, 'concurrent warm calls share one probe batch');
  await dispose();
});

test('JjService: the detect cache is pruned to a bounded size', async (t) => {
  const temp = makeTempRoot('dsh-jj-service-prune');
  t.after(() => temp.cleanup());
  const subprocess = immediateSubprocess('jj 0.46.0\n');
  const { ctx, dispose } = serviceContext(subprocess);
  const service = new JjService(ctx, { timeoutMs: 5_000, graceMs: 50 });
  const cap = JjService.DETECT_CACHE_MAX_ENTRIES;
  const dirs: string[] = [];
  for (let index = 0; index < cap + 1; index += 1) {
    const dir = join(temp.dir, `repo-${index}`);
    mkdirSync(dir);
    dirs.push(dir);
    await service.warm(dir);
  }
  const evicted = dirs.filter((dir) => service.peek(dir) === undefined);
  assert.equal(evicted.length, 1, 'exactly the oldest entry beyond the cap is evicted');
  assert.equal(service.peek(dirs[0]), undefined, 'the oldest descriptor goes first');
  assert.notEqual(service.peek(dirs[cap]), undefined, 'the newest descriptor stays cached');
  await dispose();
});

test('JjService: version caches only a successful probe', async (t) => {
  const temp = makeTempRoot('dsh-jj-service-version');
  t.after(() => temp.cleanup());
  const subprocess = flakyVersionSubprocess();
  const { ctx, dispose } = serviceContext(subprocess);
  const service = new JjService(ctx, { timeoutMs: 5_000, graceMs: 50 });

  assert.deepEqual(await service.version(temp.dir), { jj: undefined, git: undefined }, 'a failed probe is not cached');
  const afterFailure = subprocess.specs.length;
  assert.deepEqual(await service.version(temp.dir), { jj: 'jj 0.46.0', git: undefined }, 'the retry succeeds');
  const afterSuccess = subprocess.specs.length;
  assert.ok(afterSuccess > afterFailure, 'the failed probe was retried');
  assert.deepEqual(await service.version(temp.dir), { jj: 'jj 0.46.0', git: undefined });
  assert.equal(subprocess.specs.length, afterSuccess, 'the successful probe is cached for the process lifetime');
  await dispose();
});
