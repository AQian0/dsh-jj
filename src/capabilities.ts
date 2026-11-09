/**
 * Capability matrix: what each jj subcommand the guard knows about is *for*.
 *
 * The guard classifies shell invocations, the tools expose structured actions, and the
 * model-facing guidance names concrete tools. Those three views drift silently unless
 * one table says which of them owns a subcommand. This module is that table:
 *
 * - `tool` — a `jj_*` tool performs it; the model should call the tool, not the shell.
 * - `shell` — the plugin deliberately does not wrap it; running it in the shell is fine
 *   (read-only inspection, advanced or interactive verbs).
 * - `blocked` — the guard refuses it (a hard-deny safety rule), or it may only happen
 *   through a specific tool that carries the plugin's ownership checks.
 *
 * `test/capabilities.test.ts` asserts the matrix covers exactly the subcommands in
 * `jj-rules.ts`, and that every `tool` entry names a registered tool. Adding a rule to
 * the guard therefore fails the build until this table is updated — the point is that
 * "who owns this verb" is a decision, not an accident.
 *
 * @module dsh-jj/capabilities
 */

import { JJ_READ_ONLY_SUBCOMMANDS, JJ_REPO_WIDE_SUBCOMMANDS, JJ_WORKSPACE_LOCAL_SUBCOMMANDS } from './jj-rules.ts';

/** Who owns one jj subcommand. */
export type JjCapability =
  | {
      /** A `jj_*` tool performs it. */
      readonly kind: 'tool';
      /** Registered tool name, e.g. `jj_status`. */
      readonly tool: string;
    }
  | {
      /** The shell is the supported path; the guard lets it through. */
      readonly kind: 'shell';
      /** Why the plugin does not wrap it (model-facing only when asked). */
      readonly note: string;
    }
  | {
      /** Refused by the guard, or reachable only through an ownership-checked tool. */
      readonly kind: 'blocked';
      /** Why it is restricted, and which tool is allowed to perform it. */
      readonly note: string;
    };

/**
 * Disposition of every jj subcommand in the guard's scope tables.
 *
 * Keys are the normalized subcommand spellings the guard produces, including the
 * two-word forms (`op log`, `workspace add`, `bookmark set`, `git fetch`, …).
 */
export const JJ_CAPABILITY_MATRIX: Readonly<Record<string, JjCapability>> = Object.freeze({
  // ── read-only inspection: tools cover the common ones, the shell covers the rest ──
  status: { kind: 'tool', tool: 'jj_status' },
  log: { kind: 'tool', tool: 'jj_log' },
  diff: { kind: 'tool', tool: 'jj_diff' },
  'op log': { kind: 'tool', tool: 'jj_op_log' },
  'bookmark list': { kind: 'tool', tool: 'jj_bookmark_list' },
  'workspace list': { kind: 'tool', tool: 'jj_workspace_list' },
  show: { kind: 'shell', note: 'read-only; jj_show is not needed while jj_diff and jj_log cover inspection' },
  evolog: { kind: 'shell', note: 'read-only history of one change; the shell output is what the model wants' },
  'op show': { kind: 'shell', note: 'read-only operation detail' },
  'op diff': { kind: 'shell', note: 'read-only operation diff' },
  'file list': { kind: 'shell', note: 'read-only path inventory' },
  'file show': { kind: 'shell', note: 'read-only file content at a revision' },
  'file search': { kind: 'shell', note: 'read-only content search' },
  'tag list': { kind: 'shell', note: 'read-only tag inventory' },
  'workspace root': { kind: 'shell', note: 'read-only; jj_workspace_list reports every root' },
  root: { kind: 'shell', note: 'read-only repository root' },
  version: { kind: 'shell', note: 'read-only CLI version' },
  debug: { kind: 'shell', note: 'read-only diagnostics' },
  help: { kind: 'shell', note: 'read-only documentation' },

  // ── history and working-copy writes ────────────────────────────────────────────
  new: { kind: 'tool', tool: 'jj_new' },
  commit: { kind: 'tool', tool: 'jj_commit' },
  describe: { kind: 'tool', tool: 'jj_describe' },
  squash: { kind: 'tool', tool: 'jj_squash' },
  rebase: { kind: 'tool', tool: 'jj_rebase' },
  abandon: { kind: 'tool', tool: 'jj_abandon' },
  undo: { kind: 'tool', tool: 'jj_undo' },
  'op restore': { kind: 'tool', tool: 'jj_op_restore' },
  redo: { kind: 'shell', note: 'repo-wide recovery verb the plugin does not model; the guard warns' },
  'op revert': { kind: 'shell', note: 'repo-wide recovery verb the plugin does not model; the guard warns' },
  'op abandon': { kind: 'shell', note: 'repo-wide recovery verb the plugin does not model; the guard warns' },
  restore: {
    kind: 'blocked',
    note: 'restoring paths discards uncommitted work; the guard hard-denies it, and no tool performs it',
  },
  edit: { kind: 'shell', note: 'moves the working copy to another revision; the shell form is exact' },
  next: { kind: 'shell', note: 'working-copy navigation' },
  prev: { kind: 'shell', note: 'working-copy navigation' },
  move: { kind: 'shell', note: 'working-copy navigation' },
  split: { kind: 'shell', note: 'interactive in jj; the shell owns the interaction' },
  absorb: { kind: 'shell', note: 'advanced rewrite; the shell form is the documented one' },
  duplicate: { kind: 'shell', note: 'advanced rewrite' },
  metaedit: { kind: 'shell', note: 'metadata rewrite beyond descriptions (jj_describe covers the common case)' },
  diffedit: { kind: 'shell', note: 'interactive editor session' },
  fix: { kind: 'shell', note: 'formatter round-trip owned by the user’s tooling' },
  resolve: { kind: 'shell', note: 'opens an external merge tool' },
  parallelize: { kind: 'shell', note: 'advanced graph rewrite' },
  'simplify-parents': { kind: 'shell', note: 'advanced graph rewrite' },
  'sparse set': { kind: 'shell', note: 'workspace-local sparse patterns' },
  'file track': { kind: 'shell', note: 'workspace-local ignore override' },
  'file untrack': { kind: 'shell', note: 'workspace-local ignore override' },
  config: { kind: 'shell', note: 'read or write jj configuration' },
  'util gc': { kind: 'shell', note: 'maintenance' },

  // ── bookmarks, tags, remotes ───────────────────────────────────────────────────
  'bookmark set': { kind: 'tool', tool: 'jj_bookmark_set' },
  'bookmark create': { kind: 'shell', note: 'jj_bookmark_set creates a bookmark too' },
  'bookmark delete': { kind: 'shell', note: 'no tool; deleting a bookmark is a plain pointer removal' },
  'tag set': { kind: 'shell', note: 'release-time operation the user drives' },
  'tag delete': { kind: 'shell', note: 'release-time operation the user drives' },
  'git fetch': { kind: 'tool', tool: 'jj_fetch' },
  'git push': { kind: 'shell', note: 'pushing stays a user action; dsh-jj never pushes on its own' },
  'git remote': { kind: 'shell', note: 'remote inspection/management' },

  // ── workspaces ─────────────────────────────────────────────────────────────────
  'workspace add': { kind: 'tool', tool: 'jj_workspace_add' },
  'workspace forget': {
    kind: 'blocked',
    note: 'only jj_workspace_cleanup may forget a workspace this session created (ownership-checked); the shell is hard-denied',
  },
  'workspace remove': {
    kind: 'blocked',
    note: 'deletes the workspace directory too and cannot be recovered; hard-denied in every mode',
  },
  'workspace rename': { kind: 'shell', note: 'repo-wide rename; the guard warns' },
});

/** Every subcommand string the guard's scope tables declare. */
export const JJ_KNOWN_SUBCOMMANDS: readonly string[] = Object.freeze(
  [...new Set([...JJ_REPO_WIDE_SUBCOMMANDS, ...JJ_WORKSPACE_LOCAL_SUBCOMMANDS, ...JJ_READ_ONLY_SUBCOMMANDS])].sort(),
);

/**
 * Name every registered tool the matrix relies on, for coverage checks.
 *
 * @returns the sorted tool names of every `tool` entry in {@link JJ_CAPABILITY_MATRIX}.
 */
export function capabilityToolNames(): string[] {
  return [
    ...new Set(
      Object.values(JJ_CAPABILITY_MATRIX)
        .filter((entry): entry is Extract<JjCapability, { kind: 'tool' }> => entry.kind === 'tool')
        .map((entry) => entry.tool),
    ),
  ].sort();
}
