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
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedJjConfig } from './config.ts';
import type { JjRunResult, RunCommand, RunJj, RunJjOptions } from './types.ts';
export type { JjRunResult, RunJj, RunJjOptions };
/** Stable jj error codes (contract §5.7). */
export type JjErrorCode = 'JJ_NOT_INSTALLED' | 'JJ_TIMEOUT' | 'JJ_ABORTED' | 'JJ_NOT_A_REPO' | 'JJ_REPO_BROKEN' | 'JJ_BAD_REVSET' | 'JJ_BAD_INPUT' | 'JJ_COMMAND_FAILED' | 'JJ_OUTPUT_INVALID';
/** One failed jj call with its raw evidence. */
export declare class JjError extends Error {
    readonly code: JjErrorCode;
    readonly detail: {
        readonly argv: readonly string[];
        readonly exitCode: number | null;
        readonly stderr: string;
        readonly stdout: string;
    };
    constructor(code: JjErrorCode, message: string, detail: JjError['detail']);
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
export declare function jjNonInteractiveEnv(extra?: Readonly<Record<string, string>>): Record<string, string>;
/**
 * Map a settled jj process outcome onto a {@link JjErrorCode}.
 *
 * @param result - settled run result.
 * @param aborted - whether the caller's signal was already aborted.
 * @returns the error code, or `undefined` for a successful exit.
 */
export declare function classifyJjFailure(result: JjRunResult, aborted: boolean): JjErrorCode | undefined;
/** Human-readable, model-facing message for one failure. */
export declare function jjErrorMessage(code: JjErrorCode, argv: readonly string[], result: JjRunResult, jjCommand: string): string;
/**
 * The real runner: `ctx.subprocess.spawn` with collected output, grace, and a
 * caller-owned timeout (contract §5.5).
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj} bound to this context.
 */
export declare function createRunJj(ctx: Context, config: ResolvedJjConfig): RunJj;
/**
 * Runner over an injected {@link RunCommand} (task-4 runner shape). Used by tests
 * and by embedders that already own a process runner; argv[0] is `jjCommand`.
 *
 * @param run - the injected runner.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj}.
 */
export declare function createCommandRunJj(run: RunCommand, config: ResolvedJjConfig): RunJj;
/**
 * The Git runner: used **only** for probes (`git rev-parse`, `git --version`) and
 * never as a fallback for jj work (contract §5.4 MUST 1).
 *
 * @param ctx - context providing the `subprocess` service.
 * @param config - resolved plugin configuration.
 * @returns a {@link RunJj} that spawns `config.gitCommand`.
 */
export declare function createRunGit(ctx: Context, config: ResolvedJjConfig): RunJj;
/** Runner used for the version probes (`git --version` is the only git call dsh-jj allows). */
export declare function createCommandRunGit(run: RunCommand, config: ResolvedJjConfig): RunJj;
/** Run one jj command and throw a {@link JjError} on failure (contract §5.7). */
export declare function runJjChecked(runJj: RunJj, options: RunJjOptions, config: ResolvedJjConfig): Promise<JjRunResult>;
