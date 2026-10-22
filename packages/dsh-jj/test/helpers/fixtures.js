/**
 * Real-repository fixtures for the dsh-jj tests.
 *
 * Safety rules (after the shared-workspace `jj undo` incident):
 * - every fixture lives in its own `mkdtemp` directory outside any repository;
 * - setup commands run with an explicit `cwd` (never the workspace root);
 * - each fixture self-checks that `jj root` / `git rev-parse --show-toplevel`
 *   resolve to the fixture directory itself, so a fixture accidentally created
 *   inside another repository fails loudly instead of silently poisoning results.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRun } from './run.js';

/** Create an isolated temporary root with a cleanup hook. */
export function makeTempRoot(label = 'dsh-jj') {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a hermetic jj config (identity for commit-creating commands) outside any repository. */
export function writeJjConfig(root) {
  const file = join(root, 'jj-config.toml');
  writeFileSync(
    file,
    ['user.name = "dsh-jj test"', 'user.email = "dsh-jj@example.invalid"', 'ui.color = "never"', ''].join('\n'),
  );
  return file;
}

/** Build a runner whose default environment points jj at the fixture config. */
export function createFixtureRunner(root, extraEnv = {}) {
  return createRun({ JJ_CONFIG: writeJjConfig(root), ...extraEnv });
}

/** Run a fixture command and fail loudly (exit 0 required) on error. */
export async function mustRun(run, argv, cwd, env) {
  const result = await run(argv, { cwd, timeoutMs: 30_000, ...(env !== undefined ? { env } : {}) });
  if (result.exitCode !== 0 || result.errorCode !== undefined) {
    throw new Error(
      `fixture setup failed: ${argv.join(' ')} (exit ${result.exitCode ?? 'null'}${result.errorCode ? `, ${result.errorCode}` : ''})\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

/** Create a directory for a fixture repository. */
export function makeRepoDir(root, name) {
  const dir = resolve(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Fail unless the jj CLI resolves `dir` as its own workspace root. */
export async function assertJjFixture(run, dir) {
  const result = await mustRun(run, ['jj', '--ignore-working-copy', '--no-pager', '--color=never', 'root'], dir);
  const root = result.stdout.trim();
  if (!samePath(root, dir)) {
    throw new Error(`fixture ${dir} is inside another jj workspace (${root}); refusing to run`);
  }
}

/** Fail unless git resolves `dir` as its own worktree root. */
export async function assertGitFixture(run, dir) {
  const result = await mustRun(run, ['git', 'rev-parse', '--show-toplevel'], dir);
  const root = result.stdout.trim();
  if (!samePath(root, dir)) {
    throw new Error(`fixture ${dir} is inside another git worktree (${root}); refusing to run`);
  }
}

/** `jj git init --colocate` — `.jj` + `.git` in the same root (jj 0.46 default). */
export async function initJjColocated(run, dir) {
  await mustRun(run, ['jj', 'git', 'init', '--colocate'], dir);
  await assertJjFixture(run, dir);
  return dir;
}

/** `jj git init --no-colocate` — `.jj` only; the Git backend lives inside `.jj`. */
export async function initJjNative(run, dir) {
  await mustRun(run, ['jj', 'git', 'init', '--no-colocate'], dir);
  await assertJjFixture(run, dir);
  return dir;
}

/** `git init` — plain Git repository without jj metadata. */
export async function initGit(run, dir) {
  await mustRun(run, ['git', 'init', '--quiet'], dir);
  await assertGitFixture(run, dir);
  return dir;
}

/** Fail with a clear message when the real toolchain is unavailable. */
export async function assertToolchain(run, cwd) {
  const jj = await run(['jj', '--version'], { cwd, timeoutMs: 10_000 });
  const git = await run(['git', '--version'], { cwd, timeoutMs: 10_000 });
  if (jj.exitCode !== 0) throw new Error(`this suite requires a real jj binary on PATH: ${jj.stderr || jj.errorCode || jj.exitCode}`);
  if (git.exitCode !== 0) throw new Error(`this suite requires a real git binary on PATH: ${git.stderr || git.errorCode || git.exitCode}`);
}

/** realpath helper so assertions survive symlinked temp roots. */
export function realpath(path) {
  return realpathSync(path);
}

/**
 * Per-test fixture scope: its own temporary root (auto-cleaned), a runner, and a
 * path helper. Use inside a `test(...)` body with the test context `t`.
 */
export function makeFixture(t, label = 'dsh-jj') {
  const root = makeTempRoot(label);
  t.after(() => root.cleanup());
  const run = createFixtureRunner(root.dir);
  return {
    root: root.dir,
    run,
    path: (name) => makeRepoDir(root.dir, name),
  };
}

/**
 * Minimal stand-in for the parts of a Cordis context the guard uses.
 *
 * Reproduces the `ctx.tools.guard(...)` contract (registration order, first
 * non-empty reason denies), plus `on`, `logger`, and `emit` for the warm-up and
 * observability paths.
 */
export function createGuardContext() {
  const guards = [];
  const listeners = new Map();
  const logged = [];
  const events = [];
  const ctx = {
    tools: {
      guard: (guard) => {
        guards.push(guard);
        return () => {
          const index = guards.indexOf(guard);
          if (index >= 0) guards.splice(index, 1);
        };
      },
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    logger: { warn: (message) => logged.push(message) },
    emit: (event, payload) => events.push({ event, payload }),
  };
  return {
    ctx,
    guards,
    logged,
    events,
    listeners,
    /** Run the registered pre-execute waterfall listeners, then the guards. */
    async runPipeline(execution) {
      let index = 0;
      const list = listeners.get('tools/pre-execute') ?? [];
      const next = async () => {
        if (index < list.length) {
          const listener = list[index];
          index += 1;
          return await listener(execution, next);
        }
        return { kind: 'allow' };
      };
      await next();
      for (const guard of guards) {
        const reason = guard(execution);
        if (typeof reason === 'string' && reason.length > 0) return reason;
      }
      return undefined;
    },
    runGuard: (execution) => {
      for (const guard of guards) {
        const reason = guard(execution);
        if (typeof reason === 'string' && reason.length > 0) return reason;
      }
      return undefined;
    },
  };
}