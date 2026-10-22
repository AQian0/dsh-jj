/**
 * Pure, table-driven recognizer for Git invocations inside shell command lines
 * (design contract §8.2 / §8.3).
 *
 * Safety classes:
 * - `read`    — inspects the repository; allowed inside a jj workspace.
 * - `mutate`  — changes refs, HEAD, the index, the working copy, or shared
 *               storage; refused inside a jj workspace by the guard.
 * - `unknown` — unrecognized subcommand, no subcommand, or unparsable input.
 *               **Never** treated as `mutate` (no misjudgement).
 *
 * Rules:
 * - No I/O, no subprocess, no environment access: a pure function over a string.
 * - Table-driven; the only per-command logic is for `contextual` subcommands,
 *   which need flag/subcommand inspection.
 * - An unterminated quote or trailing escape yields zero invocations, because the
 *   shell itself would reject the line before running anything.
 *
 * Known limitations (documented in README): Git aliases, shell functions and
 * wrapper scripts are configuration/state dependent and cannot be resolved here;
 * heredoc bodies are scanned line-wise but a heredoc's structure is not modelled.
 *
 * @module dsh-jj/git-command
 */
/** Classification of one Git invocation. */
export type GitSafety = 'read' | 'mutate' | 'unknown';
/** Finer-grained class kept for messaging and tests (base-layer extra). */
export type GitSafetySubtype = 'read-only' | 'index' | 'worktree' | 'mutating' | 'unknown';
/** One Git invocation found in a shell command line. */
export interface GitInvocation {
    /** Normalized Git argv (program plus its arguments; leading wrappers stripped). */
    readonly argv: readonly string[];
    /** Raw shell segment this invocation was found in (base-layer extra). */
    readonly raw: string;
    /** The Git program token as written (`git`, `git.exe`, `/usr/bin/git`, …). */
    readonly program: string;
    /** Git subcommand, or `null` when Git was invoked without one. */
    readonly subcommand: string | null;
    readonly safety: GitSafety;
    /** True iff `safety === 'mutate'`. */
    readonly mutating: boolean;
    readonly confidence: 'high' | 'low';
    /** Why this classification, e.g. ``subcommand `commit` is in the mutate table``. */
    readonly reason: string;
    /** Leading global options that change cwd/repo, in order (for example `['-C','sub']`). */
    readonly globalOptions: readonly string[];
    /** jj replacement text shown in refusals; `''` when none is known. */
    readonly equivalence: string;
    /** Base-layer extras: finer class, `-C`, `--git-dir`, `--work-tree`. */
    readonly subtype: GitSafetySubtype;
    readonly changeDir?: string;
    readonly gitDir?: string;
    readonly workTree?: string;
}
/** One shell segment (a command between `;`, `&&`, `||`, `|`, `&`, `(`, `)`, or a newline). */
export interface ParsedSegment {
    readonly raw: string;
    /** `substitution` marks the inner text of `$(…)` or `` `…` ``. */
    readonly kind: 'command' | 'substitution';
    readonly words: readonly string[];
    /** False when the segment contained an unterminated quote or a trailing escape. */
    readonly parsed: boolean;
    /** Target of a leading `cd <path>` in this segment. */
    readonly cdTarget?: string;
    /** Indexes into {@link GitCommandClassification.invocations}. */
    readonly invocationIndexes: readonly number[];
}
/** Result of {@link classifyGitInvocation}. */
export interface GitCommandClassification {
    readonly invocations: readonly GitInvocation[];
    /** Segments in command-line order; the guard follows `cd` changes through them. */
    readonly segments: readonly ParsedSegment[];
    /** Non-fatal parse defects, in English. */
    readonly warnings: readonly string[];
}
interface RuleResult {
    readonly safety: GitSafety;
    readonly subtype?: GitSafetySubtype;
    readonly reason: string;
    /** jj replacement text (contract §8.6 lines are preferred). */
    readonly equivalence?: string;
}
interface SubcommandRule {
    /** `contextual` rules must be resolved by `refine`. */
    readonly contextual?: boolean;
    readonly safety: GitSafety;
    readonly subtype?: GitSafetySubtype;
    readonly reason: string;
    readonly equivalence?: string;
    readonly refine?: (context: RefineContext) => RuleResult;
}
interface RefineContext {
    readonly args: readonly string[];
    readonly flags: readonly string[];
    readonly positionals: readonly string[];
}
/** jj replacement lines (contract §8.3 / §8.6), verbatim where the contract fixes the wording. */
export declare const JJ_EQUIVALENCE: Readonly<{
    commit: "jj commit -m \"…\"      (or: jj describe -m \"…\" then jj new)";
    checkout: "jj new <rev>          (or: jj edit <rev> to edit that change in place)";
    switchCreate: "jj new -m \"…\" then jj bookmark create <name> -r @";
    resetHard: "jj edit <rev>         (or: jj op restore <op-id>)";
    reset: "jj undo               (jj has no index to reset)";
    restore: "jj restore <path>";
    stash: "jj new                (jj keeps your changes; no stash needed)";
    merge: "jj new @ <rev>        (a merge is just a change with two parents)";
    rebase: "jj rebase -r @ -d <dest>";
    cherryPick: "jj duplicate <rev>    (or: jj rebase -r <rev> -d <dest>)";
    worktreeAdd: "jj workspace add <path>";
    worktreeList: "jj workspace list";
    worktreeRemove: "jj workspace forget <name>";
    branchCreate: "jj bookmark create <name> -r @";
    branchForce: "jj bookmark set <name> -r <r> --allow-backwards";
    bookmark: "jj bookmark create/set/delete <name> -r <revset>";
    push: "jj git push -b <bookmark>";
    fetch: "jj git fetch";
    pull: "jj git fetch && jj rebase -d <bookmark>@origin";
    gc: "jj util gc";
    revert: "jj revert -r <revset>";
    historyEdit: "jj undo / jj op restore <op-id> / jj edit <revset>";
    conflict: "jj restore / jj resolve / jj fix";
    remote: "jj git remote add/remove/rename/set-url";
    submoduleLimited: "jj has limited submodule support; prefer jj-native commands such as `jj git fetch`";
    store: "jj util gc (jj understands its own reachability; git gc does not)";
    noEquivalent: "(no single jj equivalent; inspect with jj_log / jj_status first, then use jj_new, jj_describe, jj_squash, jj_rebase, jj_undo, jj_workspace_* as appropriate)";
}>;
/**
 * Classification table (contract §8.3). Keys are Git subcommands; `contextual`
 * entries resolve through `refine`.
 */
export declare const GIT_SUBCOMMAND_RULES: Readonly<Record<string, SubcommandRule>>;
/**
 * Recognize Git invocations in a shell command line.
 *
 * @param commandLine - the raw shell command string (as the model wrote it).
 * @returns recognized invocations in order, the parsed segments, and parse warnings.
 */
export declare function classifyGitInvocation(commandLine: string): GitCommandClassification;
/**
 * jj replacement text for a denied invocation (contract §8.2).
 *
 * @param invocation - a classified invocation.
 * @returns the §8.6/§8.3 equivalence line, or `''` when no single equivalent is known.
 */
export declare function gitEquivalence(invocation: GitInvocation): string;
/** True when the classification contains at least one mutating Git invocation. */
export declare function hasMutatingGitInvocation(classification: GitCommandClassification): boolean;
/** Scope of one jj invocation. */
export type JjScope = 'repo-wide' | 'workspace-local' | 'read-only' | 'scope-creep' | 'destructive' | 'unknown';
/** One jj invocation found in a shell command line. */
export interface JjInvocation {
    readonly argv: readonly string[];
    readonly raw: string;
    /** Normalized subcommand, e.g. `undo`, `op restore`, `workspace forget`. */
    readonly subcommand: string;
    readonly scope: JjScope;
    readonly globalOptions: readonly string[];
    /** `-R`/`--repository` target, when given. */
    readonly repository?: string;
    /** `--at-op`/`--at-operation` value, when given (read-only replay). */
    readonly atOp?: string;
    /** Argument of `jj workspace forget <name>`. */
    readonly targetWorkspace?: string;
    /** True for `jj undo --allow-cross-workspace` (hard-deny per contract §8.3b). */
    readonly allowCrossWorkspace?: boolean;
    /** Non-flag arguments after the subcommand (used for `abandon @` / `restore` pathspecs). */
    readonly positionals?: readonly string[];
    readonly confidence: 'high' | 'low';
    readonly reason: string;
}
/** Result of {@link classifyJjInvocation}. */
export interface JjCommandClassification {
    readonly invocations: readonly JjInvocation[];
    readonly warnings: readonly string[];
}
/** jj subcommands whose scope is repository-wide (contract §8.3b). */
export declare const JJ_REPO_WIDE_SUBCOMMANDS: readonly string[];
/** jj subcommands that only touch the current workspace (never blocked). */
export declare const JJ_WORKSPACE_LOCAL_SUBCOMMANDS: readonly string[];
/** jj subcommands that never write the repository. */
export declare const JJ_READ_ONLY_SUBCOMMANDS: readonly string[];
/**
 * Recognize jj invocations in a shell command line (contract §8.3b).
 *
 * @param commandLine - raw shell command string.
 * @returns jj invocations with their scope, plus parse warnings.
 */
export declare function classifyJjInvocation(commandLine: string): JjCommandClassification;
export {};
