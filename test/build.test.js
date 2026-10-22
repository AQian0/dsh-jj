/**
 * Build and loadability evidence.
 *
 * `tsc -p tsconfig.json` must produce `lib/*.js` plus `lib/types/*.d.ts`, the
 * three entry points must import under plain Node with `name`/`inject`/`apply`/
 * `Config`, and the built guard must still refuse a mutating Git command inside a
 * real jj workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createGuardContext, initJjColocated, makeFixture } from './helpers/fixtures.js';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

/** Ensure the offline @deepseek-ai symlinks exist before building. */
async function ensureLinks() {
  if (!existsSync(join(packageDir, 'node_modules', '@deepseek-ai'))) {
    await execFileAsync('node', ['scripts/setup-links.mjs'], { cwd: packageDir, timeout: 60_000 });
  }
}

test('tsc -p tsconfig.json builds lib/ and lib/types/ for every source module', async () => {
  await ensureLinks();
  const result = await execFileAsync('tsc', ['-p', 'tsconfig.json'], { cwd: packageDir, timeout: 180_000 });
  assert.equal(result.stderr.trim(), '', `tsc stderr: ${result.stderr}`);
  for (const file of ['index.js', 'tools.js', 'guard.js', 'detect.js', 'git-command.js', 'types.js', 'config.js']) {
    assert.ok(existsSync(join(packageDir, 'lib', file)), `missing build artifact lib/${file}`);
  }
  for (const file of ['index.d.ts', 'tools.d.ts', 'guard.d.ts', 'detect.d.ts', 'git-command.d.ts', 'types.d.ts', 'config.d.ts']) {
    assert.ok(existsSync(join(packageDir, 'lib', 'types', file)), `missing declaration lib/types/${file}`);
  }
});

test('pure modules stay free of runtime @deepseek-ai imports', () => {
  for (const file of ['detect.js', 'git-command.js', 'types.js']) {
    const source = readFileSync(join(packageDir, 'lib', file), 'utf8');
    assert.ok(!/from\s*"@deepseek-ai\//.test(source), `${file} must not import a DSH package at runtime`);
  }
});

test('all three entries import under plain Node with name/inject/apply/Config', async () => {
  const entries = [
    ['.', 'jj', ['subprocess', 'workingDirectory']],
    ['./tools', 'jj-tools', ['tools', 'jj', 'workingDirectory']],
    ['./guard', 'jj-guard', ['tools', 'jj']],
  ];
  for (const [specifier, expectedName, expectedInject] of entries) {
    const module = await import(pathToFileURL(join(packageDir, 'lib', entryFile(specifier))).href);
    assert.equal(module.name, expectedName, `${specifier} name`);
    assert.deepEqual([...module.inject], expectedInject, `${specifier} inject`);
    assert.equal(typeof module.apply, 'function', `${specifier} apply`);
    assert.ok(module.Config !== undefined, `${specifier} must export Config`);
  }
});

test('the bare package name resolves each documented export', async () => {
  const root = await import('dsh-jj');
  const tools = await import('dsh-jj/tools');
  const guard = await import('dsh-jj/guard');
  assert.equal(root.name, 'jj');
  assert.equal(tools.name, 'jj-tools');
  assert.equal(guard.name, 'jj-guard');
  assert.equal(root.Config, tools.Config, 'the same schemastery Config is shared');
  assert.equal(tools.Config, guard.Config);
  assert.equal(typeof root.detectVcs, 'function');
  assert.equal(typeof root.classifyGitInvocation, 'function');
  assert.equal(typeof root.gitEquivalence, 'function');
  assert.equal(typeof root.installGitConfusionGuard, 'function');
});

test('the built guard entry installs a working guard against a real jj workspace', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-build');
  const colo = await initJjColocated(fx.run, fx.path('colo'));

  const guardEntry = await import('dsh-jj/guard');
  const harness = createGuardContext();
  guardEntry.apply(harness.ctx, { guardMutatingGit: 'deny', defaultCwd: colo });
  const reason = harness.runGuard({ name: 'bash', arguments: { command: 'git commit -m x' } });
  assert.match(reason, /^Blocked: `git commit`/);
});

test('the built runtime entry registers the ctx.jj service on a real Cordis context', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const runtimeEntry = await import('dsh-jj');
  const ctx = new Context();
  assert.doesNotThrow(() => runtimeEntry.apply(ctx, {}));
  const service = ctx.jj;
  assert.ok(service !== undefined, 'ctx.jj must be registered by the runtime entry');
  assert.equal(typeof service.peek, 'function');
  assert.equal(typeof service.warm, 'function');
  assert.equal(typeof service.operations.status, 'function');
  assert.equal(service.describe('jj-native'), 'Jujutsu (jj) native repository');
});

function entryFile(specifier) {
  if (specifier === './tools') return 'tools.js';
  if (specifier === './guard') return 'guard.js';
  return 'index.js';
}
test('assembleBaseLayer still returns undefined (with one warning) without a tool registry', async () => {
  const runtimeEntry = await import('dsh-jj');
  const warnings = [];
  const bareContext = { logger: { warn: (message) => warnings.push(message) } };
  assert.equal(runtimeEntry.assembleBaseLayer(/** @type {never} */ (bareContext)), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tools service is unavailable/);
});

test('bundle patch carries the jj-aware project-root row (task-10)', () => {
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:[\s\S]*name: 'dsh-jj'/, 'the runtime row is declared');
  assert.match(patch, /name: 'dsh-jj\/tools'/, 'the tools row is declared');
  assert.match(patch, /name: 'dsh-jj\/guard'/, 'the guard row is declared');
  assert.match(patch, /^- id: agent-instructions$/m, 'the id-targeted agent-instructions row is declared');
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-instructions'/);
  assert.match(patch, /maxBytes: 65536/, 'the composed maxBytes value must be restated (whole-config replacement)');
  assert.match(patch, /projectRootMarkers: \['\.git', '\.jj'\]/, 'jj must be a project-root marker');
});
