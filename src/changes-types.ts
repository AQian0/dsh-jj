/**
 * Pure data contracts shared by the Jujutsu workspace-changes bridge.
 *
 * The bridge records what one DSH turn changed in a Jujutsu (jj) workspace: it
 * snapshots the working-copy commit when the turn starts, diffs that commit
 * against the working-copy commit when the turn ends, and serves the resulting
 * file list (with line counts) as the Host's `workspaceChanges` summary.
 *
 * Every module that implements those steps depends only on these declarations,
 * Node's standard library, and type-only imports from
 * `@deepseek-ai/dsh-workspace-changes`; no module below the Host entry imports
 * a DSH runtime package.
 *
 * @module dsh-jj/changes-types
 */

import type { WorkspaceDiffHunk } from '@deepseek-ai/dsh-workspace-changes/types';

/**
 * How one file changed between the two working-copy snapshots.
 *
 * Mirrors jj's tree-diff entry statuses (`modified`, `added`, `removed`,
 * `copied`, `renamed`), with `removed` named `deleted` to match the Host's
 * changed-file vocabulary.
 */
export type ParsedChangeStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

/**
 * One file changed between two working-copy snapshot commits.
 *
 * Paths are relative to the jj workspace root and slash-separated, matching the
 * form `jj diff --git` prints and the form the Host's summary expects after
 * rebasing them onto the Session working directory.
 */
export interface ParsedChange {
  /** How the file changed; `added` means it did not exist at turn start, `deleted` at turn end. */
  readonly status: ParsedChangeStatus;
  /** Target path relative to the jj workspace root, slash-separated. */
  readonly path: string;
  /** Source path of a rename or copy, workspace-relative; absent for add/modify/delete. */
  readonly oldPath?: string;
  /** Lines added by this change (zero for a binary file). */
  readonly added: number;
  /** Lines deleted by this change (zero for a binary file). */
  readonly deleted: number;
  /** jj reported the content as binary, so no lines are counted or served. */
  readonly binary: boolean;
  /** Three-context-line hunks in file order; empty for binary or metadata-only changes. */
  readonly hunks: readonly WorkspaceDiffHunk[];
  /** Bytes of the raw diff section, so a comparison can be refused as oversized. */
  readonly diffBytes: number;
}

/** Options every reader call receives; command limits are bound when the reader is created. */
export interface ChangesReaderOptions {
  /** Directory inside the jj workspace whose working copy is observed. */
  readonly cwd: string;
  /** Cancels the command. */
  readonly signal?: AbortSignal;
}

/** Options for diffing two working-copy snapshot commits. */
export interface TurnDiffOptions extends ChangesReaderOptions {
  /** Turn-start working-copy commit id. */
  readonly from: string;
  /** Turn-end working-copy commit id. */
  readonly to: string;
}

/**
 * Reads one Jujutsu workspace's turn boundaries.
 *
 * Both methods resolve to `undefined` instead of throwing: recording is a
 * best-effort side channel, so a missing binary, a broken repository, a stale
 * working copy, or a truncated response must never break the turn.
 */
export interface JjChangesReader {
  /** Snapshot the working copy and return its commit id for a turn boundary. */
  readCommit(options: ChangesReaderOptions): Promise<string | undefined>;
  /** Diff two snapshot commits into per-file changes. */
  readDiff(options: TurnDiffOptions): Promise<readonly ParsedChange[] | undefined>;
}
