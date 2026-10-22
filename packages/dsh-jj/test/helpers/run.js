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

/**
 * @param {Record<string, string>} defaultEnv - environment entries layered over `process.env` for every call.
 * @returns {import('../src/types.ts').RunCommand} a real subprocess runner.
 */
export function createRun(defaultEnv = {}) {
  return async function run(argv, options) {
    const started = Date.now();
    const [command, ...args] = argv;
    const env = { ...process.env, ...defaultEnv, ...(options.env ?? {}) };
    return await new Promise((resolve) => {
      let timer;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child;
      try {
        child = spawn(command, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({
          argv,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: String(error?.message ?? error),
          timedOut: false,
          errorCode: error?.code ?? 'SPAWN_FAILED',
          durationMs: Date.now() - started,
        });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 20_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        finish({
          argv,
          exitCode: null,
          signal: null,
          stdout,
          stderr: stderr.length > 0 ? stderr : String(error?.message ?? error),
          timedOut,
          errorCode: error?.code ?? 'SPAWN_FAILED',
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