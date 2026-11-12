/**
 * Policy helpers: ownership registry, root-workspace detection and the cleanup decision.
 *
 * These are the rules the tool, flow, service and guard layers share, so they are tested
 * without a repository where possible: a decision table for every refusal, and a registry
 * whose lifetime is the session's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JJ_TOOL_SANDBOX_CLASSES,
  WorkspaceOwnership,
  agentSessionId,
  canonicalWorkspacePath,
  decideJjToolSandbox,
  decideOrphanWorkspaceCleanup,
  decideWorkspaceCleanup,
  isPathWithinSandboxRoots,
  isRootWorkspace,
  isStaleWorkingCopyFailure,
  resolveSandboxTargetPath,
  sandboxWritableRoots,
} from '../src/policies.ts';
import { resolveConfig } from '../src/config.ts';
import { JjOperations } from '../src/service.ts';
import { jjToolDefinitions } from '../src/tools.ts';
import type { VcsDescriptor } from '../src/types.ts';

/** Minimal descriptor for the layout checks. */
function descriptorAt(root: string, workspaceName?: string): VcsDescriptor {
  return { root, workspaceName, kind: 'jj-colocated' } as VcsDescriptor;
}

test('WorkspaceOwnership remembers the canonical root per session', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jj-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, 'real');
  mkdirSync(real);
  const link = join(dir, 'link');
  symlinkSync(real, link);

  const ownership = new WorkspaceOwnership();
  const agent = { id: 'session-a' };
  const other = { id: 'session-b' };
  // No repo path: process-lifetime ownership only, exactly like a host without a
  // writable metadata directory.
  ownership.remember(undefined, agent, 'ws', link);
  ownership.remember(undefined, agent, 'ws', link); // idempotent

  assert.equal(ownership.owns(undefined, agent, 'ws', real), true, 'a symlinked root compares equal');
  assert.equal(ownership.owns(undefined, agent, 'ws', link), true);
  assert.equal(ownership.owns(undefined, other, 'ws', real), false, 'another session owns nothing');
  assert.deepEqual(
    ownership
      .list(undefined, agent)
      .map((entry) => ({ name: entry.name, root: entry.root, sessionId: entry.sessionId })),
    [{ name: 'ws', root: canonicalWorkspacePath(real), sessionId: 'session-a' }],
  );
  assert.deepEqual(ownership.list(undefined, other), []);
  // Non-object agents (tool calls without an agent) never own anything.
  ownership.remember(undefined, undefined, 'ws', real);
  assert.equal(ownership.owns(undefined, undefined, 'ws', real), false);
  assert.deepEqual(ownership.list(undefined, undefined), []);
});

test('WorkspaceOwnership reloads durable records by session id after a restart', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-jj-ownership-durable-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const root = join(repo, 'ws');
  mkdirSync(root);

  const first = new WorkspaceOwnership();
  first.remember(repo, { id: 'session-a' }, 'ws', root, 'base-change');
  assert.deepEqual(
    first.records(repo).map((entry) => ({ name: entry.name, sessionId: entry.sessionId, base: entry.baseChangeId })),
    [{ name: 'ws', sessionId: 'session-a', base: 'base-change' }],
  );

  // A restarted host has no memory: ownership must come back from the durable record
  // for the same DSH session id, even though the agent object is new.
  const second = new WorkspaceOwnership();
  assert.equal(second.owns(repo, { id: 'session-a' }, 'ws', root), true);
  assert.equal(second.owns(repo, { session: { id: 'session-a' } }, 'ws', root), true, 'Agent.session.id works too');
  assert.equal(second.owns(repo, { id: 'session-b' }, 'ws', root), false, 'another session does not inherit it');
  assert.equal(second.owns(repo, { id: 'session-a' }, 'ws', join(repo, 'other')), false, 'name+root both matter');
  assert.equal(second.list(repo, { id: 'session-a' })[0]?.baseChangeId, 'base-change');

  second.forget(repo, 'ws');
  assert.equal(second.owns(repo, { id: 'session-a' }, 'ws', root), false);
  assert.deepEqual(new WorkspaceOwnership().list(repo, { id: 'session-a' }), []);
});

test('agentSessionId reads the live Agent session and the plain-object fallback', () => {
  assert.equal(agentSessionId({ session: { id: 'live' } }), 'live');
  assert.equal(agentSessionId({ id: 'plain' }), 'plain');
  assert.equal(agentSessionId({ session: { id: '' }, id: 'fallback' }), 'fallback');
  assert.equal(agentSessionId({}), undefined);
  assert.equal(agentSessionId(undefined), undefined);
});

test('isRootWorkspace uses the .jj/repo layout, not the workspace name', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jj-root-layout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const linked = join(dir, 'linked');
  mkdirSync(join(root, '.jj', 'repo'), { recursive: true });
  mkdirSync(join(linked, '.jj'), { recursive: true });
  writeFileSync(join(linked, '.jj', 'repo'), '../../../root/.jj/repo');

  assert.equal(isRootWorkspace(descriptorAt(root, 'renamed-root')), true, 'renamed root workspaces still count');
  assert.equal(isRootWorkspace(descriptorAt(linked, 'default')), false, 'a pointer file is a linked workspace');
  assert.equal(
    isRootWorkspace(descriptorAt(join(dir, 'missing'), 'default')),
    true,
    'missing metadata falls back to the name',
  );
});

test('decideWorkspaceCleanup covers every refusal reason', () => {
  const ok = {
    workspaceName: 'session',
    owned: true,
    workingCopy: { empty: true, conflict: false },
    defaultWorkspaceRoot: '/repo',
    canSwitchWorkingDirectory: true,
  } as const;
  assert.equal(decideWorkspaceCleanup(ok), undefined);
  assert.equal(decideWorkspaceCleanup({ ...ok, workspaceName: 'default' }), 'default-workspace');
  assert.equal(decideWorkspaceCleanup({ ...ok, owned: false }), 'not-owned');
  assert.equal(decideWorkspaceCleanup({ ...ok, workingCopy: undefined }), 'unreadable-working-copy');
  assert.equal(decideWorkspaceCleanup({ ...ok, workingCopy: { empty: false, conflict: false } }), 'dirty-working-copy');
  assert.equal(
    decideWorkspaceCleanup({ ...ok, workingCopy: { empty: true, conflict: true } }),
    'conflicted-working-copy',
  );
  assert.equal(decideWorkspaceCleanup({ ...ok, defaultWorkspaceRoot: undefined }), 'no-default-workspace');
  assert.equal(decideWorkspaceCleanup({ ...ok, canSwitchWorkingDirectory: false }), 'no-working-directory');
});

test('isStaleWorkingCopyFailure reads JjError-shaped and plain errors', () => {
  const stale = new Error('The working copy is stale (not updated since operation abc); run jj workspace update-stale');
  assert.equal(isStaleWorkingCopyFailure(stale), true);
  assert.equal(
    isStaleWorkingCopyFailure({
      name: 'JjError',
      message: 'jj command failed',
      detail: { stderr: 'The working copy is stale; run `jj workspace update-stale`' },
    }),
    true,
  );
  assert.equal(isStaleWorkingCopyFailure(new Error('boom')), false);
  assert.equal(isStaleWorkingCopyFailure(undefined), false);
});

test('decideOrphanWorkspaceCleanup covers every refusal reason', () => {
  const ok = {
    workspaceName: 'ws',
    isCurrentWorkspace: false,
    recorded: true,
    registered: true,
    ownerAlive: false,
    inUse: false,
    directoryExists: true,
    workingCopy: { empty: true, conflict: false },
  } as const;
  assert.equal(decideOrphanWorkspaceCleanup(ok), undefined);
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, isCurrentWorkspace: true }), 'current-workspace');
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, workspaceName: 'default' }), 'default-workspace');
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, recorded: false }), 'not-recorded');
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, ownerAlive: true }), 'owner-live');
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, inUse: true }), 'in-use');
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, registered: false }), 'not-registered');
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, workingCopy: undefined }), 'unreadable-working-copy');
  assert.equal(
    decideOrphanWorkspaceCleanup({ ...ok, workingCopy: { empty: false, conflict: false } }),
    'dirty-working-copy',
  );
  assert.equal(
    decideOrphanWorkspaceCleanup({ ...ok, workingCopy: { empty: true, conflict: true } }),
    'conflicted-working-copy',
  );
  // A workspace whose directory disappeared cannot be read any more, but unregistering
  // the leftover registration is safe.
  assert.equal(decideOrphanWorkspaceCleanup({ ...ok, directoryExists: false, workingCopy: undefined }), undefined);
});

test('WorkspaceOwnership can keep memory-only entries when persist is false', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-jj-ownership-nopersist-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const root = join(repo, 'ws');
  mkdirSync(root);

  const memoryOnly = new WorkspaceOwnership();
  memoryOnly.remember(repo, { id: 'session-ro' }, 'ws', root, 'base-1', { persist: false });
  assert.equal(memoryOnly.owns(repo, { id: 'session-ro' }, 'ws', root), true);
  assert.deepEqual(new WorkspaceOwnership().records(repo), [], 'no durable file was written when persist is false');
});

test('JJ_TOOL_SANDBOX_CLASSES covers every registered jj_* tool with no drift', () => {
  const dummyOps = new JjOperations({
    runJj: async () => ({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      killedByTimeout: false,
    }),
  });
  const definitions = jjToolDefinitions({
    service: {
      operations: dummyOps,
      workspaceOwnership: new WorkspaceOwnership(),
      detect: async (cwd) => descriptorAt(cwd, 'default'),
    },
    config: resolveConfig({}),
    host: { tools: { register: () => () => {} } },
    cwdFor: async () => '/repo',
  });
  const definedNames = definitions.map((definition) => definition.name).sort();
  const classifiedNames = Object.keys(JJ_TOOL_SANDBOX_CLASSES).sort();
  assert.deepEqual(classifiedNames, definedNames, 'every jj_* tool has an explicit sandbox class');
  assert.equal(definedNames.length, 24);
});

test('resolveSandboxTargetPath and isPathWithinSandboxRoots canonicalize non-existent leaves and symlink escapes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jj-sandbox-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repo = join(dir, 'repo');
  const outside = join(dir, 'outside');
  const repoPrefixSibling = join(dir, 'repo-ws');
  mkdirSync(repo);
  mkdirSync(outside);
  mkdirSync(repoPrefixSibling);

  const aliasToRepo = join(dir, 'repo-link');
  symlinkSync(repo, aliasToRepo);
  const escapeLinkInsideRepo = join(repo, 'escape');
  symlinkSync(outside, escapeLinkInsideRepo);

  // Non-existent nested leaf under a symlinked ancestor resolves onto the real directory.
  assert.equal(
    resolveSandboxTargetPath(join(aliasToRepo, 'nested', 'leaf')),
    join(canonicalWorkspacePath(repo), 'nested', 'leaf'),
  );

  // Prefix collisions (/repo vs /repo-ws) and symlink escapes (/repo/escape/ws -> /outside/ws) are rejected.
  const roots = [repo];
  assert.equal(isPathWithinSandboxRoots(repo, roots), true);
  assert.equal(isPathWithinSandboxRoots(join(aliasToRepo, 'sub', 'file.ts'), roots), true);
  assert.equal(isPathWithinSandboxRoots(repoPrefixSibling, roots), false, 'sibling with shared prefix is outside');
  assert.equal(
    isPathWithinSandboxRoots(join(escapeLinkInsideRepo, 'new-ws'), roots),
    false,
    'symlink inside repo pointing outside does not bypass sandbox roots',
  );

  assert.deepEqual(sandboxWritableRoots({ mode: 'read-only', workspaceRoot: repo }), []);
  assert.deepEqual(sandboxWritableRoots({ mode: 'danger-full-access', workspaceRoot: repo }), []);
  const writable = sandboxWritableRoots({ mode: 'workspace-write', workspaceRoot: repo });
  assert.equal(isPathWithinSandboxRoots(repo, writable), true);
  assert.equal(isPathWithinSandboxRoots(join('/tmp', 'dsh-jj-temp-ws'), writable), true);
  assert.equal(isPathWithinSandboxRoots(join(tmpdir(), 'dsh-jj-temp-ws'), writable), true);
});

test('decideJjToolSandbox enforces read-only and workspace-write boundaries', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-jj-sandbox-decide-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const scopedTmp = join(base, 'scoped-tmp');
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(scopedTmp);
  mkdirSync(repo);
  mkdirSync(outside);

  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scopedTmp;
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  });

  // Absent policy and danger-full-access always allow.
  assert.equal(decideJjToolSandbox({ toolName: 'jj_commit', cwd: outside }).kind, 'allow');
  assert.equal(
    decideJjToolSandbox({
      toolName: 'jj_workspace_add',
      policy: { mode: 'danger-full-access', workspaceRoot: repo },
      cwd: repo,
      targetPath: outside,
    }).kind,
    'allow',
  );

  // read-only: read tools and workspace-switch are allowed; mutate and workspace-create ask.
  const readOnly = { mode: 'read-only', workspaceRoot: repo } as const;
  for (const [toolName, toolClass] of Object.entries(JJ_TOOL_SANDBOX_CLASSES)) {
    const decision = decideJjToolSandbox({
      toolName,
      policy: readOnly,
      cwd: repo,
      jjRepoPath: join(repo, '.jj', 'repo'),
      targetPath: join(scopedTmp, 'ws'),
    });
    if (toolClass === 'read' || toolClass === 'workspace-switch') {
      assert.equal(decision.kind, 'allow', `${toolName} should be allowed in read-only mode`);
    } else {
      assert.equal(decision.kind, 'ask', `${toolName} should ask in read-only mode`);
      if (decision.kind === 'ask') {
        assert.match(decision.reason, /read-only/);
        assert.ok(decision.displayReason.en.includes(toolName));
        assert.ok(decision.displayReason.zh.includes(toolName));
      }
    }
  }

  // workspace-write: repo and /tmp targets allow; outside targets/stores ask.
  const workspaceWrite = { mode: 'workspace-write', workspaceRoot: repo } as const;
  assert.equal(
    decideJjToolSandbox({
      toolName: 'jj_commit',
      policy: workspaceWrite,
      cwd: repo,
      jjRepoPath: join(repo, '.jj', 'repo'),
    }).kind,
    'allow',
  );
  assert.equal(
    decideJjToolSandbox({
      toolName: 'jj_workspace_add',
      policy: workspaceWrite,
      cwd: repo,
      jjRepoPath: join(repo, '.jj', 'repo'),
      targetPath: join(scopedTmp, 'repo-session-a'),
    }).kind,
    'allow',
    'creating a session workspace inside os.tmpdir() needs no approval',
  );
  const outsideAdd = decideJjToolSandbox({
    toolName: 'jj_workspace_add',
    policy: workspaceWrite,
    cwd: repo,
    jjRepoPath: join(repo, '.jj', 'repo'),
    targetPath: join(outside, 'repo-session-a'),
  });
  assert.equal(outsideAdd.kind, 'ask');

  const outsideEnter = decideJjToolSandbox({
    toolName: 'jj_workspace_enter',
    policy: workspaceWrite,
    cwd: repo,
    jjRepoPath: join(repo, '.jj', 'repo'),
    targetPath: outside,
  });
  assert.equal(outsideEnter.kind, 'ask');
  assert.equal(
    decideJjToolSandbox({
      toolName: 'jj_workspace_enter',
      policy: workspaceWrite,
      cwd: repo,
      jjRepoPath: join(repo, '.jj', 'repo'),
      targetPath: join(scopedTmp, 'repo-session-a'),
    }).kind,
    'allow',
  );

  // Linked workspace inside scopedTmp whose shared .jj/repo lives in `outside` (outside workspaceRoot): asks!
  const linkedExternalStore = decideJjToolSandbox({
    toolName: 'jj_commit',
    policy: { mode: 'workspace-write', workspaceRoot: join(scopedTmp, 'linked') },
    cwd: join(scopedTmp, 'linked'),
    jjRepoPath: join(outside, '.jj', 'repo'),
  });
  assert.equal(linkedExternalStore.kind, 'ask');
});
