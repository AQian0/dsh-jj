/**
 * jj operations layer and the public `service` barrel (design contract §5.4 / §5.6).
 *
 * {@link JjOperations} holds every jj-native operation; it is pure with respect
 * to the host (one injected {@link RunJj}), which makes the whole operation layer
 * testable against real repositories without mounting Cordis.
 *
 * The module is split for readability: pure template constants and record parsers
 * live in `jj-templates`, the Cordis `ctx.jj` service in `jj-service`; both are
 * re-exported at the bottom so every existing `from './service.ts'` import keeps
 * working unchanged.
 *
 * @module dsh-jj/service
 */

import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  assertServiceableConfig,
  Config,
  resolveConfig,
  type JjPluginConfig,
  type ResolvedJjConfig,
} from './config.ts';
import { JjError, runJjChecked, type RunJj } from './jj-command.ts';
import {
  asRecord,
  bound,
  changeFromRecord,
  parseChangeLines,
  parseJsonLine,
  TemplateParseError,
  TPL_BOOKMARK_LIST,
  TPL_CHANGE,
  TPL_COMMIT_IDS,
  TPL_DESCRIPTION,
  TPL_LOG,
  TPL_OP_LOG,
  TPL_STATUS,
  TPL_WORKSPACE_LIST_TAB,
  type JjChangeRecord,
} from './jj-templates.ts';
import type { JjOperation, JjRunResult } from './types.ts';

/** How `jj rebase` selects the revisions to move (jj 0.46). */
export type JjRebaseMode = 'revisions' | 'source' | 'branch';

/** `JjRebaseMode` → jj command-line flag. */
const REBASE_MODE_FLAGS: Readonly<Record<JjRebaseMode, string>> = { revisions: '-r', source: '-s', branch: '-b' };

function badInput(message: string, argv: readonly string[] = []): JjError {
  return new JjError('JJ_BAD_INPUT', message, { argv, exitCode: null, stderr: '', stdout: '' });
}

const OPERATION_ID_RE = /^[0-9a-f]{4,128}$/;
const BOOKMARK_NAME_RE = /^[^\s@]+$/;
/** Bookmark names safe to embed verbatim in a jj revset (`bookmarks(exact:…)` / `::name`). */
const SAFE_BOOKMARK_RE = /^[A-Za-z0-9_./-]+$/;

/** Result of `status()`. */
export interface JjStatusResult {
  readonly change: JjChangeRecord;
  readonly changedPaths: readonly string[];
  readonly diffStat: string;
  readonly raw: string;
  readonly truncated: boolean;
}

/** Result of `undo()`. */
export interface JjUndoResult {
  readonly mode: 'undo' | 'restore';
  readonly operationId: string;
  readonly headOperationId: string;
  readonly message: string;
}

/** Result of `commit()`. */
export interface JjCommitResult {
  /** The change that was described (the parent of the new working copy); it may be empty. */
  readonly committed: JjChangeRecord;
  /** The new working-copy change; it keeps any changes not covered by `paths`. */
  readonly workingCopy: JjChangeRecord;
  /** Non-fatal jj warnings (for example paths that matched no file), surfaced to the model. */
  readonly warnings: readonly string[];
}

/** Result of `workspaceAdd()`. */
export interface JjWorkspaceAddResult {
  readonly path: string;
  readonly name: string;
  readonly change: JjChangeRecord;
}

/**
 * jj's empty root commit id as spelled in a SHA-1 repository (the default): a
 * destination that resolves to it is never an integration base.
 *
 * The constant is kept for API compatibility (`src/index.ts` re-exports it and
 * `test/build.test.ts` asserts the SHA-1 spelling). SHA-256 Git repositories use
 * 64 zeroes instead, so detection must go through {@link isRootCommitId}.
 */
export const ROOT_COMMIT_ID = '0'.repeat(40);

/** Whether a commit id is jj's empty root commit (SHA-1: 40 zeroes, SHA-256: 64). */
function isRootCommitId(commitId: string): boolean {
  return /^0{40,}$/.test(commitId);
}

/** How a hand-off destination was chosen (model-facing provenance). */
export type JjHandoffTargetSource = 'argument' | 'configured' | 'trunk' | 'main' | 'master';

/** The integration destination a hand-off resolved. */
export interface JjHandoffTarget {
  /** The revset expression that resolved (as given/configured or the automatic fallback). */
  readonly revset: string;
  /** Why this candidate was used. */
  readonly source: JjHandoffTargetSource;
  readonly change: JjChangeRecord;
}

/** Outcome of the hand-off's `jj git fetch`; never fatal. */
export interface JjFetchResult {
  readonly status: 'fetched' | 'no-remote' | 'skipped' | 'failed';
  readonly message: string;
}

/** Options for {@link JjOperations.handoff}. */
export interface JjHandoffOptions {
  /**
   * Explicit integration revset (a user-named revision or bookmark); omit for
   * automatic resolution. It must share real history with this workspace: a
   * destination that only shares jj's empty root commit is refused (the detected
   * stack would otherwise include shared commits).
   */
  readonly destination?: string;
  /**
   * Bottom-most change of this workspace's stack; omit to detect it above the
   * destination. It must be a root of `roots(::@ ~ ::destination)`.
   */
  readonly firstChange?: string;
  /**
   * Local bookmark to move to the rebased tip (only a bookmark this session owns).
   * An existing bookmark is moved only when it points inside the rebased stack; a
   * bookmark on shared history is reported as `bookmarkSkipped` instead.
   */
  readonly bookmark?: string;
  /** Run `jj git fetch` first (default true; a repository without remotes is fine). */
  readonly fetch?: boolean;
}

/** One conflicted change reported by a hand-off. */
export interface JjHandoffConflict {
  readonly changeId: string;
  readonly description: string;
}

/** Result of a bookmark move requested by a hand-off. */
export interface JjHandoffBookmark {
  readonly name: string;
  readonly target: string;
  readonly moved: boolean;
}

/** Result of {@link JjOperations.handoff}: everything the model needs to report or finish. */
export interface JjHandoffResult {
  readonly fetch: JjFetchResult;
  /** Destination revset that was resolved. */
  readonly destination: string;
  readonly destinationSource: JjHandoffTargetSource;
  readonly destinationChangeId: string;
  readonly destinationCommitId: string;
  /** Bottom-most change of the stack (empty when nothing was integrated). */
  readonly firstChangeId: string;
  /**
   * The stack from `firstChangeId` up to and including `@`, newest first.
   *
   * Bounded by `maxLogLimit`; when the listing may be truncated the `message`
   * carries an explicit note instead of implying the whole stack was reported.
   */
  readonly stack: readonly JjChangeRecord[];
  readonly rebased: boolean;
  /** True when the stack already sits directly on the destination and no rebase was needed. */
  readonly alreadyIntegrated: boolean;
  /**
   * True when the stack's base is the destination after this call.
   *
   * False when the workspace is behind the destination (the destination already
   * contains `@`): there is no stack above it to rebase and nothing was changed.
   */
  readonly onTarget: boolean;
  /** Change ids of disconnected stacks when auto-detection was ambiguous. */
  readonly ambiguousRoots: readonly string[];
  readonly conflicts: readonly JjHandoffConflict[];
  /** True when `@` has uncommitted content and must be committed before a hand-off. */
  readonly needsCommit: boolean;
  readonly message: string;
  readonly bookmark?: JjHandoffBookmark;
  /** Why a requested bookmark move was skipped (conflicts, empty stack). */
  readonly bookmarkSkipped?: string;
}

/** Whether an error is jj's "working copy is stale" refusal (another workspace rewrote a shared ancestor). */
function isStaleWorkingCopyFailure(error: unknown): boolean {
  const stderr = error instanceof JjError ? error.detail.stderr : error instanceof Error ? error.message : '';
  return /stale/i.test(stderr) && /workspace update-stale/i.test(stderr);
}

/** Canonical filesystem spelling of one path (realpath when it exists, else the resolved absolute path). */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Decode one `jj workspace list` field printed with the `json(...)` template
 * function (the JSON string literal that `json()` renders).
 *
 * Returns `undefined` for a malformed field so one unparsable line is skipped
 * instead of failing every workspace operation.
 */
function parseWorkspaceField(field: string | undefined): string | undefined {
  if (field === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(field);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-throw a pure template parse failure as the contract `JjError`.
 *
 * `jj-templates` cannot construct `JjError` itself (it must stay free of the
 * subprocess adapter), so its parsers throw {@link TemplateParseError}; this is
 * where the original `JJ_OUTPUT_INVALID` code, message, and detail are restored.
 *
 * @param error - whatever a parser threw.
 * @throws JjError when the error is a template parse failure, else rethrows it.
 */
function contractParseFailure(error: unknown): never {
  if (error instanceof TemplateParseError) {
    throw new JjError('JJ_OUTPUT_INVALID', error.message, {
      argv: error.detail.argv,
      exitCode: 0,
      stderr: error.detail.stderr,
      stdout: error.detail.stdout,
    });
  }
  throw error;
}

/** Parse the first JSON record of a single-revision read; failures become `JjError`. */
function readChangeRecord(stdout: string, argv: readonly string[]): JjChangeRecord {
  try {
    return changeFromRecord(parseJsonLine(stdout, argv));
  } catch (error) {
    contractParseFailure(error);
  }
}

/**
 * Format one `jj op log` timestamp.
 *
 * jj 0.46 serializes `json(self).time` as an object (`{ start, end }`), so the old
 * `String(record.time)` produced the useless literal `[object Object]`. The model
 * needs one parseable instant, so the operation's start time is reported; a plain
 * string shape (other jj builds) is passed through unchanged.
 */
function operationTime(record: Record<string, unknown>): string {
  const value = record['time'];
  if (typeof value === 'string') return value;
  const time = asRecord(value);
  const start = time?.['start'];
  return typeof start === 'string' ? start : '';
}

/** Parse every JSON record of a multi-revision read; failures become `JjError`. */
function readChangeRecords(stdout: string, argv: readonly string[]): JjChangeRecord[] {
  try {
    return parseChangeLines(stdout, argv);
  } catch (error) {
    contractParseFailure(error);
  }
}

/** Every jj-native operation dsh-jj exposes, over one injected runner. */
export class JjOperations {
  readonly config: ResolvedJjConfig;
  private readonly runJj: RunJj;

  constructor(options: { runJj: RunJj; config?: JjPluginConfig }) {
    this.config = resolveConfig(options.config ?? {});
    assertServiceableConfig(this.config);
    this.runJj = options.runJj;
  }

  /** Base jj options shared by every call. */
  private options(cwd: string, argv: readonly string[], signal?: AbortSignal) {
    return {
      cwd,
      argv,
      timeoutMs: this.config.timeoutMs,
      graceMs: this.config.graceMs,
      maxOutputBytes: this.config.maxOutputBytes,
      jjCommand: this.config.jjCommand,
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  private async run(cwd: string, argv: readonly string[], signal?: AbortSignal): Promise<JjRunResult> {
    return await runJjChecked(this.runJj, this.options(cwd, argv, signal), this.config);
  }

  /** `jj log -r @ --no-graph -T <TPL_STATUS>` plus `jj status`. */
  async status(cwd: string, signal?: AbortSignal): Promise<JjStatusResult> {
    const argv = ['log', '-r', '@', '--no-graph', '-T', TPL_STATUS];
    const changeResult = await this.run(cwd, argv, signal);
    const change = readChangeRecord(changeResult.stdout, argv);
    const statusArgv = ['status'];
    const statusResult = await this.run(cwd, statusArgv, signal);
    const raw = statusResult.stdout;
    const bounded = bound(raw, 8 * 1024);
    return {
      change,
      changedPaths: change.paths,
      diffStat: raw.trim(),
      raw: bounded.text,
      truncated: bounded.truncated,
    };
  }

  /** `jj log -r <revset> --no-graph --limit <n> -T <TPL_LOG>`. */
  async log(cwd: string, revset: string, limit: number, signal?: AbortSignal): Promise<readonly JjChangeRecord[]> {
    // Content-reporting reads intentionally snapshot: `jj log -r @` must show the
    // current working-copy content (contract §5.8's --ignore-working-copy applies
    // to metadata reads, which are listed below).
    const argv = ['log', '-r', revset, '--no-graph', '--limit', String(limit), '-T', TPL_LOG];
    const result = await this.run(cwd, argv, signal);
    return readChangeRecords(result.stdout, argv);
  }

  /** `jj diff -r <revset> (--stat|--git) [-- <paths…>]`. */
  async diff(
    cwd: string,
    revset: string,
    format: 'stat' | 'patch',
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean }> {
    const argv = ['diff', '-r', revset, format === 'stat' ? '--stat' : '--git'];
    if (paths.length > 0) argv.push('--', ...paths);
    const result = await this.run(cwd, argv, signal);
    const bounded = bound(result.stdout, this.config.maxOutputBytes);
    return { text: bounded.text, truncated: bounded.truncated };
  }

  /** `jj new [-m <message>] [-- <parent>…]` then read back `@`. */
  async newChange(
    cwd: string,
    parents: readonly string[],
    message: string | undefined,
    signal?: AbortSignal,
  ): Promise<JjChangeRecord> {
    const argv = ['new'];
    if (message !== undefined && message.length > 0) argv.push('-m', message);
    // Model-supplied revsets are positional arguments, not options: `--` keeps a
    // value such as `--help` from being parsed by clap (which exits 0 without
    // creating a change, i.e. a silent no-op reported as success).
    if (parents.length > 0) argv.push('--', ...parents);
    await this.run(cwd, argv, signal);
    return await this.readAt(cwd, signal);
  }

  /**
   * `jj describe -r <revset> -m <message>` then read the described revision back.
   *
   * The revset must resolve to exactly one revision: `jj describe -r 'main..@'`
   * would rewrite the description of every selected change while the read-back only
   * reports one of them, which silently changes history the caller did not name.
   *
   * @param cwd - workspace directory.
   * @param revset - revset that must resolve to a single revision.
   * @param message - new description.
   * @param signal - cancellation signal.
   * @throws JjError `JJ_BAD_INPUT` when the revset selects zero or several revisions.
   */
  async describeChange(cwd: string, revset: string, message: string, signal?: AbortSignal): Promise<JjChangeRecord> {
    const selected = await this.readCommitIds(cwd, revset, signal, 2);
    if (selected.length === 0) {
      throw badInput(
        `jj_describe revset ${JSON.stringify(revset)} does not resolve to a change in this repository; pass exactly one revision such as @ or a change id.`,
      );
    }
    if (selected.length > 1) {
      throw badInput(
        `jj_describe revset ${JSON.stringify(revset)} selects more than one revision; jj would rewrite every one of them. Pass exactly one revision such as @ or a change id.`,
      );
    }
    const argv = ['describe', '-r', revset, '-m', message];
    await this.run(cwd, argv, signal);
    return await this.readAt(cwd, signal, revset);
  }

  /**
   * `jj commit -m <message> [-- <paths…>]` then read the committed change (`@-`)
   * and the new working copy (`@`) **in one log call**.
   *
   * jj commit is describe + new in one step: the current change keeps its content
   * (or only the given paths, which lets a caller split a messy working copy),
   * gets the description, and a new working-copy change becomes `@` (empty unless
   * some changes were left behind). Warnings jj reports on a zero exit (for
   * example a pathspec that matched no file) are returned instead of being
   * discarded, because a silent empty commit would defeat the split workflow.
   *
   * The read-back uses `TPL_STATUS` (not the lightweight `TPL_CHANGE`) because the
   * tools surface `committedPaths`/`workingCopyPaths`, but it reads both revisions
   * in one `jj log -r '@ | @-'` instead of two separate spawns.
   *
   * @param cwd - workspace directory.
   * @param message - non-empty description; callers are expected to follow the repository style.
   * @param paths - optional repository-relative paths to commit only part of the working copy.
   * @param signal - cancellation signal.
   */
  async commit(cwd: string, message: string, paths: readonly string[], signal?: AbortSignal): Promise<JjCommitResult> {
    if (message.trim().length === 0) {
      throw badInput('jj_commit needs a non-empty description that follows the repository commit style.');
    }
    for (const path of paths) {
      if (path.trim().length === 0 || path.startsWith('-')) {
        throw badInput('paths must be non-empty and must not start with "-".');
      }
    }
    // A pathspec would otherwise be parsed as an option; `--` ends option parsing.
    const argv = ['commit', '-m', message, ...(paths.length > 0 ? ['--', ...paths] : [])];
    const commitResult = await this.run(cwd, argv, signal);
    const warnings: string[] = [];
    // jj writes progress ("Working copy now at: …") to stderr as well; only real
    // warning lines are surfaced to the model.
    const warningLines = commitResult.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('Warning:'));
    if (warningLines.length > 0) warnings.push(bound(warningLines.join('\n'), 2 * 1024).text);
    const records = await this.readChangesAt(cwd, '@ | @-', TPL_STATUS, signal);
    const workingCopy = records.find((change) => change.currentWorkingCopy);
    const committed = records.find((change) => !change.currentWorkingCopy);
    if (workingCopy === undefined || committed === undefined) {
      throw new JjError(
        'JJ_OUTPUT_INVALID',
        `\`jj log -r '@ | @-'\` did not report both the committed change and the new working copy (${records.length} record(s)).`,
        { argv, exitCode: 0, stderr: commitResult.stderr, stdout: '' },
      );
    }
    if (paths.length > 0 && committed.empty) {
      warnings.push(
        'No changes matched the given paths, so the committed change is empty; the working copy still holds the changes. Check that the paths are repository-relative.',
      );
    }
    return { committed, workingCopy, warnings };
  }

  /**
   * Full descriptions selected by a revset, newest first (`TPL_DESCRIPTION`).
   *
   * This is the commit-style sampler: `TPL_LOG` only exposes the subject line,
   * but callers may want to show body/footer conventions as well.
   *
   * @param cwd - workspace directory.
   * @param revset - revisions to read.
   * @param limit - maximum number of records to read.
   * @param signal - cancellation signal.
   */
  async descriptionSamples(
    cwd: string,
    revset: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const argv = ['log', '-r', revset, '--no-graph', '--limit', String(limit), '-T', TPL_DESCRIPTION];
    const result = await this.run(cwd, argv, signal);
    const descriptions: string[] = [];
    const lines = result.stdout.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        descriptions.push(typeof parsed === 'string' ? parsed : String(parsed));
      } catch (error) {
        // A bounded output stream is cut at an arbitrary byte boundary. DSH's
        // collected output keeps the TAIL, so the partial record is the FIRST line
        // and the complete records follow it; runners that keep the head cut the
        // LAST line instead. A style sample is best-effort: skip the partial head
        // and stop after a partial tail, but never hide unexpected invalid output.
        if (result.truncated && index === 0) continue;
        if (result.truncated && index === lines.length - 1) break;
        throw new JjError(
          'JJ_OUTPUT_INVALID',
          `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`,
          {
            argv,
            exitCode: 0,
            stderr: error instanceof Error ? error.message : '',
            stdout: bound(result.stdout, 512).text,
          },
        );
      }
    }
    return descriptions;
  }

  /** `jj squash --from <from> --into <into> [-m msg | --use-destination-message]`. */
  async squash(
    cwd: string,
    from: string,
    into: string,
    message: string | undefined,
    useDestinationMessage: boolean,
    signal?: AbortSignal,
  ): Promise<JjChangeRecord> {
    if (message !== undefined && useDestinationMessage) {
      throw badInput('message and useDestinationMessage are mutually exclusive; pass only one.');
    }
    if (message === undefined && !useDestinationMessage) {
      // Contract §5.9/§7.3.6: never let jj open an editor for a headless tool call.
      throw badInput(
        'jj_squash needs a message path: pass -m <message> or useDestinationMessage: true (jj would otherwise open an editor).',
      );
    }
    const argv = ['squash', '--from', from, '--into', into];
    if (message !== undefined) argv.push('-m', message);
    if (useDestinationMessage) argv.push('--use-destination-message');
    await this.run(cwd, argv, signal);
    return await this.readAt(cwd, signal);
  }

  /** `jj undo` or `jj op restore <operationId>`; records the head operation first. */
  async undo(cwd: string, operationId: string | undefined, signal?: AbortSignal): Promise<JjUndoResult> {
    if (operationId !== undefined && !OPERATION_ID_RE.test(operationId)) {
      throw badInput('operationId must be a hexadecimal operation id prefix (4-128 characters) as shown by jj_op_log.');
    }
    // Deliberately reads the head *with* its leading snapshot: `jj undo` undoes the
    // snapshot operation this read creates (when the working copy has unsnapshotted
    // changes), so that operation is the exact rollback target named below.
    const headOperationId = await this.readHeadOperationId(cwd, signal, true);
    const argv = operationId === undefined ? ['undo'] : ['op', 'restore', operationId];
    const result = await this.run(cwd, argv, signal);
    const rollbackHint =
      headOperationId === undefined
        ? 'dsh-jj could not read the head operation id; if you need to roll back this undo, inspect the operation log (jj_op_log) and pass the target operation id to jj_undo.'
        : `head operation before this call: ${headOperationId} — to roll back, run \`jj op restore ${headOperationId}\` (a second \`jj undo\` would undo this undo, not redo it).`;
    const message = [bound(result.stdout.trim(), 2 * 1024).text, rollbackHint]
      .filter((line) => line.length > 0)
      .join('\n');
    return {
      mode: operationId === undefined ? 'undo' : 'restore',
      operationId: operationId ?? headOperationId ?? 'unknown',
      headOperationId: headOperationId ?? 'unknown',
      message,
    };
  }

  /**
   * `jj op log -n 1 --no-graph -T 'self.id()'` — the self-protection step
   * (contract §8.3b).
   *
   * The guard calls this before every shell command, so the public entry reads with
   * `--ignore-working-copy`: a plain `jj op log` would snapshot the working copy and
   * create an operation on every call (polluting the operation log and changing the
   * rollback target). `undo()` opts into the snapshot with `snapshot: true` because
   * it needs the exact operation its own `jj undo` is about to undo.
   *
   * @param cwd - workspace directory.
   * @param signal - cancellation signal.
   * @param snapshot - allow jj to snapshot the working copy before reading.
   * @returns the newest recorded operation id, or `undefined` when it cannot be read.
   */
  private async readHeadOperationId(cwd: string, signal?: AbortSignal, snapshot = false): Promise<string | undefined> {
    try {
      const argv = [
        'op',
        'log',
        '-n',
        '1',
        '--no-graph',
        ...(snapshot ? [] : ['--ignore-working-copy']),
        '-T',
        'self.id()',
      ];
      const result = await this.runJj(this.options(cwd, argv, signal));
      const id = result.stdout.trim().split('\n')[0]?.trim();
      return id !== undefined && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /** `jj op log -n 1 --no-graph -T 'self.id()'`; `'unknown'` when unreadable (compat API). */
  async headOperationId(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.readHeadOperationId(cwd, signal)) ?? 'unknown';
  }

  /** `jj op log -n <n> --no-graph -T 'json(self) ++ "\n"'`. */
  async opLog(cwd: string, limit: number, signal?: AbortSignal): Promise<readonly JjOperation[]> {
    const argv = ['op', 'log', '-n', String(limit), '--ignore-working-copy', '--no-graph', '-T', TPL_OP_LOG];
    const result = await this.run(cwd, argv, signal);
    const operations: JjOperation[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      let record: Record<string, unknown> | undefined;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        throw new JjError(
          'JJ_OUTPUT_INVALID',
          `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`,
          {
            argv,
            exitCode: 0,
            stderr: '',
            stdout: bound(result.stdout, 512).text,
          },
        );
      }
      if (record === undefined) continue;
      const id = String(record['id'] ?? '');
      const attributes = asRecord(record['attributes']) ?? {};
      operations.push({
        id,
        shortId: id.slice(0, 12),
        description: String(record['description'] ?? ''),
        time: operationTime(record),
        user: `${String(record['username'] ?? '')}@${String(record['hostname'] ?? '')}`,
        workspaceName:
          record['workspace_name'] === null || record['workspace_name'] === undefined
            ? null
            : String(record['workspace_name']),
        isSnapshot: record['is_snapshot'] === true,
        tags: Object.keys(attributes),
      });
    }
    return operations;
  }

  /** `jj workspace add <path> [--name n] [-r r]… [-m m] [--colocate]`, then read the workspace back. */
  async workspaceAdd(
    cwd: string,
    path: string,
    name: string | undefined,
    parents: readonly string[],
    message: string | undefined,
    colocate: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<JjWorkspaceAddResult> {
    if (path.trim().length === 0 || path.startsWith('-')) {
      throw badInput('path must be a non-empty path that does not start with "-".');
    }
    // The trimmed path is the one that is validated and spawned: passing the raw
    // value (` /root/x `) made jj fail with "Cannot access <cwd>/ <path>" and the
    // error was then mis-classified as a broken repository.
    const trimmedPath = path.trim();
    // Always pass an explicit name: the created workspace is then resolved by exact
    // name instead of jj's list order, so callers (the tools layer records session
    // ownership) can never register a different workspace by mistake.
    const requestedName = name !== undefined && name.length > 0 ? name : basename(trimmedPath);
    const argv = ['workspace', 'add', trimmedPath];
    if (requestedName.length > 0) argv.push('--name', requestedName);
    for (const parent of parents) argv.push('-r', parent);
    if (message !== undefined && message.length > 0) argv.push('-m', message);
    if (colocate === true) argv.push('--colocate');
    await this.run(cwd, argv, signal);

    const workspaces = await this.workspaceList(cwd, signal);
    const requestedRoot = canonicalPath(resolve(cwd, trimmedPath));
    const created =
      workspaces.find((workspace) => workspace.name === requestedName) ??
      workspaces.find((workspace) => canonicalPath(workspace.root) === requestedRoot);
    if (created === undefined) {
      throw new JjError(
        'JJ_OUTPUT_INVALID',
        `\`jj workspace add\` did not report a workspace named ${JSON.stringify(requestedName)} for ${path}.`,
        { argv, exitCode: 0, stderr: '', stdout: '' },
      );
    }
    const change = await this.readAt(created.root, signal);
    return { path: created.root, name: created.name, change };
  }

  /**
   * `jj workspace list -T '<JSON name>\t<JSON root>\n'`; roots are absolute.
   *
   * Both fields are JSON-encoded because jj 0.46 decorates names that need quoting
   * (`my session` → `"my session"`) when the template prints the bare `name`, which
   * made `workspaceAdd` return a quoted name and the session-ownership comparison in
   * `jj_workspace_cleanup` fail. JSON also keeps names containing a literal tab
   * parseable (the tab is escaped inside the JSON string, not printed raw).
   */
  async workspaceList(cwd: string, signal?: AbortSignal): Promise<readonly { name: string; root: string }[]> {
    const argv = ['workspace', 'list', '--ignore-working-copy', '-T', TPL_WORKSPACE_LIST_TAB];
    const result = await this.run(cwd, argv, signal);
    const workspaces: { name: string; root: string }[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const fields = line.split('\t');
      const name = parseWorkspaceField(fields[0]);
      const root = parseWorkspaceField(fields[1]);
      if (name === undefined || root === undefined) continue;
      // jj lists non-current workspaces relative to the current directory; every
      // caller needs a usable absolute path (the cleanup tool moves the session there).
      const absoluteRoot = isAbsolute(root) ? root : resolve(cwd, root);
      workspaces.push({ name, root: absoluteRoot });
    }
    return workspaces;
  }

  /**
   * `jj workspace forget <name>`.
   *
   * Unregisters one working copy without touching the shared commit graph (the
   * directory and its files stay on disk, but jj stops treating it as a working
   * copy). Callers must run this from a *different* workspace than the one being
   * forgotten and own the target: the `jj_workspace_cleanup` tool enforces both,
   * the shell guard keeps denying raw `jj workspace forget <other>` commands.
   *
   * @param cwd - directory to run jj in (the surviving workspace).
   * @param name - exact workspace name from `jj workspace list`.
   * @param signal - cancellation signal.
   * @returns bounded jj output.
   */
  async workspaceForget(cwd: string, name: string, signal?: AbortSignal): Promise<string> {
    if (name.trim().length === 0 || name.trim().startsWith('-')) {
      throw badInput('workspace name must be non-empty and must not start with "-".');
    }
    const argv = ['workspace', 'forget', name.trim()];
    const result = await this.run(cwd, argv, signal);
    return bound(result.stdout.trim() || result.stderr.trim(), 1024).text;
  }

  /** `jj bookmark list [--all-remotes] -T 'json(self) ++ "\n"'`. */
  async bookmarkList(
    cwd: string,
    allRemotes: boolean,
    signal?: AbortSignal,
  ): Promise<readonly { name: string; target: string; remote: string | null }[]> {
    const argv = ['bookmark', 'list', '--ignore-working-copy'];
    if (allRemotes) argv.push('--all-remotes');
    argv.push('-T', TPL_BOOKMARK_LIST);
    const result = await this.run(cwd, argv, signal);
    const bookmarks: { name: string; target: string; remote: string | null }[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      let record: Record<string, unknown> | undefined;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        throw new JjError(
          'JJ_OUTPUT_INVALID',
          `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`,
          {
            argv,
            exitCode: 0,
            stderr: '',
            stdout: bound(result.stdout, 512).text,
          },
        );
      }
      if (record === undefined) continue;
      const target = Array.isArray(record['target']) ? record['target'] : [];
      bookmarks.push({
        name: String(record['name'] ?? ''),
        target: target.length > 0 ? String(target[0]) : '',
        remote: record['remote'] === undefined || record['remote'] === null ? null : String(record['remote']),
      });
    }
    return bookmarks;
  }

  /**
   * `jj bookmark set <name> -r <revset> [--allow-backwards]`, then read the target back.
   *
   * @param knownTargetCommitId - commit id the revset is known to resolve to (the
   *   hand-off passes the tip commit id of the change it just read). When supplied,
   *   the read-back `jj bookmark list` is skipped: a zero exit from
   *   `jj bookmark set` guarantees the bookmark points at that revision.
   * @param existingTarget - the bookmark's current target commit id, or `null` when
   *   the caller already listed the bookmarks and knows it does not exist. When
   *   supplied, the pre-set `jj bookmark list` is skipped as well (the hand-off lists
   *   once to check ownership before moving anything).
   */
  async bookmarkSet(
    cwd: string,
    name: string,
    revset: string,
    allowBackwards: boolean,
    signal?: AbortSignal,
    knownTargetCommitId?: string,
    existingTarget?: string | null,
  ): Promise<{ name: string; target: string; moved: boolean }> {
    if (!BOOKMARK_NAME_RE.test(name) || name.includes('@')) {
      throw badInput("bookmark names must be non-empty and must not contain whitespace or '@'.");
    }
    let existing = existingTarget !== null;
    if (existingTarget === undefined) {
      const before = await this.bookmarkList(cwd, false, signal);
      existing = before.find((bookmark) => bookmark.name === name) !== undefined;
    }
    const argv = ['bookmark', 'set', name, '-r', revset];
    if (allowBackwards) argv.push('--allow-backwards');
    await this.run(cwd, argv, signal);
    let target = knownTargetCommitId ?? '';
    if (knownTargetCommitId === undefined) {
      const after = await this.bookmarkList(cwd, false, signal);
      target = after.find((bookmark) => bookmark.name === name)?.target ?? '';
    }
    return { name, target, moved: existing };
  }

  /**
   * `jj rebase (-r|-s|-b) <revision> -d <destination>`.
   *
   * jj 0.46 distinguishes the selection modes sharply: `-r` moves only the named
   * revisions and leaves their descendants behind (re-parented onto the old
   * parents), while `-s` moves the revision together with all of its descendants.
   * Moving a whole stack (the multi-session hand-off) therefore needs
   * `mode: 'source'`; the default stays `revisions` to preserve existing callers.
   *
   * The literal `trunk()` destination gets one preflight: in a repository without
   * a fetched remote main it resolves to jj's empty root commit, and jj's raw
   * revset error reads like a typo instead of the real cause. The model gets an
   * actionable message instead (and `jj_handoff` never has this problem because it
   * resolves the target with fallbacks).
   */
  async rebase(
    cwd: string,
    revision: string,
    destination: string,
    signal?: AbortSignal,
    mode: JjRebaseMode = 'revisions',
  ): Promise<string> {
    if (destination.trim() === 'trunk()') {
      const trunk = await this.tryReadAt(cwd, destination, signal);
      if (trunk !== undefined && isRootCommitId(trunk.commitId)) {
        throw badInput(
          "`trunk()` resolves to jj's empty root commit here: this repository has no fetched remote main (local main/master bookmarks do not define trunk()). Pass a real destination such as `main` or a change id, or call jj_handoff, which resolves the integration target automatically.",
        );
      }
    }
    const flag = REBASE_MODE_FLAGS[mode] ?? '-r';
    const argv = ['rebase', flag, revision, '-d', destination];
    const result = await this.run(cwd, argv, signal);
    // jj prints the "Rebased N commits…" status on stderr even on success, so fall
    // back to it when stdout is empty; the model gets a real result summary.
    return bound(result.stdout.trim() || result.stderr.trim(), 2 * 1024).text;
  }

  /** `jj workspace update-stale` — recovery after another workspace rewrote a shared ancestor. */
  async updateStale(cwd: string, signal?: AbortSignal): Promise<string> {
    const argv = ['workspace', 'update-stale'];
    const result = await this.run(cwd, argv, signal);
    return bound(result.stdout.trim() || result.stderr.trim(), 1024).text;
  }

  /**
   * `jj git fetch`, classified instead of thrown: a local-only repository has no
   * remote and that is a normal state for a hand-off, not an error. Aborts and
   * timeouts still surface because the caller asked to stop.
   */
  async fetch(cwd: string, signal?: AbortSignal): Promise<JjFetchResult> {
    try {
      const result = await this.run(cwd, ['git', 'fetch'], signal);
      const text = bound(
        [result.stdout.trim(), result.stderr.trim()].filter((line) => line.length > 0).join('\n'),
        1024,
      ).text;
      return {
        status: 'fetched',
        message: text.length > 0 ? text : 'jj git fetch completed with nothing new to fetch.',
      };
    } catch (error) {
      // Stale working copies are retried by the hand-off wrapper after recovery;
      // abort/timeout still win because the caller asked to stop.
      if (isStaleWorkingCopyFailure(error)) throw error;
      if (error instanceof JjError && (error.code === 'JJ_ABORTED' || error.code === 'JJ_TIMEOUT')) throw error;
      const detail =
        error instanceof JjError ? error.detail.stderr : error instanceof Error ? error.message : String(error);
      if (/No git remotes to fetch from|No matching remotes/i.test(detail)) {
        return {
          status: 'no-remote',
          message: 'This repository has no git remote to fetch from; continuing with the local targets.',
        };
      }
      return {
        status: 'failed',
        message: `jj git fetch failed; continuing with the local targets. ${bound(detail, 512).text}`,
      };
    }
  }

  /**
   * Resolve the integration destination for a hand-off.
   *
   * Order: the explicit `destination` when the model/user named one, otherwise the
   * configured `rebaseTarget` (default `trunk()`), then `trunk()`, local `main`,
   * and local `master`. A candidate counts only when the revset resolves to a real
   * commit: jj's empty root commit (the usual `trunk()` result in a local-only
   * repository) is skipped so the model never has to ask the user which revision
   * to use. Only when every candidate fails does the error ask for a target.
   *
   * @param cwd - workspace directory.
   * @param options - explicit destination (optional) and the configured rebase target.
   * @param signal - cancellation signal.
   * @returns the first usable target with its provenance.
   * @throws JjError `JJ_BAD_INPUT` when the explicit revset is invalid or no target exists.
   */
  async resolveHandoffTarget(
    cwd: string,
    options: { readonly destination?: string; readonly configured: string },
    signal?: AbortSignal,
  ): Promise<JjHandoffTarget> {
    const requested = options.destination?.trim();
    const candidates: { revset: string; source: JjHandoffTargetSource }[] = [];
    if (requested !== undefined && requested.length > 0) {
      candidates.push({ revset: requested, source: 'argument' });
    } else {
      candidates.push({ revset: options.configured, source: 'configured' });
    }
    candidates.push(
      { revset: 'trunk()', source: 'trunk' },
      { revset: 'main', source: 'main' },
      { revset: 'master', source: 'master' },
    );

    const seen = new Set<string>();
    const rootOnly: string[] = [];
    const unresolved: string[] = [];
    // Bookmark names are only needed for actionable *errors*: resolving a target must
    // not pay for an extra `jj bookmark list` on the happy path.
    let bookmarkHintPromise: Promise<string> | undefined;
    const bookmarkHint = async (): Promise<string> => {
      bookmarkHintPromise ??= this.localBookmarkNames(cwd, signal).then((names) =>
        names.length > 0 ? names.join(', ') : 'none',
      );
      return await bookmarkHintPromise;
    };
    for (const candidate of candidates) {
      if (seen.has(candidate.revset)) continue;
      seen.add(candidate.revset);
      const change = await this.tryReadAt(cwd, candidate.revset, signal);
      if (change === undefined) {
        if (candidate.source === 'argument') {
          const hint = await bookmarkHint();
          throw badInput(
            `jj_handoff cannot use destination ${JSON.stringify(candidate.revset)}: the revset does not resolve in this repository. Pass a real revision (local bookmarks: ${hint}), or omit destination to let jj_handoff resolve the target with fallbacks.`,
          );
        }
        unresolved.push(`${candidate.revset} (${candidate.source})`);
        continue;
      }
      if (isRootCommitId(change.commitId)) {
        // An explicitly named root commit is a model mistake, not a signal to
        // silently integrate somewhere else; the fallbacks only rescue defaults.
        if (candidate.source === 'argument') {
          const hint = await bookmarkHint();
          throw badInput(
            `jj_handoff destination ${JSON.stringify(candidate.revset)} resolves to jj's empty root commit (there is no remote trunk here). Pass a real revision such as a local bookmark (${hint}), or omit destination to let jj_handoff pick the target automatically.`,
          );
        }
        rootOnly.push(`${candidate.revset} (${candidate.source})`);
        continue;
      }
      return { ...candidate, change };
    }
    const details: string[] = [];
    if (rootOnly.length > 0) details.push(`resolved to jj's empty root commit: ${rootOnly.join(', ')}`);
    if (unresolved.length > 0) details.push(`did not resolve: ${unresolved.join(', ')}`);
    const hint = await bookmarkHint();
    throw badInput(
      `jj_handoff found no usable integration target — ${details.length > 0 ? details.join('; ') : 'no candidate was tried'}. Local bookmarks: ${hint}. Ask the user which revision to integrate onto, pass it as destination, and call jj_handoff again.`,
    );
  }

  /**
   * Integrate this workspace's change stack onto a base revision.
   *
   * One call does the whole end-of-work hand-off so the model does not have to
   * chain raw jj commands (and hand control back to the user when one of them
   * fails): fetch (skipped/ignored when there is no remote), resolve the target
   * deterministically, detect the stack above it, move the whole stack with
   * `jj rebase -s`, recover a stale working copy once, report every conflicted
   * change, and optionally move an owned bookmark to the rebased tip.
   *
   * It never decides content: conflicts are reported for the model to resolve (the
   * same workspace is then handed off again to verify). A non-empty `@` is reported
   * as `needsCommit` so the model commits with `jj_commit` first instead of the
   * change being folded into the rebase.
   *
   * Safety invariants (A2 audit):
   * - the destination must share real history with the workspace (a destination
   *   unrelated except for jj's empty root commit is refused, because
   *   `roots(::@ ~ ::target)` would then name shared commits and a source-mode
   *   rebase would rewrite them);
   * - a destination that resolves to `@` is a model mistake and is rejected;
   * - when every ancestor of `@` is already contained in the destination the
   *   workspace is *behind* it: the result reports `onTarget: false` and nothing is
   *   rebased instead of claiming a verified integration.
   *
   * @param cwd - workspace directory.
   * @param options - destination/firstChange/bookmark/fetch options.
   * @param signal - cancellation signal.
   * @returns the full hand-off report.
   */
  async handoff(cwd: string, options: JjHandoffOptions = {}, signal?: AbortSignal): Promise<JjHandoffResult> {
    try {
      return await this.handoffFlow(cwd, options, signal);
    } catch (error) {
      if (!isStaleWorkingCopyFailure(error)) throw error;
      // A stale working copy fails *every* content read, including the target and
      // stack detection above, so recovery must wrap the whole flow and retry it
      // once instead of leaving the user to run workspace update-stale.
      await this.updateStale(cwd, signal);
      return await this.handoffFlow(cwd, options, signal);
    }
  }

  /** One hand-off attempt; {@link handoff} retries it once after stale recovery. */
  private async handoffFlow(cwd: string, options: JjHandoffOptions, signal?: AbortSignal): Promise<JjHandoffResult> {
    // Cheap check first: with uncommitted changes the model must commit before any
    // hand-off step, so neither the network fetch nor the target probes are paid for.
    const workingCopy = await this.readAt(cwd, signal);
    if (!workingCopy.empty) {
      return {
        fetch:
          options.fetch === false
            ? { status: 'skipped', message: 'jj git fetch was disabled for this call.' }
            : { status: 'skipped', message: 'jj git fetch was skipped because the working copy needs a commit first.' },
        destination: '',
        destinationSource: 'configured',
        destinationChangeId: '',
        destinationCommitId: '',
        firstChangeId: '',
        stack: [workingCopy],
        rebased: false,
        alreadyIntegrated: false,
        onTarget: false,
        ambiguousRoots: [],
        conflicts: [],
        needsCommit: true,
        message:
          "The working copy has uncommitted changes. Commit them first with jj_commit (description following this repository's style), then call jj_handoff again.",
      };
    }

    // A bookmark request is validated before the fetch/rebase: jj rejects invalid
    // names (whitespace, '@', leading '-') and used to fail *after* the rebase had
    // already rewritten the workspace, so the model saw an error for work that had
    // actually been done.
    const requestedBookmark = options.bookmark?.trim();
    if (requestedBookmark !== undefined && requestedBookmark.length > 0) {
      if (!BOOKMARK_NAME_RE.test(requestedBookmark) || requestedBookmark.includes('@')) {
        throw badInput("bookmark names must be non-empty and must not contain whitespace or '@'.");
      }
    }

    const fetchResult: JjFetchResult =
      options.fetch === false
        ? { status: 'skipped', message: 'jj git fetch was disabled for this call.' }
        : await this.fetch(cwd, signal);
    const target = await this.resolveHandoffTarget(
      cwd,
      {
        ...(options.destination !== undefined ? { destination: options.destination } : {}),
        configured: this.config.rebaseTarget,
      },
      signal,
    );
    // The destination must be a *base* the stack can sit on, never `@` itself:
    // `roots(::@ ~ ::@)` is empty, which used to be reported as a verified
    // "already integrated" hand-off while nothing had been verified at all.
    if (target.change.changeId === workingCopy.changeId) {
      throw badInput(
        `jj_handoff destination ${JSON.stringify(target.revset)} resolves to this workspace's own working copy @: @ is not an integration base. Pass the revision the stack should sit on (for example a local bookmark), or omit destination to let jj_handoff resolve the target with fallbacks.`,
      );
    }

    const base: JjHandoffResult = {
      fetch: fetchResult,
      destination: target.revset,
      destinationSource: target.source,
      destinationChangeId: target.change.changeId,
      destinationCommitId: target.change.commitId,
      firstChangeId: '',
      stack: [],
      rebased: false,
      alreadyIntegrated: false,
      onTarget: false,
      ambiguousRoots: [],
      conflicts: [],
      needsCommit: false,
      message: '',
    };

    const roots = await this.stackRoots(cwd, target.revset, signal);
    const explicitFirst = options.firstChange?.trim();
    if (roots.length === 0) {
      // `roots(::@ ~ ::target)` is empty only when every ancestor of `@` is already
      // an ancestor of the destination: the workspace is *behind* the target (the
      // target already contains `@`), not stacked on it. Reporting
      // `alreadyIntegrated`/`onTarget` here was a false verified success, and a
      // rebase of the (empty) stack would have been the wrong update anyway.
      return {
        ...base,
        message: `This workspace is behind ${target.revset}: the destination already contains this workspace's changes, so there is no stack above it to rebase and nothing was changed. Inspect the history with jj_log; moving the workspace onto the destination is a separate decision the user must confirm.`,
        ...(requestedBookmark !== undefined && requestedBookmark.length > 0
          ? {
              bookmarkSkipped: `Bookmark ${requestedBookmark} was not moved because the workspace is behind the destination and nothing was rebased.`,
            }
          : {}),
      };
    }

    let first: JjChangeRecord;
    if (explicitFirst !== undefined && explicitFirst.length > 0) {
      const ancestor = await this.tryReadAt(cwd, `(${explicitFirst}) & ::@`, signal);
      if (ancestor === undefined) {
        throw badInput(
          `jj_handoff firstChange ${JSON.stringify(explicitFirst)} is not a change in this workspace's working-copy ancestry. Pass the bottom-most change id this session created (inspect jj_log if needed).`,
        );
      }
      // The explicit value must name the bottom of this workspace's stack: a middle
      // change or `@` would move only part of the work (or the empty working copy)
      // and report a false "verified" success while the session's commits stay behind.
      if (!roots.some((root) => root.changeId === ancestor.changeId)) {
        // An unrelated destination makes `roots` name shared history rather than this
        // workspace's commits; explain that instead of recommending a foreign change
        // (following such a recommendation was how the audit rewrote `main`).
        await this.assertDestinationCoversBase(cwd, target.revset, signal);
        throw badInput(
          `jj_handoff firstChange ${JSON.stringify(explicitFirst)} is not the bottom of this workspace's stack above ${target.revset}. Pass one of: ${roots.map((change) => `${change.changeId} (${change.description || 'no description'})`).join(', ')}, or omit firstChange to let jj_handoff pick the single stack automatically.`,
        );
      }
      first = ancestor;
    } else if (roots.length > 1) {
      return {
        ...base,
        ambiguousRoots: roots.map((change) => change.changeId),
        message: `This workspace has ${roots.length} disconnected stacks above ${target.revset}. Pass firstChange with the bottom-most change of one stack (candidates: ${roots.map((change) => change.changeId).join(', ')}).`,
      };
    } else {
      first = roots[0] as JjChangeRecord;
    }

    const parentCommitId = await this.parentCommitId(cwd, first.changeId, signal);
    if (parentCommitId !== undefined && parentCommitId === target.change.commitId) {
      const stack = await this.stackFrom(cwd, first.changeId, signal);
      const conflicts = this.conflictsIn(stack);
      const bookmarkOutcome = await this.moveRequestedBookmark(
        cwd,
        options.bookmark,
        stack,
        conflicts,
        signal,
        first.changeId,
      );
      return {
        ...base,
        firstChangeId: first.changeId,
        stack,
        alreadyIntegrated: true,
        onTarget: true,
        conflicts,
        message: `The stack is already based directly on ${target.revset}; no rebase was needed.${this.stackTruncationNote(stack)}`,
        ...bookmarkOutcome,
      };
    }

    // Fail closed before any rewrite when the destination does not extend the
    // history this workspace was based on: `roots()` above would then name shared
    // commits (the pre-session history just above the empty root commit) and a
    // source-mode rebase would rewrite trunk history (A2-F1).
    await this.assertStackNotShared(cwd, first.changeId, requestedBookmark, signal);
    await this.assertDestinationCoversBase(cwd, target.revset, signal);

    const message = await this.rebase(cwd, first.changeId, target.revset, signal, 'source');
    const stack = await this.stackFrom(cwd, first.changeId, signal);
    const conflicts = this.conflictsIn(stack);
    const rebasedParentCommitId = await this.parentCommitId(cwd, first.changeId, signal);
    const onTarget = rebasedParentCommitId !== undefined && rebasedParentCommitId === target.change.commitId;
    const bookmarkOutcome = await this.moveRequestedBookmark(
      cwd,
      options.bookmark,
      stack,
      conflicts,
      signal,
      first.changeId,
    );

    return {
      ...base,
      firstChangeId: first.changeId,
      stack,
      rebased: true,
      onTarget,
      conflicts,
      message: `${message}${this.stackTruncationNote(stack)}`,
      ...bookmarkOutcome,
    };
  }

  /**
   * Model-facing note when the reported hand-off stack may be cut off by
   * `maxLogLimit` (A2-F10): the `stack` array is bounded by the configured log
   * limit, so a very large stack would otherwise be reported as complete.
   */
  private stackTruncationNote(stack: readonly JjChangeRecord[]): string {
    if (stack.length < this.config.maxLogLimit) return '';
    return ` The stack listing is capped at maxLogLimit=${this.config.maxLogLimit} changes, so changes below that cap are not listed; inspect the full stack with jj_log.`;
  }

  /**
   * Apply the optional bookmark move shared by every hand-off exit path.
   *
   * Keeping this in one place means the already-integrated paths report the same
   * bookmark outcome as a fresh rebase instead of silently dropping the request.
   *
   * A bookmark that already exists is only moved when it points inside the stack
   * being integrated (`firstChangeId::@`): a bookmark on shared history (for example
   * the shared trunk `main`) must not be dragged to the session tip by a model
   * mistake (A2-F4). Such a request is reported as `bookmarkSkipped`, not as failure.
   *
   * @param cwd - workspace directory.
   * @param requested - bookmark name requested by the caller, when any.
   * @param stack - the integrated stack (newest first).
   * @param conflicts - conflicted changes in the stack.
   * @param signal - cancellation signal.
   * @param firstChangeId - bottom-most change of the stack, used for the ownership check.
   */
  private async moveRequestedBookmark(
    cwd: string,
    requested: string | undefined,
    stack: readonly JjChangeRecord[],
    conflicts: readonly JjHandoffConflict[],
    signal?: AbortSignal,
    firstChangeId?: string,
  ): Promise<{ bookmark?: JjHandoffBookmark; bookmarkSkipped?: string }> {
    const name = requested?.trim();
    if (name === undefined || name.length === 0) return {};
    if (conflicts.length > 0) {
      return {
        bookmarkSkipped: `Bookmark ${name} was left in place because the stack has conflicts; resolve them and call jj_handoff again with the same bookmark.`,
      };
    }
    const tip = this.bookmarkTip(stack);
    if (tip === undefined) {
      return { bookmarkSkipped: 'The stack has no content change to point a bookmark at.' };
    }
    try {
      const bookmarks = await this.bookmarkList(cwd, false, signal);
      const existing = bookmarks.find((bookmark) => bookmark.name === name && bookmark.remote === null);
      if (existing !== undefined && existing.target.length > 0 && firstChangeId !== undefined) {
        const inside = await this.readCommitIds(cwd, `(${existing.target}) & ((${firstChangeId})::@)`, signal, 1);
        if (inside.length === 0) {
          return {
            bookmarkSkipped: `Bookmark ${name} points at ${existing.target.slice(0, 12)}, which is outside this workspace's stack, so it looks like shared history: jj_handoff does not move it. Report the rebased stack instead; the user can move that bookmark explicitly if it really belongs to this session.`,
          };
        }
      }
      return {
        bookmark: await this.bookmarkSet(
          cwd,
          name,
          tip.changeId,
          false,
          signal,
          tip.commitId,
          existing === undefined ? null : existing.target,
        ),
      };
    } catch (error) {
      // The rebase already happened: a failed bookmark move must not turn the whole
      // hand-off into an error, because retrying would claim the (already applied)
      // rebase failed. Report the bookmark problem next to the successful result.
      if (error instanceof JjError && (error.code === 'JJ_ABORTED' || error.code === 'JJ_TIMEOUT')) throw error;
      const detail =
        error instanceof JjError
          ? error.detail.stderr.trim() || error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        bookmarkSkipped: `Bookmark ${name} was not moved: ${bound(detail, 512).text} The rebase result above is still valid; fix the bookmark name or move it manually.`,
      };
    }
  }

  /** Bottom-most change(s) of this workspace's stack above `target` (`roots(::@ ~ ::target)`). */
  private async stackRoots(cwd: string, target: string, signal?: AbortSignal): Promise<readonly JjChangeRecord[]> {
    return await this.log(cwd, `roots(::@ ~ ::(${target}))`, 32, signal);
  }

  /**
   * Refuse to source-mode rebase a selection that contains shared (bookmarked) history.
   *
   * jj has no per-workspace ownership metadata, so the only durable signal for
   * "commit already published / owned by another workspace or the user" is a local
   * bookmark: rewriting its history is what broke shared trunks (A2-F1). A bookmark
   * explicitly passed as the hand-off's `bookmark` is the one exception — it is the
   * session's own pointer and the hand-off is about to move it — and only when it
   * points strictly inside the stack being moved (a bookmark pointing at shared
   * history is not moved, F4).
   *
   * @param cwd - workspace directory.
   * @param first - bottom-most change of the stack about to be moved.
   * @param requestedBookmark - bookmark the caller asked to move, when any.
   * @param signal - cancellation signal.
   * @throws JjError `JJ_BAD_INPUT` when the moving set contains other bookmarked commits.
   */
  private async assertStackNotShared(
    cwd: string,
    first: string,
    requestedBookmark: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const movingSet = `((${first})::@)`;
    const offenders = await this.readCommitIds(cwd, `${movingSet} & ::bookmarks()`, signal, 1);
    if (offenders.length === 0) return;
    const requested = requestedBookmark?.trim();
    if (requested !== undefined && requested.length > 0 && SAFE_BOOKMARK_RE.test(requested)) {
      const exact = `bookmarks(exact:${JSON.stringify(requested)})`;
      // Only a bookmark that points *above* the stack bottom is owned by the stack;
      // one pointing at or below the bottom would smuggle shared history into it.
      const owned = await this.readCommitIds(cwd, `(${exact}) & (${movingSet} ~ (${first}))`, signal, 1);
      if (owned.length > 0) {
        const others = await this.readCommitIds(cwd, `${movingSet} & (::((bookmarks()) ~ (${exact})))`, signal, 1);
        if (others.length === 0) return;
      }
    }
    const hint = await this.localBookmarkNames(cwd, signal);
    throw badInput(
      `jj_handoff refuses to rebase ${JSON.stringify(first)}::@: the selection contains commits that are reachable from local bookmarks, i.e. shared/stable history this workspace does not own, so a source-mode rebase would rewrite it. Local bookmarks: ${hint.length > 0 ? hint.join(', ') : 'none'}. Pass firstChange with the bottom-most change id this session created, pass the session's own bookmark as the bookmark option, or ask the user which revision to integrate onto.`,
    );
  }

  /**
   * Refuse a destination whose history does not extend this workspace's base.
   *
   * `roots(::@ ~ ::target)` names only this workspace's own commits when `target`
   * already contains the shared history the workspace was based on. With an
   * unrelated destination (only jj's empty root commit in common) the roots instead
   * name the *shared* commits directly above the root commit, and `jj rebase -s`
   * would rewrite them — the A2-F1 data-loss shape. This is fail-closed: the model
   * must pick a destination this workspace's history extends (or ask the user).
   *
   * @param cwd - workspace directory.
   * @param target - resolved destination revset.
   * @param signal - cancellation signal.
   * @throws JjError `JJ_BAD_INPUT` when the destination shares no history beyond the root commit.
   */
  private async assertDestinationCoversBase(cwd: string, target: string, signal?: AbortSignal): Promise<void> {
    const shared = await this.readCommitIds(cwd, `((::@ & ::(${target})) ~ root())`, signal, 1);
    if (shared.length > 0) return;
    const hint = await this.localBookmarkNames(cwd, signal);
    throw badInput(
      `jj_handoff cannot integrate onto ${JSON.stringify(target)}: it shares no history with this workspace except jj's empty root commit, so the stack above it would include changes from the shared history rather than only this workspace's own commits, and a source-mode rebase could rewrite them. Local bookmarks: ${hint.length > 0 ? hint.join(', ') : 'none'}. Pass a destination this workspace's history extends (the bookmark or branch it was based on), or ask the user which revision to integrate onto; moving this workspace's own commits onto an unrelated revision needs an explicit jj_rebase decision, which jj_handoff must not guess.`,
    );
  }

  /** The stack from `first` up to and including `@`, newest first. */
  private async stackFrom(cwd: string, first: string, signal?: AbortSignal): Promise<readonly JjChangeRecord[]> {
    return await this.log(cwd, `(${first})::@`, this.config.maxLogLimit, signal);
  }

  /** Parent commit id of a revision, or `undefined` when it does not resolve. */
  private async parentCommitId(cwd: string, revset: string, signal?: AbortSignal): Promise<string | undefined> {
    return (await this.readCommitIds(cwd, `(${revset})-`, signal))[0];
  }

  /**
   * Commit ids selected by a revset (`commit_id`-only template).
   *
   * Parent/base checks only need the commit id; reading a full change record would
   * pay for the `self.diff()` of every parent (expensive on large commits). Missing
   * revisions report `[]`; every other error is rethrown (same contract as
   * {@link tryReadAt}).
   *
   * @param cwd - workspace directory.
   * @param revset - revisions to read.
   * @param signal - cancellation signal.
   * @param limit - optional maximum number of commit ids to read (existence probes).
   */
  private async readCommitIds(
    cwd: string,
    revset: string,
    signal?: AbortSignal,
    limit?: number,
  ): Promise<readonly string[]> {
    try {
      const argv = [
        'log',
        '-r',
        revset,
        '--no-graph',
        ...(limit !== undefined ? ['--limit', String(limit)] : []),
        '-T',
        TPL_COMMIT_IDS,
      ];
      const result = await this.run(cwd, argv, signal);
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      if (isStaleWorkingCopyFailure(error)) throw error;
      if (error instanceof JjError && error.code === 'JJ_BAD_REVSET') return [];
      throw error;
    }
  }

  /** Conflicted changes in one stack, model-facing. */
  private conflictsIn(stack: readonly JjChangeRecord[]): JjHandoffConflict[] {
    return stack
      .filter((change) => change.conflict)
      .map((change) => ({ changeId: change.changeId, description: change.description }));
  }

  /** The stack's top content change (newest first, skipping the empty working-copy change). */
  private bookmarkTip(stack: readonly JjChangeRecord[]): JjChangeRecord | undefined {
    return stack.find((change) => !change.empty && !change.currentWorkingCopy) ?? stack.find((change) => !change.empty);
  }

  /** Local (non-remote-tracking) bookmark names, used in actionable errors. */
  private async localBookmarkNames(cwd: string, signal?: AbortSignal): Promise<readonly string[]> {
    try {
      const bookmarks = await this.bookmarkList(cwd, false, signal);
      return bookmarks
        .filter((bookmark) => bookmark.remote === null && bookmark.name.length > 0)
        .map((bookmark) => bookmark.name);
    } catch {
      return [];
    }
  }

  /**
   * Read one revision without throwing only when the *revset* does not resolve.
   *
   * Hand-off fallbacks rely on an unresolvable candidate (`main` before it exists)
   * reporting `undefined`, but infrastructure failures (jj missing, template/parse
   * failure, broken repository, abort/timeout, stale working copy) must keep their
   * real error: turning them into "revset does not resolve" made `jj_handoff` claim
   * it could not find an integration target while the actual cause was invisible.
   */
  private async tryReadAt(cwd: string, revset: string, signal?: AbortSignal): Promise<JjChangeRecord | undefined> {
    try {
      return await this.readAt(cwd, signal, revset);
    } catch (error) {
      // A stale working copy makes every content read fail; the hand-off wrapper
      // recovers it once, so this must not look like a nonexistent revision.
      if (isStaleWorkingCopyFailure(error)) throw error;
      if (error instanceof JjError && error.code === 'JJ_BAD_REVSET') return undefined;
      throw error;
    }
  }

  /** Read one revision as a {@link JjChangeRecord} (default `@`, lightweight template). */
  private async readAt(cwd: string, signal?: AbortSignal, revset = '@'): Promise<JjChangeRecord> {
    const argv = ['log', '-r', revset, '--no-graph', '-T', TPL_CHANGE];
    const result = await this.run(cwd, argv, signal);
    return readChangeRecord(result.stdout, argv);
  }

  /** Read every revision selected by a revset (used to fold `@` and `@-` into one call). */
  private async readChangesAt(
    cwd: string,
    revset: string,
    template: string,
    signal?: AbortSignal,
  ): Promise<JjChangeRecord[]> {
    const argv = ['log', '-r', revset, '--no-graph', '-T', template];
    const result = await this.run(cwd, argv, signal);
    return readChangeRecords(result.stdout, argv);
  }
}

/** Plugin configuration schema re-exported for the service entry. */
export { Config };

/** Pure template constants and record parsers (see `jj-templates`). */
export * from './jj-templates.ts';

/** The Cordis `ctx.jj` service (see `jj-service`). */
export * from './jj-service.ts';
