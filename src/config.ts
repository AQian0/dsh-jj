/**
 * Plugin configuration and its defaults (design contract §5.2).
 *
 * Every entry point (`dsh-jj`, `dsh-jj/tools`, `dsh-jj/guard`) re-exports the
 * same schemastery `Config`, so an invalid profile config is rejected by the
 * Cordis loader before `apply` runs.
 *
 * @module dsh-jj/config
 */

import z from '@deepseek-ai/schemastery';
import type { CommitStyleId } from './commit-style.ts';

/** Cordis config schema for every dsh-jj entry point. */
export const Config = z.object({
  jjCommand: z.string().default('jj'),
  gitCommand: z.string().default('git'),
  timeoutMs: z.natural().default(30_000),
  graceMs: z.natural().default(3_000),
  maxOutputBytes: z.natural().default(262_144),
  detectCacheTtlMs: z.natural().default(10_000),
  // Policy (2026-10-22): a jj workspace PREFERS jj, it does not forbid git. When .jj and
  // .git coexist (colocated) a mutating git command runs and the model gets a preference
  // notice appended to the tool result; set 'deny' to make dsh-jj block it instead.
  guardMutatingGit: z.union(['deny', 'warn', 'off']).default('warn'),
  // Same preference policy: jj-native has no root .git, so git either fails or inspects an
  // unrelated parent repository — noticed, not blocked; 'deny' remains available.
  guardGitInJjNative: z.union(['warn', 'deny', 'off']).default('warn'),
  guardJjRepositoryWide: z.union(['warn', 'deny', 'off']).default('warn'),
  guardTools: z.array(z.string()).default(['bash', 'pwsh', 'terminal_send']),
  guardCreateWorktree: z.boolean().default(true),
  readOnlyGitNotice: z.boolean().default(true),
  // Session-start model-visible context: 'this is a jj workspace, prefer jj'.
  preferJjContext: z.boolean().default(true),
  // Commit-description policy (2026-10-30): by default inherit the style of the
  // repository's recent jj/Git descriptions; when history cannot decide, the model
  // asks the user (Conventional Commits / Angular / Gitmoji / plain / custom).
  // `custom` requires the rules in `commitStyleCustom`.
  commitGuidance: z.boolean().default(true),
  commitStyle: z.union(['auto', 'conventional', 'angular', 'gitmoji', 'plain', 'custom']).default('auto'),
  commitStyleCustom: z.string().default(''),
  // Prefer a stack of small, self-contained commits over one growing @ change.
  preferSplitCommits: z.boolean().default(true),
  // How many recent descriptions jj_commit_style samples (also bounds its process output).
  commitStyleSampleLimit: z.natural().default(30),
  defaultLogLimit: z.natural().default(30),
  maxLogLimit: z.natural().default(200),
  defaultCwd: z.string().default(''),
});

/** Plugin configuration accepted by `apply` (every key optional; defaults from {@link Config}). */
export interface JjPluginConfig {
  readonly jjCommand?: string;
  readonly gitCommand?: string;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
  readonly maxOutputBytes?: number;
  readonly detectCacheTtlMs?: number;
  readonly guardMutatingGit?: 'deny' | 'warn' | 'off';
  readonly guardGitInJjNative?: 'warn' | 'deny' | 'off';
  /** Treatment of repository-wide jj commands (`jj undo`, `jj op restore`, …) in shell tools (default warn). */
  readonly guardJjRepositoryWide?: 'warn' | 'deny' | 'off';
  readonly guardTools?: readonly string[];
  readonly guardCreateWorktree?: boolean;
  readonly readOnlyGitNotice?: boolean;
  readonly preferJjContext?: boolean;
  /** Inject the commit-description style and split-commit guidance into the model context (default true). */
  readonly commitGuidance?: boolean;
  /** Commit-description style: inherit history (`auto`), a preset, or `custom` (default auto). */
  readonly commitStyle?: CommitStyleId;
  /** Rules for `commitStyle: 'custom'` (required in that case); ignored for other styles. */
  readonly commitStyleCustom?: string;
  /** Tell the model to advance through small, self-contained commits (default true). */
  readonly preferSplitCommits?: boolean;
  /** Number of recent descriptions `jj_commit_style` samples (default 30). */
  readonly commitStyleSampleLimit?: number;
  readonly defaultLogLimit?: number;
  readonly maxLogLimit?: number;
  readonly defaultCwd?: string;
}

/** Configuration with every default applied. */
export interface ResolvedJjConfig {
  readonly jjCommand: string;
  readonly gitCommand: string;
  readonly timeoutMs: number;
  readonly graceMs: number;
  readonly maxOutputBytes: number;
  readonly detectCacheTtlMs: number;
  readonly guardMutatingGit: 'deny' | 'warn' | 'off';
  readonly guardGitInJjNative: 'warn' | 'deny' | 'off';
  readonly guardJjRepositoryWide: 'warn' | 'deny' | 'off';
  readonly guardTools: readonly string[];
  readonly guardCreateWorktree: boolean;
  readonly readOnlyGitNotice: boolean;
  readonly preferJjContext: boolean;
  readonly commitGuidance: boolean;
  readonly commitStyle: CommitStyleId;
  readonly commitStyleCustom: string;
  readonly preferSplitCommits: boolean;
  readonly commitStyleSampleLimit: number;
  readonly defaultLogLimit: number;
  readonly maxLogLimit: number;
  readonly defaultCwd: string;
}

/** Hard upper bound accepted for timer-valued keys (mirrors DSH MAX_TIMER_DELAY_MS). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Apply contract defaults to a partial config.
 *
 * @param config - partial plugin config (already schema-validated when loaded by Cordis).
 * @returns a fully populated configuration.
 */
export function resolveConfig(config: JjPluginConfig = {}): ResolvedJjConfig {
  return {
    jjCommand: config.jjCommand ?? 'jj',
    gitCommand: config.gitCommand ?? 'git',
    timeoutMs: config.timeoutMs ?? 30_000,
    graceMs: config.graceMs ?? 3_000,
    maxOutputBytes: config.maxOutputBytes ?? 262_144,
    detectCacheTtlMs: config.detectCacheTtlMs ?? 10_000,
    // Keep these two in lockstep with the Config schema defaults above: a jj workspace
    // prefers jj and does not forbid git (policy 2026-10-22).
    guardMutatingGit: config.guardMutatingGit ?? 'warn',
    guardGitInJjNative: config.guardGitInJjNative ?? 'warn',
    guardJjRepositoryWide: config.guardJjRepositoryWide ?? 'warn',
    guardTools: config.guardTools ?? ['bash', 'pwsh', 'terminal_send'],
    guardCreateWorktree: config.guardCreateWorktree ?? true,
    readOnlyGitNotice: config.readOnlyGitNotice ?? true,
    preferJjContext: config.preferJjContext ?? true,
    // Commit-description policy (2026-10-30): inherit history, ask when undecidable,
    // allow presets/custom config. Keep in lockstep with the Config schema above.
    commitGuidance: config.commitGuidance ?? true,
    commitStyle: config.commitStyle ?? 'auto',
    commitStyleCustom: config.commitStyleCustom ?? '',
    preferSplitCommits: config.preferSplitCommits ?? true,
    commitStyleSampleLimit: config.commitStyleSampleLimit ?? 30,
    defaultLogLimit: config.defaultLogLimit ?? 30,
    maxLogLimit: config.maxLogLimit ?? 200,
    defaultCwd: config.defaultCwd ?? '',
  };
}

/**
 * Construction-time validation (contract §5.2 MUST): non-empty commands and
 * positive finite timing values.
 *
 * @param config - resolved configuration.
 * @throws Error naming the offending key.
 */
export function assertServiceableConfig(config: ResolvedJjConfig): void {
  if (config.jjCommand.trim().length === 0) throw new Error('dsh-jj: `jjCommand` must not be empty');
  if (config.gitCommand.trim().length === 0) throw new Error('dsh-jj: `gitCommand` must not be empty');
  for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes', 'detectCacheTtlMs'] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-jj: \`${key}\` must be a positive safe integer, received ${String(value)}`);
    }
    if (value > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-jj: \`${key}\` must be <= ${MAX_TIMER_DELAY_MS}, received ${String(value)}`);
    }
  }
  if (!Number.isSafeInteger(config.defaultLogLimit) || config.defaultLogLimit <= 0) {
    throw new Error('dsh-jj: `defaultLogLimit` must be a positive safe integer');
  }
  if (!Number.isSafeInteger(config.maxLogLimit) || config.maxLogLimit < config.defaultLogLimit) {
    throw new Error('dsh-jj: `maxLogLimit` must be a safe integer >= defaultLogLimit');
  }
  if (config.commitStyle === 'custom' && config.commitStyleCustom.trim().length === 0) {
    throw new Error("dsh-jj: `commitStyle: 'custom'` requires a non-empty `commitStyleCustom` with the style rules");
  }
  if (!Number.isSafeInteger(config.commitStyleSampleLimit) || config.commitStyleSampleLimit <= 0) {
    throw new Error('dsh-jj: `commitStyleSampleLimit` must be a positive safe integer');
  }
}