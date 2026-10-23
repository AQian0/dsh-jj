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
});