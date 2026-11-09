/**
 * Capability-matrix coverage: every jj subcommand the guard classifies has a declared
 * owner, and every tool the matrix names actually exists.
 *
 * The point of the matrix is to make "who owns this verb" a decision recorded in code:
 * adding a jj subcommand to the guard's scope tables without deciding whether a tool,
 * the shell, or a hard-deny owns it must fail here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JJ_CAPABILITY_MATRIX, JJ_KNOWN_SUBCOMMANDS, capabilityToolNames } from '../src/capabilities.ts';
import { resolveConfig } from '../src/config.ts';
import { jjToolDefinitions } from '../src/tool-definitions.ts';

/** Tool names the definitions expose, without executing anything. */
function registeredToolNames(): string[] {
  const definitions = jjToolDefinitions({
    service: {
      operations: {} as never,
      detect: async () => {
        throw new Error('not used');
      },
    },
    config: resolveConfig({}),
    host: { tools: { register: () => () => {} } },
    cwdFor: async () => process.cwd(),
  });
  return definitions.map((definition) => definition.name).sort();
}

test('every guard-known jj subcommand has a declared capability', () => {
  const missing = JJ_KNOWN_SUBCOMMANDS.filter((subcommand) => !(subcommand in JJ_CAPABILITY_MATRIX));
  assert.deepEqual(missing, [], 'a guard scope-table entry without a capability decision is a bug');
});

test('the matrix declares nothing the guard cannot classify', () => {
  const known = new Set(JJ_KNOWN_SUBCOMMANDS);
  // Two-word file verbs are classified by the guard's generic `file` handling but are
  // not in the scope tables; they are documented here so the intent is explicit.
  // `workspace remove` is hard-denied by a dedicated guard rule rather than a scope
  // table, and the two-word file verbs fall under the guard's generic `file` handling.
  const documentedExtras = new Set(['file track', 'file untrack', 'workspace remove']);
  const unknown = Object.keys(JJ_CAPABILITY_MATRIX).filter(
    (subcommand) => !known.has(subcommand) && !documentedExtras.has(subcommand),
  );
  assert.deepEqual(unknown, [], 'matrix keys must be guard-known subcommands');
});

test('every tool entry names a registered jj_* tool', () => {
  const tools = new Set(registeredToolNames());
  for (const [subcommand, capability] of Object.entries(JJ_CAPABILITY_MATRIX)) {
    if (capability.kind !== 'tool') continue;
    assert.ok(tools.has(capability.tool), `${subcommand} names ${capability.tool}, which is not registered`);
    assert.match(capability.tool, /^jj_/, 'tool capabilities must name a jj_* tool');
  }
});

test('the matrix covers the tool set that owns one-verb actions', () => {
  const owned = new Set(capabilityToolNames());
  // Composite tools are intentionally absent: jj_handoff orchestrates several verbs,
  // jj_commit_style samples history, and jj_workspace_cleanup performs an ownership-checked
  // `workspace forget` that the matrix records as blocked for the shell.
  for (const tool of [
    'jj_status',
    'jj_log',
    'jj_diff',
    'jj_new',
    'jj_commit',
    'jj_describe',
    'jj_squash',
    'jj_rebase',
    'jj_abandon',
    'jj_undo',
    'jj_op_restore',
    'jj_op_log',
    'jj_fetch',
    'jj_bookmark_list',
    'jj_bookmark_set',
    'jj_workspace_add',
    'jj_workspace_list',
  ]) {
    assert.ok(owned.has(tool), `${tool} must be reachable from a matrix entry`);
  }
});

test('blocked entries say why the shell must not run them', () => {
  for (const [subcommand, capability] of Object.entries(JJ_CAPABILITY_MATRIX)) {
    if (capability.kind !== 'blocked') continue;
    assert.ok(capability.note.length > 20, `${subcommand} needs an explanation a maintainer can use`);
  }
});
