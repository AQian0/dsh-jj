/**
 * Read-only panel Host routes: payload shape, caching, refresh, and fail-open behavior.
 *
 * The browser half is a separate bundle; these tests pin the contract it consumes, so a
 * client change cannot silently depend on data the Host stopped sending.
 */
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { detectVcs } from '../src/detect.ts';
import { createCommandRunJj } from '../src/jj-command.ts';
import {
  JJ_OVERVIEW_PATH,
  JJ_REFRESH_PATH,
  JJ_REVISION_PATH,
  buildJjFileDiff,
  buildJjOverview,
  buildJjRevisionDetail,
  registerJjPanelRoutes,
  type JjPanelFileDiff,
  type JjPanelRevisionDetail,
  type JjPanelRouteHost,
  type JjPanelServiceLike,
} from '../src/panel-host.ts';
import { JjOperations } from '../src/service.ts';
import { sessionHeartbeatPath, writeSessionHeartbeat } from '../src/session-heartbeat.ts';
import type { VcsDescriptor } from '../src/types.ts';
import { writeWorkspaceRecord } from '../src/workspace-registry.ts';
import { initJjColocated, makeFixture, mustRun } from './helpers/fixtures.ts';

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
  stack: number;
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
      log: async () => {
        calls.stack += 1;
        return [
          {
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
          },
        ];
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
  return { detect: 0, readAt: 0, stack: 0, workspaces: 0, bookmarks: 0, operations: 0 };
}

test('the overview reports workspace, working copy, bookmarks and operations', async () => {
  const calls = zeroCalls();
  const overview = await buildJjOverview(fakeService(calls), '/repo', { enabled: true });
  assert.equal(overview.enabled, true);
  assert.deepEqual(overview.workspace, { kind: 'jj-colocated', root: '/repo', name: 'default' });
  assert.equal(overview.workingCopy?.changeId, 'abcabcabcabc');
  assert.equal(overview.workingCopy?.stale, 'no');
  assert.deepEqual(
    overview.stack.map((entry) => entry.changeId),
    ['abcabcabcabc'],
    'the stack is read from jj without snapshotting',
  );
  assert.equal(overview.workspaces.length, 1);
  assert.equal(overview.bookmarks.length, 1);
  assert.equal(overview.bookmarks[0]?.name, 'main');
  assert.equal(overview.bookmarks[0]?.target, '111122223333');
  assert.equal(overview.bookmarks[0]?.conflicted, false);
  assert.equal(overview.bookmarks[0]?.targetChangeId, 'abcabcabcabc');
  assert.equal(overview.bookmarks[0]?.targetDescription, 'feat: overview');
  assert.equal(overview.operations[0]?.shortId, 'ffff1111');
  assert.equal(overview.operations[0]?.user, 'dev');
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

test('buildJjOverview reads a dirty real jj workspace without snapshotting or creating an operation', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-panel-no-snapshot');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const runJj = createCommandRunJj(fx.run, resolveConfig({}));
  const operations = new JjOperations({ runJj });
  const service: JjPanelServiceLike = {
    detect: async (cwd, signal) => await detectVcs(cwd, fx.run, signal),
    operations,
  };

  const opsBefore = await operations.opLog(repo, 20);
  // Dirty the working tree without running any snapshotting jj command.
  writeFileSync(join(repo, 'unsnapshotted.txt'), 'dirty working tree\n');

  const overview = await buildJjOverview(service, repo, { enabled: true });
  assert.equal(overview.enabled, true);
  assert.equal(overview.workspace?.root, repo);
  assert.equal(overview.workingCopy?.stale, 'unknown');

  const opsAfter = await operations.opLog(repo, 20);
  assert.deepEqual(
    opsAfter.map((op) => op.id),
    opsBefore.map((op) => op.id),
    'panel overview must pass --ignore-working-copy on every jj command and create zero snapshot operations',
  );
});

test('panel routes reject out-of-scope directories with HTTP 403 before spawning jj', async () => {
  const calls = zeroCalls();
  const host = fakeHost();
  registerJjPanelRoutes(host, {
    service: fakeService(calls),
    enabled: true,
    isAllowedCwd: (cwd) => cwd === '/repo',
  });
  const overviewRoute = host.routes.find((route) => route.path === JJ_OVERVIEW_PATH)!;
  const refreshRoute = host.routes.find((route) => route.path === JJ_REFRESH_PATH)!;

  const deniedGet = await overviewRoute.fetch(new Request('http://localhost/api/jj.overview?cwd=/etc'));
  assert.equal(deniedGet.status, 403);
  const deniedPost = await refreshRoute.fetch(
    new Request('http://localhost/api/jj.refresh', { method: 'POST', body: JSON.stringify({ cwd: '/etc' }) }),
  );
  assert.equal(deniedPost.status, 403);
  assert.equal(calls.detect, 0, 'rejected directories must never reach detect()');

  const allowedGet = await overviewRoute.fetch(new Request('http://localhost/api/jj.overview?cwd=/repo'));
  assert.equal(allowedGet.status, 200);
  assert.equal(calls.detect, 1);
});

test('GET /api/jj.revision returns revision details and bounded file diffs with validation and caching', async () => {
  let revCalls = 0;
  let diffCalls = 0;
  const service: JjPanelServiceLike = {
    detect: async () => descriptor(),
    operations: {
      readAt: async () => ({
        changeId: 'abcabcabcabc',
        commitId: '111122223333',
        description: 'feat: title\n\ndetailed body line',
        empty: false,
        conflict: false,
        currentWorkingCopy: true,
        bookmarks: ['main'],
        remoteBookmarks: [],
        immutable: false,
        author: 'dev@example.com',
        paths: [],
      }),
      log: async () => [],
      readPanelLog: async () => [
        {
          changeId: 'abcabcabcabc',
          shortestChangeId: 'ab',
          commitId: '111122223333',
          parents: ['000011112222'],
          description: 'feat: title',
          empty: false,
          conflict: false,
          currentWorkingCopy: true,
          bookmarks: ['main'],
          remoteBookmarks: [],
          immutable: false,
          rewritable: true,
          author: 'Dev',
          authorEmail: 'dev@example.com',
          timestamp: '2026-11-12T10:00:00+08:00',
        },
        {
          changeId: 'zzzzzzzzzzzz',
          shortestChangeId: 'zz',
          commitId: '000011112222',
          parents: [],
          description: 'chore: base',
          empty: false,
          conflict: false,
          currentWorkingCopy: false,
          bookmarks: [],
          remoteBookmarks: ['main'],
          immutable: true,
          rewritable: false,
          author: 'Dev',
          authorEmail: 'dev@example.com',
          timestamp: '2026-11-11T10:00:00+08:00',
        },
      ],
      readPanelRevision: async () => {
        revCalls += 1;
        return {
          changeId: 'abcabcabcabc',
          shortestChangeId: 'ab',
          commitId: '111122223333',
          parents: ['000011112222'],
          description: 'feat: title\n\ndetailed body line',
          empty: false,
          conflict: false,
          currentWorkingCopy: true,
          bookmarks: ['main'],
          remoteBookmarks: [],
          immutable: false,
          rewritable: true,
          author: 'Dev',
          authorEmail: 'dev@example.com',
          timestamp: '2026-11-12T10:00:00+08:00',
        };
      },
      readPanelDiffFiles: async () => [{ path: 'src/a.ts', status: 'modified', added: 3, removed: 1, conflict: false }],
      diff: async () => {
        diffCalls += 1;
        return {
          text: [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,3 @@',
            ' line 1',
            '-old line',
            '+new line',
            '+extra line',
          ].join('\n'),
          truncated: false,
        };
      },
      workspaceStates: async () => [],
      bookmarkList: async () => [
        { name: 'main', target: '111122223333', remote: null, conflicted: false },
        { name: 'main', target: '000011112222', remote: 'origin', conflicted: false },
        { name: 'main', target: '111122223333', remote: 'git', conflicted: false },
        { name: 'upstream-only', target: '000011112222', remote: 'origin', conflicted: false },
      ],
      opLog: async () => [],
    },
  };

  // Enriched overview computes bookmark sync (ahead) and filters @git while preserving remote-only bookmarks.
  const overview = await buildJjOverview(service, '/repo', { enabled: true });
  assert.equal(overview.history?.length, 2);
  assert.equal(overview.stack.length, 1);
  assert.equal(overview.workingCopy?.files?.length, 1);
  assert.equal(overview.workingCopy?.totalAdded, 3);
  assert.equal(overview.workingCopy?.totalRemoved, 1);
  assert.deepEqual(overview.bookmarks[0]?.remotes, [
    { remote: 'origin', target: '000011112222', conflicted: false, sync: 'ahead' },
  ]);
  assert.deepEqual(overview.remoteOnlyBookmarks, [
    { name: 'upstream-only', remote: 'origin', target: '000011112222', conflicted: false },
  ]);

  const host = fakeHost();
  let clock = 10_000;
  registerJjPanelRoutes(host, {
    service,
    enabled: true,
    isAllowedCwd: (cwd) => cwd === '/repo',
    now: () => clock,
    ttlMs: 5_000,
  });
  const revRoute = host.routes.find((route) => route.path === JJ_REVISION_PATH)!;
  const refreshRoute = host.routes.find((route) => route.path === JJ_REFRESH_PATH)!;
  assert.ok(revRoute !== undefined);

  // Validation and scope enforcement.
  assert.equal((await revRoute.fetch(new Request('http://localhost/api/jj.revision?rev=@'))).status, 400);
  assert.equal((await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/etc&rev=@'))).status, 403);
  assert.equal((await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo'))).status, 400);
  assert.equal(
    (await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo&rev=--help'))).status,
    400,
    'flag-like rev must be rejected',
  );
  assert.equal(
    (await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo&rev=all()'))).status,
    400,
    'arbitrary revsets must be rejected',
  );
  assert.equal(
    (await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo&rev=@&file=-x'))).status,
    400,
    'flag-like file path must be rejected',
  );

  // Revision detail read + caching.
  const firstRev = await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo&rev=111122223333'));
  assert.equal(firstRev.status, 200);
  const firstBody = (await firstRev.json()) as JjPanelRevisionDetail;
  assert.equal(firstBody.revision?.description, 'feat: title\n\ndetailed body line');
  assert.equal(firstBody.revision?.files.length, 1);
  assert.equal(revCalls, 1);

  await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo&rev=111122223333'));
  assert.equal(revCalls, 1, 'revision reads are cached within TTL');

  // File diff read.
  const fileResp = await revRoute.fetch(
    new Request('http://localhost/api/jj.revision?cwd=/repo&rev=111122223333&file=src%2Fa.ts'),
  );
  assert.equal(fileResp.status, 200);
  const fileBody = (await fileResp.json()) as JjPanelFileDiff;
  assert.equal(fileBody.path, 'src/a.ts');
  assert.equal(fileBody.added, 2);
  assert.equal(fileBody.removed, 1);
  assert.equal(fileBody.hunks?.length, 1);
  assert.equal(diffCalls, 1);

  // POST /api/jj.refresh clears both overview and revision caches for that cwd.
  await refreshRoute.fetch(
    new Request('http://localhost/api/jj.refresh', { method: 'POST', body: JSON.stringify({ cwd: '/repo' }) }),
  );
  await revRoute.fetch(new Request('http://localhost/api/jj.revision?cwd=/repo&rev=111122223333'));
  assert.equal(revCalls, 2, 'refresh invalidates cached revision detail');
});

test('real jj fixture: overview, revision detail and file diff stay strictly read-only without snapshotting or purging heartbeats', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-panel-rich-readonly');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  writeFileSync(join(repo, 'hello.txt'), 'line 1\nline 2\n');
  await mustRun(fx.run, ['jj', 'commit', '-m', 'feat: add hello\n\nsecond paragraph'], repo);
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);
  const siblingRoot = fx.path('repo-orphan');
  await mustRun(fx.run, ['jj', 'workspace', 'add', siblingRoot, '--name', 'orphan-ws'], repo);

  const runJj = createCommandRunJj(fx.run, resolveConfig({}));
  const operations = new JjOperations({ runJj });
  const service: JjPanelServiceLike = {
    detect: async (cwd, signal) => await detectVcs(cwd, fx.run, signal),
    operations,
  };

  const detected = await service.detect(repo);
  assert.ok(detected.jjRepoPath !== undefined);
  // Seed one managed workspace record with a dead owner and one expired heartbeat to verify zero disk writes.
  writeWorkspaceRecord(detected.jjRepoPath, {
    name: 'orphan-ws',
    root: siblingRoot,
    sessionId: 'dead-session',
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  writeSessionHeartbeat(detected.jjRepoPath, {
    sessionId: 'expired-session',
    cwd: repo,
    workspaceName: 'default',
    workspaceRoot: repo,
    active: true,
    updatedAt: 1_000,
  });
  const expiredHeartbeatFile = sessionHeartbeatPath(detected.jjRepoPath, 'expired-session');
  assert.equal(existsSync(expiredHeartbeatFile), true);

  const opsBefore = await operations.opLog(repo, 30);
  // Dirty the working tree without running any snapshotting jj command.
  writeFileSync(join(repo, 'unsnapshotted.txt'), 'dirty working tree\n');

  const overview = await buildJjOverview(service, repo, {
    enabled: true,
    liveSessions: () => [{ sessionId: 'live-1', cwd: repo, active: true }],
    now: () => 999_999_999_999,
  });
  assert.equal(overview.enabled, true);
  assert.ok((overview.history?.length ?? 0) >= 2, 'history includes @ and committed parent');
  const mainBm = overview.bookmarks.find((bm) => bm.name === 'main');
  assert.ok(mainBm !== undefined && mainBm.target !== undefined);
  assert.equal(mainBm.targetDescription, 'feat: add hello');

  const orphanWs = overview.workspaces.find((ws) => ws.name === 'orphan-ws');
  assert.equal(orphanWs?.managed, true);
  assert.equal(orphanWs?.sessionState, 'orphaned');
  const defaultWs = overview.workspaces.find((ws) => ws.name === 'default');
  assert.equal(defaultWs?.sessionState, 'active');

  const detail = await buildJjRevisionDetail(service, repo, mainBm.target, { enabled: true });
  assert.equal(detail.revision?.description, 'feat: add hello\n\nsecond paragraph');
  assert.equal(detail.revision?.files[0]?.path, 'hello.txt');
  assert.equal(detail.revision?.files[0]?.added, 2);

  const fileDiff = await buildJjFileDiff(service, repo, mainBm.target, 'hello.txt', { enabled: true });
  assert.equal(fileDiff.path, 'hello.txt');
  assert.equal(fileDiff.added, 2);
  assert.ok((fileDiff.hunks?.length ?? 0) === 1);

  const opsAfter = await operations.opLog(repo, 30);
  assert.deepEqual(
    opsAfter.map((op) => op.id),
    opsBefore.map((op) => op.id),
    'overview, revision detail and file diff must create zero snapshot operations',
  );
  assert.equal(
    existsSync(expiredHeartbeatFile),
    true,
    'panel reads must pass purgeExpired: false and never delete heartbeat files',
  );
});
