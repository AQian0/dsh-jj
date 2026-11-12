/**
 * Cross-process session heartbeats: file layout, expiry, validation and fail-open reads.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_HEARTBEAT_DIR,
  readSessionHeartbeats,
  removeSessionHeartbeat,
  sessionHeartbeatPath,
  writeSessionHeartbeat,
} from '../src/session-heartbeat.ts';

/** A disposable repository metadata directory. */
function repoDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jj-heartbeat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a heartbeat round-trips through the repository metadata directory', (t) => {
  const repo = repoDir(t);
  const now = 1_700_000_000_000;
  const written = writeSessionHeartbeat(repo, {
    sessionId: 'session-a',
    cwd: '/repo',
    workspaceName: 'default',
    workspaceRoot: '/repo',
    active: true,
    updatedAt: now,
  });
  assert.equal(written, true);
  assert.equal(existsSync(sessionHeartbeatPath(repo, 'session-a')), true);
  assert.deepEqual(readdirSync(join(repo, SESSION_HEARTBEAT_DIR)), ['session-a.json']);

  const peers = readSessionHeartbeats(repo, { now: now + 1000 });
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.sessionId, 'session-a');
  assert.equal(peers[0]?.active, true);

  // The current session excludes its own file, and callers can also exclude every
  // peer session already tracked in-process so stale disk state cannot shadow memory.
  assert.deepEqual(readSessionHeartbeats(repo, { now: now + 1000, excludeSessionId: 'session-a' }), []);
  writeSessionHeartbeat(repo, {
    sessionId: 'session-b',
    cwd: '/repo',
    workspaceName: 'default',
    workspaceRoot: '/repo',
    active: false,
    updatedAt: now,
  });
  writeSessionHeartbeat(repo, {
    sessionId: 'session-remote',
    cwd: '/repo',
    workspaceName: 'default',
    workspaceRoot: '/repo',
    active: true,
    updatedAt: now,
  });
  const remoteOnly = readSessionHeartbeats(repo, {
    now: now + 1000,
    excludeSessionId: 'session-a',
    excludeSessionIds: new Set(['session-b']),
  });
  assert.deepEqual(
    remoteOnly.map((entry) => entry.sessionId),
    ['session-remote'],
  );
});

test('expired and malformed heartbeats are ignored; expired files are cleaned up', (t) => {
  const repo = repoDir(t);
  const now = 1_700_000_000_000;
  writeSessionHeartbeat(repo, {
    sessionId: 'old',
    cwd: '/repo',
    workspaceName: 'default',
    workspaceRoot: '/repo',
    updatedAt: now - 60_000,
  });
  mkdirSync(join(repo, SESSION_HEARTBEAT_DIR), { recursive: true });
  writeFileSync(join(repo, SESSION_HEARTBEAT_DIR, 'broken.json'), '{not json');
  writeFileSync(join(repo, SESSION_HEARTBEAT_DIR, 'not-a-heartbeat.json'), JSON.stringify({ sessionId: 42 }));

  const peers = readSessionHeartbeats(repo, { now, ttlMs: 30_000 });
  assert.deepEqual(peers, [], 'stale, corrupt and malformed entries contribute nothing');
  assert.deepEqual(readdirSync(join(repo, SESSION_HEARTBEAT_DIR)), ['broken.json', 'not-a-heartbeat.json']);
});

test('a future timestamp counts as fresh rather than being discarded', (t) => {
  const repo = repoDir(t);
  const now = 1_700_000_000_000;
  writeSessionHeartbeat(repo, {
    sessionId: 'skewed',
    cwd: '/repo',
    workspaceName: 'ws',
    workspaceRoot: '/repo/ws',
    updatedAt: now + 60_000,
  });
  assert.equal(readSessionHeartbeats(repo, { now }).length, 1, 'clock skew must not disable detection');
});

test('session ids cannot escape the heartbeat directory', (t) => {
  const repo = repoDir(t);
  writeSessionHeartbeat(repo, {
    sessionId: '../../etc/passwd',
    cwd: '/repo',
    workspaceName: 'default',
    workspaceRoot: '/repo',
    updatedAt: 1,
  });
  const files = readdirSync(join(repo, SESSION_HEARTBEAT_DIR));
  assert.deepEqual(files, ['.._.._etc_passwd.json']);
});

test('reads and writes fail open when the metadata directory is unusable', (t) => {
  const repo = repoDir(t);
  // A file where the directory should be: mkdir fails, so the write reports false and
  // reads see nothing instead of throwing.
  writeFileSync(join(repo, 'dsh-jj'), 'not a directory');
  assert.equal(
    writeSessionHeartbeat(repo, {
      sessionId: 'x',
      cwd: '/repo',
      workspaceName: 'default',
      workspaceRoot: '/repo',
      updatedAt: 1,
    }),
    false,
  );
  assert.deepEqual(readSessionHeartbeats(repo, { now: 1 }), []);
  assert.doesNotThrow(() => removeSessionHeartbeat(repo, 'missing'));
});

test('expired heartbeats are not purged by read-only inspection', (t) => {
  const repo = repoDir(t);
  const now = 1_700_000_000_000;
  writeSessionHeartbeat(repo, {
    sessionId: 'old',
    cwd: '/repo',
    workspaceName: 'default',
    workspaceRoot: '/repo',
    updatedAt: now - 60_000,
  });
  assert.deepEqual(readSessionHeartbeats(repo, { now, ttlMs: 30_000, purgeExpired: false }), []);
  assert.deepEqual(readdirSync(join(repo, SESSION_HEARTBEAT_DIR)), ['old.json'], 'the file is left for later readers');
  assert.deepEqual(readSessionHeartbeats(repo, { now, ttlMs: 30_000 }), []);
  assert.deepEqual(readdirSync(join(repo, SESSION_HEARTBEAT_DIR)), [], 'a normal read still prunes expired files');
});
