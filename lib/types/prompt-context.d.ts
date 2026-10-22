/**
 * Session-start jj preference context (model-facing).
 *
 * Policy (2026-10-22): a jj workspace PREFERS jj — it does not forbid git. The guard's
 * post-execute notice only helps *after* a model already chose git, so this module puts
 * the preference into the model's own prompt from the first assembly.
 *
 * Shape follows DSH's own repository-fact precedent, `@deepseek-ai/dsh-working-directory`:
 * one **global** `ctx.systemPrompt.context(...)` whose text provider reads
 * `context.agent` (augmented onto `AssembleContext` by `@deepseek-ai/dsh-agent`) and
 * resolves that agent's session directory. One registration therefore covers every agent,
 * every provider, and every model in the profile — subagents included.
 *
 * The provider is synchronous (context text cannot await), which is enough here because
 * both inputs are synchronous: `WorkingDirectoryService.get(session)` and the filesystem
 * sniff. The warmed `ctx.jj` cache is consulted first when it already has an answer.
 * Outside a jj workspace the provider returns `''`, which contributes nothing.
 *
 * @module dsh-jj/prompt-context
 */
import type { VcsKind, VcsSniff } from './types.ts';
/** Prompt-context name (unique in its scope; a duplicate registration throws). */
export declare const JJ_CONTEXT_NAME = "dsh-jj-workspace";
/** Fallback placement when the host cannot resolve the canonical order. */
export declare const JJ_CONTEXT_ORDER_FALLBACK = 100;
/** Minimal view of a Cordis context: only inject-free accessors are used. */
export interface JjPromptHost {
    readonly get?: (name: string, strict?: boolean) => unknown;
}
/** The provider's view of the agent for one assembly (`AssembleContext.agent`). */
export interface JjPromptAgent {
    readonly session?: unknown;
}
/** Options for {@link installJjPromptContext}. */
export interface JjPromptContextOptions {
    /** Sync cached lookup (`ctx.jj.peek`) — consulted before the sniff. */
    readonly peek?: (cwd: string) => {
        kind: VcsKind;
        root: string;
        workspaceName?: string;
    } | undefined;
    /** Injectable sniff for tests. */
    readonly sniff?: (cwd: string) => VcsSniff;
    /** Force a numeric order instead of the canonical `WORKING_DIRECTORY` slot. */
    readonly order?: number;
}
/** Model-facing preference text for one jj workspace. */
export declare function jjPreferenceContextText(kind: VcsKind, root: string, workspaceName?: string): string;
/**
 * Install the global jj preference prompt context.
 *
 * @param host - context exposing `get` (used for `workingDirectory` and `systemPrompt`).
 * @param options - optional cached peek, injectable sniff, and forced order.
 * @returns the disposer that unregisters the context (idempotent, never throws).
 */
export declare function installJjPromptContext(host: JjPromptHost, options?: JjPromptContextOptions): () => void;
