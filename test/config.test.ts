/**
 * Configuration defaults and validation for the commit-description policy.
 *
 * `Config` (schemastery), `resolveConfig`, and `assertServiceableConfig` are
 * three places that must agree on every default; these tests pin the commit-style
 * keys so drift is caught before a profile hits it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_OWNER_ENTRY,
  CONFIG_OWNERSHIP,
  Config,
  assertServiceableConfig,
  misplacedConfigKeys,
  resolveConfig,
  warnMisplacedConfig,
  type ConfigOwner,
} from '../src/config.ts';

test('resolveConfig applies the commit-description defaults', () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.commitGuidance, true);
  assert.equal(resolved.commitStyle, 'auto');
  assert.equal(resolved.commitStyleCustom, '');
  assert.equal(resolved.preferSplitCommits, true);
  assert.equal(resolved.commitStyleSampleLimit, 30);
});

test('the schemastery Config defaults agree with resolveConfig', () => {
  const defaults = Config({}) as Record<string, unknown>;
  for (const key of [
    'commitGuidance',
    'commitStyle',
    'commitStyleCustom',
    'preferSplitCommits',
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
    commitStyleSampleLimit: 7,
  });
  assert.equal(resolved.commitGuidance, false);
  assert.equal(resolved.commitStyle, 'angular');
  assert.equal(resolved.commitStyleCustom, 'unused for angular');
  assert.equal(resolved.preferSplitCommits, false);
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
// Cross-row config ownership (audit core M8)
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
  };
  for (const owner of ['runtime', 'tools', 'guard'] as const) {
    const actual = (Object.keys(CONFIG_OWNERSHIP) as (keyof typeof CONFIG_OWNERSHIP)[])
      .filter((key) => CONFIG_OWNERSHIP[key] === owner)
      .sort();
    assert.deepEqual(actual, [...expected[owner]].sort(), `unexpected ${owner} keys`);
  }
  assert.deepEqual(
    { ...CONFIG_OWNER_ENTRY },
    { runtime: 'jj-runtime', tools: 'jj-tools', guard: 'jj-guard' },
    'warnings must name the row the model sees in its profile',
  );
});

test('misplacedConfigKeys reports only explicitly configured keys owned by other rows', () => {
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
    'results are sorted so warnings and tests are deterministic',
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
});

test('warnMisplacedConfig warns once per misplaced key and never throws', () => {
  const messages: string[] = [];
  const logger = { warn: (message: string) => messages.push(message) };
  warnMisplacedConfig(
    logger,
    { guardMutatingGit: 'deny', readOnlyGitNotice: false, commitStyle: 'angular' },
    'runtime',
  );
  assert.equal(messages.length, 2, 'one warning per misplaced key, none for the local commitStyle');
  assert.match(messages[0] ?? '', /`guardMutatingGit` belongs to the jj-guard row; this row \(jj-runtime\) ignores it/);
  assert.match(messages[1] ?? '', /`readOnlyGitNotice` belongs to the jj-guard row/);

  // A missing, malformed, or throwing logger must never break startup.
  assert.doesNotThrow(() => warnMisplacedConfig(undefined, { guardTools: ['bash'] }, 'runtime'));
  assert.doesNotThrow(() => warnMisplacedConfig({}, { guardTools: ['bash'] }, 'runtime'));
  assert.doesNotThrow(() => warnMisplacedConfig({ warn: 'not-a-function' }, { guardTools: ['bash'] }, 'runtime'));
  assert.doesNotThrow(() =>
    warnMisplacedConfig(
      {
        warn: () => {
          throw new Error('logger down');
        },
      },
      { guardTools: ['bash'] },
      'runtime',
    ),
  );
});
