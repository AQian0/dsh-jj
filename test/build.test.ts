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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createGuardContext, initJjColocated, makeFixture } from './helpers/fixtures.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

/** Dynamic import over a URL, typed loosely because the target is build output. */
interface BuiltModule {
  readonly name?: unknown;
  readonly inject?: unknown;
  readonly apply?: unknown;
  readonly Config?: unknown;
}

/** Structural view of the `ctx.jj` service the runtime entry must register. */
interface BuiltJjService {
  readonly peek: unknown;
  readonly warm: unknown;
  readonly operations: Record<string, unknown>;
  describe(kind: string): string;
}

/** Ensure the offline @deepseek-ai symlinks exist before building. */
async function ensureLinks(): Promise<void> {
  if (!existsSync(join(packageDir, 'node_modules', '@deepseek-ai'))) {
    await execFileAsync('node', ['scripts/setup-links.ts'], { cwd: packageDir, timeout: 60_000 });
  }
}

/**
 * Compiler the build test must use.
 *
 * Prefer the workspace-local `tsc` so a direct `node --test test/build.test.ts`
 * produces the same emit as `npm test`/CI (a different global compiler preserves
 * different string quotes and would make the committed lib/ look stale).
 */
function tscCommand(): string {
  const local = join(packageDir, 'node_modules', '.bin', 'tsc');
  return existsSync(local) ? local : 'tsc';
}

test('tsc -p tsconfig.json builds lib/ and lib/types/ for every source module', async () => {
  await ensureLinks();
  const result = await execFileAsync(tscCommand(), ['-p', 'tsconfig.json'], { cwd: packageDir, timeout: 180_000 });
  assert.equal(String(result.stderr).trim(), '', `tsc stderr: ${String(result.stderr)}`);
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

/** Manifest fields this build test inspects. */
interface PackageManifest {
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

test('DSH peer ranges admit later 0.2.x releases instead of pinning one runtime', () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageManifest;
  const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  );
  assert.ok(dshPeers.length > 0, 'the manifest must state its DSH runtime requirement');
  for (const [name, range] of dshPeers) {
    // DSH matches the running version against each peer range, so an exact pin rejects every
    // later 0.2.x release. A caret range keeps patch/prerelease updates compatible while still
    // rejecting the next minor line, whose plugin-facing APIs may change incompatibly.
    assert.match(
      range,
      /^\^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      `${name} must declare a caret range so later DSH patch releases stay compatible, got ${JSON.stringify(range)}`,
    );
  }
});

test('all three entries import under plain Node with name/inject/apply/Config', async () => {
  const entries: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['.', 'jj', ['subprocess', 'workingDirectory']],
    ['./tools', 'jj-tools', ['tools', 'jj', 'workingDirectory']],
    ['./guard', 'jj-guard', ['tools', 'jj']],
  ];
  for (const [specifier, expectedName, expectedInject] of entries) {
    const module = (await import(pathToFileURL(join(packageDir, 'lib', entryFile(specifier))).href)) as BuiltModule;
    assert.equal(module.name, expectedName, `${specifier} name`);
    assert.deepEqual([...((module.inject as readonly string[] | undefined) ?? [])], expectedInject, `${specifier} inject`);
    assert.equal(typeof module.apply, 'function', `${specifier} apply`);
    assert.ok(module.Config !== undefined, `${specifier} must export Config`);
  }
});

test('the bare package name resolves each documented export', async () => {
  const root = await import('@aqian0/dsh-jj');
  const tools = await import('@aqian0/dsh-jj/tools');
  const guard = await import('@aqian0/dsh-jj/guard');
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

  const guardEntry = await import('@aqian0/dsh-jj/guard');
  const harness = createGuardContext();
  guardEntry.apply(harness.ctx, { guardMutatingGit: 'deny', defaultCwd: colo });
  const reason = harness.runGuard({ name: 'bash', arguments: { command: 'git commit -m x' } });
  assert.ok(typeof reason === 'string', 'the built guard must refuse the git write');
  assert.match(reason, /^Blocked: `git commit`/);
});

test('the built runtime entry registers the ctx.jj service on a real Cordis context', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const runtimeEntry = await import('@aqian0/dsh-jj');
  const ctx = new Context();
  assert.doesNotThrow(() => runtimeEntry.apply(ctx, {}));
  const service = (ctx as unknown as { jj: BuiltJjService }).jj;
  assert.ok(service !== undefined, 'ctx.jj must be registered by the runtime entry');
  assert.equal(typeof service.peek, 'function');
  assert.equal(typeof service.warm, 'function');
  assert.equal(typeof service.operations.status, 'function');
  assert.equal(service.describe('jj-native'), 'Jujutsu (jj) native repository');
});

/** Map a subpath step in the loadability loop to the emitted entry file. */
function entryFile(specifier: string): string {
  if (specifier === './tools') return 'tools.js';
  if (specifier === './guard') return 'guard.js';
  return 'index.js';
}

test('assembleBaseLayer still returns undefined (with one warning) without a tool registry', async () => {
  const runtimeEntry = await import('@aqian0/dsh-jj');
  const warnings: string[] = [];
  const bareContext = { logger: { warn: (message: string) => warnings.push(message) } };
  assert.equal(runtimeEntry.assembleBaseLayer(bareContext as unknown as never), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /tools service is unavailable/);
});

/** Recursively collect hand-written JavaScript files under one source directory. */
function collectJavaScript(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJavaScript(path, found);
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      found.push(relative(packageDir, path));
    }
  }
  return found;
}

test('all hand-written source is TypeScript (only built lib/ may contain JavaScript)', () => {
  const offenders = ['src', 'test', 'scripts'].flatMap((dir) => collectJavaScript(join(packageDir, dir)));
  assert.deepEqual(offenders, [], `hand-written JavaScript must be migrated to TypeScript: ${offenders.join(', ')}`);
});

test('bundle patch carries the jj-aware project-root row (task-10)', () => {
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:[\s\S]*name: '@aqian0\/dsh-jj'/, 'the runtime row is declared');
  assert.match(patch, /name: '@aqian0\/dsh-jj\/tools'/, 'the tools row is declared');
  assert.match(patch, /name: '@aqian0\/dsh-jj\/guard'/, 'the guard row is declared');
  assert.match(patch, /^- id: agent-instructions$/m, 'the id-targeted agent-instructions row is declared');
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-instructions'/);
  assert.match(patch, /maxBytes: 65536/, 'the composed maxBytes value must be restated (whole-config replacement)');
  assert.match(patch, /projectRootMarkers: \['\.git', '\.jj'\]/, 'jj must be a project-root marker');
});