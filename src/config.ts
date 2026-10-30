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
  // Multi-session policy (2026-10-30): when several top-level DSH sessions work in the
  // same jj project at the same time, the model is told to isolate in its own jj
  // workspace before writing and to rebase the finished stack onto `rebaseTarget`.
  // `auto` detects live sessions in this DSH process; `always` also covers separate
  // dsh processes (where in-process detection cannot see peers); `off` disables it.
  multiSessionGuidance: z.union(['auto', 'always', 'off']).default('auto'),
  // End-of-task rebase destination used by the multi-session guidance (jj revset).
  rebaseTarget: z.string().default('trunk()'),
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

/**
 * Plugin configuration accepted by `apply` (every key optional; defaults from {@link Config}).
 *
 * Derived from the schemastery schema so a new schema key cannot be forgotten here:
 * `Partial<ResolvedJjConfig>` is exactly the schema output with every field optional.
 */
export type JjPluginConfig = Partial<ResolvedJjConfig>;

/**
 * Configuration with every default applied.
 *
 * Derived from the schemastery schema (`Schemastery.TypeT`) instead of being written
 * out by hand, so the interface cannot drift from {@link Config}.
 */
export type ResolvedJjConfig = Schemastery.TypeT<typeof Config>;

/** Schema defaults: the single source of truth for every resolved default value. */
const SCHEMA_DEFAULTS: ResolvedJjConfig = Config({});

/** Hard upper bound accepted for timer-valued keys (mirrors DSH MAX_TIMER_DELAY_MS). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Which bundle row reads a configuration key. */
export type ConfigOwner = 'runtime' | 'tools' | 'guard';

/** Entry names printed in misplaced-config warnings (`dsh-jj` row names). */
export const CONFIG_OWNER_ENTRY: Readonly<Record<ConfigOwner, string>> = Object.freeze({
  runtime: 'jj-runtime',
  tools: 'jj-tools',
  guard: 'jj-guard',
});

/**
 * The bundle row that actually reads each configuration key.
 *
 * Every entry point re-exports the same {@link Config}, so Cordis accepts any key on
 * any row; only the listed row consumes it. The runtime row owns detection and the
 * session context, the tools row owns `jj_*` tool behaviour, and the guard row owns
 * the git-confusion policies. A key configured on the wrong row is silently ignored
 * by default, which is what {@link misplacedConfigKeys} surfaces.
 */
export const CONFIG_OWNERSHIP: Readonly<Record<keyof ResolvedJjConfig, ConfigOwner>> = Object.freeze({
  jjCommand: 'runtime',
  gitCommand: 'runtime',
  timeoutMs: 'runtime',
  graceMs: 'runtime',
  maxOutputBytes: 'runtime',
  detectCacheTtlMs: 'runtime',
  guardMutatingGit: 'guard',
  guardGitInJjNative: 'guard',
  guardJjRepositoryWide: 'guard',
  guardTools: 'guard',
  guardCreateWorktree: 'guard',
  readOnlyGitNotice: 'guard',
  preferJjContext: 'runtime',
  multiSessionGuidance: 'runtime',
  rebaseTarget: 'runtime',
  commitGuidance: 'runtime',
  commitStyle: 'runtime',
  commitStyleCustom: 'runtime',
  preferSplitCommits: 'runtime',
  commitStyleSampleLimit: 'runtime',
  defaultLogLimit: 'tools',
  maxLogLimit: 'tools',
  defaultCwd: 'tools',
});

/**
 * Keys a row was configured with but does not read.
 *
 * Only explicitly supplied keys count: an `undefined` value is never a configuration
 * mistake. The result is sorted so warnings and tests are deterministic.
 *
 * @param config - raw (partial) plugin config for one entry row.
 * @param owner - the row whose `apply` is validating the config.
 * @returns the misplaced keys, sorted.
 */
export function misplacedConfigKeys(config: JjPluginConfig, owner: ConfigOwner): (keyof ResolvedJjConfig)[] {
  const misplaced: (keyof ResolvedJjConfig)[] = [];
  for (const key of Object.keys(CONFIG_OWNERSHIP) as (keyof ResolvedJjConfig)[]) {
    if (config[key] === undefined) continue;
    if (CONFIG_OWNERSHIP[key] !== owner) misplaced.push(key);
  }
  return misplaced.sort();
}

/**
 * Warn once per key that belongs to another bundle row.
 *
 * Observability must never block startup: a missing, malformed, or throwing logger is
 * ignored. The text names both the key and the row that would read it.
 *
 * @param logger - host logger (usually `{ warn }`); anything else is a no-op.
 * @param config - raw (partial) plugin config for one entry row.
 * @param owner - the row whose `apply` is validating the config.
 */
export function warnMisplacedConfig(logger: unknown, config: JjPluginConfig, owner: ConfigOwner): void {
  const misplaced = misplacedConfigKeys(config, owner);
  if (misplaced.length === 0) return;
  const record = typeof logger === 'object' && logger !== null ? (logger as Record<string, unknown>) : undefined;
  const warn = record?.['warn'];
  if (typeof warn !== 'function') return;
  for (const key of misplaced) {
    const message =
      `dsh-jj: \`${key}\` belongs to the ${CONFIG_OWNER_ENTRY[CONFIG_OWNERSHIP[key]]} row; ` +
      `this row (${CONFIG_OWNER_ENTRY[owner]}) ignores it`;
    try {
      (warn as (message: string) => void).call(logger, message);
    } catch {
      // A failing logger must not break plugin startup.
    }
  }
}

/**
 * Apply contract defaults to a partial config.
 *
 * The defaults come from {@link Config}({}) and are only overridden by keys the caller
 * actually supplied, so `Config` and `resolveConfig` cannot drift. Values are not
 * validated here (the Cordis loader validates profiles; {@link assertServiceableConfig}
 * covers construction-time invariants), which keeps tolerant callers like tests working.
 *
 * @param config - partial plugin config (already schema-validated when loaded by Cordis).
 * @returns a fully populated configuration.
 */
export function resolveConfig(config: JjPluginConfig = {}): ResolvedJjConfig {
  const resolved: ResolvedJjConfig = { ...SCHEMA_DEFAULTS };
  const writable = resolved as Record<string, unknown>;
  for (const key of Object.keys(SCHEMA_DEFAULTS) as (keyof ResolvedJjConfig)[]) {
    const value = config[key];
    if (value !== undefined) writable[key] = value;
  }
  // Copy the array default so a caller can never mutate the shared schema default.
  resolved.guardTools = [...(config.guardTools ?? SCHEMA_DEFAULTS.guardTools)];
  return resolved;
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
  if (config.rebaseTarget.trim().length === 0) {
    throw new Error('dsh-jj: `rebaseTarget` must be a non-empty jj revset');
  }
  if (config.commitStyle === 'custom' && config.commitStyleCustom.trim().length === 0) {
    throw new Error("dsh-jj: `commitStyle: 'custom'` requires a non-empty `commitStyleCustom` with the style rules");
  }
  if (!Number.isSafeInteger(config.commitStyleSampleLimit) || config.commitStyleSampleLimit <= 0) {
    throw new Error('dsh-jj: `commitStyleSampleLimit` must be a positive safe integer');
  }
}