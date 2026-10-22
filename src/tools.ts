/**
 * The `jj_*` model tools (design contract §7).
 *
 * Every tool is jj-native: it names "Jujutsu (jj)" in its first sentence, states
 * that it is *not* git, and never falls back to Git commands. Outside a usable jj
 * workspace the tools refuse with the §7.4 templates (git repository / no
 * repository / broken metadata / jj not installed) instead of failing silently.
 *
 * @module dsh-jj/tools
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { Config, resolveConfig, type JjPluginConfig, type ResolvedJjConfig } from './config.ts';
import type { JjOperations } from './service.ts';
import type { VcsDescriptor, VcsKind } from './types.ts';

export { Config };

/** Structural view of the service the tools need (a live `JjService` satisfies it). */
export interface JjToolService {
  readonly operations: JjOperations;
  detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
  describe(target: VcsDescriptor | VcsKind): string;
}

/** Structural view of the host context used by the tools entry. */
export interface JjToolsHost {
  readonly tools: { register(definition: ToolDefinition): () => void };
  readonly workingDirectory?: { ensure(agent: unknown, signal?: AbortSignal): Promise<string> };
}

/** Refusal text for a directory that is not a usable jj workspace (contract §7.4). */
export function jjRefusalText(descriptor: VcsDescriptor, cwd: string, jjCommand = 'jj'): string {
  if (!descriptor.jjAvailable && descriptor.jjRoot !== undefined) {
    return [
      `dsh-jj could not run the jj executable (${jjCommand}): ${descriptor.notices.map((entry) => entry.detail).join('; ') || 'not found'}`,
      `Install Jujutsu (https://jj-vcs.dev) or point the dsh-jj \`jjCommand\` setting at the binary. dsh-jj never substitutes Git for jj.`,
    ].join('\n');
  }
  if (descriptor.jjRoot !== undefined && descriptor.kind === 'none') {
    return [
      `Jujutsu (jj) metadata was found at ${descriptor.jjRoot}, but jj cannot use the repository:`,
      descriptor.notices.map((entry) => `${entry.code}: ${entry.detail}`).join('\n') || 'no further detail',
      '',
      `dsh-jj will not fall back to Git. Inspect the repository with \`jj --ignore-working-copy workspace list\` in ${descriptor.jjRoot}, or repair/re-create it (\`jj git init --no-colocate\` in an empty directory).`,
    ].join('\n');
  }
  if (descriptor.kind === 'git') {
    const root = descriptor.gitRoot ?? descriptor.root;
    return [
      `No Jujutsu (jj) workspace was found for ${cwd}. This directory is inside a Git repository at ${root}.`,
      '',
      'dsh-jj tools operate on Jujutsu repositories only and never fall back to Git commands.',
      '',
      'Options:',
      '- Use the Git tools for this repository (it is a plain Git repository, not a jj one).',
      `- To adopt jj without leaving Git: run \`jj git init\` in ${root}. That keeps the existing .git and adds .jj beside it (colocated); both toolchains then work in the same working copy.`,
      '- To create a separate jj-native repository: `jj git init --no-colocate <dir>` (no root .git), or clone with `jj git clone <url> <dir>`.',
    ].join('\n');
  }
  return [
    `No Jujutsu (jj) workspace was found for ${cwd}, and no Git repository either.`,
    '',
    'dsh-jj tools operate on Jujutsu repositories only.',
    '',
    'Options:',
    '- Create a repository here: `jj git init` (creates a colocated .jj + .git), or `jj git init --no-colocate` (jj only).',
    '- Adopt an existing Git checkout: run `jj git init` from its root.',
    descriptor.notices.map((entry) => `${entry.code}: ${entry.message ?? entry.detail}`).join('\n'),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function textRender(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

const CHANGE_PROPERTIES = {
  changeId: { type: 'string', description: 'jj change id (stable across rewrites).', required: true },
  commitId: { type: 'string', description: 'Commit id of this change right now.', required: true },
  description: { type: 'string', description: 'Change description (may be empty).', required: true },
  empty: { type: 'boolean', description: 'True when the change has no content changes.', required: true },
  conflict: { type: 'boolean', description: 'True when the change contains conflicts (jj tracks them as first-class).', required: true },
  currentWorkingCopy: { type: 'boolean', description: 'True for the working-copy change @.', required: true },
  bookmarks: { type: 'array', description: 'Local bookmarks pointing at this change.', items: { type: 'string' }, required: true },
  author: { type: 'string', description: 'Author email.', required: true },
} as const;

const CHANGE_SCHEMA = { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES } as const;

interface ToolContext {
  readonly service: JjToolService;
  readonly config: ResolvedJjConfig;
  readonly host: JjToolsHost;
  readonly cwdFor: (exec: { agent?: unknown; signal?: AbortSignal }) => Promise<string>;
}

async function requireWorkspace(context: ToolContext, cwd: string, signal?: AbortSignal): Promise<VcsDescriptor> {
  const descriptor = await context.service.detect(cwd, signal);
  if (descriptor.kind === 'jj-colocated' || descriptor.kind === 'jj-native') return descriptor;
  throw new Error(jjRefusalText(descriptor, cwd, context.config.jjCommand));
}

function workspaceFields(descriptor: VcsDescriptor): { kind: 'jj-colocated' | 'jj-native'; workspaceRoot: string; workspaceName: string } {
  return {
    kind: descriptor.kind === 'jj-colocated' ? 'jj-colocated' : 'jj-native',
    workspaceRoot: descriptor.root,
    workspaceName: descriptor.workspaceName ?? 'default',
  };
}

/**
 * Build every `jj_*` tool definition (contract §7.3).
 *
 * @param context - service access, resolved config, host, and the cwd resolver.
 * @returns the 13 tool definitions in a stable order.
 */
export function jjToolDefinitions(context: ToolContext): ToolDefinition[] {
  const { service, config } = context;
  const operations = service.operations;

  return [
    defineTool({
      name: 'jj_status',
      description:
        'Report Jujutsu (jj) working-copy state. This is jj, not git: there is no staging area, and the working copy is already a commit (@) that jj snapshots automatically. Returns the current change id, commit id, description, bookmarks, changed paths, and diff stat.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['jj-colocated', 'jj-native'], required: true },
            workspaceRoot: { type: 'string', required: true },
            workspaceName: { type: 'string', required: true },
            changeId: { type: 'string', required: true },
            commitId: { type: 'string', required: true },
            description: { type: 'string', required: true },
            empty: { type: 'boolean', required: true },
            conflict: { type: 'boolean', required: true },
            bookmarks: { type: 'array', items: { type: 'string' }, required: true },
            changedPaths: { type: 'array', items: { type: 'string' }, required: true },
            diffStat: { type: 'string', required: true },
            statusText: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(_args, exec) {
        const cwd = await context.cwdFor(exec);
        const descriptor = await requireWorkspace(context, cwd, exec.signal);
        const status = await operations.status(cwd, exec.signal);
        return {
          ...workspaceFields(descriptor),
          changeId: status.change.changeId,
          commitId: status.change.commitId,
          description: status.change.description,
          empty: status.change.empty,
          conflict: status.change.conflict,
          bookmarks: [...status.change.bookmarks],
          changedPaths: [...status.changedPaths],
          diffStat: status.diffStat,
          statusText: status.truncated ? `[truncated]\n${status.raw}` : status.raw,
        };
      },
    }),

    defineTool({
      name: 'jj_log',
      description:
        'Show Jujutsu (jj) revisions selected by a revset. This is jj, not git: revisions are selected with jj revsets such as @, @-, ::@, bookmarks(), or description("…"), not with git branch or range syntax. Anonymous changes without any bookmark are normal and are still returned.',
      parameters: {
        revset: { type: 'string', description: "jj revset selecting the revisions to show. Defaults to '@ | @-'." },
        limit: { type: 'integer', description: `Maximum entries to return; 1…${config.maxLogLimit}, default ${config.defaultLogLimit}.` },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revset: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            changes: { type: 'array', items: CHANGE_SCHEMA, required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const revset = args.revset ?? '@ | @-';
        const requested = args.limit ?? config.defaultLogLimit;
        const limit = Math.max(1, Math.min(requested, config.maxLogLimit));
        const changes = await operations.log(cwd, revset, limit, exec.signal);
        return {
          revset,
          truncated: changes.length >= limit,
          changes: changes.map((change) => ({
            changeId: change.changeId,
            commitId: change.commitId,
            description: change.description,
            empty: change.empty,
            conflict: change.conflict,
            currentWorkingCopy: change.currentWorkingCopy,
            bookmarks: [...change.bookmarks],
            author: change.author,
          })),
        };
      },
    }),

    defineTool({
      name: 'jj_diff',
      description:
        'Show a Jujutsu (jj) diff. Diffs are computed between a revision and its parents; this is jj, not git — there is no index and no stash, so reviewing the working copy means diffing @ against @-.',
      parameters: {
        revset: { type: 'string', description: "jj revset to diff; defaults to '@'." },
        format: { type: 'string', enum: ['stat', 'patch'], description: 'stat gives per-file counts; patch gives a unified diff.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional repository-relative paths to restrict the diff; passed to jj as literal paths.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revset: { type: 'string', required: true },
            format: { type: 'string', enum: ['stat', 'patch'], required: true },
            paths: { type: 'array', items: { type: 'string' }, required: true },
            text: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const revset = args.revset ?? '@';
        const format = args.format ?? 'stat';
        const paths = args.paths ?? [];
        const result = await operations.diff(cwd, revset, format, paths, exec.signal);
        return {
          revset,
          format,
          paths: [...paths],
          text: result.truncated ? `[output truncated to ${config.maxOutputBytes} bytes]\n${result.text}` : result.text,
          truncated: result.truncated,
        };
      },
    }),

    defineTool({
      name: 'jj_new',
      description:
        'Create a new Jujutsu (jj) change on top of the given parents and make it the working copy (@). This is jj, not git: the previous change keeps its identity and is not re-created, and no commit step is needed — the new change is already real.',
      parameters: {
        message: { type: 'string', description: 'Description for the new change. Omit to leave it undescribed; jj allows an undescribed working-copy change.' },
        parents: { type: 'array', items: { type: 'string' }, description: 'Revsets to use as parents. Omit to start on top of the current @ (jj moves the working copy).' },
      },
      output: { schema: CHANGE_SCHEMA, render: (_args, value) => textRender(value) },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const change = await operations.newChange(cwd, args.parents ?? [], args.message, exec.signal);
        return changeView(change);
      },
    }),

    defineTool({
      name: 'jj_describe',
      description:
        'Set the description (message) of a Jujutsu (jj) revision. This is jj, not git: there is no separate commit step, so this edits the change in place instead of amending or committing; descendants are rebased automatically when metadata changes.',
      parameters: {
        message: { type: 'string', description: 'New description. An empty string clears the description.', required: true },
        revset: { type: 'string', description: "jj revset of the change to describe; defaults to '@'." },
      },
      output: { schema: CHANGE_SCHEMA, render: (_args, value) => textRender(value) },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const change = await operations.describeChange(cwd, args.revset ?? '@', args.message, exec.signal);
        return changeView(change);
      },
    }),

    defineTool({
      name: 'jj_squash',
      description:
        'Move changes from one Jujutsu (jj) revision into another; by default from @ into @-. This is jj, not git: it replaces git commit --amend and interactive staging, and descendants are rebased automatically.',
      parameters: {
        from: { type: 'string', description: "jj revset to move changes out of; defaults to '@'." },
        into: { type: 'string', description: "jj revset to move changes into; defaults to '@-'." },
        message: { type: 'string', description: 'New description for the destination change. Mutually exclusive with useDestinationMessage.' },
        useDestinationMessage: { type: 'boolean', description: "Keep the destination change's existing description." },
      },
      output: { schema: CHANGE_SCHEMA, render: (_args, value) => textRender(value) },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const change = await operations.squash(
          cwd,
          args.from ?? '@',
          args.into ?? '@-',
          args.message,
          args.useDestinationMessage ?? false,
          exec.signal,
        );
        return changeView(change);
      },
    }),

    defineTool({
      name: 'jj_undo',
      description:
        'Undo a Jujutsu (jj) operation, or restore the repository to any earlier operation. This is jj, not git: every repository mutation is recorded in the operation log, so undo is a graph-level restore that is itself undoable, not a git reset. Note that jj operations are repository-wide: undoing rewrites the whole working copy of this workspace.',
      parameters: {
        operationId: { type: 'string', description: 'Operation id (or unique hexadecimal prefix) from jj_op_log. Omit to undo the most recent operation.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: ['undo', 'restore'], required: true },
            operationId: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const result = await operations.undo(cwd, args.operationId, exec.signal);
        return { mode: result.mode, operationId: result.operationId, message: result.message };
      },
    }),

    defineTool({
      name: 'jj_op_log',
      description:
        'Show the Jujutsu (jj) operation log — the recorded history of repository mutations, including automatic working-copy snapshots. Use it to find an operation id for jj_undo.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum operations to return; 1…100, default 20.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operations: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  shortId: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  time: { type: 'string', required: true },
                  user: { type: 'string', required: true },
                  workspaceName: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  isSnapshot: { type: 'boolean', required: true },
                  tags: { type: 'array', items: { type: 'string' }, required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
        const all = await operations.opLog(cwd, limit, exec.signal);
        return {
          operations: all.map((operation) => ({
            id: operation.id,
            shortId: operation.shortId,
            description: operation.description,
            time: operation.time,
            user: operation.user,
            workspaceName: operation.workspaceName,
            isSnapshot: operation.isSnapshot,
            tags: [...operation.tags],
          })),
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_add',
      description:
        'Create an additional Jujutsu (jj) workspace — a second working copy of the same repository — at a path, and start a new change in it. This is jj, not git: the workspace is registered in jj and visible to jj_workspace_list, unlike a raw git worktree. Prefer a path outside the repository root (a path inside it leaves a phantom entry in git-side snapshots), and use an absolute path to place the workspace outside the repository.',
      parameters: {
        path: { type: 'string', description: 'Directory for the new workspace; relative paths resolve against the current working directory, absolute paths are supported and are the way to place it outside the repository. jj creates it if missing.', required: true },
        name: { type: 'string', description: 'Workspace name. Defaults to the basename of path; names must be unique.' },
        parents: { type: 'array', items: { type: 'string' }, description: "Revsets the new workspace's change starts on; omit to share the current change's parents." },
        message: { type: 'string', description: 'Description for the new workspace working-copy change.' },
        colocate: { type: 'boolean', description: "Also create a matching Git worktree for the new workspace. Defaults to the repository's own colocation setting." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            name: { type: 'string', required: true },
            changeId: { type: 'string', required: true },
            commitId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const result = await operations.workspaceAdd(cwd, args.path, args.name, args.parents ?? [], args.message, args.colocate, exec.signal);
        return { path: result.path, name: result.name, changeId: result.change.changeId, commitId: result.change.commitId };
      },
    }),

    defineTool({
      name: 'jj_workspace_list',
      description: 'List the Jujutsu (jj) workspaces of this repository. Each workspace is a separate working copy with its own current change (@).',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspaces: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  root: { type: 'string', required: true },
                  isCurrent: { type: 'boolean', required: true },
                },
              },
            },
            currentWorkspace: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(_args, exec) {
        const cwd = await context.cwdFor(exec);
        const descriptor = await requireWorkspace(context, cwd, exec.signal);
        const workspaces = await operations.workspaceList(cwd, exec.signal);
        return {
          workspaces: workspaces.map((workspace) => ({
            name: workspace.name,
            root: workspace.root,
            isCurrent: workspace.name === (descriptor.workspaceName ?? 'default'),
          })),
          currentWorkspace: descriptor.workspaceName ?? 'default',
        };
      },
    }),

    defineTool({
      name: 'jj_bookmark_list',
      description:
        "List Jujutsu (jj) bookmarks. Bookmarks are jj's optional named pointers: unlike git branches they are not required to create or keep changes, so most changes may have no bookmark at all.",
      parameters: {
        allRemotes: { type: 'boolean', description: 'Also include remote-tracking entries (name@remote).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bookmarks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  target: { type: 'string', required: true },
                  remote: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const bookmarks = await operations.bookmarkList(cwd, args.allRemotes ?? false, exec.signal);
        return { bookmarks: bookmarks.map((bookmark) => ({ name: bookmark.name, target: bookmark.target, remote: bookmark.remote })) };
      },
    }),

    defineTool({
      name: 'jj_bookmark_set',
      description:
        'Create or move a Jujutsu (jj) bookmark to a revision. jj refuses backward or sideways moves unless explicitly allowed, because that usually means the wrong revision was selected.',
      parameters: {
        name: { type: 'string', description: "Bookmark name; must not contain whitespace or '@'.", required: true },
        revset: { type: 'string', description: "jj revset the bookmark should point at; defaults to '@'." },
        allowBackwards: { type: 'boolean', description: 'Permit moving the bookmark to an ancestor or unrelated revision.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            target: { type: 'string', required: true },
            moved: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const result = await operations.bookmarkSet(cwd, args.name, args.revset ?? '@', args.allowBackwards ?? false, exec.signal);
        return result;
      },
    }),

    defineTool({
      name: 'jj_rebase',
      description:
        'Rebase a Jujutsu (jj) revision and its descendants onto another revision. This is jj, not git: descendants move automatically, so there is no branch replay and no merge step.',
      parameters: {
        revision: { type: 'string', description: 'jj revset of the revision(s) to move.', required: true },
        destination: { type: 'string', description: 'jj revset of the destination revision.', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'string', required: true },
            destination: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const message = await operations.rebase(cwd, args.revision, args.destination, exec.signal);
        return { revision: args.revision, destination: args.destination, message };
      },
    }),
  ];
}

interface ChangeView {
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly currentWorkingCopy: boolean;
  readonly bookmarks: string[];
  readonly author: string;
}

function changeView(change: {
  changeId: string;
  commitId: string;
  description: string;
  empty: boolean;
  conflict: boolean;
  currentWorkingCopy: boolean;
  bookmarks: readonly string[];
  author: string;
}): ChangeView {
  return {
    changeId: change.changeId,
    commitId: change.commitId,
    description: change.description,
    empty: change.empty,
    conflict: change.conflict,
    currentWorkingCopy: change.currentWorkingCopy,
    bookmarks: [...change.bookmarks],
    author: change.author,
  };
}

/**
 * Register every `jj_*` tool.
 *
 * @param host - context providing `tools` (and optionally `workingDirectory`).
 * @param options - service plus partial plugin config.
 * @returns one disposer that unregisters every tool.
 */
export function registerJjTools(
  host: JjToolsHost,
  options: { service: JjToolService; config?: JjPluginConfig },
): () => void {
  const config = resolveConfig(options.config ?? {});
  const cwdFor = async (exec: { agent?: unknown; signal?: AbortSignal }): Promise<string> => {
    if (exec.agent !== undefined && host.workingDirectory !== undefined) {
      try {
        return await host.workingDirectory.ensure(exec.agent, exec.signal);
      } catch {
        // Fall through to the configured default.
      }
    }
    return config.defaultCwd.length > 0 ? config.defaultCwd : process.cwd();
  };
  const disposers = jjToolDefinitions({ service: options.service, config, host, cwdFor }).map((definition) =>
    host.tools.register(definition),
  );
  return () => {
    for (const disposer of disposers) {
      try {
        disposer();
      } catch {
        // Unregistration must not throw during teardown.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin entry (`dsh-jj/tools`, contract §4.1b)
// ---------------------------------------------------------------------------

/** Cordis plugin name for the tools entry. */
export const name = 'jj-tools';

/**
 * Services required by the tools entry (`jj` is the service from the runtime entry).
 *
 * `workingDirectory` is REQUIRED here, not optional: `cwdFor` resolves the directory
 * a jj command runs in, and a fallback to `process.cwd()` would silently run jj in the
 * wrong repository. (Reading an uninjected service property throws in Cordis, so an
 * "optional" read of `ctx.workingDirectory` is not available to this entry either —
 * found by real end-to-end testing 2026-10-22, where `jj_status` failed with
 * `cannot get property "workingDirectory" without inject`.)
 */
export const inject = ['tools', 'jj', 'workingDirectory'] as const;

/**
 * Install the tools entry on a Cordis context.
 *
 * @param ctx - context providing `tools`, the `jj` service, and `workingDirectory`.
 * @param config - partial plugin configuration.
 */
export function apply(ctx: Context, config: JjPluginConfig = {}): void {
  const service = (ctx as unknown as { jj: JjToolService }).jj;
  const disposer = registerJjTools(ctx as unknown as JjToolsHost, { service, config });
  const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
  if (typeof effect === 'function') effect.call(ctx, () => () => disposer(), 'dsh-jj: jj tools');
}