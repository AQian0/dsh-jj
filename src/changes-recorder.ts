/**
 * Per-turn change recorder for sessions whose working directory is a Jujutsu
 * workspace.
 *
 * The Host's built-in `workspace-changes` recorder derives its changed-file
 * summaries from Git and cannot see a jj-native repository (one without a
 * `.git`). This recorder is its jj counterpart: on `turn/start` it snapshots the
 * working-copy commit, on `agent/turn-stopping` it snapshots again, diffs the two
 * commits, and appends one `workspace/changes` event with the resulting summary.
 * The summary and the per-file comparisons stay in memory, keyed by the sequence
 * of the event that announced them, until the Session is disposed.
 *
 * The jj process itself is injected as a {@link JjChangesReader}; this module
 * contains no I/O and no `@deepseek-ai/*` runtime import, and it never throws
 * into the Host: every queued task catches its own failure and reports it
 * through the injected `warn` callback.
 *
 * Recording rules mirror the built-in recorder:
 *
 * - a turn is recorded only when at least one tool result landed inside it;
 * - a turn whose baseline snapshot failed (or returned nothing) records
 *   nothing, so the built-in recorder's Git-derived summary remains available
 *   (fail-open);
 * - a working copy whose turn-end commit equals its turn-start commit appends no
 *   event (nothing changed, so there is nothing to show);
 * - one Session's snapshot/diff/append work is serialized on a promise chain so
 *   concurrent turns, session disposal, and plugin disposal cannot interleave.
 *
 * @module dsh-jj/changes-recorder
 */

import { resolve } from 'node:path';

import type {
  WorkspaceChangedFile,
  WorkspaceChangesSummary,
  WorkspaceDiffHunk,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types';

import { compareDisplay, displayPathOf, durablePathOf } from './changes-paths.ts';
import type { JjChangesReader, ParsedChange } from './changes-types.ts';

/** Prefix of every diagnostic this module reports through the injected `warn`. */
const WARN_PREFIX = 'workspace-changes: jj: ';

/** The Session event type shared with the built-in recorder. */
const CHANGES_EVENT = 'workspace/changes';

/** One Session's append capability; the subset of DSH's `Session` this module uses. */
export interface ChangesSessionLike {
  /** Stable Session id; recording state is keyed by it. */
  readonly id: string;
  /** Append one Session event and return its sequence number. */
  append(type: string, data: unknown): { readonly seq: number };
}

/** Facts shared by every turn this recorder observes. */
export interface TurnChangesRecorderOptions {
  /** Reads jj working-copy commits and diffs them; the only I/O this recorder performs. */
  readonly reader: JjChangesReader;
  /** Maximum files carried by one summary; `total` still reports the complete count. */
  readonly maxFiles: number;
  /** Inclusive byte cap on one file's diff section; a larger file gets no comparison. */
  readonly maxFileBytes: number;
  /** Canonical home directory, used for the `~` display form; empty to disable it. */
  readonly home: string;
  /** Single-line failure reporter; a failed turn records nothing and produces no event. */
  readonly warn: (message: string) => void;
}

/** Where one recorded turn started: enough to resolve every changed path. */
export interface StartedTurn {
  /** The turn number from `turn/start`. */
  readonly turn: number;
  /** Session working directory at turn start; summary paths resolve against it. */
  readonly cwd: string;
  /** jj workspace root at turn start; parsed diff paths resolve against it. */
  readonly root: string;
}

/** The turn-start working-copy commit, once the baseline snapshot settled. */
type Baseline =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'commit'; readonly id: string };

/** State of the one turn this recorder currently has open for a Session. */
interface TurnState {
  readonly turn: number;
  readonly cwd: string;
  readonly root: string;
  /** Turn-start commit; `pending` until the queued snapshot settles. */
  baseline: Baseline;
  /** Sequence of the latest `tool/result` that landed inside this turn, or -1. */
  lastToolResultSeq: number;
  /** `lastToolResultSeq` seen when a record attempt was queued; guards the fallback. */
  attemptedAfterSeq: number;
}

/** How one listed file's two sides can be served to the Host. */
type Comparison =
  | {
      readonly kind: 'text';
      readonly hunks: readonly WorkspaceDiffHunk[];
      readonly before: boolean;
      readonly after: boolean;
    }
  | { readonly kind: 'binary' }
  | { readonly kind: 'oversized' };

/** One changed file and the comparison kept for it. */
interface ListedChange {
  readonly file: WorkspaceChangedFile;
  readonly comparison: Comparison;
}

/** Everything kept for one appended `workspace/changes` event. */
interface RecordedChanges {
  readonly summary: WorkspaceChangesSummary;
  /** Comparison per entry of `summary.files`, in the same order. */
  readonly comparisons: readonly Comparison[];
}

/** Per-Session queue, open turn, and records; recreated after `forget`. */
interface SessionState {
  /** Aborted by `forget` (Session disposal) and by {@link TurnChangesRecorder.dispose}. */
  readonly lifetime: AbortController;
  /** Serializes snapshot, diff, and append work for this Session. */
  chain: Promise<void>;
  /** The open turn, or `undefined` after disposal or before the first turn. */
  turn: TurnState | undefined;
  /** Records by the sequence of the event that announced them. */
  readonly records: Map<number, RecordedChanges>;
  /** Sequence of the last event recorded for one turn; the bridge's merge helper. */
  readonly lastSeqByTurn: Map<number, number>;
}

/**
 * Records what one DSH turn changed in a jj workspace and serves the resulting
 * summary and comparisons behind the `workspaceChanges` contract.
 *
 * The Host creates one recorder for the plugin, fans `turn/start`,
 * `tool/result`, `agent/turn-stopping`, `turn/end`, and `session/disposed` into
 * it, and wraps {@link summary} / {@link diff} in the merged service. A failed
 * read never escapes: the turn simply records nothing and the built-in
 * recorder's summary stays authoritative.
 */
export class TurnChangesRecorder {
  private readonly options: TurnChangesRecorderOptions;
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;

  /**
   * @param options - injected reader, display bounds, home directory, and warning sink.
   */
  constructor(options: TurnChangesRecorderOptions) {
    this.options = options;
  }

  /**
   * Turn started in a jj workspace: record the baseline snapshot asynchronously.
   *
   * A later turn supersedes the open one; the queued read of a superseded turn
   * still settles but can no longer be recorded.
   *
   * @param session - the Session whose turn started.
   * @param turn - turn number, working directory, and jj workspace root.
   */
  startTurn(session: ChangesSessionLike, turn: StartedTurn): void {
    if (this.disposed) return;
    const state = this.sessionState(session.id);
    const turnState: TurnState = {
      turn: turn.turn,
      cwd: turn.cwd,
      root: turn.root,
      baseline: { kind: 'pending' },
      lastToolResultSeq: -1,
      attemptedAfterSeq: -1,
    };
    state.turn = turnState;
    void this.enqueue(state, async (signal) => {
      try {
        const commit = await this.options.reader.readCommit({ cwd: turnState.cwd, signal });
        turnState.baseline = commit === undefined ? { kind: 'failed' } : { kind: 'commit', id: commit };
      } catch (error) {
        // A repository whose snapshot failed must not be summarized as unchanged.
        turnState.baseline = { kind: 'failed' };
        throw error;
      }
    });
  }

  /**
   * A tool result landed inside this turn.
   *
   * Mirrors the built-in recorder's "only record turns that ran tools" rule:
   * a turn without a tool result produces no summary even when files changed
   * (for example by an external process).
   *
   * @param session - the Session that appended the `tool/result` event.
   * @param turn - the turn the event belongs to.
   * @param seq - the event's sequence number.
   */
  noteToolResult(session: ChangesSessionLike, turn: number, seq: number): void {
    if (this.disposed) return;
    const turnState = this.sessions.get(session.id)?.turn;
    if (turnState === undefined || turnState.turn !== turn) return;
    if (seq > turnState.lastToolResultSeq) turnState.lastToolResultSeq = seq;
  }

  /**
   * Record the turn's changes inside the turn, before `turn/end` commits.
   *
   * The returned promise settles once the queued snapshot/diff/append work ran,
   * so awaiting it guarantees the `workspace/changes` event exists before the
   * turn end is committed. It never rejects: failures are reported through
   * `warn`.
   *
   * @param session - the Session whose turn is stopping.
   * @param turn - the stopping turn.
   * @returns after the record attempt settled or was skipped.
   */
  stopping(session: ChangesSessionLike, turn: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const state = this.sessions.get(session.id);
    const turnState = state?.turn;
    if (state === undefined || turnState === undefined || turnState.turn !== turn) return Promise.resolve();
    return this.recordTurn(state, turnState, session);
  }

  /**
   * After-turn fallback for hosts without the stopping hook; never records a
   * turn that already had a record attempt for its last tool result.
   *
   * @param session - the Session whose turn ended.
   * @param turn - the turn number from `turn/end`.
   */
  end(session: ChangesSessionLike, turn: number): void {
    if (this.disposed) return;
    const state = this.sessions.get(session.id);
    const turnState = state?.turn;
    if (state === undefined || turnState === undefined || turnState.turn !== turn) return;
    void this.recordTurn(state, turnState, session);
  }

  /**
   * Drop one Session's state and cancel its queued work (Session disposal).
   *
   * @param sessionId - the disposed Session's id.
   */
  forget(sessionId: string): void {
    if (this.disposed) return;
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.sessions.delete(sessionId);
    dropState(state);
  }

  /**
   * Abort queued reads and drop every record (plugin disposal).
   *
   * Afterwards every method is a no-op that resolves to `undefined`, so a late
   * host call cannot resurrect a disposed recorder.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.sessions.values()) dropState(state);
    this.sessions.clear();
  }

  /**
   * The summary announced by one of this recorder's `workspace/changes` events.
   *
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined for a sequence this recorder did not append.
   */
  summary(sessionId: string, seq: number): WorkspaceChangesSummary | undefined {
    if (this.disposed) return undefined;
    return this.sessions.get(sessionId)?.records.get(seq)?.summary;
  }

  /**
   * Compare one listed file's two sides, computed from the recorded diff.
   *
   * @param sessionId - the Session that appended the event.
   * @param seq - the announcing event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the call; an already-aborted signal resolves to `undefined`.
   * @returns the comparison, or undefined for an unknown sequence or index.
   */
  async diff(
    sessionId: string,
    seq: number,
    index: number,
    signal: AbortSignal,
  ): Promise<WorkspaceFileDiff | undefined> {
    if (this.disposed) return undefined;
    const record = this.sessions.get(sessionId)?.records.get(seq);
    if (record === undefined) return undefined;
    return comparisonDiff(record, index, signal);
  }

  /**
   * This recorder's last summary for one turn, for the merged Host service.
   *
   * @param sessionId - the Session id.
   * @param turn - the turn number.
   * @returns the summary of the last event recorded for that turn, or undefined.
   */
  summaryForTurn(sessionId: string, turn: number): WorkspaceChangesSummary | undefined {
    if (this.disposed) return undefined;
    const state = this.sessions.get(sessionId);
    const seq = state?.lastSeqByTurn.get(turn);
    if (state === undefined || seq === undefined) return undefined;
    return state.records.get(seq)?.summary;
  }

  /**
   * This recorder's comparison for one turn and file index, for the merged Host
   * service; it resolves the index against the turn's last recorded summary.
   *
   * @param sessionId - the Session id.
   * @param turn - the turn number.
   * @param index - the file's index in that summary's `files`.
   * @param signal - cancels the call.
   * @returns the comparison, or undefined when the turn or index is unknown.
   */
  async diffForTurn(
    sessionId: string,
    turn: number,
    index: number,
    signal: AbortSignal,
  ): Promise<WorkspaceFileDiff | undefined> {
    if (this.disposed) return undefined;
    const seq = this.sessions.get(sessionId)?.lastSeqByTurn.get(turn);
    if (seq === undefined) return undefined;
    return this.diff(sessionId, seq, index, signal);
  }

  /**
   * Whether `seq` is a `workspace/changes` event this recorder appended.
   *
   * The merged service uses it to tell its own events from the built-in
   * recorder's, which share the same Session event stream.
   *
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns true for one of this recorder's events.
   */
  ownsSeq(sessionId: string, seq: number): boolean {
    if (this.disposed) return false;
    return this.sessions.get(sessionId)?.records.has(seq) === true;
  }

  /** The state for one Session, created on first use. */
  private sessionState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        lifetime: new AbortController(),
        chain: Promise.resolve(),
        turn: undefined,
        records: new Map(),
        lastSeqByTurn: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Mark the turn for recording and queue the work; the fallback sees the mark. */
  private recordTurn(state: SessionState, turnState: TurnState, session: ChangesSessionLike): Promise<void> {
    if (turnState.attemptedAfterSeq >= turnState.lastToolResultSeq) return Promise.resolve();
    turnState.attemptedAfterSeq = turnState.lastToolResultSeq;
    return this.enqueue(state, (signal) => this.record(state, turnState, session, signal));
  }

  /** Serialize one task on the Session's chain, catching and reporting its failure. */
  private enqueue(state: SessionState, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const run = state.chain.then(async () => {
      const { signal } = state.lifetime;
      if (signal.aborted || this.disposed) return;
      try {
        await task(signal);
      } catch (error) {
        report(this.options.warn, error, signal, this.disposed);
      }
    });
    state.chain = run;
    return run;
  }

  /** The actual turn record: diff the two snapshots, build the summary, append the event. */
  private async record(
    state: SessionState,
    turnState: TurnState,
    session: ChangesSessionLike,
    signal: AbortSignal,
  ): Promise<void> {
    const baseline = turnState.baseline;
    if (baseline.kind !== 'commit') return;
    if (turnState.lastToolResultSeq < 0) return;
    const { cwd, root } = turnState;
    const end = await this.options.reader.readCommit({ cwd, signal });
    if (end === undefined || end === baseline.id || signal.aborted) return;
    const changes = await this.options.reader.readDiff({ cwd, from: baseline.id, to: end, signal });
    if (changes === undefined || changes.length === 0 || signal.aborted) return;
    const { home, maxFiles, maxFileBytes } = this.options;
    const listed: ListedChange[] = changes.map((change) => ({
      file: changedFile(change, cwd, root, home),
      comparison: comparisonOf(change, maxFileBytes),
    }));
    listed.sort((a, b) => compareDisplay(a.file, b.file));
    const files = listed.slice(0, Math.max(0, maxFiles));
    const summary: WorkspaceChangesSummary = {
      turn: turnState.turn,
      cwd,
      files: files.map((entry) => entry.file),
      total: listed.length,
      added: listed.reduce((sum, entry) => sum + entry.file.added, 0),
      deleted: listed.reduce((sum, entry) => sum + entry.file.deleted, 0),
    };
    if (signal.aborted || this.disposed) return;
    const event = session.append(CHANGES_EVENT, { turn: turnState.turn });
    state.records.set(event.seq, { summary, comparisons: files.map((entry) => entry.comparison) });
    state.lastSeqByTurn.set(turnState.turn, event.seq);
  }
}

/** Drop one Session's live state and cancel anything queued for it. */
function dropState(state: SessionState): void {
  state.lifetime.abort();
  state.records.clear();
  state.lastSeqByTurn.clear();
  state.turn = undefined;
}

/** The Host-facing file entry for one parsed change; binary files get zeroed counts. */
function changedFile(change: ParsedChange, cwd: string, root: string, home: string): WorkspaceChangedFile {
  const absolute = resolve(root, change.path);
  const added = change.binary ? 0 : change.added;
  const deleted = change.binary ? 0 : change.deleted;
  return {
    path: durablePathOf(absolute, cwd),
    display: displayPathOf(absolute, cwd, root, home),
    added,
    deleted,
    ...(change.binary ? { binary: true as const } : {}),
  };
}

/** The comparison kept for one parsed change; binary and oversized files refuse hunks. */
function comparisonOf(change: ParsedChange, maxFileBytes: number): Comparison {
  if (change.binary) return { kind: 'binary' };
  if (change.diffBytes > maxFileBytes) return { kind: 'oversized' };
  return {
    kind: 'text',
    hunks: change.hunks,
    before: change.status !== 'added',
    after: change.status !== 'deleted',
  };
}

/** Serve one recorded comparison as the Host's {@link WorkspaceFileDiff}. */
function comparisonDiff(record: RecordedChanges, index: number, signal: AbortSignal): WorkspaceFileDiff | undefined {
  const file = record.summary.files[index];
  const comparison = record.comparisons[index];
  if (file === undefined || comparison === undefined) return undefined;
  if (signal.aborted) return undefined;
  switch (comparison.kind) {
    case 'binary':
      return { kind: 'binary', path: file.path, display: file.display };
    case 'oversized':
      return { kind: 'oversized', path: file.path, display: file.display };
    case 'text':
      return {
        kind: 'text',
        path: file.path,
        display: file.display,
        before: comparison.before,
        after: comparison.after,
        hunks: [...comparison.hunks],
        coarse: false,
      };
  }
}

/** Report one queued-task failure as a single line, unless it is expected cancellation. */
function report(warn: (message: string) => void, error: unknown, signal: AbortSignal, disposed: boolean): void {
  if (signal.aborted || disposed) return;
  const detail = error instanceof Error ? error.message || error.name : String(error);
  const line = detail.replace(/\s+/g, ' ').trim();
  warn(`${WARN_PREFIX}${line === '' ? 'unknown error' : line}`);
}
