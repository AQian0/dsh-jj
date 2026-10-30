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
 * Policy refinement (2026-10-30, activity gate): a live Agent is NOT a parallel
 * session. The host keeps an Agent alive after its turn ends (Web GUI sessions
 * stay resumed for the lifetime of the app), so a single session would otherwise
 * see every session it opened earlier in the same working copy as a concurrent
 * peer and isolate itself in a fresh jj workspace. Only a peer whose host-reported
 * activity says it is inside an open turn counts as parallel; {@link
 * JjLiveSession.active} carries that fact and `undefined` keeps the fail-open
 * behavior when the host cannot report it.
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
  /**
   * Whether this session's agent is inside an open turn right now.
   *
   * `false` means the host positively reports an idle session (its turn ended, or
   * it never started one) and it must not be treated as a concurrent peer.
   * `undefined` means the host cannot report activity; callers keep the fail-open
   * behavior and count it as possibly parallel.
   */
  readonly active?: boolean;
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
 * Working directories of sessions that may be running concurrently with `current`.
 *
 * Live-agent presence alone is not evidence of parallel work: the host keeps an
 * Agent alive after its turn ends, so every session the user opened earlier in
 * the same project would otherwise count. Only a peer the host positively reports
 * as idle (`active: false`) is skipped; an unknown activity state keeps the
 * fail-open behavior, and the current session itself is always excluded.
 *
 * @param current - the current session object (`AssembleContext.agent.session`).
 * @param sessions - live top-level sessions, including the current one.
 * @returns the working directories to probe for workspace overlap.
 */
export function parallelPeerCwds(current: unknown, sessions: readonly JjLiveSession[]): string[] {
  const peers: string[] = [];
  for (const entry of sessions) {
    if (entry.session === current) continue;
    if (entry.active === false) continue;
    peers.push(entry.cwd);
  }
  return peers;
}

/**
 * Group live peer sessions by their relation to the current jj workspace.
 *
 * Peers that cannot be resolved to a usable jj workspace, that belong to another
 * repository, or that have an empty/unreadable directory are ignored. The same
 * workspace is reported once even when several peers share it.
 *
 * @param current - the current session's jj workspace identity.
 * @param peerCwds - effective working directories of the other top-level sessions
 *   (use {@link parallelPeerCwds} to drop known-idle peers).
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
    'Parallel sessions: another DSH session is running in this Jujutsu working copy right now. A working copy is not parallel-safe: every jj command snapshots the whole directory, so an unpathed commit can capture another session\'s uncommitted files. Read-only inspection is safe; before writing files:',
    "- Isolate into a new jj workspace with jj_workspace_add: absolute path outside the repository, unique name, never reuse another session's workspace; switch with the working_directory tool, then confirm with jj_status.",
    '- If you already edited this working copy, jj_commit only your own paths first, then pass parents ["@"] to jj_workspace_add to carry them over.',
    "- Never use `git worktree` (jj cannot see that checkout); never move, reuse or delete another session's workspace (shell `jj workspace forget` on another workspace is refused).",
    '- Edit the shared copy only when the user explicitly wants it there; commit explicit paths.',
  ].join('\n');
}

/** One peer session's guidance: isolated working copies, shared repository state. */
function siblingWorkspaceText(): string {
  return [
    'Parallel sessions: another DSH session is using a sibling workspace of this Jujutsu repository. Working copies are isolated; bookmarks and the operation log are shared:',
    "- Rebase, describe, squash, edit and restore only this session's changes; never rewrite another workspace's change or move its bookmark.",
    '- `jj undo` and `jj op restore` rewrite repository-wide state (the guard warns); prefer workspace-local commands.',
  ].join('\n');
}

/** Guidance for `always` mode (or when detection cannot run): several processes may share the project. */
function genericParallelText(): string {
  return [
    'Parallel sessions: several DSH sessions (or separate dsh processes) may run against this project at the same time. If another session shares this working copy, isolate in a dedicated jj workspace before writing files:',
    '- jj_workspace_add with an absolute path outside the repository (unique name; never reuse another workspace), then switch there with the working_directory tool.',
    '- Do not edit, commit, or rewrite files that belong to another session; never use `git worktree` (jj cannot see that checkout).',
  ].join('\n');
}

/** End-of-task rebase hand-off shared by every multi-session variant. */
function finishChecklistText(target: string): string {
  return [
    "Finishing this workspace's work (standard rebase hand-off):",
    '1. jj_commit the last coherent step; keep the change ids you created.',
    `2. Call jj_handoff once instead of manual fetch/rebase/verify: it fetches (a repository without remotes is fine), picks the integration target itself (configured rebaseTarget, default ${target}, then local main/master), rebases the whole stack with source mode, verifies the base, reports conflicts and moves a bookmark you pass. In the default workspace pass firstChange: <bottom-most change id you created>; in your own workspace omit it. If the stack bottoms on an earlier session's commit, keep the chain together.`,
    "3. Resolve conflicts yourself: edit files to their final content, remove the marker blocks, jj_status to snapshot; for a conflict in a middle commit `jj edit <change>`, fix it, then `jj new <top change>`; call jj_handoff again. Report only a conflict you cannot resolve safely.",
    '4. Only ask the user for an integration target when jj_handoff reports none exists; never ask them to fetch, rebase, verify or move bookmarks.',
    '5. If you created this workspace with jj_workspace_add, call jj_workspace_cleanup; if refused (not session-created), report its name/path: the user runs `jj workspace forget <name>`, do not run it yourself.',
    '6. Report the rebased change ids, the resolved destination, any bookmark move and the cleanup outcome.',
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