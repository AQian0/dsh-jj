/**
 * Read-only Jujutsu panel: the Host half.
 *
 * The Web panel needs a snapshot of this workspace (working copy + changed files,
 * mutable stack + recent history graph, sibling workspaces with multi-session
 * awareness, bookmarks with remote sync status, recent operations, and lazy
 * per-revision/per-file diff inspection) and nothing else: it must never change the
 * repository, never snapshot a working copy, never mutate metadata/heartbeat files,
 * and never break the Host when jj is missing or the directory is not a jj workspace.
 *
 * Reads use `--ignore-working-copy` everywhere, are cached for a few seconds and
 * share one in-flight request per key so opening or switching tabs does not spawn
 * duplicate `jj` processes.
 *
 * @module dsh-jj/panel-host
 */

import { resolve, sep } from 'node:path';
import { parseGitFormatDiff } from './changes-diff.ts';
import {
  isRewritableChange,
  type JjPanelChangeRecord,
  type JjPanelDiffFile,
  type JjPanelDiffStatus,
} from './jj-templates.ts';
import { canonicalWorkspacePath } from './policies.ts';
import type { JjBookmarkEntry, JjOperations } from './service.ts';
import { readSessionHeartbeats } from './session-heartbeat.ts';
import type { JjOperation, JjWorkspaceState, VcsDescriptor } from './types.ts';
import { readWorkspaceRecords } from './workspace-registry.ts';

/** Route paths the browser half calls (document-relative form is derived in the client). */
export const JJ_OVERVIEW_PATH = '/api/jj.overview';
export const JJ_REFRESH_PATH = '/api/jj.refresh';
export const JJ_REVISION_PATH = '/api/jj.revision';

/** Default cache lifetime for overview and revision snapshots. */
export const JJ_OVERVIEW_TTL_MS = 5_000;

/** How many stack rows the panel shows at most. */
export const JJ_OVERVIEW_STACK_LIMIT = 20;

/** How many graph/history rows (mutable stack + recent ancestors + bookmarks) the overview fetches. */
export const JJ_OVERVIEW_HISTORY_LIMIT = 30;

/** How many recent operations the panel shows. */
export const JJ_OVERVIEW_OPERATION_LIMIT = 25;

/** Maximum diff lines returned for one file in the panel inspector. */
export const JJ_REVISION_DIFF_MAX_LINES = 400;

/** Revset fetching `@`, the mutable stack, recent ancestors, and local bookmark targets in one call. */
const PANEL_HISTORY_REVSET = 'present(@) | (::@ ~ ::immutable_heads()) | ancestors(@, 15) | bookmarks()';

/** Strict revision selector accepted by `GET /api/jj.revision` (`@`, change id or commit id). */
const SAFE_PANEL_REV_RE = /^(@|[0-9a-z]{4,64})$/i;

/** The subset of `JjService` the panel reads (a live service satisfies it). */
export interface JjPanelServiceLike {
  detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
  readonly operations: Pick<JjOperations, 'readAt' | 'log' | 'workspaceStates' | 'bookmarkList' | 'opLog'> &
    Partial<Pick<JjOperations, 'readPanelLog' | 'readPanelRevision' | 'readPanelDiffFiles' | 'diff'>>;
}

/** One in-process top-level session observation supplied by the Host runtime. */
export interface JjPanelLiveSession {
  readonly sessionId?: string;
  readonly cwd: string;
  readonly active?: boolean;
}

/** Remote tracking status for one local bookmark against a remote of the same name. */
export type JjPanelBookmarkSync = 'synced' | 'ahead' | 'behind' | 'diverged' | 'unsynced';

/** One remote bookmark tracked against a local bookmark. */
export interface JjPanelBookmarkRemote {
  readonly remote: string;
  readonly target?: string;
  readonly conflicted: boolean;
  readonly sync: JjPanelBookmarkSync;
}

/** One local bookmark as the panel shows it. */
export interface JjPanelBookmark {
  readonly name: string;
  readonly target?: string;
  readonly conflicted: boolean;
  readonly targetChangeId?: string;
  readonly targetShortestChangeId?: string;
  readonly targetDescription?: string;
  readonly remotes?: readonly JjPanelBookmarkRemote[];
}

/** One remote bookmark that has no matching local bookmark (colocated `@git` excluded). */
export interface JjPanelRemoteBookmark {
  readonly name: string;
  readonly remote: string;
  readonly target?: string;
  readonly conflicted: boolean;
}

/** One change row as the panel shows it (stack and history graph). */
export interface JjPanelChange {
  readonly changeId: string;
  readonly shortestChangeId?: string;
  readonly commitId: string;
  readonly parents?: readonly string[];
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly currentWorkingCopy: boolean;
  readonly immutable?: boolean;
  readonly rewritable?: boolean;
  readonly bookmarks?: readonly string[];
  readonly remoteBookmarks?: readonly string[];
  readonly author?: string;
  readonly timestamp?: string;
  /** True when this change sits in the mutable stack above `immutable_heads()`. */
  readonly inStack?: boolean;
}

/** Session ownership/activity status attached to one workspace row (read-only). */
export type JjPanelWorkspaceSessionState = 'active' | 'idle' | 'orphaned' | 'none';

/** One workspace row as the panel shows it. */
export interface JjPanelWorkspace extends JjWorkspaceState {
  readonly managed?: boolean;
  readonly baseChangeId?: string;
  readonly sessionState?: JjPanelWorkspaceSessionState;
}

/** One operation as the panel shows it. */
export interface JjPanelOperation {
  readonly id: string;
  readonly shortId: string;
  readonly description: string;
  readonly time: string;
  readonly user?: string;
  readonly workspaceName: string | null;
  readonly isSnapshot: boolean;
  readonly tags?: readonly string[];
}

/** The panel's whole overview payload; partial failures degrade gracefully. */
export interface JjOverview {
  /** False when the panel is disabled by config or the Host has no connection service. */
  readonly enabled: boolean;
  readonly workspace?: {
    readonly kind: 'jj-colocated' | 'jj-native';
    readonly root: string;
    readonly name: string;
    readonly jjVersion?: string;
  };
  readonly workingCopy?: {
    readonly changeId: string;
    readonly shortestChangeId?: string;
    readonly commitId: string;
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly immutable?: boolean;
    readonly rewritable?: boolean;
    readonly stale: 'yes' | 'no' | 'unknown';
    readonly parentCommitIds?: readonly string[];
    readonly files?: readonly JjPanelDiffFile[];
    readonly totalAdded?: number;
    readonly totalRemoved?: number;
    readonly conflictFiles?: readonly string[];
  };
  /** The stack above the integration base (`::@ ~ ::immutable_heads()`), newest first. */
  readonly stack: readonly JjPanelChange[];
  /** Mutable stack plus recent immutable ancestors and local bookmark targets, newest first. */
  readonly history?: readonly JjPanelChange[];
  readonly workspaces: readonly JjPanelWorkspace[];
  /** Count of other active top-level sessions sharing this jj repository. */
  readonly parallelActiveSessions?: number;
  readonly bookmarks: readonly JjPanelBookmark[];
  /** Remote bookmarks without a local counterpart (colocated `@git` mirrors excluded). */
  readonly remoteOnlyBookmarks?: readonly JjPanelRemoteBookmark[];
  readonly operations: readonly JjPanelOperation[];
  /** Set when the requested directory is not a usable jj workspace. */
  readonly reason?: string;
}

/** One unified diff hunk for the panel's read-only diff viewer. */
export interface JjPanelDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/** Full detail of one inspected revision (`GET /api/jj.revision` without `file`). */
export interface JjPanelRevisionDetail {
  readonly enabled: boolean;
  readonly revision?: {
    readonly changeId: string;
    readonly shortestChangeId: string;
    readonly commitId: string;
    readonly parents: readonly string[];
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly currentWorkingCopy: boolean;
    readonly immutable: boolean;
    readonly rewritable: boolean;
    readonly bookmarks: readonly string[];
    readonly remoteBookmarks: readonly string[];
    readonly author: string;
    readonly authorEmail: string;
    readonly timestamp: string;
    readonly files: readonly JjPanelDiffFile[];
    readonly totalAdded: number;
    readonly totalRemoved: number;
  };
  readonly reason?: string;
}

/** Unified diff payload for one file of a revision (`GET /api/jj.revision` with `file`). */
export interface JjPanelFileDiff {
  readonly enabled: boolean;
  readonly rev?: string;
  readonly path?: string;
  readonly oldPath?: string;
  readonly status?: JjPanelDiffStatus;
  readonly added?: number;
  readonly removed?: number;
  readonly binary?: boolean;
  readonly truncated?: boolean;
  readonly hunks?: readonly JjPanelDiffHunk[];
  readonly reason?: string;
}

/** Structural view of the DSH connection route registry. */
export interface JjPanelRouteHost {
  readonly fetch: {
    register(entry: {
      readonly path: string;
      readonly methods: readonly string[];
      readonly requestBody: 'buffered';
      readonly fetch: (request: Request) => Promise<Response>;
    }): unknown;
  };
}

/** Options of {@link registerJjPanelRoutes}. */
export interface JjPanelRouteOptions {
  readonly service: JjPanelServiceLike;
  /** `uiPanel` config: `off` keeps the routes answering `enabled: false`. */
  readonly enabled: boolean;
  /**
   * Optional directory allow-list check supplied by the Host runtime.
   *
   * When present and returning `false`, the routes reject the request with HTTP 403
   * before spawning `jj` so arbitrary directories outside active sessions are not probed.
   */
  readonly isAllowedCwd?: (cwd: string) => boolean;
  /** Optional read-only in-process live session enumerator for workspace badges. */
  readonly liveSessions?: (cwd: string) => readonly JjPanelLiveSession[];
  /** Injectable clock/cache lifetime for tests. */
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/** One cached entry with a write timestamp. */
interface CachedEntry<T> {
  readonly at: number;
  readonly value: T;
}

/** Map an operation record to the panel's flat shape. */
function toPanelOperation(operation: JjOperation): JjPanelOperation {
  return {
    id: operation.id,
    shortId: operation.shortId,
    description: operation.description,
    time: operation.time,
    ...(operation.user.length > 0 ? { user: operation.user } : {}),
    workspaceName: operation.workspaceName ?? null,
    isSnapshot: operation.isSnapshot,
    ...(operation.tags.length > 0 ? { tags: operation.tags } : {}),
  };
}

/** Convert an enriched panel change record into a {@link JjPanelChange}. */
function toPanelChange(change: JjPanelChangeRecord, inStack: boolean): JjPanelChange {
  return {
    changeId: change.changeId,
    shortestChangeId: change.shortestChangeId,
    commitId: change.commitId,
    parents: change.parents,
    description: change.description,
    empty: change.empty,
    conflict: change.conflict,
    currentWorkingCopy: change.currentWorkingCopy,
    immutable: change.immutable,
    rewritable: change.rewritable,
    bookmarks: change.bookmarks,
    remoteBookmarks: change.remoteBookmarks,
    author: change.author,
    timestamp: change.timestamp,
    inStack,
  };
}

/** Sum per-file added/removed line counts. */
function sumDiffLines(files: readonly JjPanelDiffFile[]): { totalAdded: number; totalRemoved: number } {
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const file of files) {
    totalAdded += file.added;
    totalRemoved += file.removed;
  }
  return { totalAdded, totalRemoved };
}

/**
 * Walk parent links from the current working copy without crossing an immutable commit.
 *
 * By definition of `immutable_heads()`, every ancestor of an immutable commit is also
 * immutable, so the reachable mutable set equals `::@ ~ ::immutable_heads()` within the
 * fetched graph window.
 */
function computeStackCommitIds(changes: readonly JjPanelChangeRecord[]): Set<string> {
  const byCommit = new Map<string, JjPanelChangeRecord>();
  let workingCopy: JjPanelChangeRecord | undefined;
  for (const change of changes) {
    byCommit.set(change.commitId, change);
    if (change.currentWorkingCopy) workingCopy = change;
  }
  const stackIds = new Set<string>();
  if (workingCopy === undefined) return stackIds;
  const queue: JjPanelChangeRecord[] = [workingCopy];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.immutable || stackIds.has(current.commitId)) continue;
    stackIds.add(current.commitId);
    for (const parentId of current.parents) {
      const parent = byCommit.get(parentId);
      if (parent !== undefined && !parent.immutable && !stackIds.has(parent.commitId)) {
        queue.push(parent);
      }
    }
  }
  return stackIds;
}

/** Check whether `ancestorId` is reachable by walking `parents` from `descendantId` inside the fetched graph. */
function isCommitAncestor(
  ancestorId: string,
  descendantId: string,
  parentsByCommit: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (ancestorId.length === 0 || descendantId.length === 0) return false;
  if (ancestorId === descendantId) return true;
  const visited = new Set<string>([descendantId]);
  const queue: string[] = [descendantId];
  while (queue.length > 0 && visited.size <= 128) {
    const current = queue.shift()!;
    const parents = parentsByCommit.get(current);
    if (parents === undefined) continue;
    for (const parent of parents) {
      if (parent === ancestorId) return true;
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Read history + stack without snapshotting; falls back to legacy `log()` when `readPanelLog` is absent. */
async function readHistoryAndStack(
  service: JjPanelServiceLike,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly stack: readonly JjPanelChange[]; readonly history: readonly JjPanelChange[] }> {
  if (typeof service.operations.readPanelLog === 'function') {
    try {
      const records = await service.operations.readPanelLog(
        cwd,
        PANEL_HISTORY_REVSET,
        JJ_OVERVIEW_HISTORY_LIMIT,
        signal,
      );
      const stackIds = computeStackCommitIds(records);
      const history = records.map((record) => toPanelChange(record, stackIds.has(record.commitId)));
      const stack = history.filter((entry) => entry.inStack === true).slice(0, JJ_OVERVIEW_STACK_LIMIT);
      return { stack, history };
    } catch {
      // Fall through to legacy lightweight stack query if the panel template fails on an older jj.
    }
  }
  try {
    const changes = await service.operations.log(cwd, '::@ ~ ::immutable_heads()', JJ_OVERVIEW_STACK_LIMIT, signal, {
      ignoreWorkingCopy: true,
    });
    const stack: JjPanelChange[] = changes.map((change) => ({
      changeId: change.changeId,
      shortestChangeId: change.changeId.slice(0, 4),
      commitId: change.commitId,
      description: change.description,
      empty: change.empty,
      conflict: change.conflict,
      currentWorkingCopy: change.currentWorkingCopy,
      immutable: change.immutable,
      rewritable: isRewritableChange(change),
      bookmarks: change.bookmarks,
      remoteBookmarks: change.remoteBookmarks,
      author: change.author,
      inStack: true,
    }));
    return { stack, history: stack };
  } catch {
    return { stack: [], history: [] };
  }
}

/** Read local + remote bookmarks and enrich with target commit summaries and remote sync state. */
async function readEnrichedBookmarks(
  service: JjPanelServiceLike,
  cwd: string,
  signal: AbortSignal | undefined,
  history: readonly JjPanelChange[],
): Promise<{
  readonly bookmarks: readonly JjPanelBookmark[];
  readonly remoteOnlyBookmarks: readonly JjPanelRemoteBookmark[];
}> {
  let entries: readonly JjBookmarkEntry[];
  try {
    entries = await service.operations.bookmarkList(cwd, true, signal);
  } catch {
    try {
      entries = await service.operations.bookmarkList(cwd, false, signal);
    } catch {
      return { bookmarks: [], remoteOnlyBookmarks: [] };
    }
  }

  const byCommit = new Map<string, JjPanelChange>();
  const parentsByCommit = new Map<string, readonly string[]>();
  for (const change of history) {
    byCommit.set(change.commitId, change);
    if (change.parents !== undefined) parentsByCommit.set(change.commitId, change.parents);
  }

  const locals: JjBookmarkEntry[] = [];
  const remotesByName = new Map<string, JjBookmarkEntry[]>();
  for (const entry of entries) {
    if (entry.remote === 'git') continue;
    if (entry.remote === null || entry.remote === undefined) {
      locals.push(entry);
    } else {
      const list = remotesByName.get(entry.name) ?? [];
      list.push(entry);
      remotesByName.set(entry.name, list);
    }
  }

  const localNames = new Set(locals.map((entry) => entry.name));
  const bookmarks: JjPanelBookmark[] = locals.map((local) => {
    const target = local.target.length > 0 ? local.target : undefined;
    const targetChange = target !== undefined ? byCommit.get(target) : undefined;
    const matchedRemotes = remotesByName.get(local.name) ?? [];
    const remotes: JjPanelBookmarkRemote[] = matchedRemotes.map((remoteEntry) => {
      const remoteTarget = remoteEntry.target.length > 0 ? remoteEntry.target : undefined;
      let sync: JjPanelBookmarkSync = 'unsynced';
      if (!local.conflicted && !remoteEntry.conflicted && target !== undefined && remoteTarget !== undefined) {
        if (target === remoteTarget) {
          sync = 'synced';
        } else if (isCommitAncestor(remoteTarget, target, parentsByCommit)) {
          sync = 'ahead';
        } else if (isCommitAncestor(target, remoteTarget, parentsByCommit)) {
          sync = 'behind';
        } else if (parentsByCommit.has(target) && parentsByCommit.has(remoteTarget)) {
          sync = 'diverged';
        }
      }
      return {
        remote: remoteEntry.remote!,
        ...(remoteTarget !== undefined ? { target: remoteTarget } : {}),
        conflicted: remoteEntry.conflicted === true,
        sync,
      };
    });
    return {
      name: local.name,
      ...(target !== undefined ? { target } : {}),
      conflicted: local.conflicted === true,
      ...(targetChange !== undefined
        ? {
            targetChangeId: targetChange.changeId,
            ...(targetChange.shortestChangeId !== undefined
              ? { targetShortestChangeId: targetChange.shortestChangeId }
              : {}),
            targetDescription: targetChange.description,
          }
        : {}),
      ...(remotes.length > 0 ? { remotes } : {}),
    };
  });

  const remoteOnlyBookmarks: JjPanelRemoteBookmark[] = [];
  for (const [name, list] of remotesByName) {
    if (localNames.has(name)) continue;
    for (const entry of list) {
      remoteOnlyBookmarks.push({
        name: entry.name,
        remote: entry.remote!,
        ...(entry.target.length > 0 ? { target: entry.target } : {}),
        conflicted: entry.conflicted === true,
      });
    }
  }

  return { bookmarks, remoteOnlyBookmarks };
}

/** Read the recent operations, tolerating an unreadable operation log. */
async function readOperations(
  service: JjPanelServiceLike,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<JjPanelOperation[]> {
  try {
    const operations = await service.operations.opLog(cwd, JJ_OVERVIEW_OPERATION_LIMIT, signal);
    return operations.map(toPanelOperation);
  } catch {
    return [];
  }
}

/** Check whether `candidate` equals `root` or lies inside it (canonicalized). */
function isPathInsideRoot(candidate: string, root: string): boolean {
  const prefix = root === sep ? sep : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

/** Enrich workspace rows with read-only ownership/heartbeat metadata (never writes or purges disk). */
function enrichWorkspaces(
  workspaces: readonly JjWorkspaceState[],
  jjRepoPath: string | undefined,
  cwd: string,
  liveSessions: ((cwd: string) => readonly JjPanelLiveSession[]) | undefined,
  now: number,
): { readonly workspaces: readonly JjPanelWorkspace[]; readonly parallelActiveSessions: number } {
  const inProcess: readonly JjPanelLiveSession[] = (() => {
    try {
      return liveSessions?.(cwd) ?? [];
    } catch {
      return [];
    }
  })();
  const inProcessIds = new Set<string>();
  const observations: { readonly sessionId?: string; readonly canonicalCwd: string; readonly active?: boolean }[] = [];
  for (const session of inProcess) {
    if (session.sessionId !== undefined && session.sessionId.length > 0) inProcessIds.add(session.sessionId);
    observations.push({
      ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
      canonicalCwd: canonicalWorkspacePath(resolve(session.cwd)),
      ...(session.active !== undefined ? { active: session.active } : {}),
    });
  }

  const recordsByName = new Map<string, { readonly sessionId: string; readonly baseChangeId?: string }>();
  if (jjRepoPath !== undefined && jjRepoPath.length > 0) {
    for (const record of readWorkspaceRecords(jjRepoPath)) {
      recordsByName.set(record.name, {
        sessionId: record.sessionId,
        ...(record.baseChangeId !== undefined ? { baseChangeId: record.baseChangeId } : {}),
      });
    }
    for (const heartbeat of readSessionHeartbeats(jjRepoPath, {
      now,
      excludeSessionIds: inProcessIds,
      purgeExpired: false,
    })) {
      observations.push({
        sessionId: heartbeat.sessionId,
        canonicalCwd: canonicalWorkspacePath(resolve(heartbeat.cwd)),
        ...(heartbeat.active !== undefined ? { active: heartbeat.active } : {}),
      });
    }
  }

  const liveSessionIds = new Set<string>();
  for (const obs of observations) {
    if (obs.sessionId !== undefined) liveSessionIds.add(obs.sessionId);
  }

  const canonicalRoots = workspaces.map((workspace) => canonicalWorkspacePath(resolve(workspace.root)));
  let totalActiveInRepo = 0;
  let currentWorkspaceHasActive = false;

  const enriched: JjPanelWorkspace[] = workspaces.map((workspace, index) => {
    const canonicalRoot = canonicalRoots[index]!;
    const matching = observations.filter((obs) => isPathInsideRoot(obs.canonicalCwd, canonicalRoot));
    const activeCount = matching.filter((obs) => obs.active === true).length;
    totalActiveInRepo += activeCount;
    if (workspace.current && activeCount > 0) currentWorkspaceHasActive = true;

    const record = recordsByName.get(workspace.name);
    let sessionState: JjPanelWorkspaceSessionState = 'none';
    if (activeCount > 0) {
      sessionState = 'active';
    } else if (matching.length > 0) {
      sessionState = 'idle';
    } else if (record !== undefined && !liveSessionIds.has(record.sessionId)) {
      sessionState = 'orphaned';
    }

    return {
      ...workspace,
      ...(record !== undefined
        ? { managed: true, ...(record.baseChangeId !== undefined ? { baseChangeId: record.baseChangeId } : {}) }
        : {}),
      ...(sessionState !== 'none' ? { sessionState } : {}),
    };
  });

  const parallelActiveSessions = Math.max(0, totalActiveInRepo - (currentWorkspaceHasActive ? 1 : 0));
  return { workspaces: enriched, parallelActiveSessions };
}

/**
 * Build one overview snapshot for a directory.
 *
 * The panel is strictly read-only: no rebase, no snapshot, no cleanup, and no heartbeat
 * purging. A directory outside a jj workspace returns `enabled` with a `reason` and no
 * workspace data, which the client renders as a short explanation instead of an error.
 *
 * @param service - the `ctx.jj` service.
 * @param cwd - directory the panel is looking at (the session working directory).
 * @param options - enabled flag, optional live-session observer, clock and cancellation signal.
 * @returns the overview; never throws for a non-jj directory.
 */
export async function buildJjOverview(
  service: JjPanelServiceLike,
  cwd: string,
  options: {
    readonly enabled: boolean;
    readonly signal?: AbortSignal;
    readonly liveSessions?: (cwd: string) => readonly JjPanelLiveSession[];
    readonly now?: () => number;
  },
): Promise<JjOverview> {
  const descriptor = await service.detect(cwd, options.signal);
  const kind = descriptor.kind;
  const empty: JjOverview = {
    enabled: options.enabled,
    stack: [],
    history: [],
    workspaces: [],
    bookmarks: [],
    remoteOnlyBookmarks: [],
    operations: [],
  };
  if (kind !== 'jj-colocated' && kind !== 'jj-native') {
    return {
      ...empty,
      ...(descriptor.notices.length > 0
        ? { reason: descriptor.notices.map((notice) => notice.detail).join('; ') }
        : {}),
    };
  }
  const workspace = {
    kind,
    root: descriptor.root,
    name: descriptor.workspaceName ?? 'default',
    ...(descriptor.jjVersion !== undefined ? { jjVersion: descriptor.jjVersion } : {}),
  } as const;

  const [change, graph, rawWorkspaces, operations] = await Promise.all([
    service.operations.readAt(cwd, options.signal, '@', { ignoreWorkingCopy: true }).catch(() => undefined),
    readHistoryAndStack(service, cwd, options.signal),
    service.operations
      .workspaceStates(cwd, options.signal, { ignoreWorkingCopy: true })
      .catch(() => [] as JjWorkspaceState[]),
    readOperations(service, cwd, options.signal),
  ]);

  const [{ bookmarks, remoteOnlyBookmarks }, workingCopyFiles] = await Promise.all([
    readEnrichedBookmarks(service, cwd, options.signal, graph.history),
    change !== undefined && !change.empty && typeof service.operations.readPanelDiffFiles === 'function'
      ? service.operations.readPanelDiffFiles(cwd, '@', change.conflict, options.signal).catch(() => [])
      : Promise.resolve([] as readonly JjPanelDiffFile[]),
  ]);

  const { workspaces, parallelActiveSessions } = enrichWorkspaces(
    rawWorkspaces,
    descriptor.jjRepoPath,
    cwd,
    options.liveSessions,
    (options.now ?? Date.now)(),
  );
  const current = workspaces.find((state) => state.current);
  const graphWorkingCopy = graph.history.find((entry) => entry.currentWorkingCopy);
  const { totalAdded, totalRemoved } = sumDiffLines(workingCopyFiles);
  const conflictFiles = workingCopyFiles.filter((file) => file.conflict).map((file) => file.path);

  return {
    enabled: options.enabled,
    workspace,
    ...(change !== undefined
      ? {
          workingCopy: {
            changeId: change.changeId,
            ...(graphWorkingCopy?.shortestChangeId !== undefined
              ? { shortestChangeId: graphWorkingCopy.shortestChangeId }
              : {}),
            commitId: change.commitId,
            description: change.description,
            empty: change.empty,
            conflict: change.conflict,
            immutable: change.immutable,
            rewritable: isRewritableChange(change),
            stale: current?.stale ?? 'unknown',
            ...(graphWorkingCopy?.parents !== undefined ? { parentCommitIds: graphWorkingCopy.parents } : {}),
            files: workingCopyFiles,
            totalAdded,
            totalRemoved,
            ...(conflictFiles.length > 0 ? { conflictFiles } : {}),
          },
        }
      : {}),
    stack: graph.stack,
    history: graph.history,
    workspaces,
    ...(parallelActiveSessions > 0 ? { parallelActiveSessions } : {}),
    bookmarks,
    ...(remoteOnlyBookmarks.length > 0 ? { remoteOnlyBookmarks } : {}),
    operations,
  };
}

/** Bound diff hunks to at most `maxLines` lines across all hunks. */
function capDiffHunks(
  hunks: readonly JjPanelDiffHunk[],
  maxLines: number,
): { readonly hunks: readonly JjPanelDiffHunk[]; readonly truncated: boolean } {
  const capped: JjPanelDiffHunk[] = [];
  let remaining = maxLines;
  let truncated = false;
  for (const hunk of hunks) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (hunk.lines.length <= remaining) {
      capped.push(hunk);
      remaining -= hunk.lines.length;
    } else {
      capped.push({ ...hunk, lines: hunk.lines.slice(0, remaining) });
      remaining = 0;
      truncated = true;
      break;
    }
  }
  return { hunks: capped, truncated };
}

/**
 * Read one revision's full detail (full description, metadata, changed files) for the
 * read-only inspector, without snapshotting the working copy.
 *
 * @param service - the `ctx.jj` service.
 * @param cwd - directory inside the workspace.
 * @param rev - validated revision selector (`@`, change id or commit id).
 * @param options - enabled flag and cancellation signal.
 */
export async function buildJjRevisionDetail(
  service: JjPanelServiceLike,
  cwd: string,
  rev: string,
  options: { readonly enabled: boolean; readonly signal?: AbortSignal },
): Promise<JjPanelRevisionDetail> {
  try {
    let record: JjPanelChangeRecord;
    if (typeof service.operations.readPanelRevision === 'function') {
      record = await service.operations.readPanelRevision(cwd, rev, options.signal);
    } else {
      const basic = await service.operations.readAt(cwd, options.signal, rev, { ignoreWorkingCopy: true });
      record = {
        ...basic,
        shortestChangeId: basic.changeId.slice(0, 4),
        parents: [],
        authorEmail: basic.author,
        timestamp: '',
        rewritable: isRewritableChange(basic),
      };
    }
    const files =
      !record.empty && typeof service.operations.readPanelDiffFiles === 'function'
        ? await service.operations.readPanelDiffFiles(cwd, rev, record.conflict, options.signal).catch(() => [])
        : [];
    const { totalAdded, totalRemoved } = sumDiffLines(files);
    return {
      enabled: options.enabled,
      revision: {
        changeId: record.changeId,
        shortestChangeId: record.shortestChangeId,
        commitId: record.commitId,
        parents: record.parents,
        description: record.description,
        empty: record.empty,
        conflict: record.conflict,
        currentWorkingCopy: record.currentWorkingCopy,
        immutable: record.immutable,
        rewritable: record.rewritable,
        bookmarks: record.bookmarks,
        remoteBookmarks: record.remoteBookmarks,
        author: record.author,
        authorEmail: record.authorEmail,
        timestamp: record.timestamp,
        files,
        totalAdded,
        totalRemoved,
      },
    };
  } catch (error) {
    return {
      enabled: options.enabled,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read one file's bounded unified diff for a revision, strictly with `--ignore-working-copy`.
 *
 * Reuses `parseGitFormatDiff` from `changes-diff` so hunk parsing and binary detection
 * stay consistent with the workspace-changes recorder.
 */
export async function buildJjFileDiff(
  service: JjPanelServiceLike,
  cwd: string,
  rev: string,
  file: string,
  options: { readonly enabled: boolean; readonly signal?: AbortSignal },
): Promise<JjPanelFileDiff> {
  if (typeof service.operations.diff !== 'function') {
    return { enabled: options.enabled, rev, path: file, reason: 'diff operation is unavailable' };
  }
  try {
    const result = await service.operations.diff(cwd, rev, 'patch', [file], options.signal, {
      ignoreWorkingCopy: true,
    });
    const parsed = parseGitFormatDiff(result.text, [file])[0];
    if (parsed === undefined) {
      return {
        enabled: options.enabled,
        rev,
        path: file,
        status: 'modified',
        added: 0,
        removed: 0,
        binary: false,
        truncated: result.truncated,
        hunks: [],
      };
    }
    const capped = capDiffHunks(parsed.hunks, JJ_REVISION_DIFF_MAX_LINES);
    return {
      enabled: options.enabled,
      rev,
      path: parsed.path,
      ...(parsed.oldPath !== undefined ? { oldPath: parsed.oldPath } : {}),
      status: parsed.status,
      added: parsed.added,
      removed: parsed.deleted,
      binary: parsed.binary,
      truncated: result.truncated || capped.truncated,
      hunks: capped.hunks,
    };
  } catch (error) {
    return {
      enabled: options.enabled,
      rev,
      path: file,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read the requested directory from a query string. */
function cwdFromRequest(request: Request): string | undefined {
  const url = new URL(request.url);
  const cwd = url.searchParams.get('cwd');
  return cwd !== null && cwd.trim().length > 0 ? cwd.trim() : undefined;
}

/** Validate a revision query parameter (`@`, change id or commit id). */
function validRevFromRequest(request: Request): string | undefined {
  const url = new URL(request.url);
  const raw = url.searchParams.get('rev')?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  return SAFE_PANEL_REV_RE.test(raw) ? raw : undefined;
}

/** Validate an optional file path query parameter for single-file diff inspection. */
function fileFromRequest(request: Request): { readonly present: boolean; readonly value?: string } {
  const url = new URL(request.url);
  if (!url.searchParams.has('file')) return { present: false };
  const raw = url.searchParams.get('file') ?? '';
  if (raw.length === 0 || raw.includes('\0') || raw.startsWith('-')) return { present: true, value: undefined };
  return { present: true, value: raw };
}

/**
 * Register the panel's authenticated routes (`/api/jj.overview`, `/api/jj.refresh`, `/api/jj.revision`).
 *
 * @param host - the DSH connection service (`ctx.connection`).
 * @param options - the jj service, the `uiPanel` flag, scope guard, live-session reader, and (tests) clock/TTL.
 * @returns a disposer that clears the in-memory caches.
 */
export function registerJjPanelRoutes(host: JjPanelRouteHost, options: JjPanelRouteOptions): () => void {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? JJ_OVERVIEW_TTL_MS;
  const overviewCache = new Map<string, CachedEntry<JjOverview>>();
  const overviewInflight = new Map<string, Promise<JjOverview>>();
  const revisionCache = new Map<string, CachedEntry<JjPanelRevisionDetail | JjPanelFileDiff>>();
  const revisionInflight = new Map<string, Promise<JjPanelRevisionDetail | JjPanelFileDiff>>();

  /** Delete all cached revision/diff entries belonging to one directory. */
  const clearRevisionCacheFor = (cwd: string): void => {
    const prefix = `${cwd}\u0000`;
    for (const key of revisionCache.keys()) {
      if (key.startsWith(prefix)) revisionCache.delete(key);
    }
  };

  /** One cached/serialized overview read. */
  const overviewFor = async (cwd: string): Promise<JjOverview> => {
    const cached = overviewCache.get(cwd);
    if (cached !== undefined && now() - cached.at <= ttl) return cached.value;
    const pending = overviewInflight.get(cwd);
    if (pending !== undefined) return await pending;
    const request = (async (): Promise<JjOverview> => {
      try {
        const overview = await buildJjOverview(options.service, cwd, {
          enabled: options.enabled,
          liveSessions: options.liveSessions,
          now,
        });
        overviewCache.set(cwd, { at: now(), value: overview });
        return overview;
      } catch (error) {
        // A failed read must never break the Host: answer a reasoned snapshot and let
        // the client show that the repository state is unavailable.
        return {
          enabled: options.enabled,
          stack: [],
          history: [],
          workspaces: [],
          bookmarks: [],
          remoteOnlyBookmarks: [],
          operations: [],
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    overviewInflight.set(cwd, request);
    try {
      return await request;
    } finally {
      if (overviewInflight.get(cwd) === request) overviewInflight.delete(cwd);
    }
  };

  /** One cached/serialized revision or file-diff read. */
  const revisionFor = async (
    cwd: string,
    rev: string,
    file: string | undefined,
  ): Promise<JjPanelRevisionDetail | JjPanelFileDiff> => {
    const key = `${cwd}\u0000${rev}\u0000${file ?? ''}`;
    const cached = revisionCache.get(key);
    if (cached !== undefined && now() - cached.at <= ttl) return cached.value;
    const pending = revisionInflight.get(key);
    if (pending !== undefined) return await pending;
    const request = (async (): Promise<JjPanelRevisionDetail | JjPanelFileDiff> => {
      const payload =
        file === undefined
          ? await buildJjRevisionDetail(options.service, cwd, rev, { enabled: options.enabled })
          : await buildJjFileDiff(options.service, cwd, rev, file, { enabled: options.enabled });
      if (payload.reason === undefined) revisionCache.set(key, { at: now(), value: payload });
      return payload;
    })();
    revisionInflight.set(key, request);
    try {
      return await request;
    } finally {
      if (revisionInflight.get(key) === request) revisionInflight.delete(key);
    }
  };

  host.fetch.register({
    path: JJ_OVERVIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      if (!options.enabled) {
        return Response.json({
          enabled: false,
          stack: [],
          history: [],
          workspaces: [],
          bookmarks: [],
          remoteOnlyBookmarks: [],
          operations: [],
        });
      }
      const cwd = cwdFromRequest(request);
      if (cwd === undefined) {
        return Response.json({ error: 'missing cwd query parameter' }, { status: 400 });
      }
      if (options.isAllowedCwd !== undefined && !options.isAllowedCwd(cwd)) {
        return Response.json({ error: 'cwd is outside active session workspaces' }, { status: 403 });
      }
      return Response.json(await overviewFor(cwd), { headers: { 'cache-control': 'no-store' } });
    },
  });

  host.fetch.register({
    path: JJ_REFRESH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      if (!options.enabled) {
        return Response.json({
          enabled: false,
          stack: [],
          history: [],
          workspaces: [],
          bookmarks: [],
          remoteOnlyBookmarks: [],
          operations: [],
        });
      }
      const body = (await request.json().catch(() => undefined)) as { cwd?: unknown } | undefined;
      const cwd = typeof body?.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd.trim() : undefined;
      if (cwd === undefined) {
        return Response.json({ error: 'missing cwd' }, { status: 400 });
      }
      if (options.isAllowedCwd !== undefined && !options.isAllowedCwd(cwd)) {
        return Response.json({ error: 'cwd is outside active session workspaces' }, { status: 403 });
      }
      overviewCache.delete(cwd);
      clearRevisionCacheFor(cwd);
      return Response.json(await overviewFor(cwd), { headers: { 'cache-control': 'no-store' } });
    },
  });

  host.fetch.register({
    path: JJ_REVISION_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      if (!options.enabled) {
        return Response.json({ enabled: false });
      }
      const cwd = cwdFromRequest(request);
      if (cwd === undefined) {
        return Response.json({ error: 'missing cwd query parameter' }, { status: 400 });
      }
      if (options.isAllowedCwd !== undefined && !options.isAllowedCwd(cwd)) {
        return Response.json({ error: 'cwd is outside active session workspaces' }, { status: 403 });
      }
      const rev = validRevFromRequest(request);
      if (rev === undefined) {
        return Response.json({ error: 'missing or invalid rev query parameter' }, { status: 400 });
      }
      const file = fileFromRequest(request);
      if (file.present && file.value === undefined) {
        return Response.json({ error: 'invalid file query parameter' }, { status: 400 });
      }
      return Response.json(await revisionFor(cwd, rev, file.value), { headers: { 'cache-control': 'no-store' } });
    },
  });

  return () => {
    overviewCache.clear();
    overviewInflight.clear();
    revisionCache.clear();
    revisionInflight.clear();
  };
}
