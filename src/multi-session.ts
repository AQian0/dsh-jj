/**
 * Multi-session (parallel DSH session) detection and model-facing guidance.
 *
 * Policy (2026-10-30): when several top-level DSH sessions work in the same jj
 * project at the same time, one shared working copy is not parallel-safe. Every
 * jj command snapshots the whole directory, so a commit or squash performed by
 * one session can capture another session's uncommitted files. The preference is
 * therefore: each parallel session isolates itself in its own jj workspace
 * (`jj workspace add`) before writing files, and when its work is done it
 * rebases the change stack onto the trunk so the parallel results can be
 * integrated linearly.
 *
 * The runtime entry detects live top-level sessions through the host's agent
 * registry (`ctx.agents.roots()`), resolves their working directories with the
 * `workingDirectory` service, and feeds the result into this module. Detection
 * is fail-open: no host services means no detection, and the prompt context then
 * emits nothing (`auto` mode).
 *
 * This module is pure: no I/O except a `realpath` used to compare workspace
 * identities, no subprocess, and no `@deepseek-ai/*` imports. The host injects
 * the synchronous {@link JjWorkspaceProbe}.
 *
 * @module dsh-jj/multi-session
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** Every accepted `multiSessionGuidance` configuration value. */
export const MULTI_SESSION_GUIDANCE_MODES = ['auto', 'always', 'off'] as const;

/** Multi-session guidance mode (`auto` = only when parallel sessions are detected). */
export type MultiSessionGuidanceMode = (typeof MULTI_SESSION_GUIDANCE_MODES)[number];

/** Default end-of-task rebase destination (jj's builtin trunk revset). */
export const DEFAULT_REBASE_TARGET = 'trunk()';

/**
 * One live top-level DSH session, as provided by the runtime entry.
 *
 * The session object is opaque here: it is compared by reference to exclude the
 * current session, and is never serialised into the prompt.
 */
export interface JjLiveSession {
  /** DSH session object (`agent.session`); identity matters, contents do not. */
  readonly session: unknown;
  /** Effective session working directory (`workingDirectory.get(session)`). */
  readonly cwd: string;
}

/** Synchronously resolved jj workspace identity for one directory. */
export interface JjWorkspaceIdentity {
  /** jj workspace root: the directory containing `.jj`. */
  readonly workspaceRoot: string;
  /**
   * Resolved shared-repository path behind `.jj/repo` (a directory for the
   * default workspace, the pointer target for a linked workspace). Two different
   * workspaces of one repository share this path.
   */
  readonly jjRepoPath?: string;
}

/**
 * Synchronous workspace probe injected by the host.
 *
 * @param cwd - a session's effective working directory.
 * @returns the jj workspace identity, or `undefined` when `cwd` is not inside a
 *   usable jj workspace.
 */
export type JjWorkspaceProbe = (cwd: string) => JjWorkspaceIdentity | undefined;

/** Peer sessions grouped by how their working copy relates to this session's. */
export interface ParallelSessionDetection {
  /** Distinct peer workspace roots that are the same working copy as this session's. */
  readonly sharedWorkspace: readonly string[];
  /** Distinct peer workspace roots in the same jj repository but a different working copy. */
  readonly siblingWorkspace: readonly string[];
}

/** Options for {@link multiSessionPromptText}. */
export interface MultiSessionPromptOptions {
  /** Resolved `multiSessionGuidance` config value. */
  readonly mode: MultiSessionGuidanceMode;
  /** Detection result; `undefined` when the host cannot enumerate live sessions. */
  readonly detection?: ParallelSessionDetection;
  /** Rebase destination revset (`rebaseTarget` config; defaults to `trunk()`). */
  readonly rebaseTarget?: string;
}

/** Canonical identity of a path (realpath when it exists, else the resolved absolute path). */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Group live peer sessions by their relation to the current jj workspace.
 *
 * Peers that cannot be resolved to a usable jj workspace, that belong to another
 * repository, or that have an empty/unreadable directory are ignored. The same
 * workspace is reported once even when several peers share it.
 *
 * @param current - the current session's jj workspace identity.
 * @param peerCwds - effective working directories of the other top-level sessions.
 * @param probe - synchronous workspace probe (failures are ignored per peer).
 * @returns distinct shared/sibling workspace roots.
 */
export function detectParallelSessions(
  current: JjWorkspaceIdentity,
  peerCwds: readonly string[],
  probe: JjWorkspaceProbe,
): ParallelSessionDetection {
  const currentRoot = canonicalPath(current.workspaceRoot);
  const currentRepo = current.jjRepoPath === undefined ? undefined : canonicalPath(current.jjRepoPath);
  const shared = new Set<string>();
  const sibling = new Set<string>();

  for (const cwd of peerCwds) {
    if (typeof cwd !== 'string' || cwd.length === 0) continue;
    let peer: JjWorkspaceIdentity | undefined;
    try {
      peer = probe(cwd);
    } catch {
      peer = undefined;
    }
    if (peer === undefined) continue;
    const peerRoot = canonicalPath(peer.workspaceRoot);
    if (peerRoot === currentRoot) {
      shared.add(peerRoot);
      continue;
    }
    const peerRepo = peer.jjRepoPath === undefined ? undefined : canonicalPath(peer.jjRepoPath);
    // A different workspace belongs to the same repository only when both sides
    // resolve `.jj/repo`; without that pointer the relation is unknowable.
    if (currentRepo !== undefined && peerRepo !== undefined && peerRepo === currentRepo) sibling.add(peerRoot);
  }

  return { sharedWorkspace: [...shared], siblingWorkspace: [...sibling] };
}

/** One peer session's guidance: isolate before writing into the shared working copy. */
function sharedWorkingCopyText(): string {
  return [
    'Parallel sessions: another live DSH session is using this Jujutsu working copy. A working copy is not safe to share between concurrent sessions: every jj command (including `jj workspace add`) snapshots the whole directory, and a commit without paths can capture another session\'s uncommitted files.',
    'Before writing files, isolate this session in its own jj workspace (read-only inspection is safe):',
    "- Create it with jj_workspace_add (or `jj workspace add <path> --name <name>`): check jj_workspace_list first and never reuse another session's workspace; use an absolute path OUTSIDE the repository root (a sibling directory of the repository root is fine), a name unique to this session, and no parents so it starts from the current change's parents.",
    '- Move this session into it with the working_directory tool (`cd` to the new path, when installed), then confirm with jj_status that the new workspace has its own working-copy change.',
    '- If this session already made changes in the shared working copy, commit only the paths this session owns first (jj_commit with paths) and pass parents: ["@"] to jj_workspace_add (`jj workspace add --revision @ <path>`) so the new workspace carries them over.',
    '- Only edit the shared working copy when the user explicitly wants the change there; then commit explicit paths with jj_commit and remember that the other session\'s files are snapshotted here too.',
    '- Never use `git worktree` (jj cannot see that checkout), and never move, reuse or delete another session\'s workspace (`jj workspace forget` on another workspace is refused by the guard).',
  ].join('\n');
}

/** One peer session's guidance: isolated working copies, shared repository state. */
function siblingWorkspaceText(): string {
  return [
    'Parallel sessions: another live DSH session shares this Jujutsu repository but works in a separate workspace. Your working copies are isolated while bookmarks and the operation log are shared:',
    "- Rebase, describe, squash, edit and restore only this session's own changes; never rewrite another workspace's working-copy change or move its bookmark.",
    '- Keep this session\'s edits inside its own workspace, and prefer workspace-local commands: `jj undo` and `jj op restore` rewrite repository-wide state (the guard warns about them).',
    '- When the task is done, hand the change over with the standard rebase checklist below.',
  ].join('\n');
}

/** Guidance for `always` mode (or when detection cannot run): several processes may share the project. */
function genericParallelText(): string {
  return [
    'Parallel sessions: several DSH sessions (or separate dsh processes) may run against this project at the same time. If another session shares this working copy (the user says so, or the project is being worked on in parallel), isolate this session in a dedicated jj workspace before writing files:',
    "- jj_workspace_add with an absolute path OUTSIDE the repository root (`jj workspace add <path> --name <name>` when the jj_* tools are unavailable), then move this session there with the working_directory tool.",
    '- Do not edit, commit, or rewrite files that belong to another session; never use `git worktree` (jj cannot see that checkout).',
  ].join('\n');
}

/** End-of-task rebase hand-off shared by every multi-session variant. */
function finishChecklistText(target: string): string {
  return [
    "Finishing this workspace's work (standard rebase hand-off):",
    '1. Commit the last coherent step with jj_commit so the change is durable, and keep the change ids this session created.',
    `2. Choose the destination carefully. Run \`jj git fetch\` first; if jj exits 1 with "No git remotes to fetch from" there is simply no remote, which is fine to ignore. Then verify the target: \`jj log -r '${target}'\` must print a real commit (not the empty root commit), and the stack's base must already be in its ancestry — \`jj log -r '(<first change>-) & ~::${target}'\` must print nothing. If either check fails (no remote trunk configured, or local main is ahead of the remote), use the local main or master bookmark or the revision the user names instead.`,
    `3. Move the WHOLE stack in one rebase: jj_rebase with revision = the first change this session created, destination = ${target}, and mode = source (or \`jj rebase -s <first change> -d '${target}'\`). Never use the revisions/-r mode for a stack: it moves only the named change and leaves the descendants behind, re-parented onto the old parent. Confirm that every descendant this moves belongs to this session before you run it. Do not cherry-pick, and never use git rebase or git merge here.`,
    "4. Verify the result: jj_status reports no conflicts, jj_log shows the stack directly on top of the target, and jj_diff shows only the intended files. To resolve a conflict, edit the files to their final content (remove the `<<<<<<<` / `%%%%%%%` / `>>>>>>>` marker blocks) and run jj_status so jj snapshots the resolution; `jj resolve --list` lists anything still conflicting. For a conflict inside a middle commit, `jj edit <change>`, fix it, then return to the top change. If jj reports the working copy is stale (another session rewrote a shared ancestor), run `jj workspace update-stale` and re-verify: never `jj undo` / `jj op restore` for this. If a conflict cannot be resolved safely, stop and report it with the change ids.",
    "5. Move a bookmark (jj_bookmark_set) to the rebased tip only when this session owns it; never move another session's bookmark. Report the rebased change ids and the destination to the user.",
    '6. Do not run `jj workspace forget` yourself: forgetting THIS workspace unregisters its working copy, so jj stops recognizing this directory (the files stay, but jj commands report no working copy). Leave the temporary workspace registered and report its name and path from jj_workspace_list; the user can forget it from the default workspace and delete the directory afterwards.',
  ].join('\n');
}

/**
 * The end-of-task rebase hand-off on its own.
 *
 * Used when the session has already seen a parallel peer but the peer is no longer
 * live: the isolation section would be stale, while the rebase reminder still applies.
 *
 * @param rebaseTarget - jj revset destination; empty/undefined falls back to `trunk()`.
 * @returns the checklist text (never empty).
 */
export function multiSessionFinishChecklistText(rebaseTarget?: string): string {
  const target =
    rebaseTarget !== undefined && rebaseTarget.trim().length > 0 ? rebaseTarget : DEFAULT_REBASE_TARGET;
  return finishChecklistText(target);
}

/**
 * Model-facing multi-session guidance block.
 *
 * @param options - resolved mode, optional detection result, and rebase target.
 * @returns the multi-line text, or `''` when the mode/detection contributes nothing.
 */
export function multiSessionPromptText(options: MultiSessionPromptOptions): string {
  if (options.mode === 'off') return '';
  const detection = options.detection;
  const shared = detection?.sharedWorkspace.length ?? 0;
  const sibling = detection?.siblingWorkspace.length ?? 0;
  const target = options.rebaseTarget !== undefined && options.rebaseTarget.trim().length > 0 ? options.rebaseTarget : DEFAULT_REBASE_TARGET;

  const blocks: string[] = [];
  if (shared > 0) blocks.push(sharedWorkingCopyText());
  else if (sibling > 0) blocks.push(siblingWorkspaceText());
  else if (options.mode === 'always') blocks.push(genericParallelText());
  if (blocks.length === 0) return '';
  blocks.push(finishChecklistText(target));
  return blocks.join('\n');
}