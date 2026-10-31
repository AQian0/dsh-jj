/**
 * jj command orchestration for the per-turn workspace-changes recorder.
 *
 * A DSH turn is bracketed by two working-copy snapshots: at turn start the
 * recorder asks for the current `@` commit id, at turn end it asks again and
 * diffs the two ids. Everything here goes through the injected {@link RunJj}
 * runner, so limits, cancellation, and the scrubbed non-interactive environment
 * are uniform with every other jj call in the plugin.
 *
 * Two deliberate snapshot choices:
 *
 * - `readCommit` does NOT pass `--ignore-working-copy`: jj must snapshot the
 *   working copy first, so the returned commit id reflects the files on disk.
 * - `readDiff` passes `--ignore-working-copy` to both commands: both commits are
 *   already recorded, no re-snapshot is needed, and skipping it avoids racing an
 *   actively mutated working copy.
 *
 * Both methods resolve to `undefined` instead of throwing: recording changes is a
 * best-effort side channel, so a missing binary, a broken repository, a stale
 * working copy, truncation, a timeout, or a throwing runner must never break the
 * turn. Pure orchestration over the injected runner: no `child_process`, no
 * `@deepseek-ai/*` runtime import.
 *
 * @module dsh-jj/changes-jj
 */

import { parseGitFormatDiff, parseNulPaths } from './changes-diff.ts';
import type { JjChangesReader, ParsedChange } from './changes-types.ts';
import type { JjRunResult, RunJj, RunJjOptions } from './types.ts';

/** Command limits bound into every command this reader runs. */
export interface JjChangesCommandLimits {
  /** Runner-side deadline per command. */
  readonly timeoutMs: number;
  /** Grace period between termination and kill. */
  readonly graceMs: number;
  /** Cap on collected stdout/stderr bytes; a truncated run is treated as failed. */
  readonly maxOutputBytes: number;
}

/** A commit id: 40 lowercase hex digits (SHA-1) or 64 (SHA-256). */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Template printing the working-copy commit id followed by one newline.
 *
 * The TS string holds a literal backslash-n so jj's template parser emits the
 * newline (not a real newline inside the `-T` argument).
 */
const COMMIT_TEMPLATE = 'commit_id ++ "\\n"';

/**
 * Template printing one NUL-terminated workspace-relative target path per diff entry.
 *
 * The TS string holds a literal backslash-zero so jj's template parser emits NUL.
 */
const PATH_TEMPLATE = 'path ++ "\\0"';

/** Whether a settled run is a complete, successful answer. */
function succeeded(result: JjRunResult): boolean {
  return result.exitCode === 0 && !result.killedByTimeout && !result.truncated;
}

/** Run one bounded jj command, turning a throwing runner into a failed read. */
async function tryRun(runJj: RunJj, options: RunJjOptions): Promise<JjRunResult | undefined> {
  try {
    return await runJj(options);
  } catch {
    return undefined;
  }
}

/** Run one command that must exit zero and stay untruncated, else resolve `undefined`. */
async function runChecked(runJj: RunJj, options: RunJjOptions): Promise<JjRunResult | undefined> {
  const result = await tryRun(runJj, options);
  return result !== undefined && succeeded(result) ? result : undefined;
}

/** Build the bound runner options for one command (limits always applied). */
function commandOptions(
  limits: JjChangesCommandLimits,
  cwd: string,
  argv: readonly string[],
  signal: AbortSignal | undefined,
): RunJjOptions {
  return {
    cwd,
    argv,
    timeoutMs: limits.timeoutMs,
    graceMs: limits.graceMs,
    maxOutputBytes: limits.maxOutputBytes,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Create a {@link JjChangesReader} bound to one runner and one set of command limits.
 *
 * @param runJj - injected jj runner; the caller owns the executable name, pager/color flags, and environment.
 * @param limits - timeout, grace, and output cap applied to every command this reader runs.
 * @returns a reader whose methods never throw and resolve `undefined` for every failed read.
 */
export function createJjChangesReader(runJj: RunJj, limits: JjChangesCommandLimits): JjChangesReader {
  return {
    async readCommit(options): Promise<string | undefined> {
      const result = await runChecked(
        runJj,
        commandOptions(limits, options.cwd, ['log', '--no-graph', '-r', '@', '-T', COMMIT_TEMPLATE], options.signal),
      );
      if (result === undefined) return undefined;
      const id = result.stdout.trim();
      return COMMIT_ID.test(id) ? id.toLowerCase() : undefined;
    },

    async readDiff(options): Promise<readonly ParsedChange[] | undefined> {
      if (options.from === options.to) return [];
      const pathsResult = await runChecked(
        runJj,
        commandOptions(
          limits,
          options.cwd,
          ['diff', '--ignore-working-copy', '--from', options.from, '--to', options.to, '-T', PATH_TEMPLATE],
          options.signal,
        ),
      );
      if (pathsResult === undefined) return undefined;
      const diffResult = await runChecked(
        runJj,
        commandOptions(
          limits,
          options.cwd,
          ['diff', '--ignore-working-copy', '--from', options.from, '--to', options.to, '--git'],
          options.signal,
        ),
      );
      if (diffResult === undefined) return undefined;
      return parseGitFormatDiff(diffResult.stdout, parseNulPaths(pathsResult.stdout));
    },
  };
}
