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
import type { VcsKind } from './types.ts';
// Type-only: loads the `@deepseek-ai/dsh-tools` module augmentation that adds `ctx.tools`.
import type {} from '@deepseek-ai/dsh-tools';
import { assertServiceableConfig, Config, resolveConfig, type JjPluginConfig } from './config.ts';
import { installGitConfusionGuard, type GitConfusionGuardHandle, type GuardServiceLike, type ToolGuardHost } from './guard.ts';
import { installJjPromptContext } from './prompt-context.ts';
import { JjService } from './service.ts';

/** Cordis plugin name (bare package name so a bundle row can resolve it). */
export const name = 'jj';

/** Services required before `apply` runs (the tools layer adds `tools`-dependent work). */
export const inject = ['subprocess', 'workingDirectory'] as const;

export { Config };
export type { JjPluginConfig };

/**
 * Build the guard host view from a live Cordis context (keeps the `tools.guard`
 * check real).
 *
 * Returns `undefined` when this profile did not mount a tool registry: reading an
 * unavailable service through the Cordis proxy can throw, and a profile that only
 * installs `dsh-jj` must still boot. The caller then installs no guard instead of
 * failing the profile.
 */
function guardHostFrom(ctx: Context): ToolGuardHost | undefined {
  let tools: unknown;
  try {
    tools = (ctx as unknown as { tools?: unknown }).tools;
  } catch {
    tools = undefined;
  }
  if (typeof (tools as { guard?: unknown } | undefined)?.guard !== 'function') return undefined;
  const view = ctx as unknown as {
    on?: (...args: unknown[]) => unknown;
    logger?: unknown;
    emit?: unknown;
    workingDirectory?: unknown;
  };
  const rawOn = view.on;
  return {
    tools: tools as ToolGuardHost['tools'],
    ...(typeof rawOn === 'function'
      ? {
          on: (event: string, listener: (...args: unknown[]) => unknown) => rawOn.call(ctx, event, listener),
        }
      : {}),
    ...(view.logger !== undefined ? { logger: view.logger } : {}),
    ...(view.emit !== undefined ? { emit: view.emit } : {}),
    ...(view.workingDirectory !== undefined ? { workingDirectory: view.workingDirectory } : {}),
  };
}

/** Best-effort warning when the guard cannot be installed. */
function warnMissingTools(ctx: Context): void {
  try {
    const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger;
    logger?.warn?.('dsh-jj: the tools service is unavailable; the git-confusion guard was not installed.');
  } catch {
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
export function assembleBaseLayer(ctx: Context, config: JjPluginConfig = {}): GitConfusionGuardHandle | undefined {
  const resolved = resolveConfig(config);
  assertServiceableConfig(resolved);
  const host = guardHostFrom(ctx);
  if (host === undefined) {
    warnMissingTools(ctx);
    return undefined;
  }
  const service = (ctx as unknown as { jj?: GuardServiceLike }).jj;
  return installGitConfusionGuard(host, { config, ...(service !== undefined ? { service } : {}) });
}

/**
 * Install the plugin on a Cordis context.
 *
 * @param ctx - live context providing `subprocess`, `workingDirectory`, and `tools`.
 * @param config - partial plugin configuration; every key is optional.
 */
export function apply(ctx: Context, config: JjPluginConfig = {}): void {
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
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get;
  const promptContext = resolved.preferJjContext
    ? installJjPromptContext(
        { get: typeof get === 'function' ? get.bind(ctx) : undefined },
        {
          peek: (cwd) => {
            try {
              const service = get?.call(ctx, 'jj') as
                | { peek?: (cwd: string) => { kind: VcsKind; root: string; workspaceName?: string } | undefined }
                | undefined;
              return service?.peek?.(cwd);
            } catch {
              return undefined;
            }
          },
          // Commit-description handling (policy 2026-10-30): inherit the repository's
          // description style by default, ask the user when history cannot decide, and
          // prefer a stack of small commits; a configured preset/custom style wins.
          commitGuidance: resolved.commitGuidance,
          commitStyle: resolved.commitStyle,
          commitStyleCustom: resolved.commitStyleCustom,
          preferSplitCommits: resolved.preferSplitCommits,
        },
      )
    : () => {};
  const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
  if (typeof effect === 'function') effect.call(ctx, () => () => promptContext(), 'dsh-jj: jj prompt context');
}

export { JjService, JjOperations, TPL_STATUS, TPL_LOG, TPL_DESCRIPTION, TPL_OP_LOG, TPL_BOOKMARK_LIST, TPL_WORKSPACE_LIST_TAB } from './service.ts';
export { JjError, classifyJjFailure, createCommandRunGit, createCommandRunJj, createRunGit, createRunJj, jjErrorMessage, jjNonInteractiveEnv } from './jj-command.ts';
export { jjRefusalText, jjToolDefinitions, registerJjTools } from './tools.ts';
export { describeVcsKind } from './types.ts';
export {
  installJjPromptContext,
  jjPreferenceContextText,
  JJ_CONTEXT_NAME,
  JJ_CONTEXT_ORDER_FALLBACK,
} from './prompt-context.ts';
export {
  COMMIT_STYLE_CHOICES,
  COMMIT_STYLE_DOMINANCE,
  COMMIT_STYLE_IDS,
  COMMIT_STYLE_PRESETS,
  CONCRETE_COMMIT_STYLE_IDS,
  MIN_COMMIT_STYLE_SAMPLES,
  SPLIT_COMMITS_GUIDANCE,
  classifyDescriptionStyle,
  commitStylePromptText,
  detectCommitStyle,
  firstDescriptionLine,
  resolveCommitStylePolicy,
} from './commit-style.ts';
export {
  detectVcs,
  sniffVcsSync,
  parseWorkspaceList,
  parseRemoteList,
  DEFAULT_PROBE_TIMEOUT_MS,
  GIT_PROBE_ENV,
  JJ_PROBE_ENV,
  TPL_WORKSPACE_LIST,
} from './detect.ts';
export { classifyGitInvocation, gitEquivalence, hasMutatingGitInvocation, GIT_SUBCOMMAND_RULES, JJ_EQUIVALENCE } from './git-command.ts';
export {
  buildGitRefusalMessage,
  buildWorktreeToolRefusalMessage,
  evaluateGitCommand,
  gitConfusionWhy,
  installGitConfusionGuard,
} from './guard.ts';
export { MAX_TIMER_DELAY_MS, assertServiceableConfig, resolveConfig } from './config.ts';

export type {
  DetectionConfidence,
  DetectDeps,
  DetectInput,
  JjRemote,
  JjRunResult,
  JjWorkspaceInfo,
  RunCommand,
  RunCommandOptions,
  RunJj,
  RunJjOptions,
  RunResult,
  VcsDescriptor,
  VcsEvidenceSource,
  VcsKind,
  VcsNotice,
  VcsNoticeCode,
  VcsSniff,
} from './types.ts';
export type { DetectVcsOptions, JjWorkspaceEntry, SniffOptions } from './detect.ts';
export type { GitCommandClassification, GitInvocation, GitSafety, GitSafetySubtype, ParsedSegment } from './git-command.ts';
export type {
  EvaluateGitCommandOptions,
  GitCommandEvaluation,
  GitConfusionGuardHandle,
  GitConfusionGuardWarning,
  GitGuardFinding,
  GuardDescriptorLike,
  GuardExecutionLike,
  GuardOptions,
  GuardServiceLike,
  ToolGuardHost,
} from './guard.ts';
export type { ResolvedJjConfig } from './config.ts';
export type {
  CommitStyleChoice,
  CommitStyleConfidence,
  CommitStyleCounts,
  CommitStyleDetection,
  CommitStyleDetectionKind,
  CommitStyleFamily,
  CommitStyleId,
  CommitStylePolicy,
  CommitStylePreset,
  CommitStylePromptOptions,
  CommitStyleSource,
  ConcreteCommitStyleId,
  ResolveCommitStyleOptions,
} from './commit-style.ts';
export type { JjPromptCommitOptions, JjPromptContextOptions } from './prompt-context.ts';
export type { JjChange, JjOperation } from './types.ts';
export type { JjErrorCode } from './jj-command.ts';
export type { JjCommitResult, JjStatusResult, JjUndoResult, JjWorkspaceAddResult } from './service.ts';
export type { JjToolService, JjToolsHost } from './tools.ts';