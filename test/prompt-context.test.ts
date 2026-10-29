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