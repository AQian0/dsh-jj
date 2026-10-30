/**
 * Detection failure semantics (design contract §2.10 / §6.5): broken `.jj`,
 * missing executables, unusable repositories, timeouts, and cancellation.
 * Nothing here may throw an undiagnosable error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectVcs, sniffVcsSync } from '../src/detect.ts';
import type { DetectDeps, DetectInput, RunCommand, RunResult } from '../src/types.ts';
import { initJjColocated, initJjNative, makeFixture } from './helpers/fixtures.ts';

/** Wrap a runner so one argv condition returns a synthetic outcome. */
function intercept(
  baseRun: RunCommand,
  predicate: (argv: readonly string[]) => boolean,
  outcome: Partial<RunResult>,
): { wrapped: RunCommand; count: () => number } {
  let intercepted = 0;
  const wrapped: RunCommand = async (argv, options) => {
    if (predicate(argv)) {
      intercepted += 1;
      return { argv, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, ...outcome };
    }
    return baseRun(argv, options);
  };
  return { wrapped, count: () => intercepted };
}

test('F2: a stray empty `.jj` directory is unusable — `jj root` lies, `workspace list` exits 255', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-f2');
  const broken = fx.path('broken-jj');
  mkdirSync(join(broken, '.jj'), { recursive: true });

  // `jj root` returns exit 0 and prints the directory (the lie this contract guards against).
  const lie = await fx.run(['jj', '--ignore-working-copy', '--no-pager', '--color=never', 'root'], { cwd: broken });
  assert.equal(lie.exitCode, 0, 'jj root must be shown to be unreliable here');
  const truth = await fx.run(['jj', '--no-pager', '--color=never', 'workspace', 'list'], { cwd: broken });
  assert.notEqual(truth.exitCode, 0, 'workspace list is the authority');

  const descriptor = await detectVcs(broken, fx.run);
  assert.equal(descriptor.kind, 'none');
  assert.equal(descriptor.verified, false);
  assert.equal(descriptor.confidence, 'low');
  assert.equal(descriptor.jjRoot, broken, 'the .jj path is retained in the descriptor');
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-repo-broken'));
});

test('F3: a plain `.jj` FILE is not a jj marker', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-f3');
  const dir = fx.path('jj-file');
  writeFileSync(join(dir, '.jj'), 'not a workspace\n');
  const sniff = sniffVcsSync(dir);
  assert.equal(sniff.kind, 'none');
  assert.equal(sniff.jjRoot, undefined);
  assert.ok(sniff.diagnostics.some((entry) => entry.code === 'jj-metadata-incomplete'));
  const descriptor = await detectVcs(dir, fx.run);
  assert.equal(descriptor.kind, 'none');
});

test('F4: a broken `.jj/repo` pointer is diagnosed, not thrown', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-f4');
  const native = await initJjNative(fx.run, fx.path('native'));
  const workspacePath = join(fx.root, 'broken-link');
  await fx.run(['jj', 'workspace', 'add', '--name', 'gone', workspacePath], { cwd: native, timeoutMs: 30_000 });
  // Break the pointer so `.jj/repo` points nowhere.
  writeFileSync(join(workspacePath, '.jj', 'repo'), '../../does-not-exist/.jj/repo\n');

  const descriptor = await detectVcs(workspacePath, fx.run);
  assert.equal(descriptor.verified, false);
  assert.equal(descriptor.kind, 'none');
  assert.ok(
    descriptor.notices.some((entry) => entry.code === 'jj-pointer-broken' || entry.code === 'jj-repo-broken'),
    `expected a pointer/broken notice, got ${JSON.stringify(descriptor.notices)}`,
  );
});

test('jj executable missing: sniff-only descriptor, no throw', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-nojj');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const { wrapped } = intercept(fx.run, (argv) => argv[0] === 'jj', { errorCode: 'ENOENT' });
  const descriptor = await detectVcs(colo, wrapped);
  assert.equal(descriptor.kind, 'jj-colocated');
  assert.equal(descriptor.verified, false);
  assert.equal(descriptor.jjAvailable, false);
  assert.equal(descriptor.confidence, 'medium');
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-cli-missing'));
});

test('jj CLI unavailable in a jj-native workspace still classifies from the layout', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-nojj-native');
  const native = await initJjNative(fx.run, fx.path('native'));
  const { wrapped } = intercept(fx.run, (argv) => argv[0] === 'jj', { errorCode: 'ENOENT' });
  const descriptor = await detectVcs(native, wrapped);
  assert.equal(descriptor.kind, 'jj-native');
  assert.equal(descriptor.verified, false);
  assert.equal(descriptor.gitDir, undefined);
});

test('jj timeout is reported as jj-cli-timeout', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-timeout');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const { wrapped } = intercept(fx.run, (argv) => argv[0] === 'jj' && argv.includes('workspace'), {
    timedOut: true,
    signal: 'SIGKILL',
  });
  const descriptor = await detectVcs(colo, wrapped);
  assert.equal(descriptor.verified, false);
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-cli-timeout' || entry.code === 'jj-repo-unreadable'));
});

test('an already-aborted signal skips every probe', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-abort');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const controller = new AbortController();
  controller.abort();
  const { wrapped, count } = intercept(fx.run, () => true, { exitCode: 0 });
  const descriptor = await detectVcs(colo, wrapped, controller.signal);
  assert.equal(descriptor.kind, 'jj-colocated', 'the sniff still classifies');
  assert.equal(descriptor.confidence, 'low');
  assert.equal(count(), 0, 'no probe ran after cancellation');
  assert.ok(descriptor.notices.some((entry) => entry.code === 'cancelled'));
});

test('a runner that throws never escapes detectVcs', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-throw');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const throwing: RunCommand = async () => {
    throw new Error('runner exploded');
  };
  const descriptor = await detectVcs(colo, throwing);
  assert.equal(descriptor.kind, 'jj-colocated');
  assert.equal(descriptor.verified, false);
  assert.notEqual(descriptor.confidence, 'high');
});

test('detectVcs rejects a non-runner input as a programmer error', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-input');
  // Deliberately invalid values: this test exercises the programmer-error path.
  const notARunner = undefined as unknown as DetectInput;
  const emptyDeps = {} as unknown as DetectInput;
  await assert.rejects(() => detectVcs(fx.root, notARunner), TypeError);
  await assert.rejects(() => detectVcs(fx.root, emptyDeps), TypeError);
});

test('contract-shaped DetectDeps input works (runJj/runGit, argv without the program)', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-deps');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const calls: string[][] = [];
  const deps: DetectDeps = {
    runJj: async ({ cwd, argv, timeoutMs }) => {
      calls.push(['jj', ...argv]);
      const result = await fx.run(['jj', ...argv], { cwd, timeoutMs });
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: false,
        killedByTimeout: result.timedOut,
      };
    },
    runGit: async ({ cwd, argv, timeoutMs }) => {
      calls.push(['git', ...argv]);
      const result = await fx.run(['git', ...argv], { cwd, timeoutMs });
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: false,
        killedByTimeout: result.timedOut,
      };
    },
    statKind: async (path) => {
      try {
        const { lstatSync } = await import('node:fs');
        const stat = lstatSync(path);
        return stat.isDirectory() ? 'dir' : 'file';
      } catch {
        return 'missing';
      }
    },
  };
  const descriptor = await detectVcs(colo, deps);
  assert.equal(descriptor.kind, 'jj-colocated');
  assert.equal(descriptor.verified, true);
  assert.ok(
    calls.some((call) => call[0] === 'jj' && call.includes('workspace')),
    'the jj authority probe ran',
  );
  assert.ok(
    calls.every((call) => call[1] !== undefined),
    'the program name is supplied by the adapter, never by deps',
  );
});
/** DetectDeps whose jj workspace-list probe returns a synthetic result. */
function depsWithWorkspaceList(
  fx: ReturnType<typeof makeFixture>,
  synthetic: { readonly stdout: string; readonly truncated: boolean },
): DetectDeps {
  const delegateJj = async ({ cwd, argv, timeoutMs }: Parameters<NonNullable<DetectDeps['runJj']>>[0]) => {
    const result = await fx.run(['jj', ...argv], { cwd, timeoutMs });
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: false,
      killedByTimeout: result.timedOut,
    };
  };
  return {
    runJj: async (options) => {
      if (options.argv.includes('workspace')) {
        return {
          exitCode: 0,
          signal: null,
          stdout: synthetic.stdout,
          stderr: '',
          truncated: synthetic.truncated,
          killedByTimeout: false,
        };
      }
      return delegateJj(options);
    },
    runGit: async ({ cwd, argv, timeoutMs }) => {
      const result = await fx.run(['git', ...argv], { cwd, timeoutMs });
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: false,
        killedByTimeout: result.timedOut,
      };
    },
  };
}

test('M6: a truncated workspace list is diagnosed and degrades confidence', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-truncated');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const deps = depsWithWorkspaceList(fx, { stdout: '{"name":"default","root":"', truncated: true });
  const descriptor = await detectVcs(colo, deps);
  assert.equal(descriptor.kind, 'jj-colocated', 'the layout still classifies');
  assert.equal(descriptor.workspaceName, undefined);
  assert.deepEqual(descriptor.workspaces, []);
  assert.equal(descriptor.confidence, 'low', 'a truncated authority output cannot be high confidence');
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-metadata-incomplete'));
});

test('M6: an unparsable workspace list is diagnosed instead of silently high confidence', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-unparsed');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const deps = depsWithWorkspaceList(fx, { stdout: 'Warning: unexpected output\n', truncated: false });
  const descriptor = await detectVcs(colo, deps);
  assert.equal(descriptor.confidence, 'low');
  assert.ok(
    descriptor.notices.some(
      (entry) => entry.code === 'jj-metadata-incomplete' && /could not be parsed/.test(entry.message ?? ''),
    ),
  );
});

test('M6: an empty workspace list keeps the sniffed root but lowers confidence to medium', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-fail-empty-list');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const deps = depsWithWorkspaceList(fx, { stdout: '', truncated: false });
  const descriptor = await detectVcs(colo, deps);
  assert.equal(descriptor.confidence, 'medium');
  assert.equal(descriptor.workspaceName, undefined);
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-metadata-incomplete'));
});
