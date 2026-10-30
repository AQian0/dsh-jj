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
import type { TestContext } from 'node:test';
import type { GuardExecutionLike, ToolGuardHost } from '../../src/guard.ts';
import type { RunCommand, RunResult } from '../../src/types.ts';
import { createRun, type TestEnv } from './run.ts';

/** Isolated temporary root plus its cleanup hook. */
export interface TempRoot {
  readonly dir: string;
  cleanup(): void;
}

/** Per-test fixture scope: its own temporary root, a runner, and a path helper. */
export interface Fixture {
  readonly root: string;
  readonly run: RunCommand;
  /** Create (or reuse) a directory under the fixture root and return its absolute path. */
  path(name: string): string;
  /** Optional working directory override used by the service/tool suites. */
  cwd?: string;
}

/** One recorded Cordis event from a guard harness. */
export interface HarnessEvent {
  readonly event: string;
  readonly payload: { readonly message?: string; readonly kind?: string; readonly [key: string]: unknown };
}

/**
 * Structural context double handed to `installGitConfusionGuard` / entry `apply`.
 *
 * Deliberately omits `on` from its surface type: the guard's own `on` signature
 * (event + listener) and the entry `apply` signature (`...args`) are not mutually
 * assignable, while both accept a host that simply does not expose `on` (the
 * harness keeps listeners reachable through {@link GuardHarness.listeners}).
 */
export interface HarnessContext {
  readonly tools: ToolGuardHost['tools'];
  readonly logger: unknown;
  readonly emit: (event: string, payload: HarnessEvent['payload']) => void;
}

/** Model-visible tool result shape the post-execute waterfall hands around. */
export interface HarnessToolResult {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly kind?: string;
  readonly [key: string]: unknown;
}

/** Waterfall listener registered through the harness `on` seam (shape varies per event). */
export type HarnessListener = (...args: unknown[]) => unknown;

/**
 * Minimal stand-in for the parts of a Cordis context the guard uses.
 *
 * Reproduces the `ctx.tools.guard(...)` contract (registration order, first
 * non-empty reason denies), plus `on`, `logger`, and `emit` for the warm-up and
 * observability paths.
 */
export interface GuardHarness {
  readonly ctx: HarnessContext;
  readonly guards: Array<(execution: GuardExecutionLike) => string | undefined>;
  readonly logged: unknown[];
  readonly events: HarnessEvent[];
  readonly listeners: Map<string, HarnessListener[]>;
  /** Run the registered pre-execute waterfall listeners, then the guards. */
  runPipeline(execution: GuardExecutionLike): Promise<string | undefined>;
  /** Run only the decision path (no warm-up listener), as the sync tool seam does. */
  runGuard(execution: GuardExecutionLike): string | undefined;
}

/** Create an isolated temporary root with a cleanup hook. */
export function makeTempRoot(label = 'dsh-jj'): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a hermetic jj config (identity for commit-creating commands) outside any repository. */
export function writeJjConfig(root: string): string {
  const file = join(root, 'jj-config.toml');
  writeFileSync(
    file,
    ['user.name = "dsh-jj test"', 'user.email = "dsh-jj@example.invalid"', 'ui.color = "never"', ''].join('\n'),
  );
  return file;
}

/** Build a runner whose default environment points jj at the fixture config. */
export function createFixtureRunner(root: string, extraEnv: TestEnv = {}): RunCommand {
  return createRun({ JJ_CONFIG: writeJjConfig(root), ...extraEnv });
}

/** Run a fixture command and fail loudly (exit 0 required) on error. */
export async function mustRun(
  run: RunCommand,
  argv: readonly string[],
  cwd: string,
  env?: TestEnv,
): Promise<RunResult> {
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
export function makeRepoDir(root: string, name: string): string {
  const dir = resolve(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Compare two paths by their canonical realpath. */
function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Fail unless the jj CLI resolves `dir` as its own workspace root. */
export async function assertJjFixture(run: RunCommand, dir: string): Promise<void> {
  const result = await mustRun(run, ['jj', '--ignore-working-copy', '--no-pager', '--color=never', 'root'], dir);
  const root = result.stdout.trim();
  if (!samePath(root, dir)) {
    throw new Error(`fixture ${dir} is inside another jj workspace (${root}); refusing to run`);
  }
}

/** Fail unless git resolves `dir` as its own worktree root. */
export async function assertGitFixture(run: RunCommand, dir: string): Promise<void> {
  const result = await mustRun(run, ['git', 'rev-parse', '--show-toplevel'], dir);
  const root = result.stdout.trim();
  if (!samePath(root, dir)) {
    throw new Error(`fixture ${dir} is inside another git worktree (${root}); refusing to run`);
  }
}

/** `jj git init --colocate` — `.jj` + `.git` in the same root (jj 0.46 default). */
export async function initJjColocated(run: RunCommand, dir: string): Promise<string> {
  await mustRun(run, ['jj', 'git', 'init', '--colocate'], dir);
  await assertJjFixture(run, dir);
  return dir;
}

/** `jj git init --no-colocate` — `.jj` only; the Git backend lives inside `.jj`. */
export async function initJjNative(run: RunCommand, dir: string): Promise<string> {
  await mustRun(run, ['jj', 'git', 'init', '--no-colocate'], dir);
  await assertJjFixture(run, dir);
  return dir;
}

/** `git init` — plain Git repository without jj metadata. */
export async function initGit(run: RunCommand, dir: string): Promise<string> {
  await mustRun(run, ['git', 'init', '--quiet'], dir);
  await assertGitFixture(run, dir);
  return dir;
}

/**
 * SHA-256 Git repository with jj colocated on top: `git init --object-format=sha256`
 * followed by `jj git init --colocate`.
 *
 * The empty root commit has 64 zeroes in such a repository (not the 40 of a SHA-1
 * repository), which exercises jj's root-commit detection.
 *
 * Returns `undefined` instead of throwing when the local toolchain cannot create
 * or use a SHA-256 repository (git < 2.29, or a jj build without the SHA-256 git
 * backend), so callers can `t.skip` and keep the suite green on older setups.
 */
export async function initJjSha256(run: RunCommand, dir: string): Promise<string | undefined> {
  const git = await run(['git', 'init', '--quiet', '--object-format=sha256'], { cwd: dir, timeoutMs: 30_000 });
  if (git.exitCode !== 0 || git.errorCode !== undefined) return undefined;
  await assertGitFixture(run, dir);
  const jj = await run(['jj', 'git', 'init', '--colocate'], { cwd: dir, timeoutMs: 30_000 });
  if (jj.exitCode !== 0 || jj.errorCode !== undefined) return undefined;
  await assertJjFixture(run, dir);
  return dir;
}

/** Fail with a clear message when the real toolchain is unavailable. */
export async function assertToolchain(run: RunCommand, cwd: string): Promise<void> {
  const jj = await run(['jj', '--version'], { cwd, timeoutMs: 10_000 });
  const git = await run(['git', '--version'], { cwd, timeoutMs: 10_000 });
  if (jj.exitCode !== 0) throw new Error(`this suite requires a real jj binary on PATH: ${jj.stderr || jj.errorCode || jj.exitCode}`);
  if (git.exitCode !== 0) throw new Error(`this suite requires a real git binary on PATH: ${git.stderr || git.errorCode || git.exitCode}`);
}

/** realpath helper so assertions survive symlinked temp roots. */
export function realpath(path: string): string {
  return realpathSync(path);
}

/**
 * Per-test fixture scope: its own temporary root (auto-cleaned), a runner, and a
 * path helper. Use inside a `test(...)` body with the test context `t`.
 */
export function makeFixture(t: TestContext, label = 'dsh-jj'): Fixture {
  const root = makeTempRoot(label);
  t.after(() => root.cleanup());
  const run = createFixtureRunner(root.dir);
  return {
    root: root.dir,
    run,
    path: (name) => makeRepoDir(root.dir, name),
  };
}

/** Build a guard harness whose context double satisfies {@link ToolGuardHost}. */
export function createGuardContext(): GuardHarness {
  const guards: Array<(execution: GuardExecutionLike) => string | undefined> = [];
  const listeners = new Map<string, HarnessListener[]>();
  const logged: unknown[] = [];
  const events: HarnessEvent[] = [];
  const ctx: HarnessContext = {
    tools: {
      guard: (guard) => {
        guards.push(guard);
        return () => {
          const index = guards.indexOf(guard);
          if (index >= 0) guards.splice(index, 1);
        };
      },
    },
    logger: { warn: (message: unknown) => logged.push(message) },
    emit: (event: string, payload: HarnessEvent['payload']) => events.push({ event, payload }),
  };
  // `on` is installed on the live object but kept out of the surface type (see
  // HarnessContext): the guard reads it through its own widened `on` member.
  (ctx as HarnessContext & { on: (event: string, listener: HarnessListener) => () => void }).on = (
    event,
    listener,
  ) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
    return () => {
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    };
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
      const next = async (): Promise<unknown> => {
        if (index < list.length) {
          const listener = list[index];
          index += 1;
          return await listener?.(execution, next);
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

/** Options accepted by the exported fixture helpers; re-exported for convenience. */
export type { TestEnv };