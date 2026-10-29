/**
 * Model-facing prompt context (policy 2026-10-22): the session-start "prefer jj" notice.
 *
 * These tests use the documented DSH shape rather than a private double: one global
 * `systemPrompt.context(...)` whose text provider reads `AssembleContext.agent`, exactly
 * like `@deepseek-ai/dsh-working-directory` does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installJjPromptContext, jjPreferenceContextText, JJ_CONTEXT_NAME } from '../src/prompt-context.ts';
import type { VcsSniff } from '../src/types.ts';
import { initGit, initJjColocated, initJjNative, makeFixture } from './helpers/fixtures.ts';

/** Session identity used as the working-directory service key. */
interface FakeSession {
  readonly id: string;
}

/** One registered prompt context, structurally typed for the assertions below. */
interface CapturedContext {
  readonly name: string;
  readonly order: number;
  readonly interpolate: boolean;
  readonly required: boolean;
  readonly text: (context: { readonly agent?: { readonly session?: unknown } } | undefined) => string;
}

/** Host double: only the inject-free `get` accessor and the two services are needed. */
function fakeHost({
  cwdBySession,
  withSystemPrompt = true,
  order = 100,
}: {
  readonly cwdBySession: { get(session: FakeSession): string | undefined };
  readonly withSystemPrompt?: boolean;
  readonly order?: number;
}): { host: { get(name: string): unknown }; captured: CapturedContext[]; disposers: CapturedContext[] } {
  const captured: CapturedContext[] = [];
  const disposers: CapturedContext[] = [];
  const services: Record<string, unknown> = {
    workingDirectory: { get: (session: FakeSession) => cwdBySession.get(session) },
    systemPrompt: withSystemPrompt
      ? {
          context: (context: CapturedContext) => {
            captured.push(context);
            const dispose = () => disposers.push(context);
            return dispose;
          },
          getContextOrder: (name: string) => {
            assert.equal(name, 'WORKING_DIRECTORY', 'the canonical sibling slot is requested');
            return order;
          },
        }
      : undefined,
  };
  return { host: { get: (name: string) => services[name] }, captured, disposers };
}

test('registers one global context at the WORKING_DIRECTORY slot', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const session = { id: 's1' };
  const { host, captured } = fakeHost({ cwdBySession: new Map([[session, colo]]) });

  const dispose = installJjPromptContext(host);
  assert.equal(captured.length, 1, 'exactly one registration, independent of agent count');
  const context = captured[0];
  assert.equal(context.name, JJ_CONTEXT_NAME);
  assert.equal(context.order, 100);
  assert.equal(context.interpolate, false, 'repository paths must not be interpolated');
  assert.equal(context.required, false, 'optional runtime context may be disabled');

  const text = context.text({ agent: { session } });
  assert.match(text, /Jujutsu \(jj\) workspace/);
  assert.match(text, /jj-colocated/);
  assert.match(text, /Prefer jj/);
  assert.match(text, /jj_/);
  assert.equal(typeof dispose, 'function');
  dispose();
  dispose(); // idempotent
});

test('contributes nothing outside a jj workspace, or without an agent', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-none');
  const git = await initGit(fx.run, fx.path('git'));
  const gitSession = { id: 'g1' };
  const gitHost = fakeHost({ cwdBySession: new Map([[gitSession, git]]) });
  installJjPromptContext(gitHost.host);
  assert.equal(gitHost.captured[0].text({ agent: { session: gitSession } }), '', 'plain Git repo contributes nothing');
  assert.equal(gitHost.captured[0].text(undefined), '', 'a diagnostics assembly has no agent');
  assert.equal(gitHost.captured[0].text({}), '', 'an agent without a resolvable directory contributes nothing');
});

test('jj-native workspaces are named as such', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-native');
  const native = await initJjNative(fx.run, fx.path('native'));
  const session = { id: 'n1' };
  const { host, captured } = fakeHost({ cwdBySession: new Map([[session, native]]) });
  installJjPromptContext(host);
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /jj-native/);
  assert.match(text, /no root \.git|re-imports/, 'the jj-native wording explains the git situation');
});

test('a warm cache wins over the sniff, and a missing systemPrompt is harmless', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-cache');
  const colo = await initJjColocated(fx.run, fx.path('colo'));
  const session = { id: 'c1' };
  const { host, captured } = fakeHost({ cwdBySession: new Map([[session, colo]]) });
  installJjPromptContext(host, {
    // The peek answers first, so this deliberately partial sniff result is never read.
    sniff: () => ({ cwd: '/nowhere', kind: 'none' }) as unknown as VcsSniff,
    peek: (cwd) => ({ kind: 'jj-colocated', root: cwd, workspaceName: 'default' }),
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /workspace "default"/, 'the cached descriptor supplies the workspace name');

  const bare = fakeHost({ cwdBySession: new Map(), withSystemPrompt: false });
  const dispose = installJjPromptContext(bare.host);
  assert.equal(bare.captured.length, 0);
  dispose();
});

test('the shared text helper is stable', () => {
  const text = jjPreferenceContextText('jj-colocated', '/repo', 'default');
  assert.match(text, /^This session's working directory is a Jujutsu \(jj\) workspace \(jj-colocated: \/repo \(workspace "default"\)\)\./);
  assert.match(text, /jj describe/);
  assert.match(text, /jj_commit_style/, 'the default text explains how to learn the description style');
});

test('default context asks the model to inherit descriptions and split commits', () => {
  const text = jjPreferenceContextText('jj-colocated', '/repo');
  assert.match(text, /inherit this repository's existing style/);
  assert.match(text, /jj_commit_style/);
  assert.match(text, /needsUserChoice/);
  assert.match(text, /jj commit -m/, 'jj commit is part of the recommended workflow');
  assert.match(text, /small, self-contained commits/);
  assert.match(text, /hard for humans to review/);
  assert.match(text, /never use git commit/);
});

test('commit guidance can be disabled without dropping the jj preference', () => {
  const text = jjPreferenceContextText('jj-colocated', '/repo', undefined, { commitGuidance: false });
  assert.match(text, /Prefer jj/);
  assert.ok(!text.includes('Commit descriptions'), 'no description-style section');
  assert.ok(!text.includes('Commit granularity'), 'no split-commit section');
});

test('configured and custom styles are reflected in the prompt text', () => {
  const angular = jjPreferenceContextText('jj-native', '/repo', undefined, { commitStyle: 'angular' });
  assert.match(angular, /Angular commit convention/);
  assert.ok(angular.includes('<type>(<scope>): <subject>'));

  const rules = 'Chinese imperative subject, no prefix, body optional.';
  const custom = jjPreferenceContextText('jj-native', '/repo', undefined, { commitStyle: 'custom', commitStyleCustom: rules });
  assert.ok(custom.includes(rules), 'custom rules are copied verbatim');

  const noSplit = jjPreferenceContextText('jj-native', '/repo', undefined, { preferSplitCommits: false });
  assert.ok(!noSplit.includes('Commit granularity'));
  assert.match(noSplit, /Commit descriptions/);
});

test('the install options forward into the registered context text', () => {
  const session = { id: 'style' };
  const cwd = '/fake/jj-workspace';
  const { host, captured } = fakeHost({ cwdBySession: new Map([[session, cwd]]) });
  installJjPromptContext(host, {
    sniff: () => ({ cwd, kind: 'jj-colocated', jjRoot: cwd, diagnostics: [] }),
    commitStyle: 'gitmoji',
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /Gitmoji/);
  assert.match(text, /:sparkles:/);
});
// ---------------------------------------------------------------------------
// Multi-session guidance (policy 2026-10-30): parallel top-level DSH sessions.
// ---------------------------------------------------------------------------

/** Sniff double: the current checkout is a colocated jj workspace. */
function colocatedSniff(root: string, workspaceRoot = root, jjRepoPath = `${root}/.jj/repo`): (cwd: string) => VcsSniff {
  return (cwd) => ({ cwd, kind: 'jj-colocated', jjRoot: workspaceRoot, jjRepoPath, diagnostics: [] });
}

test('a parallel session sharing the working copy gets the isolate-now guidance', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-parallel');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const session = { id: 'parallel-current' };
  const peer = { id: 'parallel-peer' };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo], [peer, repo]]) });
  installJjPromptContext(host, {
    sniff: colocatedSniff(repo),
    liveRootSessions: () => [
      { session, cwd: repo },
      { session: peer, cwd: repo },
    ],
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /Parallel sessions: another live DSH session is using this Jujutsu working copy/);
  assert.match(text, /jj_workspace_add/);
  assert.match(text, /standard rebase hand-off/);
  assert.match(text, /Inherit this repository|Commit descriptions/, 'commit guidance is still present');
});

test('sibling workspaces of one repository get the coordination wording and the configured target', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-sibling');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const peerRoot = fx.path('repo-w2');
  const session = { id: 'sibling-current' };
  const peer = { id: 'sibling-peer' };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo], [peer, peerRoot]]) });
  installJjPromptContext(host, {
    sniff: (cwd) =>
      cwd === peerRoot
        ? { cwd, kind: 'jj-colocated', jjRoot: peerRoot, jjRepoPath: `${repo}/.jj/repo`, diagnostics: [] }
        : colocatedSniff(repo)(cwd),
    liveRootSessions: () => [
      { session, cwd: repo },
      { session: peer, cwd: peerRoot },
    ],
    rebaseTarget: 'main',
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /but works in a separate workspace/);
  assert.match(text, /destination = main/);
  assert.ok(!text.includes('jj_workspace_add'), 'an isolated peer needs no new workspace');
});

test('a subagent session (not a top-level root) never counts its parent as a parallel peer', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-subagent');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const parent = { id: 'parent-session' };
  const child = { id: 'child-subagent' };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[child, repo]]) });
  installJjPromptContext(host, {
    sniff: colocatedSniff(repo),
    // The registry only reports roots: the child is absent, so it is a subagent.
    liveRootSessions: () => [{ session: parent, cwd: repo }],
  });
  const text = captured[0].text({ agent: { session: child } });
  assert.match(text, /Jujutsu \(jj\) workspace/, 'the jj preference still applies');
  assert.ok(!text.includes('Parallel sessions'), 'a delegated subagent is not a parallel session peer');
});

test('multi-session guidance respects off/auto/always', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-modes');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const session = { id: 'mode-current' };
  const peer = { id: 'mode-peer' };
  const peers = () => [
    { session, cwd: repo },
    { session: peer, cwd: repo },
  ];
  const make = (options: Parameters<typeof installJjPromptContext>[1]): string => {
    const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo]]) });
    installJjPromptContext(host, options);
    return captured[0].text({ agent: { session } });
  };
  const sniff = colocatedSniff(repo);
  assert.ok(!make({ sniff, liveRootSessions: peers, multiSessionGuidance: 'off' }).includes('Parallel sessions'));
  assert.ok(!make({ sniff }).includes('Parallel sessions'), 'auto without a session source is fail-open');
  assert.match(make({ sniff, multiSessionGuidance: 'always' }), /separate dsh processes/);
  assert.match(make({ sniff, multiSessionGuidance: 'always' }), /standard rebase hand-off/);
});

test('a throwing live-session source never breaks the prompt context', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-throw');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const session = { id: 'throw-current' };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo]]) });
  installJjPromptContext(host, {
    sniff: colocatedSniff(repo),
    liveRootSessions: () => {
      throw new Error('agent registry exploded');
    },
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /Jujutsu \(jj\) workspace/);
  assert.ok(!text.includes('Parallel sessions'));
});

test('peeked peer descriptors avoid re-sniffing peer directories', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-peek');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const session = { id: 'peek-current' };
  const peer = { id: 'peek-peer' };
  const peerRoot = fx.path('repo-peek-w2');
  const sniffed: string[] = [];
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo], [peer, peerRoot]]) });
  installJjPromptContext(host, {
    peek: (cwd) =>
      cwd === repo
        ? { kind: 'jj-colocated', root: repo, workspaceName: 'default', jjRepoPath: `${repo}/.jj/repo` }
        : cwd === peerRoot
          ? { kind: 'jj-colocated', root: peerRoot, workspaceName: 'w2', jjRepoPath: `${repo}/.jj/repo` }
          : undefined,
    sniff: (cwd) => {
      sniffed.push(cwd);
      return colocatedSniff(repo)(cwd);
    },
    liveRootSessions: () => [
      { session, cwd: repo },
      { session: peer, cwd: peerRoot },
    ],
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /works in a separate workspace/);
  assert.deepEqual(sniffed, [], 'both descriptors came from the warm cache');
});

test('a session that saw a parallel peer keeps the finish checklist after the peer ends', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-latch');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const session = { id: 'latch-current' };
  const peer = { id: 'latch-peer' };
  const live = { running: true };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo], [peer, repo]]) });
  installJjPromptContext(host, {
    sniff: colocatedSniff(repo),
    liveRootSessions: () =>
      live.running
        ? [
            { session, cwd: repo },
            { session: peer, cwd: repo },
          ]
        : [{ session, cwd: repo }],
  });

  const whilePeerAlive = captured[0].text({ agent: { session } });
  assert.match(whilePeerAlive, /Parallel sessions: another live DSH session/);
  assert.match(whilePeerAlive, /standard rebase hand-off/);

  live.running = false;
  const afterPeerLeft = captured[0].text({ agent: { session } });
  assert.ok(!afterPeerLeft.includes('Parallel sessions'), 'the stale peer claim is gone');
  assert.match(afterPeerLeft, /standard rebase hand-off/, 'the hand-off checklist is latched for the rest of the session');
});

test('subagents never receive multi-session guidance, even in always mode', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-subagent-always');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const parent = { id: 'always-parent' };
  const child = { id: 'always-child' };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[child, repo]]) });
  installJjPromptContext(host, {
    sniff: colocatedSniff(repo),
    multiSessionGuidance: 'always',
    // The child is absent from roots(), so it is a subagent, not a parallel session.
    liveRootSessions: () => [{ session: parent, cwd: repo }],
  });
  const text = captured[0].text({ agent: { session: child } });
  assert.match(text, /Jujutsu \(jj\) workspace/);
  assert.ok(!text.includes('Parallel sessions'), 'a subagent is not an independent session');
  assert.ok(!text.includes('standard rebase hand-off'), 'no hand-off checklist for delegated work');
});

test("'always' mode still contributes generically when the host enumerates sessions", async (t) => {
  const fx = makeFixture(t, 'dsh-jj-prompt-always-source');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const session = { id: 'always-source-current' };
  const { host, captured } = fakeHost({ cwdBySession: new Map<FakeSession, string>([[session, repo]]) });
  installJjPromptContext(host, {
    sniff: colocatedSniff(repo),
    multiSessionGuidance: 'always',
    liveRootSessions: () => [{ session, cwd: repo }],
  });
  const text = captured[0].text({ agent: { session } });
  assert.match(text, /separate dsh processes/);
  assert.match(text, /standard rebase hand-off/);
});
