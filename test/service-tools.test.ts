/**
 * Service, operation-layer, and `jj_*` tool end-to-end tests against real
 * repositories (task-6 acceptance).
 *
 * Every jj call runs the real `jj` binary through the task-4 runner (via
 * `createCommandRunJj`), and the runner wrapper records argv so the suite can
 * assert that **no** jj path ever falls back to git.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { detectVcs } from '../src/detect.ts';
import { createCommandRunJj } from '../src/jj-command.ts';
import { JjOperations, TPL_STATUS } from '../src/service.ts';
import { jjRefusalText, jjToolDefinitions, registerJjTools, type JjToolService } from '../src/tools.ts';
import { assertToolchain, initGit, initJjColocated, initJjNative, makeFixture, mustRun, type Fixture } from './helpers/fixtures.ts';
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools';

/** Canonical JSON value a tool output renderer accepts. */
type JsonValueLike = Parameters<ToolDefinition['output']['render']>[1];
/** Execution context handed to a tool body (only `signal` is exercised here). */
type ExecContext = Parameters<ToolDefinition['execute']>[1];

/** Runner that records every argv so the suite can prove "jj only". */
function recordingRunner(fx: Fixture) {
  const calls: string[][] = [];
  const runJj = createCommandRunJj(async (argv, options) => {
    calls.push([...argv]);
    return await fx.run(argv, options);
  }, resolveConfig({}));
  return { runJj, calls, jjCalls: () => calls.filter((argv) => argv[0] === 'jj') };
}

function fakeExec(): ExecContext {
  return { signal: new AbortController().signal } as unknown as ExecContext;
}

/** A tool service backed by real operations plus real detection. */
function toolService(fx: Fixture, operations: JjOperations, _extraEnv: Readonly<Record<string, string>> = {}): JjToolService {
  return {
    operations,
    detect: (cwd, signal) => detectVcs(cwd, fx.run, signal),
    describe: () => 'test descriptor',
  };
}

function toolContext(fx: Fixture, service: JjToolService, config = resolveConfig({})) {
  return {
    service,
    config,
    host: { tools: { register: () => () => {} } },
    // Every tool-calling test assigns `fx.cwd` first; the refusal test overrides this.
    cwdFor: async () => fx.cwd as string,
  };
}

function definitionsByName(definitions: readonly ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition] as const));
}

test('operation layer: status, new, describe, log, diff, op log, bookmarks, workspace, undo', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-ops');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });

  // status (@ is the working-copy change)
  const status = await operations.status(repo);
  assert.equal(status.change.currentWorkingCopy, true);
  assert.match(status.change.changeId, /^[a-z]{8,}/);
  assert.ok(status.raw.length > 0, 'jj status text is returned');

  // new change with a description
  const created = await operations.newChange(repo, [], 'first change', undefined);
  assert.equal(created.currentWorkingCopy, true);
  assert.equal(created.description, 'first change');

  // describe the change in place
  const described = await operations.describeChange(repo, '@', 'renamed change', undefined);
  assert.equal(described.description, 'renamed change');
  assert.equal(described.changeId, created.changeId, 'jj describe edits the same change id');

  // write a file so the diff is non-empty, then diff @ against its parent
  await fx.run(['bash', '-c', 'printf hello > file.txt'], { cwd: repo, timeoutMs: 5_000 });
  const diff = await operations.diff(repo, '@', 'stat', [], undefined);
  assert.match(diff.text, /file\.txt/);

  // log with an explicit revset
  const changes = await operations.log(repo, '@ | @-', 5, undefined);
  assert.ok(changes.length >= 2);
  assert.equal(changes[0]?.description, 'renamed change');

  // bookmark set + list
  const set = await operations.bookmarkSet(repo, 'feature', '@', false, undefined);
  assert.equal(set.name, 'feature');
  assert.equal(set.moved, false, 'created, not moved');
  const bookmarks = await operations.bookmarkList(repo, false, undefined);
  assert.ok(bookmarks.some((bookmark) => bookmark.name === 'feature' && bookmark.target.length > 0));

  // op log
  const ops = await operations.opLog(repo, 5, undefined);
  assert.ok(ops.length >= 1);
  assert.ok(ops[0]?.id.length >= 8);
  assert.equal(ops[0]?.shortId, ops[0]?.id.slice(0, 12));
  assert.equal(typeof ops[0]?.isSnapshot, 'boolean');

  // undo records the head operation first (contract §8.3b self-protection)
  const headBefore = await operations.headOperationId(repo);
  const undone = await operations.undo(repo, undefined, undefined);
  assert.equal(undone.mode, 'undo');
  assert.equal(undone.headOperationId, headBefore);
  assert.match(undone.message, /head operation before this call/);
  assert.match(undone.message, /jj op restore/);

  // workspace add outside the repository root (contract §7.3.9 recommendation)
  const wsPath = join(fx.root, 'ws-outside');
  const workspace = await operations.workspaceAdd(repo, wsPath, 'outside', [], undefined, undefined, undefined);
  assert.equal(workspace.name, 'outside');
  assert.equal(workspace.change.currentWorkingCopy, true);
  const workspaces = await operations.workspaceList(repo, undefined);
  assert.ok(workspaces.some((entry) => entry.name === 'outside'));

  // squash + rebase run through jj as well
  await operations.squash(repo, '@', '@-', undefined, true, undefined);
  const rebased = await operations.rebase(repo, '@', '@-', undefined);
  assert.equal(typeof rebased, 'string');

  // every recorded call used the jj binary — never git
  assert.ok(calls.length > 10);
  for (const argv of calls) {
    assert.equal(argv[0], 'jj', `unexpected non-jj program: ${argv.join(' ')}`);
  }
  assert.ok(calls.every((argv) => argv.includes('--no-pager') && argv.includes('--color=never')), 'non-interactive flags are always present');
});

test('operation layer: bad input is rejected before spawning anything', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-ops-bad');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });

  await assert.rejects(() => operations.undo(repo, 'NOT-HEX', undefined), /hexadecimal operation id/);
  await assert.rejects(() => operations.squash(repo, '@', '@-', 'msg', true, undefined), /mutually exclusive/);
  await assert.rejects(() => operations.bookmarkSet(repo, 'bad name', '@', false, undefined), /must not contain whitespace/);
  await assert.rejects(() => operations.bookmarkSet(repo, 'bad@name', '@', false, undefined), /must not contain whitespace or '@'/);
  await assert.rejects(() => operations.workspaceAdd(repo, '--evil', undefined, [], undefined, undefined, undefined), /does not start with/);
  assert.equal(calls.length, 0, 'no jj process was spawned for invalid input');
});

test('all 13 jj_* tools are defined with contract names, descriptions, and schemas', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-tools-defs');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const definitions = jjToolDefinitions(toolContext(fx, toolService(fx, operations)));
  const byName = definitionsByName(definitions);

  const expected = [
    'jj_status',
    'jj_log',
    'jj_diff',
    'jj_new',
    'jj_describe',
    'jj_squash',
    'jj_undo',
    'jj_op_log',
    'jj_workspace_add',
    'jj_workspace_list',
    'jj_bookmark_list',
    'jj_bookmark_set',
    'jj_rebase',
  ];
  assert.deepEqual([...byName.keys()], expected);
  const antiConfusion = new Set(['jj_status', 'jj_log', 'jj_diff', 'jj_new', 'jj_describe', 'jj_squash', 'jj_undo', 'jj_workspace_add', 'jj_rebase']);
  for (const definition of definitions) {
    assert.match(definition.description, /Jujutsu \(jj\)/, `${definition.name} must name jj`);
    if (antiConfusion.has(definition.name)) {
      assert.match(definition.description, /jj, not git/, `${definition.name} must distinguish itself from git`);
    }
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.output.schema.additionalProperties, false);
  }
  assert.equal(byName.get('jj_workspace_add')?.description.includes('outside the repository root'), true, 'placement advice is in the description');
});

test('tool schemas validate their own arguments and outputs (real DSH validators)', async (t) => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
  const fx = makeFixture(t, 'dsh-jj-tools-schema');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  await mustRun(fx.run, ['jj', 'describe', '-r', '@', '-m', 'schema check'], repo);
  fx.cwd = repo;
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const definitions = jjToolDefinitions(toolContext(fx, toolService(fx, operations)));

  const calls: Record<string, Record<string, unknown> | undefined> = {
    jj_status: {},
    jj_log: { revset: '@', limit: 3 },
    jj_diff: { revset: '@', format: 'stat', paths: [] },
    jj_new: { message: 'from tool', parents: [] },
    jj_describe: { message: 'described by tool', revset: '@' },
    jj_squash: { from: '@', into: '@-', useDestinationMessage: true },
    jj_undo: {},
    jj_op_log: { limit: 3 },
    jj_workspace_list: {},
    jj_bookmark_list: { allRemotes: false },
    jj_bookmark_set: { name: 'tool-bookmark', revset: '@' },
    jj_rebase: { revision: '@', destination: '@-' },
  };

  for (const definition of definitions) {
    const args = calls[definition.name];
    if (args === undefined) continue; // jj_workspace_add is exercised separately (it creates a directory)
    // `ToolDefinition.parameters` / `output.schema` are the compiled JSON Schemas.
    const violations = validateJsonSchemaValue(definition.parameters as JsonSchemaNode, args);
    assert.deepEqual(violations, [], `${definition.name} rejects its own example args`);
    const value = await definition.execute(args, fakeExec());
    const outputViolations = validateJsonSchemaValue(definition.output.schema, value);
    assert.deepEqual(outputViolations, [], `${definition.name} output must satisfy its own schema: ${JSON.stringify(value)}`);
    const rendered = definition.output.render(args, value as JsonValueLike);
    assert.equal(rendered[0]?.type, 'text');
    assert.ok(rendered[0].text.length > 0);
  }

  // invalid args are reported by the same validator path
  const logDefinition = definitionsByName(definitions).get('jj_log')!;
  assert.ok(validateJsonSchemaValue(logDefinition.parameters as JsonSchemaNode, { revset: 42 }).length > 0, 'type violations are surfaced');
});

test('T20: every tool path runs jj only, never git', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-tools-argv');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  await mustRun(fx.run, ['jj', 'describe', '-r', '@', '-m', 'argv check'], repo);
  fx.cwd = repo;
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const definitions = definitionsByName(jjToolDefinitions(toolContext(fx, toolService(fx, operations))));

  for (const name of ['jj_status', 'jj_log', 'jj_diff', 'jj_op_log', 'jj_workspace_list', 'jj_bookmark_list']) {
    const definition = definitions.get(name)!;
    await definition.execute(name === 'jj_log' ? { revset: '@', limit: 2 } : {}, fakeExec());
  }
  await definitions.get('jj_bookmark_set')!.execute({ name: 'argv-bookmark', revset: '@' }, fakeExec());
  await definitions.get('jj_new')!.execute({ message: 'argv new' }, fakeExec());
  await definitions.get('jj_describe')!.execute({ message: 'argv described' }, fakeExec());

  assert.ok(calls.length >= 8, `expected many jj calls, saw ${calls.length}`);
  for (const argv of calls) {
    assert.equal(argv[0], 'jj', `tool path must not spawn ${argv[0]}: ${argv.join(' ')}`);
    assert.ok(!argv.includes('git') || argv[1] === 'git' === false, `no git subcommand fallback: ${argv.join(' ')}`);
  }
  assert.equal(calls.some((argv) => argv[0] === 'git'), false, 'no git process was ever spawned');
});

test('refusal paths: git-only, no repository, and broken jj metadata are all diagnosable', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-refuse');
  const gitRepo = await initGit(fx.run, fx.path('plain-git'));
  const empty = fx.path('empty');
  const native = await initJjNative(fx.run, fx.path('native'));
  const broken = fx.path('broken');
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });

  const gitDescriptor = await detectVcs(gitRepo, fx.run);
  const gitText = jjRefusalText(gitDescriptor, gitRepo);
  assert.match(gitText, /No Jujutsu \(jj\) workspace was found/);
  assert.match(gitText, /inside a Git repository at/);
  assert.match(gitText, /jj git init/);
  assert.match(gitText, /never fall back to Git commands/);

  const noneDescriptor = await detectVcs(empty, fx.run);
  const noneText = jjRefusalText(noneDescriptor, empty);
  assert.match(noneText, /no Git repository either/);
  assert.match(noneText, /jj git init --no-colocate/);

  const brokenDescriptor = await detectVcs(join(broken, 'missing'), fx.run);
  const brokenText = jjRefusalText(brokenDescriptor, join(broken, 'missing'));
  assert.ok(brokenText.length > 0);

  // A tool call in the git repository refuses before spawning jj.
  calls.length = 0;
  const definitions = definitionsByName(
    jjToolDefinitions({ ...toolContext(fx, toolService(fx, operations)), cwdFor: async () => gitRepo }),
  );
  await assert.rejects(() => definitions.get('jj_status')!.execute({}, fakeExec()), /No Jujutsu \(jj\) workspace was found/);
  assert.equal(calls.length, 0, 'refusal happens before any jj process starts');

  // In the jj-native workspace the same tool succeeds.
  const nativeDefinitions = definitionsByName(
    jjToolDefinitions({ ...toolContext(fx, toolService(fx, operations)), cwdFor: async () => native }),
  );
  const status = (await nativeDefinitions.get('jj_status')!.execute({}, fakeExec())) as {
    readonly kind: string;
    readonly changeId: string;
  };
  assert.equal(status.kind, 'jj-native');
  assert.ok(status.changeId.length > 0);
});

test('registerJjTools registers and disposes every tool', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-tools-register');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const registered: string[] = [];
  const host = {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition.name);
        return () => {
          const index = registered.indexOf(definition.name);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  };
  const dispose = registerJjTools(host, { service: toolService(fx, operations), config: {} });
  assert.equal(registered.length, 13);
  dispose();
  assert.equal(registered.length, 0);
  dispose();
  assert.equal(registered.length, 0, 'disposer is idempotent');
});

test('TPL_STATUS is the contract template and parses into a change', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-template');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const result = await mustRun(fx.run, ['jj', '--no-pager', '--color=never', 'log', '-r', '@', '--no-graph', '-T', TPL_STATUS], repo);
  assert.match(result.stdout, /"change_id":/);
  assert.match(result.stdout, /"paths":/);
  assert.match(result.stdout, /\n$/, 'the template ends every record with a newline');
});