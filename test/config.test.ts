/**
 * Configuration defaults, validation, and cross-row ownership.
 *
 * `Config` (schemastery), `resolveConfig`, and `assertServiceableConfig` are three
 * places that must agree on every default; these tests pin the commit-style keys so
 * drift is caught before a profile hits it.
 *
 * The cross-row section at the end boots the real Cordis loader: Cordis validates
 * each row's config with `Config` (filling every default) before `apply` and exposes
 * a callable `ctx.logger`, which is exactly the environment the misplacement
 * warnings must survive (audit A4-F1/F2/F6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
  CONFIG_OWNER_ENTRY,
  CONFIG_OWNERSHIP,
  CONFIG_SHARED_OWNERSHIP,
  Config,
  ROW_CONFIG_KEYS,
  assertScopedConfig,
  assertServiceableConfig,
  configKeyOwners,
  configSchemaFor,
  misplacedConfigKeys,
  resolveConfig,
  unknownConfigKeys,
  type ConfigOwner,
} from '../src/config.ts';
import * as runtimeEntry from '../src/index.ts';
import * as toolsRow from '../src/tools.ts';

test('resolveConfig applies the commit-description defaults', () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.commitGuidance, true);
  assert.equal(resolved.commitStyle, 'auto');
  assert.equal(resolved.commitStyleCustom, '');
  assert.equal(resolved.preferSplitCommits, true);
  assert.equal(resolved.preferAmendCorrections, true);
  assert.equal(resolved.commitStyleSampleLimit, 30);
});

test('the schemastery Config defaults agree with resolveConfig', () => {
  const defaults = Config({}) as Record<string, unknown>;
  for (const key of [
    'commitGuidance',
    'commitStyle',
    'commitStyleCustom',
    'preferSplitCommits',
    'preferAmendCorrections',
    'commitStyleSampleLimit',
  ] as const) {
    assert.deepEqual(defaults[key], resolveConfig({})[key], `default mismatch for ${key}`);
  }
});

test('explicit commit-style config is preserved', () => {
  const resolved = resolveConfig({
    commitGuidance: false,
    commitStyle: 'angular',
    commitStyleCustom: 'unused for angular',
    preferSplitCommits: false,
    preferAmendCorrections: false,
    commitStyleSampleLimit: 7,
  });
  assert.equal(resolved.commitGuidance, false);
  assert.equal(resolved.commitStyle, 'angular');
  assert.equal(resolved.commitStyleCustom, 'unused for angular');
  assert.equal(resolved.preferSplitCommits, false);
  assert.equal(resolved.preferAmendCorrections, false);
  assert.equal(resolved.commitStyleSampleLimit, 7);
});

test("commitStyle 'custom' requires non-empty commitStyleCustom rules", () => {
  assert.throws(() => assertServiceableConfig(resolveConfig({ commitStyle: 'custom' })), /commitStyleCustom/);
  assert.throws(
    () => assertServiceableConfig(resolveConfig({ commitStyle: 'custom', commitStyleCustom: '   ' })),
    /commitStyleCustom/,
  );
  assert.doesNotThrow(() =>
    assertServiceableConfig(resolveConfig({ commitStyle: 'custom', commitStyleCustom: 'lowercase subjects' })),
  );
  // Non-custom styles do not need custom rules.
  assert.doesNotThrow(() => assertServiceableConfig(resolveConfig({ commitStyle: 'conventional' })));
});

test('commitStyleSampleLimit must be a positive safe integer', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const resolved = { ...resolveConfig({}), commitStyleSampleLimit: value };
    assert.throws(
      () => assertServiceableConfig(resolved),
      /commitStyleSampleLimit/,
      `value ${String(value)} must be rejected`,
    );
  }
  assert.doesNotThrow(() => assertServiceableConfig(resolveConfig({ commitStyleSampleLimit: 1 })));
});
test('resolveConfig applies the multi-session defaults', () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.multiSessionGuidance, 'auto');
  assert.equal(resolved.rebaseTarget, 'trunk()');
});

test('the schemastery Config defaults agree for the multi-session keys', () => {
  const defaults = Config({}) as Record<string, unknown>;
  for (const key of ['multiSessionGuidance', 'rebaseTarget'] as const) {
    assert.deepEqual(defaults[key], resolveConfig({})[key], `default mismatch for ${key}`);
  }
  assert.throws(() => Config({ multiSessionGuidance: 'sometimes' } as never), /multiSessionGuidance/);
});

test('explicit multi-session config is preserved, and rebaseTarget must not be empty', () => {
  const resolved = resolveConfig({ multiSessionGuidance: 'always', rebaseTarget: 'main' });
  assert.equal(resolved.multiSessionGuidance, 'always');
  assert.equal(resolved.rebaseTarget, 'main');
  assert.throws(() => assertServiceableConfig(resolveConfig({ rebaseTarget: '   ' })), /rebaseTarget/);
  assert.doesNotThrow(() => assertServiceableConfig(resolveConfig({ rebaseTarget: 'main@origin' })));
});

test('every Config key and default agrees between schemastery and resolveConfig', () => {
  const defaults = Config({}) as unknown as Record<string, unknown>;
  const resolved = resolveConfig({}) as unknown as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(resolved).sort(),
    Object.keys(defaults).sort(),
    'the schemastery schema and resolveConfig must expose the same keys',
  );
  for (const key of Object.keys(defaults)) {
    assert.deepEqual(resolved[key], defaults[key], `default mismatch for ${key}`);
  }
});

test('assertServiceableConfig rejects invalid timing and limit values', () => {
  const base = resolveConfig({});
  const cases: ReadonlyArray<readonly [string, () => void]> = [
    ['timeoutMs', () => assertServiceableConfig({ ...base, timeoutMs: 0 })],
    ['graceMs', () => assertServiceableConfig({ ...base, graceMs: 0 })],
    ['maxOutputBytes', () => assertServiceableConfig({ ...base, maxOutputBytes: -1 })],
    ['detectCacheTtlMs', () => assertServiceableConfig({ ...base, detectCacheTtlMs: 0 })],
    ['timeoutMs', () => assertServiceableConfig({ ...base, timeoutMs: Number.NaN })],
    ['timeoutMs', () => assertServiceableConfig({ ...base, timeoutMs: Number.MAX_SAFE_INTEGER + 1 })],
    ['jjCommand', () => assertServiceableConfig({ ...base, jjCommand: '   ' })],
    ['gitCommand', () => assertServiceableConfig({ ...base, gitCommand: '' })],
    ['defaultLogLimit', () => assertServiceableConfig({ ...base, defaultLogLimit: 0 })],
    ['maxLogLimit', () => assertServiceableConfig({ ...base, maxLogLimit: 10, defaultLogLimit: 20 })],
  ];
  for (const [pattern, run] of cases) assert.throws(run, new RegExp(pattern));
  assert.doesNotThrow(() => assertServiceableConfig(base));
});

test('resolveConfig derives defaults from the schema and isolates array defaults', () => {
  const first = resolveConfig({});
  first.guardTools.push('mutated-by-caller');
  assert.deepEqual(
    [...resolveConfig({}).guardTools],
    ['bash', 'pwsh', 'terminal_send'],
    'a resolved config must not share the mutable schema default array',
  );
  assert.deepEqual([...resolveConfig({ guardTools: ['bash'] }).guardTools], ['bash']);
  assert.equal(
    resolveConfig({ timeoutMs: 0 }).timeoutMs,
    0,
    'resolveConfig stays tolerant; assertServiceableConfig is the validation step',
  );
});

// ---------------------------------------------------------------------------
// Cross-row config ownership (audit core M8, A4-F1/F2/F4/F5)
// ---------------------------------------------------------------------------

test('CONFIG_OWNERSHIP maps every config key to exactly one bundle row', () => {
  const keys = Object.keys(resolveConfig({})).sort();
  assert.deepEqual(Object.keys(CONFIG_OWNERSHIP).sort(), keys, 'the ownership table must cover every config key');
  const expected: Readonly<Record<ConfigOwner, readonly (keyof typeof CONFIG_OWNERSHIP)[]>> = {
    runtime: [
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
    ],
    tools: ['defaultLogLimit', 'maxLogLimit', 'defaultCwd'],
    guard: [
      'guardMutatingGit',
      'guardGitInJjNative',
      'guardJjRepositoryWide',
      'guardTools',
      'guardCreateWorktree',
      'readOnlyGitNotice',
    ],
    changes: ['workspaceChanges', 'maxFiles', 'maxFileBytes', 'outputMaxBytes', 'diffTimeoutMs'],
  };
  for (const owner of ['runtime', 'tools', 'guard', 'changes'] as const) {
    const actual = (Object.keys(CONFIG_OWNERSHIP) as (keyof typeof CONFIG_OWNERSHIP)[])
      .filter((key) => CONFIG_OWNERSHIP[key] === owner)
      .sort();
    assert.deepEqual(actual, [...expected[owner]].sort(), `unexpected ${owner} keys`);
  }
  assert.deepEqual(
    { ...CONFIG_OWNER_ENTRY },
    { runtime: 'jj-runtime', tools: 'jj-tools', guard: 'jj-guard', changes: 'jj-changes' },
    'messages must name the row the user sees in the profile',
  );
});

test('ROW_CONFIG_KEYS partitions the union schema, and only defaultCwd is shared', () => {
  const declared = new Set<string>();
  for (const keys of Object.values(ROW_CONFIG_KEYS)) {
    for (const key of keys) {
      assert.ok(!declared.has(key) || key === 'defaultCwd', `${key} must have exactly one owning row`);
      declared.add(key);
    }
  }
  assert.deepEqual([...declared].sort(), Object.keys(resolveConfig({})).sort(), 'every schema key owns a row');
  assert.deepEqual(Object.keys(CONFIG_SHARED_OWNERSHIP), ['defaultCwd']);
});

test('each row schema declares exactly the keys that row reads', () => {
  for (const owner of ['runtime', 'tools', 'guard', 'changes'] as const) {
    const fields = Object.keys(configSchemaFor(owner).dict ?? {}).sort();
    assert.deepEqual(fields, [...ROW_CONFIG_KEYS[owner]].sort(), `the ${owner} schema must be scoped to its keys`);
  }
});

test('defaultCwd is shared by the tools and guard rows, not the runtime row', () => {
  // The guard row reads `defaultCwd` for its agent-less cwd fallback and the tools row
  // reads it for `cwdFor`; the documented primary owner stays jj-tools.
  assert.equal(CONFIG_OWNERSHIP.defaultCwd, 'tools');
  assert.deepEqual([...(CONFIG_SHARED_OWNERSHIP.defaultCwd ?? [])], ['tools', 'guard']);
  assert.deepEqual([...configKeyOwners('defaultCwd')], ['tools', 'guard']);
  assert.deepEqual([...configKeyOwners('guardMutatingGit')], ['guard'], 'single-owner keys are unchanged');

  assert.deepEqual(misplacedConfigKeys({ defaultCwd: '/tmp' }, 'tools'), []);
  assert.deepEqual(misplacedConfigKeys({ defaultCwd: '/tmp' }, 'guard'), []);
  assert.deepEqual(misplacedConfigKeys({ defaultCwd: '/tmp' }, 'runtime'), ['defaultCwd']);
  assert.doesNotThrow(() => assertScopedConfig({ defaultCwd: '/tmp' }, 'guard'));
  assert.throws(
    () => assertScopedConfig({ defaultCwd: '/tmp' }, 'runtime'),
    /belongs to the jj-tools \/ jj-guard rows/,
  );
});

test('misplacedConfigKeys reports every explicitly written key owned by another row', () => {
  assert.deepEqual(misplacedConfigKeys({}, 'runtime'), [], 'nothing configured means nothing to report');
  assert.deepEqual(misplacedConfigKeys({ commitStyle: 'angular' }, 'runtime'), [], 'a key on its own row is fine');
  assert.deepEqual(misplacedConfigKeys({ guardMutatingGit: 'deny' }, 'runtime'), ['guardMutatingGit']);
  assert.deepEqual(
    misplacedConfigKeys({ guardMutatingGit: undefined }, 'runtime'),
    [],
    'undefined is not a configuration mistake',
  );
  assert.deepEqual(
    misplacedConfigKeys(
      { defaultCwd: '/tmp', readOnlyGitNotice: false, guardTools: ['bash'], maxLogLimit: 5 },
      'runtime',
    ),
    ['defaultCwd', 'guardTools', 'maxLogLimit', 'readOnlyGitNotice'],
    'results are sorted so messages and tests are deterministic',
  );
  assert.deepEqual(
    misplacedConfigKeys({ defaultLogLimit: 5, defaultCwd: '/tmp' }, 'tools'),
    [],
    'the tools row owns both',
  );
  assert.deepEqual(misplacedConfigKeys({ commitStyle: 'auto', defaultLogLimit: 5 }, 'guard'), [
    'commitStyle',
    'defaultLogLimit',
  ]);
  assert.deepEqual(misplacedConfigKeys({ maxFiles: 10 }, 'runtime'), ['maxFiles'], 'the changes row is scoped too');
});

test('a scoped schema fills defaults only for its own keys, so explicit defaults are detectable', () => {
  // The scoped row schema never fills another row's key, so an explicitly written value
  // that happens to equal that key's default is present in the config object and can be
  // reported — the limitation of the old global-schema heuristic is gone.
  const guardConfig = configSchemaFor('guard') as unknown as (
    value: Record<string, unknown>,
  ) => Record<string, unknown>;
  const normalized = guardConfig({ guardMutatingGit: 'warn', commitStyle: 'auto' });
  assert.equal(normalized.commitStyle, 'auto');
  assert.deepEqual(misplacedConfigKeys(normalized as never, 'guard'), ['commitStyle']);
  assert.deepEqual(
    misplacedConfigKeys(guardConfig({}) as never, 'guard'),
    [],
    'schema defaults are not mistaken for input',
  );
});

test('assertScopedConfig rejects a misplaced key and names the owning row', () => {
  assert.throws(
    () => assertScopedConfig({ guardMutatingGit: 'deny', readOnlyGitNotice: false }, 'runtime'),
    /`guardMutatingGit` belongs to the jj-guard row; the jj-runtime row does not read it/,
  );
  assert.doesNotThrow(() => assertScopedConfig({ guardMutatingGit: 'deny' }, 'guard'));
  assert.doesNotThrow(() => assertScopedConfig({}, 'runtime'));
});

test('assertScopedConfig rejects a misspelled key instead of dropping it silently', () => {
  assert.throws(
    () => assertScopedConfig({ rebaseTargt: 'main' } as never, 'runtime'),
    /`rebaseTargt` is not a known dsh-jj configuration key/,
  );
  assert.deepEqual(unknownConfigKeys({ rebaseTargt: 'main' } as never), ['rebaseTargt']);
  assert.deepEqual(unknownConfigKeys({ guardMutatingGti: 'deny', preferJjContxt: false } as never), [
    'guardMutatingGti',
    'preferJjContxt',
  ]);
  assert.deepEqual(unknownConfigKeys({ rebaseTargt: undefined } as never), [], 'undefined is not a mistake');
});

// ---------------------------------------------------------------------------
// Real Cordis boot: normalized config + callable logger + deferred systemPrompt
// ---------------------------------------------------------------------------

/** One captured warning text from Cordis's own logger. */
type CapturedWarning = string;

/** One `systemPrompt.context()` registration, as passed by the plugin. */
interface PromptRegistration {
  readonly name?: unknown;
  readonly order?: unknown;
  readonly required?: unknown;
  readonly interpolate?: unknown;
}

/** Real Cordis root plus the doubles the entry rows need and their observable effects. */
interface HostFixture {
  readonly root: Context;
  /** Warning texts recorded through the real Cordis logger (level 2). */
  readonly warnings: CapturedWarning[];
  /** Every `systemPrompt.context(...)` registration, in order. */
  readonly promptRegistrations: PromptRegistration[];
  /** How many times a prompt registration's disposer ran. */
  readonly promptUnregisters: { count: number };
}

/** Provide one service double under a name Cordis also declares in its context type. */
function provideService(root: Context, name: string, value: unknown): () => unknown {
  return (root as unknown as { provide(name: string, value?: unknown): () => unknown }).provide(name, value);
}

/** Build a real Cordis root with the host services the runtime/tools rows inject. */
function createHost(options: { readonly systemPrompt: boolean }): HostFixture {
  const root = new Context();
  const warnings: string[] = [];
  root.logger.exporter({
    // Cordis skips records whose level is above the exporter threshold; warnings are 2.
    levels: { default: 9 },
    export: (message) => {
      if (message.level === 2) warnings.push(String(message.args.join(' ')));
    },
  });
  const cwd = process.cwd();
  provideService(root, 'subprocess', {
    spawn: () => Promise.reject(new Error('the config tests never spawn a subprocess')),
  });
  provideService(root, 'workingDirectory', { get: () => cwd, ensure: async () => cwd, set: async () => cwd });
  provideService(root, 'tools', { register: () => () => {}, guard: () => () => {} });

  const fixture: HostFixture = {
    root,
    warnings,
    promptRegistrations: [],
    promptUnregisters: { count: 0 },
  };
  if (options.systemPrompt) provideSystemPrompt(fixture);
  return fixture;
}

/** Add the `systemPrompt` service double; returns its disposer. */
function provideSystemPrompt(fixture: HostFixture): () => unknown {
  return provideService(fixture.root, 'systemPrompt', {
    getContextOrder: (name: string) => (name === 'WORKING_DIRECTORY' ? 100 : 100),
    context(options: PromptRegistration) {
      fixture.promptRegistrations.push(options);
      return () => {
        fixture.promptUnregisters.count += 1;
      };
    },
  });
}

/** The guard row only needs the shared warning helper here; importing the real guard
 * entry would couple this test file to the concurrently edited guard implementation. */
const syntheticGuardRow = {
  name: 'jj-guard-test-row',
  Config: configSchemaFor('guard'),
  inject: [] as const,
  apply(_ctx: Context, config: Record<string, unknown>): void {
    assertScopedConfig(config as never, 'guard');
  },
};

/** Await one plugin row exactly like the Cordis loader does. */
async function bootRow(fixture: HostFixture, plugin: unknown, config?: unknown): Promise<void> {
  await (fixture.root.plugin(plugin as never, config as never) as unknown as Promise<unknown>);
}

/** Boot the three entry rows in load order (the tools row injects the runtime's `jj`). */
async function bootThreeRows(
  fixture: HostFixture,
  configs: {
    readonly runtime?: Record<string, unknown>;
    readonly tools?: Record<string, unknown>;
    readonly guard?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await bootRow(fixture, runtimeEntry, configs.runtime);
  await bootRow(fixture, toolsRow, configs.tools);
  await bootRow(fixture, syntheticGuardRow, configs.guard);
}

/** Wait until `predicate` holds (Cordis hoists child fibers asynchronously). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('real Cordis: a clean boot of the three rows emits no warnings', async () => {
  const fixture = createHost({ systemPrompt: true });
  await bootThreeRows(fixture);
  assert.deepEqual(fixture.warnings, [], 'schema defaults must never be mistaken for user configuration');
  await waitFor(() => fixture.promptRegistrations.length === 1, 'the session prompt context registration');
  assert.equal(fixture.promptRegistrations[0]?.name, 'dsh-jj-workspace');
});

test('real Cordis: a key placed on the wrong row fails that row at construction', async () => {
  const fixture = createHost({ systemPrompt: true });
  await assert.rejects(
    () => bootRow(fixture, runtimeEntry, { guardMutatingGit: 'deny' }),
    /`guardMutatingGit` belongs to the jj-guard row; the jj-runtime row does not read it/,
  );
});

test('real Cordis: an explicit default value on the wrong row is still rejected', async () => {
  // The row schema fills defaults only for its own keys, so an explicitly written
  // value that equals another key's default is visible and rejected.
  const fixture = createHost({ systemPrompt: false });
  await assert.rejects(
    () => bootRow(fixture, syntheticGuardRow, { commitStyle: 'auto', guardMutatingGit: 'warn' }),
    /`commitStyle` belongs to the jj-runtime row/,
  );
});

test('real Cordis: an unknown config key fails the row instead of being dropped', async () => {
  const fixture = createHost({ systemPrompt: true });
  await assert.rejects(
    () => bootRow(fixture, runtimeEntry, { rebaseTargt: 'main' }),
    /`rebaseTargt` is not a known dsh-jj configuration key/,
  );
});

test('real Cordis: the tools row rejects an invalid tools-owned limit at boot', async () => {
  const fixture = createHost({ systemPrompt: false });
  await bootRow(fixture, runtimeEntry);
  await assert.rejects(() => bootRow(fixture, toolsRow, { maxLogLimit: 0 }), /`maxLogLimit` must be a safe integer/);
  // The same row still boots with the schema defaults.
  const valid = createHost({ systemPrompt: false });
  await bootRow(valid, runtimeEntry);
  await bootRow(valid, toolsRow);
});

test('real Cordis: the session context registers when systemPrompt appears after apply', async () => {
  const fixture = createHost({ systemPrompt: false });
  await bootRow(fixture, runtimeEntry);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.promptRegistrations.length, 0, 'nothing can be registered before the service exists');

  const disposeSystemPrompt = provideSystemPrompt(fixture);
  await waitFor(() => fixture.promptRegistrations.length === 1, 'the deferred session prompt context registration');
  const registration = fixture.promptRegistrations[0];
  assert.equal(registration?.name, 'dsh-jj-workspace');
  assert.equal(registration?.order, 100);
  assert.equal(registration?.required, false);
  assert.equal(registration?.interpolate, false);

  // The registration is owned by the `ctx.inject` child fiber: unloading the service
  // disposes the context instead of leaking a duplicate registration.
  disposeSystemPrompt();
  await waitFor(() => fixture.promptUnregisters.count === 1, 'the prompt context disposer');
});
