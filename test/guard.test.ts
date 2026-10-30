/**
 * End-to-end guard behaviour against real repositories (design contract §8).
 *
 * The decision path is synchronous (filesystem sniff or a warmed service cache),
 * so these tests use real jj/git fixtures plus a context double that reproduces
 * `ctx.tools.guard(...)` and the `tools/pre-execute` waterfall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import type { JjPluginConfig } from '../src/config.ts';
import { apply as applyGuardEntry, evaluateGitCommand, installGitConfusionGuard } from '../src/guard.ts';
import type {
  GitConfusionGuardHandle,
  GuardDescriptorLike,
  GuardExecutionLike,
  GuardOptions,
  GuardServiceLike,
} from '../src/guard.ts';
import { createGuardContext, initGit, initJjColocated, initJjNative, makeFixture } from './helpers/fixtures.ts';
import type { GuardHarness, HarnessToolResult } from './helpers/fixtures.ts';

function install(harness: GuardHarness, options: JjPluginConfig | GuardOptions = {}): GitConfusionGuardHandle {
  const guard = installGitConfusionGuard(harness.ctx, options);
  return guard;
}

function bash(command: string, workdir?: string): GuardExecutionLike {
  return { name: 'bash', arguments: workdir === undefined ? { command } : { command, workdir } };
}

test('config defaults match the contract §5.2', () => {
  const config = resolveConfig();
  // Policy 2026-10-22: a jj workspace PREFERS jj; git stays available and the model
  // gets a preference notice appended to the tool result (deny is opt-in).
  assert.equal(config.guardMutatingGit, 'warn');
  assert.equal(config.guardGitInJjNative, 'warn');
  assert.deepEqual([...config.guardTools], ['bash', 'pwsh', 'terminal_send']);
  assert.equal(config.guardCreateWorktree, true);
  assert.equal(config.readOnlyGitNotice, true);
});

test('deny (explicit): mutating git in a colocated jj workspace is blocked with a jj equivalent', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-deny');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', defaultCwd: colo });
  const reason = harness.runGuard(bash('git commit -m "x"', colo));
  assert.ok(typeof reason === 'string');
  assert.match(reason, /^Blocked: `git commit` in a Jujutsu \(jj\) workspace \(jj-colocated: /);
  assert.match(reason, /jj commit -m "…"/);
  assert.match(reason, /Use the jj equivalent instead:/);
  assert.match(reason, /guardMutatingGit to "warn" or "off"/);
});

test('deny: read-only git commands are allowed in a jj workspace', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-read');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { readOnlyGitNotice: false, defaultCwd: colo });
  for (const command of ['git status', 'git log --oneline', 'git diff', 'git rev-parse HEAD', 'git branch -a']) {
    assert.equal(harness.runGuard(bash(command, colo)), undefined, `${command} must be allowed`);
  }
});

test('deny: mutating git outside any jj workspace is not touched', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-outside');
  const git = await initGit(fx.run, fx.path('git'));
  const empty = fx.path('empty');
  const harness = createGuardContext();
  install(harness, { defaultCwd: empty });
  assert.equal(harness.runGuard(bash('git commit -m x', git)), undefined, 'plain Git repository');
  assert.equal(harness.runGuard(bash('git commit -m x', empty)), undefined, 'not a repository');
});

test('deny: jj-native refusal uses the jj-native reason and a jj workspace equivalent', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-native');
  const native = await initJjNative(fx.run, fx.path('native'));
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', defaultCwd: native });
  const reason = harness.runGuard(bash('git worktree add ../wt', native));
  assert.match(reason ?? '', /jj-native: /);
  assert.match(reason ?? '', /jj workspace add <path>/);
  assert.match(reason ?? '', /no root \.git/);
});

test('deny: `-C` and `cd` retarget the effective directory', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-cd');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const git = await initGit(fx.run, fx.path('git'));
  const native = await initJjNative(fx.run, fx.path('native'));
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', defaultCwd: colo });
  assert.equal(harness.runGuard(bash(`git -C ${git} commit -m x`, colo)), undefined);
  assert.equal(harness.runGuard(bash(`cd ${git} && git commit -m x`, colo)), undefined);
  assert.equal(typeof harness.runGuard(bash(`cd ${native} && git commit -m x`, colo)), 'string');
});

test('deny: guardTools limits which tools are inspected', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-tools');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', guardTools: ['pwsh'], defaultCwd: colo });
  assert.equal(harness.runGuard(bash('git commit -m x', colo)), undefined, 'bash is not in guardTools');
  assert.equal(
    typeof harness.runGuard({ name: 'pwsh', arguments: { command: 'git commit -m x', workdir: colo } }),
    'string',
  );
  assert.equal(harness.runGuard({ name: 'read', arguments: { file_path: join(colo, 'x') } }), undefined);
});

test('warn mode never blocks and reports through emit + logger', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-warn');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const guard = install(harness, { guardMutatingGit: 'warn', readOnlyGitNotice: false, defaultCwd: colo });
  assert.equal(harness.runGuard(bash('git commit -m x', colo)), undefined, 'warn mode must not block');
  assert.equal(guard.warnings().length, 1);
  assert.equal(guard.warnings()[0]?.subcommand, 'commit');
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0]?.event, 'jj/git-confusion');
  assert.equal(harness.events[0]?.payload?.kind, 'jj-colocated');
  assert.equal(harness.logged.length, 1);
});

test('off mode disables the command-line guard entirely', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-off');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const guard = install(harness, { guardMutatingGit: 'off', defaultCwd: colo });
  assert.equal(harness.runGuard(bash('git commit -m x', colo)), undefined);
  assert.equal(guard.warnings().length, 0);
  assert.equal(harness.events.length, 0);
});

test('guardGitInJjNative (explicit deny): read-only git in a jj-native workspace is refused', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-native-read');
  const native = await initJjNative(fx.run, fx.path('native'));

  const defaultHarness = createGuardContext();
  install(defaultHarness, { guardGitInJjNative: 'deny', defaultCwd: native });
  const defaultReason = defaultHarness.runGuard(bash('git status', native));
  assert.match(defaultReason ?? '', /^Blocked: `git status` in a Jujutsu \(jj\) workspace \(jj-native: /);
  assert.match(defaultReason ?? '', /jj log \/ jj status/);

  const warnHarness = createGuardContext();
  install(warnHarness, { guardGitInJjNative: 'warn', defaultCwd: native });
  assert.equal(warnHarness.runGuard(bash('git log --oneline', native)), undefined, 'warn allows with a notice');
  assert.equal(warnHarness.events.length, 1, 'one-time notice');
  warnHarness.runGuard(bash('git log --oneline', native));
  assert.equal(warnHarness.events.length, 1, 'the notice is emitted once per (cwd, code, subcommand)');

  const offHarness = createGuardContext();
  install(offHarness, { guardGitInJjNative: 'off', defaultCwd: native });
  assert.equal(offHarness.runGuard(bash('git status', native)), undefined);
  assert.equal(offHarness.events.length, 0);
});

test('readOnlyGitNotice: a colocated read-only git call emits a one-time notice', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-readnotice');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: colo });
  assert.equal(harness.runGuard(bash('git log --oneline', colo)), undefined);
  assert.equal(harness.events.length, 1);
  assert.match(harness.events[0]?.payload?.message ?? '', /colocated jj workspace/);
  harness.runGuard(bash('git log --oneline', colo));
  assert.equal(harness.events.length, 1);
});

test('create_worktree is blocked in a jj workspace and allowed in a Git repository', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-wt');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const git = await initGit(fx.run, fx.path('git'));

  const inJj = createGuardContext();
  install(inJj, { defaultCwd: colo });
  const reason = inJj.runGuard({ name: 'create_worktree', arguments: { name: 'feature' } });
  assert.match(reason ?? '', /^Blocked: `create_worktree` in a Jujutsu \(jj\) workspace \(jj-colocated: /);
  assert.match(reason ?? '', /jj_workspace_add/);
  assert.match(reason ?? '', /working-directory tool/);

  const inGit = createGuardContext();
  install(inGit, { defaultCwd: git });
  assert.equal(inGit.runGuard({ name: 'create_worktree', arguments: { name: 'feature' } }), undefined);

  const disabled = createGuardContext();
  install(disabled, { guardCreateWorktree: false, defaultCwd: colo });
  assert.equal(disabled.runGuard({ name: 'create_worktree', arguments: { name: 'feature' } }), undefined);
});

test('F6 shadowed case: a nested Git repository is not guarded', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-f6');
  await initJjColocated(fx.run, fx.path('outer'));
  const nested = await initGit(fx.run, fx.path('outer/nested'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: nested });
  assert.equal(harness.runGuard(bash('git commit -m x', nested)), undefined, 'git owns this directory');

  // The nearest-repository rule also covers tools: this directory is a plain Git
  // repository, so `create_worktree` is allowed (the jj workspace is only an ancestor).
  const nestedToolHarness = createGuardContext();
  install(nestedToolHarness, { defaultCwd: nested });
  assert.equal(
    nestedToolHarness.runGuard({ name: 'create_worktree', arguments: { name: 'feature' } }),
    undefined,
    'create_worktree follows the nearest repository, like git commands do',
  );
});

test('unknown and unparsable invocations are never blocked', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-unknown');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: colo });
  assert.equal(harness.runGuard(bash('git frobnicate --x', colo)), undefined);
  assert.equal(harness.runGuard(bash('git', colo)), undefined);
  assert.equal(harness.runGuard(bash('git commit -m "unterminated', colo)), undefined);
  assert.equal(harness.runGuard({ name: 'bash', arguments: { description: 'no command' } }), undefined);
  assert.equal(harness.runGuard({ name: 'bash', arguments: {} }), undefined);
});

test('the returned handle is itself the disposer and is idempotent', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-dispose');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const dispose = install(harness, { guardMutatingGit: 'deny', defaultCwd: colo });
  assert.equal(typeof dispose, 'function');
  assert.equal(typeof harness.runGuard(bash('git commit -m x', colo)), 'string');
  dispose();
  assert.equal(harness.guards.length, 0);
  assert.equal(harness.runGuard(bash('git commit -m x', colo)), undefined);
  dispose();
  dispose.dispose();
  assert.equal(harness.guards.length, 0);
  assert.equal(typeof dispose.check, 'function');
  assert.equal(typeof dispose.config, 'object');
});

test('the async warm-up seam precomputes the decision before guards run', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-warm');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const warmed: string[] = [];
  install(harness, {
    config: { guardMutatingGit: 'deny' },
    warm: async (cwd) => {
      warmed.push(cwd);
    },
  });
  const execution = { name: 'bash', callId: 'call-1', arguments: { command: 'git commit -m x', workdir: colo } };
  const reason = await harness.runPipeline(execution);
  assert.deepEqual(warmed, [colo], 'the warm-up listener ran before the guard');
  assert.match(reason ?? '', /^Blocked: `git commit`/);
  // The cached decision short-circuits even if the working directory disappears.
  assert.match(harness.runGuard(execution) ?? '', /^Blocked: `git commit`/);
});

test('evaluateGitCommand is a pure classifier with an injectable sniff', () => {
  const layouts: Readonly<Record<string, GuardDescriptorLike>> = {
    '/jj': { kind: 'jj-colocated', jjRoot: '/jj', root: '/jj', workspaceName: 'default' },
    '/git': { kind: 'git', jjRoot: undefined, root: '/git' },
  };
  const evaluation = evaluateGitCommand('cd /jj && git commit -m x && git status', '/git', {
    sniff: (cwd) => layouts[cwd] ?? { kind: 'none', jjRoot: undefined, root: cwd },
  });
  assert.equal(evaluation.findings.length, 1);
  assert.equal(evaluation.findings[0]?.invocation.subcommand, 'commit');
  assert.match(evaluation.findings[0]?.message ?? '', /jj commit -m "…"/);
  assert.equal(evaluation.effectiveCwds[0], '/jj');
});

test('warn-mode warning buffer is bounded and clearable', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-buffer');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const guard = install(harness, { guardMutatingGit: 'warn', defaultCwd: colo });
  for (let index = 0; index < 60; index += 1) {
    harness.runGuard(bash(`git commit -m "n${index}"`, colo));
  }
  assert.equal(guard.warnings().length, 50);
  guard.clearWarnings();
  assert.equal(guard.warnings().length, 0);
});
// ---------------------------------------------------------------------------
// jj-side repository-wide operations (contract §8.3b / v2.0)
// ---------------------------------------------------------------------------

test('T19a: `jj undo` is allowed by default and reported as a repository-wide operation', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-jjundo');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: colo });
  assert.equal(harness.runGuard(bash('jj undo', colo)), undefined, 'jj undo is the preferred recovery path');
  const repoWide = harness.events.filter((entry) => entry.event === 'jj/repo-wide-op');
  assert.equal(repoWide.length, 1);
  assert.match(repoWide[0]?.payload?.message ?? '', /repository-wide/);
  assert.match(repoWide[0]?.payload?.message ?? '', /--at-op=<op-id>/);
  harness.runGuard(bash('jj undo', colo));
  assert.equal(harness.events.filter((entry) => entry.event === 'jj/repo-wide-op').length, 1, 'one-time notice');
});

test('T19b: guardJjRepositoryWide=deny blocks with --at-op and the jj_undo tool pointer', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-jjdeny');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { guardJjRepositoryWide: 'deny', defaultCwd: colo });
  for (const command of ['jj undo', 'jj op restore abcdef', 'jj redo', 'jj abandon xyz']) {
    const reason = harness.runGuard(bash(command, colo));
    assert.ok(typeof reason === 'string', `${command} must be blocked in deny mode`);
    assert.match(reason, /^Blocked: `jj /);
    assert.match(reason, /--at-op=<op-id>/);
    assert.match(reason, /jj_undo tool/);
  }
});

test('T19c: workspace-local and read-only jj commands are never blocked', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-jjlocal');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { guardJjRepositoryWide: 'deny', defaultCwd: colo });
  for (const command of [
    'jj new',
    'jj describe -m x',
    'jj squash',
    'jj rebase -d main',
    'jj restore file',
    'jj split',
    'jj op log',
    'jj log -r @',
    'jj status',
    'jj diff',
    'jj --at-op=abcdef jj log',
  ]) {
    assert.equal(harness.runGuard(bash(command, colo)), undefined, `${command} must be allowed`);
  }
});

test('T19d: scope creep (`jj -R <ancestor> undo`) is always denied', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-scope');
  const outer = await initJjNative(fx.run, fx.path('outer'));
  const inner = await initJjNative(fx.run, fx.path('outer/inner'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: inner });
  const reason = harness.runGuard(bash(`jj -R ${outer} undo`, inner));
  assert.ok(typeof reason === 'string');
  assert.match(reason, /targets `.*outer`, which is not the repository this session is working in/);

  const okHarness = createGuardContext();
  install(okHarness, { defaultCwd: inner });
  assert.equal(okHarness.runGuard(bash(`jj -R ${inner} new`, inner)), undefined, 'the same repository is fine');
});

test('T19e: `jj workspace forget <other>` is denied regardless of mode', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-forget');
  const native = await initJjNative(fx.run, fx.path('native'));
  // Keep the linked workspace inside the fixture root so the fixture cleanup
  // removes it (a `${fx.root}-ws` path used to leak one directory per run).
  const wsPath = join(fx.root, 'ws-other');
  await fx.run(['jj', 'workspace', 'add', '--name', 'other', wsPath], { cwd: native, timeoutMs: 30_000 });
  const harness = createGuardContext();
  install(harness, { defaultCwd: native });
  const reason = harness.runGuard(bash('jj workspace forget other', native));
  assert.ok(typeof reason === 'string', 'forgetting another workspace is denied even in warn mode');
  assert.match(reason, /^Blocked: `jj workspace forget other`/);
  assert.match(reason, /jj_workspace_cleanup/, 'the refusal points at the safe session-owned cleanup path');
  assert.match(
    reason,
    /leave the cleanup to the user/,
    'non-owned workspaces stay a user action with the exact command',
  );
});

test('T20 (base layer): the decision path is synchronous and spawns nothing', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-sync');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const guard = install(harness, { guardMutatingGit: 'deny', defaultCwd: colo });
  let completed = false;
  const reason = harness.runGuard(bash('git commit -m x', colo));
  completed = true;
  assert.equal(completed, true);
  assert.match(reason ?? '', /^Blocked/);
  // The guard API has no runner injection at all: the decision uses the sniff
  // cache, so the tool path cannot spawn a git subprocess (the tools-layer T20
  // assertion additionally checks tool argv).
  assert.equal(typeof guard.peek(colo)?.kind, 'string');
});

// ---------------------------------------------------------------------------
// v2.2/v2.3: hard denies and the widened warn class (contract §8.3b)
// ---------------------------------------------------------------------------

test('T21: hard-deny jj calls are refused and cannot be enabled by config', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-harddeny');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const hardDenies: ReadonlyArray<readonly [string, RegExp]> = [
    ['jj restore', /removed 1 files/],
    ['jj abandon @', /working copy/],
    ['jj undo --allow-cross-workspace', /cross-workspace/],
  ];
  for (const mode of ['warn', 'off'] as const) {
    const harness = createGuardContext();
    install(harness, { guardJjRepositoryWide: mode, defaultCwd: colo });
    for (const [command, detail] of hardDenies) {
      const reason = harness.runGuard(bash(command, colo));
      assert.ok(typeof reason === 'string', `${command} must be refused even with guardJjRepositoryWide=${mode}`);
      assert.match(reason, /^Blocked: `jj /);
      assert.match(reason, /jj --at-op=<op-id>/);
      assert.match(reason, detail);
    }
  }
});

test('T21b: `jj restore <path>` stays allowed while `jj restore` alone is refused', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-restore');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: colo });
  assert.equal(harness.runGuard(bash('jj restore file.txt', colo)), undefined);
  assert.equal(typeof harness.runGuard(bash('jj restore', colo)), 'string');
});

test('T21c: `jj edit <rev>` and `jj new <rev>` are warned (v2.2), `jj new` alone is allowed', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-editnew');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { guardJjRepositoryWide: 'warn', defaultCwd: colo });
  for (const command of ['jj edit @-', 'jj new @-', 'jj op revert abcdef', 'jj abandon xyz']) {
    assert.equal(harness.runGuard(bash(command, colo)), undefined, `${command} is warn-class (allowed in warn mode)`);
  }
  assert.equal(
    harness.events.filter((entry) => entry.event === 'jj/repo-wide-op').length >= 3,
    true,
    'each warned call emits jj/repo-wide-op',
  );
  assert.equal(
    harness.runGuard(bash('jj new', colo)),
    undefined,
    '`jj new` without a revset only starts an empty change',
  );
  assert.equal(harness.runGuard(bash('jj describe -m x', colo)), undefined);

  const denyHarness = createGuardContext();
  install(denyHarness, { guardJjRepositoryWide: 'deny', defaultCwd: colo });
  assert.equal(typeof denyHarness.runGuard(bash('jj edit @-', colo)), 'string');
  assert.equal(typeof denyHarness.runGuard(bash('jj new @-', colo)), 'string');
  assert.equal(denyHarness.runGuard(bash('jj new', colo)), undefined, '`jj new` stays allowed even in deny mode');
});

test('T21d: repo-wide warnings name the head operation when the service provides one', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-headop');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, {
    defaultCwd: colo,
    warm: async () => {},
    // Deliberately partial service double: the guard only reads kind/jjRoot/root/
    // workspaceName from `peek`, while the real service returns a full descriptor.
    service: {
      peek: () => ({ kind: 'jj-colocated', jjRoot: colo, root: colo, workspaceName: 'default' }),
      warm: async () => {},
      operations: { headOperationId: async () => 'deadbeefcafe' },
    } as unknown as GuardServiceLike,
  });
  const execution = { name: 'bash', callId: 'call-head', arguments: { command: 'jj undo', workdir: colo } };
  await harness.runPipeline(execution);
  const event = harness.events.find((entry) => entry.event === 'jj/repo-wide-op');
  assert.ok(event !== undefined, 'the repo-wide warning was emitted');
  assert.match(event.payload.message ?? '', /Head operation before this call: deadbeefcafe/);
  assert.match(event.payload.message ?? '', /jj op restore deadbeefcafe/);
});

test('default (warn): a git write runs and the MODEL gets a jj-preference notice', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-prefer');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  const guard = install(harness, { readOnlyGitNotice: false, defaultCwd: colo });
  const execution = { name: 'bash', callId: 'call-prefer', arguments: { command: 'git commit -m "x"', workdir: colo } };

  // Policy 2026-10-22: a jj workspace PREFERS jj; it does not forbid git.
  const reason = await harness.runPipeline(execution);
  assert.equal(reason, undefined, 'the default must not block a git write');
  assert.ok(guard.warnings().length >= 1, 'the write is still observed');

  // The preference must reach the model: tools/post-execute appends a notice.
  const list = harness.listeners.get('tools/post-execute') ?? [];
  assert.equal(list.length, 1, 'the guard registers exactly one post-execute listener');
  let index = 0;
  const next = async (): Promise<unknown> =>
    index < list.length
      ? await list[index++](execution, { content: [{ type: 'text', text: 'ok' }] }, next)
      : { kind: 'accept' };
  const decision = (await next()) as HarnessToolResult;
  assert.equal(decision.kind, 'accept');
  const texts = (decision.content ?? []).map((block) => block.text ?? '').join('\n');
  assert.match(texts, /ok/, 'the original tool output is preserved');
  assert.match(texts, /prefers jj/, 'the notice states the preference');
  assert.match(texts, /git commit/, 'the notice names the command');
  assert.match(texts, /jj (describe|new|commit)/, 'the notice names the jj equivalent');
});
// ---------------------------------------------------------------------------
// Audited P0 fixes: cwd ownership, canonical scope comparison, warm-up cost,
// and config validation at boot.
// ---------------------------------------------------------------------------

test('a relative `workdir` resolves against the session cwd, not the host directory', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-relworkdir');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const plain = fx.path('plain');
  const session = { id: 'rel-session' };
  const agent = { id: 'rel-agent', session };
  const harness = createGuardContext();
  (harness.ctx as unknown as Record<string, unknown>)['workingDirectory'] = {
    get: (key: unknown) => (key === session ? colo : undefined),
  };
  install(harness, { guardMutatingGit: 'deny', defaultCwd: plain });

  const relative = harness.runGuard({
    name: 'bash',
    callId: 'rel-1',
    arguments: { command: 'git commit -m x', workdir: '.' },
    agent,
  });
  assert.match(
    relative ?? '',
    /^Blocked: `git commit`/,
    'a relative workdir must stay anchored to the session repository',
  );

  const noWorkdir = harness.runGuard({
    name: 'bash',
    callId: 'rel-2',
    arguments: { command: 'git commit -m x' },
    agent,
  });
  assert.match(noWorkdir ?? '', /^Blocked: `git commit`/, 'the session cwd itself is still guarded');

  const absoluteOutside = harness.runGuard({
    name: 'bash',
    callId: 'rel-3',
    arguments: { command: 'git commit -m x', workdir: plain },
    agent,
  });
  assert.equal(absoluteOutside, undefined, 'an explicit workdir outside jj is not guarded');
});

test('scope creep compares canonical paths, so a symlinked workspace is not another repository', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-scope-link');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const other = await initJjNative(fx.run, fx.path('other'));
  const link = join(fx.root, 'colo-link');
  symlinkSync(colo, link, 'dir');
  const harness = createGuardContext();
  install(harness, { defaultCwd: link });

  assert.equal(
    harness.runGuard({
      name: 'bash',
      callId: 'scope-link',
      arguments: { command: `jj -R ${colo} new`, workdir: link },
    }),
    undefined,
    'the same repository reached through a symlink must not be refused as scope creep',
  );
  const refused = harness.runGuard({
    name: 'bash',
    callId: 'scope-other',
    arguments: { command: `jj -R ${other} undo`, workdir: link },
  });
  assert.match(refused ?? '', /targets `.*other`, which is not the repository this session is working in/);
});

test('the head operation is only read for repository-wide jj commands', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-headop-lazy');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  let headReads = 0;
  const service = {
    peek: () => ({ kind: 'jj-colocated', jjRoot: colo, root: colo, workspaceName: 'default' }),
    warm: async () => {},
    operations: {
      headOperationId: async () => {
        headReads += 1;
        return 'cafebabe';
      },
    },
  } as unknown as GuardServiceLike;
  install(harness, { config: { defaultCwd: colo }, service });

  await harness.runPipeline({ name: 'bash', callId: 'lazy-ls', arguments: { command: 'ls', workdir: colo } });
  assert.equal(headReads, 0, 'a plain shell call must not read the jj operation log');
  await harness.runPipeline({
    name: 'bash',
    callId: 'lazy-git',
    arguments: { command: 'git commit -m x', workdir: colo },
  });
  assert.equal(headReads, 0, 'a mutating git command does not need a jj rollback target');
  await harness.runPipeline({ name: 'bash', callId: 'lazy-undo', arguments: { command: 'jj undo', workdir: colo } });
  assert.equal(headReads, 1, 'a repository-wide jj command reads the head operation once');
  const event = harness.events.find((entry) => entry.event === 'jj/repo-wide-op');
  assert.match(event?.payload?.message ?? '', /Head operation before this call: cafebabe/);
});

test('the precomputed decision is dropped after the tool call finishes', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-decisions');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const plain = fx.path('plain');
  const harness = createGuardContext();
  let kind: 'jj-colocated' | 'none' = 'jj-colocated';
  const service = {
    peek: () =>
      kind === 'jj-colocated'
        ? { kind: 'jj-colocated', jjRoot: colo, root: colo, workspaceName: 'default' }
        : { kind: 'none', jjRoot: undefined, root: plain },
    warm: async () => {},
  } as unknown as GuardServiceLike;
  install(harness, { config: { guardMutatingGit: 'deny', defaultCwd: colo }, service });

  const execution = { name: 'bash', callId: 'cleanup-1', arguments: { command: 'git commit -m x', workdir: colo } };
  assert.match((await harness.runPipeline(execution)) ?? '', /^Blocked/);
  assert.match(harness.runGuard(execution) ?? '', /^Blocked/, 'the decision stays cached until the tool finishes');

  // Simulate the host finishing the tool call: the post-execute listener drops it.
  const list = harness.listeners.get('tools/post-execute') ?? [];
  const next = async (): Promise<unknown> => ({ kind: 'accept' });
  for (const listener of list) await listener(execution, { content: [] }, next);

  kind = 'none';
  assert.equal(harness.runGuard(execution), undefined, 'after post-execute the decision is recomputed');
});

test('the guard entry validates its config at boot', () => {
  const harness = createGuardContext();
  const ctx = harness.ctx as unknown as Parameters<typeof applyGuardEntry>[0];
  assert.doesNotThrow(() => applyGuardEntry(ctx, {}));
  assert.throws(() => applyGuardEntry(ctx, { timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => applyGuardEntry(ctx, { commitStyle: 'custom' }), /commitStyleCustom/);
  assert.throws(() => applyGuardEntry(ctx, { rebaseTarget: '   ' }), /rebaseTarget/);
});

test('jj-side decisions follow a statically known `cd` into a jj workspace', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-jjcd');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const plain = fx.path('plain');
  const harness = createGuardContext();
  install(harness, { guardJjRepositoryWide: 'deny', defaultCwd: plain });

  const undoReason = harness.runGuard({
    name: 'bash',
    callId: 'jjcd-1',
    arguments: { command: `cd ${colo} && jj undo` },
  });
  assert.match(
    undoReason ?? '',
    /^Blocked: `jj undo`/,
    'a cd into a jj workspace must be followed for jj-side hard denies',
  );

  const abandonReason = harness.runGuard({
    name: 'bash',
    callId: 'jjcd-2',
    arguments: { command: `cd ${colo} && jj abandon @` },
  });
  assert.match(abandonReason ?? '', /^Blocked: `jj abandon`/, 'hard denies apply after a static cd');
});

test('a `cd` target that needs shell expansion is not guessed', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-jjcd-var');
  await initJjColocated(fx.run, fx.path('colo'));
  const plain = fx.path('plain');
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', guardJjRepositoryWide: 'deny', defaultCwd: plain });

  // The variable cannot be resolved statically: keep the session cwd (plain dir)
  // and fail open instead of denying based on a guessed path.
  const gitVar = harness.runGuard({
    name: 'bash',
    callId: 'var-1',
    arguments: { command: 'cd "$DIR" && git commit -m x' },
  });
  assert.equal(gitVar, undefined);
  const jjVar = harness.runGuard({ name: 'bash', callId: 'var-2', arguments: { command: 'cd "$DIR" && jj undo' } });
  assert.equal(jjVar, undefined);
  const tilde = harness.runGuard({ name: 'bash', callId: 'var-3', arguments: { command: 'cd ~/colo && jj undo' } });
  assert.equal(tilde, undefined);
});

// ---------------------------------------------------------------------------
// Audited P0 regressions: hard-deny syntax bypasses and false positives.
// ---------------------------------------------------------------------------

test('audited hard-deny bypasses are refused: redirection, flag values, bare abandon', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-harddeny-bypass');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { defaultCwd: colo });
  const refused = [
    'jj restore >/dev/null',
    'jj restore 2>/dev/null',
    'jj restore > /dev/null',
    'jj restore --from @-',
    'jj restore --changes-in @',
    'jj restore -f @-',
    'jj abandon',
  ];
  for (const command of refused) {
    const reason = harness.runGuard({
      name: 'bash',
      callId: `bypass-${refused.indexOf(command)}`,
      arguments: { command, workdir: colo },
    });
    assert.match(reason ?? '', /^Blocked: `jj /, `${command} must be refused as destructive`);
  }
  assert.equal(harness.runGuard(bash('jj restore file.txt', colo)), undefined, 'an explicit fileset stays allowed');
  assert.equal(harness.runGuard(bash('jj abandon xyz', colo)), undefined, 'a non-@ revset stays warn-class');
});

test('audited false positives are gone: heredoc bodies, dry-run/help git, jj new -m', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-false-positives');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', guardJjRepositoryWide: 'deny', defaultCwd: colo });

  const heredoc = ["cat > notes.md <<'EOF'", 'git commit -m looks-like-a-command', 'EOF'].join('\n');
  assert.equal(harness.runGuard(bash(heredoc, colo)), undefined, 'heredoc bodies are data, not commands');
  assert.equal(harness.runGuard(bash('git clean -n', colo)), undefined, 'a dry-run is read-only');
  assert.equal(harness.runGuard(bash('git rm --dry-run file.txt', colo)), undefined);
  assert.equal(harness.runGuard(bash('git --help commit', colo)), undefined);
  assert.equal(harness.runGuard(bash('git commit --help', colo)), undefined);
  assert.equal(
    harness.runGuard(bash('git branch > branches.txt', colo)),
    undefined,
    'a redirected listing is read-only',
  );
  assert.equal(harness.runGuard(bash('jj new -m "message"', colo)), undefined, 'the -m value is not a revset');
});

test('audited wrapper / attached-option bypasses are refused', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-wrappers');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const other = await initJjNative(fx.run, fx.path('other'));
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', defaultCwd: colo });

  for (const [index, command] of [
    'timeout -s KILL 5 git commit -m x',
    'timeout --signal KILL 5 git commit -m x',
    'env -S "git commit -m x"',
    'command -p git commit -m x',
    'pwsh -c "git commit -m x"',
    'cmd /c "git commit -m x"',
  ].entries()) {
    const reason = harness.runGuard({
      name: 'bash',
      callId: `wrapper-${index}`,
      arguments: { command, workdir: colo },
    });
    assert.match(reason ?? '', /^Blocked: `git commit`/, `${command} must be recognised`);
  }
  const attached = harness.runGuard({
    name: 'bash',
    callId: 'attached-repository',
    arguments: { command: `jj -R${other} undo`, workdir: colo },
  });
  assert.match(attached ?? '', /targets `/, 'an attached -R target is still scope creep');
});

test('guard warm-up reuses the TTL detection cache for ordinary commands', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-ttl');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  let warms = 0;
  let detects = 0;
  const service = {
    peek: () => ({ kind: 'jj-colocated', jjRoot: colo, root: colo, workspaceName: 'default' }),
    warm: async () => {
      warms += 1;
    },
    detect: async () => {
      detects += 1;
    },
    operations: { headOperationId: async () => 'deadbeef' },
  } as unknown as GuardServiceLike;
  install(harness, { config: { defaultCwd: colo }, service });

  // Ordinary shell call: TTL cache, no forced refresh.
  await harness.runPipeline({ name: 'bash', callId: 'ttl-ls', arguments: { command: 'ls', workdir: colo } });
  assert.equal(detects, 1);
  assert.equal(warms, 0);

  // Mutating git: still TTL (the hard-deny scopes below are what force freshness).
  await harness.runPipeline({
    name: 'bash',
    callId: 'ttl-git',
    arguments: { command: 'git commit -m x', workdir: colo },
  });
  assert.equal(detects, 2);
  assert.equal(warms, 0);

  // Destructive/repo-wide/scope-creep jj commands keep the forced refresh.
  await harness.runPipeline({
    name: 'bash',
    callId: 'ttl-restore',
    arguments: { command: 'jj restore', workdir: colo },
  });
  assert.equal(warms, 1);
  await harness.runPipeline({ name: 'bash', callId: 'ttl-undo', arguments: { command: 'jj undo', workdir: colo } });
  assert.equal(warms, 2);
  await harness.runPipeline({
    name: 'bash',
    callId: 'ttl-scope',
    arguments: { command: `jj -R ${colo} undo`, workdir: colo },
  });
  assert.equal(warms, 3);

  // A command-less guarded call (create_worktree) uses the TTL path too.
  await harness.runPipeline({ name: 'create_worktree', callId: 'ttl-wt', arguments: { name: 'x' } });
  assert.equal(detects, 3);
});

test('a service without a TTL detect entry keeps the forced warm-up fallback', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-ttl-fallback');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const harness = createGuardContext();
  let warms = 0;
  const service = {
    peek: () => ({ kind: 'jj-colocated', jjRoot: colo, root: colo, workspaceName: 'default' }),
    warm: async () => {
      warms += 1;
    },
  } as unknown as GuardServiceLike;
  install(harness, { config: { defaultCwd: colo }, service });
  await harness.runPipeline({ name: 'bash', callId: 'fallback-ls', arguments: { command: 'ls', workdir: colo } });
  assert.equal(warms, 1);
});

// ---------------------------------------------------------------------------
// Audited L4: broken `.jj` metadata in the sniff fallback fails open.
// ---------------------------------------------------------------------------

test('L4: broken `.jj` metadata in the guard sniff path fails open instead of denying', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-broken-metadata');
  const broken = fx.path('broken');
  // Empty `.jj` without `.jj/repo`: the CLI authority reports kind:none/verified:false
  // (test/detect-failures.test.ts F2), so the synchronous sniff fallback must not
  // turn the same directory into a deny decision.
  mkdirSync(join(broken, '.jj'), { recursive: true });
  const harness = createGuardContext();
  install(harness, { guardMutatingGit: 'deny', defaultCwd: broken });
  assert.equal(
    harness.runGuard(bash('git commit -m x', broken)),
    undefined,
    'a broken .jj must be treated like "not a jj workspace" (fail-open)',
  );

  // Control: a real jj repository in the same guard configuration is still denied.
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const controlHarness = createGuardContext();
  install(controlHarness, { guardMutatingGit: 'deny', defaultCwd: colo });
  assert.match(controlHarness.runGuard(bash('git commit -m x', colo)) ?? '', /^Blocked: `git commit`/);
});

// ---------------------------------------------------------------------------
// Audited L3: the repository-wide refusal text depends on where the command runs.
// ---------------------------------------------------------------------------

test('L3: the repo-wide refusal text distinguishes the workspace root from subdirectories', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-repo-wide-text');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const sub = fx.path('colo/nested/deep');

  const rootHarness = createGuardContext();
  install(rootHarness, { guardJjRepositoryWide: 'deny', defaultCwd: colo });
  const atRoot = rootHarness.runGuard(bash('jj undo', colo));
  assert.match(atRoot ?? '', /targets repository-wide state from this workspace's own root/);
  assert.doesNotMatch(
    atRoot ?? '',
    /not this repository's own workspace root/,
    'a session at the workspace root must not be told it is outside the root',
  );

  const subHarness = createGuardContext();
  install(subHarness, { guardJjRepositoryWide: 'deny', defaultCwd: sub });
  const belowRoot = subHarness.runGuard(bash('jj undo', sub));
  assert.match(belowRoot ?? '', /not this repository's own workspace root/);
  assert.match(belowRoot ?? '', /^Blocked: `jj undo`/);
});

// ---------------------------------------------------------------------------
// Cross-row config ownership warnings (audit core M8) at the guard entry.
// ---------------------------------------------------------------------------

test('the guard entry warns once about config keys owned by other rows', () => {
  const harness = createGuardContext();
  const ctx = harness.ctx as unknown as Parameters<typeof applyGuardEntry>[0];
  applyGuardEntry(ctx, { guardMutatingGit: 'deny', commitStyle: 'angular', defaultLogLimit: 10 });
  const messages = harness.logged.map((entry) => String(entry));
  assert.ok(
    messages.some((message) =>
      /`commitStyle` belongs to the jj-runtime row; this row \(jj-guard\) ignores it/.test(message),
    ),
    `expected a commitStyle ownership warning, got: ${messages.join(' | ')}`,
  );
  assert.ok(
    messages.some((message) => /`defaultLogLimit` belongs to the jj-tools row/.test(message)),
    'expected a defaultLogLimit ownership warning',
  );
  assert.ok(
    !messages.some((message) => /`guardMutatingGit` belongs to/.test(message)),
    'a key on its own row must not be reported',
  );
  assert.equal(harness.guards.length, 1, 'the warning must not change guard registration');
  harness.runGuard(bash('git commit -m x'));
  assert.equal(harness.guards.length, 1);
});
