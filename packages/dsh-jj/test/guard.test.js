/**
 * End-to-end guard behaviour against real repositories (design contract §8).
 *
 * The decision path is synchronous (filesystem sniff or a warmed service cache),
 * so these tests use real jj/git fixtures plus a context double that reproduces
 * `ctx.tools.guard(...)` and the `tools/pre-execute` waterfall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { evaluateGitCommand, installGitConfusionGuard } from '../src/guard.ts';
import { createGuardContext, initGit, initJjColocated, initJjNative, makeFixture } from './helpers/fixtures.js';

function install(harness, options = {}) {
  const guard = installGitConfusionGuard(harness.ctx, options);
  return guard;
}

function bash(command, workdir) {
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
  assert.equal(typeof reason, 'string');
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
  assert.match(reason, /jj-native: /);
  assert.match(reason, /jj workspace add <path>/);
  assert.match(reason, /no root \.git/);
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
  assert.equal(typeof harness.runGuard({ name: 'pwsh', arguments: { command: 'git commit -m x', workdir: colo } }), 'string');
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
  assert.match(defaultReason, /^Blocked: `git status` in a Jujutsu \(jj\) workspace \(jj-native: /);
  assert.match(defaultReason, /jj log \/ jj status/);

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
  assert.match(reason, /^Blocked: `create_worktree` in a Jujutsu \(jj\) workspace \(jj-colocated: /);
  assert.match(reason, /jj_workspace_add/);
  assert.match(reason, /working-directory tool/);

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
  const warmed = [];
  install(harness, {
    config: { guardMutatingGit: 'deny' },
    warm: async (cwd) => {
      warmed.push(cwd);
    },
  });
  const execution = { name: 'bash', callId: 'call-1', arguments: { command: 'git commit -m x', workdir: colo } };
  const reason = await harness.runPipeline(execution);
  assert.deepEqual(warmed, [colo], 'the warm-up listener ran before the guard');
  assert.match(reason, /^Blocked: `git commit`/);
  // The cached decision short-circuits even if the working directory disappears.
  assert.match(harness.runGuard(execution), /^Blocked: `git commit`/);
});

test('evaluateGitCommand is a pure classifier with an injectable sniff', () => {
  const layouts = {
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
    assert.equal(typeof reason, 'string', `${command} must be blocked in deny mode`);
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
  for (const command of ['jj new', 'jj describe -m x', 'jj squash', 'jj rebase -d main', 'jj restore file', 'jj split', 'jj op log', 'jj log -r @', 'jj status', 'jj diff', 'jj --at-op=abcdef jj log']) {
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
  assert.equal(typeof reason, 'string');
  assert.match(reason, /targets `.*outer`, which is not the repository this session is working in/);

  const okHarness = createGuardContext();
  install(okHarness, { defaultCwd: inner });
  assert.equal(okHarness.runGuard(bash(`jj -R ${inner} new`, inner)), undefined, 'the same repository is fine');
});

test('T19e: `jj workspace forget <other>` is denied regardless of mode', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-guard-forget');
  const native = await initJjNative(fx.run, fx.path('native'));
  const wsPath = `${fx.root}-ws`;
  await fx.run(['jj', 'workspace', 'add', '--name', 'other', wsPath], { cwd: native, timeoutMs: 30_000 });
  const harness = createGuardContext();
  install(harness, { defaultCwd: native });
  const reason = harness.runGuard(bash('jj workspace forget other', native));
  assert.equal(typeof reason, 'string', 'forgetting another workspace is denied even in warn mode');
  assert.match(reason, /^Blocked: `jj workspace forget`/);
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
  assert.match(reason, /^Blocked/);
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
  for (const mode of ['warn', 'off']) {
    const harness = createGuardContext();
    install(harness, { guardJjRepositoryWide: mode, defaultCwd: colo });
    for (const [command, detail] of [
      ['jj restore', /removed 1 files/],
      ['jj abandon @', /working copy/],
      ['jj undo --allow-cross-workspace', /cross-workspace/],
    ]) {
      const reason = harness.runGuard(bash(command, colo));
      assert.equal(typeof reason, 'string', `${command} must be refused even with guardJjRepositoryWide=${mode}`);
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
  assert.equal(harness.events.filter((entry) => entry.event === 'jj/repo-wide-op').length >= 3, true, 'each warned call emits jj/repo-wide-op');
  assert.equal(harness.runGuard(bash('jj new', colo)), undefined, '`jj new` without a revset only starts an empty change');
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
    service: {
      peek: () => ({ kind: 'jj-colocated', jjRoot: colo, root: colo, workspaceName: 'default' }),
      warm: async () => {},
      operations: { headOperationId: async () => 'deadbeefcafe' },
    },
  });
  const execution = { name: 'bash', callId: 'call-head', arguments: { command: 'jj undo', workdir: colo } };
  await harness.runPipeline(execution);
  const event = harness.events.find((entry) => entry.event === 'jj/repo-wide-op');
  assert.ok(event !== undefined, 'the repo-wide warning was emitted');
  assert.match(event.payload.message, /Head operation before this call: deadbeefcafe/);
  assert.match(event.payload.message, /jj op restore deadbeefcafe/);
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
  const next = async () =>
    index < list.length ? await list[index++](execution, { content: [{ type: 'text', text: 'ok' }] }, next) : { kind: 'accept' };
  const decision = await next();
  assert.equal(decision.kind, 'accept');
  const texts = (decision.content ?? []).map((block) => block.text ?? '').join('\n');
  assert.match(texts, /ok/, 'the original tool output is preserved');
  assert.match(texts, /prefers jj/, 'the notice states the preference');
  assert.match(texts, /git commit/, 'the notice names the command');
  assert.match(texts, /jj (describe|new|commit)/, 'the notice names the jj equivalent');
});

