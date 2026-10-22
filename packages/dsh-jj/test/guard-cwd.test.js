/**
 * V1 regression (task-11): the guard must resolve the **session** working
 * directory through the real `WorkingDirectoryService`.
 *
 * Production shape: the guard entry receives the live Cordis context, so
 * `host.workingDirectory` is the real service, which is keyed by a **Session**
 * (its projection state needs `session.snapshotEvents`), while the tool execution
 * carries a live **Agent** whose session lives at `agent.session`.
 *
 * These tests build the real services (no doubles) and then check both failure
 * directions the 2026-10 verification reported:
 * (a) session in a plain Git repository + host startup directory in a jj repo
 *     must be allowed (was a false positive), and
 * (b) session in a jj repository + host startup directory elsewhere must be
 *     refused (was a silent miss).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SessionProjectionService from '@deepseek-ai/dsh-session-projection';
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory';
import { installGitConfusionGuard } from '../src/guard.ts';
import { createGuardContext, initGit, initJjColocated, makeFixture } from './helpers/fixtures.js';

/** Build the real working-directory stack the way the Host does. */
function realWorkingDirectory(defaultDirectory) {
  const ctx = new Context();
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    context: () => {},
    getContextOrder: () => 0,
  });
  ctx.provide('fs', { resolve: async (path) => path, stat: async () => undefined, processPath: (path) => path });
  new SessionProjectionService(ctx);
  return new WorkingDirectoryService(ctx, { defaultDirectory });
}

/** Faithful minimal live Session shape (`cellFor` needs header + snapshotEvents). */
function fakeSession(cwd) {
  return {
    id: 'v1-session',
    header: { cwd },
    inheritedEventCount: 0,
    seq: 0,
    snapshotEvents: () => [],
    eventAt: () => undefined,
  };
}

/** Live Agent shape: it carries the session but is not itself a Session key. */
function fakeAgent(session) {
  return { id: session.id, session };
}

function guardWithRealCwdResolver(harness, workingDirectory, config = {}) {
  return installGitConfusionGuard(
    { tools: harness.ctx.tools, workingDirectory, emit: harness.ctx.emit, logger: harness.ctx.logger },
    config,
  );
}

test('V1(a): session in a plain Git repo is allowed even when the host started in a jj repo', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v1a');
  const hostStartup = await initJjColocated(fx.run, fx.path('host-jj'));
  const sessionRepo = await initGit(fx.run, fx.path('session-git'));

  const workingDirectory = realWorkingDirectory(hostStartup);
  const session = fakeSession(sessionRepo);
  const agent = fakeAgent(session);
  assert.equal(workingDirectory.get(session), sessionRepo, 'the real service resolves the session key');

  const harness = createGuardContext();
  guardWithRealCwdResolver(harness, workingDirectory, {});
  const execution = { name: 'bash', callId: 'v1a', arguments: { command: 'git commit -m x' }, agent, signal: new AbortController().signal };
  assert.equal(harness.runGuard(execution), undefined, 'a Git commit inside a plain Git session must not be blocked');
});

test('V1(b): session in a jj workspace is refused even when the host started elsewhere', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v1b');
  const sessionRepo = await initJjColocated(fx.run, fx.path('session-jj'));
  const plainStartup = fx.path('plain-startup');

  const workingDirectory = realWorkingDirectory(plainStartup);
  const session = fakeSession(sessionRepo);
  const agent = fakeAgent(session);

  const harness = createGuardContext();
  guardWithRealCwdResolver(harness, workingDirectory, { guardMutatingGit: 'deny' });
  const execution = { name: 'bash', callId: 'v1b', arguments: { command: 'git commit -m x' }, agent, signal: new AbortController().signal };
  const reason = harness.runGuard(execution);
  assert.equal(typeof reason, 'string', 'a Git commit inside a jj session must be blocked');
  assert.match(reason, /^Blocked: `git commit`/);
  assert.ok(reason.includes(sessionRepo), `the refusal must name the session workspace, got: ${reason.split('\n')[0]}`);
});

test('V1(c): without an agent the guard falls back to defaultCwd, not the host directory', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v1c');
  const jjRepo = await initJjColocated(fx.run, fx.path('jj'));
  const otherRepo = await initGit(fx.run, fx.path('git'));
  const harness = createGuardContext();
  const workingDirectory = realWorkingDirectory(otherRepo);
  guardWithRealCwdResolver(harness, workingDirectory, { defaultCwd: jjRepo, guardMutatingGit: 'deny' });
  const reason = harness.runGuard({ name: 'bash', arguments: { command: 'git commit -m x' } });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.includes(jjRepo), 'the configured defaultCwd is used');
});

test('V1(d) §5.10: a broken working-directory resolution degrades to fail-open with a one-time diagnostic', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v1d');
  const jjRepo = await initJjColocated(fx.run, fx.path('jj'));
  const harness = createGuardContext();
  const broken = {
    get: () => {
      throw new TypeError('session.snapshotEvents is not a function');
    },
  };
  guardWithRealCwdResolver(harness, broken, { defaultCwd: jjRepo });
  const execution = { name: 'bash', callId: 'v1d', arguments: { command: 'git commit -m x' }, agent: fakeAgent(fakeSession(jjRepo)), signal: new AbortController().signal };
  assert.equal(harness.runGuard(execution), undefined, 'a degraded cwd resolution allows the call (fail-open)');
  const diagnostics = harness.events.filter((entry) => entry.event === 'jj/guard-degraded');
  assert.equal(diagnostics.length, 1, 'the failure is diagnosed once, not swallowed silently');
  assert.match(diagnostics[0]?.payload?.message ?? '', /could not resolve the session working directory/);
  assert.equal(harness.logged.length, 1, 'the logger also receives the warning');
  harness.runGuard(execution);
  assert.equal(harness.events.filter((entry) => entry.event === 'jj/guard-degraded').length, 1, 'the diagnostic is one-time');
});

test('V1(e) §5.10: a host without a workingDirectory service degrades the same way', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v1e');
  const jjRepo = await initJjColocated(fx.run, fx.path('jj'));
  const harness = createGuardContext();
  installGitConfusionGuard({ tools: harness.ctx.tools, emit: harness.ctx.emit, logger: harness.ctx.logger }, { config: {} });
  const execution = { name: 'bash', callId: 'v1e', arguments: { command: 'git commit -m x' }, agent: fakeAgent(fakeSession(jjRepo)), signal: new AbortController().signal };
  assert.equal(harness.runGuard(execution), undefined, 'no workingDirectory service ⇒ fail-open');
  assert.equal(harness.events.filter((entry) => entry.event === 'jj/guard-degraded').length, 1);
});