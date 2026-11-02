/**
 * Git-subcommand jj replacement text and the rule shapes shared by the Git
 * classification table (design contract §8.3 / §8.6).
 *
 * Pure module: no I/O, no subprocess, no `@deepseek-ai/*` imports.
 *
 * @module dsh-jj/git-equivalence
 */

/** Classification of one Git invocation. */
export type GitSafety = 'read' | 'mutate' | 'unknown';

/** Finer-grained class kept for messaging and tests (base-layer extra). */
export type GitSafetySubtype = 'read-only' | 'index' | 'worktree' | 'mutating' | 'unknown';

/** Classification of one invocation; what the rule table and `refine` produce. */
export interface RuleResult {
  readonly safety: GitSafety;
  readonly subtype?: GitSafetySubtype;
  readonly reason: string;
  /** jj replacement text (contract §8.6 lines are preferred). */
  readonly equivalence?: string;
}

/** One row of the Git subcommand table. */
export interface SubcommandRule extends RuleResult {
  /** `contextual` rules must be resolved by `refine`. */
  readonly contextual?: boolean;
  /**
   * Resolve the row for one argument list. Returning `undefined` keeps the row's
   * own classification, so a rule only has to describe its exceptions.
   */
  readonly refine?: (context: RefineContext) => RuleResult | undefined;
}

/** Parsed argument list a `refine` decision may look at. */
export interface RefineContext {
  readonly flags: readonly string[];
  readonly positionals: readonly string[];
}

/** jj replacement lines (contract §8.3 / §8.6), verbatim where the contract fixes the wording. */
export const JJ_EQUIVALENCE = Object.freeze({
  commit: 'jj commit -m "…"      (or: jj describe -m "…" then jj new)',
  checkout: 'jj new <rev>          (or: jj edit <rev> to edit that change in place)',
  switchCreate: 'jj new -m "…" then jj bookmark create <name> -r @',
  resetHard: 'jj edit <rev>         (or: jj op restore <op-id>)',
  reset: 'jj undo               (jj has no index to reset)',
  restore: 'jj restore <path>',
  stash: 'jj new                (jj keeps your changes; no stash needed)',
  merge: 'jj new @ <rev>        (a merge is just a change with two parents)',
  rebase: 'jj rebase -r @ -d <dest>',
  cherryPick: 'jj duplicate <rev>    (or: jj rebase -r <rev> -d <dest>)',
  worktreeAdd: 'jj workspace add <path>',
  worktreeList: 'jj workspace list',
  worktreeRemove:
    'jj_workspace_cleanup for a temporary workspace this session created with jj_workspace_add; otherwise the user runs `jj workspace forget <name>`',
  branchCreate: 'jj bookmark create <name> -r @',
  branchForce: 'jj bookmark set <name> -r <r> --allow-backwards',
  bookmark: 'jj bookmark create/set/delete <name> -r <revset>',
  push: 'jj git push -b <bookmark>',
  fetch: 'jj git fetch',
  pull: 'jj git fetch && jj rebase -d <bookmark>@origin',
  gc: 'jj util gc',
  revert: 'jj revert -r <revset>',
  historyEdit: 'jj undo / jj op restore <op-id> / jj edit <revset>',
  conflict: 'jj restore / jj resolve / jj fix',
  remote: 'jj git remote add/remove/rename/set-url',
  submoduleLimited: 'jj has limited submodule support; prefer jj-native commands such as `jj git fetch`',
  store: 'jj util gc (jj understands its own reachability; git gc does not)',
  noEquivalent:
    '(no single jj equivalent; inspect with jj_log / jj_status first, then use jj_new, jj_describe, jj_squash, jj_rebase, jj_undo, jj_workspace_* as appropriate)',
});

/** A `read` classification: used for read-only rows and for `refine` exceptions. */
export function readRule(reason = 'read-only Git subcommand'): RuleResult {
  return { safety: 'read', subtype: 'read-only', reason, equivalence: '' };
}

/** A `mutate` classification: used for rows and for `refine` exceptions. */
export function mutateRule(reason: string, equivalence?: string): RuleResult {
  return { safety: 'mutate', subtype: 'mutating', reason, ...(equivalence !== undefined ? { equivalence } : {}) };
}
