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
import { sniffVcsSync } from "./detect.js";
/** Prompt-context name (unique in its scope; a duplicate registration throws). */
export const JJ_CONTEXT_NAME = 'dsh-jj-workspace';
/** Fallback placement when the host cannot resolve the canonical order. */
export const JJ_CONTEXT_ORDER_FALLBACK = 100;
/** Model-facing preference text for one jj workspace. */
export function jjPreferenceContextText(kind, root, workspaceName) {
    const place = `${kind}: ${root}${workspaceName !== undefined ? ` (workspace "${workspaceName}")` : ''}`;
    return [
        `This session's working directory is a Jujutsu (jj) workspace (${place}).`,
        'Prefer jj for version control here: use the jj_* tools and jj-native commands (jj status / log / diff / new / describe / squash / undo / op log / bookmark / workspace) and address revisions with revsets and change ids rather than git branch names.',
        "Git still works, but a git write is not recorded in jj's operation log (so `jj undo` cannot take it back) and jj re-imports the result afterwards. Prefer `jj describe` / `jj new` / `jj commit` over `git commit`, and `jj bookmark` over `git branch`.",
    ].join('\n');
}
/**
 * Install the global jj preference prompt context.
 *
 * @param host - context exposing `get` (used for `workingDirectory` and `systemPrompt`).
 * @param options - optional cached peek, injectable sniff, and forced order.
 * @returns the disposer that unregisters the context (idempotent, never throws).
 */
export function installJjPromptContext(host, options = {}) {
    const systemPrompt = host.get?.('systemPrompt');
    if (typeof systemPrompt?.context !== 'function')
        return () => { };
    const order = options.order ??
        (typeof systemPrompt.getContextOrder === 'function'
            ? systemPrompt.getContextOrder('WORKING_DIRECTORY')
            : JJ_CONTEXT_ORDER_FALLBACK);
    const textForAgent = (agent) => {
        if (agent === undefined)
            return '';
        try {
            const workingDirectory = host.get?.('workingDirectory');
            if (typeof workingDirectory?.get !== 'function')
                return '';
            const cwd = workingDirectory.get(agent.session);
            if (typeof cwd !== 'string' || cwd.length === 0)
                return '';
            const peeked = options.peek?.(cwd);
            if (peeked !== undefined) {
                return peeked.kind.startsWith('jj-') ? jjPreferenceContextText(peeked.kind, peeked.root, peeked.workspaceName) : '';
            }
            const sniffed = (options.sniff ?? sniffVcsSync)(cwd);
            if (!sniffed.kind.startsWith('jj-'))
                return '';
            // VcsSniff carries the marker roots rather than one `root`; the jj workspace wins.
            return jjPreferenceContextText(sniffed.kind, sniffed.jjRoot ?? sniffed.cwd, sniffed.workspaceName);
        }
        catch {
            // A prompt contribution must never break an assembly.
            return '';
        }
    };
    let disposed = false;
    try {
        const unregister = systemPrompt.context({
            name: JJ_CONTEXT_NAME,
            order,
            // Optional context: dropped when a deployment disables runtime-context snapshots.
            required: false,
            // Literal text: never interpolate `{{…}}` that a repository path could contain.
            interpolate: false,
            text: (context) => textForAgent(context?.agent),
        });
        return () => {
            if (disposed)
                return;
            disposed = true;
            if (typeof unregister === 'function') {
                try {
                    unregister();
                }
                catch {
                    // Teardown must not throw.
                }
            }
        };
    }
    catch {
        // Duplicate registration or an incompatible host: the notice is optional.
        return () => { };
    }
}
