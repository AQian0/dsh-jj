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
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  remember(
    jjRepoPath: string | undefined,
    agent: unknown,
    name: string,
    root: string,
    baseChangeId?: string,
    options?: { readonly persist?: boolean },
  ): void {
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
    if (jjRepoPath === undefined || options?.persist === false) return;
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

/** Inputs of {@link decideOrphanWorkspaceCleanup}. */
export interface OrphanWorkspaceCleanupFacts {
  readonly workspaceName: string;
  /** The target is the workspace this tool call runs in (handled by the normal flow). */
  readonly isCurrentWorkspace: boolean;
  /** A durable `jj_workspace_add` record exists for this name+root. */
  readonly recorded: boolean;
  /** The workspace is still registered with jj. */
  readonly registered: boolean;
  /** The recorded owning session is still live (host session list or fresh heartbeat). */
  readonly ownerAlive: boolean;
  /** A live session other than the caller occupies the workspace. */
  readonly inUse: boolean;
  /** The workspace directory still exists on disk. */
  readonly directoryExists: boolean;
  /** `undefined` when the working copy could not be read (the directory may be missing). */
  readonly workingCopy?: { readonly empty: boolean; readonly conflict: boolean };
}

/** Why an interrupted session's workspace may not be unregistered, or `undefined` when it may. */
export type OrphanWorkspaceCleanupRefusal =
  | 'current-workspace'
  | 'default-workspace'
  | 'not-recorded'
  | 'not-registered'
  | 'owner-live'
  | 'in-use'
  | 'unreadable-working-copy'
  | 'dirty-working-copy'
  | 'conflicted-working-copy';

/**
 * Decide whether one session may unregister another recorded workspace.
 *
 * This is the safety fence for workspaces left behind by an interrupted/restarted
 * session: only a workspace the plugin recorded, whose owning session is gone and no
 * other live session occupies, and whose working copy is clean (or whose directory is
 * already gone) may be forgotten. The caller still never deletes the directory.
 *
 * @param facts - ownership, liveness and working-copy facts supplied by the tool.
 * @returns the refusal reason, or `undefined` when the cleanup may run.
 */
export function decideOrphanWorkspaceCleanup(
  facts: OrphanWorkspaceCleanupFacts,
): OrphanWorkspaceCleanupRefusal | undefined {
  if (facts.isCurrentWorkspace) return 'current-workspace';
  if (facts.workspaceName === 'default') return 'default-workspace';
  if (!facts.recorded) return 'not-recorded';
  if (facts.ownerAlive) return 'owner-live';
  if (facts.inUse) return 'in-use';
  if (!facts.registered) return 'not-registered';
  if (facts.workingCopy === undefined) {
    // A deleted directory cannot be snapshotted anymore; unregistering it is safe
    // (the registration is the only thing left) and reports the limitation.
    return facts.directoryExists ? 'unreadable-working-copy' : undefined;
  }
  if (!facts.workingCopy.empty) return 'dirty-working-copy';
  if (facts.workingCopy.conflict) return 'conflicted-working-copy';
  return undefined;
}

/** Host file-sandbox modes exposed by `@deepseek-ai/dsh-sandbox-policy`. */
export type JjSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Structural snapshot of one session's resolved DSH sandbox policy. */
export interface JjSandboxPolicy {
  readonly mode: JjSandboxMode;
  readonly workspaceRoot: string;
}

/** Sandbox enforcement category of each `jj_*` tool. */
export type JjToolSandboxClass = 'read' | 'workspace-switch' | 'workspace-create' | 'mutate';

/**
 * Exhaustive sandbox classification of all 24 `jj_*` tools.
 *
 * - `read`: inspection only; runs with `--ignore-working-copy` in `read-only` mode so
 *   zero working-copy snapshots or op-log writes happen.
 * - `workspace-switch`: switches the in-memory session working directory; allowed in
 *   `read-only` mode (using `--ignore-working-copy`), and asks in `workspace-write` mode
 *   when switching outside the sandbox writable roots.
 * - `workspace-create`: creates a new working copy on disk and writes `.jj/repo`; asks in
 *   `read-only` mode, and asks in `workspace-write` mode when target, cwd, or `.jj/repo`
 *   lies outside `[workspaceRoot, /tmp, os.tmpdir()]`.
 * - `mutate`: mutates `.jj` or working-copy state; asks in `read-only` mode, and asks in
 *   `workspace-write` mode when cwd, `.jj/repo`, or an affected target workspace lies
 *   outside `[workspaceRoot, /tmp, os.tmpdir()]`.
 */
export const JJ_TOOL_SANDBOX_CLASSES: Readonly<Record<string, JjToolSandboxClass>> = Object.freeze({
  jj_status: 'read',
  jj_log: 'read',
  jj_diff: 'read',
  jj_commit_style: 'read',
  jj_op_log: 'read',
  jj_workspace_list: 'read',
  jj_bookmark_list: 'read',
  jj_workspace_enter: 'workspace-switch',
  jj_workspace_add: 'workspace-create',
  jj_workspace_restore: 'workspace-create',
  jj_new: 'mutate',
  jj_commit: 'mutate',
  jj_describe: 'mutate',
  jj_squash: 'mutate',
  jj_amend: 'mutate',
  jj_undo: 'mutate',
  jj_bookmark_set: 'mutate',
  jj_rebase: 'mutate',
  jj_handoff: 'mutate',
  jj_workspace_cleanup: 'mutate',
  jj_abandon: 'mutate',
  jj_fetch: 'mutate',
  jj_workspace_update_stale: 'mutate',
  jj_op_restore: 'mutate',
});

/**
 * Canonicalize a target path even when its leaf directories do not exist yet.
 *
 * `jj_workspace_add` creates missing directories (for example `/tmp/repo-ws1` on macOS,
 * where `/tmp` is a symlink to `/private/tmp`), and a path inside a workspace may also
 * traverse a symlinked parent pointing outside the sandbox. Walking up to the nearest
 * existing ancestor and resolving `realpathSync` there handles both cases cleanly.
 */
export function resolveSandboxTargetPath(path: string): string {
  let cursor = resolve(path);
  const trailing: string[] = [];
  for (;;) {
    try {
      let resolved = realpathSync(cursor);
      for (let index = trailing.length - 1; index >= 0; index -= 1) {
        const segment = trailing[index];
        if (segment !== undefined) resolved = join(resolved, segment);
      }
      return resolved;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      trailing.push(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Canonical directories writable without approval under a `workspace-write` policy.
 *
 * Matches DSH's `writableRoots(policy)` (`[policy.workspaceRoot, '/tmp', os.tmpdir()]`),
 * while skipping an empty `workspaceRoot` so a malformed policy never resolves `''` to
 * `process.cwd()`.
 */
export function sandboxWritableRoots(policy: JjSandboxPolicy): readonly string[] {
  if (policy.mode !== 'workspace-write') return [];
  const roots = new Set<string>();
  for (const candidate of [policy.workspaceRoot, '/tmp', tmpdir()]) {
    if (candidate.trim().length === 0) continue;
    roots.add(resolveSandboxTargetPath(candidate));
  }
  return [...roots];
}

/** Whether `targetPath` is equal to or nested inside any directory in `roots`. */
export function isPathWithinSandboxRoots(targetPath: string, roots: readonly string[]): boolean {
  if (targetPath.trim().length === 0) return false;
  const resolvedTarget = resolveSandboxTargetPath(targetPath);
  for (const root of roots) {
    if (root.trim().length === 0) continue;
    const resolvedRoot = resolveSandboxTargetPath(root);
    if (resolvedTarget === resolvedRoot) return true;
    const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
    if (resolvedTarget.startsWith(prefix)) return true;
  }
  return false;
}

/** Inputs to {@link decideJjToolSandbox}. */
export interface JjToolSandboxFacts {
  readonly toolName: string;
  readonly policy?: JjSandboxPolicy | undefined;
  readonly cwd: string;
  readonly jjRepoPath?: string | undefined;
  readonly targetPath?: string | undefined;
}

/** Pre-execution sandbox gate decision compatible with DSH `PreToolDecision`. */
export type JjToolSandboxDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'ask';
      readonly reason: string;
      readonly displayReason: { readonly en: string; readonly zh: string };
    };

/**
 * Pure sandbox gate decision for one `jj_*` tool call.
 *
 * Keeps `jj_*` host-executed tools aligned with DSH's file/shell sandbox boundaries:
 * - absent policy or `danger-full-access` allows every call;
 * - `read-only` allows `read` and `workspace-switch` tools (their execution runs with
 *   `--ignore-working-copy`) and asks approval before any `workspace-create` or `mutate`
 *   tool;
 * - `workspace-write` allows writes inside `[workspaceRoot, /tmp, os.tmpdir()]` without
 *   prompting and asks approval when a target directory, current workspace, or shared
 *   `.jj/repo` store lies outside those writable roots.
 */
export function decideJjToolSandbox(facts: JjToolSandboxFacts): JjToolSandboxDecision {
  const { policy, toolName } = facts;
  if (policy === undefined || policy.mode === 'danger-full-access') return { kind: 'allow' };
  const toolClass = JJ_TOOL_SANDBOX_CLASSES[toolName];
  if (toolClass === undefined || toolClass === 'read') return { kind: 'allow' };

  if (policy.mode === 'read-only') {
    if (toolClass === 'workspace-switch') return { kind: 'allow' };
    return {
      kind: 'ask',
      reason: `${toolName} mutates Jujutsu (jj) repository or workspace state while sandbox mode is read-only.`,
      displayReason: {
        en: `Allow ${toolName} to modify the Jujutsu repository in read-only mode`,
        zh: `允许 ${toolName} 在只读沙箱模式下修改 Jujutsu 仓库`,
      },
    };
  }

  const roots = sandboxWritableRoots(policy);
  const workspaceLabel = policy.workspaceRoot.trim().length > 0 ? policy.workspaceRoot : 'unset';
  if (toolClass === 'workspace-switch') {
    if (facts.targetPath !== undefined && !isPathWithinSandboxRoots(facts.targetPath, roots)) {
      return {
        kind: 'ask',
        reason: `${toolName} switches the session working directory to ${facts.targetPath}, outside the workspace-write sandbox roots (${workspaceLabel} and system temp directories).`,
        displayReason: {
          en: `Switch session working directory to ${facts.targetPath} (outside current workspace)`,
          zh: `将当前会话工作目录切换到沙箱可写范围外的 ${facts.targetPath}`,
        },
      };
    }
    return { kind: 'allow' };
  }

  if (toolClass === 'workspace-create' && facts.targetPath !== undefined) {
    if (!isPathWithinSandboxRoots(facts.targetPath, roots)) {
      return {
        kind: 'ask',
        reason: `${toolName} creates a Jujutsu workspace at ${facts.targetPath}, outside the workspace-write sandbox roots (${workspaceLabel} and system temp directories; temporary workspaces under /tmp stay inside workspace-write).`,
        displayReason: {
          en: `Create Jujutsu workspace at ${facts.targetPath} (outside current workspace)`,
          zh: `在沙箱可写范围外创建 Jujutsu 工作区：${facts.targetPath}`,
        },
      };
    }
  }

  for (const candidate of [facts.targetPath, facts.cwd, facts.jjRepoPath]) {
    if (candidate === undefined || isPathWithinSandboxRoots(candidate, roots)) continue;
    return {
      kind: 'ask',
      reason: `${toolName} modifies Jujutsu state at ${candidate}, outside the workspace-write sandbox roots (${workspaceLabel} and system temp directories).`,
      displayReason: {
        en: `Allow ${toolName} to modify Jujutsu state at ${candidate} (outside current workspace)`,
        zh: `允许 ${toolName} 修改当前沙箱可写范围外的 Jujutsu 状态：${candidate}`,
      },
    };
  }
  return { kind: 'allow' };
}
