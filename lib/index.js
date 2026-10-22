/**
 * dsh-jj runtime entry (`dsh-jj` bundle row).
 *
 * The base layer owns repository detection, Git command classification, and the
 * git-confusion guard. The `ctx.jj` service (`name: 'jj'`) and the `jj_*` tools
 * land in the tools layer; this entry already assembles the guard so a profile
 * that installs only `dsh-jj` still gets protection, and it exports
 * {@link assembleBaseLayer} for tests that want the assembly without Cordis.
 *
 * @module dsh-jj
 */
import { assertServiceableConfig, Config, resolveConfig } from "./config.js";
import { installGitConfusionGuard } from "./guard.js";
import { installJjPromptContext } from "./prompt-context.js";
import { JjService } from "./service.js";
/** Cordis plugin name (bare package name so a bundle row can resolve it). */
export const name = 'jj';
/** Services required before `apply` runs (the tools layer adds `tools`-dependent work). */
export const inject = ['subprocess', 'workingDirectory'];
export { Config };
/**
 * Build the guard host view from a live Cordis context (keeps the `tools.guard`
 * check real).
 *
 * Returns `undefined` when this profile did not mount a tool registry: reading an
 * unavailable service through the Cordis proxy can throw, and a profile that only
 * installs `dsh-jj` must still boot. The caller then installs no guard instead of
 * failing the profile.
 */
function guardHostFrom(ctx) {
    let tools;
    try {
        tools = ctx.tools;
    }
    catch {
        tools = undefined;
    }
    if (typeof tools?.guard !== 'function')
        return undefined;
    const view = ctx;
    const rawOn = view.on;
    return {
        tools: tools,
        ...(typeof rawOn === 'function'
            ? {
                on: (event, listener) => rawOn.call(ctx, event, listener),
            }
            : {}),
        ...(view.logger !== undefined ? { logger: view.logger } : {}),
        ...(view.emit !== undefined ? { emit: view.emit } : {}),
        ...(view.workingDirectory !== undefined ? { workingDirectory: view.workingDirectory } : {}),
    };
}
/** Best-effort warning when the guard cannot be installed. */
function warnMissingTools(ctx) {
    try {
        const logger = ctx.logger;
        logger?.warn?.('dsh-jj: the tools service is unavailable; the git-confusion guard was not installed.');
    }
    catch {
        // Logging must never break plugin startup.
    }
}
/**
 * Assemble the base layer (configuration validation plus the git-confusion guard).
 *
 * @param ctx - live Cordis context.
 * @param config - partial plugin configuration.
 * @returns the guard handle (also callable as its own disposer), or `undefined`
 *   when the profile mounted no tool registry.
 */
export function assembleBaseLayer(ctx, config = {}) {
    const resolved = resolveConfig(config);
    assertServiceableConfig(resolved);
    const host = guardHostFrom(ctx);
    if (host === undefined) {
        warnMissingTools(ctx);
        return undefined;
    }
    const service = ctx.jj;
    return installGitConfusionGuard(host, { config, ...(service !== undefined ? { service } : {}) });
}
/**
 * Install the plugin on a Cordis context.
 *
 * @param ctx - live context providing `subprocess`, `workingDirectory`, and `tools`.
 * @param config - partial plugin configuration; every key is optional.
 */
export function apply(ctx, config = {}) {
    // Entry one (`dsh-jj`) owns the service and detection; the tools and guard
    // entries consume `ctx.jj` (contract §4.1b). Registering the service here is
    // what makes `inject: ['tools','jj']` loadable for the other two rows.
    const resolved = resolveConfig(config);
    assertServiceableConfig(resolved);
    new JjService(ctx, config);
    // Session-start preference (policy 2026-10-22): the model is told, in its own prompt,
    // that this workspace is a jj one and that jj is preferred. Registered globally with a
    // provider reading `AssembleContext.agent` — the pattern DSH's own
    // `dsh-working-directory` uses — so one registration covers every agent and model.
    const get = ctx.get;
    const promptContext = resolved.preferJjContext
        ? installJjPromptContext({ get: typeof get === 'function' ? get.bind(ctx) : undefined }, {
            peek: (cwd) => {
                try {
                    const service = get?.call(ctx, 'jj');
                    return service?.peek?.(cwd);
                }
                catch {
                    return undefined;
                }
            },
        })
        : () => { };
    const effect = ctx.effect;
    if (typeof effect === 'function')
        effect.call(ctx, () => () => promptContext(), 'dsh-jj: jj prompt context');
}
export { JjService, JjOperations, TPL_STATUS, TPL_LOG, TPL_OP_LOG, TPL_BOOKMARK_LIST, TPL_WORKSPACE_LIST_TAB } from "./service.js";
export { JjError, classifyJjFailure, createCommandRunGit, createCommandRunJj, createRunGit, createRunJj, jjErrorMessage, jjNonInteractiveEnv } from "./jj-command.js";
export { jjRefusalText, jjToolDefinitions, registerJjTools } from "./tools.js";
export { describeVcsKind } from "./types.js";
export { installJjPromptContext, jjPreferenceContextText, JJ_CONTEXT_NAME, JJ_CONTEXT_ORDER_FALLBACK, } from "./prompt-context.js";
export { detectVcs, sniffVcsSync, parseWorkspaceList, parseRemoteList, DEFAULT_PROBE_TIMEOUT_MS, GIT_PROBE_ENV, JJ_PROBE_ENV, TPL_WORKSPACE_LIST, } from "./detect.js";
export { classifyGitInvocation, gitEquivalence, hasMutatingGitInvocation, GIT_SUBCOMMAND_RULES, JJ_EQUIVALENCE } from "./git-command.js";
export { buildGitRefusalMessage, buildWorktreeToolRefusalMessage, evaluateGitCommand, gitConfusionWhy, installGitConfusionGuard, } from "./guard.js";
export { MAX_TIMER_DELAY_MS, assertServiceableConfig, resolveConfig } from "./config.js";
