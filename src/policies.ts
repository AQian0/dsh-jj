/**
 * Pure policy helpers shared by the tool, flow, service and guard layers.
 *
 * Nothing here spawns a process or imports a DSH package: these are the decisions
 * ("may this workspace be forgotten?", "is this the root workspace?", "who created
 * this workspace?") that used to be re-implemented inside whichever layer needed them.
 * Keeping them in one module is what lets the tools, the cleanup flow and the shell
 * guard agree instead of drifting.
 *
 * @module dsh-jj/policies
 */

import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  readWorkspaceRecord,
  readWorkspaceRecords,
  removeWorkspaceRecord,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from './workspace-registry.ts';
import type { VcsDescriptor } from './types.ts';

/**
 * Whether an error is jj's "working copy is stale" refusal.
 *
 * Another workspace rewrote the change this workspace has checked out; every read and
 * write fails with this message until `jj workspace update-stale` runs. Callers use it
 * to recover once instead of surfacing a confusing failure. Structural on purpose: the
 * policy layer must not depend on the subprocess adapter.
 *
 * @param error - any thrown value.
 * @returns true when the failure is the stale-working-copy refusal.
 */
export function isStaleWorkingCopyFailure(error: unknown): boolean {
  const record = error as { detail?: { stderr?: unknown }; message?: unknown } | null;
  const stderr =
    typeof record?.detail?.stderr === 'string'
      ? record.detail.stderr
      : typeof record?.message === 'string'
        ? record.message
        : '';
  return /stale/i.test(stderr) && /workspace update-stale/i.test(stderr);
}

/** Canonical workspace root for ownership checks (realpath when it exists, else the path as given). */
export function canonicalWorkspacePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether this session runs in the repository's root ("default") workspace.
 *
 * Determined from the layout, not the name: the root workspace owns `.jj/repo` as
 * a real directory, while a linked workspace's `.jj/repo` is a pointer file. This
 * keeps the `firstChange` safety requirement when the root workspace was renamed.
 */
export function isRootWorkspace(descriptor: VcsDescriptor): boolean {
  try {
    return statSync(join(descriptor.root, '.jj', 'repo')).isDirectory();
  } catch {
    return (descriptor.workspaceName ?? 'default') === 'default';
  }
}

/** One workspace this session created through `jj_workspace_add`. */
export interface OwnedWorkspace {
  readonly name: string;
  /** Canonical root (realpath), so symlinked paths compare equal. */
  readonly root: string;
  /** DSH session that created it, when the host exposes a session id. */
  readonly sessionId?: string;
  /**
   * Change the workspace's first working copy was created on top of (the parents
   * `jj workspace add` used). `jj_workspace_restore` recreates a deleted workspace on
   * exactly this base; `undefined` when the workspace was created with explicit
   * parents, because a multi-parent base cannot be reproduced from one change id.
   */
  readonly baseChangeId?: string;
  /** Epoch milliseconds of the first record write, when known. */
  readonly createdAt?: number;
  /** Epoch milliseconds of the last record write, when known. */
  readonly updatedAt?: number;
}

/**
 * Structural session id of the agent that made a tool call.
 *
 * A live DSH Agent exposes `Agent.session.id`; tests and embedders may pass a plain
 * `{ id }` object instead. Ownership stays in process memory when neither exists.
 *
 * @param agent - the tool call's caller (`ToolExec.agent`).
 * @returns the session id, or `undefined` when the host exposes none.
 */
export function agentSessionId(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined;
  const session = (agent as { session?: { id?: unknown } }).session;
  const sessionId = session?.id;
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId;
  const id = (agent as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Convert one durable record into the registry's in-memory shape. */
function recordToOwned(record: WorkspaceRecord): OwnedWorkspace {
  return {
    name: record.name,
    root: record.root,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.baseChangeId !== undefined ? { baseChangeId: record.baseChangeId } : {}),
  };
}

/**
 * Per-session ownership of the workspaces the plugin created.
 *
 * Ownership is keyed by DSH session id and persisted under
 * `<jjRepoPath>/dsh-jj/workspaces/` (see `workspace-registry`): an interrupted or
 * restarted session still owns the workspace it created and can unregister it. A host
 * without session ids falls back to the live agent object and keeps the old
 * process-lifetime behavior. `root` is stored canonicalized because the same directory
 * can be reached through a symlink (see AGENTS rule 13).
 *
 * Every filesystem failure is fail-open: the in-memory registry keeps working, and a
 * workspace simply cannot be reclaimed after a restart instead of breaking a tool call.
 */
export class WorkspaceOwnership {
  /** Ownership loaded per `<canonical repo path>\\0<session id>` key. */
  private readonly bySession = new Map<string, OwnedWorkspace[]>();
  /** Process-lifetime fallback for agents without a session id. */
  private readonly byAgent = new WeakMap<object, OwnedWorkspace[]>();
  /** Session keys whose durable records were already merged into memory. */
  private readonly loaded = new Set<string>();

  /**
   * Record that `agent` created `name` at `root`.
   *
   * Duplicates are ignored, so calling it after a retry is harmless. The record is
   * persisted immediately when the repo path and a session id are available.
   *
   * @param jjRepoPath - shared repository path behind `.jj/repo` (optional).
   * @param agent - live agent of the session (`exec.agent`).
   * @param name - jj workspace name.
   * @param root - workspace root as reported by jj.
   * @param baseChangeId - implicit base change recorded for `jj_workspace_restore`.
   */
  remember(jjRepoPath: string | undefined, agent: unknown, name: string, root: string, baseChangeId?: string): void {
    if (typeof agent !== 'object' || agent === null || name.length === 0 || root.length === 0) return;
    const identity = { name, root: canonicalWorkspacePath(root) };
    const sessionId = agentSessionId(agent);
    const now = Date.now();
    if (sessionId === undefined) {
      const owned = this.byAgent.get(agent) ?? [];
      this.upsert(owned, identity, baseChangeId, now);
      this.byAgent.set(agent, owned);
      return;
    }
    const key = this.sessionKey(jjRepoPath, sessionId);
    this.ensureLoaded(jjRepoPath, key, sessionId);
    const owned = this.bySession.get(key) ?? [];
    const merged = this.upsert(owned, { ...identity, sessionId }, baseChangeId, now);
    this.bySession.set(key, owned);
    if (jjRepoPath === undefined) return;
    const durable = readWorkspaceRecord(jjRepoPath, name);
    const effectiveBase = merged.baseChangeId ?? durable?.baseChangeId;
    writeWorkspaceRecord(jjRepoPath, {
      name,
      root: identity.root,
      sessionId,
      createdAt: merged.createdAt ?? durable?.createdAt ?? now,
      updatedAt: now,
      ...(effectiveBase !== undefined ? { baseChangeId: effectiveBase } : {}),
    });
  }

  /**
   * Insert or update one owned workspace in a mutable list.
   *
   * @param owned - list to update.
   * @param identity - name, canonical root and optional session id.
   * @param baseChangeId - base to record when supplied (an existing one is kept).
   * @param now - creation/update timestamp.
   * @returns the merged entry.
   */
  private upsert(
    owned: OwnedWorkspace[],
    identity: { readonly name: string; readonly root: string; readonly sessionId?: string },
    baseChangeId: string | undefined,
    now: number,
  ): OwnedWorkspace {
    const existing = owned.find((entry) => entry.name === identity.name && entry.root === identity.root);
    const effectiveBase = baseChangeId ?? existing?.baseChangeId;
    const merged: OwnedWorkspace = {
      ...identity,
      ...(effectiveBase !== undefined ? { baseChangeId: effectiveBase } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing === undefined) owned.push(merged);
    else owned[owned.indexOf(existing)] = merged;
    return merged;
  }

  /**
   * Whether `agent` created the workspace `name` at `root`.
   *
   * @param jjRepoPath - shared repository path behind `.jj/repo`.
   * @param agent - live agent of the session.
   * @param name - jj workspace name.
   * @param root - workspace root as reported by jj.
   * @returns true only when both name and canonical root match a recorded entry.
   */
  owns(jjRepoPath: string | undefined, agent: unknown, name: string, root: string): boolean {
    if (typeof agent !== 'object' || agent === null) return false;
    const canonicalRoot = canonicalWorkspacePath(root);
    return this.list(jjRepoPath, agent).some((entry) => entry.name === name && entry.root === canonicalRoot);
  }

  /**
   * Every workspace `agent` created: durable records of its session plus this process's
   * not-yet-persisted entries (read-only view).
   *
   * @param jjRepoPath - shared repository path behind `.jj/repo`.
   * @param agent - live agent of the session.
   */
  list(jjRepoPath: string | undefined, agent: unknown): readonly OwnedWorkspace[] {
    if (typeof agent !== 'object' || agent === null) return [];
    const sessionId = agentSessionId(agent);
    if (sessionId === undefined) return [...(this.byAgent.get(agent) ?? [])];
    const key = this.sessionKey(jjRepoPath, sessionId);
    this.ensureLoaded(jjRepoPath, key, sessionId);
    return [...(this.bySession.get(key) ?? [])];
  }

  /**
   * Every recorded workspace of one repository, regardless of session.
   *
   * Used by `jj_workspace_list` and the orphan-ownership path to answer "who created
   * this workspace and is that session still around?".
   *
   * @param jjRepoPath - shared repository path behind `.jj/repo`.
   * @param name - optional exact workspace name.
   * @returns the recorded workspaces (durable records plus in-memory entries).
   */
  records(jjRepoPath: string | undefined, name?: string): readonly OwnedWorkspace[] {
    if (jjRepoPath === undefined) return [];
    const merged = new Map<string, OwnedWorkspace>();
    const add = (entry: OwnedWorkspace): void => {
      if (name !== undefined && entry.name !== name) return;
      const key = `${entry.name}\u0000${entry.root}`;
      const existing = merged.get(key);
      // Prefer the durable record's metadata; both describe the same workspace.
      if (existing === undefined || (entry.baseChangeId !== undefined && existing.baseChangeId === undefined)) {
        merged.set(key, entry);
      }
    };
    for (const record of readWorkspaceRecords(jjRepoPath)) add(recordToOwned(record));
    const prefix = `${canonicalWorkspacePath(jjRepoPath)}\u0000`;
    for (const [key, owned] of this.bySession) {
      if (!key.startsWith(prefix)) continue;
      for (const entry of owned) add(entry);
    }
    return [...merged.values()];
  }

  /**
   * Forget one recorded workspace after it was unregistered.
   *
   * @param jjRepoPath - shared repository path behind `.jj/repo`.
   * @param name - exact jj workspace name.
   */
  forget(jjRepoPath: string | undefined, name: string): void {
    if (jjRepoPath !== undefined) removeWorkspaceRecord(jjRepoPath, name);
    for (const owned of this.bySession.values()) {
      for (let index = owned.length - 1; index >= 0; index -= 1) {
        if (owned[index]?.name === name) owned.splice(index, 1);
      }
    }
  }

  /** Durable-record key for one session in one repository. */
  private sessionKey(jjRepoPath: string | undefined, sessionId: string): string {
    const repo = jjRepoPath === undefined ? '' : canonicalWorkspacePath(jjRepoPath);
    return `${repo}\u0000${sessionId}`;
  }

  /**
   * Merge the durable records of one session into memory (once per process and key).
   *
   * @param jjRepoPath - shared repository path behind `.jj/repo`.
   * @param key - session key.
   * @param sessionId - session id to load.
   */
  private ensureLoaded(jjRepoPath: string | undefined, key: string, sessionId: string): void {
    if (jjRepoPath === undefined || this.loaded.has(key)) return;
    this.loaded.add(key);
    const owned = this.bySession.get(key) ?? [];
    for (const record of readWorkspaceRecords(jjRepoPath)) {
      if (record.sessionId !== sessionId) continue;
      if (owned.some((entry) => entry.name === record.name && entry.root === record.root)) continue;
      owned.push(recordToOwned(record));
    }
    this.bySession.set(key, owned);
  }
}

/** Inputs of {@link decideWorkspaceCleanup}. */
export interface WorkspaceCleanupFacts {
  readonly workspaceName: string;
  readonly owned: boolean;
  /** `undefined` when the working copy could not be read (stale/conflicted). */
  readonly workingCopy?: { readonly empty: boolean; readonly conflict: boolean };
  readonly defaultWorkspaceRoot?: string;
  readonly canSwitchWorkingDirectory: boolean;
}

/** Why a cleanup was refused, or `undefined` when it may proceed. */
export type WorkspaceCleanupRefusal =
  | 'default-workspace'
  | 'not-owned'
  | 'unreadable-working-copy'
  | 'dirty-working-copy'
  | 'conflicted-working-copy'
  | 'no-default-workspace'
  | 'no-working-directory';

/**
 * Decide whether this session may unregister its workspace.
 *
 * Pure: the caller supplies the facts, so the same decision is testable without a
 * repository and the wording can live in whichever layer renders it.
 *
 * @param facts - ownership, working-copy state and host capabilities.
 * @returns the refusal reason, or `undefined` when cleanup may run.
 */
export function decideWorkspaceCleanup(facts: WorkspaceCleanupFacts): WorkspaceCleanupRefusal | undefined {
  if (facts.workspaceName === 'default') return 'default-workspace';
  if (!facts.owned) return 'not-owned';
  if (facts.workingCopy === undefined) return 'unreadable-working-copy';
  if (!facts.workingCopy.empty) return 'dirty-working-copy';
  if (facts.workingCopy.conflict) return 'conflicted-working-copy';
  if (facts.defaultWorkspaceRoot === undefined) return 'no-default-workspace';
  if (!facts.canSwitchWorkingDirectory) return 'no-working-directory';
  return undefined;
}
