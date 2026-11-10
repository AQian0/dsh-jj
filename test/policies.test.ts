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
  WorkspaceOwnership,
  agentSessionId,
  canonicalWorkspacePath,
  decideOrphanWorkspaceCleanup,
  decideWorkspaceCleanup,
  isRootWorkspace,
  isStaleWorkingCopyFailure,
} from '../src/policies.ts';
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
