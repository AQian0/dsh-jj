/**
 * Durable workspace-ownership records for multi-session/multi-workspace cleanup.
 *
 * Session ownership used to live only in process memory (a `WeakMap` keyed by the live
 * Agent), so an interrupted or restarted session lost the right to unregister the
 * workspace it created: `jj_workspace_cleanup` refused and the shell guard keeps denying
 * raw `jj workspace forget`. Its empty working-copy commit then stayed in the shared
 * history as a stray head. Each `jj_workspace_add` therefore persists a small JSON record
 * under the repository's own jj metadata directory (`<jjRepoPath>/dsh-jj/workspaces/`),
 * which no working-copy snapshot can reach, and the ownership registry reads it back by
 * DSH session id.
 *
 * Everything here is best-effort: a read-only metadata directory, a corrupt file or a
 * missing record simply yields no durable ownership (the in-memory registry still works),
 * and ownership checks must never block a tool call.
 *
 * @module dsh-jj/workspace-registry
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directory (relative to the shared jj repository path) that holds the workspace records. */
export const WORKSPACE_RECORD_DIR = join('dsh-jj', 'workspaces');

/** One workspace the plugin created through `jj_workspace_add`, persisted across restarts. */
export interface WorkspaceRecord {
  /** jj workspace name (decoded, exactly as jj reports it). */
  readonly name: string;
  /** Canonical workspace root (realpath when it exists). */
  readonly root: string;
  /** DSH session id that created the workspace. */
  readonly sessionId: string;
  /**
   * Change the workspace's first working copy was created on top of, when known.
   * `jj_workspace_restore` recreates a lost workspace on exactly this base.
   */
  readonly baseChangeId?: string;
  /** Epoch milliseconds of the first record write. */
  readonly createdAt: number;
  /** Epoch milliseconds of the last write. */
  readonly updatedAt: number;
}

/**
 * Sanitized, collision-resistant file stem for one workspace name.
 *
 * Workspace names may contain spaces, tabs or path separators; the file name keeps a
 * readable prefix and appends a hash of the exact name so two cleaned-up names can never
 * overwrite each other's record.
 *
 * @param name - jj workspace name.
 * @returns the file stem (without `.json`).
 */
export function workspaceRecordStem(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `${safe.length > 0 ? safe : 'workspace'}-${digest}`;
}

/**
 * Absolute path of one workspace ownership record.
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param name - jj workspace name.
 * @returns the absolute file path.
 */
export function workspaceRecordPath(jjRepoPath: string, name: string): string {
  return join(jjRepoPath, WORKSPACE_RECORD_DIR, `${workspaceRecordStem(name)}.json`);
}

/** Structural validation of a decoded record: everything optional on disk. */
function decodeWorkspaceRecord(value: unknown): WorkspaceRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { name, root, sessionId, baseChangeId, createdAt, updatedAt } = record;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof root !== 'string' ||
    root.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt)
  ) {
    return undefined;
  }
  if (baseChangeId !== undefined && (typeof baseChangeId !== 'string' || baseChangeId.length === 0)) return undefined;
  return {
    name,
    root,
    sessionId,
    createdAt,
    updatedAt,
    ...(typeof baseChangeId === 'string' ? { baseChangeId } : {}),
  };
}

/**
 * Write (or replace) one workspace ownership record.
 *
 * A temporary file plus `renameSync` keeps a reader from seeing a half-written record.
 * Every failure (metadata directory not writable, full disk) reports `false` instead of
 * throwing: ownership is an optimization, not a precondition for a tool call.
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param record - the record to persist.
 * @returns true when the record was written.
 */
export function writeWorkspaceRecord(jjRepoPath: string, record: WorkspaceRecord): boolean {
  try {
    const dir = join(jjRepoPath, WORKSPACE_RECORD_DIR);
    mkdirSync(dir, { recursive: true });
    const target = workspaceRecordPath(jjRepoPath, record.name);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record));
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every readable workspace record of one repository.
 *
 * Unreadable or malformed files are skipped (a partially written or hand-edited record
 * must not break workspace listing or cleanup).
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @returns the valid records, in directory order.
 */
export function readWorkspaceRecords(jjRepoPath: string): WorkspaceRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(join(jjRepoPath, WORKSPACE_RECORD_DIR));
  } catch {
    return [];
  }
  const records: WorkspaceRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let record: WorkspaceRecord | undefined;
    try {
      record = decodeWorkspaceRecord(JSON.parse(readFileSync(join(jjRepoPath, WORKSPACE_RECORD_DIR, entry), 'utf8')));
    } catch {
      record = undefined;
    }
    if (record !== undefined) records.push(record);
  }
  return records;
}

/**
 * Read one workspace record by exact name.
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param name - jj workspace name.
 * @returns the record, or `undefined` when it is missing or unreadable.
 */
export function readWorkspaceRecord(jjRepoPath: string, name: string): WorkspaceRecord | undefined {
  try {
    return decodeWorkspaceRecord(JSON.parse(readFileSync(workspaceRecordPath(jjRepoPath, name), 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Remove one workspace record (best effort).
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param name - jj workspace name.
 */
export function removeWorkspaceRecord(jjRepoPath: string, name: string): void {
  try {
    rmSync(workspaceRecordPath(jjRepoPath, name), { force: true });
  } catch {
    // Read-only metadata: the stale record is ignored when the workspace is gone.
  }
}
