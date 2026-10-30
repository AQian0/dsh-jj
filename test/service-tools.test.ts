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
import { assertToolchain, initGit, initJjColocated, initJjNative, makeFixture, mustRun, realpath, type Fixture } from './helpers/fixtures.ts';
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

function fakeExec(agent?: unknown): ExecContext {
  return {
    signal: new AbortController().signal,
    ...(agent !== undefined ? { agent } : {}),
  } as unknown as ExecContext;
}

/** A tool service backed by real operations plus real detection. */
function toolService(fx: Fixture, operations: JjOperations, _extraEnv: Readonly<Record<string, string>> = {}): JjToolService {
  return {
    operations,
    detect: (cwd, signal) => detectVcs(cwd, fx.run, signal),
    describe: () => 'test descriptor',
  };
}

function toolContext(
  fx: Fixture,
  service: JjToolService,
  config = resolveConfig({}),
  workingDirectory?: { ensure(agent: unknown, signal?: AbortSignal): Promise<string>; set?(agent: unknown, path: string, signal?: AbortSignal): Promise<string> },
) {
  return {
    service,
    config,
    host: {
      tools: { register: () => () => {} },
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    },
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
  assert.ok(
    calls.some((argv) => argv.includes('rebase') && argv.includes('-r')),
    'the default rebase mode stays the current `-r` behavior',
  );

  // every recorded call used the jj binary — never git
  assert.ok(calls.length > 10);
  for (const argv of calls) {
    assert.equal(argv[0], 'jj', `unexpected non-jj program: ${argv.join(' ')}`);
  }
  assert.ok(calls.every((argv) => argv.includes('--no-pager') && argv.includes('--color=never')), 'non-interactive flags are always present');
});

test('jj_rebase mode: source moves a whole stack onto the advanced trunk', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-rebase-source');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });

  // Build a two-commit session stack on top of main.
  await mustRun(fx.run, ['jj', 'commit', '-m', 'chore: init'], repo);
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);
  await fx.run(['bash', '-c', 'printf b > b.txt'], { cwd: repo, timeoutMs: 5_000 });
  await mustRun(fx.run, ['jj', 'commit', '-m', 'feat: one'], repo);
  await fx.run(['bash', '-c', 'printf c > c.txt'], { cwd: repo, timeoutMs: 5_000 });
  await mustRun(fx.run, ['jj', 'commit', '-m', 'feat: two'], repo);
  const stack = await operations.log(repo, 'main..@', 10, undefined);
  const first = stack.find((change) => change.description === 'feat: one');
  const second = stack.find((change) => change.description === 'feat: two');
  assert.ok(first !== undefined, 'the stack contains its first change');
  assert.ok(second !== undefined, 'the stack contains its last change');

  // Advance main while the session works (the shared trunk moves).
  await mustRun(fx.run, ['jj', 'new', 'main', '-m', 'feat: advance'], repo);
  await fx.run(['bash', '-c', 'printf d > d.txt'], { cwd: repo, timeoutMs: 5_000 });
  await mustRun(fx.run, ['jj', 'commit', '-m', 'feat: advance'], repo);
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);

  const message = await operations.rebase(repo, first.changeId, 'main', undefined, 'source');
  assert.match(message, /Rebased/);
  // Change ids survive rewrites, so the rebased stack can be inspected and must now
  // sit on top of the advanced trunk: feat two's ancestry contains feat one AND the
  // advance commit. (With `-r` the stack would be split and the advance missing here.)
  const ancestry = await operations.log(repo, `::${second.changeId}`, 20, undefined);
  const descriptions = ancestry.map((change) => change.description).filter((description) => description.length > 0);
  assert.deepEqual(
    descriptions.slice(0, 3),
    ['feat: two', 'feat: one', 'feat: advance'],
    'source mode rebased the whole stack onto the advanced main',
  );
  assert.ok(
    calls.some((argv) => argv.includes('rebase') && argv.includes('-s')),
    'source mode uses `jj rebase -s` instead of `-r`',
  );
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

test('all 17 jj_* tools are defined with contract names, descriptions, and schemas', async (t) => {
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
    'jj_commit',
    'jj_describe',
    'jj_commit_style',
    'jj_squash',
    'jj_undo',
    'jj_op_log',
    'jj_workspace_add',
    'jj_workspace_list',
    'jj_bookmark_list',
    'jj_bookmark_set',
    'jj_rebase',
    'jj_handoff',
    'jj_workspace_cleanup',
  ];
  assert.deepEqual([...byName.keys()], expected);
  const antiConfusion = new Set([
    'jj_status',
    'jj_log',
    'jj_diff',
    'jj_new',
    'jj_commit',
    'jj_describe',
    'jj_commit_style',
    'jj_squash',
    'jj_undo',
    'jj_workspace_add',
    'jj_rebase',
  ]);
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
    jj_commit: { message: 'chore: commit from tool' },
    jj_describe: { message: 'described by tool', revset: '@' },
    jj_commit_style: {},
    jj_squash: { from: '@', into: '@-', useDestinationMessage: true },
    jj_undo: {},
    jj_op_log: { limit: 3 },
    jj_workspace_list: {},
    jj_bookmark_list: { allRemotes: false },
    jj_bookmark_set: { name: 'tool-bookmark', revset: '@' },
    jj_rebase: { revision: '@', destination: '@-', mode: 'source' },
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

  for (const name of ['jj_status', 'jj_log', 'jj_diff', 'jj_op_log', 'jj_workspace_list', 'jj_bookmark_list', 'jj_commit_style']) {
    const definition = definitions.get(name)!;
    await definition.execute(name === 'jj_log' ? { revset: '@', limit: 2 } : {}, fakeExec());
  }
  await definitions.get('jj_bookmark_set')!.execute({ name: 'argv-bookmark', revset: '@' }, fakeExec());
  await definitions.get('jj_new')!.execute({ message: 'argv new' }, fakeExec());
  await definitions.get('jj_commit')!.execute({ message: 'chore: argv commit' }, fakeExec());
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
  assert.equal(registered.length, 17);
  dispose();
  assert.equal(registered.length, 0);
  dispose();
  assert.equal(registered.length, 0, 'disposer is idempotent');
});

test('operation layer: jj commit describes the change, splits paths, and starts a new @', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-ops-commit');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  await fx.run(['bash', '-c', 'printf one > one.txt; printf two > two.txt'], { cwd: repo, timeoutMs: 5_000 });

  // Partial commit: only one.txt lands in the described change; two.txt stays in @.
  const partial = await operations.commit(repo, 'feat: commit one only', ['one.txt']);
  assert.equal(partial.committed.description, 'feat: commit one only');
  assert.equal(partial.committed.currentWorkingCopy, false, 'the committed change is no longer @');
  assert.equal(partial.committed.empty, false);
  assert.deepEqual(partial.warnings, [], 'a successful commit has no warnings');
  assert.equal(partial.workingCopy.currentWorkingCopy, true);
  assert.equal(partial.workingCopy.empty, false, 'the remaining path stays in the new working copy');
  const status = await operations.status(repo);
  assert.deepEqual([...status.changedPaths], ['two.txt']);

  // A pathspec that matches nothing is a zero-exit jj warning: it must be surfaced,
  // and the empty commit must be visible instead of silently passing as a split.
  await fx.run(['bash', '-c', 'printf leftover > leftover.txt'], { cwd: repo, timeoutMs: 5_000 });
  const missed = await operations.commit(repo, 'feat: misses everything', ['missing.txt']);
  assert.equal(missed.committed.empty, true, 'jj created an empty change for the non-matching path');
  assert.ok(missed.warnings.length > 0, 'the jj warning is surfaced');
  assert.match(missed.warnings.join('\n'), /do not match|No changes matched/);
  assert.deepEqual([...missed.workingCopy.paths].sort(), ['leftover.txt', 'two.txt'], 'the real changes stay in the working copy');

  // Full commit: the working copy becomes a fresh empty change.
  const full = await operations.commit(repo, 'chore: finish the change', []);
  assert.equal(full.committed.description, 'chore: finish the change');
  assert.equal(full.workingCopy.empty, true);
  assert.equal(full.workingCopy.currentWorkingCopy, true);
  const committedLog = await operations.log(repo, '@-', 1);
  assert.equal(committedLog[0]?.description, 'chore: finish the change');

  // Description samples carry full descriptions (newest first), not just subjects.
  const samples = await operations.descriptionSamples(repo, '::@', 10);
  assert.ok(samples.some((description) => description.includes('chore: finish the change')));

  // Invalid input is rejected before spawning.
  calls.length = 0;
  await assert.rejects(() => operations.commit(repo, '   ', []), /non-empty description/);
  await assert.rejects(() => operations.commit(repo, 'feat: x', ['-bad']), /must not start/);
  await assert.rejects(() => operations.commit(repo, 'feat: x', ['   ']), /must be non-empty/);
  assert.equal(calls.length, 0);
  for (const argv of calls) assert.equal(argv[0], 'jj');
});

test('jj_commit tool commits the change and reports the fresh working copy', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-tool-commit');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const definitions = definitionsByName(jjToolDefinitions(toolContext(fx, toolService(fx, operations))));
  await fx.run(['bash', '-c', 'printf one > one.txt; printf two > two.txt'], { cwd: repo, timeoutMs: 5_000 });

  const result = (await definitions.get('jj_commit')!.execute({ message: 'feat: tool commit', paths: ['one.txt'] }, fakeExec())) as {
    readonly committed: { readonly description: string; readonly empty: boolean; readonly currentWorkingCopy: boolean };
    readonly workingCopy: { readonly empty: boolean; readonly currentWorkingCopy: boolean };
    readonly committedPaths: readonly string[];
    readonly workingCopyPaths: readonly string[];
    readonly warnings: readonly string[];
  };
  assert.equal(result.committed.description, 'feat: tool commit');
  assert.equal(result.committed.currentWorkingCopy, false);
  assert.equal(result.workingCopy.currentWorkingCopy, true);
  assert.equal(result.workingCopy.empty, false);
  assert.deepEqual([...result.committedPaths], ['one.txt']);
  assert.deepEqual([...result.workingCopyPaths], ['two.txt']);
  assert.deepEqual([...result.warnings], []);
  const status = await operations.status(repo);
  assert.deepEqual([...status.changedPaths], ['two.txt']);

  // Non-matching paths: the tool must expose the warning, not report a clean split.
  const missed = (await definitions.get('jj_commit')!.execute({ message: 'feat: tool miss', paths: ['missing.txt'] }, fakeExec())) as {
    readonly committed: { readonly empty: boolean };
    readonly workingCopyPaths: readonly string[];
    readonly warnings: readonly string[];
  };
  assert.equal(missed.committed.empty, true);
  assert.ok(missed.warnings.length > 0);
  assert.deepEqual([...missed.workingCopyPaths], ['two.txt'], 'the real change remains in the working copy');
});

test('jj_commit_style inherits Conventional history, asks when undecidable, and honours config', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-tool-style');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  fx.cwd = repo;
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const styleTool = (policy = resolveConfig({})) => {
    // Commit policy is owned by the runtime entry (`ctx.jj`), i.e. `operations.config`;
    // the second config passed to toolContext is the tools row and must not fork it.
    const runtimeOperations = new JjOperations({ runJj, config: policy });
    return definitionsByName(jjToolDefinitions(toolContext(fx, toolService(fx, runtimeOperations)))).get('jj_commit_style')!;
  };

  interface StyleResult {
    readonly style: string;
    readonly source: string;
    readonly needsUserChoice: boolean;
    readonly guidance: string;
    readonly confidence: string;
    readonly sampleCount: number;
    readonly examples: readonly string[];
    readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  }

  // Empty history: the tool must not guess — it returns the ask-the-user choices.
  const unknown = (await styleTool().execute({}, fakeExec())) as StyleResult;
  assert.equal(unknown.style, 'auto');
  assert.equal(unknown.source, 'needs-user-choice');
  assert.equal(unknown.needsUserChoice, true);
  assert.equal(unknown.choices.length, 5);
  assert.ok(unknown.choices.some((choice) => choice.id === 'angular'));
  assert.match(unknown.guidance, /ask_user_question/);

  // Three Conventional commits: the tool inherits the repository style.
  for (const message of ['feat(core): add alpha', 'fix(parser): handle beta', 'docs: explain gamma']) {
    await mustRun(fx.run, ['jj', '--no-pager', '--color=never', 'commit', '-m', message], repo);
  }
  const detected = (await styleTool().execute({}, fakeExec())) as StyleResult;
  assert.equal(detected.style, 'conventional');
  assert.equal(detected.source, 'history');
  assert.equal(detected.needsUserChoice, false);
  assert.equal(detected.confidence, 'high');
  assert.ok(detected.sampleCount >= 3);
  assert.match(detected.guidance, /Conventional Commits/);
  assert.ok(detected.examples.includes('feat(core): add alpha'));

  // P3: the limit counts non-empty descriptions, not log entries (the empty @ and
  // the empty root commit must not consume the budget).
  const limited = (await styleTool(resolveConfig({ commitStyleSampleLimit: 3 })).execute({}, fakeExec())) as StyleResult;
  assert.equal(limited.style, 'conventional');
  assert.equal(limited.sampleCount, 3, 'three decent commits are enough even with the empty @ and root');
  assert.equal(limited.needsUserChoice, false);

  // Body/footer habits are observable: examples carry full descriptions, not just subjects.
  await mustRun(
    fx.run,
    ['jj', '--no-pager', '--color=never', 'commit', '-m', 'feat(api): add endpoint\n\nExplain the why in the body.\n\nRefs: #42'],
    repo,
  );
  const withBody = (await styleTool().execute({}, fakeExec())) as StyleResult;
  assert.ok(
    withBody.examples.some((example) => example.includes('Explain the why in the body.') && example.includes('Refs: #42')),
    `full descriptions reach the model: ${JSON.stringify(withBody.examples)}`,
  );

  // A tools-row-only commitStyle must not contradict the runtime policy (single source of truth).
  const toolsRowOnly = definitionsByName(
    jjToolDefinitions(toolContext(fx, toolService(fx, operations), resolveConfig({ commitStyle: 'angular' }))),
  ).get('jj_commit_style')!;
  const runtimeOwnsPolicy = (await toolsRowOnly.execute({}, fakeExec())) as StyleResult;
  assert.equal(runtimeOwnsPolicy.style, 'conventional', 'runtime-row auto still detects history; tools-row config is ignored');
  assert.equal(runtimeOwnsPolicy.source, 'history');

  // The sampling bound comes from the tools row (`config.maxLogLimit`), and a
  // tools-row commitStyleSampleLimit is inert like the style itself.
  const toolsRowLimit = definitionsByName(
    jjToolDefinitions(toolContext(fx, toolService(fx, operations), resolveConfig({ commitStyleSampleLimit: 1 }))),
  ).get('jj_commit_style')!;
  const ignoredLimit = (await toolsRowLimit.execute({}, fakeExec())) as StyleResult;
  assert.ok(ignoredLimit.sampleCount > 1, 'tools-row sample limit is ignored; the runtime policy applies');

  // A configured preset wins over history.
  const angular = (await styleTool(resolveConfig({ commitStyle: 'angular' })).execute({}, fakeExec())) as StyleResult;
  assert.equal(angular.style, 'angular');
  assert.equal(angular.source, 'config');
  assert.equal(angular.needsUserChoice, false);
  assert.match(angular.guidance, /Angular commit convention/);

  // A configured custom style supplies the rules verbatim.
  const rules = 'lowercase Chinese subject, no prefix, body optional';
  const custom = (await styleTool(resolveConfig({ commitStyle: 'custom', commitStyleCustom: rules })).execute({}, fakeExec())) as StyleResult;
  assert.equal(custom.style, 'custom');
  assert.equal(custom.source, 'config');
  assert.ok(custom.guidance.includes(rules));

  // Style sampling must stay jj-only as well.
  assert.ok(calls.length > 0);
  for (const argv of calls) assert.equal(argv[0], 'jj', `unexpected non-jj program: ${argv.join(' ')}`);
});

test('descriptionSamples keeps complete records when the bounded output is truncated', async () => {
  // A large full-description sample can trip maxOutputBytes; the partial tail must
  // be dropped instead of failing the whole style probe.
  const operations = new JjOperations({
    runJj: async () => ({
      exitCode: 0,
      signal: null,
      stdout: '"feat: first description"\n"feat: second description with a long body',
      stderr: '',
      truncated: true,
      killedByTimeout: false,
    }),
  });
  const samples = await operations.descriptionSamples('/anywhere', '::@', 5);
  assert.deepEqual([...samples], ['feat: first description']);
});

test('TPL_STATUS is the contract template and parses into a change', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-template');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const result = await mustRun(fx.run, ['jj', '--no-pager', '--color=never', 'log', '-r', '@', '--no-graph', '-T', TPL_STATUS], repo);
  assert.match(result.stdout, /"change_id":/);
  assert.match(result.stdout, /"paths":/);
  assert.match(result.stdout, /\n$/, 'the template ends every record with a newline');
});

// ---------------------------------------------------------------------------
// End-of-work hand-off (jj_handoff) and session-owned workspace cleanup.
// ---------------------------------------------------------------------------

/** Commit the current working copy, leaving a fresh empty @ on top. */
async function commitWorkingCopy(fx: Fixture, cwd: string, message: string): Promise<void> {
  await mustRun(fx.run, ['jj', '--no-pager', '--color=never', 'commit', '-m', message], cwd);
}

/** Write one small file with the same real shell the other tests use. */
async function writeFixtureFile(fx: Fixture, cwd: string, name: string, content: string): Promise<void> {
  const result = await fx.run(['bash', '-c', `printf '%s\\n' '${content}' > '${name}'`], { cwd, timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0, `could not write fixture file ${name}: ${result.stderr}`);
}

/**
 * The multi-session shape: `main` is a base commit and a linked workspace works
 * on a session stack starting from it. Operations and their recorded argv are
 * returned so the tests can prove the hand-off is jj-only and uses source mode.
 */
async function makeHandoffFixture(t: Parameters<typeof makeFixture>[0], label: string) {
  const fx = makeFixture(t, label);
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  await writeFixtureFile(fx, repo, 'f.txt', 'base');
  await commitWorkingCopy(fx, repo, 'chore: base');
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);
  const ws = join(fx.root, 'ws-session');
  await mustRun(fx.run, ['jj', 'workspace', 'add', ws, '--name', 'session', '-r', 'main'], repo);
  const { runJj, calls } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  return { fx, repo, ws, operations, calls };
}

test('operation layer: jj_handoff resolves a local-only target, rebases the stack, and moves a bookmark', async (t) => {
  const { fx, ws, operations, calls } = await makeHandoffFixture(t, 'dsh-jj-handoff-local');
  await writeFixtureFile(fx, ws, 'one.txt', 'one');
  await commitWorkingCopy(fx, ws, 'feat: one');
  await writeFixtureFile(fx, ws, 'two.txt', 'two');
  await commitWorkingCopy(fx, ws, 'feat: two');
  const sessionStack = (await operations.log(ws, 'main..@', 10)).filter((change) => change.description.length > 0);
  const firstSessionChange = sessionStack.at(-1);
  assert.ok(firstSessionChange !== undefined);

  // Advance main while the session works (the shared trunk moves).
  await mustRun(fx.run, ['jj', 'new', 'main', '-m', 'chore: advance'], fx.path('repo'));
  await writeFixtureFile(fx, fx.path('repo'), 'adv.txt', 'advance');
  await commitWorkingCopy(fx, fx.path('repo'), 'chore: advance');
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], fx.path('repo'));

  const result = await operations.handoff(ws, { bookmark: 'feature' });
  assert.equal(result.fetch.status, 'no-remote', 'a repository without remotes is not an error');
  assert.equal(result.destination, 'main', 'trunk() resolves to root, so local main is the fallback');
  assert.equal(result.destinationSource, 'main');
  assert.equal(result.rebased, true);
  assert.equal(result.onTarget, true);
  assert.deepEqual([...result.conflicts], []);
  assert.equal(result.firstChangeId, firstSessionChange.changeId);
  assert.equal(result.bookmark?.name, 'feature');
  assert.equal(result.bookmark?.moved, false, 'the bookmark did not exist yet: it is created, not moved');
  const tip = result.stack.find((change) => change.description === 'feat: two');
  assert.ok(tip !== undefined);
  assert.equal(result.bookmark?.target, tip.commitId, 'the bookmark points at the rebased stack tip');

  const ancestry = (await operations.log(ws, '::@-', 10)).filter((change) => change.description.length > 0);
  assert.deepEqual(
    ancestry.slice(0, 3).map((change) => change.description),
    ['feat: two', 'feat: one', 'chore: advance'],
    'the whole stack moved onto the advanced main',
  );
  assert.ok(calls.some((argv) => argv.includes('rebase') && argv.includes('-s')), 'a stack is moved with source mode');
  for (const argv of calls) assert.equal(argv[0], 'jj', `the hand-off never spawns ${argv[0]}`);
});

test('operation layer: jj_handoff reports an already-integrated stack without rebasing', async (t) => {
  const { fx, ws, operations, calls } = await makeHandoffFixture(t, 'dsh-jj-handoff-integrated');
  await writeFixtureFile(fx, ws, 'one.txt', 'one');
  await commitWorkingCopy(fx, ws, 'feat: one');

  const result = await operations.handoff(ws);
  assert.equal(result.alreadyIntegrated, true);
  assert.equal(result.rebased, false);
  assert.equal(result.onTarget, true);
  assert.equal(result.destinationSource, 'main');
  assert.equal(result.conflicts.length, 0);
  assert.ok(result.firstChangeId.length > 0);
  assert.match(result.message, /already/);
  assert.ok(!calls.some((argv) => argv.includes('rebase')), 'no rebase is spawned when the stack already sits on the target');
});

test('operation layer: jj_handoff asks for a commit instead of folding uncommitted changes into the rebase', async (t) => {
  const { fx, ws, operations } = await makeHandoffFixture(t, 'dsh-jj-handoff-dirty');
  await writeFixtureFile(fx, ws, 'dirty.txt', 'dirty');

  const result = await operations.handoff(ws);
  assert.equal(result.needsCommit, true);
  assert.equal(result.rebased, false);
  assert.match(result.message, /Commit them first with jj_commit/);
  assert.equal(result.stack.length, 1, 'the working-copy change is reported back to the model');
});

test('operation layer: jj_handoff surfaces conflicts as data instead of stopping the session', async (t) => {
  const { fx, repo, ws, operations } = await makeHandoffFixture(t, 'dsh-jj-handoff-conflict');
  await writeFixtureFile(fx, ws, 'f.txt', 'session edit');
  await commitWorkingCopy(fx, ws, 'feat: session edit');
  const sessionChange = (await operations.log(ws, 'main..@', 5)).find((change) => change.description === 'feat: session edit');
  assert.ok(sessionChange !== undefined);

  await mustRun(fx.run, ['jj', 'new', 'main', '-m', 'chore: main edit'], repo);
  await writeFixtureFile(fx, repo, 'f.txt', 'main edit');
  await commitWorkingCopy(fx, repo, 'chore: main edit');
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);

  const result = await operations.handoff(ws, { bookmark: 'feature' });
  assert.equal(result.rebased, true);
  assert.equal(result.onTarget, true);
  assert.ok(result.conflicts.length > 0, 'the conflict is reported as data for the model to resolve');
  assert.ok(
    result.conflicts.some((conflict) => conflict.changeId === sessionChange.changeId),
    'the conflicted session change is named',
  );
  assert.equal(result.bookmark, undefined);
  assert.match(result.bookmarkSkipped ?? '', /conflicts/);
});

test('handoff target resolution: explicit, automatic fallback, and the ask-the-user-only case', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-handoff-target');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });

  // No remote, no bookmark: only then is asking the user for a target legitimate.
  await assert.rejects(
    () => operations.resolveHandoffTarget(repo, { configured: 'trunk()' }),
    /Ask the user which revision/,
  );
  // An explicit destination that does not resolve is an actionable error.
  await assert.rejects(
    () => operations.resolveHandoffTarget(repo, { destination: 'no-such-rev', configured: 'trunk()' }),
    /does not resolve in this repository/,
  );
  // Local main is the automatic fallback once it exists; an explicit one wins.
  await writeFixtureFile(fx, repo, 'f.txt', 'base');
  await commitWorkingCopy(fx, repo, 'chore: base');
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);
  const automatic = await operations.resolveHandoffTarget(repo, { configured: 'trunk()' });
  assert.equal(automatic.revset, 'main');
  assert.equal(automatic.source, 'main');
  const explicit = await operations.resolveHandoffTarget(repo, { destination: 'main', configured: 'trunk()' });
  assert.equal(explicit.source, 'argument');
});

test('jj_rebase rejects the empty-root trunk() destination with an actionable message', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-rebase-trunk');
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  await assert.rejects(() => operations.rebase(repo, '@', 'trunk()'), /empty root commit/);
  await assert.rejects(() => operations.rebase(repo, '@', 'trunk()'), /jj_handoff/);
});

test('jj_handoff tool: runs the whole hand-off and reports model next steps', async (t) => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
  const { fx, repo, ws, operations } = await makeHandoffFixture(t, 'dsh-jj-tool-handoff');
  await writeFixtureFile(fx, ws, 'one.txt', 'one');
  await commitWorkingCopy(fx, ws, 'feat: one');
  // The shared main advances while the session works, so the hand-off really rebases.
  await mustRun(fx.run, ['jj', 'new', 'main', '-m', 'chore: advance'], repo);
  await writeFixtureFile(fx, repo, 'adv.txt', 'advance');
  await commitWorkingCopy(fx, repo, 'chore: advance');
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);
  const handoff = definitionsByName(jjToolDefinitions(toolContext(fx, toolService(fx, operations)))).get('jj_handoff')!;

  fx.cwd = ws;
  const value = (await handoff.execute({ bookmark: 'feature' }, fakeExec())) as Record<string, unknown>;
  assert.deepEqual(validateJsonSchemaValue(handoff.output.schema, value), [], `output: ${JSON.stringify(value)}`);
  assert.equal(value['workspaceName'], 'session');
  assert.equal(value['destinationSource'], 'main');
  assert.equal(value['rebased'], true);
  assert.match(String(value['nextSteps']), /Report the rebased change ids/);
  assert.match(String(value['nextSteps']), /user action/, 'cleanup of a workspace not created through jj_workspace_add stays with the user');

  // The default workspace requires the explicit stack bottom: never rebase foreign history.
  fx.cwd = repo;
  await assert.rejects(() => handoff.execute({}, fakeExec()), /needs `firstChange`/);
  await mustRun(fx.run, ['jj', 'new', 'main', '-m', 'feat: own change'], repo);
  await writeFixtureFile(fx, repo, 'own.txt', 'own');
  await commitWorkingCopy(fx, repo, 'feat: own change');
  const own = (await operations.log(repo, 'main..@', 5)).find((change) => change.description === 'feat: own change');
  assert.ok(own !== undefined);
  const defaultValue = (await handoff.execute({ firstChange: own.changeId }, fakeExec())) as Record<string, unknown>;
  assert.equal(defaultValue['alreadyIntegrated'], true);
  assert.equal(defaultValue['workspaceName'], 'default');
});

test('jj_workspace_cleanup tool: unregisters only a session-created workspace and returns to the default workspace', async (t) => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
  const fx = makeFixture(t, 'dsh-jj-tool-cleanup');
  await assertToolchain(fx.run, fx.root);
  const repo = await initJjColocated(fx.run, fx.path('repo'));
  await writeFixtureFile(fx, repo, 'f.txt', 'base');
  await commitWorkingCopy(fx, repo, 'chore: base');
  await mustRun(fx.run, ['jj', 'bookmark', 'set', 'main', '-r', '@-'], repo);
  const { runJj } = recordingRunner(fx);
  const operations = new JjOperations({ runJj, config: {} });
  const moved: string[] = [];
  const workingDirectory = {
    ensure: async () => (fx.cwd as string),
    set: async (_agent: unknown, path: string) => {
      moved.push(path);
      return path;
    },
  };
  const definitions = definitionsByName(
    jjToolDefinitions(toolContext(fx, toolService(fx, operations), resolveConfig({}), workingDirectory)),
  );
  const agent = { id: 'cleanup-agent' };
  const otherAgent = { id: 'other-cleanup-agent' };
  const cleanup = definitions.get('jj_workspace_cleanup')!;
  fx.cwd = repo;

  // A workspace this session created is moved out of and unregistered.
  const wsPath = join(fx.root, 'ws-clean');
  const created = (await definitions.get('jj_workspace_add')!.execute({ path: wsPath, name: 'clean-me' }, fakeExec(agent))) as {
    readonly name: string;
  };
  assert.equal(created.name, 'clean-me');
  fx.cwd = wsPath;
  const value = (await cleanup.execute({}, fakeExec(agent))) as Record<string, unknown>;
  assert.deepEqual(validateJsonSchemaValue(cleanup.output.schema, value), [], `output: ${JSON.stringify(value)}`);
  assert.equal(value['forgotten'], true);
  assert.equal(value['currentWorkspace'], 'default');
  assert.equal(value['currentWorkspaceRoot'], realpath(repo));
  assert.deepEqual(moved, [realpath(repo)], 'the session is moved back to the default workspace before forgetting');
  const remaining = await operations.workspaceList(repo);
  assert.ok(!remaining.some((workspace) => workspace.name === 'clean-me'), 'the workspace is unregistered');

  // The default workspace is never forgotten.
  fx.cwd = repo;
  await assert.rejects(() => cleanup.execute({}, fakeExec(agent)), /default workspace/);

  // A workspace the user created (or another session created) is refused.
  const foreign = join(fx.root, 'ws-foreign');
  await mustRun(fx.run, ['jj', 'workspace', 'add', foreign, '--name', 'foreign'], repo);
  fx.cwd = foreign;
  await assert.rejects(() => cleanup.execute({}, fakeExec(agent)), /not created through jj_workspace_add/);

  // Uncommitted work blocks cleanup so nothing is silently unregistered.
  fx.cwd = repo;
  const dirtyPath = join(fx.root, 'ws-dirty');
  await definitions.get('jj_workspace_add')!.execute({ path: dirtyPath, name: 'dirty-ws' }, fakeExec(agent));
  fx.cwd = dirtyPath;
  await writeFixtureFile(fx, dirtyPath, 'dirty.txt', 'dirty');
  await assert.rejects(() => cleanup.execute({}, fakeExec(agent)), /uncommitted changes/);

  // Ownership is per session: another agent cannot clean this session's workspace.
  fx.cwd = repo;
  const otherPath = join(fx.root, 'ws-othered');
  await definitions.get('jj_workspace_add')!.execute({ path: otherPath, name: 'other-ws' }, fakeExec(agent));
  fx.cwd = otherPath;
  await assert.rejects(() => cleanup.execute({}, fakeExec(otherAgent)), /not created through jj_workspace_add/);
});