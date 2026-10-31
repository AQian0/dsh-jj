/**
 * Parsers for the jj outputs behind the workspace-changes recorder.
 *
 * A recorder turn runs two `jj diff` commands for one commit pair:
 *
 * 1. `jj diff --from <from> --to <to> -T 'path ++ "\0"'` prints one
 *    NUL-terminated workspace-relative target path per changed entry, in jj's
 *    diff order. That listing is authoritative: the `--git` output below is
 *    parsed against it, so a path that needs quoting or renaming can never be
 *    misattributed.
 * 2. `jj diff --from <from> --to <to> --git` prints a Git-format unified diff
 *    with per-file hunks. jj 0.46 never C-quotes paths, but the Git quoting form
 *    is tolerated defensively because a future jj release may adopt it.
 *
 * The turn-boundary snapshot (`jj log -r @`) additionally reports files jj
 * refuses to snapshot because they are larger than
 * `snapshot.max-new-file-size`; {@link parseRefusedSnapshotFiles} reads that
 * warning out of the command's stderr so the recorder can list those files in
 * the card instead of dropping them silently.
 *
 * This module is pure: no I/O, no subprocess, and no `@deepseek-ai/*` runtime
 * import (the declarations it needs are imported as types only).
 *
 * @module dsh-jj/changes-diff
 */

import type { WorkspaceDiffHunk } from '@deepseek-ai/dsh-workspace-changes/types';
import type { ParsedChange, ParsedChangeStatus } from './changes-types.ts';

/** Prefix of the line that starts one Git-format diff section. */
const SECTION_PREFIX = 'diff --git ';

/** Marker Git uses for the "no newline at end of file" note (not hunk content). */
const NO_NEWLINE_MARKER = '\\';

/** Hunk header: `@@ -oldStart[,oldLines] +newStart[,newLines] @@`. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Two C-quoted path tokens, as Git would print them in a `diff --git` header. */
const QUOTED_HEADER = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;

/**
 * Parse the NUL-separated path listing produced by
 * `jj diff -T 'path ++ "\0"'`.
 *
 * The template emits one path plus one NUL per entry, so the output normally
 * ends with a NUL (and therefore with an empty split record). That final empty
 * record is dropped; a stream without a trailing NUL is accepted too. The
 * function never throws: malformed output degrades to the records it contains.
 *
 * @param output - raw stdout of the path-listing command.
 * @returns target paths in jj's diff order; paths are workspace-relative and slash-separated.
 */
export function parseNulPaths(output: string): string[] {
  const records = output.split('\0');
  if (records.length > 0 && records[records.length - 1] === '') records.pop();
  return records.filter((record) => record.length > 0);
}

/** Heading line of the stderr warning jj prints when it refuses to snapshot oversized new files. */
const REFUSED_SNAPSHOT_HEADER = /^Warning: Refused to snapshot (?:some files|\d+ files?):$/;

/**
 * One file entry of that warning: a two-space indent, the path (relative to the
 * command's working directory), and jj's size / configured-cap explanation.
 */
const REFUSED_SNAPSHOT_ENTRY = /^ {2}(.+): [^(]*\(\d+ bytes\); the maximum size allowed is /;

/**
 * Parse the paths jj refused to snapshot out of one command's stderr.
 *
 * jj snapshots the working copy before most commands and ignores new files above
 * `snapshot.max-new-file-size` (1 MiB by default), printing a warning block that
 * names each refused path relative to the command's working directory. The
 * recorder lists those files in the turn's card as oversized entries because the
 * working-copy diff can never contain them.
 *
 * The parser is deliberately fail-open: a stderr without the warning yields an
 * empty list, and the first line that does not have the entry shape ends the
 * block, so an unrelated warning (or a future jj format change) degrades to
 * "nothing refused" instead of throwing or inventing a path.
 *
 * @param stderr - stderr of one jj command.
 * @returns refused paths in jj's order, each relative to that command's working directory.
 */
export function parseRefusedSnapshotFiles(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((line) => REFUSED_SNAPSHOT_HEADER.test(line));
  if (start < 0) return [];
  const refused: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = REFUSED_SNAPSHOT_ENTRY.exec(lines[index]);
    if (match === null) break;
    refused.push(match[1]);
  }
  return refused;
}

/**
 * Undo Git's C-style quoting around a path token.
 *
 * Only the escapes Git can emit are decoded (`\\`, `\"`, `\t`, `\n`). Any other
 * escape, a missing closing quote, or a trailing backslash means the token is
 * not something this parser understands, so the raw token is returned unchanged.
 *
 * @param token - one path token exactly as it appeared in the diff.
 * @returns the decoded path, or the raw token when it is not valid C quoting.
 */
function unquoteGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return token;
  const inner = token.slice(1, -1);
  let decoded = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    const escaped = inner[index + 1];
    index += 1;
    if (escaped === '\\') decoded += '\\';
    else if (escaped === '"') decoded += '"';
    else if (escaped === 't') decoded += '\t';
    else if (escaped === 'n') decoded += '\n';
    else return token;
  }
  return decoded;
}

/** Strip one `a/` or `b/` diff prefix from a path token. */
function stripDiffPrefix(token: string, prefix: string): string {
  return token.startsWith(prefix) ? token.slice(prefix.length) : token;
}

/**
 * Split one raw `--git` output into per-section texts.
 *
 * A section starts at a line that begins exactly with `diff --git ` and runs to
 * the next such line or the end of the text. Hunk body lines always carry a
 * `+`, `-`, or space prefix, so they can never be mistaken for a section start.
 *
 * @param diffText - raw stdout of `jj diff --git`.
 * @returns section texts, each including its own `diff --git` line and trailing newline.
 */
function splitSections(diffText: string): string[] {
  const marker = `\n${SECTION_PREFIX}`;
  const starts: number[] = [];
  if (diffText.startsWith(SECTION_PREFIX)) starts.push(0);
  let found = diffText.indexOf(marker);
  while (found !== -1) {
    starts.push(found + 1);
    found = diffText.indexOf(marker, found + 1);
  }
  const sections: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const next = starts[index + 1];
    sections.push(diffText.slice(start, next ?? diffText.length));
  }
  return sections;
}

/** Split one section into lines, dropping only the line terminator of the last line. */
function splitLines(sectionText: string): string[] {
  const body = sectionText.endsWith('\n') ? sectionText.slice(0, -1) : sectionText;
  return body.length === 0 ? [] : body.split('\n');
}

/** Read the two path tokens of a `diff --git a/X b/Y` line. */
function headerPathPair(headerLine: string): readonly [string, string] | undefined {
  const rest = headerLine.slice(SECTION_PREFIX.length);
  const quoted = QUOTED_HEADER.exec(rest);
  if (quoted !== null) return [quoted[1], quoted[2]];
  const separator = rest.indexOf(' b/');
  if (separator <= 0) return undefined;
  return [rest.slice(0, separator), rest.slice(separator + 1)];
}

/**
 * Best-effort target path of a section whose authoritative path is unavailable.
 *
 * The `a/X b/Y` header only names a path when both stripped sides agree, which
 * is the case for modify and metadata-only sections but not for renames (those
 * carry their own `rename to` line, tried first).
 *
 * @param headerLine - the section's `diff --git` line.
 * @returns the target path, or `undefined` when the header is ambiguous.
 */
function headerTargetPath(headerLine: string): string | undefined {
  const pair = headerPathPair(headerLine);
  if (pair === undefined) return undefined;
  const oldPath = stripDiffPrefix(unquoteGitPath(pair[0]), 'a/');
  const newPath = stripDiffPrefix(unquoteGitPath(pair[1]), 'b/');
  return oldPath === newPath ? newPath : undefined;
}

/** Read the old and new path tokens of a `Binary files a/X and b/Y differ` line. */
function binaryPathPair(line: string): readonly [string, string] | undefined {
  const withoutPrefix = line.slice('Binary files '.length);
  const body = withoutPrefix.endsWith(' differ') ? withoutPrefix.slice(0, -' differ'.length) : withoutPrefix;
  const separator = body.lastIndexOf(' and ');
  if (separator <= 0) return undefined;
  return [unquoteGitPath(body.slice(0, separator)), unquoteGitPath(body.slice(separator + ' and '.length))];
}

/**
 * Derive one target path from a section's lines when the authoritative listing
 * does not line up with the sections.
 *
 * Precedence: `rename to` / `copy to`, then the `+++ b/X` content line (skipping
 * `+++ /dev/null`), then the `Binary files` line, then the `diff --git` header.
 *
 * @param lines - section lines, `diff --git` line first.
 * @returns the derived target path, or `undefined` when none of the sources is usable.
 */
function deriveSectionPath(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (line.startsWith('rename to ')) return unquoteGitPath(line.slice('rename to '.length));
    if (line.startsWith('copy to ')) return unquoteGitPath(line.slice('copy to '.length));
  }
  const addedLine = lines.find((line) => line.startsWith('+++ '));
  if (addedLine !== undefined) {
    const token = unquoteGitPath(addedLine.slice('+++ '.length));
    if (token !== '/dev/null') return stripDiffPrefix(token, 'b/');
  }
  const binaryLine = lines.find((line) => line.startsWith('Binary files '));
  if (binaryLine !== undefined) {
    const pair = binaryPathPair(binaryLine);
    if (pair !== undefined) {
      if (pair[1] !== '/dev/null') return stripDiffPrefix(pair[1], 'b/');
      if (pair[0] !== '/dev/null') return stripDiffPrefix(pair[0], 'a/');
    }
  }
  const headerLine = lines[0];
  return headerLine === undefined ? undefined : headerTargetPath(headerLine);
}

/** Derive a rename/copy source path from a section's `rename from` / `copy from` line. */
function deriveOldPath(lines: readonly string[], path: string): string | undefined {
  for (const line of lines) {
    let source: string | undefined;
    if (line.startsWith('rename from ')) source = line.slice('rename from '.length);
    else if (line.startsWith('copy from ')) source = line.slice('copy from '.length);
    if (source === undefined) continue;
    const decoded = unquoteGitPath(source);
    return decoded === path ? undefined : decoded;
  }
  return undefined;
}

/**
 * Derive how the changed file itself changed from a section's marker lines.
 *
 * Rename/copy markers win over the `/dev/null` heuristics: a rename or copy
 * section also carries ordinary `---`/`+++` content headers, and jj emits
 * `new file mode` / `deleted file mode` for plain adds and deletes. Sections
 * with no marker at all (mode-only changes, pure content edits) are `modified`.
 *
 * @param lines - section lines, `diff --git` line first.
 * @returns the file status for this section; never guessed from the path list.
 */
function deriveStatus(lines: readonly string[]): ParsedChangeStatus {
  let added = false;
  let deleted = false;
  let renamed = false;
  let copied = false;
  for (const line of lines) {
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) renamed = true;
    else if (line.startsWith('copy from ') || line.startsWith('copy to ')) copied = true;
    else if (line.startsWith('new file mode') || line === '--- /dev/null') added = true;
    else if (line.startsWith('deleted file mode') || line === '+++ /dev/null') deleted = true;
  }
  if (renamed) return 'renamed';
  if (copied) return 'copied';
  if (added) return 'added';
  if (deleted) return 'deleted';
  return 'modified';
}

/** Hunk line count from an optional header group (a missing count means one line). */
function hunkCount(group: string | undefined): number {
  return group === undefined ? 1 : Number.parseInt(group, 10);
}

/**
 * Parse the hunks of one non-binary section.
 *
 * Body lines keep their `+`, `-`, or space prefix. A hunk ends at the next `@@`
 * line, at the section end, or at the first line that is not hunk content; the
 * `\ No newline at end of file` marker is skipped and never counted.
 *
 * @param lines - section lines, `diff --git` line first.
 * @returns hunks in file order, with header counts and body lines.
 */
function parseHunks(lines: readonly string[]): WorkspaceDiffHunk[] {
  const hunks: WorkspaceDiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index]);
    if (header === null) {
      index += 1;
      continue;
    }
    const hunk: WorkspaceDiffHunk = {
      oldStart: Number.parseInt(header[1], 10),
      oldLines: hunkCount(header[2]),
      newStart: Number.parseInt(header[3], 10),
      newLines: hunkCount(header[4]),
      lines: [],
    };
    index += 1;
    while (index < lines.length) {
      const body = lines[index];
      if (body.startsWith('@@')) break;
      if (body.startsWith(NO_NEWLINE_MARKER)) {
        index += 1;
        continue;
      }
      if (body.startsWith('+') || body.startsWith('-') || body.startsWith(' ')) {
        hunk.lines.push(body);
        index += 1;
        continue;
      }
      break;
    }
    hunks.push(hunk);
  }
  return hunks;
}

/** Build one {@link ParsedChange} from a section and its resolved target path. */
function parseSection(sectionText: string, lines: readonly string[], path: string): ParsedChange {
  const binary = lines.some((line) => line.startsWith('Binary files '));
  const hunks = binary ? [] : parseHunks(lines);
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) deleted += 1;
    }
  }
  const oldPath = deriveOldPath(lines, path);
  return {
    status: deriveStatus(lines),
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    added,
    deleted,
    binary,
    hunks,
    diffBytes: Buffer.byteLength(sectionText, 'utf8'),
  };
}

/**
 * Parse the stdout of `jj diff --from <from> --to <to> --git` into per-file changes.
 *
 * `paths` must be the target paths for the same commit pair in the same order
 * (from {@link parseNulPaths}); when its length matches the number of diff
 * sections, each path is used verbatim and no path guessing happens. Otherwise
 * each section's path is derived best-effort and a section with no derivable
 * path is skipped. The function never throws: unrecognized input yields `[]`.
 *
 * @param diffText - raw stdout of the Git-format diff command.
 * @param paths - authoritative target paths for the same commit pair, in order.
 * @returns one entry per changed file, in diff order; empty for an empty diff.
 */
export function parseGitFormatDiff(diffText: string, paths: readonly string[]): ParsedChange[] {
  if (diffText.length === 0) return [];
  const sections = splitSections(diffText);
  if (sections.length === 0) return [];
  const authoritative = paths.length === sections.length;
  const changes: ParsedChange[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const sectionText = sections[index];
    const lines = splitLines(sectionText);
    const path = authoritative ? paths[index] : deriveSectionPath(lines);
    if (path === undefined) continue;
    changes.push(parseSection(sectionText, lines, path));
  }
  return changes;
}
