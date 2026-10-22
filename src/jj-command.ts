/**
 * jj execution adapter and error vocabulary (design contract §5.5 / §5.7).
 *
 * Every jj call goes through {@link RunJj}: the plugin binds it to
 * `ctx.subprocess.spawn`, tests bind it to a real `node:child_process` runner.
 * Git is never used as a fallback for jj work.
 *
 * Non-interactive guarantees: `--no-pager --color=never` are always prepended,
 * `GIT_TERMINAL_PROMPT=0`/`NO_COLOR=1` are layered on the scrubbed parent
 * environment, stdin is `/dev/null`, and prompts cannot be answered.
 *
 * @module dsh-jj/jj-command
 */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedJjConfig } from './config.ts';
import type { JjRunResult, RunCommand, RunJj, RunJjOptions } from './types.ts';

export type { JjRunResult, RunJj, RunJjOptions };

/** Stable jj error codes (contract §5.7). */
export type JjErrorCode =
  | 'JJ_NOT_INSTALLED'
  | 'JJ_TIMEOUT'
  | 'JJ_ABORTED'
  | 'JJ_NOT_A_REPO'
  | 'JJ_REPO_BROKEN'
  | 'JJ_BAD_REVSET'
  | 'JJ_BAD_INPUT'
  | 'JJ_COMMAND_FAILED'
  | 'JJ_OUTPUT_INVALID';

/** One failed jj call with its raw evidence. */
export class JjError extends Error {
  readonly code: JjErrorCode;
  readonly detail: {
    readonly argv: readonly string[];
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly stdout: string;
  };

  constructor(code: JjErrorCode, message: string, detail: JjError['detail']) {
    super(message);
    this.name = 'JjError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Environment layered onto every jj call (never carries credentials).
 *
 * Editor/credential shield (contract §5.9): jj opens an editor for commands whose
 * description is not fully specified, and a headless tool call would hang on a
 * blocking editor or fail with an undiagnosable logging error. Every editor hook
 * (`JJ_EDITOR`, `GIT_EDITOR`, `EDITOR`, `VISUAL`) points at an immediately failing
 * command, and credential prompts are disabled. `--config ui.editor=false` is
 * deliberately NOT used: jj 0.46 rejects it with
 * `Config error: Invalid type or value for ui.editor`. Parameter validation (see
 * `JjOperations.squash`) is what prevents the editor path in the first place; this
 * environment only guarantees no hang.
 */
export function jjNonInteractiveEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...scrubbedParentEnv(),
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    JJ_EDITOR: '/bin/false',
    GIT_EDITOR: '/bin/false',
    EDITOR: '/bin/false',
    VISUAL: '/bin/false',
    // Empty values disable interactive credential helpers outright.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    ...extra,
  };
}

function bounded(text: string, limit = 2_048): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`;
}

/**
 * Map a settled jj process outcome onto a {@link JjErrorCode}.
 *
 * @param result - settled run result.
 * @param aborted - whether the caller's signal was already aborted.
 * @returns the error code, or `undefined` for a successful exit.
 */
export function classifyJjFailure(result: JjRunResult, aborted: boolean): JjErrorCode | undefined {
  if (aborted) return 'JJ_ABORTED';
  if (result.killedByTimeout) return 'JJ_TIMEOUT';
  if (result.exitCode === 0) return undefined;
  const stderr = result.stderr;
  if (result.exitCode === null) return 'JJ_NOT_INSTALLED';
  if (result.exitCode === 255 || /appears broken or inaccessible/i.test(stderr)) return 'JJ_REPO_BROKEN';
  if (/There is no jj repo in/i.test(stderr)) return 'JJ_NOT_A_REPO';
  if (/Failed to parse revset|doesn't exist|no such revision|Revision .* doesn't exist/i.test(stderr)) return 'JJ_BAD_REVSET';
  if (result.exitCode === 2) return 'JJ_BAD_INPUT';
  if (/Cannot access/i.test(stderr)) return 'JJ_REPO_BROKEN';
  return 'JJ_COMMAND_FAILED';
}

/** Human-readable, model-facing message for one failure. */
export function jjErrorMessage(code: JjErrorCode, argv: readonly string[], result: JjRunResult, jjCommand: string): string {
  const command = `jj ${argv.join(' ')}`;
  switch (code) {
    case 'JJ_NOT_INSTALLED':
      return `dsh-jj could not run the jj executable (${jjCommand}). Install Jujutsu (https://jj-vcs.dev) or point the dsh-jj \`jjCommand\` setting at the binary. dsh-jj never substitutes Git for jj.`;
    case 'JJ_TIMEOUT':
      return `\`${command}\` exceeded its timeout (${result.signal ?? 'killed'}); the repository may already be partially changed — inspect with jj_op_log before retrying.`;
    case 'JJ_ABORTED':
      return `\`${command}\` was cancelled by the caller.`;
    case 'JJ_NOT_A_REPO':
      return `\`${command}\` failed: this directory is not a usable Jujutsu (jj) repository. ${bounded(result.stderr, 512)}`;
    case 'JJ_REPO_BROKEN':
      return `\`${command}\` failed: the jj repository looks broken or inaccessible. ${bounded(result.stderr, 512)}`;
    case 'JJ_BAD_REVSET':
      return `\`${command}\` rejected the revset: ${bounded(result.stderr, 512)}`;
    case 'JJ_BAD_INPUT':
      return `\`${command}\` was rejected by jj (usage error): ${bounded(result.stderr, 512)}`;
    case 'JJ_OUTPUT_INVALID':
      return `\`${command}\` produced output that dsh-jj could not parse: ${bounded(result.stdout, 512)}`;
    case 'JJ_COMMAND_FAILED':
      return `\`${command}\` failed with exit code ${result.exitCode ?? 'null'}: ${bounded(result.stderr)}`;
  }
}

function emptyResult(): JjRunResult {
  return { exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, killedByTimeout: false };
}

/** Read one collected stream completely (contract: `readFrom(0)` after settlement). */
function readCollected(reader: { readFrom(fromByte: number): { text: string; lossy: boolean } } | undefined): { text: string; lossy: boolean } {
  if (reader === undefined) return { text: '', lossy: false };
  try {
    const read = reader.readFrom(0);
    return { text: read.text, lossy: read.lossy };
  } catch {
    return { text: '', lossy: false };
  }
}

/**
 * The real runner: `ctx.subprocess.spawn` with collected output, grace, and a
 * caller-owned timeout (contract §5.5).
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj} bound to this context.
 */
export function createRunJj(ctx: Context, config: ResolvedJjConfig): RunJj {
  return async (options: RunJjOptions): Promise<JjRunResult> => {
    if (options.signal?.aborted === true) return emptyResult();
    const argv = [options.jjCommand || config.jjCommand, '--no-pager', '--color=never', ...options.argv];
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('dsh-jj timeout')), options.timeoutMs || config.timeoutMs);
    let timedOut = false;
    controller.signal.addEventListener('abort', () => {
      if (options.signal?.aborted !== true) timedOut = true;
    });
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: options.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: options.maxOutputBytes || config.maxOutputBytes },
          stderr: { maxBytes: options.maxOutputBytes || config.maxOutputBytes },
        },
        graceMs: options.graceMs || config.graceMs,
        signal: controller.signal,
        env: jjNonInteractiveEnv(options.env),
      });
      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        handle.terminate();
        await handle.waitForExit().catch(() => false);
        return {
          ...emptyResult(),
          stderr: error instanceof Error ? error.message : String(error),
          killedByTimeout: timedOut,
        };
      }
      const stdout = readCollected(handle.collected.stdout);
      const stderr = readCollected(handle.collected.stderr);
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.lossy,
        killedByTimeout: timedOut,
      };
    } catch (error) {
      // Spawn refused synchronously (missing executable, invalid spec).
      return {
        ...emptyResult(),
        stderr: error instanceof Error ? error.message : String(error),
        killedByTimeout: timedOut,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Runner over an injected {@link RunCommand} (task-4 runner shape). Used by tests
 * and by embedders that already own a process runner; argv[0] is `jjCommand`.
 *
 * @param run - the injected runner.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj}.
 */
export function createCommandRunJj(run: RunCommand, config: ResolvedJjConfig): RunJj {
  return async (options: RunJjOptions): Promise<JjRunResult> => {
    const program = options.jjCommand || config.jjCommand;
    const result = await run([program, '--no-pager', '--color=never', ...options.argv], {
      cwd: options.cwd,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs || config.timeoutMs,
      env: { NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...(options.env ?? {}) },
    });
    return {
      exitCode: result.errorCode !== undefined ? null : result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.errorCode !== undefined ? `${result.errorCode}: ${result.stderr}` : result.stderr,
      truncated: false,
      killedByTimeout: result.timedOut,
    };
  };
}

/**
 * The Git runner: used **only** for probes (`git rev-parse`, `git --version`) and
 * never as a fallback for jj work (contract §5.4 MUST 1).
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj} that spawns `config.gitCommand`.
 */
export function createRunGit(ctx: Context, config: ResolvedJjConfig): RunJj {
  return async (options: RunJjOptions): Promise<JjRunResult> => {
    if (options.signal?.aborted === true) return emptyResult();
    const argv = [options.jjCommand || config.gitCommand, ...options.argv];
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: options.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: options.maxOutputBytes || config.maxOutputBytes },
          stderr: { maxBytes: options.maxOutputBytes || config.maxOutputBytes },
        },
        graceMs: options.graceMs || config.graceMs,
        signal: options.signal,
        env: { ...scrubbedParentEnv(), NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', ...(options.env ?? {}) },
      });
      const outcome = await handle.done;
      const stdout = readCollected(handle.collected.stdout);
      const stderr = readCollected(handle.collected.stderr);
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.lossy,
        killedByTimeout: false,
      };
    } catch (error) {
      return { ...emptyResult(), stderr: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** Runner used for the version probes (`git --version` is the only git call dsh-jj allows). */
export function createCommandRunGit(run: RunCommand, config: ResolvedJjConfig): RunJj {
  return async (options: RunJjOptions): Promise<JjRunResult> => {
    const program = options.jjCommand || config.gitCommand;
    const result = await run([program, ...options.argv], {
      cwd: options.cwd,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs || config.timeoutMs,
      env: { NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...(options.env ?? {}) },
    });
    return {
      exitCode: result.errorCode !== undefined ? null : result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.errorCode !== undefined ? `${result.errorCode}: ${result.stderr}` : result.stderr,
      truncated: false,
      killedByTimeout: result.timedOut,
    };
  };
}

/** Run one jj command and throw a {@link JjError} on failure (contract §5.7). */
export async function runJjChecked(
  runJj: RunJj,
  options: RunJjOptions,
  config: ResolvedJjConfig,
): Promise<JjRunResult> {
  const result = await runJj(options);
  const code = classifyJjFailure(result, options.signal?.aborted === true);
  if (code !== undefined) {
    throw new JjError(code, jjErrorMessage(code, options.argv, result, options.jjCommand || config.jjCommand), {
      argv: options.argv,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return result;
}