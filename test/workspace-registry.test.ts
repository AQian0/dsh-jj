/**
 * Durable workspace-ownership records: layout, round-trip, validation and fail-open reads.
 *
 * The registry lives under the repository's jj metadata directory and must never throw:
 * a corrupt record or an unwritable directory only means "no durable ownership".
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_RECORD_DIR,
  readWorkspaceRecord,
  readWorkspaceRecords,
  removeWorkspaceRecord,
  workspaceRecordPath,
  workspaceRecordStem,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from '../src/workspace-registry.ts';

/** A disposable metadata root. */
function repoDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jj-workspace-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One complete record. */
function record(name: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    name,
    root: `/repo/${name}`,
    sessionId: 'session-a',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test('a workspace record round-trips through the jj metadata directory', (t) => {
  const repo = repoDir(t);
  assert.equal(writeWorkspaceRecord(repo, record('session', { baseChangeId: 'abc123' })), true);
  assert.deepEqual(readdirSync(join(repo, WORKSPACE_RECORD_DIR)).length, 1);

  assert.deepEqual(readWorkspaceRecord(repo, 'session'), record('session', { baseChangeId: 'abc123' }));
  const records = readWorkspaceRecords(repo);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.name, 'session');
  assert.equal(records[0]?.baseChangeId, 'abc123');

  // Writing the same name again replaces the record instead of accumulating files.
  assert.equal(writeWorkspaceRecord(repo, record('session', { updatedAt: 1_700_000_001_000 })), true);
  assert.equal(readWorkspaceRecords(repo).length, 1);
  assert.equal(readWorkspaceRecord(repo, 'session')?.updatedAt, 1_700_000_001_000);

  removeWorkspaceRecord(repo, 'session');
  assert.equal(readWorkspaceRecord(repo, 'session'), undefined);
  assert.doesNotThrow(() => removeWorkspaceRecord(repo, 'missing'));
});

test('record file names are sanitized and collision-resistant', (t) => {
  const repo = repoDir(t);
  writeWorkspaceRecord(repo, record('my session/with space'));
  writeWorkspaceRecord(repo, record('my_session_with_space'));
  const files = readdirSync(join(repo, WORKSPACE_RECORD_DIR));
  assert.equal(files.length, 2, 'distinct names keep distinct records');
  assert.ok(files.every((file) => file.endsWith('.json') && /^[A-Za-z0-9._-]+\.json$/.test(file)));
  assert.notEqual(workspaceRecordStem('my session'), workspaceRecordStem('my_session'));
  assert.equal(
    workspaceRecordPath(repo, 'a/b c'),
    join(repo, WORKSPACE_RECORD_DIR, `${workspaceRecordStem('a/b c')}.json`),
  );
  assert.deepEqual(
    readWorkspaceRecords(repo)
      .map((entry) => entry.name)
      .sort(),
    ['my session/with space', 'my_session_with_space'],
  );
});

test('corrupt and structurally invalid records are skipped', (t) => {
  const repo = repoDir(t);
  mkdirSync(join(repo, WORKSPACE_RECORD_DIR), { recursive: true });
  writeFileSync(join(repo, WORKSPACE_RECORD_DIR, 'broken.json'), '{not json');
  writeFileSync(join(repo, WORKSPACE_RECORD_DIR, 'not-a-record.json'), JSON.stringify({ name: 42 }));
  writeFileSync(
    join(repo, WORKSPACE_RECORD_DIR, 'bad-base.json'),
    JSON.stringify({ ...record('bad-base', { baseChangeId: 7 as unknown as string }) }),
  );
  assert.deepEqual(readWorkspaceRecords(repo), []);
  assert.equal(readWorkspaceRecord(repo, 'broken'), undefined);
});

test('reads and writes fail open when the metadata directory is unusable', (t) => {
  const repo = repoDir(t);
  // A file where the `dsh-jj` directory should be: mkdir fails.
  writeFileSync(join(repo, 'dsh-jj'), 'not a directory');
  assert.equal(writeWorkspaceRecord(repo, record('ws')), false);
  assert.deepEqual(readWorkspaceRecords(repo), []);
  assert.equal(readWorkspaceRecord(repo, 'ws'), undefined);
  assert.doesNotThrow(() => removeWorkspaceRecord(repo, 'ws'));
  assert.equal(existsSync(join(repo, WORKSPACE_RECORD_DIR)), false);
});
