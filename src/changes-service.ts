/**
 * Combined `workspaceChanges` service: the jj recorder's per-turn summaries
 * merged with the Host's built-in Git recorder.
 *
 * The Host runs the built-in recorder in an isolated Cordis service scope so a
 * jj-native Session (no `.git`) can still be served. This module builds the
 * service the parent scope provides: for a Session whose turn the jj recorder
 * recorded, it answers from the jj summary and adds the built-in recorder's
 * files that jj did not see (file-tool captures inside a colocated workspace).
 * For every other Session it is a transparent facade over the built-in service.
 *
 * Two event streams reach the Host: `workspace/changes` events appended by the
 * jj recorder and events appended by the built-in recorder. A summary request
 * carries only the announcing sequence, so the bridge uses
 * {@link BridgeOptions.observedTurn} to map either stream's sequence back to its
 * turn and then looks up both recorders for that turn:
 *
 * - the jj recorder's last summary for the turn (it owns the durable paths);
 * - the newest built-in summary for the turn, taken from the candidate sequences
 *   {@link BridgeOptions.upstreamSeqs} reports (the built-in recorder replaces a
 *   turn's earlier event with a later one, so a stale sequence must not win).
 *
 * Merging deduplicates files by absolute path, keeps the jj entry on a duplicate
 * (jj derived its line counts from the working-copy diff), appends the
 * remaining built-in entries, sorts by `display`, and caps the list at
 * `maxFiles`. The merged `total` and line sums are documented on
 * {@link mergeSummary}; they are deliberately an approximation because the
 * built-in recorder's summary no longer carries the counts of the files its own
 * cap omitted.
 *
 * The bridge is recomputed on every call (no mutable cache): a late-arriving
 * event may change which built-in sequence is newest, and the summary and the
 * comparison must always agree on the merged order for the same inputs.
 *
 * Pure module: no I/O and no `@deepseek-ai/*` runtime import.
 *
 * @module dsh-jj/changes-service
 */

import type {
  WorkspaceChangedFile,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types';

import { absoluteSummaryPath, compareDisplay } from './changes-paths.ts';
import type { TurnChangesRecorder } from './changes-recorder.ts';

/** The Host-facing shape of the `workspaceChanges` service (a subset of DSH's `WorkspaceChanges`). */
export interface ChangesServiceLike {
  /**
   * The summary announced by one `workspace/changes` event, either recorder's.
   *
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the merged summary, or undefined when neither recorder knows the sequence.
   */
  summary(sessionId: string, seq: number): WorkspaceChangesSummary | undefined;
  /**
   * Compare one listed file of one announced summary.
   *
   * @param sessionId - the Session that appended the event.
   * @param seq - the announcing event's sequence number.
   * @param index - the file's index in the merged summary's `files`.
   * @param signal - cancels the reads; forwarded to the serving recorder.
   * @returns the comparison, or undefined when no recorder has that file.
   * @throws when the serving recorder's read fails for a live Session.
   */
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>;
}

/** What the bridge needs from the Host entry to resolve one event sequence. */
export interface BridgeOptions {
  /** The jj recorder that appended the jj side of the merged view. */
  readonly recorder: TurnChangesRecorder;
  /** The built-in recorder's service in its isolated scope; absent when that row is not mounted. */
  readonly upstream: ChangesServiceLike | undefined;
  /** Maps any `workspace/changes` sequence of a Session to its turn, for either recorder's events. */
  readonly observedTurn: (sessionId: string, seq: number) => number | undefined;
  /** Candidate built-in sequences announced for one turn, oldest first. */
  readonly upstreamSeqs: (sessionId: string, turn: number) => readonly number[];
  /** Maximum files carried by one merged summary; `total` still reports the complete count. */
  readonly maxFiles: number;
}

/** A built-in summary together with the sequence that announced it. */
interface UpstreamSummary {
  readonly summary: WorkspaceChangesSummary;
  readonly seq: number;
}

/** One merged file and the recorder/index that can serve its comparison. */
interface MergedFile {
  readonly file: WorkspaceChangedFile;
  readonly entry: MergedEntry;
}

/** Where one merged file's comparison comes from. */
type MergedEntry =
  | { readonly source: 'own'; readonly index: number }
  | { readonly source: 'upstream'; readonly seq: number; readonly index: number };

/** The merged file list before the cap, plus the built-in contributions to the totals. */
interface MergeView {
  /** Every merged file in `display` order, duplicates already removed. */
  readonly all: readonly MergedFile[];
  /** Built-in files not duplicated by a jj file (over the built-in summary's complete list). */
  readonly upstreamOnlyCount: number;
  /** Line additions of the built-in-only files the built-in summary listed. */
  readonly upstreamOnlyAdded: number;
  /** Line deletions of the built-in-only files the built-in summary listed. */
  readonly upstreamOnlyDeleted: number;
}

/**
 * Create the merged `workspaceChanges` service the Host provides in the parent
 * scope.
 *
 * @param options - the jj recorder, the isolated built-in service, the sequence
 *   lookups the Host owns, and the merged file cap.
 * @returns the service implementing DSH's `workspaceChanges` contract.
 */
export function createChangesService(options: BridgeOptions): ChangesServiceLike {
  return {
    summary(sessionId, seq) {
      return summaryOf(options, sessionId, seq);
    },
    async diff(sessionId, seq, index, signal) {
      return diffOf(options, sessionId, seq, index, signal);
    },
  };
}

/** Resolve one summary request across both recorders. */
function summaryOf(options: BridgeOptions, sessionId: string, seq: number): WorkspaceChangesSummary | undefined {
  const own = options.recorder.summary(sessionId, seq);
  if (own !== undefined) return own;
  const turn = options.observedTurn(sessionId, seq);
  if (turn === undefined) return options.upstream?.summary(sessionId, seq);
  const ownTurn = options.recorder.summaryForTurn(sessionId, turn);
  const base = newestUpstreamSummary(options, sessionId, turn);
  if (ownTurn === undefined) return base?.summary;
  if (base === undefined) return ownTurn;
  return mergeSummary(ownTurn, base, options.maxFiles);
}

/** Resolve one comparison request across both recorders. */
async function diffOf(
  options: BridgeOptions,
  sessionId: string,
  seq: number,
  index: number,
  signal: AbortSignal,
): Promise<WorkspaceFileDiff | undefined> {
  const own = await options.recorder.diff(sessionId, seq, index, signal);
  if (own !== undefined) return own;
  const turn = options.observedTurn(sessionId, seq);
  if (turn === undefined) return options.upstream?.diff(sessionId, seq, index, signal);
  const ownTurn = options.recorder.summaryForTurn(sessionId, turn);
  const base = newestUpstreamSummary(options, sessionId, turn);
  const entry = mergeView(ownTurn, base).all[index];
  if (entry !== undefined) {
    const resolved =
      entry.entry.source === 'own'
        ? await options.recorder.diffForTurn(sessionId, turn, entry.entry.index, signal)
        : await options.upstream?.diff(sessionId, entry.entry.seq, entry.entry.index, signal);
    if (resolved !== undefined) return resolved;
  }
  // An out-of-range or unresolvable index falls back to the announcing sequence,
  // which lets the built-in recorder answer for events this bridge cannot map.
  return options.upstream?.diff(sessionId, seq, index, signal);
}

/**
 * The newest built-in summary recorded for one turn.
 *
 * The built-in recorder announces a turn once per record attempt and a later
 * event replaces an earlier one, so scanning the candidate sequences from last
 * to first and taking the first defined summary yields the current view.
 *
 * @param options - bridge options carrying the service and the sequence lookup.
 * @param sessionId - the Session id.
 * @param turn - the turn whose built-in summary is wanted.
 * @returns the newest defined summary and its sequence, or undefined.
 */
function newestUpstreamSummary(options: BridgeOptions, sessionId: string, turn: number): UpstreamSummary | undefined {
  const upstream = options.upstream;
  if (upstream === undefined) return undefined;
  const seqs = options.upstreamSeqs(sessionId, turn);
  for (let at = seqs.length - 1; at >= 0; at -= 1) {
    const seq = seqs[at] as number;
    const summary = upstream.summary(sessionId, seq);
    if (summary !== undefined) return { summary, seq };
  }
  return undefined;
}

/**
 * Merge the two recorders' file lists for one turn.
 *
 * Deduplication is by absolute path: the jj summary's relative paths resolve
 * against the jj turn's working directory, the built-in summary's against its
 * own `cwd` (the two recorders may have been created with different working
 * directories). The jj entry wins on a duplicate; the built-in entries that
 * remain are appended, the whole list is sorted by `display`, and
 * {@link mergeSummary} applies the cap.
 *
 * @param own - the jj summary for the turn, or undefined.
 * @param base - the built-in summary for the turn, or undefined.
 * @returns the merged files plus the built-in totals the summary needs.
 */
function mergeView(own: WorkspaceChangesSummary | undefined, base: UpstreamSummary | undefined): MergeView {
  const files: MergedFile[] = [];
  const ownPaths = new Set<string>();
  if (own !== undefined) {
    for (let index = 0; index < own.files.length; index += 1) {
      const file = own.files[index] as WorkspaceChangedFile;
      ownPaths.add(absoluteSummaryPath(file.path, own.cwd));
      files.push({ file, entry: { source: 'own', index } });
    }
  }
  let upstreamOnlyCount = 0;
  let upstreamOnlyAdded = 0;
  let upstreamOnlyDeleted = 0;
  if (base !== undefined) {
    for (let index = 0; index < base.summary.files.length; index += 1) {
      const file = base.summary.files[index] as WorkspaceChangedFile;
      if (ownPaths.has(absoluteSummaryPath(file.path, base.summary.cwd))) continue;
      upstreamOnlyCount += 1;
      upstreamOnlyAdded += file.added;
      upstreamOnlyDeleted += file.deleted;
      files.push({ file, entry: { source: 'upstream', seq: base.seq, index } });
    }
  }
  files.sort((a, b) => compareDisplay(a.file, b.file));
  return { all: files, upstreamOnlyCount, upstreamOnlyAdded, upstreamOnlyDeleted };
}

/**
 * Merge two defined summaries into the Host-facing view.
 *
 * The result keeps the jj summary's `turn`, `cwd`, and line counts (jj derived
 * them from the working-copy diff) and omits `snapshot` (the jj recorder has no
 * Git tree ids). Its `files` are the merged files capped at `maxFiles`.
 *
 * `total` and the line sums are an approximation, because the built-in
 * summary's `total`/`added`/`deleted` cover files its own `maxFiles` cap
 * omitted, and those omitted files carry no per-file counts the bridge could
 * re-add. The formula used is the specified one:
 *
 * - `total = own.total + (base.total - base.files.length) + baseOnlyListed`
 *   (the first term counts the jj files, the second the built-in files its cap
 *   omitted, the third the built-in files it listed that jj did not see; a
 *   listed built-in duplicate of a jj file is still counted by `base.total` and
 *   the jj total, so the sum slightly over-counts such duplicates);
 * - `added`/`deleted = own sums + the sums of the built-in-only listed files`.
 *
 * @param own - the jj summary for the turn.
 * @param base - the newest built-in summary for the turn.
 * @param maxFiles - the merged file cap.
 * @returns the merged summary.
 */
function mergeSummary(own: WorkspaceChangesSummary, base: UpstreamSummary, maxFiles: number): WorkspaceChangesSummary {
  const view = mergeView(own, base);
  const kept = view.all.slice(0, Math.max(0, maxFiles));
  return {
    turn: own.turn,
    cwd: own.cwd,
    files: kept.map((merged) => merged.file),
    total: own.total + (base.summary.total - base.summary.files.length) + view.upstreamOnlyCount,
    added: own.added + view.upstreamOnlyAdded,
    deleted: own.deleted + view.upstreamOnlyDeleted,
  };
}
