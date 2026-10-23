#!/usr/bin/env node
/**
 * Offline dependency wiring for the dsh-jj package.
 *
 * The package never installs anything from the network. It only needs the
 * already-installed DeepSeek Harness packages (and @types/node) to be visible
 * to `tsc` through the normal node_modules lookup:
 *
 *   node_modules/@deepseek-ai -> <DSH install>/node_modules/@deepseek-ai
 *   node_modules/@types       -> <DSH install>/node_modules/@types
 *
 * This is a development-only bootstrap for `tsc`; it is not part of bundle
 * installation (DSH resolves shipped packages from the installation itself).
 *
 * The default DSH install root is the global bun install used by this
 * workspace:
 *   /home/aqian/.cache/.bun/install/global/node_modules
 * Override it with DSH_NODE_MODULES=/path/to/node_modules.
 *
 * Runtime tests do NOT need these links: `node --test` loads test/*.ts through
 * Node's built-in type stripping, and every DSH import in src/ is type-only.
 * Only `tsc` needs them.
 *
 * Idempotent: re-running replaces an existing link only when it points
 * elsewhere; a real directory is never deleted (the script fails loudly).
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRoot = '/home/aqian/.cache/.bun/install/global/node_modules';
const sourceRoot = resolve(process.env.DSH_NODE_MODULES ?? defaultRoot);
const nodeModules = join(packageDir, 'node_modules');

/** Point `link` at `target` (symlink) or fail loudly instead of clobbering a real path. */
function ensureLink(label: string, target: string, link: string): void {
  if (!existsSync(target)) {
    throw new Error(
      `[dsh-jj] missing ${label} at ${target}. ` +
        'Offline setup requires an existing DeepSeek Harness install; set DSH_NODE_MODULES to its node_modules directory.',
    );
  }
  const current = lstatSync(link, { throwIfNoEntry: false });
  if (current !== undefined && current.isSymbolicLink() && realpathSync(link) === realpathSync(target)) {
    console.log(`[dsh-jj] ok      ${link} -> ${target}`);
    return;
  }
  if (current !== undefined && !current.isSymbolicLink()) {
    throw new Error(`[dsh-jj] refusing to replace real path ${link}; remove it manually if it is stale`);
  }
  if (current !== undefined) rmSync(link);
  symlinkSync(target, link, 'dir');
  console.log(`[dsh-jj] linked  ${link} -> ${target}`);
}

mkdirSync(nodeModules, { recursive: true });
ensureLink('@deepseek-ai', join(sourceRoot, '@deepseek-ai'), join(nodeModules, '@deepseek-ai'));
ensureLink('@types', join(sourceRoot, '@types'), join(nodeModules, '@types'));