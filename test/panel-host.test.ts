/**
 * Read-only panel Host routes: payload shape, caching, refresh, and fail-open behavior.
 *
 * The browser half is a separate bundle; these tests pin the contract it consumes, so a
 * client change cannot silently depend on data the Host stopped sending.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JJ_OVERVIEW_PATH,
  JJ_REFRESH_PATH,
  buildJjOverview,
  registerJjPanelRoutes,
  type JjPanelRouteHost,
  type JjPanelServiceLike,
} from '../src/panel-host.ts';
import type { VcsDescriptor } from '../src/types.ts';

/** One captured route registration. */
interface RegisteredRoute {
  readonly path: string;
  readonly methods: readonly string[];
  readonly fetch: (request: Request) => Promise<Response>;
}

/** Build a fake connection service that records routes. */
function fakeHost(): JjPanelRouteHost & { routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  return {
    routes,
    fetch: {
      register(entry) {
        routes.push(entry);
        return () => {};
      },
    },
  };
}

/** Counters for the fake jj service. */
interface Calls {
  detect: number;
  readAt: number;
  workspaces: number;
  bookmarks: number;
  operations: number;
}

/** A jj descriptor for a colocated workspace. */
function descriptor(kind: VcsDescriptor['kind'] = 'jj-colocated'): VcsDescriptor {
  return {
    kind,
    root: '/repo',
    cwd: '/repo',
    workspaceName: 'default',
    notices: [],
    verified: true,
    jjRepoPath: '/repo/.jj/repo',
  } as unknown as VcsDescriptor;
}

/** A fake service whose calls are counted. */
function fakeService(
  calls: Calls,
  overrides: { readonly detect?: () => Promise<VcsDescriptor> } = {},
): JjPanelServiceLike {
  return {
    detect: async () => {
      calls.detect += 1;
      return overrides.detect !== undefined ? await overrides.detect() : descriptor();
    },
    operations: {
      readAt: async () => {
        calls.readAt += 1;
        return {
          changeId: 'abcabcabcabc',
          commitId: '111122223333',
          description: 'feat: overview',
          empty: false,
          conflict: false,
          currentWorkingCopy: true,
          bookmarks: [],
          remoteBookmarks: [],
          immutable: false,
          author: 'dev@example.com',
          paths: [],
        };
      },
      workspaceStates: async () => {
        calls.workspaces += 1;
        return [
          {
            name: 'default',
            root: '/repo',
            current: true,
            changeId: 'abcabcabcabc',
            commitId: '111122223333',
            description: 'feat: overview',
            empty: false,
            conflict: false,
            stale: 'no' as const,
          },
        ];
      },
      bookmarkList: async () => {
        calls.bookmarks += 1;
        return [{ name: 'main', target: '111122223333', conflicted: false }];
      },
      opLog: async () => {
        calls.operations += 1;
        return [
          {
            id: 'ffff1111',
            shortId: 'ffff1111',
            description: 'describe commit',
            time: '2026-11-09T08:00:00+00:00',
            user: 'dev',
            workspaceName: 'default',
            isSnapshot: false,
            tags: [],
          },
        ];
      },
    },
  } as unknown as JjPanelServiceLike;
}

/** Zeroed call counters. */
function zeroCalls(): Calls {
  return { detect: 0, readAt: 0, workspaces: 0, bookmarks: 0, operations: 0 };
}

test('the overview reports workspace, working copy, bookmarks and operations', async () => {
  const calls = zeroCalls();
  const overview = await buildJjOverview(fakeService(calls), '/repo', { enabled: true });
  assert.equal(overview.enabled, true);
  assert.deepEqual(overview.workspace, { kind: 'jj-colocated', root: '/repo', name: 'default' });
  assert.equal(overview.workingCopy?.changeId, 'abcabcabcabc');
  assert.equal(overview.workingCopy?.stale, 'no');
  assert.equal(overview.workspaces.length, 1);
  assert.deepEqual(overview.bookmarks, [{ name: 'main', target: '111122223333', conflicted: false }]);
  assert.equal(overview.operations[0]?.shortId, 'ffff1111');
  assert.equal(overview.reason, undefined);
});

test('a non-jj directory returns a reason instead of throwing', async () => {
  const calls = zeroCalls();
  const notices = [{ code: 'JJ_NOT_FOUND', detail: 'no jj workspace here' }];
  const overview = await buildJjOverview(
    fakeService(calls, {
      detect: async () => ({ ...descriptor('none'), notices }) as VcsDescriptor,
    }),
    '/tmp',
    { enabled: true },
  );
  assert.equal(overview.enabled, true);
  assert.equal(overview.workspace, undefined);
  assert.deepEqual(overview.workspaces, []);
  assert.match(overview.reason ?? '', /no jj workspace here/);
});

test('GET /api/jj.overview caches per directory and refresh invalidates it', async () => {
  const calls = zeroCalls();
  const host = fakeHost();
  let clock = 1_000;
  registerJjPanelRoutes(host, { service: fakeService(calls), enabled: true, now: () => clock, ttlMs: 5_000 });
  const overviewRoute = host.routes.find((route) => route.path === JJ_OVERVIEW_PATH);
  const refreshRoute = host.routes.find((route) => route.path === JJ_REFRESH_PATH);
  assert.ok(overviewRoute !== undefined && refreshRoute !== undefined);
  assert.deepEqual([...overviewRoute.methods], ['GET']);
  assert.deepEqual([...refreshRoute.methods], ['POST']);

  const url = 'http://localhost/api/jj.overview?cwd=/repo';
  const first = await overviewRoute.fetch(new Request(url));
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { enabled: boolean }).enabled, true);
  assert.equal(calls.detect, 1);

  clock += 1_000;
  const second = await overviewRoute.fetch(new Request(url));
  assert.equal(second.status, 200);
  assert.equal(calls.detect, 1, 'a cached read spawns nothing');

  const refreshed = await refreshRoute.fetch(
    new Request('http://localhost/api/jj.refresh', { method: 'POST', body: JSON.stringify({ cwd: '/repo' }) }),
  );
  assert.equal(refreshed.status, 200);
  assert.equal(calls.detect, 2, 'refresh re-reads the repository');

  clock += 6_000;
  await overviewRoute.fetch(new Request(url));
  assert.equal(calls.detect, 3, 'the TTL expires the snapshot');
});

test('missing parameters are client errors, and uiPanel off short-circuits', async () => {
  const calls = zeroCalls();
  const host = fakeHost();
  registerJjPanelRoutes(host, { service: fakeService(calls), enabled: false });
  const overviewRoute = host.routes[0];
  const refreshRoute = host.routes[1];
  assert.ok(overviewRoute !== undefined && refreshRoute !== undefined);

  const disabled = await overviewRoute.fetch(new Request('http://localhost/api/jj.overview?cwd=/repo'));
  assert.equal(disabled.status, 200);
  assert.equal(((await disabled.json()) as { enabled: boolean }).enabled, false);
  assert.equal(calls.detect, 0, 'a disabled panel never touches the repository');

  const enabledHost = fakeHost();
  registerJjPanelRoutes(enabledHost, { service: fakeService(calls), enabled: true });
  const enabledOverview = enabledHost.routes[0]!;
  const enabledRefresh = enabledHost.routes[1]!;
  assert.equal((await enabledOverview.fetch(new Request('http://localhost/api/jj.overview'))).status, 400);
  assert.equal(
    (await enabledRefresh.fetch(new Request('http://localhost/api/jj.refresh', { method: 'POST', body: '{}' }))).status,
    400,
  );
});

test('a throwing read degrades to a reasoned snapshot instead of a 500', async () => {
  const calls = zeroCalls();
  const host = fakeHost();
  registerJjPanelRoutes(host, {
    service: fakeService(calls, {
      detect: async () => {
        throw new Error('jj exploded');
      },
    }),
    enabled: true,
  });
  const response = await host.routes[0]!.fetch(new Request('http://localhost/api/jj.overview?cwd=/repo'));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { enabled: boolean; reason?: string; workspaces: unknown[] };
  assert.equal(body.enabled, true);
  assert.match(body.reason ?? '', /jj exploded/);
  assert.deepEqual(body.workspaces, []);
});
