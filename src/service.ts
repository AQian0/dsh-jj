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
import { isStaleWorkingCopyFailure } from './policies.ts';
import {
  asRecord,
  bound,
  changeFromRecord,
  isRewritableChange,
  parseChangeLines,
  parseWorkspaceStates,
  parseJsonLine,
  TemplateParseError,
  TPL_BOOKMARK_LIST,
  TPL_CHANGE,
  TPL_COMMIT_IDS,
  TPL_DESCRIPTION,
  TPL_LOG,
  TPL_OP_LOG,
  TPL_STATUS,
  TPL_WORKSPACE_LIST_STATE,
  TPL_WORKSPACE_LIST_TAB,
  type JjChangeRecord,
} from './jj-templates.ts';
import type { JjOperation, JjRunResult, JjWorkspaceState } from './types.ts';

/** How `jj rebase` selects the revisions to move. */
export type JjRebaseMode = 'revisions' | 'source' | 'branch';

/** `JjRebaseMode` → jj command-line flag. */
const REBASE_MODE_FLAGS: Readonly<Record<JjRebaseMode, string>> = { revisions: '-r', source: '-s', branch: '-b' };

function badInput(message: string, argv: readonly string[] = []): JjError {
  return new JjError('JJ_BAD_INPUT', message, { argv, exitCode: null, stderr: '', stdout: '' });
}

/**
 * jj warnings printed on a zero exit (for example a pathspec that matched no file).
 *
 * They are returned instead of discarded: a silent empty commit or a paths-limited
 * fold that matched nothing would otherwise look like a successful operation.
 */
function stderrWarnings(stderr: string): string[] {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Warning:'));
  return lines.length > 0 ? [bound(lines.join('\n'), 2 * 1024).text] : [];
}

const OPERATION_ID_RE = /^[0-9a-f]{4,128}$/;
const BOOKMARK_NAME_RE = /^[^\s@]+$/;
/** Bookmark names safe to embed verbatim in a jj revset (`bookmarks(exact:…)` / `::name`). */
const SAFE_BOOKMARK_RE = /^[A-Za-z0-9_./-]+$/;

/** Reject path arguments jj would read as options (and empty/whitespace paths). */
function assertPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (path.trim().length === 0 || path.startsWith('-')) {
      throw badInput('paths must be non-empty and must not start with "-".');
    }
  }
}

/** Validate a bookmark name before anything is rewritten (jj only rejects it later). */
function assertBookmarkName(name: string): void {
  if (!BOOKMARK_NAME_RE.test(name) || name.includes('@')) {
    throw badInput("bookmark names must be non-empty and must not contain whitespace or '@'.");
  }
}

/** `jj log -r <revset> --no-graph [--limit <n>] -T <template>`: the argv every change read shares. */
function logArgv(revset: string, template: string, limit?: number, ignoreWorkingCopy = false): string[] {
  const boundedBy = limit === undefined ? [] : ['--limit', String(limit)];
  const staticCopy = ignoreWorkingCopy ? ['--ignore-working-copy'] : [];
  return ['log', '-r', revset, '--no-graph', ...staticCopy, ...boundedBy, '-T', template];
}

/**
 * Parse one `-T 'json(self) ++ "\n"'` read (one JSON object per line) into records.
 *
 * A line that is not JSON is `JJ_OUTPUT_INVALID` carrying that line as evidence —
 * jj output must never turn into a silently empty result. A line that parses to a
 * non-object is skipped.
 */
function jsonRecords(argv: readonly string[], stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    let record: Record<string, unknown> | undefined;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      throw new JjError(
        'JJ_OUTPUT_INVALID',
        `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`,
        { argv, exitCode: 0, stderr: '', stdout: bound(stdout, 512).text },
      );
    }
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** Result of `status()`. */
export interface JjStatusResult {
  readonly change: JjChangeRecord;
  readonly changedPaths: readonly string[];
  readonly diffStat: string;
  readonly raw: string;
  readonly truncated: boolean;
}

/** Result of `abandon()`. */
export interface JjAbandonResult {
  /** The revisions that were dropped, as they looked before the command. */
  readonly abandoned: readonly JjChangeRecord[];
  /** jj's own output line (bounded). */
  readonly message: string;
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

/** Options for {@link JjOperations.amend}. */
export interface JjAmendOptions {
  /** Target change: a revset that must resolve to exactly one revision (usually a change id). */
  readonly into: string;
  /** Source of the correction; defaults to `@`. Pass the correction's change id when it was already committed. */
  readonly from?: string;
  /** Replacement description; omitted keeps the target's description (never opens an editor). */
  readonly message?: string;
  /** Repository-relative paths to fold only; the remaining changes stay in the source change. */
  readonly paths?: readonly string[];
}

/** One change rewritten (rebased) by an amendment. */
export interface JjAmendRewritten {
  readonly changeId: string;
  readonly description: string;
  /** True when the rewrite left a conflict in this change; the model must resolve it. */
  readonly conflict: boolean;
}

/** Result of {@link JjOperations.amend}. */
export interface JjAmendResult {
  /** The target change after the rewrite (its change id is stable). */
  readonly amended: JjChangeRecord;
  /** The working-copy change after the rewrite; a fully folded `@` is replaced by a fresh empty change. */
  readonly workingCopy: JjChangeRecord;
  /** True when the source was a committed change that jj abandoned after folding it. */
  readonly sourceAbandoned: boolean;
  /** Descendants rebased by the rewrite, newest first (target and `@` excluded). */
  readonly rewritten: readonly JjAmendRewritten[];
  /** Model-facing warnings (empty target description, remaining working-copy changes, conflicts). */
  readonly warnings: readonly string[];
}

/** Result of `workspaceAdd()`. */
export interface JjWorkspaceAddResult {
  readonly path: string;
  readonly name: string;
  readonly change: JjChangeRecord;
  /**
   * Model-facing note when the requested parents were adjusted: a parent that
   * resolves to the fresh empty working-copy change is dropped, so the new
   * workspace's chain does not gain an empty commit.
   */
  readonly note?: string;
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
  /**
   * Plan only: resolve the target, validate the boundaries and read the stack, but do
   * not fetch, rebase or move a bookmark (default false). A dry run never touches the
   * repository, so the reported conflicts are the ones already present in the stack.
   */
  readonly dryRun?: boolean;
}

/** One conflicted change reported by a hand-off. */
export interface JjHandoffConflict {
  readonly changeId: string;
  readonly description: string;
}

/** One `jj bookmark list` entry. */
export interface JjBookmarkEntry {
  readonly name: string;
  /**
   * Commit id the bookmark points at; for a conflicted bookmark the first present
   * added side, and `''` when every side is absent.
   */
  readonly target: string;
  /** Remote name for a remote-tracking entry, `null` for the local bookmark. */
  readonly remote: string | null;
  /** True when concurrent operations left the bookmark with several (or absent) targets. */
  readonly conflicted: boolean;
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
  /** True when nothing was fetched, rebased or moved (planning only). */
  readonly dryRun: boolean;
  readonly message: string;
  readonly bookmark?: JjHandoffBookmark;
  /** Why a requested bookmark move was skipped (conflicts, empty stack). */
  readonly bookmarkSkipped?: string;
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
 * jj serializes `json(self).time` as an object (`{ start, end }`) of RFC 3339
 * instants with an explicit offset (UTC is written `+00:00`), so
 * `String(record.time)` would produce the useless literal `[object Object]`. The
 * model needs one parseable instant, so the operation's start time is reported
 * verbatim; a plain string shape is passed through unchanged.
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
  async status(
    cwd: string,
    signal?: AbortSignal,
    options: { readonly details?: boolean } = {},
  ): Promise<JjStatusResult> {
    // `details: false` is the cheap path agents use for orientation: the change record
    // comes from the same template as `readAt` (no `self.diff()`), and `jj status` (which
    // duplicates the description and costs a full snapshot diff) is skipped entirely.
    if (options.details === false) {
      const change = await this.readAt(cwd, signal);
      return { change, changedPaths: [], diffStat: '', raw: '', truncated: false };
    }
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
  async log(
    cwd: string,
    revset: string,
    limit: number,
    signal?: AbortSignal,
    options: { readonly ignoreWorkingCopy?: boolean } = {},
  ): Promise<readonly JjChangeRecord[]> {
    // Content-reporting reads intentionally snapshot: `jj log -r @` must show the
    // current working-copy content (contract §5.8's --ignore-working-copy applies
    // to metadata reads, which are listed below). Read-only callers (the panel) pass
    // `ignoreWorkingCopy` so opening a panel never rewrites the snapshot commit.
    const argv = logArgv(revset, TPL_LOG, limit, options.ignoreWorkingCopy === true);
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

  /**
   * `jj new [-m <message>] [-- <parent>…]` then read back `@`.
   *
   * With no parents `jj new` starts a change on top of the current one. When the
   * current `@` is already empty that only stacks another empty change on top and
   * leaves the old empty `@` behind as a description-less commit in the chain, so
   * the call is refused. An explicit parent (start a stack on another revision) and
   * a non-empty working copy keep their normal behavior.
   */
  async newChange(
    cwd: string,
    parents: readonly string[],
    message: string | undefined,
    signal?: AbortSignal,
  ): Promise<JjChangeRecord> {
    if (parents.length === 0) {
      const current = await this.readAt(cwd, signal);
      if (current.empty && !current.conflict) {
        throw badInput(
          'jj_new would add another empty change on top of this empty working copy, leaving an empty commit in the change chain. Edit the files (they go into @) and finish steps with jj_commit; pass explicit parents to start a change on another revision.',
        );
      }
    }
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
   * some changes were left behind). An empty working copy is refused before jj
   * runs: committing it would leave an empty commit in the change chain (and in the
   * history handed off/pushed later), which is never what "describe this step"
   * means. Warnings jj reports on a zero exit (for example a pathspec that matched
   * no file) are returned instead of being discarded, because a silent empty commit
   * would defeat the split workflow.
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
    assertPaths(paths);
    // An empty conflicted `@` is a real state (pending merge resolution) and keeps
    // its existing path; a plain empty `@` can only produce an empty commit.
    const current = await this.readAt(cwd, signal);
    if (current.empty && !current.conflict) {
      const pathHint =
        paths.length > 0
          ? ' `jj_commit` with paths commits only those files, so an unmatched path also creates an empty commit; check the paths.'
          : '';
      throw badInput(
        `jj_commit would create an empty commit: this working copy (@) has no content changes. Nothing was committed. If the work is already committed, call jj_handoff directly; for an intentionally empty change use jj_new; otherwise edit the files first.${pathHint}`,
      );
    }
    // A pathspec would otherwise be parsed as an option; `--` ends option parsing.
    const argv = ['commit', '-m', message, ...(paths.length > 0 ? ['--', ...paths] : [])];
    const commitResult = await this.run(cwd, argv, signal);
    // jj writes progress ("Working copy now at: …") to stderr as well; only real
    // warning lines are surfaced to the model.
    const warnings: string[] = stderrWarnings(commitResult.stderr);
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
        'No changes matched the given paths, so the committed change is empty; the working copy still holds the changes. Check that the paths are repository-relative. The empty commit stays in the change chain: remove it with jj_abandon (or undo the commit with jj_undo) if it was not intended.',
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
    const argv = logArgv(revset, TPL_DESCRIPTION, limit);
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

  /**
   * `jj squash --from <from> --into <into> [-m msg | --use-destination-message] [-- <paths…>]`.
   *
   * A failed rewrite of published history is reported as `JJ_BAD_INPUT` with the
   * correction-policy next step instead of jj's raw "is immutable" error: dsh-jj
   * never retries with `--ignore-immutable`, so the model must be told to append a
   * new change instead.
   *
   * @param cwd - workspace directory.
   * @param from - source revset.
   * @param into - destination revset.
   * @param message - replacement description, or `undefined` with `useDestinationMessage`.
   * @param useDestinationMessage - keep the destination's description (never opens an editor).
   * @param paths - optional repository-relative paths to move only those changes.
   * @param signal - cancellation signal.
   */
  async squash(
    cwd: string,
    from: string,
    into: string,
    message: string | undefined,
    useDestinationMessage: boolean,
    paths: readonly string[],
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
    assertPaths(paths);
    // Same publication boundary as jj_amend. `jj squash --into` rewrites the target and
    // rebases every descendant up to the working copy, so a published change anywhere in
    // that range would need a forced push; refuse before touching anything instead of
    // letting jj's immutable check be the only fence (it misses pushed tracked bookmarks).
    const published = await this.readChangesAt(
      cwd,
      `((${from}) | (${into}))::@ & (immutable() | remote_bookmarks())`,
      TPL_LOG,
      signal,
      1,
    );
    const publishedChange = published[0];
    if (publishedChange !== undefined) {
      const label = bound(publishedChange.description.trim(), 120) || '(no description)';
      throw badInput(
        `jj_squash refuses to rewrite ${publishedChange.changeId} (${label}): the rewritten range contains a published change (trunk, tag or remote bookmark). Rewriting it would need a forced push, which dsh-jj never does — commit the change as a new revision instead, or use jj_amend for an unpushed correction.`,
      );
    }
    const argv = ['squash', '--from', from, '--into', into];
    if (message !== undefined) argv.push('-m', message);
    if (useDestinationMessage) argv.push('--use-destination-message');
    // A pathspec would otherwise be parsed as an option; `--` ends option parsing.
    if (paths.length > 0) argv.push('--', ...paths);
    try {
      await this.run(cwd, argv, signal);
    } catch (error) {
      if (
        error instanceof JjError &&
        error.code !== 'JJ_BAD_INPUT' &&
        /is immutable|rewrite \d+ immutable/i.test(error.detail.stderr)
      ) {
        throw badInput(
          `jj_squash cannot rewrite ${JSON.stringify(into)}: the rewritten range contains a published change (jj treats it as immutable). A correction there would need a forced push, which dsh-jj never does; commit the correction as a new change instead.`,
          argv,
        );
      }
      throw error;
    }
    return await this.readAt(cwd, signal);
  }

  /**
   * Fold a correction into an earlier change (`jj squash --from … --into …`).
   *
   * This is the jj-native alternative to appending a "fix" commit: the target
   * change is rewritten in place, its descendants are rebased, local bookmarks
   * follow, and the change id stays stable.
   *
   * Safety invariants (all checked before anything is executed; failures are
   * `JJ_BAD_INPUT` and never a partial rewrite):
   * - `into` and `from` each resolve to exactly one revision, and are different;
   * - `into` is an ancestor of `from` (only this workspace's own stack is foldable);
   * - the rewritten range `into::@` contains no immutable change and no remote
   *   bookmark. The second half matters: jj's default `immutable_heads()` leaves a
   *   pushed *tracked* bookmark mutable, and folding into it would diverge the
   *   local bookmark from its remote (a forced push);
   * - the target is not a merge, the source is not empty and not conflicted.
   *
   * The destination description is kept by default (`--use-destination-message`),
   * so jj never opens an editor; pass `message` when the fix changes what the
   * target commit does. A stale working copy is recovered once and the flow
   * retried, exactly like {@link handoff}.
   *
   * @param cwd - workspace directory.
   * @param options - target, optional source/message/paths.
   * @param signal - cancellation signal.
   * @returns the amended target, the working copy, and every rebased descendant.
   */
  async amend(cwd: string, options: JjAmendOptions, signal?: AbortSignal): Promise<JjAmendResult> {
    try {
      return await this.amendFlow(cwd, options, signal);
    } catch (error) {
      if (!isStaleWorkingCopyFailure(error)) throw error;
      await this.updateStale(cwd, signal);
      return await this.amendFlow(cwd, options, signal);
    }
  }

  /** One amendment attempt; {@link amend} retries it once after stale recovery. */
  private async amendFlow(cwd: string, options: JjAmendOptions, signal?: AbortSignal): Promise<JjAmendResult> {
    const into = options.into.trim();
    if (into.length === 0) {
      throw badInput('jj_amend needs a target change: pass the change id from jj_log as `into`.');
    }
    const from = options.from?.trim() ?? '@';
    if (from.length === 0) {
      throw badInput('jj_amend `from` must be a non-empty revset; omit it to fold the working copy.');
    }
    const paths = options.paths ?? [];
    assertPaths(paths);
    if (options.message !== undefined && options.message.trim().length === 0) {
      throw badInput(
        'jj_amend `message` must not be empty; omit it to keep the target description, or pass the full new description.',
      );
    }

    const intoIds = await this.readCommitIds(cwd, into, signal, 2);
    if (intoIds.length === 0) {
      throw badInput(
        `jj_amend target ${JSON.stringify(into)} does not resolve to a change in this repository; pass exactly one change id from jj_log.`,
      );
    }
    if (intoIds.length > 1) {
      throw badInput(
        `jj_amend target ${JSON.stringify(into)} selects more than one revision; pass exactly one change id so only that change is rewritten.`,
      );
    }
    const fromIds = await this.readCommitIds(cwd, from, signal, 2);
    if (fromIds.length === 0) {
      throw badInput(`jj_amend source ${JSON.stringify(from)} does not resolve to a change in this repository.`);
    }
    if (fromIds.length > 1) {
      throw badInput(
        `jj_amend source ${JSON.stringify(from)} selects more than one revision; pass exactly one change id or path list.`,
      );
    }
    if (intoIds[0] === fromIds[0]) {
      throw badInput(
        'jj_amend target and source are the same change; edit the files and use jj_describe / jj_commit, or pass the change the correction belongs to as `into`.',
      );
    }

    // Only this workspace's own stack: the target must be an ancestor of the source.
    const inStack = await this.readCommitIds(cwd, `(${into})::(${from})`, signal, 1);
    if (inStack.length === 0) {
      throw badInput(
        `jj_amend cannot fold ${JSON.stringify(from)} into ${JSON.stringify(into)}: the target is not an ancestor of the source. Only changes in this workspace's own stack can be amended; inspect the graph with jj_log.`,
      );
    }

    // Publication boundary over the WHOLE rewritten range (into::@), not only the
    // target: `jj squash --into` rebases every descendant up to the working copy.
    const published = await this.readChangesAt(
      cwd,
      `(${into})::@ & (immutable() | remote_bookmarks())`,
      TPL_LOG,
      signal,
      1,
    );
    const publishedChange = published[0];
    if (publishedChange !== undefined) {
      const label = bound(publishedChange.description.trim(), 120) || '(no description)';
      throw badInput(
        `jj_amend refuses to rewrite ${publishedChange.changeId} (${label}): the rewritten range contains a published change (trunk, tag or remote bookmark). Folding the correction would require a forced push, which dsh-jj never does — commit the correction as a new change instead and tell the user why.`,
      );
    }

    const parents = await this.readCommitIds(cwd, `(${into})-`, signal, 2);
    if (parents.length > 1) {
      throw badInput(
        `jj_amend cannot fold into ${JSON.stringify(into)}: the target is a merge commit (${parents.length} parents), and folding into a merge would make the correction's intent ambiguous.`,
      );
    }

    const source = await this.readAt(cwd, signal, from);
    // Conflict first: a conflicted merge change also reports `empty`, and folding
    // it would move the conflict markers into the target.
    if (source.conflict) {
      throw badInput(
        `jj_amend cannot fold ${JSON.stringify(from)}: the source change has conflicts. Resolve them first (edit the files, then jj_status), and call jj_amend again.`,
      );
    }
    if (source.empty) {
      throw badInput(
        `jj_amend has nothing to fold: ${JSON.stringify(from)} has no content changes. Edit the files first, or use jj_describe for a description-only change.`,
      );
    }

    const argv = ['squash', '--from', from, '--into', into];
    if (options.message !== undefined) argv.push('-m', options.message);
    else argv.push('--use-destination-message');
    if (paths.length > 0) argv.push('--', ...paths);
    const squashResult = await this.run(cwd, argv, signal);

    const amended = await this.readAt(cwd, signal, into);
    const workingCopy = await this.readAt(cwd, signal);
    const stack = await this.readChangesAt(cwd, `(${into})::@`, TPL_LOG, signal, this.config.maxLogLimit);
    const rewritten = stack
      .filter((change) => change.changeId !== amended.changeId && !change.currentWorkingCopy)
      .map((change) => ({
        changeId: change.changeId,
        description: change.description,
        conflict: change.conflict,
      }));

    let sourceAbandoned = false;
    if (!source.currentWorkingCopy) {
      // Change ids survive rewrites, so an empty lookup means jj abandoned the
      // now-empty correction change instead of keeping it in the stack. The
      // working-copy change is never reported as abandoned: a fully folded `@` is
      // replaced by a fresh empty change, which `workingCopy` already describes.
      const stillVisible = await this.readCommitIds(cwd, source.changeId, signal, 1);
      sourceAbandoned = stillVisible.length === 0;
    }

    const warnings = stderrWarnings(squashResult.stderr);
    if (amended.description.trim().length === 0) {
      warnings.push(
        'The amended change has no description; pass `message` when the correction changes what the commit does (jj_commit_style reports the repository style).',
      );
    }
    if (paths.length > 0 && !workingCopy.empty) {
      warnings.push(
        'Only the given paths were folded; the remaining working-copy changes are still in @ (it is not empty).',
      );
    }
    const conflicted = rewritten.filter((change) => change.conflict);
    if (conflicted.length > 0) {
      warnings.push(
        `The rewrite left conflicts in: ${conflicted.map((change) => change.changeId).join(', ')}. Resolve them yourself, then call jj_amend again to verify.`,
      );
    }

    return { amended, workingCopy, sourceAbandoned, rewritten, warnings };
  }

  /**
   * `jj abandon <revset>` — drop revisions, rebasing their descendants onto the parents.
   *
   * Safety invariants, checked before anything runs:
   * - a revset must be given (jj defaults to `@`, which would silently discard the
   *   working copy);
   * - the revset must resolve to at least one revision;
   * - it must not include the working-copy change (the shell guard hard-denies
   *   abandoning `@`; the tool must not be the way around that rule);
   * - it must not include a published change (immutable, trunk/tag, or a remote
   *   bookmark): dropping published history would need a forced push.
   *
   * @param cwd - workspace directory.
   * @param revset - revisions to abandon (resolved first).
   * @param signal - cancellation signal.
   * @returns the abandoned change records and jj's own output line.
   */
  async abandon(cwd: string, revset: string, signal?: AbortSignal): Promise<JjAbandonResult> {
    const target = revset.trim();
    if (target.length === 0) {
      throw badInput(
        'jj_abandon needs an explicit revset: passing nothing would abandon the working copy (@). Name the change id from jj_log.',
      );
    }
    const changes = await this.readChangesAt(cwd, target, TPL_LOG, signal, this.config.maxLogLimit);
    if (changes.length === 0) {
      throw badInput(
        `jj_abandon found no revision matching ${JSON.stringify(target)}; list the changes with jj_log and pass a change id.`,
      );
    }
    const workingCopy = changes.find((change) => change.currentWorkingCopy);
    if (workingCopy !== undefined) {
      throw badInput(
        'jj_abandon refuses to abandon the working-copy change @: it would discard the files you are working on. Commit or describe it first, or name the specific change to drop.',
      );
    }
    const published = changes.find((change) => !isRewritableChange(change));
    if (published !== undefined) {
      const label = bound(published.description.trim(), 120) || '(no description)';
      throw badInput(
        `jj_abandon refuses to abandon ${published.changeId} (${label}): it is published (trunk, tag or remote bookmark), so dropping it would need a forced push. dsh-jj never rewrites published history.`,
      );
    }
    const result = await this.run(cwd, ['abandon', target], signal);
    return {
      abandoned: changes,
      message: bound(result.stdout.trim() || result.stderr.trim(), 1024).text,
    };
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
    for (const record of jsonRecords(argv, result.stdout)) {
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

  /**
   * `jj workspace add <path> [--name n] [-r r]… [-m m] [--colocate]`, then read
   * the workspace back.
   *
   * A parent that resolves to `@` is special-cased. It names the current
   * *working-copy* change, which is usually the fresh empty change left by the last
   * commit; using it as a parent puts that empty commit into the new workspace's
   * ancestry, and it later reaches the handed-off (and pushed) linear history as an
   * empty commit.
   * Since `jj workspace add` without `-r` already bases the new workspace on the
   * parents of `@` (the last committed change), an empty `@` parent is dropped with
   * a note. Once `@` contains uncommitted content it cannot be dropped safely (the
   * commit would be undescribed and owned by the source workspace), so the call is
   * refused with the commit-first instruction instead.
   *
   * @param cwd - workspace directory to run jj in.
   * @param path - destination directory for the new workspace.
   * @param name - jj workspace name; defaults to the destination basename.
   * @param parents - revsets the new working-copy change starts on.
   * @param message - optional description for the new working-copy change.
   * @param colocate - create a matching Git worktree when true.
   * @param signal - cancellation signal.
   * @returns the created workspace and its current change.
   */
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
    const adjusted = await this.adjustWorkspaceParents(cwd, parents, signal);
    const argv = ['workspace', 'add', trimmedPath];
    if (requestedName.length > 0) argv.push('--name', requestedName);
    for (const parent of adjusted.parents) argv.push('-r', parent);
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
    return {
      path: created.root,
      name: created.name,
      change,
      ...(adjusted.note !== undefined ? { note: adjusted.note } : {}),
    };
  }

  /**
   * Drop a parent that resolves to the current working-copy change, or refuse it.
   *
   * `jj workspace add -r @` (or `-r <@'s change id>`, or any revset selecting `@`)
   * makes the current working-copy change a parent of the new workspace. After a
   * commit that change is the fresh empty change, so the new workspace's chain
   * would gain an empty description-less commit that reaches the handed-off/pushed
   * history as an empty commit. Omitting `-r` already bases the new workspace on
   * `@`'s parents, so a bare empty `@` is dropped. A non-empty `@` is refused:
   * committing it is the caller's decision, and as an unspecified working-copy
   * commit it would still pollute the new chain.
   *
   * Parents are compared as *revisions*, not strings: a change id copied from
   * `jj_status`/`jj_log` must hit the same guard as the literal `@` revset.
   *
   * @param cwd - workspace directory.
   * @param parents - requested parent revsets.
   * @param signal - cancellation signal.
   * @returns the parents to pass to jj plus an optional model-facing note.
   */
  private async adjustWorkspaceParents(
    cwd: string,
    parents: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ parents: readonly string[]; note?: string }> {
    if (parents.length === 0) return { parents };
    const workingCopyIndexes: number[] = [];
    for (const [index, parent] of parents.entries()) {
      // An invalid/unresolvable revset yields no overlap here and is then reported
      // by jj itself; only the working-copy comparison is the plugin's concern.
      const overlap = await this.readCommitIds(cwd, `((${parent}) & @)`, signal, 1);
      if (overlap.length > 0) workingCopyIndexes.push(index);
    }
    if (workingCopyIndexes.length === 0) return { parents };
    const workingCopy = await this.readAt(cwd, signal);
    if (!workingCopy.empty) {
      throw badInput(
        'jj_workspace_add cannot use the working-copy change @ as a parent: it still has uncommitted content, so the new workspace would keep it as an undescribed commit in its chain (and in the history handed off later). Commit it first with jj_commit, then call jj_workspace_add without parents: jj bases the new workspace on the commit you just made.',
      );
    }
    if (parents.length > 1) {
      throw badInput(
        'jj_workspace_add cannot combine the working-copy change @ with other parents: @ is the empty working-copy change, and using it as a parent would add an empty commit to the new workspace. Drop @ and pass only committed parents (or omit parents entirely).',
      );
    }
    return {
      parents: [],
      note: 'The requested parent @ (the empty working-copy change) was dropped: jj_workspace_add already bases the new workspace on its parent commit (the last committed change), so no empty commit enters the new chain.',
    };
  }

  /**
   * `jj workspace list -T '<JSON name>\t<JSON root>\n'`; roots are absolute.
   *
   * Both fields are JSON-encoded because jj decorates names that need quoting
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
   * Every workspace of this repository with the state of its working-copy change.
   *
   * One `jj workspace list -T <TPL_WORKSPACE_LIST_STATE> --ignore-working-copy` call:
   * the listing never snapshots any working copy, so it is safe to run per turn from a
   * panel or a tool. The workspace this call runs in is marked `current` by comparing
   * its target change with `@`; every other workspace reports `stale: 'unknown'`
   * because telling otherwise requires loading (and snapshotting) that checkout.
   *
   * @param cwd - any directory inside the workspace to query.
   * @param signal - cancellation signal.
   * @returns one state per workspace, in jj's order.
   */
  async workspaceStates(cwd: string, signal?: AbortSignal): Promise<readonly JjWorkspaceState[]> {
    const argv = ['workspace', 'list', '--ignore-working-copy', '-T', TPL_WORKSPACE_LIST_STATE];
    const result = await this.run(cwd, argv, signal);
    const records = parseWorkspaceStates(result.stdout, argv);
    let currentChangeId: string | undefined;
    try {
      currentChangeId = (await this.readAt(cwd, signal)).changeId;
    } catch {
      // A stale or unreadable working copy still lists other workspaces; "current" then
      // stays unresolved instead of failing the whole listing.
      currentChangeId = undefined;
    }
    return records.map((record) => ({
      name: record.name,
      root: record.root,
      current: currentChangeId !== undefined && record.changeId === currentChangeId,
      changeId: record.changeId,
      commitId: record.commitId,
      description: record.description,
      empty: record.empty,
      conflict: record.conflict,
      // Only this workspace's readability is known: a successful `@` read proves it is
      // fresh, and a failed one leaves the question open (a stale checkout refuses reads).
      stale: currentChangeId !== undefined && record.changeId === currentChangeId ? 'no' : 'unknown',
    }));
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
   * The surviving (default) workspace can be stale when this session's hand-off
   * rewrote a change it still had checked out. Cleanup must not strand the session
   * for that: the stale copy is recovered once and the forget retried, exactly like
   * the hand-off wraps its own flow.
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
    const forget = async (): Promise<string> => {
      const result = await this.run(cwd, argv, signal);
      return bound(result.stdout.trim() || result.stderr.trim(), 1024).text;
    };
    try {
      return await forget();
    } catch (error) {
      if (!isStaleWorkingCopyFailure(error)) throw error;
      await this.updateStale(cwd, signal);
      return await forget();
    }
  }

  /**
   * Whether a change id still resolves to a visible revision.
   *
   * Used after `jj workspace forget`: jj abandons the forgotten workspace's
   * working-copy commit only when it is empty, undescribed and has no descendants;
   * otherwise the change stays in the shared history (and can surface as an empty
   * commit). Missing revisions report `false`; infrastructure failures are rethrown
   * (same contract as {@link tryReadAt}), and callers that must stay fail-open
   * contain them.
   *
   * @param cwd - directory to run jj in.
   * @param changeId - change id to look up.
   * @param signal - cancellation signal.
   * @returns true when the revision is still visible.
   */
  async changeExists(cwd: string, changeId: string, signal?: AbortSignal): Promise<boolean> {
    const id = changeId.trim();
    if (id.length === 0) return false;
    return (await this.tryReadAt(cwd, id, signal)) !== undefined;
  }

  /**
   * `jj bookmark list [--all-remotes] -T 'json(self) ++ "\n"'`.
   *
   * `json(self).target` is jj's merge form `[add, remove, add, …]`: one commit id for
   * a normal bookmark, several for a conflicted one, and `null` for an *absent* side
   * (one concurrent operation deleted the bookmark while another moved it; the plain
   * `jj bookmark list` shows that side as `(absent)`). The reported `target` is the
   * first present added side, never the literal revset `"null"`, and `conflicted`
   * tells callers that no single target exists, so nothing may treat that id as the
   * bookmark's position.
   */
  async bookmarkList(cwd: string, allRemotes: boolean, signal?: AbortSignal): Promise<readonly JjBookmarkEntry[]> {
    const argv = ['bookmark', 'list', '--ignore-working-copy'];
    if (allRemotes) argv.push('--all-remotes');
    argv.push('-T', TPL_BOOKMARK_LIST);
    const result = await this.run(cwd, argv, signal);
    const bookmarks: JjBookmarkEntry[] = [];
    for (const record of jsonRecords(argv, result.stdout)) {
      const terms: unknown[] = Array.isArray(record['target']) ? record['target'] : [];
      const isPresent = (term: unknown): term is string => typeof term === 'string' && term.length > 0;
      const added = terms.filter((_term, index) => index % 2 === 0);
      const target = added.find(isPresent) ?? terms.find(isPresent) ?? '';
      bookmarks.push({
        name: String(record['name'] ?? ''),
        target,
        remote: record['remote'] === undefined || record['remote'] === null ? null : String(record['remote']),
        conflicted: terms.length > 1,
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
    assertBookmarkName(name);
    // A caller that already listed the bookmarks passes what it knows in, so the
    // pre-set inspection and the post-set read-back only run when it is unknown.
    const existing =
      existingTarget === undefined
        ? (await this.bookmarkList(cwd, false, signal)).some((bookmark) => bookmark.name === name)
        : existingTarget !== null;
    const argv = ['bookmark', 'set', name, '-r', revset];
    if (allowBackwards) argv.push('--allow-backwards');
    await this.run(cwd, argv, signal);
    const target =
      knownTargetCommitId ??
      (await this.bookmarkList(cwd, false, signal)).find((bookmark) => bookmark.name === name)?.target ??
      '';
    return { name, target, moved: existing };
  }

  /**
   * `jj rebase (-r|-s|-b) <revision> -d <destination>`.
   *
   * jj distinguishes the selection modes sharply: `-r` moves only the named
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
        dryRun: options.dryRun === true,
        message:
          "The working copy has uncommitted changes. Commit them first with jj_commit (description following this repository's style), then call jj_handoff again.",
      };
    }

    // A bookmark request is validated before the fetch/rebase: jj rejects invalid
    // names (whitespace, '@', leading '-') and used to fail *after* the rebase had
    // already rewritten the workspace, so the model saw an error for work that had
    // actually been done.
    const requestedBookmark = options.bookmark?.trim();
    if (requestedBookmark !== undefined && requestedBookmark.length > 0) assertBookmarkName(requestedBookmark);

    const dryRun = options.dryRun === true;
    const fetchResult: JjFetchResult = dryRun
      ? { status: 'skipped', message: 'jj git fetch was skipped because this is a dry run.' }
      : options.fetch === false
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
      dryRun: options.dryRun === true,
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
        first.changeId,
        signal,
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

    if (dryRun) {
      // Planning only: the same validations ran, so a refused dry run is as meaningful
      // as a refused real one, but nothing was fetched, rebased or moved.
      const stack = await this.stackFrom(cwd, first.changeId, signal);
      return {
        ...base,
        firstChangeId: first.changeId,
        stack,
        conflicts: this.conflictsIn(stack),
        message: `Dry run: ${stack.length} change${stack.length === 1 ? '' : 's'} would be rebased onto ${target.revset}. Nothing was fetched, rebased or moved; call jj_handoff again without dryRun to perform it.${this.stackTruncationNote(stack)}`,
        ...(requestedBookmark !== undefined && requestedBookmark.length > 0
          ? { bookmarkSkipped: `Bookmark ${requestedBookmark} was not moved because this was a dry run.` }
          : {}),
      };
    }

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
      first.changeId,
      signal,
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
   * A conflicted bookmark (concurrent operations moved or deleted it differently) is
   * skipped too: it has no single position to check ownership against, and setting
   * it would silently pick a side for whoever else moved it.
   *
   * @param cwd - workspace directory.
   * @param requested - bookmark name requested by the caller, when any.
   * @param stack - the integrated stack (newest first).
   * @param conflicts - conflicted changes in the stack.
   * @param firstChangeId - bottom-most change of the stack, used for the ownership check.
   * @param signal - cancellation signal.
   */
  private async moveRequestedBookmark(
    cwd: string,
    requested: string | undefined,
    stack: readonly JjChangeRecord[],
    conflicts: readonly JjHandoffConflict[],
    firstChangeId: string,
    signal?: AbortSignal,
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
      if (existing?.conflicted === true) {
        return {
          bookmarkSkipped: `Bookmark ${name} is conflicted (concurrent operations moved or deleted it differently), so jj_handoff does not pick a side. Report the rebased stack instead; once the intended target is clear the bookmark can be resolved with jj_bookmark_set.`,
        };
      }
      if (existing !== undefined && existing.target.length > 0) {
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
      const argv = logArgv(revset, TPL_COMMIT_IDS, limit);
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

  /**
   * Read one revision as a {@link JjChangeRecord} (default `@`, lightweight template).
   *
   * Public because flows and tools need the working-copy record without paying for the
   * full `status` output; it is a single `jj log -r <revset>` call.
   *
   * @param cwd - workspace directory.
   * @param signal - cancellation signal.
   * @param revset - revision to read (default `@`).
   * @returns the change record.
   */
  async readAt(cwd: string, signal?: AbortSignal, revset = '@'): Promise<JjChangeRecord> {
    const argv = logArgv(revset, TPL_CHANGE);
    const result = await this.run(cwd, argv, signal);
    return readChangeRecord(result.stdout, argv);
  }

  /** Read every revision selected by a revset (used to fold `@` and `@-` into one call). */
  private async readChangesAt(
    cwd: string,
    revset: string,
    template: string,
    signal?: AbortSignal,
    limit?: number,
  ): Promise<JjChangeRecord[]> {
    const argv = logArgv(revset, template, limit);
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
