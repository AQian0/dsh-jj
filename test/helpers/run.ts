/**
 * Real command runner for tests.
 *
 * Every test fixture and every detection probe runs a real `jj` / `git` binary
 * through `node:child_process`; nothing about the repository behaviour is mocked.
 * This runner mirrors the contract of `RunCommand` in src/types.ts:
 * - a non-zero exit is reported, never thrown;
 * - a missing executable is reported as `errorCode: 'ENOENT'`;
 * - the runner owns its deadline and reports `timedOut: true` when it fires.
 */
import { spawn } from 'node:child_process';
import type { RunCommand, RunCommandOptions, RunResult } from '../../src/types.ts';

/** Environment entries layered over `process.env` for every call. */
export type TestEnv = Readonly<Record<string, string>>;

/** Read `code` off an unknown thrown value without leaking `any` through the runner. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return 'SPAWN_FAILED';
}

/**
 * Build a runner backed by a real subprocess.
 *
 * @param defaultEnv environment entries layered over `process.env` for every call.
 * @returns a real subprocess runner that never rejects for process-level failures.
 */
export function createRun(defaultEnv: TestEnv = {}): RunCommand {
  return async function run(argv, options): Promise<RunResult> {
    const started = Date.now();
    const [command, ...args] = argv;
    const env: NodeJS.ProcessEnv = { ...process.env, ...defaultEnv, ...(options.env ?? {}) };
    return await new Promise<RunResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const spawned = (():
        | { readonly child: ReturnType<typeof spawn> }
        | { readonly spawnError: unknown } => {
        try {
          return { child: spawn(command, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) };
        } catch (error) {
          return { spawnError: error };
        }
      })();
      if ('spawnError' in spawned) {
        const error = spawned.spawnError;
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          argv,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: message,
          timedOut: false,
          errorCode: errorCodeOf(error),
          durationMs: Date.now() - started,
        });
        return;
      }
      const child = spawned.child;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 20_000);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error: Error) => {
        finish({
          argv,
          exitCode: null,
          signal: null,
          stdout,
          stderr: stderr.length > 0 ? stderr : error.message,
          timedOut,
          errorCode: errorCodeOf(error),
          durationMs: Date.now() - started,
        });
      });
      child.on('close', (code, signal) => {
        finish({
          argv,
          exitCode: code,
          signal,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
    });
  };
}

/** Options accepted by every test call; re-exported so tests do not import src internals. */
export type { RunCommandOptions };