/**
 * Plugin configuration: the union schema, the per-row scoped schemas derived from it,
 * and the ownership table that decides which bundle row reads each key.
 *
 * Every bundle row validates its own config with its own scoped schema
 * ({@link configSchemaFor}), so a key placed on the wrong row is visible instead of
 * silently ignored. {@link assertScopedConfig} turns such a placement into a
 * construction-time error that names the row the key belongs to.
 *
 * @module dsh-jj/config
 */

import z from '@deepseek-ai/schemastery';

/** How the `jj-changes` row serves the Host's `workspaceChanges` service. */
export const WORKSPACE_CHANGES_MODES = ['auto', 'builtin', 'off'] as const;
export type WorkspaceChangesMode = (typeof WORKSPACE_CHANGES_MODES)[number];

/**
 * The union configuration schema.
 *
 * This is the only place a key and its default are declared: the per-row schemas are
 * projections of this object, and {@link CONFIG_OWNERSHIP} is derived from
 * {@link ROW_CONFIG_KEYS}. `resolveConfig` reads the same defaults.
 */
export const Config = z.object({
  // ── process ────────────────────────────────────────────────────────────────
  jjCommand: z.string().default('jj'),
  gitCommand: z.string().default('git'),
  timeoutMs: z.natural().default(30_000),
  graceMs: z.natural().default(3_000),
  maxOutputBytes: z.natural().default(262_144),
  // ── detection ──────────────────────────────────────────────────────────────
  detectCacheTtlMs: z.natural().default(10_000),
  // ── git-confusion guard (jj-guard row) ─────────────────────────────────────
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
  // ── session context (jj-runtime row) ───────────────────────────────────────
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
  // Correction policy (2026-11-02): a correction to a commit made earlier in this
  // session is folded into that commit (jj_amend) while it is still unpushed.
  // Setting this to false only drops that guidance; jj_amend stays available.
  preferAmendCorrections: z.boolean().default(true),
  // How many recent descriptions jj_commit_style samples (also bounds its process output).
  commitStyleSampleLimit: z.natural().default(30),
  // Web panel: 'auto' shows the Jujutsu tab and serves its read-only routes when the
  // Host has a connection service; 'off' keeps the routes disabled (headless use).
  uiPanel: z.union(['auto', 'off']).default('auto'),
  // ── tools row ──────────────────────────────────────────────────────────────
  defaultLogLimit: z.natural().default(30),
  maxLogLimit: z.natural().default(200),
  // Shared: read by `cwdFor` (tools) and by the guard's agent-less fallback.
  defaultCwd: z.string().default(''),
  // ── changes row (`jj-changes`) ─────────────────────────────────────────────
  /**
   * Serving strategy: `auto` (jj data for jj Sessions, built-in recorder otherwise,
   * merged), `builtin` (built-in recorder only) or `off` (no card data).
   */
  workspaceChanges: z.union([...WORKSPACE_CHANGES_MODES]).default('auto'),
  /** Maximum files one summary carries; `total` still reports the complete count. */
  maxFiles: z.natural().default(500),
  /** Largest per-file diff the comparison view serves; a larger change is refused as oversized. */
  maxFileBytes: z.natural().default(2 * 1024 * 1024),
  /** Bytes of `jj diff` output retained per turn; a larger diff abandons that turn's record. */
  outputMaxBytes: z.natural().default(8 * 1024 * 1024),
  /** Milliseconds the built-in recorder's line comparison may run before it degrades. */
  diffTimeoutMs: z.natural().default(100),
});

/** One bundle row that owns configuration keys. */
export type ConfigOwner = 'runtime' | 'tools' | 'guard' | 'changes';

/** Entry names printed in errors and documentation (`dsh-jj` row names). */
export const CONFIG_OWNER_ENTRY: Readonly<Record<ConfigOwner, string>> = Object.freeze({
  runtime: 'jj-runtime',
  tools: 'jj-tools',
  guard: 'jj-guard',
  changes: 'jj-changes',
});

/**
 * The keys each row reads, in ownership order.
 *
 * This is the single ownership declaration: {@link CONFIG_OWNERSHIP},
 * {@link configKeyOwners}, {@link misplacedConfigKeys} and the per-row schemas are all
 * derived from it, so a key cannot be documented as belonging to one row and validated
 * by another. `defaultCwd` is deliberately listed by both rows that read it; every
 * other key appears exactly once.
 */
export const ROW_CONFIG_KEYS: Readonly<Record<ConfigOwner, readonly (keyof ResolvedJjConfig)[]>> = Object.freeze({
  runtime: Object.freeze([
    'jjCommand',
    'gitCommand',
    'timeoutMs',
    'graceMs',
    'maxOutputBytes',
    'detectCacheTtlMs',
    'preferJjContext',
    'multiSessionGuidance',
    'rebaseTarget',
    'commitGuidance',
    'commitStyle',
    'commitStyleCustom',
    'preferSplitCommits',
    'preferAmendCorrections',
    'commitStyleSampleLimit',
    'uiPanel',
  ] as const),
  tools: Object.freeze(['defaultLogLimit', 'maxLogLimit', 'defaultCwd'] as const),
  guard: Object.freeze([
    'guardMutatingGit',
    'guardGitInJjNative',
    'guardJjRepositoryWide',
    'guardTools',
    'guardCreateWorktree',
    'readOnlyGitNotice',
    'defaultCwd',
  ] as const),
  changes: Object.freeze(['workspaceChanges', 'maxFiles', 'maxFileBytes', 'outputMaxBytes', 'diffTimeoutMs'] as const),
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

/** The union schema's fields (an object schema always carries its dict). */
const CONFIG_FIELDS = Config.dict ?? {};

/** Every declared configuration key, in schema order. */
const ALL_CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as (keyof ResolvedJjConfig)[];

/**
 * Validate that {@link ROW_CONFIG_KEYS} is a partition of the schema's keys.
 *
 * Runs at module load: a key added to {@link Config} without an owning row (or a row
 * naming a key the schema does not declare) is a programming error, not a runtime
 * condition, so it must fail where it is introduced instead of surfacing as a silently
 * ignored setting.
 */
function assertOwnershipCoversSchema(): void {
  const declared = new Set<string>();
  for (const [owner, keys] of Object.entries(ROW_CONFIG_KEYS) as [ConfigOwner, readonly string[]][]) {
    for (const key of keys) {
      if (!(key in CONFIG_FIELDS)) {
        throw new Error(`dsh-jj: ${CONFIG_OWNER_ENTRY[owner]} declares unknown configuration key \`${key}\``);
      }
      declared.add(key);
    }
  }
  for (const key of ALL_CONFIG_KEYS) {
    if (!declared.has(key)) {
      throw new Error(
        `dsh-jj: configuration key \`${key}\` has no owning row; add it to ROW_CONFIG_KEYS so the row ` +
          'that reads it validates it and the other rows reject it',
      );
    }
  }
}

assertOwnershipCoversSchema();

/** Schema defaults: the single source of truth for every resolved default value. */
const SCHEMA_DEFAULTS: ResolvedJjConfig = Config({});

/** Hard upper bound accepted for timer-valued keys (mirrors DSH MAX_TIMER_DELAY_MS). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Every bundle row that reads one configuration key, primary owner first.
 *
 * Derived from {@link ROW_CONFIG_KEYS}: the first row listing the key is the documented
 * primary owner (the one the README table and the error messages name).
 *
 * @param key - any declared configuration key.
 * @returns the reading rows (never empty).
 */
export function configKeyOwners(key: keyof ResolvedJjConfig): readonly ConfigOwner[] {
  const owners = (Object.keys(ROW_CONFIG_KEYS) as ConfigOwner[]).filter((owner) =>
    ROW_CONFIG_KEYS[owner].includes(key),
  );
  if (owners.length === 0) throw new Error(`dsh-jj: configuration key \`${key}\` has no owning row`);
  return owners;
}

/**
 * The bundle row that is documented as reading each configuration key.
 *
 * Derived from {@link ROW_CONFIG_KEYS} so the README table, the error messages and the
 * per-row schemas cannot disagree.
 */
export const CONFIG_OWNERSHIP: Readonly<Record<keyof ResolvedJjConfig, ConfigOwner>> = Object.freeze(
  Object.fromEntries(ALL_CONFIG_KEYS.map((key) => [key, configKeyOwners(key)[0]])) as Record<
    keyof ResolvedJjConfig,
    ConfigOwner
  >,
);

/**
 * Keys read by more than one row, primary owner first.
 *
 * Only `defaultCwd` is shared today: the tools row resolves the session directory with
 * it and the guard row uses the same fallback for agent-less calls.
 */
export const CONFIG_SHARED_OWNERSHIP: Readonly<Partial<Record<keyof ResolvedJjConfig, readonly ConfigOwner[]>>> =
  Object.freeze(
    Object.fromEntries(
      ALL_CONFIG_KEYS.map((key) => [key, configKeyOwners(key)]).filter(([, owners]) => owners.length > 1),
    ) as Partial<Record<keyof ResolvedJjConfig, readonly ConfigOwner[]>>,
  );

/**
 * Build the scoped object schema of one row.
 *
 * @param owner - bundle row whose keys are projected out of {@link Config}.
 * @returns the schemastery object schema declaring exactly that row's keys.
 */
function buildRowSchema(owner: ConfigOwner) {
  const fields = Object.fromEntries(ROW_CONFIG_KEYS[owner].map((key) => [key, CONFIG_FIELDS[key]]));
  return z.object(fields);
}

/** The type of one row's scoped configuration schema. */
export type RowConfigSchema = ReturnType<typeof buildRowSchema>;

/** Cached per-row schemas, built on first use and reused by every caller. */
const ROW_SCHEMAS = new Map<ConfigOwner, RowConfigSchema>();

/**
 * The scoped configuration schema of one bundle row.
 *
 * A row validates exactly the keys it reads: {@link ROW_CONFIG_KEYS} selects the fields
 * out of the union {@link Config}, so the schema a Cordis row sees (and that a profile
 * editor displays) cannot imply ownership of another row's keys. Unknown keys are still
 * carried through by schemastery, which is what makes {@link assertScopedConfig} able to
 * name a misplaced key instead of dropping it silently.
 *
 * @param owner - the bundle row whose schema is requested.
 * @returns the schemastery schema for that row (cached).
 */
export function configSchemaFor(owner: ConfigOwner): RowConfigSchema {
  const cached = ROW_SCHEMAS.get(owner);
  if (cached !== undefined) return cached;
  const schema = buildRowSchema(owner);
  ROW_SCHEMAS.set(owner, schema);
  return schema;
}

/**
 * Keys a row was configured with but does not read.
 *
 * The row's scoped schema only fills defaults for the keys it owns, so any other
 * declared key present in the config object was written explicitly by the user — even
 * when its value equals that key's default. This closes the limitation the previous
 * warning-based check documented.
 *
 * @param config - raw plugin config for one entry row.
 * @param owner - the row whose `apply` is validating the config.
 * @returns the misplaced keys, sorted.
 */
export function misplacedConfigKeys(config: JjPluginConfig, owner: ConfigOwner): (keyof ResolvedJjConfig)[] {
  const owned = ROW_CONFIG_KEYS[owner] as readonly string[];
  return ALL_CONFIG_KEYS.filter((key) => config[key] !== undefined && !owned.includes(key)).sort();
}

/**
 * Keys present in a row config that dsh-jj does not define.
 *
 * schemastery keeps unknown keys in the validated config (it does not close the
 * object), so a misspelled key would otherwise be carried along and ignored. Sorted for
 * deterministic messages.
 *
 * @param config - raw plugin config for one entry row.
 * @returns unknown keys with a non-`undefined` value, sorted.
 */
export function unknownConfigKeys(config: JjPluginConfig): string[] {
  const known = new Set<string>(ALL_CONFIG_KEYS);
  const record = config as Record<string, unknown>;
  return Object.keys(record)
    .filter((key) => !known.has(key) && record[key] !== undefined)
    .sort();
}

/** Model-facing row list for a message ("the jj-guard row" / "the jj-tools / jj-guard rows"). */
function ownerRowsText(owners: readonly ConfigOwner[]): string {
  const rows = [...new Set(owners.map((owner) => CONFIG_OWNER_ENTRY[owner]))];
  return rows.length === 1 ? `the ${rows[0]} row` : `the ${rows.join(' / ')} rows`;
}

/**
 * Reject a row config that carries another row's key or a misspelled key.
 *
 * A misplaced key would be read by a row the user did not configure, so the effective
 * value would silently differ from the written profile; a misspelled key would be
 * dropped entirely. Both fail the row's construction with a message naming the key and
 * the row that reads it, which is the only place the profile can still be fixed.
 *
 * @param config - raw plugin config for one entry row (schema-validated by Cordis).
 * @param owner - the row whose `apply` is validating the config.
 * @throws Error naming the first misplaced/unknown key.
 */
export function assertScopedConfig(config: JjPluginConfig, owner: ConfigOwner): void {
  const self = CONFIG_OWNER_ENTRY[owner];
  const misplaced = misplacedConfigKeys(config, owner);
  if (misplaced.length > 0) {
    const key = misplaced[0] as keyof ResolvedJjConfig;
    throw new Error(
      `dsh-jj: \`${key}\` belongs to ${ownerRowsText(configKeyOwners(key))}; the ${self} row does not read it. ` +
        "Move the key to that row's `config`, or remove it.",
    );
  }
  const unknown = unknownConfigKeys(config);
  if (unknown.length > 0) {
    throw new Error(
      `dsh-jj: \`${unknown[0]}\` is not a known dsh-jj configuration key; the ${self} row cannot read it. ` +
        'Check the spelling against the README configuration table.',
    );
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
  for (const key of ALL_CONFIG_KEYS) {
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
  for (const key of ['maxFiles', 'maxFileBytes', 'outputMaxBytes', 'diffTimeoutMs'] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-jj: \`${key}\` must be a positive safe integer, received ${String(value)}`);
    }
    if (key !== 'diffTimeoutMs' && value > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-jj: \`${key}\` must be <= ${MAX_TIMER_DELAY_MS}, received ${String(value)}`);
    }
  }
}
