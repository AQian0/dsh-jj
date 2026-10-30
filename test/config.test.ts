/**
 * Configuration defaults and validation for the commit-description policy.
 *
 * `Config` (schemastery), `resolveConfig`, and `assertServiceableConfig` are
 * three places that must agree on every default; these tests pin the commit-style
 * keys so drift is caught before a profile hits it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, assertServiceableConfig, resolveConfig } from '../src/config.ts';

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
  for (const key of ['commitGuidance', 'commitStyle', 'commitStyleCustom', 'preferSplitCommits', 'commitStyleSampleLimit'] as const) {
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
  assert.doesNotThrow(() => assertServiceableConfig(resolveConfig({ commitStyle: 'custom', commitStyleCustom: 'lowercase subjects' })));
  // Non-custom styles do not need custom rules.
  assert.doesNotThrow(() => assertServiceableConfig(resolveConfig({ commitStyle: 'conventional' })));
});

test('commitStyleSampleLimit must be a positive safe integer', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const resolved = { ...resolveConfig({}), commitStyleSampleLimit: value };
    assert.throws(() => assertServiceableConfig(resolved), /commitStyleSampleLimit/, `value ${String(value)} must be rejected`);
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
