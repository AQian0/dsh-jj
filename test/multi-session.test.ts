/**
 * Multi-session detection and model-facing guidance (policy 2026-10-30).
 *
 * The pure layer is exercised without DSH: a fake synchronous workspace probe and
 * real temporary directories for the symlink/canonical-path case.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_REBASE_TARGET,
  detectParallelSessions,
  multiSessionPromptText,
  MULTI_SESSION_GUIDANCE_MODES,
  type JjWorkspaceIdentity,
  type JjWorkspaceProbe,
} from '../src/multi-session.ts';

/** Isolated temporary root with the cleanup hook (same policy as test/helpers/fixtures.ts). */
function tempRoot(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Probe double driven by a cwd → identity table. */
function tableProbe(table: Readonly<Record<string, JjWorkspaceIdentity>>): JjWorkspaceProbe {
  return (cwd) => table[cwd];
}

const CURRENT: JjWorkspaceIdentity = { workspaceRoot: '/repo', jjRepoPath: '/repo/.jj/repo' };

test('detects peers in the same working copy and reports each workspace once', () => {
  const probe = tableProbe({
    '/repo': { workspaceRoot: '/repo', jjRepoPath: '/repo/.jj/repo' },
    '/repo/src': { workspaceRoot: '/repo', jjRepoPath: '/repo/.jj/repo' },
  });
  const detection = detectParallelSessions(CURRENT, ['/repo', '/repo/src', '/not-a-repo'], probe);
  assert.deepEqual(detection.sharedWorkspace, ['/repo'], 'same working copy, deduplicated');
  assert.deepEqual(detection.siblingWorkspace, []);
});

test('detects sibling workspaces of one repository and ignores other repositories', () => {
  const probe = tableProbe({
    '/repo-w2': { workspaceRoot: '/repo-w2', jjRepoPath: '/repo/.jj/repo' },
    '/repo-w3': { workspaceRoot: '/repo-w3', jjRepoPath: '/repo/.jj/repo' },
    '/other': { workspaceRoot: '/other', jjRepoPath: '/other/.jj/repo' },
  });
  const detection = detectParallelSessions(CURRENT, ['/repo-w2', '/repo-w3', '/other'], probe);
  assert.deepEqual(detection.sharedWorkspace, []);
  assert.deepEqual(detection.siblingWorkspace, ['/repo-w2', '/repo-w3']);
});

test('ignores peers whose repository identity cannot be proven, and probe failures', () => {
  const probe: JjWorkspaceProbe = (cwd) => {
    if (cwd === '/broken') return { workspaceRoot: '/broken' }; // no jjRepoPath: relation unknown
    if (cwd === '/throws') throw new Error('unreadable directory');
    return { workspaceRoot: '/repo-w2', jjRepoPath: '/repo/.jj/repo' };
  };
  const detection = detectParallelSessions(CURRENT, ['/broken', '/throws', '', '/repo-w2'], probe);
  assert.deepEqual(detection.sharedWorkspace, []);
  assert.deepEqual(detection.siblingWorkspace, ['/repo-w2']);
});

test('a symlinked working directory and its real path count as the same workspace', (t) => {
  const root = tempRoot(t, 'dsh-jj-parallel-paths');
  const real = join(root, 'real-repo');
  const link = join(root, 'link-repo');
  mkdirSync(real);
  symlinkSync(real, link);
  const current: JjWorkspaceIdentity = { workspaceRoot: link, jjRepoPath: join(real, '.jj', 'repo') };
  const probe: JjWorkspaceProbe = () => ({ workspaceRoot: real, jjRepoPath: join(real, '.jj', 'repo') });
  const detection = detectParallelSessions(current, [real], probe);
  assert.equal(detection.sharedWorkspace.length, 1, 'realpath comparison identifies the shared directory');
  assert.equal(detection.siblingWorkspace.length, 0);
});

test('off mode contributes nothing, and auto mode stays quiet without peers', () => {
  assert.equal(multiSessionPromptText({ mode: 'off' }), '');
  assert.equal(multiSessionPromptText({ mode: 'auto' }), '');
  assert.equal(
    multiSessionPromptText({ mode: 'auto', detection: { sharedWorkspace: [], siblingWorkspace: [] } }),
    '',
    'no peers means no injected text',
  );
});

test('a shared working copy asks for a dedicated workspace and the rebase hand-off', () => {
  const text = multiSessionPromptText({
    mode: 'auto',
    detection: { sharedWorkspace: ['/repo'], siblingWorkspace: [] },
  });
  assert.match(text, /Parallel sessions: another live DSH session is using this Jujutsu working copy/);
  assert.match(text, /jj_workspace_add/);
  assert.match(text, /working_directory/);
  assert.match(text, /outside the repository/i);
  assert.match(text, /git worktree/, 'the guard-equivalent git worktree pitfall is named');
  assert.match(text, /standard rebase hand-off/);
  assert.match(text, /trunk\(\)/, 'the default rebase target is trunk()');
  assert.match(text, /jj rebase -s <first change> -d 'trunk\(\)'/);
  assert.match(text, /mode = source/, 'a stack rebase must use source mode, not the default revisions mode');
  assert.match(text, /workspace add --revision @/, 'migrating mid-task carries the session change into the new workspace');
  assert.match(text, /No git remotes to fetch from/, 'a repo without remotes is handled');
  assert.match(text, /jj workspace update-stale/, 'a stale working copy has a recovery step');
  assert.match(text, /Do not run `jj workspace forget` yourself/, 'cleanup is left to the user (self-forget destroys the working copy)');
  assert.match(text, /never move another session's bookmark/);
});

test('sibling workspaces are described as isolated copies with a shared repository', () => {
  const text = multiSessionPromptText({
    mode: 'auto',
    detection: { sharedWorkspace: [], siblingWorkspace: ['/repo-w2', '/repo-w3'] },
  });
  assert.match(text, /another live DSH session shares this Jujutsu repository but works in a separate workspace/);
  assert.match(text, /working copies are isolated while bookmarks and the operation log are shared/);
  assert.match(text, /jj undo/);
  assert.ok(!text.includes('jj_workspace_add'), 'no need to create a workspace when the peer is already isolated');
  assert.match(text, /standard rebase hand-off/, 'the finish checklist still applies');
});

test('detection counts deduplicate peers without leaking a misleading session count', () => {
  const text = multiSessionPromptText({ mode: 'auto', detection: { sharedWorkspace: ['/repo'], siblingWorkspace: [] } });
  assert.ok(!/\b\d+ other live/.test(text), 'several peers in one workspace are named once, without a count');
});

test("'always' mode covers separate processes where detection cannot see peers", () => {
  const text = multiSessionPromptText({ mode: 'always' });
  assert.match(text, /separate dsh processes/);
  assert.match(text, /standard rebase hand-off/);
  assert.match(text, /working copy is stale/, 'the generic variant still explains stale recovery');
});

test('a configured rebase target replaces the default in the checklist', () => {
  const text = multiSessionPromptText({
    mode: 'always',
    rebaseTarget: 'main',
  });
  assert.match(text, /destination = main/);
  assert.match(text, /jj rebase -s <first change> -d 'main'/);
  assert.ok(!text.includes(`destination = ${DEFAULT_REBASE_TARGET}`), 'the configured target replaces the default destination');
  assert.ok(!text.includes(`-d '${DEFAULT_REBASE_TARGET}'`));
});

test('the shared-working-copy warning wins over the sibling-workspace wording', () => {
  const text = multiSessionPromptText({
    mode: 'auto',
    detection: { sharedWorkspace: ['/repo'], siblingWorkspace: ['/repo-w2'] },
  });
  assert.match(text, /using this Jujutsu working copy/);
  assert.ok(!text.includes('separate workspaces'), 'the dangerous case is the one described');
});

test('the exported mode list is the accepted configuration vocabulary', () => {
  assert.deepEqual([...MULTI_SESSION_GUIDANCE_MODES], ['auto', 'always', 'off']);
});