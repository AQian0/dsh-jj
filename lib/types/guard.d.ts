/**
 * Git-confusion guard (design contract §8).
 *
 * Why: jj and Git keep different models of the same repository
 * (working-copy-as-a-commit vs index + HEAD, change ids vs SHAs, operation log
 * vs reflog, first-class conflicts vs merge state). A mutating Git command inside
 * a jj workspace silently desynchronises `jj status`/`jj log` from reality, and
 * jj-side destructive commands have repository-wide blast radius.
 *
 * Architecture (contract §8.1): the tool guard is **synchronous**, while
 * detection needs subprocesses. So:
 * - **warm-up**: a `tools/pre-execute` waterfall listener resolves the call's cwd
 *   and awaits `service.warm(cwd)` (and precomputes the decision) before guards run;
 * - **decision**: `ctx.tools.guard(...)` reads the precomputed decision, or falls
 *   back to the synchronous filesystem sniff when nothing was precomputed
 *   (standalone use, or the warm-up listener failing — fail-open).
 *
 * @module dsh-jj/guard
 */
import { Config, type JjPluginConfig, type ResolvedJjConfig } from './config.ts';
export { Config };
import { type GitCommandClassification, type GitInvocation, type JjInvocation } from './git-command.ts';
import type { VcsDescriptor, VcsKind } from './types.ts';
/** Structural view of the tool execution the guard inspects. */
export interface GuardExecutionLike {
    readonly name: string;
    readonly arguments?: unknown;
    readonly agent?: unknown;
    readonly callId?: unknown;
    readonly signal?: unknown;
}
/** Structural view of the jj service the guard uses for warm/peek. */
export interface GuardServiceLike {
    /** Synchronous cache lookup (contract §6.4). */
    peek(cwd: string): VcsDescriptor | undefined;
    /** Refreshes the cache for `cwd` (contract §6.4). */
    warm(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor | void> | VcsDescriptor | void;
    /** Optional: head operation id used by repo-wide warnings (contract §8.3b self-protection). */
    operations?: {
        headOperationId(cwd: string, signal?: AbortSignal): Promise<string>;
    };
}
/** Structural view of the Cordis context the guard needs. */
export interface ToolGuardHost {
    readonly tools: {
        guard(guard: (execution: GuardExecutionLike) => string | undefined): () => void;
    };
    /**
     * Optional: registers the guard's waterfall listeners.
     *
     * The same `on` carries both `tools/pre-execute` (warm-up + decision) and
     * `tools/post-execute` (append the jj-preference notice to an allowed git write).
     * Typed loosely because the two events have different listener shapes.
     */
    readonly on?: (event: string, listener: (...args: any[]) => unknown) => unknown;
    /** Optional: Cordis logger service (or a plain `{ warn }` object in tests). */
    readonly logger?: unknown;
    /** Optional: Cordis emit function (feature-detected; used for warn-mode events). */
    readonly emit?: unknown;
    /** Optional: working-directory service with a synchronous `get`. */
    readonly workingDirectory?: unknown;
}
/** Options for {@link installGitConfusionGuard} (contract §8.1). */
export interface GuardOptions {
    readonly service?: GuardServiceLike;
    readonly config?: JjPluginConfig;
    /** Explicit warm function, when the caller does not pass a full service. */
    readonly warm?: (cwd: string, signal?: AbortSignal) => Promise<void> | void;
}
/** One warn-mode observation. */
export interface GitConfusionGuardWarning {
    readonly at: number;
    readonly tool: string;
    readonly commandLine: string;
    readonly subcommand: string | null;
    readonly cwd: string;
    readonly root: string;
    readonly kind: VcsKind;
    readonly message: string;
}
/** One mutating Git invocation found inside a jj workspace. */
export interface GitGuardFinding {
    readonly invocation: GitInvocation;
    /** Directory the invocation would actually run in (after `cd`/`-C`). */
    readonly cwd: string;
    readonly root: string;
    readonly kind: VcsKind;
    readonly workspaceName?: string;
    /** Model-facing refusal text. */
    readonly message: string;
}
/** Options for {@link evaluateGitCommand}. */
export interface EvaluateGitCommandOptions {
    /** Injectable sniff (tests simulate layouts without touching the disk). */
    readonly sniff?: (cwd: string) => GuardDescriptorLike;
}
/** Minimal descriptor view the guard needs (full descriptor or sniff fallback). */
export interface GuardDescriptorLike {
    readonly kind: VcsKind;
    readonly jjRoot: string | undefined;
    readonly root: string;
    readonly workspaceName?: string | undefined;
}
/** Result of {@link evaluateGitCommand}. */
export interface GitCommandEvaluation {
    readonly classification: GitCommandClassification;
    readonly findings: readonly GitGuardFinding[];
    /** Effective directory per invocation index (parallel to `classification.invocations`). */
    readonly effectiveCwds: readonly string[];
}
/** Handle returned by {@link installGitConfusionGuard}: callable as the disposer, with test hooks. */
export type GitConfusionGuardHandle = (() => void) & {
    readonly dispose: () => void;
    readonly config: ResolvedJjConfig;
    readonly check: (execution: GuardExecutionLike) => string | undefined;
    readonly warnings: () => readonly GitConfusionGuardWarning[];
    readonly clearWarnings: () => void;
    /** Synchronous descriptor lookup used by the decision (service cache, else sniff). */
    readonly peek: (cwd: string) => GuardDescriptorLike | undefined;
};
/** Reason text for one kind (contract §8.5, verbatim). */
export declare function gitConfusionWhy(kind: VcsKind): string;
/**
 * Model-facing refusal text for one mutating Git invocation (contract §8.5).
 *
 * @param invocation - the classified Git invocation.
 * @param descriptor - descriptor of the effective directory (jj kind).
 * @returns the refusal text.
 */
export declare function buildGitRefusalMessage(invocation: GitInvocation, descriptor: GuardDescriptorLike): string;
/**
 * Model-facing preference notice for a git write that was **allowed** in a jj workspace.
 *
 * Policy: a jj workspace prefers jj, it does not forbid git. Mutating git commands run
 * (warn mode) and this notice is appended to the tool result so the model learns the
 * preference from the outcome instead of being blocked. The text stays short: it must
 * read as guidance next to the command's own output.
 */
export declare function buildGitPreferenceNotice(invocation: GitInvocation, descriptor: GuardDescriptorLike): string;
/** Model-facing refusal text for `create_worktree` (contract §8.7, verbatim structure). */
export declare function buildWorktreeToolRefusalMessage(toolName: string, descriptor: GuardDescriptorLike): string;
/**
 * Refusal text for a repository-wide jj command (contract §8.3b, verbatim).
 *
 * @param invocation - the classified jj invocation.
 * @param descriptor - descriptor of the effective directory.
 * @param cwd - the directory the command would start in.
 * @returns the refusal text.
 */
export declare function buildJjRepoWideRefusal(invocation: JjInvocation, descriptor: GuardDescriptorLike, cwd: string): string;
/**
 * Hard-deny text for jj commands that discard working-copy content with no
 * explicit target (contract §8.3b; never short-circuited by config).
 *
 * @param invocation - the classified jj invocation.
 * @param descriptor - descriptor of the effective directory.
 * @returns the refusal text.
 */
export declare function buildJjHardDenyRefusal(invocation: JjInvocation, _descriptor: GuardDescriptorLike): string;
/** One-time warning text for a repository-wide jj command (contract §8.3b, verbatim). */
export declare function buildJjRepoWideWarning(invocation: JjInvocation, descriptor: GuardDescriptorLike, headOperationId?: string): string;
/**
 * Find mutating Git invocations that would run inside a jj workspace.
 *
 * Pure with respect to the repository: classifies the command line, follows
 * `cd`/`-C` to compute each invocation's effective directory, and sniffs that
 * directory. It never executes anything.
 *
 * @param commandLine - shell command line as written by the model.
 * @param baseCwd - directory the shell starts in.
 * @param options - injectable sniff for tests.
 * @returns classification, per-invocation effective cwd, and findings.
 */
export declare function evaluateGitCommand(commandLine: string, baseCwd: string, options?: EvaluateGitCommandOptions): GitCommandEvaluation;
/**
 * Install the git-confusion guard (and, when the host supports it, the async
 * warm-up listener) on a Cordis context.
 *
 * @param host - context exposing `tools.guard`; `on`, `logger`, `emit`, and
 *   `workingDirectory` are used opportunistically when present.
 * @param options - either a bare {@link JjPluginConfig} (standalone use) or
 *   {@link GuardOptions} with the jj service.
 * @returns a disposer function that also exposes `check`, `warnings`, and `config`.
 */
export declare function installGitConfusionGuard(host: ToolGuardHost, options?: JjPluginConfig | GuardOptions): GitConfusionGuardHandle;
/** Cordis plugin name for the guard entry. */
export declare const name = "jj-guard";
/** Services required by the guard entry (`jj` is the service from the runtime entry). */
export declare const inject: readonly ["tools", "jj"];
/**
 * Install the guard entry on a Cordis context.
 *
 * @param ctx - context providing `tools` (plus optional `logger`/`emit`/`workingDirectory`).
 * @param config - partial plugin configuration.
 */
export declare function apply(ctx: ToolGuardHost & {
    effect?: (body: () => () => void, label?: string) => unknown;
    jj?: GuardServiceLike;
    logger?: unknown;
    emit?: unknown;
    workingDirectory?: unknown;
    on?: (...args: unknown[]) => unknown;
}, config?: JjPluginConfig): void;
