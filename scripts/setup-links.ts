#!/usr/bin/env node
/**
 * Portable offline dependency wiring for dsh-jj development.
 *
 * `tsc` and the test type-check need the DeepSeek Harness packages (and
 * `@types/node`) to be visible through the normal `node_modules` lookup. There
 * are two supported bootstraps, and this script detects both and no-ops when
 * either is already in place:
 *
 * 1. **Link to a DSH install** — point the local scoped directories at an
 *    existing DSH `node_modules`:
 *
 *      node_modules/@deepseek-ai -> <DSH install>/node_modules/@deepseek-ai
 *      node_modules/@types       -> <DSH install>/node_modules/@types
 *
 *    The source is `DSH_NODE_MODULES` when set, otherwise the global bun
 *    installs `${HOME}/.cache/.bun/install/global/node_modules` and
 *    `${HOME}/.bun/install/global/node_modules`. macOS/Windows desktop-app
 *    installs keep their dependencies inside the app bundle, so those cannot be
 *    linked; use option 2 there.
 *
 * 2. **Install the public peer dependencies once** (network, no lockfile, no new
 *    dependencies): `npm install --no-package-lock --ignore-scripts` plus the
 *    CI-pinned compiler (`typescript@6.0.3`, `@types/node@26.6.5`). After that
 *    this script prints "already resolvable; nothing to do" and exits 0, so
 *    `npm test` stays offline.
 *
 * Options:
 * - `--check`  probe only; write nothing. Exit 0 when the bootstrap is already
 *              effective or satisfiable (a DSH source is discoverable), 1
 *              otherwise with the two ways out.
 * - `--help`   print this description.
 *
 * Idempotency and safety: an existing correct link is reported `ok`; a link
 * that points elsewhere is re-pointed; a real directory is never deleted or
 * replaced (it is accepted when it already provides the packages, otherwise the
 * script fails loudly). Tests do NOT need these links: `node --test` loads
 * test/*.ts through Node's type stripping and imports only local source paths.
 *
 * @module scripts/setup-links
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An expected bootstrap failure; printed as a diagnostic, never with a stack trace. */
class SetupError extends Error {}

/** One `node_modules` probe that proves a dependency is resolvable locally. */
interface LocalProbe {
  readonly label: string;
  readonly path: string;
}

/** One scoped directory this script links from a DSH install. */
interface ScopedLink {
  readonly label: string;
  /** Package-relative file that proves the source really is a DSH node_modules. */
  readonly probe: string;
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(packageDir, 'node_modules');
const checkOnly = process.argv.includes('--check');
const helpWanted = process.argv.includes('--help') || process.argv.includes('-h');

/** Files `tsc` and the test type-check need; `typescript` itself is not linked by this script. */
const LOCAL_PROBES: readonly LocalProbe[] = [
  { label: '@deepseek-ai/cordis', path: join(nodeModules, '@deepseek-ai', 'cordis', 'package.json') },
  { label: '@deepseek-ai/schemastery', path: join(nodeModules, '@deepseek-ai', 'schemastery', 'package.json') },
  { label: '@types/node', path: join(nodeModules, '@types', 'node', 'package.json') },
  { label: 'typescript', path: join(nodeModules, 'typescript', 'package.json') },
];
/** The compiler probe: the link step never provides `typescript`; it comes from PATH or the npm step. */
const TYPESCRIPT_PROBE = LOCAL_PROBES[LOCAL_PROBES.length - 1];
/** Subset that the link step is responsible for. */
const LINKED_PROBES = LOCAL_PROBES.filter((probe) => probe !== TYPESCRIPT_PROBE);
const SCOPED_LINKS: readonly ScopedLink[] = [
  { label: '@deepseek-ai', probe: join('cordis', 'package.json') },
  { label: '@types', probe: join('node', 'package.json') },
];
/** Windows needs a junction for directory links; POSIX uses the plain directory symlink. */
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * Print one diagnostic line.
 *
 * @param message - message without the `[dsh-jj]` prefix.
 */
function log(message: string): void {
  console.log(`[dsh-jj] ${message}`);
}

/**
 * Abort the setup with an actionable diagnostic.
 *
 * @param message - multi-line explanation; printed as-is.
 * @throws {SetupError} always.
 */
function fail(message: string): never {
  throw new SetupError(message);
}

/**
 * Whether a path exists (symlinks followed).
 *
 * @param path - candidate path.
 * @returns true when the path can be resolved.
 */
function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * Whether a path is a directory after following a symlink.
 *
 * @param path - candidate path.
 * @returns true when the resolved path is a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether one source root is a DSH `node_modules` (contains the scoped probes).
 *
 * @param root - candidate `node_modules` directory.
 * @returns true when both scoped probes exist below it.
 */
function looksLikeDshNodeModules(root: string): boolean {
  return SCOPED_LINKS.every((link) => exists(join(root, link.label, link.probe)));
}

/**
 * Candidate source roots in discovery order.
 *
 * @returns the explicit `DSH_NODE_MODULES` value, or the two portable bun-global defaults.
 */
function candidateSourceRoots(): readonly string[] {
  const explicit = process.env.DSH_NODE_MODULES;
  if (explicit !== undefined && explicit.trim().length > 0) return [resolve(explicit)];
  return [
    join(homedir(), '.cache', '.bun', 'install', 'global', 'node_modules'),
    join(homedir(), '.bun', 'install', 'global', 'node_modules'),
  ];
}

/**
 * Validate an explicitly configured source root.
 *
 * @param root - the resolved `DSH_NODE_MODULES` value.
 */
function assertExplicitSourceRoot(root: string): void {
  if (!exists(root)) {
    fail(
      `DSH_NODE_MODULES=${root} does not exist. It must point at a node_modules directory that contains ` +
        '@deepseek-ai and @types (for example `<DSH install>/node_modules`); the desktop app keeps its ' +
        'dependencies inside the app bundle, so there use `npm install` for the public peer dependencies instead.',
    );
  }
  if (!isDirectory(root)) {
    fail(
      `DSH_NODE_MODULES=${root} is not a directory. ` +
        'It must point at a node_modules directory, not at the DSH install root.',
    );
  }
  if (!looksLikeDshNodeModules(root)) {
    fail(
      `DSH_NODE_MODULES=${root} does not look like a DSH node_modules directory: expected ` +
        `${join(root, '@deepseek-ai', 'cordis')} and ${join(root, '@types', 'node')}.`,
    );
  }
}

/**
 * Locate a DSH `node_modules` to link from.
 *
 * @returns the source root, or `undefined` when no candidate is usable.
 */
function discoverSourceRoot(): string | undefined {
  const explicit = process.env.DSH_NODE_MODULES;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const root = resolve(explicit);
    assertExplicitSourceRoot(root);
    return root;
  }
  for (const root of candidateSourceRoots()) {
    if (looksLikeDshNodeModules(root)) return root;
  }
  return undefined;
}

/**
 * The two ways out of a missing bootstrap, shared by the normal and `--check` failures.
 *
 * @param missing - local probes that are not resolvable.
 * @returns a multi-line message.
 */
function bootstrapHelp(missing: readonly LocalProbe[]): string {
  const tried = candidateSourceRoots().map((root) => `  - ${root}`).join('\n');
  return [
    'Could not satisfy the offline dependency bootstrap.',
    `Missing in ${nodeModules}: ${missing.map((probe) => probe.label).join(', ')}.`,
    'Tried these DSH node_modules sources:',
    tried,
    'Two ways out:',
    '  1. Link an existing DSH CLI/bun-global install:',
    '       DSH_NODE_MODULES=<DSH install>/node_modules npm run setup',
    '     (the macOS/Windows desktop app keeps dependencies inside the app bundle, so it cannot be linked)',
    '  2. Install the public peer dependencies once (network) and provide the compiler:',
    '       npm install --no-package-lock --ignore-scripts',
    '       npm install --no-save typescript@6.0.3 @types/node@26.6.5',
    '     Afterwards `npm run setup` / `npm test` no-op and run offline.',
  ].join('\n');
}

/**
 * Point one scoped local directory at the DSH install without clobbering real paths.
 *
 * @param sourceRoot - validated DSH `node_modules`.
 * @param link - one {@link ScopedLink} descriptor.
 */
function ensureLink(sourceRoot: string, link: ScopedLink): void {
  const target = join(sourceRoot, link.label);
  const local = join(nodeModules, link.label);
  if (!exists(join(target, link.probe))) {
    fail(
      `DSH source ${sourceRoot} does not provide ${link.label}/${link.probe}; ` +
        'is DSH_NODE_MODULES pointing at a real DeepSeek Harness node_modules install?',
    );
  }
  const current = lstatSync(local, { throwIfNoEntry: false });
  if (current === undefined) {
    symlinkSync(target, local, linkType);
    log(`linked    ${local} -> ${target}`);
    return;
  }
  if (current.isSymbolicLink()) {
    const same = sameRealPath(local, target);
    if (same) {
      log(`ok        ${local} -> ${target}`);
      return;
    }
    rmSync(local, { force: true });
    symlinkSync(target, local, linkType);
    log(`relinked  ${local} -> ${target}`);
    return;
  }
  if (current.isDirectory() && exists(join(local, link.probe))) {
    // `npm install` produced a real directory that already provides the package:
    // never delete it, just accept it as a valid resolution.
    log(`ok        ${local} (real directory already provides ${link.label}; left untouched)`);
    return;
  }
  fail(
    `refusing to replace real path ${local}; it does not provide ${link.label}/${link.probe}. ` +
      'Move it away manually (or fix the local npm install) and re-run.',
  );
}

/**
 * Compare two paths by canonical realpath (a broken link counts as different).
 *
 * @param left - first path.
 * @param right - second path.
 * @returns true when both resolve to the same real path.
 */
function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Run one bootstrap attempt.
 *
 * @returns the process exit code.
 */
function main(): number {
  if (helpWanted) {
    console.log(`Usage: node scripts/setup-links.ts [--check]

Wire the local node_modules/@deepseek-ai and node_modules/@types for tsc, either by
linking an existing DSH install (DSH_NODE_MODULES) or by accepting npm-installed
public peer dependencies (no-op). --check probes without writing.`);
    return 0;
  }
  const unknown = process.argv
    .slice(2)
    .filter((argument) => argument !== '--check' && argument !== '--help' && argument !== '-h');
  if (unknown.length > 0) {
    fail(`unknown argument(s): ${unknown.join(' ')}. Usage: node scripts/setup-links.ts [--check]`);
  }
  const explicit = process.env.DSH_NODE_MODULES;
  if (explicit !== undefined && explicit.trim().length > 0) assertExplicitSourceRoot(resolve(explicit));

  const missing = LOCAL_PROBES.filter((probe) => !exists(probe.path));
  if (missing.length === 0) {
    log('already resolvable; nothing to do');
    return 0;
  }
  const missingLinks = LINKED_PROBES.filter((probe) => !exists(probe.path));
  if (missingLinks.length === 0) {
    log('dependencies already resolvable; nothing to link');
    log('note: node_modules/typescript is missing; `tsc` must come from PATH (global install or the CI install step).');
    return 0;
  }

  if (checkOnly) {
    const source = discoverSourceRoot();
    if (source !== undefined) {
      log(`check passed: DSH node_modules found at ${source}; run without --check to wire the links`);
      return 0;
    }
    fail(bootstrapHelp(missingLinks));
  }

  const source = discoverSourceRoot();
  if (source === undefined) fail(bootstrapHelp(missingLinks));
  mkdirSync(nodeModules, { recursive: true });
  for (const link of SCOPED_LINKS) ensureLink(source, link);

  const unresolved = LINKED_PROBES.filter((probe) => !exists(probe.path));
  if (unresolved.length > 0) {
    fail(`setup finished but these are still not resolvable: ${unresolved.map((probe) => probe.label).join(', ')}.`);
  }
  if (!exists(TYPESCRIPT_PROBE.path)) {
    log('note: node_modules/typescript is missing; `tsc` must come from PATH (global install or the CI install step).');
  }
  log('done: node_modules/@deepseek-ai and node_modules/@types are wired for tsc');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof SetupError) {
    console.error(`[dsh-jj] ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
