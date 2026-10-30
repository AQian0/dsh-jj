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

import { scrubbedParentEnv, type SubprocessOutcome } from '@deepseek-ai/dsh-subprocess';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedJjConfig } from './config.ts';
import type { JjRunResult, RunCommand, RunJj, RunJjOptions } from './types.ts';

export type { JjRunResult, RunJj, RunJjOptions };

/** Stable jj error codes (contract §5.7). */
export type JjErrorCode =
  | 'JJ_NOT_INSTALLED'
  | 'JJ_TIMEOUT'
  | 'JJ_ABORTED'
  /** The process died from a signal (for example an external SIGINT/SIGTERM). */
  | 'JJ_SIGNALED'
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
 * Ordering is part of the contract (audit M2):
 * - a zero exit code is a success, even when the caller's signal aborted while
 *   the process was already finishing: the command may simply have won the race,
 *   and reporting it as cancelled would hide a completed mutation;
 * - our own deadline is `JJ_TIMEOUT`, with the terminating signal in the message;
 * - a caller cancellation that stopped the process is `JJ_ABORTED`;
 * - a process killed by an external signal is `JJ_SIGNALED` — Node reports
 *   `exitCode: null` there too, so it must not be mistaken for a missing binary;
 * - `exitCode: null` with no signal is the spawn-failure shape the adapter
 *   produces when the executable could not be started (for example ENOENT),
 *   which stays `JJ_NOT_INSTALLED`.
 *
 * @param result - settled run result.
 * @param aborted - whether the caller's signal was already aborted.
 * @returns the error code, or `undefined` for a successful exit.
 */
export function classifyJjFailure(result: JjRunResult, aborted: boolean): JjErrorCode | undefined {
  if (result.exitCode === 0 && !result.killedByTimeout) return undefined;
  if (result.killedByTimeout) return 'JJ_TIMEOUT';
  if (aborted) return 'JJ_ABORTED';
  if (result.exitCode === null) {
    return result.signal === null ? 'JJ_NOT_INSTALLED' : 'JJ_SIGNALED';
  }
  const stderr = result.stderr;
  if (result.signal !== null) return 'JJ_SIGNALED';
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
    case 'JJ_NOT_INSTALLED': {
      const detail = result.stderr.trim();
      return `dsh-jj could not run the jj executable (${jjCommand}). Install Jujutsu (https://jj-vcs.dev) or point the dsh-jj \`jjCommand\` setting at the binary. dsh-jj never substitutes Git for jj.${detail.length > 0 ? ` Underlying error: ${bounded(detail, 512)}` : ''}`;
    }
    case 'JJ_TIMEOUT':
      return `\`${command}\` exceeded its timeout (${result.signal ?? 'killed'}); the repository may already be partially changed — inspect with jj_op_log before retrying.`;
    case 'JJ_ABORTED':
      return `\`${command}\` was cancelled by the caller; the command may already have partially changed the repository — inspect with jj_op_log before retrying.`;
    case 'JJ_SIGNALED': {
      const detail = result.stderr.trim();
      return `\`${command}\` was terminated by ${result.signal ?? 'a signal'} (not by a dsh-jj timeout); the command may already have partially changed the repository — inspect with jj_op_log before retrying.${detail.length > 0 ? ` Output: ${bounded(detail, 512)}` : ''}`;
    }
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

/** Effective limits for one spawn-based run (per-call overrides win over config). */
interface SpawnLimits {
  readonly timeoutMs: number;
  readonly graceMs: number;
  readonly maxOutputBytes: number;
}

/** Read `error` as a message without leaking `unknown` through the adapter. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shared execution ladder for both spawn-based runners.
 *
 * The jj and Git adapters must behave identically for deadlines, caller
 * cancellation, bounded collection, and teardown (audit M7): a Git probe must
 * not outlive the configured timeout while jj calls respect it. Only argv and
 * env differ between the two runners; everything else lives here so the two
 * cannot drift.
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration (default limits).
 * @param options - per-call contract options (overrides and caller signal).
 * @param argv - fully built argv (program included).
 * @param env - fully layered environment for this run.
 * @returns the settled result; a pre-aborted caller never spawns anything.
 */
async function runSpawned(
  ctx: Context,
  config: ResolvedJjConfig,
  options: RunJjOptions,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<JjRunResult> {
  if (options.signal?.aborted === true) return emptyResult();
  const limits: SpawnLimits = {
    timeoutMs: options.timeoutMs || config.timeoutMs,
    graceMs: options.graceMs || config.graceMs,
    maxOutputBytes: options.maxOutputBytes || config.maxOutputBytes,
  };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('dsh-jj timeout')), limits.timeoutMs);
  let timedOut = false;
  controller.signal.addEventListener('abort', () => {
    // A caller cancellation is classified as JJ_ABORTED, not as our deadline.
    if (options.signal?.aborted !== true) timedOut = true;
  });
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: limits.maxOutputBytes },
        stderr: { maxBytes: limits.maxOutputBytes },
      },
      graceMs: limits.graceMs,
      signal: controller.signal,
      env,
    });
    let outcome: SubprocessOutcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      handle.terminate();
      await handle.waitForExit().catch(() => false);
      return { ...emptyResult(), stderr: errorMessage(error), killedByTimeout: timedOut };
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
    return { ...emptyResult(), stderr: errorMessage(error), killedByTimeout: timedOut };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The real runner: `ctx.subprocess.spawn` with collected output, grace, and a
 * caller-owned timeout (contract §5.5). Shares the deadline/abort ladder with
 * {@link createRunGit} through {@link runSpawned}.
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj} bound to this context.
 */
export function createRunJj(ctx: Context, config: ResolvedJjConfig): RunJj {
  return async (options: RunJjOptions): Promise<JjRunResult> => {
    const argv = [options.jjCommand || config.jjCommand, '--no-pager', '--color=never', ...options.argv];
    return await runSpawned(ctx, config, options, argv, jjNonInteractiveEnv(options.env));
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
      // The injected `RunCommand` shape has no truncation signal; the spawn-based
      // adapter (`createRunJj`/`createRunGit`) is the one that tracks lossy output.
      truncated: false,
      killedByTimeout: result.timedOut,
    };
  };
}

/**
 * The Git runner: used **only** for probes (`git rev-parse`, `git --version`) and
 * never as a fallback for jj work (contract §5.4 MUST 1). It shares
 * {@link runSpawned} with the jj adapter, so a hung Git probe is bounded by the
 * same configurable timeout and caller cancellation (audit M7).
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj} that spawns `config.gitCommand`.
 */
export function createRunGit(ctx: Context, config: ResolvedJjConfig): RunJj {
  return async (options: RunJjOptions): Promise<JjRunResult> => {
    const argv = [options.jjCommand || config.gitCommand, ...options.argv];
    const env = {
      ...scrubbedParentEnv(),
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    };
    return await runSpawned(ctx, config, options, argv, env);
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
      // The injected `RunCommand` shape has no truncation signal; the spawn-based
      // adapter (`createRunJj`/`createRunGit`) is the one that tracks lossy output.
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