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
  canonicalWorkspacePath,
  decideWorkspaceCleanup,
  isRootWorkspace,
  isStaleWorkingCopyFailure,
} from '../src/policies.ts';
import type { VcsDescriptor } from '../src/types.ts';

/** Minimal descriptor for the layout checks. */
function descriptorAt(root: string, workspaceName?: string): VcsDescriptor {
  return { root, workspaceName, kind: 'jj-colocated' } as VcsDescriptor;
}

test('WorkspaceOwnership remembers the canonical root per agent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jj-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, 'real');
  mkdirSync(real);
  const link = join(dir, 'link');
  symlinkSync(real, link);

  const ownership = new WorkspaceOwnership();
  const agent = { id: 'session-a' };
  const other = { id: 'session-b' };
  ownership.remember(agent, 'ws', link);
  ownership.remember(agent, 'ws', link); // idempotent

  assert.equal(ownership.owns(agent, 'ws', real), true, 'a symlinked root compares equal');
  assert.equal(ownership.owns(agent, 'ws', link), true);
  assert.equal(ownership.owns(other, 'ws', real), false, 'another session owns nothing');
  assert.deepEqual(ownership.list(agent), [{ name: 'ws', root: canonicalWorkspacePath(real) }]);
  assert.deepEqual(ownership.list(other), []);
  // Non-object agents (tool calls without an agent) never own anything.
  ownership.remember(undefined, 'ws', real);
  assert.equal(ownership.owns(undefined, 'ws', real), false);
  assert.deepEqual(ownership.list(undefined), []);
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
