/**
 * jj operations and the `ctx.jj` service (design contract §5.4 / §5.6).
 *
 * {@link JjOperations} holds every jj-native operation; it is pure with respect
 * to the host (one injected {@link RunJj}), which makes the whole operation layer
 * testable against real repositories without mounting Cordis.
 *
 * {@link JjService} is the Cordis face: it owns the TTL cache used by the
 * synchronous guard, the disposal ladder (abort → settle pending → clear cache),
 * and the process-lifetime version cache.
 *
 * @module dsh-jj/service
 */

import { Service, type Context } from '@deepseek-ai/cordis';
import { assertServiceableConfig, Config, resolveConfig, type JjPluginConfig, type ResolvedJjConfig } from './config.ts';
import { detectVcs } from './detect.ts';
import { createRunGit, createRunJj, JjError, runJjChecked, type RunJj } from './jj-command.ts';
import type { JjChange, JjOperation, JjRunResult, VcsDescriptor, VcsKind } from './types.ts';

/** `jj log -r <rev> --no-graph -T <TPL_STATUS>` template (contract §2.8, verbatim). */
export const TPL_STATUS =
  '"{\\"change_id\\":" ++ json(change_id) ++ ",\\"commit_id\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"current_working_copy\\":" ++ json(current_working_copy) ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"author\\":" ++ json(author.email()) ++ ",\\"paths\\":" ++ json(self.diff().files().map(|f| f.path())) ++ "}\\n"';

/** `jj log` per-change template (contract §2.8, verbatim). */
export const TPL_LOG =
  '"{\\"change_id\\":" ++ json(change_id) ++ ",\\"commit_id\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ json(description.first_line()) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"current_working_copy\\":" ++ json(current_working_copy) ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"author\\":" ++ json(author.email()) ++ "}\\n"';

/** `jj workspace list` template used by the tools (tab-separated; names may contain spaces). */
export const TPL_WORKSPACE_LIST_TAB = 'name ++ "\\t" ++ root ++ "\\n"';

/**
 * `jj op log` template (contract §7.3.8): `json(self)` exposes id/description/
 * time/username/hostname/workspace_name/is_snapshot/attributes.
 */
export const TPL_OP_LOG = 'json(self) ++ "\\n"';

/** `jj bookmark list` template (contract §7.3.11). */
export const TPL_BOOKMARK_LIST = 'json(self) ++ "\\n"';

/**
 * `jj log` template returning one full description per line as JSON.
 *
 * Used by the commit-style sampler: the first line carries the style, but the
 * model also needs to see body/footer habits, which `TPL_LOG` (`first_line`)
 * intentionally drops.
 */
export const TPL_DESCRIPTION = 'json(description) ++ "\\n"';

/** Bounded text helper. */
function bound(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}

/** How `jj rebase` selects the revisions to move (jj 0.46). */
export type JjRebaseMode = 'revisions' | 'source' | 'branch';

/** `JjRebaseMode` → jj command-line flag. */
const REBASE_MODE_FLAGS: Readonly<Record<JjRebaseMode, string>> = { revisions: '-r', source: '-s', branch: '-b' };

function badInput(message: string, argv: readonly string[] = []): JjError {
  return new JjError('JJ_BAD_INPUT', message, { argv, exitCode: null, stderr: '', stdout: '' });
}

const OPERATION_ID_RE = /^[0-9a-f]{4,128}$/;
const BOOKMARK_NAME_RE = /^[^\s@]+$/;

/** One jj change, as parsed from the JSON templates. */
export interface JjChangeRecord extends JjChange {
  readonly paths: readonly string[];
}

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseJsonLine(stdout: string, argv: readonly string[]): Record<string, unknown> {
  const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` returned no parseable record.`, {
      argv,
      exitCode: 0,
      stderr: '',
      stdout: bound(stdout, 512).text,
    });
  }
  try {
    const parsed: unknown = JSON.parse(line);
    const record = asRecord(parsed);
    if (record === undefined) throw new Error('not an object');
    return record;
  } catch (error) {
    throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(stdout, 512).text}`, {
      argv,
      exitCode: 0,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: bound(stdout, 512).text,
    });
  }
}

function changeFromRecord(record: Record<string, unknown>): JjChangeRecord {
  const bookmarks = Array.isArray(record['bookmarks']) ? record['bookmarks'].map((entry) => String(entry)) : [];
  const paths = Array.isArray(record['paths']) ? record['paths'].map((entry) => String(entry)) : [];
  return {
    changeId: String(record['change_id'] ?? ''),
    commitId: String(record['commit_id'] ?? ''),
    description: String(record['description'] ?? '').replace(/\n$/, ''),
    empty: record['empty'] === true,
    conflict: record['conflict'] === true,
    currentWorkingCopy: record['current_working_copy'] === true,
    bookmarks,
    author: String(record['author'] ?? ''),
    paths,
  };
}

function parseChangeLines(stdout: string, argv: readonly string[]): JjChangeRecord[] {
  const changes: JjChangeRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record !== undefined) changes.push(changeFromRecord(record));
    } catch {
      throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(stdout, 512).text}`, {
        argv,
        exitCode: 0,
        stderr: '',
        stdout: bound(stdout, 512).text,
      });
    }
  }
  return changes;
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
  private options(cwd: string, argv: readonly string[], signal?: AbortSignal, env?: Readonly<Record<string, string>>) {
    return {
      cwd,
      argv,
      timeoutMs: this.config.timeoutMs,
      graceMs: this.config.graceMs,
      maxOutputBytes: this.config.maxOutputBytes,
      jjCommand: this.config.jjCommand,
      ...(signal !== undefined ? { signal } : {}),
      ...(env !== undefined ? { env } : {}),
    };
  }

  private async run(cwd: string, argv: readonly string[], signal?: AbortSignal): Promise<JjRunResult> {
    return await runJjChecked(this.runJj, this.options(cwd, argv, signal), this.config);
  }

  /** `jj --version` / `git --version` (the only git call dsh-jj allows). */
  async version(cwd: string, signal?: AbortSignal): Promise<{ jj: string | undefined; git: string | undefined }> {
    let jj: string | undefined;
    try {
      const result = await this.runJj({ ...this.options(cwd, ['--version'], signal), jjCommand: this.config.jjCommand });
      if (result.exitCode === 0) jj = result.stdout.trim();
    } catch {
      jj = undefined;
    }
    return { jj, git: undefined };
  }

  /** `jj log -r @ --no-graph -T <TPL_STATUS>` plus `jj status`. */
  async status(cwd: string, signal?: AbortSignal): Promise<JjStatusResult> {
    const argv = ['log', '-r', '@', '--no-graph', '-T', TPL_STATUS];
    const changeResult = await this.run(cwd, argv, signal);
    const change = changeFromRecord(parseJsonLine(changeResult.stdout, argv));
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
    return parseChangeLines(result.stdout, argv);
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

  /** `jj new [-m <message>] [<parent>…]` then read back `@`. */
  async newChange(
    cwd: string,
    parents: readonly string[],
    message: string | undefined,
    signal?: AbortSignal,
  ): Promise<JjChangeRecord> {
    const argv = ['new'];
    if (message !== undefined && message.length > 0) argv.push('-m', message);
    argv.push(...parents);
    await this.run(cwd, argv, signal);
    return await this.readAt(cwd, signal);
  }

  /** `jj describe -r <revset> -m <message>` then read the revision back. */
  async describeChange(cwd: string, revset: string, message: string, signal?: AbortSignal): Promise<JjChangeRecord> {
    const argv = ['describe', '-r', revset, '-m', message];
    await this.run(cwd, argv, signal);
    const readArgv = ['log', '-r', revset, '--no-graph', '-T', TPL_STATUS];
    const result = await this.run(cwd, readArgv, signal);
    return changeFromRecord(parseJsonLine(result.stdout, readArgv));
  }

  /**
   * `jj commit -m <message> [-- <paths…>]` then read the committed change (`@-`)
   * and the new working copy (`@`).
   *
   * jj commit is describe + new in one step: the current change keeps its content
   * (or only the given paths, which lets a caller split a messy working copy),
   * gets the description, and a new working-copy change becomes `@` (empty unless
   * some changes were left behind). Warnings jj reports on a zero exit (for
   * example a pathspec that matched no file) are returned instead of being
   * discarded, because a silent empty commit would defeat the split workflow.
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
      .filter((line) => /^Warning:/.test(line));
    if (warningLines.length > 0) warnings.push(bound(warningLines.join('\n'), 2 * 1024).text);
    const workingCopy = await this.readAt(cwd, signal);
    const committed = await this.readAt(cwd, signal, '@-');
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
  async descriptionSamples(cwd: string, revset: string, limit: number, signal?: AbortSignal): Promise<readonly string[]> {
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
        // A bounded output stream can cut the last JSON record in half; the complete
        // records before it are still useful (a style sample is best-effort).
        if (result.truncated && index === lines.length - 1) break;
        throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`, {
          argv,
          exitCode: 0,
          stderr: error instanceof Error ? error.message : '',
          stdout: bound(result.stdout, 512).text,
        });
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
      throw badInput('jj_squash needs a message path: pass -m <message> or useDestinationMessage: true (jj would otherwise open an editor).');
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
    const headOperationId = await this.headOperationId(cwd, signal);
    const argv = operationId === undefined ? ['undo'] : ['op', 'restore', operationId];
    const result = await this.run(cwd, argv, signal);
    const message = [
      bound(result.stdout.trim(), 2 * 1024).text,
      `head operation before this call: ${headOperationId} — to roll back, run \`jj op restore ${headOperationId}\` (a second \`jj undo\` would undo this undo, not redo it).`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');
    return {
      mode: operationId === undefined ? 'undo' : 'restore',
      operationId: operationId ?? headOperationId,
      headOperationId,
      message,
    };
  }

  /** `jj op log -n 1 --no-graph -T 'self.id()'` — the self-protection step (contract §8.3b). */
  async headOperationId(cwd: string, signal?: AbortSignal): Promise<string> {
    try {
      const argv = ['op', 'log', '-n', '1', '--no-graph', '-T', 'self.id()'];
      const result = await this.runJj(this.options(cwd, argv, signal));
      const id = result.stdout.trim().split('\n')[0]?.trim();
      return id !== undefined && id.length > 0 ? id : 'unknown';
    } catch {
      return 'unknown';
    }
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
        throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`, {
          argv,
          exitCode: 0,
          stderr: '',
          stdout: bound(result.stdout, 512).text,
        });
      }
      if (record === undefined) continue;
      const id = String(record['id'] ?? '');
      const attributes = asRecord(record['attributes']) ?? {};
      operations.push({
        id,
        shortId: id.slice(0, 12),
        description: String(record['description'] ?? ''),
        time: String(record['time'] ?? ''),
        user: `${String(record['username'] ?? '')}@${String(record['hostname'] ?? '')}`,
        workspaceName: record['workspace_name'] === null || record['workspace_name'] === undefined ? null : String(record['workspace_name']),
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
    const argv = ['workspace', 'add', path];
    if (name !== undefined && name.length > 0) argv.push('--name', name);
    for (const parent of parents) argv.push('-r', parent);
    if (message !== undefined && message.length > 0) argv.push('-m', message);
    if (colocate === true) argv.push('--colocate');
    await this.run(cwd, argv, signal);

    const workspaces = await this.workspaceList(cwd, signal);
    const created = workspaces.find((workspace) => workspace.name === name) ?? workspaces.find((workspace) => workspace.root === path) ?? workspaces[workspaces.length - 1];
    if (created === undefined) {
      throw new JjError('JJ_OUTPUT_INVALID', `\`jj workspace add\` did not report a new workspace for ${path}.`, {
        argv,
        exitCode: 0,
        stderr: '',
        stdout: '',
      });
    }
    const change = await this.readAt(created.root, signal);
    return { path: created.root, name: created.name, change };
  }

  /** `jj workspace list -T 'name ++ "\t" ++ root ++ "\n"'`. */
  async workspaceList(cwd: string, signal?: AbortSignal): Promise<readonly { name: string; root: string }[]> {
    const argv = ['workspace', 'list', '--ignore-working-copy', '-T', TPL_WORKSPACE_LIST_TAB];
    const result = await this.run(cwd, argv, signal);
    const workspaces: { name: string; root: string }[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const [name, root] = line.split('\t');
      if (name === undefined || root === undefined) continue;
      workspaces.push({ name: name.trim(), root: root.trim() });
    }
    return workspaces;
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
        throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`, {
          argv,
          exitCode: 0,
          stderr: '',
          stdout: bound(result.stdout, 512).text,
        });
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

  /** `jj bookmark set <name> -r <revset> [--allow-backwards]`, then read the target back. */
  async bookmarkSet(
    cwd: string,
    name: string,
    revset: string,
    allowBackwards: boolean,
    signal?: AbortSignal,
  ): Promise<{ name: string; target: string; moved: boolean }> {
    if (!BOOKMARK_NAME_RE.test(name) || name.includes('@')) {
      throw badInput("bookmark names must be non-empty and must not contain whitespace or '@'.");
    }
    const before = await this.bookmarkList(cwd, false, signal);
    const existing = before.find((bookmark) => bookmark.name === name);
    const argv = ['bookmark', 'set', name, '-r', revset];
    if (allowBackwards) argv.push('--allow-backwards');
    await this.run(cwd, argv, signal);
    const after = await this.bookmarkList(cwd, false, signal);
    const target = after.find((bookmark) => bookmark.name === name)?.target ?? '';
    return { name, target, moved: existing !== undefined };
  }

  /**
   * `jj rebase (-r|-s|-b) <revision> -d <destination>`.
   *
   * jj 0.46 distinguishes the selection modes sharply: `-r` moves only the named
   * revisions and leaves their descendants behind (re-parented onto the old
   * parents), while `-s` moves the revision together with all of its descendants.
   * Moving a whole stack (the multi-session hand-off) therefore needs
   * `mode: 'source'`; the default stays `revisions` to preserve existing callers.
   */
  async rebase(
    cwd: string,
    revision: string,
    destination: string,
    signal?: AbortSignal,
    mode: JjRebaseMode = 'revisions',
  ): Promise<string> {
    const flag = REBASE_MODE_FLAGS[mode] ?? '-r';
    const argv = ['rebase', flag, revision, '-d', destination];
    const result = await this.run(cwd, argv, signal);
    // jj prints the "Rebased N commits…" status on stderr even on success, so fall
    // back to it when stdout is empty; the model gets a real result summary.
    return bound(result.stdout.trim() || result.stderr.trim(), 2 * 1024).text;
  }

  /** Read `@` (or a revset) as a {@link JjChangeRecord}. */
  private async readAt(cwd: string, signal?: AbortSignal, revset = '@'): Promise<JjChangeRecord> {
    const argv = ['log', '-r', revset, '--no-graph', '-T', TPL_STATUS];
    const result = await this.run(cwd, argv, signal);
    return changeFromRecord(parseJsonLine(result.stdout, argv));
  }
}

/** Plugin configuration schema re-exported for the service entry. */
export { Config };

/**
 * `ctx.jj` — the Cordis service face of {@link JjOperations}.
 *
 * The TTL cache is what makes the synchronous guard possible: `peek` never
 * spawns, `warm` refreshes, and disposal aborts in-flight work and clears it.
 */
export class JjService extends Service {
  static inject = ['subprocess', 'workingDirectory'];
  static Config = Config;

  readonly operations: JjOperations;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cache = new Map<string, { descriptor: VcsDescriptor; probedAt: number }>();
  private versionCache: { jj: string | undefined; git: string | undefined } | undefined;

  constructor(ctx: Context, config: JjPluginConfig = {}) {
    super(ctx, 'jj');
    const resolved = resolveConfig(config);
    assertServiceableConfig(resolved);
    this.operations = new JjOperations({
      config,
      runJj: (options) => this.track(createRunJj(ctx, resolved)(options)),
    });
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('dsh-jj service disposed'));
      await Promise.allSettled(this.pending);
      this.pending.clear();
      this.cache.clear();
    });
  }

  /** Track one in-flight jj call so disposal can settle it. */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** TTL-cached detection (contract §6.4). */
  async detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor> {
    const key = this.cacheKey(cwd);
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() - cached.probedAt <= this.operations.config.detectCacheTtlMs) {
      return cached.descriptor;
    }
    return await this.warm(cwd, signal);
  }

  /** Forced refresh of the detection cache. */
  async warm(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor> {
    const descriptor = await this.track(detectVcs(cwd, this.detectDeps(), signal));
    this.cache.set(this.cacheKey(cwd), { descriptor, probedAt: descriptor.probedAt });
    return descriptor;
  }

  /** Synchronous cache read for the guard; `undefined` on a miss (fail-open). */
  peek(cwd: string): VcsDescriptor | undefined {
    return this.cache.get(this.cacheKey(cwd))?.descriptor;
  }

  /** Single-line human summary (contract §5.4). */
  describe(target: VcsDescriptor | VcsKind): string {
    if (typeof target === 'string') {
      switch (target) {
        case 'git':
          return 'Git repository (no Jujutsu workspace)';
        case 'jj-native':
          return 'Jujutsu (jj) native repository';
        case 'jj-colocated':
          return 'Jujutsu (jj) colocated with Git';
        case 'none':
          return 'No repository';
      }
    }
    const descriptor = target;
    return `${descriptor.kind} workspace "${descriptor.workspaceName ?? 'unknown'}" at ${descriptor.root} (${descriptor.jjVersion ?? 'jj version unknown'})`;
  }

  /** Process-lifetime version cache. */
  async version(cwd: string, signal?: AbortSignal): Promise<{ jj: string | undefined; git: string | undefined }> {
    if (this.versionCache !== undefined) return this.versionCache;
    const probe = await this.operations.version(cwd, signal);
    const descriptor = this.peek(cwd);
    this.versionCache = { jj: probe.jj ?? descriptor?.jjVersion, git: descriptor?.gitVersion };
    return this.versionCache;
  }

  private cacheKey(cwd: string): string {
    try {
      return resolveKey(cwd);
    } catch {
      return cwd;
    }
  }

  private detectDeps() {
    const resolved = this.operations.config;
    return {
      runJj: createRunJj(this.ctx, resolved),
      runGit: createRunGit(this.ctx, resolved),
      jjCommand: resolved.jjCommand,
      gitCommand: resolved.gitCommand,
      timeoutMs: resolved.timeoutMs,
    };
  }
}

function resolveKey(cwd: string): string {
  // path.resolve without realpath: the guard's sync path cannot do I/O.
  return cwd.startsWith('/') ? cwd.replace(/\/+$/, '') || '/' : cwd;
}