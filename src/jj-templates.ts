/**
 * Pure jj template constants and record parsing helpers.
 *
 * This module is deliberately pure: it imports only the type-only vocabulary from
 * `types.ts` (no DSH runtime imports, no I/O, no subprocess) so the
 * build test can protect it as a pure module. Parsers throw
 * {@link TemplateParseError}; the operations layer in `service.ts` converts that
 * into the contract `JjError` so model-facing error codes/messages are unchanged.
 *
 * @module dsh-jj/jj-templates
 */

import type { JjChange } from './types.ts';

/** `jj log -r <rev> --no-graph -T <TPL_STATUS>` template (contract §2.8, verbatim). */
export const TPL_STATUS =
  '"{\\"change_id\\":" ++ json(change_id) ++ ",\\"commit_id\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"current_working_copy\\":" ++ json(current_working_copy) ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"author\\":" ++ json(author.email()) ++ ",\\"paths\\":" ++ json(self.diff().files().map(|f| f.path())) ++ "}\\n"';

/**
 * `jj log` change template **without** the diff `paths` field (`TPL_STATUS` minus
 * `paths`).
 *
 * `self.diff()` is the expensive part of `TPL_STATUS`: on a working copy with
 * 3000 changed files one read costs ≈270ms instead of ≈23ms. The generic change
 * reader (the operations layer's `readAt`) therefore uses this template; only
 * `status()` (and `commit()`'s path reporting) needs the `paths` field.
 */
export const TPL_CHANGE =
  '"{\\"change_id\\":" ++ json(change_id) ++ ",\\"commit_id\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"current_working_copy\\":" ++ json(current_working_copy) ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"author\\":" ++ json(author.email()) ++ "}\\n"';

/**
 * `jj log` template returning only the commit id of every selected revision.
 *
 * Used for parent/base checks where the full change record (and its diff) is not
 * needed; one line per revision, in jj's revset order.
 */
export const TPL_COMMIT_IDS = 'commit_id ++ "\\n"';

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
export function bound(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}

/** One jj change, as parsed from the JSON templates. */
export interface JjChangeRecord extends JjChange {
  /**
   * Paths changed by this revision.
   *
   * Populated only by `status()` and `commit()` (which read with `TPL_STATUS`);
   * the generic change reader uses the lightweight `TPL_CHANGE` and leaves this
   * array empty so it never pays for `self.diff()`.
   */
  readonly paths: readonly string[];
}

/** Detail a template parser attaches to a parse failure; `JjOperations` rethrows it as a `JjError`. */
interface TemplateParseFailure {
  readonly argv: readonly string[];
  readonly stderr: string;
  readonly stdout: string;
}

/** Error thrown by a template parser; see {@link TemplateParseFailure}. */
export class TemplateParseError extends Error {
  readonly detail: TemplateParseFailure;

  constructor(message: string, detail: TemplateParseFailure) {
    super(message);
    this.name = 'TemplateParseError';
    this.detail = detail;
  }
}

/** Coerce a JSON value to a plain object record, or `undefined` for non-objects. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Parse the first non-empty line of a single-revision read as one JSON record.
 *
 * @throws TemplateParseError when the stream has no record or the first line is not a JSON object.
 */
export function parseJsonLine(stdout: string, argv: readonly string[]): Record<string, unknown> {
  const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    throw new TemplateParseError(`\`jj ${argv.join(' ')}\` returned no parseable record.`, {
      argv,
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
    throw new TemplateParseError(`\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(stdout, 512).text}`, {
      argv,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: bound(stdout, 512).text,
    });
  }
}

/** Convert one parsed template record into a {@link JjChangeRecord}. */
export function changeFromRecord(record: Record<string, unknown>): JjChangeRecord {
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

/**
 * Parse every non-empty line of a multi-revision read as JSON records.
 *
 * @throws TemplateParseError on the first unparseable line.
 */
export function parseChangeLines(stdout: string, argv: readonly string[]): JjChangeRecord[] {
  const changes: JjChangeRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record !== undefined) changes.push(changeFromRecord(record));
    } catch {
      throw new TemplateParseError(`\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(stdout, 512).text}`, {
        argv,
        stderr: '',
        stdout: bound(stdout, 512).text,
      });
    }
  }
  return changes;
}
