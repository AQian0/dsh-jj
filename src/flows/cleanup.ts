/**
 * The `jj_workspace_cleanup` flows: leave an owned workspace and unregister it.
 *
 * Two shapes share the same safety rules:
 * - {@link cleanupWorkspace} unregisters the workspace this session runs in (the normal
 *   end-of-task path) and moves the session back to the default workspace;
 * - {@link cleanupForeignWorkspace} unregisters a workspace a *different* (recorded)
 *   session created, after an interruption or restart left it behind. It never moves the
 *   calling session and never deletes the directory.
 *
 * This used to live inside the tool definition, which meant the service, guard and
 * prompt layers could not see the same rules. The flow is deliberately separate from
 * `JjOperations` (which owns one jj subcommand each) and from the tool (which only maps
 * arguments): it is the one place that decides when a workspace may be forgotten, in
 * which order the working copy is moved and forgotten, and what is reported afterwards.
 *
 * Safety invariants (all checked before anything mutates):
 * - only the default workspace is never forgotten;
 * - only a workspace the plugin created through `jj_workspace_add` may be forgotten;
 * - a foreign workspace is only forgotten when its recorded owning session is gone, no
 *   live session occupies it, and its working copy is clean (or the directory is gone);
 * - the current session's workspace must be readable and carry no uncommitted changes or
 *   conflicts, and the host must be able to move the session back to the default one.
 *
 * A stale working copy is recovered once and the check retried, so a sibling
 * workspace's hand-off cannot make cleanup fail on a read that a recovery would fix.
 *
 * @module dsh-jj/flows/cleanup
 */

import { existsSync } from 'node:fs';
import {
  canonicalWorkspacePath,
  decideOrphanWorkspaceCleanup,
  decideWorkspaceCleanup,
  isStaleWorkingCopyFailure,
  type OrphanWorkspaceCleanupRefusal,
  type OwnedWorkspace,
  type WorkspaceCleanupRefusal,
} from '../policies.ts';
import type { JjChangeRecord, JjOperations } from '../service.ts';
import type { VcsDescriptor } from '../types.ts';

/** Result of a successful cleanup (the tool's output shape). */
export interface JjWorkspaceCleanupResult {
  /** False when the workspace was already unregistered and only a stale record was removed. */
  readonly forgotten: boolean;
  readonly workspaceName: string;
  readonly workspaceRoot: string;
  readonly currentWorkspace: string;
  readonly currentWorkspaceRoot: string;
  readonly message: string;
  readonly directoryNote: string;
  /** Which flow ran: the calling session's workspace, or a recorded foreign one. */
  readonly mode?: 'current' | 'orphan';
  /** Recorded owner session of a foreign workspace. */
  readonly ownerSessionId?: string;
  /** Whether that owner session was still live when the cleanup ran (must be false). */
  readonly ownerAlive?: boolean;
  /** Whether a live session occupied the foreign workspace (must be false). */
  readonly inUse?: boolean;
  /** Empty, unpublished working-copy change abandoned after the forget, when any. */
  readonly prunedEmptyChangeId?: string;
  /** True when the workspace was already unregistered and only the record was removed. */
  readonly alreadyForgotten?: boolean;
}

/** What the flow reads from the host: the session working directory, nothing else. */
export interface CleanupHost {
  readonly workingDirectory?: {
    set?(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
  };
}

/** Operations the cleanup flows need (a live `JjOperations` satisfies it). */
export type CleanupOperations = Pick<
  JjOperations,
  | 'status'
  | 'workspaceList'
  | 'workspaceStates'
  | 'workspaceForget'
  | 'changeExists'
  | 'updateStale'
  | 'readAt'
  | 'log'
  | 'abandon'
>;

/** Ownership and liveness facts supplied by the tool layer. */
export interface CleanupOwnership {
  /** Durable/in-memory record for a workspace name (optionally narrowed by root). */
  readonly findRecord: (name: string, root?: string) => OwnedWorkspace | undefined;
  /** Whether the recorded owner session is still live (host sessions or fresh heartbeat). */
  readonly ownerAlive?: (record: OwnedWorkspace) => boolean;
  /** Whether a live session other than the caller occupies the workspace root. */
  readonly isWorkspaceLive: (root: string) => boolean;
  /** Remove the ownership record after a successful forget. */
  readonly forgetRecord: (name: string) => void;
}

/** Inputs of {@link cleanupWorkspace}. */
export interface CleanupWorkspaceOptions extends CleanupOwnership {
  readonly operations: CleanupOperations;
  /** Whether this session created the workspace (service-level ownership registry). */
  readonly owns: (name: string, root: string) => boolean;
  readonly host: CleanupHost;
  /** The session whose working directory moves back to the default workspace. */
  readonly agent: unknown;
  readonly cwd: string;
  readonly descriptor: VcsDescriptor;
  readonly signal?: AbortSignal;
}

/** Inputs of {@link cleanupForeignWorkspace}. */
export interface CleanupForeignWorkspaceOptions extends CleanupOwnership {
  readonly operations: CleanupOperations;
  readonly host: CleanupHost;
  readonly agent: unknown;
  readonly cwd: string;
  readonly descriptor: VcsDescriptor;
  /** Workspace name or absolute root requested by the caller. */
  readonly target: string;
  readonly signal?: AbortSignal;
}

/** Refusal message for every reason the current-workspace decision can return. */
function refusalMessage(reason: WorkspaceCleanupRefusal, workspaceName: string, workspaceRoot: string): string {
  switch (reason) {
    case 'default-workspace':
      return 'jj_workspace_cleanup is unnecessary here: this session already runs in the default workspace, which must never be forgotten.';
    case 'not-owned':
      return [
        `jj_workspace_cleanup refused: workspace "${workspaceName}" was not created through jj_workspace_add in this session, so the plugin will not unregister it.`,
        'Unregistering a workspace another session or the user created would break their working copy.',
        `If the user should clean it up: from the default workspace run \`jj workspace forget ${workspaceName}\`, then delete ${workspaceRoot}. Report those commands; do not run jj workspace forget yourself (the shell guard denies it).`,
      ].join('\n');
    case 'unreadable-working-copy':
      return `jj_workspace_cleanup could not read the working copy of "${workspaceName}" even after recovering a stale checkout; commit or resolve it first and retry, or keep the workspace and report it to the user.`;
    case 'dirty-working-copy':
      return 'The working copy still has uncommitted changes. Commit them with jj_commit (or finish the hand-off with jj_handoff) before cleaning up, so nothing is lost when the workspace is unregistered.';
    case 'conflicted-working-copy':
      return 'The working copy still has unresolved conflicts. Resolve them and finish the hand-off (jj_handoff) before cleaning up the workspace.';
    case 'no-default-workspace':
      return 'jj_workspace_cleanup could not find the default workspace to move this session back to; report the cleanup commands to the user instead.';
    case 'no-working-directory':
      return 'jj_workspace_cleanup cannot move this session back to the default workspace (the host workingDirectory service exposes no set). Keep the workspace registered and report the cleanup commands to the user instead.';
  }
}

/** Refusal message for every reason a foreign-workspace cleanup can return. */
function orphanRefusalMessage(
  reason: Exclude<OrphanWorkspaceCleanupRefusal, 'not-registered' | 'current-workspace'>,
  workspaceName: string,
  workspaceRoot: string,
): string {
  const manual = `If it should be cleaned up anyway: from the default workspace run \`jj workspace forget ${workspaceName}\`, then delete ${workspaceRoot || 'its directory'}. Report those commands; the shell guard denies jj workspace forget for other workspaces.`;
  switch (reason) {
    case 'default-workspace':
      return 'The default workspace can never be forgotten.';
    case 'not-recorded':
      return [
        `jj_workspace_cleanup does not unregister ${JSON.stringify(workspaceName)}: no jj_workspace_add record exists for it, so another session or the user created it.`,
        manual,
      ].join('\n');
    case 'owner-live':
      return [
        `jj_workspace_cleanup refused: the session recorded as the owner of "${workspaceName}" is still live, so unregistering its workspace would break its working copy.`,
        'Ask that session to finish and clean up after itself (jj_handoff, then jj_workspace_cleanup), or ask the user.',
      ].join('\n');
    case 'in-use':
      return [
        `jj_workspace_cleanup refused: a live session is currently working in "${workspaceName}" (${workspaceRoot}), even though it is not the recorded owner.`,
        'Finish or close that session first; do not unregister a workspace in active use.',
      ].join('\n');
    case 'unreadable-working-copy':
      return `jj_workspace_cleanup could not read the working copy of "${workspaceName}" even after recovering a stale checkout; report it to the user instead of unregistering it.`;
    case 'dirty-working-copy':
      return 'The foreign workspace still has uncommitted changes, so unregistering it could strand them. Ask the user to recover that workspace first.';
    case 'conflicted-working-copy':
      return 'The foreign workspace still has unresolved conflicts; ask the user to recover that workspace first.';
  }
}

/**
 * Read the working copy, recovering a stale checkout once.
 *
 * @param operations - jj operations used for the read and the recovery.
 * @param cwd - workspace directory.
 * @param signal - cancellation signal.
 * @returns the status, or `undefined` when even the recovery could not read it.
 */
async function readWorkingCopyOnceRecovered(
  operations: CleanupOperations,
  cwd: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<CleanupOperations['status']>> | undefined> {
  try {
    return await operations.status(cwd, signal);
  } catch (error) {
    if (!isStaleWorkingCopyFailure(error)) throw error;
    try {
      await operations.updateStale(cwd, signal);
      return await operations.status(cwd, signal);
    } catch {
      // A workspace that stays unreadable keeps its registration: losing the check is
      // worse than leaving a stale directory for the user to remove.
      return undefined;
    }
  }
}

/**
 * Abandon a forgotten workspace's empty working-copy change when it is safe.
 *
 * jj abandons such a change on `workspace forget` only when it is empty, undescribed and
 * has no descendants. A change described through `jj_workspace_add -m`, or one another
 * workspace was based on, is kept and would surface as an empty commit forever; this
 * helper drops it when it is provably content-free: empty, conflict-free, unpublished
 * (no bookmark, no remote bookmark, not immutable) and without any descendant.
 *
 * @param operations - jj operations.
 * @param cwd - directory to run jj in (any workspace of the repository).
 * @param changeId - the forgotten workspace's working-copy change id.
 * @param signal - cancellation signal.
 * @returns the abandoned change id, or `undefined` when it was kept.
 */
async function pruneEmptyWorkingCopy(
  operations: CleanupOperations,
  cwd: string,
  changeId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const record = await operations.readAt(cwd, signal, changeId);
    if (!record.empty || record.conflict) return undefined;
    if (record.immutable || record.remoteBookmarks.length > 0 || record.bookmarks.length > 0) return undefined;
    const descendants = await operations.log(cwd, `(${changeId}):: ~ (${changeId})`, 1, signal);
    if (descendants.length > 0) return undefined;
    await operations.abandon(cwd, changeId, signal);
    return changeId;
  } catch {
    // The workspace is already unregistered: never fail the cleanup here.
    return undefined;
  }
}

/**
 * Describe what happened to the forgotten workspace's working-copy change.
 *
 * @param retained - the change is still visible after the forget.
 * @param prunedEmptyChangeId - change id abandoned by {@link pruneEmptyWorkingCopy}.
 * @param forgotten - the working-copy record read before the forget.
 * @returns the sentence appended to the result message (possibly empty).
 */
function retainedNote(retained: boolean, prunedEmptyChangeId: string | undefined, forgotten: JjChangeRecord): string {
  if (prunedEmptyChangeId !== undefined) {
    return ` The workspace's empty working-copy change ${forgotten.changeId} was abandoned after the forget (it had no descendants and was not published), so it cannot surface as an empty commit.`;
  }
  if (!retained) return '';
  return ` Note: the workspace's empty working-copy change ${forgotten.changeId}${forgotten.description.length > 0 ? ` (${forgotten.description})` : ''} was not abandoned by jj (it has a description or another workspace is based on it), so it stays in the shared history and may appear as an empty commit. Inspect it with jj_log; if another workspace is based on it, leave it and report it to the user.`;
}

/**
 * Unregister this session's workspace and move the session back to the default one.
 *
 * @param options - operations, ownership check, host, agent, workspace and signal.
 * @returns the cleanup result (the caller renders it).
 * @throws Error with the refusal message when a safety invariant does not hold.
 */
export async function cleanupWorkspace(options: CleanupWorkspaceOptions): Promise<JjWorkspaceCleanupResult> {
  const { operations, descriptor, signal } = options;
  const workspaceName = descriptor.workspaceName ?? 'default';
  const workspaceRoot = descriptor.root;

  const status = await readWorkingCopyOnceRecovered(operations, options.cwd, signal);
  const workspaces = await operations.workspaceList(options.cwd, signal).catch(() => []);
  const defaultWorkspace = workspaces.find((workspace) => workspace.name === 'default');
  const host = options.host;
  const canSwitch = options.agent !== undefined && typeof host.workingDirectory?.set === 'function';

  const refusal = decideWorkspaceCleanup({
    workspaceName,
    owned: options.owns(workspaceName, workspaceRoot),
    workingCopy: status === undefined ? undefined : { empty: status.change.empty, conflict: status.change.conflict },
    defaultWorkspaceRoot: defaultWorkspace?.root,
    canSwitchWorkingDirectory: canSwitch,
  });
  if (refusal !== undefined) throw new Error(refusalMessage(refusal, workspaceName, workspaceRoot));
  // Narrowed by the decision above; the error message keeps the invariant explicit.
  if (status === undefined || defaultWorkspace === undefined) {
    throw new Error(refusalMessage('unreadable-working-copy', workspaceName, workspaceRoot));
  }

  await (host.workingDirectory as { set(agent: unknown, path: string, signal?: AbortSignal): Promise<string> }).set(
    options.agent,
    defaultWorkspace.root,
    signal,
  );
  const forgotten = status.change;
  const message = await operations.workspaceForget(defaultWorkspace.root, workspaceName, signal);
  options.forgetRecord(workspaceName);
  // jj abandons the forgotten workspace's working-copy commit only when it is empty,
  // undescribed and has no descendants. Otherwise it stays in the shared history (a
  // described empty change, or one another workspace is based on) and can surface as an
  // empty commit; prune it only when it is provably content-free, else say so.
  let retained = false;
  try {
    retained = await operations.changeExists(defaultWorkspace.root, forgotten.changeId, signal);
  } catch {
    // The workspace is already unregistered: never fail the cleanup here.
    retained = false;
  }
  const prunedEmptyChangeId = retained
    ? await pruneEmptyWorkingCopy(operations, defaultWorkspace.root, forgotten.changeId, signal)
    : undefined;
  return {
    forgotten: true,
    mode: 'current',
    workspaceName,
    workspaceRoot,
    currentWorkspace: 'default',
    currentWorkspaceRoot: defaultWorkspace.root,
    message: `${message}${retainedNote(retained, prunedEmptyChangeId, forgotten)}`,
    directoryNote: `The directory ${workspaceRoot} is no longer a jj working copy; its files remain on disk and nothing tracked was lost. The user can delete it whenever convenient.`,
    ...(prunedEmptyChangeId !== undefined ? { prunedEmptyChangeId } : {}),
  };
}

/**
 * Unregister a workspace another (recorded) session created, without moving this session.
 *
 * @param options - operations, ownership/liveness facts and the target name or root.
 * @returns the cleanup result (the caller renders it).
 * @throws Error with the refusal message when a safety invariant does not hold.
 */
export async function cleanupForeignWorkspace(
  options: CleanupForeignWorkspaceOptions,
): Promise<JjWorkspaceCleanupResult> {
  const { operations, descriptor, signal } = options;
  const currentName = descriptor.workspaceName ?? 'default';
  const currentRoot = descriptor.root;
  const requested = options.target.trim();
  const states = await operations.workspaceStates(options.cwd, signal).catch(() => []);
  const requestedPath = canonicalWorkspacePath(requested);
  const state =
    states.find((candidate) => candidate.name === requested) ??
    states.find((candidate) => canonicalWorkspacePath(candidate.root) === requestedPath);
  const name = state?.name ?? requested;

  if (state === undefined) {
    const record = options.findRecord(name);
    if (record === undefined) {
      throw new Error(orphanRefusalMessage('not-recorded', name, ''));
    }
    // The user (or another session) already forgot the workspace; drop the stale record
    // so it stops showing up as an orphan.
    options.forgetRecord(name);
    return {
      forgotten: false,
      alreadyForgotten: true,
      mode: 'orphan',
      workspaceName: name,
      workspaceRoot: record.root,
      currentWorkspace: currentName,
      currentWorkspaceRoot: currentRoot,
      ownerSessionId: record.sessionId ?? '',
      message: `Workspace "${name}" is not registered with jj anymore; the stale ownership record was removed. Nothing was forgotten.`,
      directoryNote: `The directory ${record.root} was already outside jj's workspace list; the plugin does not delete files.`,
    };
  }

  const root = state.root;
  const isCurrentWorkspace =
    canonicalWorkspacePath(root) === canonicalWorkspacePath(currentRoot) || name === currentName;
  const directoryExists = existsSync(root);
  const status = directoryExists ? await readWorkingCopyOnceRecovered(operations, root, signal) : undefined;
  const record = options.findRecord(name, root);
  const recorded = record !== undefined;
  const ownerAlive = record !== undefined && options.ownerAlive?.(record) === true;
  const inUse = options.isWorkspaceLive(root);
  const refusal = decideOrphanWorkspaceCleanup({
    workspaceName: name,
    isCurrentWorkspace,
    recorded,
    registered: true,
    ownerAlive,
    inUse,
    directoryExists,
    ...(status !== undefined ? { workingCopy: { empty: status.change.empty, conflict: status.change.conflict } } : {}),
  });
  if (refusal !== undefined) {
    if (refusal === 'current-workspace') {
      throw new Error(
        'jj_workspace_cleanup was asked to unregister the workspace it runs in through the foreign path; retry without `workspace` to run the normal cleanup.',
      );
    }
    if (refusal === 'not-registered') throw new Error(orphanRefusalMessage('not-recorded', name, root));
    throw new Error(orphanRefusalMessage(refusal, name, root));
  }

  // Unregister from the calling workspace: never move this session into the target.
  const message = await operations.workspaceForget(options.cwd, name, signal);
  options.forgetRecord(name);
  let note = '';
  let prunedEmptyChangeId: string | undefined;
  if (status !== undefined) {
    const forgotten = status.change;
    let retained = false;
    try {
      retained = await operations.changeExists(options.cwd, forgotten.changeId, signal);
    } catch {
      retained = false;
    }
    prunedEmptyChangeId = retained
      ? await pruneEmptyWorkingCopy(operations, options.cwd, forgotten.changeId, signal)
      : undefined;
    note = retainedNote(retained, prunedEmptyChangeId, forgotten);
  } else {
    note =
      ' The workspace directory is gone, so its working copy could not be snapshotted; unregistering it is safe (the registration was the only remaining state).';
  }
  return {
    forgotten: true,
    mode: 'orphan',
    workspaceName: name,
    workspaceRoot: root,
    currentWorkspace: currentName,
    currentWorkspaceRoot: currentRoot,
    ownerSessionId: record?.sessionId ?? '',
    ownerAlive: false,
    inUse: false,
    message: `${message}${note}`,
    directoryNote: `The directory ${root} is no longer a jj working copy; its files remain on disk. The plugin does not delete directories.`,
    ...(prunedEmptyChangeId !== undefined ? { prunedEmptyChangeId } : {}),
  };
}
