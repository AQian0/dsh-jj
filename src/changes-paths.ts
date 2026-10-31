/**
 * Path classification and display forms for the files one jj turn changed.
 *
 * The Host summary lists workspace-relative slash-separated paths and a
 * user-facing `display` label; both are derived here from the absolute path a
 * jj workspace-relative diff entry resolves to. The rules intentionally match
 * the Host's built-in Git recorder so a jj workspace and a Git repository show
 * the same labels.
 *
 * Pure module: no I/O and no `@deepseek-ai/*` runtime imports.
 *
 * @module dsh-jj/changes-paths
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Slash-separated form of a native relative path. */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Whether `path` is `root` itself or lies under it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The durable `path` field: relative inside the Session working directory,
 * absolute elsewhere.
 */
export function durablePathOf(absolute: string, cwd: string): string {
  return isInside(cwd, absolute) ? toPosix(relative(cwd, absolute)) : toPosix(absolute);
}

/**
 * Sort key and label for one changed file.
 *
 * Inside the working directory or the jj workspace root the label is the
 * working-directory-relative path, above it a `../` path, under the home
 * directory a `~` path, otherwise the absolute path. Always slash-separated.
 *
 * @param absolute - canonical absolute file path.
 * @param cwd - canonical Session working directory.
 * @param root - jj workspace root.
 * @param home - canonical home directory, or an empty string to skip the `~` form.
 * @returns the slash-separated display path.
 */
export function displayPathOf(absolute: string, cwd: string, root: string, home: string): string {
  if (isInside(cwd, absolute) || isInside(root, absolute)) return toPosix(relative(cwd, absolute));
  if (home !== '' && isInside(home, absolute)) return `~/${toPosix(relative(home, absolute))}`;
  return toPosix(absolute);
}

/**
 * Code-unit order of display paths, which places `../` and absolute paths
 * before letters and matches Git's own listing order for relative paths.
 */
export function compareDisplay(a: { readonly display: string }, b: { readonly display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
}

/**
 * Absolute form of one summary path, used to merge two recorders' file lists.
 *
 * @param path - a summary `path`: relative to `cwd`, or absolute outside it.
 * @param cwd - the working directory the summary's relative paths resolve against.
 * @returns the normalized absolute path.
 */
export function absoluteSummaryPath(path: string, cwd: string): string {
  return resolve(cwd, path);
}
