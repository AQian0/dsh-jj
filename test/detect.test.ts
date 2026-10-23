/**
 * Repository classification against four real repository kinds plus nesting.
 *
 * Every fixture is a real `jj`/`git` repository; every descriptor comes from real
 * `jj workspace list` / `git rev-parse` output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { detectVcs, sniffVcsSync, parseWorkspaceList, TPL_WORKSPACE_LIST } from '../src/detect.ts';
import { assertToolchain, initGit, initJjColocated, initJjNative, makeFixture, mustRun, realpath } from './helpers/fixtures.ts';

/**
 * Compare two paths by their canonical realpath.
 *
 * `actual` is often an optional descriptor field; the non-null assertion is
 * deliberate: a missing path must fail inside `realpath`, exactly like the
 * original untyped helper, instead of being silently defaulted.
 */
function assertSamePath(actual: string | undefined, expected: string, message?: string): void {
  if (message === undefined) {
    assert.equal(realpath(actual!), realpath(expected));
  } else {
    assert.equal(realpath(actual!), realpath(expected), message);
  }
}

test('colocated repository: kind, roots, versions, remote list, and CLI evidence', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-colo');
  await assertToolchain(fx.run, fx.root);
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const descriptor = await detectVcs(colo, fx.run);

  assert.equal(descriptor.kind, 'jj-colocated');
  assert.equal(descriptor.colocated, true);
  assertSamePath(descriptor.root, colo);
  assertSamePath(descriptor.cwd, colo);
  assertSamePath(descriptor.jjRoot, colo);
  assertSamePath(descriptor.jjWorkspaceRoot, colo);
  assert.equal(descriptor.workspaceName, 'default');
  assert.equal(descriptor.workspaces.length, 1);
  assert.equal(descriptor.workspaces[0]?.name, 'default');
  assertSamePath(descriptor.workspaces[0]?.root, colo);
  assert.equal(descriptor.jjStore, 'external-git-dir');
  assertSamePath(descriptor.gitRoot, colo);
  assertSamePath(descriptor.gitDir, join(colo, '.git'));
  assert.match(descriptor.jjVersion ?? '', /^jj \d+\.\d+/);
  assert.match(descriptor.gitVersion ?? '', /^git version \d+/);
  assert.equal(descriptor.verified, true);
  assert.equal(descriptor.confidence, 'high');
  assert.deepEqual(descriptor.remotes, []);
  assert.equal(descriptor.jjAvailable, true);
  assert.equal(descriptor.gitAvailable, true);
  assert.equal(descriptor.gitCeilingApplied, false);
  assert.deepEqual([...descriptor.confirmedBy].sort(), ['filesystem-sniff', 'git-cli', 'jj-cli']);
  assert.equal(descriptor.notices.filter((entry) => entry.severity === 'error').length, 0);
  assert.equal(descriptor.probedAt > 0, true);
});

test('jj-native repository: no Git metadata at the workspace root', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-native');
  const native = await initJjNative(fx.run, fx.path('native'));
  const descriptor = await detectVcs(native, fx.run);

  assert.equal(descriptor.kind, 'jj-native');
  assert.equal(descriptor.colocated, false);
  assertSamePath(descriptor.root, native);
  assert.equal(descriptor.workspaceName, 'default');
  assert.equal(descriptor.jjStore, 'internal-git-dir');
  assert.ok(
    descriptor.notices.some((entry) => entry.code === 'jj-shared-workspace'),
    'F14: the session directory is the workspace root itself',
  );
  assert.equal(descriptor.gitRoot, undefined);
  assert.equal(descriptor.gitDir, undefined);
  assert.equal(descriptor.gitCeilingApplied, false);
  assert.equal(descriptor.verified, true);
  // `VcsDescriptor` intentionally does not declare `diagnostics`; the check still
  // tolerates it if a descriptor ever carries one.
  const diagnostics = (descriptor as { readonly diagnostics?: readonly unknown[] }).diagnostics;
  assert.equal(diagnostics?.length ?? descriptor.notices.filter((entry) => entry.severity === 'error').length, 0);
});

test('plain Git repository: git kind, no jj fields', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-git');
  const git = await initGit(fx.run, fx.path('git'));
  const descriptor = await detectVcs(git, fx.run);

  assert.equal(descriptor.kind, 'git');
  assert.equal(descriptor.colocated, false);
  assertSamePath(descriptor.root, git);
  assert.equal(descriptor.jjRoot, undefined);
  assert.equal(descriptor.jjWorkspaceRoot, undefined);
  assert.equal(descriptor.jjVersion, undefined);
  assert.equal(descriptor.jjStore, undefined);
  assert.deepEqual(descriptor.workspaces, []);
  assertSamePath(descriptor.gitRoot, git);
  assertSamePath(descriptor.gitDir, join(git, '.git'));
  assert.match(descriptor.gitVersion ?? '', /^git version \d+/);
  assert.equal(descriptor.jjAvailable, false);
  assert.equal(descriptor.verified, true);
  assert.equal(descriptor.confidence, 'high');
});

test('non-repository directory: kind none with an authoritative negative', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-none');
  const empty = fx.path('empty');
  const descriptor = await detectVcs(empty, fx.run);

  assert.equal(descriptor.kind, 'none');
  assert.equal(descriptor.colocated, false);
  assertSamePath(descriptor.root, empty);
  assert.equal(descriptor.jjRoot, undefined);
  assert.equal(descriptor.gitRoot, undefined);
  assert.equal(descriptor.confidence, 'high');
  assert.ok(descriptor.notices.some((entry) => entry.code === 'not-a-repository'));
});

test('filesystem sniff agrees with detectVcs on all four kinds', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-sniff');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const native = await initJjNative(fx.run, fx.path('native'));
  const git = await initGit(fx.run, fx.path('git'));
  const empty = fx.path('empty');
  for (const [dir, kind] of [
    [colo, 'jj-colocated'],
    [native, 'jj-native'],
    [git, 'git'],
    [empty, 'none'],
  ] as const) {
    assert.equal(sniffVcsSync(dir).kind, kind, `sniff of ${dir}`);
    assert.equal((await detectVcs(dir, fx.run)).kind, kind, `detect of ${dir}`);
  }
});

test('detection from a subdirectory resolves the workspace root', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-sub');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const deep = fx.path('colo/sub/deep');
  const descriptor = await detectVcs(deep, fx.run);
  assert.equal(descriptor.kind, 'jj-colocated');
  assertSamePath(descriptor.root, colo);
  assert.equal(descriptor.workspaceName, 'default');
});

test('a symlinked workspace path keeps the colocated identity (canonical comparison)', async (t) => {
  // Regression: `jj`/`git` report the canonical path while a caller can hand us a
  // symlinked spelling (macOS `/var -> /private/var`, or any symlinked parent).
  // Comparing the raw strings made a colocated workspace look jj-native.
  const fx = makeFixture(t, 'dsh-jj-detect-symlink');
  await assertToolchain(fx.run, fx.root);
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const alias = join(fx.root, 'colo-alias');
  symlinkSync(colo, alias, 'dir');

  const descriptor = await detectVcs(alias, fx.run);
  assert.equal(descriptor.kind, 'jj-colocated');
  assert.equal(descriptor.colocated, true);
  assertSamePath(descriptor.root, colo);
  assertSamePath(descriptor.jjWorkspaceRoot, colo);
  assertSamePath(descriptor.jjRoot, colo);
  assert.equal(
    descriptor.notices.some((entry) => entry.code === 'jj-native-under-git-parent'),
    false,
    'a colocated workspace must not be reported as a jj-native workspace under a Git parent',
  );
});

test('jj workspace inside a parent Git repository: Git does not escape the jj boundary', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-f5');
  const parent = await initGit(fx.run, fx.path('parent-git'));
  const workspace = await initJjNative(fx.run, fx.path('parent-git/inner'));
  const descriptor = await detectVcs(workspace, fx.run);

  assert.equal(descriptor.kind, 'jj-native');
  assert.equal(descriptor.gitRoot, undefined, 'the parent Git repository is not this directory\'s repository');
  assert.equal(descriptor.gitDir, undefined);
  assert.equal(descriptor.gitCeilingApplied, true);
  assert.ok(descriptor.notices.some((entry) => entry.code === 'git-ceiling-applied'));
  assert.ok(
    descriptor.notices.some((entry) => entry.code === 'jj-native-under-git-parent'),
    'F13: a jj-native workspace inside a parent Git repository must be flagged',
  );
  assert.equal(descriptor.confidence, 'high');
  assert.equal(parent.length > 0, true);
});

test('Git repository nested inside a jj workspace: the nearer Git repository wins (F6)', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-f6');
  const outer = await initJjColocated(fx.run, fx.path('outer'));
  const nested = await initGit(fx.run, fx.path('outer/nested'));
  const descriptor = await detectVcs(nested, fx.run);

  assert.equal(descriptor.kind, 'git');
  assertSamePath(descriptor.root, nested);
  assertSamePath(descriptor.jjRoot, outer, 'the outer jj workspace is still reported');
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-ancestor-shadowed'));
  const sniff = sniffVcsSync(nested);
  assert.equal(sniff.kind, 'git');
  assert.equal(sniff.jjRoot, outer);
  assert.equal(sniff.gitDepth, 0);
  assert.equal(sniff.jjDepth, 1);
});

test('linked jj workspace in a colocated repository keeps its own identity', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-ws');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const workspacePath = join(fx.root, 'colo-linked');
  await mustRun(fx.run, ['jj', 'workspace', 'add', '--name', 'linked', workspacePath], colo);
  const descriptor = await detectVcs(workspacePath, fx.run);

  assert.equal(descriptor.kind, 'jj-colocated');
  assertSamePath(descriptor.root, workspacePath);
  assert.equal(descriptor.workspaceName, 'linked');
  assert.equal(descriptor.workspaces.length, 2);
  assert.equal(descriptor.jjStore, 'external-git-dir');
  assertSamePath(descriptor.gitDir, join(colo, '.git', 'worktrees', 'colo-linked'));
  assert.equal(descriptor.verified, true);
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-workspace-pointer'));
});

test('jj-native linked workspace reports the shared repository root', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-nws');
  const native = await initJjNative(fx.run, fx.path('native'));
  const workspacePath = join(fx.root, 'native-linked');
  await mustRun(fx.run, ['jj', 'workspace', 'add', '--name', 'probe-ws', workspacePath], native);
  const descriptor = await detectVcs(workspacePath, fx.run);

  assert.equal(descriptor.kind, 'jj-native');
  assert.equal(descriptor.workspaceName, 'probe-ws');
  assert.equal(descriptor.jjStore, 'internal-git-dir');
  assert.equal(descriptor.jjRepoPath, join(native, '.jj', 'repo'));
  assert.ok(descriptor.notices.some((entry) => entry.code === 'jj-workspace-pointer'));
});

test('workspace names containing spaces survive the JSON template parse', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-wsname');
  const native = await initJjNative(fx.run, fx.path('native'));
  const workspacePath = join(fx.root, 'space-ws');
  await mustRun(fx.run, ['jj', 'workspace', 'add', '--name', 'has space', workspacePath], native);
  const descriptor = await detectVcs(workspacePath, fx.run);
  assert.equal(descriptor.workspaceName, 'has space');
});

test('TPL_WORKSPACE_LIST parses as one JSON object per line', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-tpl');
  const native = await initJjNative(fx.run, fx.path('native'));
  const result = await mustRun(
    fx.run,
    ['jj', '--ignore-working-copy', '--no-pager', '--color=never', 'workspace', 'list', '-T', TPL_WORKSPACE_LIST],
    native,
  );
  const entries = parseWorkspaceList(result.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, 'default');
  assertSamePath(entries[0]?.root, native);
  assert.match(result.stdout, /\n$/, 'the template must end every record with a newline');
});

test('detection does not snapshot the working copy (op log unchanged)', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-detect-noside');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const before = await mustRun(fx.run, ['jj', '--ignore-working-copy', '--no-pager', 'op', 'log', '--limit', '1', '--no-graph', '-T', 'self.id()'], colo);
  await detectVcs(colo, fx.run);
  const after = await mustRun(fx.run, ['jj', '--ignore-working-copy', '--no-pager', 'op', 'log', '--limit', '1', '--no-graph', '-T', 'self.id()'], colo);
  assert.equal(after.stdout, before.stdout, 'detection must not create a jj operation');
});