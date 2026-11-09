/**
 * Read-only Jujutsu panel: the Host half.
 *
 * The Web panel needs a snapshot of this workspace (working copy, stack, sibling
 * workspaces, bookmarks, recent operations) and nothing else: it must never change the
 * repository, never snapshot a working copy, and never break the Host when jj is missing
 * or the directory is not a jj workspace. The browser half is a separate client bundle
 * served by DSH's client-module loader; this module only answers two authenticated routes
 * registered through `ctx.connection.fetch`.
 *
 * Reads use `--ignore-working-copy` wherever the operation supports it, are cached for a
 * few seconds and share one in-flight request per directory, so opening the panel twice
 * does not spawn two `jj log` processes.
 *
 * @module dsh-jj/panel-host
 */

import type { JjBookmarkEntry, JjOperations } from './service.ts';
import type { JjOperation, JjWorkspaceState, VcsDescriptor } from './types.ts';

/** Route paths the browser half calls (document-relative form is derived in the client). */
export const JJ_OVERVIEW_PATH = '/api/jj.overview';
export const JJ_REFRESH_PATH = '/api/jj.refresh';

/** Default cache lifetime for one overview snapshot. */
export const JJ_OVERVIEW_TTL_MS = 5_000;

/** How many recent operations the panel shows. */
export const JJ_OVERVIEW_OPERATION_LIMIT = 10;

/** The subset of `JjService` the panel reads (a live service satisfies it). */
export interface JjPanelServiceLike {
  detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
  readonly operations: Pick<JjOperations, 'readAt' | 'workspaceStates' | 'bookmarkList' | 'opLog'>;
}

/** One bookmark as the panel shows it. */
export interface JjPanelBookmark {
  readonly name: string;
  readonly target?: string;
  readonly conflicted: boolean;
}

/** One operation as the panel shows it. */
export interface JjPanelOperation {
  readonly id: string;
  readonly shortId: string;
  readonly description: string;
  readonly time: string;
  readonly workspaceName: string | null;
  readonly isSnapshot: boolean;
}

/** The panel's whole payload; every field is optional so a partial failure still renders. */
export interface JjOverview {
  /** False when the panel is disabled by config or the Host has no connection service. */
  readonly enabled: boolean;
  readonly workspace?: {
    readonly kind: 'jj-colocated' | 'jj-native';
    readonly root: string;
    readonly name: string;
  };
  readonly workingCopy?: {
    readonly changeId: string;
    readonly commitId: string;
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly stale: 'yes' | 'no' | 'unknown';
  };
  readonly workspaces: readonly JjWorkspaceState[];
  readonly bookmarks: readonly JjPanelBookmark[];
  readonly operations: readonly JjPanelOperation[];
  /** Set when the requested directory is not a usable jj workspace. */
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
  /** Injectable clock/cache lifetime for tests. */
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/** One cached snapshot per directory. */
interface CachedOverview {
  readonly at: number;
  readonly overview: JjOverview;
}

/** Map a bookmark record (jj's merge form) to the panel's flat shape. */
function toPanelBookmark(entry: JjBookmarkEntry): JjPanelBookmark {
  return {
    name: entry.name,
    ...(entry.target !== undefined ? { target: entry.target } : {}),
    conflicted: entry.conflicted === true,
  };
}

/** Map an operation record to the panel's flat shape. */
function toPanelOperation(operation: JjOperation): JjPanelOperation {
  return {
    id: operation.id,
    shortId: operation.shortId,
    description: operation.description,
    time: operation.time,
    workspaceName: operation.workspaceName ?? null,
    isSnapshot: operation.isSnapshot,
  };
}

/** Read the bookmarks, tolerating a repository without any. */
async function readBookmarks(
  service: JjPanelServiceLike,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<JjPanelBookmark[]> {
  try {
    const entries = await service.operations.bookmarkList(cwd, false, signal);
    return entries.map(toPanelBookmark);
  } catch {
    return [];
  }
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

/**
 * Build one overview snapshot for a directory.
 *
 * The panel is read-only: no rebase, no snapshot, no cleanup. A directory outside a jj
 * workspace returns `enabled` with a `reason` and no workspace data, which the client
 * renders as a short explanation instead of an error.
 *
 * @param service - the `ctx.jj` service.
 * @param cwd - directory the panel is looking at (the session working directory).
 * @param options - enabled flag and cancellation signal.
 * @returns the overview; never throws for a non-jj directory.
 */
export async function buildJjOverview(
  service: JjPanelServiceLike,
  cwd: string,
  options: { readonly enabled: boolean; readonly signal?: AbortSignal },
): Promise<JjOverview> {
  const descriptor = await service.detect(cwd, options.signal);
  const kind = descriptor.kind;
  const empty: JjOverview = {
    enabled: options.enabled,
    workspaces: [],
    bookmarks: [],
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
  } as const;
  const [change, workspaces, bookmarks, operations] = await Promise.all([
    service.operations.readAt(cwd, options.signal).catch(() => undefined),
    service.operations.workspaceStates(cwd, options.signal).catch(() => [] as JjWorkspaceState[]),
    readBookmarks(service, cwd, options.signal),
    readOperations(service, cwd, options.signal),
  ]);
  const current = workspaces.find((state) => state.current);
  return {
    enabled: options.enabled,
    workspace,
    ...(change !== undefined
      ? {
          workingCopy: {
            changeId: change.changeId,
            commitId: change.commitId,
            description: change.description,
            empty: change.empty,
            conflict: change.conflict,
            stale: current?.stale ?? 'unknown',
          },
        }
      : {}),
    workspaces,
    bookmarks,
    operations,
  };
}

/** Read the requested directory from a query string, defaulting to the process cwd. */
function cwdFromRequest(request: Request): string | undefined {
  const url = new URL(request.url);
  const cwd = url.searchParams.get('cwd');
  return cwd !== null && cwd.trim().length > 0 ? cwd.trim() : undefined;
}

/**
 * Register the panel's authenticated routes.
 *
 * @param host - the DSH connection service (`ctx.connection`).
 * @param options - the jj service, the `uiPanel` flag, and (tests) clock/TTL.
 * @returns a disposer that unregisters nothing (DSH owns route lifetime) — kept for
 *   symmetry with other registration helpers.
 */
export function registerJjPanelRoutes(host: JjPanelRouteHost, options: JjPanelRouteOptions): () => void {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? JJ_OVERVIEW_TTL_MS;
  const cache = new Map<string, CachedOverview>();
  const inflight = new Map<string, Promise<JjOverview>>();

  /** One cached/serialized overview read. */
  const overviewFor = async (cwd: string): Promise<JjOverview> => {
    const cached = cache.get(cwd);
    if (cached !== undefined && now() - cached.at <= ttl) return cached.overview;
    const pending = inflight.get(cwd);
    if (pending !== undefined) return await pending;
    const request = (async (): Promise<JjOverview> => {
      try {
        const overview = await buildJjOverview(options.service, cwd, { enabled: options.enabled });
        cache.set(cwd, { at: now(), overview });
        return overview;
      } catch (error) {
        // A failed read must never break the Host: answer a disabled snapshot and let
        // the client show that the repository state is unavailable.
        return {
          enabled: options.enabled,
          workspaces: [],
          bookmarks: [],
          operations: [],
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    inflight.set(cwd, request);
    try {
      return await request;
    } finally {
      if (inflight.get(cwd) === request) inflight.delete(cwd);
    }
  };

  host.fetch.register({
    path: JJ_OVERVIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      if (!options.enabled) {
        return Response.json({ enabled: false, workspaces: [], bookmarks: [], operations: [] });
      }
      const cwd = cwdFromRequest(request);
      if (cwd === undefined) {
        return Response.json({ error: 'missing cwd query parameter' }, { status: 400 });
      }
      return Response.json(await overviewFor(cwd), { headers: { 'cache-control': 'no-store' } });
    },
  });

  host.fetch.register({
    path: JJ_REFRESH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const body = (await request.json().catch(() => undefined)) as { cwd?: unknown } | undefined;
      const cwd = typeof body?.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd.trim() : undefined;
      if (cwd === undefined) {
        return Response.json({ error: 'missing cwd' }, { status: 400 });
      }
      cache.delete(cwd);
      return Response.json(await overviewFor(cwd), { headers: { 'cache-control': 'no-store' } });
    },
  });

  return () => {
    cache.clear();
    inflight.clear();
  };
}
