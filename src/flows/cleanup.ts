/**
 * The `jj_workspace_cleanup` flow: leave an owned workspace and unregister it.
 *
 * This used to live inside the tool definition, which meant the service, guard and
 * prompt layers could not see the same rules. The flow is deliberately separate from
 * `JjOperations` (which owns one jj subcommand each) and from the tool (which only maps
 * arguments): it is the one place that decides when a workspace may be forgotten, in
 * which order the working copy is moved and forgotten, and what is reported afterwards.
 *
 * Safety invariants (all checked before anything mutates):
 * - only the default workspace is never forgotten;
 * - only a workspace this session created through `jj_workspace_add` may be forgotten;
 * - the working copy must be readable and carry no uncommitted changes or conflicts;
 * - the host must be able to move the session back to the default workspace.
 *
 * A stale working copy is recovered once and the check retried, so a sibling
 * workspace's hand-off cannot make cleanup fail on a read that a recovery would fix.
 *
 * @module dsh-jj/flows/cleanup
 */

import { isStaleWorkingCopyFailure, decideWorkspaceCleanup, type WorkspaceCleanupRefusal } from '../policies.ts';
import type { JjOperations } from '../service.ts';
import type { VcsDescriptor } from '../types.ts';

/** Result of a successful cleanup (the tool's output shape). */
export interface JjWorkspaceCleanupResult {
  readonly forgotten: true;
  readonly workspaceName: string;
  readonly workspaceRoot: string;
  readonly currentWorkspace: string;
  readonly currentWorkspaceRoot: string;
  readonly message: string;
  readonly directoryNote: string;
}

/** What the flow reads from the host: the session working directory, nothing else. */
export interface CleanupHost {
  readonly workingDirectory?: {
    set?(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
  };
}

/** Operations the cleanup flow needs (a live `JjOperations` satisfies it). */
export type CleanupOperations = Pick<
  JjOperations,
  'status' | 'workspaceList' | 'workspaceForget' | 'changeExists' | 'updateStale'
>;

/** Inputs of {@link cleanupWorkspace}. */
export interface CleanupWorkspaceOptions {
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

/** Refusal message for every reason the decision can return. */
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
  // jj abandons the forgotten workspace's working-copy commit only when it is empty,
  // undescribed and has no descendants. Otherwise it stays in the shared history (a
  // described empty change, or one another workspace is based on) and can surface as an
  // empty commit, so say so instead of implying a clean forget.
  let retained = false;
  try {
    retained = await operations.changeExists(defaultWorkspace.root, forgotten.changeId, signal);
  } catch {
    // The workspace is already unregistered: never fail the cleanup here.
    retained = false;
  }
  const retainedNote = retained
    ? ` Note: the workspace's empty working-copy change ${forgotten.changeId}${forgotten.description.length > 0 ? ` (${forgotten.description})` : ''} was not abandoned by jj (it has a description or another workspace is based on it), so it stays in the shared history and may appear as an empty commit. Inspect it with jj_log; if another workspace is based on it, leave it and report it to the user.`
    : '';
  return {
    forgotten: true,
    workspaceName,
    workspaceRoot,
    currentWorkspace: 'default',
    currentWorkspaceRoot: defaultWorkspace.root,
    message: `${message}${retainedNote}`,
    directoryNote: `The directory ${workspaceRoot} is no longer a jj working copy; its files remain on disk and nothing tracked was lost. The user can delete it whenever convenient.`,
  };
}
