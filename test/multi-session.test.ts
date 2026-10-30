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
  multiSessionFinishChecklistText,
  multiSessionPromptText,
  parallelPeerCwds,
  MULTI_SESSION_GUIDANCE_MODES,
  type JjLiveSession,
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

test('peer selection drops known-idle sessions but keeps active and unknown ones', () => {
  const current = { id: 'current' };
  const idle = { id: 'idle' };
  const active = { id: 'active' };
  const unknown = { id: 'unknown' };
  const sessions: JjLiveSession[] = [
    { session: current, cwd: '/repo', active: true },
    { session: idle, cwd: '/repo', active: false },
    { session: active, cwd: '/repo', active: true },
    { session: unknown, cwd: '/repo-w2' },
  ];
  assert.deepEqual(
    parallelPeerCwds(current, sessions),
    ['/repo', '/repo-w2'],
    'the current session and positively-idle peers are excluded; active and unknown-activity peers stay',
  );
});

test('an idle live peer never triggers the workspace isolation guidance', () => {
  const current = { id: 'current-idle' };
  const peer = { id: 'peer-idle' };
  const sessions: JjLiveSession[] = [
    { session: current, cwd: '/repo', active: true },
    { session: peer, cwd: '/repo', active: false },
  ];
  const probe = tableProbe({
    '/repo': { workspaceRoot: '/repo', jjRepoPath: '/repo/.jj/repo' },
  });
  const detection = detectParallelSessions(CURRENT, parallelPeerCwds(current, sessions), probe);
  assert.deepEqual(detection, { sharedWorkspace: [], siblingWorkspace: [] });
  assert.equal(
    multiSessionPromptText({ mode: 'auto', detection }),
    '',
    'a session that ended its turn is not concurrent work and must not push this session into a new jj workspace',
  );
});

test('an active live peer still triggers detection through the same peer selection', () => {
  const current = { id: 'current-active' };
  const peer = { id: 'peer-active' };
  const sessions: JjLiveSession[] = [
    { session: current, cwd: '/repo', active: true },
    { session: peer, cwd: '/repo', active: true },
  ];
  const probe = tableProbe({
    '/repo': { workspaceRoot: '/repo', jjRepoPath: '/repo/.jj/repo' },
  });
  const detection = detectParallelSessions(CURRENT, parallelPeerCwds(current, sessions), probe);
  assert.deepEqual(detection.sharedWorkspace, ['/repo']);
  assert.match(multiSessionPromptText({ mode: 'auto', detection }), /jj_workspace_add/);
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
  assert.match(text, /Parallel sessions: another DSH session is running in this Jujutsu working copy/);
  assert.match(text, /jj_workspace_add/);
  assert.match(text, /working_directory/);
  assert.match(text, /outside the repository/i);
  assert.match(text, /git worktree/, 'the guard-equivalent git worktree pitfall is named');
  assert.match(text, /standard rebase hand-off/);
  assert.match(text, /trunk\(\)/, 'the default rebase target is trunk()');
  assert.match(text, /jj_handoff/, 'the model is told to use the one-shot hand-off tool');
  assert.match(text, /source mode/, 'the hand-off moves the whole stack with source mode internally');
  assert.match(text, /repository without remotes is fine/, 'a repo without remotes is handled inside the tool');
  assert.match(text, /(picks|resolves) the integration target itself/, 'the model must not ask the user to pick the target');
  assert.match(text, /earlier session's (committed )?(change|commit)/, 'an inherited stack base keeps the chain together instead of deflecting to the user');
  assert.match(text, /resolve conflicts yourself/i, 'conflicts are resolved by the model, not handed back');
  assert.match(text, /jj_workspace_cleanup/, 'a session-created workspace is cleaned up by the plugin');
  assert.match(text, /the user runs `jj workspace forget <name>`/, 'raw workspace forget is left to the user');
  assert.match(text, /do not run it yourself/i, 'raw workspace forget stays denied');
});

test('sibling workspaces are described as isolated copies with a shared repository', () => {
  const text = multiSessionPromptText({
    mode: 'auto',
    detection: { sharedWorkspace: [], siblingWorkspace: ['/repo-w2', '/repo-w3'] },
  });
  assert.match(text, /another DSH session is using a sibling workspace of this Jujutsu repository/);
  assert.match(text, /working copies are isolated; bookmarks and the operation log are shared/i);
  assert.match(text, /jj undo/);
  assert.ok(!text.includes('isolate this session in its own jj workspace'), 'no need to create a workspace when the peer is already isolated');
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
  assert.match(text, /jj_handoff/, 'the generic variant points at the one-shot hand-off tool');
});

test('a configured rebase target replaces the default in the checklist', () => {
  const text = multiSessionPromptText({
    mode: 'always',
    rebaseTarget: 'main',
  });
  assert.match(text, /default main/, 'the configured target replaces the default destination');
  assert.ok(!text.includes(`default ${DEFAULT_REBASE_TARGET}`), 'the configured target replaces the default destination');
  assert.match(text, /jj_handoff/, 'the configured target feeds the hand-off tool');
});

test('the shared-working-copy warning wins over the sibling-workspace wording', () => {
  const text = multiSessionPromptText({
    mode: 'auto',
    detection: { sharedWorkspace: ['/repo'], siblingWorkspace: ['/repo-w2'] },
  });
  assert.match(text, /running in this Jujutsu working copy/);
  assert.ok(!text.includes('separate workspaces'), 'the dangerous case is the one described');
});

test('the exported mode list is the accepted configuration vocabulary', () => {
  assert.deepEqual([...MULTI_SESSION_GUIDANCE_MODES], ['auto', 'always', 'off']);
});

test('the injected guidance stays within the prompt token budget', () => {
  // Rough English prompt ratio: ~3.5 chars/token. The shared variant (the largest
  // block: isolation guidance + finish checklist) must stay within ~700 tokens.
  const shared = multiSessionPromptText({ mode: 'auto', detection: { sharedWorkspace: ['/repo'], siblingWorkspace: [] } });
  const checklist = multiSessionFinishChecklistText();
  assert.ok(shared.length <= 2450, `shared guidance is ${shared.length} chars; target is ~700 tokens`);
  assert.ok(checklist.length <= 1450, `finish checklist is ${checklist.length} chars; target is ~400 tokens`);
  assert.ok(checklist.length < shared.length, 'the checklist is the smaller half of the shared block');
});
