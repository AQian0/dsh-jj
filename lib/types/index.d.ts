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
import type { Context } from '@deepseek-ai/cordis';
import { Config, type JjPluginConfig } from './config.ts';
import { type GitConfusionGuardHandle } from './guard.ts';
/** Cordis plugin name (bare package name so a bundle row can resolve it). */
export declare const name = "jj";
/** Services required before `apply` runs (the tools layer adds `tools`-dependent work). */
export declare const inject: readonly ["subprocess", "workingDirectory"];
export { Config };
export type { JjPluginConfig };
/**
 * Assemble the base layer (configuration validation plus the git-confusion guard).
 *
 * @param ctx - live Cordis context.
 * @param config - partial plugin configuration.
 * @returns the guard handle (also callable as its own disposer), or `undefined`
 *   when the profile mounted no tool registry.
 */
export declare function assembleBaseLayer(ctx: Context, config?: JjPluginConfig): GitConfusionGuardHandle | undefined;
/**
 * Install the plugin on a Cordis context.
 *
 * @param ctx - live context providing `subprocess`, `workingDirectory`, and `tools`.
 * @param config - partial plugin configuration; every key is optional.
 */
export declare function apply(ctx: Context, config?: JjPluginConfig): void;
export { JjService, JjOperations, TPL_STATUS, TPL_LOG, TPL_OP_LOG, TPL_BOOKMARK_LIST, TPL_WORKSPACE_LIST_TAB } from './service.ts';
export { JjError, classifyJjFailure, createCommandRunGit, createCommandRunJj, createRunGit, createRunJj, jjErrorMessage, jjNonInteractiveEnv } from './jj-command.ts';
export { jjRefusalText, jjToolDefinitions, registerJjTools } from './tools.ts';
export { describeVcsKind } from './types.ts';
export { installJjPromptContext, jjPreferenceContextText, JJ_CONTEXT_NAME, JJ_CONTEXT_ORDER_FALLBACK, } from './prompt-context.ts';
export { detectVcs, sniffVcsSync, parseWorkspaceList, parseRemoteList, DEFAULT_PROBE_TIMEOUT_MS, GIT_PROBE_ENV, JJ_PROBE_ENV, TPL_WORKSPACE_LIST, } from './detect.ts';
export { classifyGitInvocation, gitEquivalence, hasMutatingGitInvocation, GIT_SUBCOMMAND_RULES, JJ_EQUIVALENCE } from './git-command.ts';
export { buildGitRefusalMessage, buildWorktreeToolRefusalMessage, evaluateGitCommand, gitConfusionWhy, installGitConfusionGuard, } from './guard.ts';
export { MAX_TIMER_DELAY_MS, assertServiceableConfig, resolveConfig } from './config.ts';
export type { DetectionConfidence, DetectDeps, DetectInput, JjRemote, JjRunResult, JjWorkspaceInfo, RunCommand, RunCommandOptions, RunJj, RunJjOptions, RunResult, VcsDescriptor, VcsEvidenceSource, VcsKind, VcsNotice, VcsNoticeCode, VcsSniff, } from './types.ts';
export type { DetectVcsOptions, JjWorkspaceEntry, SniffOptions } from './detect.ts';
export type { GitCommandClassification, GitInvocation, GitSafety, GitSafetySubtype, ParsedSegment } from './git-command.ts';
export type { EvaluateGitCommandOptions, GitCommandEvaluation, GitConfusionGuardHandle, GitConfusionGuardWarning, GitGuardFinding, GuardDescriptorLike, GuardExecutionLike, GuardOptions, GuardServiceLike, ToolGuardHost, } from './guard.ts';
export type { ResolvedJjConfig } from './config.ts';
export type { JjChange, JjOperation } from './types.ts';
export type { JjErrorCode } from './jj-command.ts';
export type { JjStatusResult, JjUndoResult, JjWorkspaceAddResult } from './service.ts';
export type { JjToolService, JjToolsHost } from './tools.ts';
