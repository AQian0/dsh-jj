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
  /**
   * Change the workspace's first working copy was created on top of (the parents
   * `jj workspace add` used). `jj_workspace_restore` recreates a deleted workspace on
   * exactly this base; `undefined` when the workspace was created with explicit
   * parents, because a multi-parent base cannot be reproduced from one change id.
   */
  readonly baseChangeId?: string;
}

/**
 * Per-session ownership of the workspaces the plugin created.
 *
 * The map is keyed by the live agent, so it is exactly as long-lived as the session:
 * a restarted host has no owned workspaces and therefore cannot forget anything it did
 * not create in the current process. `root` is stored canonicalized because the same
 * directory can be reached through a symlink (see AGENTS rule 13).
 */
export class WorkspaceOwnership {
  private readonly byAgent = new WeakMap<object, OwnedWorkspace[]>();

  /**
   * Record that `agent` created `name` at `root`.
   *
   * Duplicates are ignored, so calling it after a retry is harmless.
   *
   * @param agent - live agent of the session (`exec.agent`).
   * @param name - jj workspace name.
   * @param root - workspace root as reported by jj.
   */
  remember(agent: unknown, name: string, root: string, baseChangeId?: string): void {
    if (typeof agent !== 'object' || agent === null) return;
    const owned = this.byAgent.get(agent) ?? [];
    const canonicalRoot = canonicalWorkspacePath(root);
    const existing = owned.find((entry) => entry.name === name && entry.root === canonicalRoot);
    if (existing !== undefined) {
      if (baseChangeId === undefined || existing.baseChangeId === baseChangeId) return;
      owned[owned.indexOf(existing)] = { ...existing, baseChangeId };
    } else {
      owned.push({ name, root: canonicalRoot, ...(baseChangeId !== undefined ? { baseChangeId } : {}) });
    }
    this.byAgent.set(agent, owned);
  }

  /**
   * Whether `agent` created the workspace `name` at `root`.
   *
   * @param agent - live agent of the session.
   * @param name - jj workspace name.
   * @param root - workspace root as reported by jj.
   * @returns true only when both name and canonical root match a recorded entry.
   */
  owns(agent: unknown, name: string, root: string): boolean {
    if (typeof agent !== 'object' || agent === null) return false;
    const canonicalRoot = canonicalWorkspacePath(root);
    return (this.byAgent.get(agent) ?? []).some((entry) => entry.name === name && entry.root === canonicalRoot);
  }

  /** Every workspace `agent` created in this process (read-only view). */
  list(agent: unknown): readonly OwnedWorkspace[] {
    if (typeof agent !== 'object' || agent === null) return [];
    return [...(this.byAgent.get(agent) ?? [])];
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
