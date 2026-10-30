/**
 * V2/V4 regression (task-11).
 *
 * V2: `jj_squash` without `-m`/`--use-destination-message` used to launch a jj
 * editor (undiagnosable failure or a hang in a headless tool call). The fix adds
 * `--use-destination-message` for the default case **and** shields every jj call
 * with `JJ_EDITOR=true`.
 *
 * V4: probe argv used to carry `--no-pager --color=never` twice (once from the
 * runner, once from detect's global args).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from '../src/config.ts';
import { detectVcs } from '../src/detect.ts';
import { createCommandRunJj, jjNonInteractiveEnv } from '../src/jj-command.ts';
import { JjOperations } from '../src/service.ts';
import { jjToolDefinitions } from '../src/tools.ts';
import type { RunCommand } from '../src/types.ts';
import { assertToolchain, initJjColocated, makeFixture, mustRun, type Fixture } from './helpers/fixtures.ts';

/** The recorder-editor files installed for one fixture root. */
interface RecorderEditor {
  readonly recorder: string;
  readonly calls: string;
  readonly called: () => number;
}

/** Canonical `jj_squash` value as this suite inspects it. */
interface SquashValue {
  readonly changeId: unknown;
}

/** A recorder "editor": if jj ever launches it, it writes a line to calls.txt. */
function installRecorderEditor(root: string): RecorderEditor {
  const recorder = join(root, 'editor-recorder.sh');
  const calls = join(root, 'editor-calls.txt');
  writeFileSync(recorder, `#!/bin/sh\necho "EDITOR-CALLED $@" >> ${calls}\nexit 0\n`);
  chmodSync(recorder, 0o755);
  return {
    recorder,
    calls,
    called: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0),
  };
}

/** Prepare a change with content on top of a described parent so squash has work to do. */
async function prepareSquashableRepo(fx: Fixture, repo: string): Promise<void> {
  await mustRun(fx.run, ['jj', 'describe', '-r', '@', '-m', 'first'], repo);
  writeFileSync(join(repo, 'file.txt'), 'one\n');
  await mustRun(fx.run, ['jj', 'new', '-m', 'second'], repo);
  writeFileSync(join(repo, 'file.txt'), 'one\ntwo\n');
  await mustRun(fx.run, ['jj', 'status'], repo);
}

/** Fetch one `jj_*` tool definition; a missing definition fails the test loudly. */
function toolDefinition(definitions: ReadonlyMap<string, ToolDefinition>, name: string): ToolDefinition {
  const definition = definitions.get(name);
  assert.ok(definition !== undefined, `missing tool definition: ${name}`);
  return definition;
}

/** Minimal execution context: the tool bodies read only `exec.signal`. */
function toolRunContext(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext;
}

test('V2 §5.9: the non-interactive environment shields every editor and prompt hook', () => {
  const env = jjNonInteractiveEnv();
  for (const key of ['JJ_EDITOR', 'GIT_EDITOR', 'EDITOR', 'VISUAL']) {
    assert.equal(env[key], '/bin/false', `${key} must point at an immediately failing command`);
  }
  assert.equal(
    env.JJ_EDITOR === 'false',
    false,
    'the CLI --config ui.editor=false is rejected by jj 0.46; env is the supported shield',
  );
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.SSH_ASKPASS, '');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.NO_COLOR, '1');
});

test('V2: `jj_squash` with no message never launches an editor (operation layer)', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v2-ops');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  await prepareSquashableRepo(fx, repo);
  const editor = installRecorderEditor(fx.root);

  const calls: string[][] = [];
  const runJj = createCommandRunJj(async (argv, options) => {
    calls.push([...argv]);
    // The recorder wins over the shield, so a jj editor launch would be visible.
    return await fx.run(argv, { ...options, env: { ...options.env, JJ_EDITOR: editor.recorder } });
  }, resolveConfig({}));
  const operations = new JjOperations({ runJj, config: {} });

  // §7.3.6: with neither message path the operation refuses before spawning jj.
  await assert.rejects(
    () => operations.squash(repo, '@', '@-', undefined, false, undefined),
    /jj_squash needs a message path/,
  );
  assert.equal(calls.filter((argv) => argv.includes('squash')).length, 0, 'no jj squash process was spawned');
  assert.equal(editor.called(), 0, 'jj must not launch any editor');

  // The explicit message paths still work and never edit.
  const change = await operations.squash(repo, '@', '@-', undefined, true, undefined);
  assert.equal(typeof change.changeId, 'string');
  assert.equal(editor.called(), 0, 'jj must not launch any editor');
  const squashCall = calls.find((argv) => argv.includes('squash'));
  assert.ok(
    squashCall?.includes('--use-destination-message'),
    `explicit useDestinationMessage must reach jj: ${squashCall?.join(' ')}`,
  );

  // Control: prove the recorder really is reachable as jj's editor. `jj describe`
  // without `-m` always edits, so a jj-initiated editor launch would be recorded.
  await mustRun(fx.run, ['jj', '--config', `ui.editor=${editor.recorder}`, 'describe'], repo);
  assert.equal(editor.called() > 0, true, 'the recorder editor is reachable when jj decides to edit');
});

test('V2: the `jj_squash` tool path also never launches an editor', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v2-tool');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  await prepareSquashableRepo(fx, repo);
  const editor = installRecorderEditor(fx.root);
  const calls: string[][] = [];
  const runJj = createCommandRunJj(async (argv, options) => {
    calls.push([...argv]);
    return await fx.run(argv, { ...options, env: { ...options.env, JJ_EDITOR: editor.recorder } });
  }, resolveConfig({}));
  const operations = new JjOperations({ runJj, config: {} });
  const definitions = new Map(
    jjToolDefinitions({
      service: { operations, detect: async () => await detectVcs(repo, fx.run) },
      config: resolveConfig({}),
      host: { tools: { register: () => () => {} } },
      cwdFor: async () => repo,
    }).map((definition) => [definition.name, definition] as const),
  );
  await assert.rejects(
    () => toolDefinition(definitions, 'jj_squash').execute({}, toolRunContext()),
    /jj_squash needs a message path/,
  );
  assert.equal(calls.filter((argv) => argv.includes('squash')).length, 0, 'no jj squash process was spawned');
  assert.equal(editor.called(), 0, 'the tool path must not launch an editor either');

  const value = (await toolDefinition(definitions, 'jj_squash').execute(
    { useDestinationMessage: true },
    toolRunContext(),
  )) as SquashValue;
  assert.equal(typeof value.changeId, 'string');
  assert.equal(editor.called(), 0);
  assert.ok(calls.some((argv) => argv.includes('--use-destination-message')));
});

test('V4: probe argv carries each non-interactive flag exactly once', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-v4');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const calls: string[][] = [];
  // `detectVcs(cwd, run)` takes the task-4 RunCommand form (argv includes the program);
  // the runner prepends the non-interactive flags exactly once.
  const run: RunCommand = async (argv, options) => {
    calls.push([...argv]);
    return await fx.run(argv, options);
  };
  const descriptor = await detectVcs(repo, run);
  assert.equal(descriptor.kind, 'jj-colocated');
  assert.ok(calls.length >= 2, 'the jj authority probe ran');
  const jjCalls = calls.filter((argv) => argv[0] === 'jj');
  assert.ok(jjCalls.length >= 2, `expected jj probes, saw ${jjCalls.length}`);
  assert.ok(
    calls.some((argv) => argv[0] === 'git'),
    'the read-only git probe is still allowed',
  );
  for (const argv of jjCalls) {
    assert.equal(argv.filter((token) => token === '--no-pager').length, 1, `duplicate --no-pager: ${argv.join(' ')}`);
    assert.equal(
      argv.filter((token) => token === '--color=never').length,
      1,
      `duplicate --color=never: ${argv.join(' ')}`,
    );
    // `--version` needs no repository, so it carries no --ignore-working-copy.
    const expectedIgnore = argv.includes('--version') ? 0 : 1;
    assert.equal(
      argv.filter((token) => token === '--ignore-working-copy').length,
      expectedIgnore,
      `missing/duplicate --ignore-working-copy: ${argv.join(' ')}`,
    );
  }
  const workspaceList = jjCalls.find((argv) => argv.includes('workspace'));
  assert.ok(workspaceList !== undefined);
  assert.deepEqual(workspaceList.slice(1, 5), ['--no-pager', '--color=never', '--ignore-working-copy', 'workspace']);
});
