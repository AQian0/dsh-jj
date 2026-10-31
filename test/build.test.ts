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

/**
 * Compiler the build test must use.
 *
 * Prefer the workspace-local `tsc` so a direct `node --test test/build.test.ts`
 * produces the same emit as `pnpm test`/CI (a different global compiler preserves
 * different string quotes and would make the committed lib/ look stale).
 */
function tscCommand(): string {
  const local = join(packageDir, 'node_modules', '.bin', 'tsc');
  return existsSync(local) ? local : 'tsc';
}

/** Hand-written source modules (`src/<name>.ts`), derived from disk instead of a hardcoded list. */
function sourceModuleNames(): string[] {
  return readdirSync(join(packageDir, 'src'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => entry.slice(0, -'.ts'.length))
    .sort();
}

/**
 * Modules that must stay free of DSH runtime imports (AGENTS.md rule 3).
 *
 * `build.test.ts` asserts this list still matches the source tree and that the
 * compiled output only imports DSH packages with a declared runtime dependency.
 */
const PURE_MODULES = [
  'detect',
  'git-command',
  'git-tokenize',
  'git-equivalence',
  'git-rules',
  'jj-rules',
  'jj-templates',
  'types',
  'commit-style',
  'multi-session',
  'changes-types',
  'changes-paths',
  'changes-diff',
  'changes-jj',
  'changes-recorder',
  'changes-service',
] as const;

/** Manifest fields the packaging and toolchain guards inspect. */
interface PackageManifest {
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
}

/** Read and parse the package manifest. */
function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageManifest;
}

/** Strip the leading `./` from a `package.json` path target. */
function packageTargetPath(target: string): string {
  return target.replace(/^\.\//, '');
}

/**
 * Assert one `exports` target exists.
 *
 * Object targets are checked recursively. Wildcard targets (`./locale/*.json`,
 * `./src/*`) are checked as directory patterns: the static prefix must resolve to
 * a directory and at least one entry must match the suffix — never one literal file.
 */
function assertExportTarget(specifier: string, target: unknown): void {
  if (typeof target === 'string') {
    const relativeTarget = packageTargetPath(target);
    const wildcard = relativeTarget.indexOf('*');
    if (wildcard >= 0) {
      const prefix = relativeTarget.slice(0, wildcard);
      const directory = prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix);
      const suffix = relativeTarget.slice(wildcard + 1);
      const directoryPath = join(packageDir, directory);
      assert.ok(existsSync(directoryPath), `exports ${specifier}: wildcard directory ${directory}/ is missing`);
      const entries = readdirSync(directoryPath);
      assert.ok(
        entries.some((entry) => suffix.length === 0 || entry.endsWith(suffix)),
        `exports ${specifier}: no ${directory}/*${suffix} file exists`,
      );
      return;
    }
    assert.ok(existsSync(join(packageDir, relativeTarget)), `exports ${specifier}: target ${target} is missing`);
    return;
  }
  if (target !== null && typeof target === 'object') {
    for (const [condition, nested] of Object.entries(target as Record<string, unknown>)) {
      assertExportTarget(`${specifier} (${condition})`, nested);
    }
    return;
  }
  assert.fail(`exports ${specifier}: unsupported target ${JSON.stringify(target)}`);
}

/** Assert one `files` entry actually ships something (literal path or wildcard directory). */
function assertFilesEntry(entry: string): void {
  const wildcard = entry.indexOf('*');
  const basePath = wildcard >= 0 ? entry.slice(0, wildcard).replace(/\/$/, '') : entry;
  assert.ok(existsSync(join(packageDir, basePath)), `files entry ${entry} does not resolve to a shipped path`);
}

test('tsc -p tsconfig.json builds lib/ and lib/types/ for every source module', async () => {
  const result = await execFileAsync(tscCommand(), ['-p', 'tsconfig.json'], { cwd: packageDir, timeout: 180_000 });
  assert.equal(String(result.stderr).trim(), '', `tsc stderr: ${String(result.stderr)}`);
  const modules = sourceModuleNames();
  for (const required of ['index', 'tools', 'guard', 'jj-command']) {
    assert.ok(modules.includes(required), `src/${required}.ts is missing from ${modules.join(', ')}`);
  }
  for (const name of modules) {
    assert.ok(existsSync(join(packageDir, 'lib', `${name}.js`)), `missing build artifact lib/${name}.js`);
    assert.ok(
      existsSync(join(packageDir, 'lib', 'types', `${name}.d.ts`)),
      `missing declaration lib/types/${name}.d.ts`,
    );
  }
});

test('pure modules stay free of runtime @deepseek-ai imports', () => {
  const modules = sourceModuleNames();
  for (const name of PURE_MODULES) {
    assert.ok(modules.includes(name), `pure module src/${name}.ts is missing from ${modules.join(', ')}`);
    const source = readFileSync(join(packageDir, 'lib', `${name}.js`), 'utf8');
    assert.ok(
      !/from\s*['"]@deepseek-ai\//.test(source),
      `lib/${name}.js must not import a DSH package at runtime (single or double quotes)`,
    );
  }
});

/** `exports` subpaths the published package must keep. */
const REQUIRED_EXPORTS = ['.', './tools', './guard', './changes', './detect', './git-command'] as const;

/** `files` entries the published package must ship (`lib/` artifacts plus the runtime data). */
const REQUIRED_FILES = [
  'lib/**/*.js',
  'lib/types/**/*.d.ts',
  'cordis.patch.yml',
  'locale/*.json',
  'tools/locale/*.json',
  'guard/locale/*.json',
  'changes/locale/*.json',
  'icon.svg',
] as const;

test('the published package manifest points only at shipped artifacts', () => {
  // This test runs after the build test above: every manifest target is compiled output.
  assert.ok(
    existsSync(join(packageDir, 'lib', 'index.js')),
    'lib/ is missing: run this file so the build test runs first',
  );
  const manifest = readPackageManifest();

  const main = manifest.main;
  assert.ok(typeof main === 'string', 'package.json main must be a string');
  assert.ok(existsSync(join(packageDir, packageTargetPath(main))), `main ${main} does not exist`);
  const types = manifest.types;
  assert.ok(typeof types === 'string', 'package.json types must be a string');
  assert.ok(existsSync(join(packageDir, packageTargetPath(types))), `types ${types} does not exist`);

  const exportsMap = manifest.exports ?? {};
  for (const specifier of REQUIRED_EXPORTS) {
    assert.ok(specifier in exportsMap, `package.json exports is missing the ${specifier} entry`);
  }
  for (const [specifier, target] of Object.entries(exportsMap)) assertExportTarget(specifier, target);

  const files = manifest.files ?? [];
  for (const entry of REQUIRED_FILES) {
    assert.ok(files.includes(entry), `package.json files is missing ${entry}`);
  }
  for (const entry of files) assertFilesEntry(entry);
});

test('DSH peer ranges admit later 0.2.x releases instead of pinning one runtime', () => {
  const manifest = readPackageManifest();
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

test('pnpm and Vite+ are wired as the repository toolchain', () => {
  const manifest = readPackageManifest();
  assert.equal(
    manifest.packageManager?.startsWith('pnpm@'),
    true,
    'package.json must pin the pnpm version used locally and in CI',
  );
  const devDependencies = manifest.devDependencies ?? {};
  for (const name of ['vite-plus', 'typescript', '@types/node', '@deepseek-ai/dsh-session-projection']) {
    assert.ok((devDependencies[name] ?? '').length > 0, `package.json devDependencies is missing ${name}`);
  }

  const scripts = manifest.scripts ?? {};
  for (const name of [
    'build',
    'format',
    'format:check',
    'lint',
    'lint:fix',
    'check',
    'typecheck',
    'test',
    'test:unit',
  ]) {
    assert.ok((scripts[name] ?? '').length > 0, `package.json scripts.${name} is missing`);
  }
  assert.equal(scripts.format, 'vp fmt', 'formatting must go through the Vite+ CLI');
  assert.equal(scripts['format:check'], 'vp fmt --check', 'CI must check formatting through the Vite+ CLI');
  assert.equal(scripts.lint, 'vp lint', 'linting must go through the Vite+ CLI');
  assert.equal(scripts.check, 'vp check --deny-warnings', 'the static gate must deny Oxlint warnings');
  assert.match(scripts.test ?? '', /pnpm run check/, 'the test gate must run the static checks');

  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts']) {
    assert.ok(existsSync(join(packageDir, file)), `${file} must exist at the repository root`);
  }
  const workspace = readFileSync(join(packageDir, 'pnpm-workspace.yaml'), 'utf8');
  const alias = /vite@\*:\s*npm:@voidzero-dev\/vite-plus-core@(\S+)/.exec(workspace);
  assert.ok(alias !== null, 'pnpm-workspace.yaml must alias vite to the Vite+ core package');
  assert.equal(
    alias[1],
    devDependencies['vite-plus'],
    'the pnpm vite alias must track the installed vite-plus version',
  );
  const viteConfig = readFileSync(join(packageDir, 'vite.config.ts'), 'utf8');
  assert.match(viteConfig, /fmt:\s*\{/, 'vite.config.ts must configure Oxfmt');
  assert.match(viteConfig, /lint:\s*\{/, 'vite.config.ts must configure Oxlint');
});

test('all four entries import under plain Node with name/inject/apply/Config', async () => {
  const entries: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['.', 'jj', ['subprocess', 'workingDirectory']],
    ['./tools', 'jj-tools', ['tools', 'jj', 'workingDirectory']],
    ['./guard', 'jj-guard', ['tools', 'jj']],
    ['./changes', 'jj-changes', ['subprocess', 'fs', 'jj']],
  ];
  for (const [specifier, expectedName, expectedInject] of entries) {
    const module = (await import(pathToFileURL(join(packageDir, 'lib', entryFile(specifier))).href)) as BuiltModule;
    assert.equal(module.name, expectedName, `${specifier} name`);
    assert.deepEqual(
      [...((module.inject as readonly string[] | undefined) ?? [])],
      expectedInject,
      `${specifier} inject`,
    );
    assert.equal(typeof module.apply, 'function', `${specifier} apply`);
    assert.ok(module.Config !== undefined, `${specifier} must export Config`);
  }
});

test('the bare package name resolves each documented export', async () => {
  const root = await import('@aqian0/dsh-jj');
  const tools = await import('@aqian0/dsh-jj/tools');
  const guard = await import('@aqian0/dsh-jj/guard');
  const changes = await import('@aqian0/dsh-jj/changes');
  assert.equal(root.name, 'jj');
  assert.equal(tools.name, 'jj-tools');
  assert.equal(guard.name, 'jj-guard');
  assert.equal(changes.name, 'jj-changes');
  assert.ok(changes.Config !== undefined, 'the changes row validates its own configuration schema');
  assert.equal(typeof changes.apply, 'function');
  assert.equal(typeof changes.jjWorkspaceRootAt, 'function', 'jj workspace classification is part of the public API');
  assert.equal(root.Config, tools.Config, 'the same schemastery Config is shared');
  assert.equal(tools.Config, guard.Config);
  assert.equal(typeof root.detectVcs, 'function');
  assert.equal(typeof root.classifyGitInvocation, 'function');
  assert.equal(typeof root.gitEquivalence, 'function');
  assert.equal(typeof root.installGitConfusionGuard, 'function');
  assert.equal(typeof root.detectCommitStyle, 'function', 'commit-description policy is part of the public API');
  assert.equal(typeof root.resolveCommitStylePolicy, 'function');
  assert.equal(typeof root.jjPreferenceContextText, 'function');
  assert.equal(typeof root.multiSessionPromptText, 'function', 'multi-session guidance is part of the public API');
  assert.equal(typeof root.multiSessionFinishChecklistText, 'function');
  assert.equal(typeof root.detectParallelSessions, 'function');
  assert.equal(typeof root.parallelPeerCwds, 'function', 'the activity-aware peer selection is part of the public API');
  assert.equal(
    typeof root.buildJjWorkspaceForgetRefusal,
    'function',
    'the workspace-forget refusal is part of the public API',
  );
  assert.equal(root.ROOT_COMMIT_ID, '0'.repeat(40), 'the empty root commit id is exported for hand-off logic');
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

test('the runtime entry forwards the commit policy into the registered prompt context', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-apply-policy');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const { Context } = await import('@deepseek-ai/cordis');
  const runtimeEntry = await import('@aqian0/dsh-jj');

  interface CapturedPromptContext {
    readonly name: string;
    readonly text: (context: { readonly agent?: { readonly session?: unknown } } | undefined) => string;
  }

  /** Apply the runtime entry over a fresh Cordis context with the two DSH services faked. */
  const applyWith = (
    config: Parameters<typeof runtimeEntry.apply>[1],
  ): { captured: CapturedPromptContext[]; text: string } => {
    const captured: CapturedPromptContext[] = [];
    const ctx = new Context();
    ctx.provide('systemPrompt');
    ctx.set('systemPrompt', {
      context: (context: CapturedPromptContext) => {
        captured.push(context);
        return () => {};
      },
      getContextOrder: () => 100,
    });
    ctx.provide('workingDirectory');
    ctx.set('workingDirectory', { get: () => repo });
    runtimeEntry.apply(ctx, config);
    const text = captured[0]?.text({ agent: { session: { id: 'policy' } } }) ?? '';
    return { captured, text };
  };

  const angular = applyWith({ preferJjContext: true, commitStyle: 'angular' });
  assert.equal(angular.captured.length, 1, 'exactly one global prompt context is registered');
  assert.equal(angular.captured[0]?.name, 'dsh-jj-workspace');
  assert.match(angular.text, /Angular commit convention/, 'commitStyle reaches the model context');
  assert.match(angular.text, /Commit granularity/, 'preferSplitCommits defaults on');

  const disabled = applyWith({ preferJjContext: false, commitStyle: 'angular' });
  assert.equal(disabled.captured.length, 0, 'preferJjContext:false registers no context at all');
});

test('the runtime entry forwards live top-level sessions into the multi-session guidance', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-apply-parallel');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const { Context } = await import('@deepseek-ai/cordis');
  const runtimeEntry = await import('@aqian0/dsh-jj');

  interface CapturedPromptContext {
    readonly name: string;
    readonly text: (context: { readonly agent?: { readonly session?: unknown } } | undefined) => string;
  }

  /**
   * Apply the runtime entry with fake systemPrompt/workingDirectory/agents services.
   *
   * `turnState` fakes the host's `sessionProjections.stateOf(session, 'turnBoundary')`
   * activity read: `{openTurnStartSeq: null}` is an idle session, a sequence number is an
   * open turn; omitting the map fakes an older host without the projection (unknown).
   */
  const applyWith = (
    config: Parameters<typeof runtimeEntry.apply>[1],
    roots: ReadonlyArray<{ readonly session: unknown }>,
    turnState?: ReadonlyMap<unknown, unknown> | ((session: unknown) => unknown),
  ): string => {
    const captured: CapturedPromptContext[] = [];
    const ctx = new Context();
    ctx.provide('systemPrompt');
    ctx.set('systemPrompt', {
      context: (context: CapturedPromptContext) => {
        captured.push(context);
        return () => {};
      },
      getContextOrder: () => 100,
    });
    ctx.provide('workingDirectory');
    ctx.set('workingDirectory', { get: () => repo });
    if (roots.length > 0) {
      ctx.provide('agents');
      ctx.set('agents', { roots: () => roots });
    }
    if (turnState !== undefined) {
      ctx.provide('sessionProjections');
      ctx.set('sessionProjections', {
        stateOf: (session: unknown, key: string) => {
          assert.equal(key, 'turnBoundary', 'the activity read must use the agent-loop projection');
          return typeof turnState === 'function' ? turnState(session) : turnState.get(session);
        },
      });
    }
    runtimeEntry.apply(ctx, config);
    return captured[0]?.text({ agent: roots[0] !== undefined ? { session: roots[0].session } : undefined }) ?? '';
  };

  const current = { id: 'apply-current' };
  const peer = { id: 'apply-peer' };
  const activeTurn = new Map<unknown, unknown>([
    [current, { openTurnStartSeq: 1 }],
    [peer, { openTurnStartSeq: 5 }],
  ]);
  const parallel = applyWith({}, [{ session: current }, { session: peer }], activeTurn);
  assert.match(parallel, /Parallel sessions: another DSH session is running in this Jujutsu working copy/);
  assert.match(parallel, /jj_workspace_add/);
  assert.match(parallel, /standard rebase hand-off/);

  const idleTurn = new Map<unknown, unknown>([
    [current, { openTurnStartSeq: 1 }],
    [peer, { openTurnStartSeq: null }],
  ]);
  const idle = applyWith({}, [{ session: current }, { session: peer }], idleTurn);
  assert.ok(!idle.includes('Parallel sessions'), 'an idle live peer is not concurrent work');
  assert.ok(!idle.includes('jj_workspace_add'), 'a single active session keeps its current working copy');
  assert.match(idle, /Jujutsu \(jj\) workspace/, 'the base jj preference is unaffected');

  const unknown = applyWith({}, [{ session: current }, { session: peer }], undefined);
  assert.match(unknown, /Parallel sessions/, 'a host without activity reporting keeps the fail-open behavior');

  const throwingRead = applyWith({}, [{ session: current }, { session: peer }], () => {
    throw new Error('projection exploded');
  });
  assert.match(throwingRead, /Parallel sessions/, 'a throwing activity read stays fail-open and never breaks assembly');
  assert.match(throwingRead, /Jujutsu \(jj\) workspace/, 'the base jj guidance survives a throwing projection');

  const malformedRead = applyWith({}, [{ session: current }, { session: peer }], () => ({}));
  assert.match(malformedRead, /Parallel sessions/, 'an unexpected projection shape stays fail-open');
  assert.match(malformedRead, /Jujutsu \(jj\) workspace/, 'the base jj guidance survives a malformed projection');

  const off = applyWith({ multiSessionGuidance: 'off' }, [{ session: current }, { session: peer }], activeTurn);
  assert.ok(!off.includes('Parallel sessions'), 'off disables the injected section');

  const always = applyWith({ multiSessionGuidance: 'always' }, [{ session: current }], idleTurn);
  assert.match(always, /separate dsh processes/, 'always covers cross-process parallel sessions');

  assert.throws(() => applyWith({ rebaseTarget: '   ' }, [{ session: current }]), /rebaseTarget/);
});

/** Map a subpath step in the loadability loop to the emitted entry file. */
function entryFile(specifier: string): string {
  if (specifier === './tools') return 'tools.js';
  if (specifier === './guard') return 'guard.js';
  if (specifier === './changes') return 'changes.js';
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
  const offenders = ['src', 'test'].flatMap((dir) => collectJavaScript(join(packageDir, dir)));
  assert.deepEqual(offenders, [], `hand-written JavaScript must be migrated to TypeScript: ${offenders.join(', ')}`);
});

/** Recursively collect hand-written TypeScript files under one directory. */
function collectTypeScript(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScript(path, found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

test('hand-written TypeScript has no tabs, trailing whitespace, or CRLF line endings', (t) => {
  const problems: string[] = [];
  const longLines: string[] = [];
  const files = ['src', 'test'].flatMap((dir) => collectTypeScript(join(packageDir, dir)));
  files.push(join(packageDir, 'vite.config.ts'));
  for (const file of files) {
    const relativePath = relative(packageDir, file);
    const text = readFileSync(file, 'utf8');
    if (text.includes('\r')) problems.push(`${relativePath}: CRLF line ending`);
    text.split('\n').forEach((line, index) => {
      const location = `${relativePath}:${index + 1}`;
      if (line.includes('\t')) problems.push(`${location}: tab character`);
      if (/[ \t]+$/.test(line)) problems.push(`${location}: trailing whitespace`);
      if (line.length > 120) longLines.push(location);
    });
  }
  assert.deepEqual(problems, [], `style problems: ${problems.join(', ')}`);
  if (longLines.length > 0) {
    // Oxfmt wraps at 120 columns, so this is now a regression warning, not a style gate.
    t.diagnostic(
      `${longLines.length} lines exceed 120 columns (warning only, not failing): ${longLines.slice(0, 5).join(', ')}`,
    );
  }
});

test('bundle patch carries the jj-aware project-root row and the change-recording rows', () => {
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:[\s\S]*name: '@aqian0\/dsh-jj'/, 'the runtime row is declared');
  assert.match(patch, /name: '@aqian0\/dsh-jj\/tools'/, 'the tools row is declared');
  assert.match(patch, /name: '@aqian0\/dsh-jj\/guard'/, 'the guard row is declared');
  assert.match(patch, /name: '@aqian0\/dsh-jj\/changes'/, 'the jj change-recording row is declared');
  assert.match(
    patch,
    /^- id: workspace-changes$\n  name: '@deepseek-ai\/dsh-workspace-changes'\n  disabled: true$/m,
    'the built-in Git-only workspace-changes row must be disabled so jj owns the changed-files card',
  );
  assert.match(patch, /^- id: agent-instructions$/m, 'the id-targeted agent-instructions row is declared');
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-instructions'/);
  assert.match(patch, /maxBytes: 65536/, 'the composed maxBytes value must be restated (whole-config replacement)');
  assert.match(patch, /projectRootMarkers: \['\.git', '\.jj'\]/, 'jj must be a project-root marker');
});
