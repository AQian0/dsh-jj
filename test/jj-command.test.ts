/**
 * Production subprocess adapters (`createRunJj` / `createRunGit`) and the jj
 * error vocabulary (audit 03 F2 / 01 M2-M7).
 *
 * Every other suite binds `createCommandRunJj`, so this file is the only place
 * that pins the real `ctx.subprocess.spawn` contract with a minimal fake:
 * argv/env shape, bounded collection, caller-abort propagation, the plugin-owned
 * deadline, termination when `done` rejects, synchronous spawn refusal, and
 * every `classifyJjFailure` / `jjErrorMessage` branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';
import { resolveConfig } from '../src/config.ts';
import {
  JjError,
  classifyJjFailure,
  createRunGit,
  createRunJj,
  jjErrorMessage,
  runJjChecked,
  type JjErrorCode,
  type JjRunResult,
} from '../src/jj-command.ts';

/** A complete settled result, with only the facts under test overridden. */
function settled(overrides: Partial<JjRunResult> = {}): JjRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, killedByTimeout: false, ...overrides };
}

/** A caller signal that is already aborted (the "cancelled before spawn" shape). */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  return controller.signal;
}

/** Observable termination calls on one fake handle. */
interface FakeCalls {
  terminate: number;
  waitForExit: number;
}

/** Behaviour of one fake spawn. */
interface FakeBehaviour {
  readonly outcome?: SubprocessOutcome;
  /** Reject `done` with this error after the handle is returned. */
  readonly rejectWith?: Error;
  readonly stdout?: { readonly text: string; readonly lossy: boolean };
  readonly stderr?: { readonly text: string; readonly lossy: boolean };
  /** Keep `done` pending until the spawn signal aborts, then reject. */
  readonly hangUntilAborted?: boolean;
  /** Throw from `spawn` synchronously instead of returning a handle. */
  readonly spawnError?: Error;
}

/** One fake spawn: the captured request and its observable calls. */
interface FakeSpawn {
  readonly spec: SubprocessSpawnSpec;
  readonly calls: FakeCalls;
}

/** Minimal fake `ctx.subprocess`, recording every spawn request it receives. */
interface FakeSubprocess {
  readonly ctx: Context;
  readonly spawns: FakeSpawn[];
}

/** One collected-output reader whose lossiness the test controls. */
function collectedReader(text: string, lossy: boolean): { readFrom(fromByte: number): SubprocessOutputRead } {
  return {
    readFrom: (fromByte: number): SubprocessOutputRead => {
      assert.equal(fromByte, 0, 'the adapter must read collected output from offset 0');
      return { text, nextOffset: Buffer.byteLength(text), lossy };
    },
  };
}

/** Build the fake handle the adapter will drive for one spawn. */
function fakeHandle(spec: SubprocessSpawnSpec, behaviour: FakeBehaviour, calls: FakeCalls): SubprocessHandle {
  const stdout = behaviour.stdout ?? { text: '', lossy: false };
  const stderr = behaviour.stderr ?? { text: '', lossy: false };
  let resolveDone!: (outcome: SubprocessOutcome) => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  if (behaviour.rejectWith !== undefined) {
    rejectDone(behaviour.rejectWith);
  } else if (behaviour.hangUntilAborted === true) {
    const signal = spec.signal;
    if (signal === undefined) throw new Error('hangUntilAborted needs a spawn signal');
    signal.addEventListener('abort', () => rejectDone(new Error('terminated by abort signal')), { once: true });
  } else {
    resolveDone(behaviour.outcome ?? { exitCode: 0, signal: null });
  }
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: collectedReader(stdout.text, stdout.lossy),
      stderr: collectedReader(stderr.text, stderr.lossy),
    },
    done,
    terminate: () => {
      calls.terminate += 1;
    },
    waitForExit: async (): Promise<boolean> => {
      calls.waitForExit += 1;
      return true;
    },
  };
}

/** Config defaults for the adapters under test (a few seconds, never the 30s default). */
const CONFIG = resolveConfig({ timeoutMs: 30_000, graceMs: 3_000, maxOutputBytes: 262_144 });

/** Build a fake `ctx.subprocess` driven by one behaviour for every spawn. */
function fakeSubprocess(behaviour: FakeBehaviour = {}): FakeSubprocess {
  const spawns: FakeSpawn[] = [];
  const ctx = {
    subprocess: {
      spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
        const calls: FakeCalls = { terminate: 0, waitForExit: 0 };
        spawns.push({ spec, calls });
        if (behaviour.spawnError !== undefined) throw behaviour.spawnError;
        return fakeHandle(spec, behaviour, calls);
      },
    },
  } as unknown as Context;
  return { ctx, spawns };
}

const ERROR_CODES: readonly JjErrorCode[] = [
  'JJ_NOT_INSTALLED',
  'JJ_TIMEOUT',
  'JJ_ABORTED',
  'JJ_SIGNALED',
  'JJ_NOT_A_REPO',
  'JJ_REPO_BROKEN',
  'JJ_BAD_REVSET',
  'JJ_BAD_INPUT',
  'JJ_COMMAND_FAILED',
  'JJ_OUTPUT_INVALID',
];

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

test('classifyJjFailure: a successful exit wins the race with a caller abort', () => {
  // The command may have completed before the cancellation landed; reporting it
  // as cancelled would hide a mutation that actually happened.
  assert.equal(classifyJjFailure(settled({ exitCode: 0 }), true), undefined);
  assert.equal(classifyJjFailure(settled({ exitCode: 0, stdout: 'done' }), true), undefined);
});

test('classifyJjFailure: timeout, abort, external signal, and spawn failure stay distinct', () => {
  assert.equal(classifyJjFailure(settled({ exitCode: null, signal: null, killedByTimeout: true }), false), 'JJ_TIMEOUT');
  assert.equal(classifyJjFailure(settled({ exitCode: null, signal: 'SIGKILL', killedByTimeout: true }), false), 'JJ_TIMEOUT');
  assert.equal(classifyJjFailure(settled({ exitCode: 1 }), true), 'JJ_ABORTED');
  // Node reports `exitCode: null` for both an external signal and a failed
  // spawn; only the signal field tells them apart (audit M2).
  assert.equal(classifyJjFailure(settled({ exitCode: null, signal: 'SIGTERM' }), false), 'JJ_SIGNALED');
  assert.equal(classifyJjFailure(settled({ exitCode: null, signal: 'SIGINT' }), false), 'JJ_SIGNALED');
  assert.equal(classifyJjFailure(settled({ exitCode: null, signal: null }), false), 'JJ_NOT_INSTALLED');
});

test('classifyJjFailure: jj failure vocabulary is table-driven', () => {
  const cases: ReadonlyArray<readonly [string, JjRunResult, JjErrorCode]> = [
    ['broken repository by exit code', settled({ exitCode: 255 }), 'JJ_REPO_BROKEN'],
    [
      'broken repository by stderr',
      settled({ exitCode: 1, stderr: 'Error: The repository appears broken or inaccessible' }),
      'JJ_REPO_BROKEN',
    ],
    ['inaccessible repository', settled({ exitCode: 1, stderr: 'Cannot access .jj/repo' }), 'JJ_REPO_BROKEN'],
    ['not a repository', settled({ exitCode: 1, stderr: 'Error: There is no jj repo in "/tmp/x"' }), 'JJ_NOT_A_REPO'],
    ['bad revset', settled({ exitCode: 1, stderr: 'Failed to parse revset: nope' }), 'JJ_BAD_REVSET'],
    ['usage error exit code', settled({ exitCode: 2, stderr: '' }), 'JJ_BAD_INPUT'],
    ['generic failure', settled({ exitCode: 1, stderr: 'something went wrong' }), 'JJ_COMMAND_FAILED'],
  ];
  for (const [label, result, expected] of cases) {
    assert.equal(classifyJjFailure(result, false), expected, label);
  }
});

test('jjErrorMessage: every code produces model-facing text naming the command', () => {
  for (const code of ERROR_CODES) {
    const message = jjErrorMessage(code, ['log', '-r', '@'], settled({ exitCode: 1, stdout: 'out', stderr: 'err' }), 'jj');
    assert.ok(message.length > 25, `${code} message must be actionable: ${message}`);
    if (code === 'JJ_NOT_INSTALLED') {
      // Not-installed text names the executable (the command never ran), not argv.
      assert.match(message, /jj executable/, `${code} message must name the executable: ${message}`);
    } else {
      assert.ok(message.includes('jj log -r @'), `${code} message must name the command: ${message}`);
    }
  }
});

test('jjErrorMessage: spawn failure and cancellation carry the new safety warnings', () => {
  const notInstalled = jjErrorMessage(
    'JJ_NOT_INSTALLED',
    ['status'],
    settled({ exitCode: null, stderr: 'ENOENT: jj not found' }),
    '/opt/jj',
  );
  assert.match(notInstalled, /ENOENT: jj not found/, 'the real spawn error must be surfaced');
  assert.match(notInstalled, /\/opt\/jj/, 'the configured command must be named');

  const aborted = jjErrorMessage('JJ_ABORTED', ['commit', '-m', 'x'], settled({ exitCode: null }), 'jj');
  assert.match(aborted, /jj_op_log/, 'a cancellation may have partially applied');
  assert.match(aborted, /partially changed/);

  const signaled = jjErrorMessage(
    'JJ_SIGNALED',
    ['rebase'],
    settled({ exitCode: null, signal: 'SIGTERM', stderr: 'killed' }),
    'jj',
  );
  assert.match(signaled, /SIGTERM/);
  assert.match(signaled, /jj_op_log/);
  assert.match(signaled, /killed/);

  const timeout = jjErrorMessage('JJ_TIMEOUT', ['rebase'], settled({ exitCode: null, killedByTimeout: true }), 'jj');
  assert.match(timeout, /jj_op_log/);
  const failed = jjErrorMessage('JJ_COMMAND_FAILED', ['x'], settled({ exitCode: 3, stderr: 'boom' }), 'jj');
  assert.match(failed, /exit code 3/);
});

// ---------------------------------------------------------------------------
// createRunJj / createRunGit: the real spawn adapters
// ---------------------------------------------------------------------------

test('createRunJj: spawns the documented non-interactive command with bounded collection', async () => {
  const fake = fakeSubprocess();
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'] });
  assert.deepEqual(result, settled());
  assert.equal(fake.spawns.length, 1);
  const spec = fake.spawns[0].spec;
  assert.deepEqual([...spec.argv], ['jj', '--no-pager', '--color=never', 'status']);
  assert.equal(spec.cwd, '/repo');
  assert.equal(spec.stdio.stdin, 'ignore');
  assert.deepEqual(spec.stdio.stdout, { maxBytes: 262_144 });
  assert.deepEqual(spec.stdio.stderr, { maxBytes: 262_144 });
  assert.equal(spec.graceMs, 3_000);
  assert.ok(spec.signal instanceof AbortSignal, 'the provider gets the plugin-owned controller signal');
  assert.equal(spec.env?.JJ_EDITOR, '/bin/false');
  assert.equal(spec.env?.NO_COLOR, '1');
  assert.equal(spec.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(spec.env?.PAGER, 'cat');
});

test('createRunJj: per-call options override the configured program, limits, and env', async () => {
  const fake = fakeSubprocess();
  await createRunJj(fake.ctx, CONFIG)({
    cwd: '/repo',
    argv: ['log'],
    jjCommand: '/opt/jj',
    maxOutputBytes: 4_096,
    graceMs: 25,
    env: { JJ_EDITOR: '/custom/editor' },
  });
  const spec = fake.spawns[0].spec;
  assert.equal(spec.argv[0], '/opt/jj');
  assert.deepEqual(spec.stdio.stdout, { maxBytes: 4_096 });
  assert.equal(spec.graceMs, 25);
  assert.equal(spec.env?.JJ_EDITOR, '/custom/editor', 'explicit env layers after the shield');
});

test('createRunJj: returns exit facts and both collected streams', async () => {
  const fake = fakeSubprocess({
    outcome: { exitCode: 1, signal: null },
    stdout: { text: 'OUT', lossy: false },
    stderr: { text: 'ERR', lossy: false },
  });
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'] });
  assert.deepEqual(result, settled({ exitCode: 1, stdout: 'OUT', stderr: 'ERR' }));
});

test('createRunJj: lossy collected output still returns its text and flags truncation', async () => {
  const fake = fakeSubprocess({
    stdout: { text: 'stdout-tail', lossy: true },
    stderr: { text: 'stderr-tail', lossy: true },
  });
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['log'] });
  assert.equal(result.stdout, 'stdout-tail');
  assert.equal(result.stderr, 'stderr-tail');
  assert.equal(result.truncated, true, 'lossy stdout is reported as truncated');
});

test('createRunJj: a rejected done terminates the handle and surfaces the error', async () => {
  const fake = fakeSubprocess({ rejectWith: new Error('provider crashed') });
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'] });
  assert.equal(result.exitCode, null);
  assert.equal(result.stderr, 'provider crashed');
  assert.equal(result.killedByTimeout, false);
  assert.equal(fake.spawns[0].calls.terminate, 1, 'the handle is terminated');
  assert.equal(fake.spawns[0].calls.waitForExit, 1, 'teardown waits for the managed range');
});

test('createRunJj: a synchronous spawn refusal is returned, not thrown', async () => {
  const fake = fakeSubprocess({ spawnError: new Error('spawn refused') });
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'] });
  assert.deepEqual(result, settled({ exitCode: null, stderr: 'spawn refused' }));
});

test('createRunJj: a pre-aborted caller spawns nothing', async () => {
  const fake = fakeSubprocess();
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'], signal: abortedSignal() });
  assert.equal(fake.spawns.length, 0);
  assert.deepEqual(result, settled({ exitCode: null }));
});

test('createRunJj: caller abort propagates to the provider and is not a timeout', async () => {
  const fake = fakeSubprocess({ hangUntilAborted: true });
  const controller = new AbortController();
  const pending = createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'], signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.spawns[0].spec.signal?.aborted, true, 'the provider receives the abort');
  assert.equal(result.killedByTimeout, false, 'caller cancellation is not the plugin deadline');
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /terminated by abort signal/);
});

test('createRunJj: the plugin deadline terminates a hanging process', { timeout: 5_000 }, async () => {
  const fake = fakeSubprocess({ hangUntilAborted: true });
  const started = Date.now();
  const result = await createRunJj(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['status'], timeoutMs: 20 });
  assert.equal(result.killedByTimeout, true);
  assert.equal(result.exitCode, null);
  assert.equal(fake.spawns[0].calls.terminate, 1);
  assert.ok(Date.now() - started < 2_000, 'a 20ms timeout must not wait for the 30s config default');
});

test('createRunGit: spawns a Git probe with the scrubbed Git environment', async () => {
  const fake = fakeSubprocess({ stdout: { text: 'rev\n', lossy: false } });
  const result = await createRunGit(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['rev-parse', '--show-toplevel'] });
  const spec = fake.spawns[0].spec;
  assert.deepEqual([...spec.argv], ['git', 'rev-parse', '--show-toplevel']);
  assert.equal(spec.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(spec.env?.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(spec.env?.GIT_PAGER, 'cat');
  assert.equal(spec.env?.NO_COLOR, '1');
  assert.equal(result.stdout, 'rev\n');
});

test(
  'createRunGit: a hung Git probe is bounded by the plugin timeout and terminated',
  { timeout: 5_000 },
  async () => {
    const fake = fakeSubprocess({ hangUntilAborted: true });
    const config = resolveConfig({ timeoutMs: 20, graceMs: 5 });
    const started = Date.now();
    const result = await createRunGit(fake.ctx, config)({ cwd: '/repo', argv: ['rev-parse', '--show-toplevel'] });
    const spawn = fake.spawns[0];
    assert.equal(result.killedByTimeout, true, 'the Git probe honours the configured deadline (audit M7)');
    assert.equal(result.exitCode, null);
    assert.equal(spawn.spec.graceMs, 5);
    assert.equal(spawn.spec.signal?.aborted, true);
    assert.equal(spawn.calls.terminate, 1);
    assert.ok(Date.now() - started < 2_000, 'a 20ms deadline must end the probe, not wait for the default');
  },
);

test('createRunGit: a pre-aborted caller spawns nothing', async () => {
  const fake = fakeSubprocess();
  const result = await createRunGit(fake.ctx, CONFIG)({ cwd: '/repo', argv: ['--version'], signal: abortedSignal() });
  assert.equal(fake.spawns.length, 0);
  assert.deepEqual(result, settled({ exitCode: null }));
});

// ---------------------------------------------------------------------------
// runJjChecked: classification + the thrown JjError contract
// ---------------------------------------------------------------------------

test('runJjChecked: success passes the result through', async () => {
  const expected = settled({ stdout: 'ok' });
  const result = await runJjChecked(async () => expected, { cwd: '/repo', argv: ['status'] }, CONFIG);
  assert.deepEqual(result, expected);
});

test('runJjChecked: a failed command throws JjError with code, message, and raw detail', async () => {
  const failure = settled({ exitCode: 255, stderr: 'Error: The repository appears broken or inaccessible' });
  await assert.rejects(runJjChecked(async () => failure, { cwd: '/repo', argv: ['log', '-r', '@'] }, CONFIG), (error: unknown) => {
    if (!(error instanceof JjError)) assert.fail(`expected a JjError, got ${String(error)}`);
    assert.equal(error.code, 'JJ_REPO_BROKEN');
    assert.match(error.message, /jj log -r @/);
    assert.match(error.message, /broken or inaccessible/);
    assert.deepEqual([...error.detail.argv], ['log', '-r', '@']);
    assert.equal(error.detail.exitCode, 255);
    assert.equal(error.detail.stderr, failure.stderr);
    assert.equal(error.detail.stdout, '');
    return true;
  });
});

test('runJjChecked: an externally signalled process is JJ_SIGNALED, not "jj missing"', async () => {
  const killed = settled({ exitCode: null, signal: 'SIGTERM', stderr: 'killed' });
  await assert.rejects(runJjChecked(async () => killed, { cwd: '/repo', argv: ['rebase'] }, CONFIG), (error: unknown) => {
    if (!(error instanceof JjError)) assert.fail(`expected a JjError, got ${String(error)}`);
    assert.equal(error.code, 'JJ_SIGNALED');
    assert.match(error.message, /SIGTERM/);
    assert.match(error.message, /jj_op_log/);
    return true;
  });
});

test('runJjChecked: a spawn-failure result is JJ_NOT_INSTALLED with the underlying error', async () => {
  const failure = settled({ exitCode: null, stderr: 'ENOENT: jj not found' });
  await assert.rejects(runJjChecked(async () => failure, { cwd: '/repo', argv: ['status'] }, CONFIG), (error: unknown) => {
    if (!(error instanceof JjError)) assert.fail(`expected a JjError, got ${String(error)}`);
    assert.equal(error.code, 'JJ_NOT_INSTALLED');
    assert.match(error.message, /ENOENT: jj not found/);
    return true;
  });
});

test('runJjChecked: a completed command is not reported as cancelled by a late abort', async () => {
  const signal = abortedSignal();
  const result = await runJjChecked(async () => settled({ stdout: 'done' }), { cwd: '/repo', argv: ['status'], signal }, CONFIG);
  assert.equal(result.stdout, 'done');
});

test('runJjChecked: a pre-aborted call is JJ_ABORTED and warns about partial effects', async () => {
  const signal = abortedSignal();
  await assert.rejects(
    runJjChecked(async () => settled({ exitCode: null }), { cwd: '/repo', argv: ['commit', '-m', 'x'], signal }, CONFIG),
    (error: unknown) => {
      if (!(error instanceof JjError)) assert.fail(`expected a JjError, got ${String(error)}`);
      assert.equal(error.code, 'JJ_ABORTED');
      assert.match(error.message, /jj_op_log/);
      return true;
    },
  );
});
