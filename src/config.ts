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

/**
 * Structural equality for the scalar/array configuration values this schema allows.
 *
 * Values are strings, numbers, booleans, and arrays of strings, so a shallow
 * recursive comparison is enough and no dependency is needed. Plain `Object.is`
 * covers scalars; arrays are compared element by element.
 */
function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameConfigValue(value, right[index]));
  }
  return false;
}

/**
 * Whether the caller explicitly configured `key`.
 *
 * Cordis validates every row's config with {@link Config} before `apply` runs
 * (`ctx.plugin(...)` → `Fiber` → schemastery standard-schema validation), so
 * `apply` receives the schema-normalized config with every default already
 * filled in. An `undefined` check therefore cannot tell "explicitly configured"
 * from "schema default": a value equal to the schema default is treated as not
 * configured.
 *
 * Known limitation: a user who explicitly writes the default value (for example
 * `commitStyle: 'auto'` on the wrong row) gets no misplacement warning. The
 * effective value is the intended one either way, so only a diagnostic is lost.
 *
 * @param config - raw (partial) plugin config for one entry row.
 * @param key - configuration key from {@link CONFIG_OWNERSHIP}.
 */
function isExplicitlyConfigured(config: JjPluginConfig, key: keyof ResolvedJjConfig): boolean {
  const value = config[key];
  if (value === undefined) return false;
  return !sameConfigValue(value, SCHEMA_DEFAULTS[key]);
}

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
 * Bundle rows that also read a key whose documented primary owner is another row.
 *
 * {@link CONFIG_OWNERSHIP} keeps exactly one primary row per key (that is what the
 * README documents and what the "belongs to …" warning names). Keys consumed by more
 * than one row list the additional rows here so putting the key on any reading row is
 * not reported as a mistake. `defaultCwd` is read by the tools row (`cwdFor`) and by
 * the guard row (its agent-less cwd fallback), so it is valid on either row.
 */
export const CONFIG_SHARED_OWNERSHIP: Readonly<Partial<Record<keyof ResolvedJjConfig, readonly ConfigOwner[]>>> =
  Object.freeze({
    defaultCwd: Object.freeze(['tools', 'guard'] as const),
  });

/**
 * Every bundle row that reads one configuration key, primary owner first.
 *
 * @param key - configuration key from {@link CONFIG_OWNERSHIP}.
 * @returns the reading rows (never empty; the primary owner is always first).
 */
export function configKeyOwners(key: keyof ResolvedJjConfig): readonly ConfigOwner[] {
  return CONFIG_SHARED_OWNERSHIP[key] ?? [CONFIG_OWNERSHIP[key]];
}

/**
 * Keys a row was configured with but does not read.
 *
 * "Configured" means explicitly supplied by the user, not merely present after
 * Cordis applied the schema defaults: see {@link isExplicitlyConfigured} for the
 * default-value heuristic and its one limitation. Keys read by more than one row
 * are matched through {@link configKeyOwners}. The result is sorted so warnings
 * and tests are deterministic.
 *
 * @param config - raw (partial) plugin config for one entry row.
 * @param owner - the row whose `apply` is validating the config.
 * @returns the misplaced keys, sorted.
 */
export function misplacedConfigKeys(config: JjPluginConfig, owner: ConfigOwner): (keyof ResolvedJjConfig)[] {
  const misplaced: (keyof ResolvedJjConfig)[] = [];
  for (const key of Object.keys(CONFIG_OWNERSHIP) as (keyof ResolvedJjConfig)[]) {
    if (!isExplicitlyConfigured(config, key)) continue;
    if (!configKeyOwners(key).includes(owner)) misplaced.push(key);
  }
  return misplaced.sort();
}

/**
 * Keys present in a row config that dsh-jj does not define.
 *
 * schemastery keeps unknown keys in the validated config (it does not close the
 * object) and {@link resolveConfig} then ignores them, so a misspelled key would
 * otherwise be dropped without feedback. Sorted for deterministic warnings.
 *
 * @param config - raw (partial) plugin config for one entry row.
 * @returns unknown keys with a non-`undefined` value, sorted.
 */
export function unknownConfigKeys(config: JjPluginConfig): string[] {
  const known = new Set<string>(Object.keys(CONFIG_OWNERSHIP));
  const record = config as Record<string, unknown>;
  return Object.keys(record)
    .filter((key) => !known.has(key) && record[key] !== undefined)
    .sort();
}

/**
 * Extract the `warn` method from a host logger.
 *
 * Cordis's `ctx.logger` is a **callable** object (`typeof logger === 'function'`,
 * created by `createCallable`), while tests and embedders pass plain `{ warn }`
 * objects. Accept both shapes; anything without a callable `warn` is ignored.
 *
 * @param logger - host logger of either shape.
 * @returns a bound one-argument warning sink, or `undefined`.
 */
function loggerWarn(logger: unknown): ((message: string) => void) | undefined {
  if (logger === null || (typeof logger !== 'object' && typeof logger !== 'function')) return undefined;
  const warn = (logger as { warn?: unknown }).warn;
  if (typeof warn !== 'function') return undefined;
  return (message: string) => (warn as (message: string) => void).call(logger, message);
}

/**
 * Emit one warning through an already-extracted sink.
 *
 * Observability must never block startup: a throwing logger is contained.
 */
function emitWarning(warn: (message: string) => void, message: string): void {
  try {
    warn(message);
  } catch {
    // A failing logger must not break plugin startup.
  }
}

/** Model-facing row list for a warning ("the jj-guard row" / "the jj-tools / jj-guard rows"). */
function ownerRowsText(owners: readonly ConfigOwner[]): string {
  const rows = owners.map((owner) => CONFIG_OWNER_ENTRY[owner]);
  return rows.length === 1 ? `the ${rows[0]} row` : `the ${rows.join(' / ')} rows`;
}

/**
 * Warn once per key that belongs to another bundle row, and once per unknown key.
 *
 * Observability must never block startup: a missing, malformed, or throwing logger is
 * ignored, and a callable Cordis logger is supported. The text names both the key and
 * the row(s) that would read it.
 *
 * @param logger - host logger (plain `{ warn }` object or callable `ctx.logger`); anything else is a no-op.
 * @param config - raw (partial) plugin config for one entry row.
 * @param owner - the row whose `apply` is validating the config.
 */
export function warnMisplacedConfig(logger: unknown, config: JjPluginConfig, owner: ConfigOwner): void {
  const warn = loggerWarn(logger);
  if (warn === undefined) return;
  const self = CONFIG_OWNER_ENTRY[owner];
  for (const key of misplacedConfigKeys(config, owner)) {
    emitWarning(
      warn,
      `dsh-jj: \`${key}\` belongs to ${ownerRowsText(configKeyOwners(key))}; this row (${self}) ignores it`,
    );
  }
  for (const key of unknownConfigKeys(config)) {
    emitWarning(warn, `dsh-jj: \`${key}\` is not a known dsh-jj configuration key; this row (${self}) ignores it`);
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
