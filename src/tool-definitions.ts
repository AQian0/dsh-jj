/**
 * The 17 `jj_*` tool definitions (design contract §7.3).
 *
 * Every tool is jj-native: it names "Jujutsu (jj)" in its first sentence, states
 * that it is *not* git, and never falls back to Git commands. Outside a usable jj
 * workspace the tools refuse with the shared §7.4 templates instead of failing
 * silently. Schemas and views live in `tool-schemas.ts`, refusal/next-step text
 * and the tool context type in `tool-shared.ts`.
 *
 * @module dsh-jj/tool-definitions
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  COMMIT_STYLE_CHOICES,
  COMMIT_STYLE_IDS,
  CONCRETE_COMMIT_STYLE_IDS,
  detectCommitStyle,
  resolveCommitStylePolicy,
} from './commit-style.ts';
import { CHANGE_PROPERTIES, CHANGE_SCHEMA, changeView, textRender, workspaceFields } from './tool-schemas.ts';
import {
  canonicalWorkspacePath,
  handoffNextSteps,
  isRootWorkspace,
  requireWorkspace,
  type ToolContext,
} from './tool-shared.ts';

/**
 * Build every `jj_*` tool definition (contract §7.3).
 *
 * @param context - service access, resolved config, host, and the cwd resolver.
 * @returns the 17 tool definitions in a stable order.
 */
export function jjToolDefinitions(context: ToolContext): ToolDefinition[] {
  const { service, config } = context;
  const operations = service.operations;
  /**
   * Workspaces this session created through `jj_workspace_add`, keyed by the live
   * agent. Ownership is the safety invariant behind `jj_workspace_cleanup`: only a
   * workspace this exact session registered may be unregistered by the plugin, so a
   * session can never forget another session's (or the user's) working copy.
   */
  const sessionWorkspaces = new WeakMap<object, { name: string; root: string }[]>();
  const rememberOwnedWorkspace = (agent: unknown, name: string, root: string): void => {
    if (typeof agent !== 'object' || agent === null) return;
    const owned = sessionWorkspaces.get(agent) ?? [];
    const canonicalRoot = canonicalWorkspacePath(root);
    if (!owned.some((entry) => entry.name === name && entry.root === canonicalRoot))
      owned.push({ name, root: canonicalRoot });
    sessionWorkspaces.set(agent, owned);
  };
  const ownsWorkspace = (agent: unknown, name: string, root: string): boolean => {
    if (typeof agent !== 'object' || agent === null) return false;
    const canonicalRoot = canonicalWorkspacePath(root);
    return (sessionWorkspaces.get(agent) ?? []).some((entry) => entry.name === name && entry.root === canonicalRoot);
  };
  // Commit-description policy is owned by the runtime entry (`ctx.jj`) so the
  // session prompt and jj_commit_style cannot disagree; the tools row only carries
  // tool-specific tuning (limits, default cwd, …).
  const commitConfig = operations.config;

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
        limit: {
          type: 'integer',
          description: `Maximum entries to return; 1…${config.maxLogLimit}, default ${config.defaultLogLimit}.`,
        },
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
        format: {
          type: 'string',
          enum: ['stat', 'patch'],
          description: 'stat gives per-file counts; patch gives a unified diff.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional repository-relative paths to restrict the diff; passed to jj as literal paths.',
        },
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
        'Create a new Jujutsu (jj) change on top of the given parents and make it the working copy (@). This is jj, not git: the previous change keeps its identity and is not re-created, and no commit step is needed — the new change is already real. To finish the current change with a description and start the next one in a single step, use jj_commit. Prefer a series of small changes over one growing working copy.',
      parameters: {
        message: {
          type: 'string',
          description:
            'Description for the new change. Omit to leave it undescribed; jj allows an undescribed working-copy change.',
        },
        parents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Revsets to use as parents. Omit to start on top of the current @ (jj moves the working copy).',
        },
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
      name: 'jj_commit',
      description:
        'Commit the current Jujutsu (jj) working-copy change with a description and start a new change on top. This is jj, not git: jj commit is jj describe plus jj new, so the described change stays in history and a new working-copy change is created (empty unless paths leave changes behind); there is no staging area. Prefer it after each coherent step to keep the change stack reviewable for humans, and pass paths to commit only part of the working copy when splitting work. Follow the repository description style — jj_commit_style reports it.',
      parameters: {
        message: {
          type: 'string',
          description:
            "Description for the change being committed; follow the repository's commit style (call jj_commit_style first when unsure).",
          required: true,
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional repository-relative paths to commit only those changes; the remaining changes stay in the new working-copy change.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            committed: { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES, required: true },
            workingCopy: { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES, required: true },
            committedPaths: { type: 'array', items: { type: 'string' }, required: true },
            workingCopyPaths: { type: 'array', items: { type: 'string' }, required: true },
            warnings: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const result = await operations.commit(cwd, args.message, args.paths ?? [], exec.signal);
        return {
          committed: changeView(result.committed),
          workingCopy: changeView(result.workingCopy),
          committedPaths: [...result.committed.paths],
          workingCopyPaths: [...result.workingCopy.paths],
          warnings: [...result.warnings],
        };
      },
    }),

    defineTool({
      name: 'jj_describe',
      description:
        'Set the description (message) of a Jujutsu (jj) revision. This is jj, not git: there is no separate commit step, so this edits the change in place instead of amending or committing; descendants are rebased automatically when metadata changes. Follow the repository description style — jj_commit_style reports it. To finish the current change and start a new one in a single step, prefer jj_commit.',
      parameters: {
        message: {
          type: 'string',
          description: 'New description. An empty string clears the description.',
          required: true,
        },
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
      name: 'jj_commit_style',
      description:
        "Report the commit-description style used by this Jujutsu (jj) repository's recent descriptions, or the style configured for dsh-jj. This is jj, not git: it samples descriptions reachable from the working copy with jj log and classifies them as Conventional Commits/Angular, Gitmoji, plain subjects, mixed, or unknown. Call it before writing a description when the style is unclear; when needsUserChoice is true, ask the user to choose a style (the choices are returned) before committing.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            style: { type: 'string', enum: [...COMMIT_STYLE_IDS], required: true },
            source: {
              type: 'string',
              enum: ['config', 'history', 'needs-user-choice', 'pending-history'],
              required: true,
            },
            needsUserChoice: { type: 'boolean', required: true },
            guidance: { type: 'string', required: true },
            detectionStyle: {
              type: 'string',
              enum: ['conventional', 'gitmoji', 'plain', 'mixed', 'unknown'],
              required: true,
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'], required: true },
            sampleCount: { type: 'integer', required: true },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                conventional: { type: 'integer', required: true },
                gitmoji: { type: 'integer', required: true },
                plain: { type: 'integer', required: true },
              },
            },
            reason: { type: 'string', required: true },
            choices: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', enum: [...CONCRETE_COMMIT_STYLE_IDS, 'custom'], required: true },
                  label: { type: 'string', required: true },
                  summary: { type: 'string', required: true },
                },
              },
            },
            examples: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(_args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const sampleLimit = Math.max(1, Math.min(commitConfig.commitStyleSampleLimit, config.maxLogLimit));
        // `@` and the root commit are usually empty, so read a few extra log entries
        // to collect `sampleLimit` non-empty descriptions; the tools row's maxLogLimit
        // (which also bounds jj_log) still caps this extra process output.
        const readLimit = Math.min(sampleLimit + 5, Math.max(sampleLimit, config.maxLogLimit));
        const fetched = await operations.descriptionSamples(cwd, '::@', readLimit, exec.signal);
        const descriptions = fetched
          .map((description) => description.trim())
          .filter((description) => description.length > 0)
          .slice(0, sampleLimit);
        const detection = detectCommitStyle(descriptions);
        const policy = resolveCommitStylePolicy({
          configured: commitConfig.commitStyle,
          customStyle: commitConfig.commitStyleCustom,
          detection,
        });
        return {
          style: policy.style,
          source: policy.source,
          needsUserChoice: policy.needsUserChoice,
          guidance: policy.guidance,
          detectionStyle: detection.style,
          confidence: detection.confidence,
          sampleCount: detection.sampleCount,
          counts: {
            conventional: detection.counts.conventional,
            gitmoji: detection.counts.gitmoji,
            plain: detection.counts.plain,
          },
          reason: detection.reason,
          choices: COMMIT_STYLE_CHOICES.map((choice) => ({
            id: choice.id,
            label: choice.label,
            summary: choice.summary,
          })),
          // Full examples (bounded) so the model can copy subject, body, and footer habits.
          examples: descriptions
            .slice(0, 8)
            .map((description) => (description.length > 600 ? `${description.slice(0, 600)}…` : description)),
        };
      },
    }),

    defineTool({
      name: 'jj_squash',
      description:
        'Move changes from one Jujutsu (jj) revision into another; by default from @ into @-. This is jj, not git: it replaces git commit --amend and interactive staging, and descendants are rebased automatically.',
      parameters: {
        from: { type: 'string', description: "jj revset to move changes out of; defaults to '@'." },
        into: { type: 'string', description: "jj revset to move changes into; defaults to '@-'." },
        message: {
          type: 'string',
          description: 'New description for the destination change. Mutually exclusive with useDestinationMessage.',
        },
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
        operationId: {
          type: 'string',
          description:
            'Operation id (or unique hexadecimal prefix) from jj_op_log. Omit to undo the most recent operation.',
        },
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
        'Show the Jujutsu (jj) operation log — the recorded history of repository mutations, including automatic working-copy snapshots. This is jj, not git: the operation log is not a git reflog and captures every jj mutation, so use it to find an operation id for jj_undo.',
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
        'Create an additional Jujutsu (jj) workspace — a second working copy of the same repository — at a path, and start a new change in it. This is jj, not git: the workspace is registered in jj and visible to jj_workspace_list, unlike a raw git worktree. Prefer an absolute path outside the repository root (a path inside it leaves a phantom entry in git-side snapshots). Without `parents` the new workspace starts from the parents of the current change; pass `parents: ["@"]` to carry the current change (and its checkout) into the new workspace when migrating mid-task.',
      parameters: {
        path: {
          type: 'string',
          description:
            'Directory for the new workspace; relative paths resolve against the current working directory, absolute paths are supported and are the way to place it outside the repository. jj creates it if missing.',
          required: true,
        },
        name: {
          type: 'string',
          description: 'Workspace name. Defaults to the basename of path; names must be unique.',
        },
        parents: {
          type: 'array',
          items: { type: 'string' },
          description: "Revsets the new workspace's change starts on; omit to share the current change's parents.",
        },
        message: { type: 'string', description: 'Description for the new workspace working-copy change.' },
        colocate: {
          type: 'boolean',
          description:
            "Also create a matching Git worktree for the new workspace. Defaults to the repository's own colocation setting.",
        },
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
        const result = await operations.workspaceAdd(
          cwd,
          args.path,
          args.name,
          args.parents ?? [],
          args.message,
          args.colocate,
          exec.signal,
        );
        rememberOwnedWorkspace(exec.agent, result.name, result.path);
        return {
          path: result.path,
          name: result.name,
          changeId: result.change.changeId,
          commitId: result.change.commitId,
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_list',
      description:
        'List the Jujutsu (jj) workspaces of this repository. This is jj, not git: each workspace is a separate jj working copy with its own current change (@), registered with jj — not a git worktree.',
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
        "List Jujutsu (jj) bookmarks. This is jj, not git: bookmarks are jj's optional named pointers, not git branches — they are not required to create or keep changes, so most changes may have no bookmark at all.",
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
        return {
          bookmarks: bookmarks.map((bookmark) => ({
            name: bookmark.name,
            target: bookmark.target,
            remote: bookmark.remote,
          })),
        };
      },
    }),

    defineTool({
      name: 'jj_bookmark_set',
      description:
        "Create or move a Jujutsu (jj) bookmark to a revision. This is jj, not git: a bookmark is jj's named pointer with its own move rules, not a git branch. jj refuses backward or sideways moves unless explicitly allowed, because that usually means the wrong revision was selected.",
      parameters: {
        name: { type: 'string', description: "Bookmark name; must not contain whitespace or '@'.", required: true },
        revset: { type: 'string', description: "jj revset the bookmark should point at; defaults to '@'." },
        allowBackwards: {
          type: 'boolean',
          description: 'Permit moving the bookmark to an ancestor or unrelated revision.',
        },
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
        const result = await operations.bookmarkSet(
          cwd,
          args.name,
          args.revset ?? '@',
          args.allowBackwards ?? false,
          exec.signal,
        );
        return result;
      },
    }),

    defineTool({
      name: 'jj_rebase',
      description:
        'Rebase Jujutsu (jj) revisions onto a destination revision. This is jj, not git: there is no checkout and no merge commit. The mode selects which revisions move: "source" moves the given revision and all of its descendants (use it to rebase a whole stack); "revisions" (default) moves only the named revisions and leaves their descendants behind, re-parented onto the old parents; "branch" moves the whole branch containing the revision, relative to the destination.',
      parameters: {
        revision: { type: 'string', description: 'jj revset of the revision(s) to move.', required: true },
        destination: { type: 'string', description: 'jj revset of the destination revision.', required: true },
        mode: {
          type: 'string',
          enum: ['revisions', 'source', 'branch'],
          description:
            "Which revisions move: 'source' = the revision and all of its descendants (use it for a stack), 'revisions' (default) = only the named revisions, 'branch' = the whole branch relative to the destination.",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'string', required: true },
            destination: { type: 'string', required: true },
            mode: { type: 'string', enum: ['revisions', 'source', 'branch'], required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        await requireWorkspace(context, cwd, exec.signal);
        const mode = args.mode ?? 'revisions';
        const message = await operations.rebase(cwd, args.revision, args.destination, exec.signal, mode);
        return { revision: args.revision, destination: args.destination, mode, message };
      },
    }),

    defineTool({
      name: 'jj_handoff',
      description:
        "Finish work in this Jujutsu (jj) workspace end to end: fetch (a repository without remotes is fine), resolve the integration target, rebase this workspace's whole change stack onto it with source mode, verify the base, report conflicts, and optionally move a bookmark this session owns. This is jj, not git: no checkout and no merge commit. Use it instead of running fetch/rebase/verification as separate commands, and never hand those steps to the user — the tool already resolves the target and stale-working-copy recovery on its own.",
      parameters: {
        destination: {
          type: 'string',
          description:
            'jj revset to integrate onto (only when the user named a revision/bookmark). Omit for automatic resolution: the configured rebaseTarget (default trunk()), then local main/master; a local-only repository without a remote is handled.',
        },
        firstChange: {
          type: 'string',
          description:
            "Bottom-most change id of this workspace's stack above the resolved target. Omit inside a dedicated session workspace (the stack above the destination is detected automatically). Required in the root (default) workspace — detected by layout, so a renamed root workspace cannot bypass it — whose history may contain changes this session does not own; the tool rejects a change that is not the stack bottom (for example '@') because moving only part of the stack would falsely report success.",
        },
        bookmark: {
          type: 'string',
          description:
            "Local bookmark to move to the rebased tip. Pass it only when this session owns the bookmark; never move another session's bookmark.",
        },
        fetch: {
          type: 'boolean',
          description:
            'Run `jj git fetch` first (default true). Set false when the user explicitly asked to stay offline.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['jj-colocated', 'jj-native'], required: true },
            workspaceRoot: { type: 'string', required: true },
            workspaceName: { type: 'string', required: true },
            destination: { type: 'string', required: true },
            destinationSource: {
              type: 'string',
              enum: ['argument', 'configured', 'trunk', 'main', 'master'],
              required: true,
            },
            destinationChangeId: { type: 'string', required: true },
            destinationCommitId: { type: 'string', required: true },
            firstChangeId: { type: 'string', required: true },
            stack: { type: 'array', items: CHANGE_SCHEMA, required: true },
            rebased: { type: 'boolean', required: true },
            alreadyIntegrated: { type: 'boolean', required: true },
            onTarget: { type: 'boolean', required: true },
            needsCommit: { type: 'boolean', required: true },
            ambiguousRoots: { type: 'array', items: { type: 'string' }, required: true },
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  changeId: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                },
              },
              required: true,
            },
            fetch: {
              type: 'object',
              additionalProperties: false,
              properties: {
                status: { type: 'string', enum: ['fetched', 'no-remote', 'skipped', 'failed'], required: true },
                message: { type: 'string', required: true },
              },
              required: true,
            },
            message: { type: 'string', required: true },
            bookmark: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                target: { type: 'string', required: true },
                moved: { type: 'boolean', required: true },
              },
            },
            bookmarkSkipped: { type: 'string' },
            nextSteps: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const cwd = await context.cwdFor(exec);
        const descriptor = await requireWorkspace(context, cwd, exec.signal);
        const workspaceName = descriptor.workspaceName ?? 'default';
        const explicitFirst = args.firstChange?.trim();
        if (isRootWorkspace(descriptor) && (explicitFirst === undefined || explicitFirst.length === 0)) {
          throw new Error(
            'jj_handoff in the root (default) workspace needs `firstChange` (the bottom-most change id this session created): the root workspace history may contain changes from earlier work, and jj_handoff must never rebase changes it does not own. Inspect jj_log when unsure. Inside a dedicated session workspace the stack is detected automatically.',
          );
        }
        const result = await operations.handoff(
          cwd,
          {
            ...(args.destination !== undefined ? { destination: args.destination } : {}),
            ...(explicitFirst !== undefined && explicitFirst.length > 0 ? { firstChange: explicitFirst } : {}),
            ...(args.bookmark !== undefined ? { bookmark: args.bookmark } : {}),
            ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
          },
          exec.signal,
        );
        const cleanupOwned = workspaceName !== 'default' && ownsWorkspace(exec.agent, workspaceName, descriptor.root);
        return {
          ...workspaceFields(descriptor),
          destination: result.destination,
          destinationSource: result.destinationSource,
          destinationChangeId: result.destinationChangeId,
          destinationCommitId: result.destinationCommitId,
          firstChangeId: result.firstChangeId,
          stack: result.stack.map(changeView),
          rebased: result.rebased,
          alreadyIntegrated: result.alreadyIntegrated,
          onTarget: result.onTarget,
          needsCommit: result.needsCommit,
          ambiguousRoots: [...result.ambiguousRoots],
          conflicts: result.conflicts.map((conflict) => ({
            changeId: conflict.changeId,
            description: conflict.description,
          })),
          fetch: result.fetch,
          message: result.message,
          ...(result.bookmark !== undefined ? { bookmark: result.bookmark } : {}),
          ...(result.bookmarkSkipped !== undefined ? { bookmarkSkipped: result.bookmarkSkipped } : {}),
          nextSteps: handoffNextSteps(result, descriptor, cleanupOwned),
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_cleanup',
      description:
        "Unregister this session's own temporary Jujutsu (jj) workspace after a verified hand-off. This is jj, not git: it unregisters a jj workspace (not a git worktree), moves the session back to the default workspace (working_directory set), and runs jj workspace forget only for a workspace this exact session created through jj_workspace_add; any other workspace is refused and must be cleaned by the user. The directory keeps its files on disk. Use it instead of leaving a registered workspace behind or asking the user to forget it.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            forgotten: { type: 'boolean', required: true },
            workspaceName: { type: 'string', required: true },
            workspaceRoot: { type: 'string', required: true },
            currentWorkspace: { type: 'string', required: true },
            currentWorkspaceRoot: { type: 'string', required: true },
            message: { type: 'string', required: true },
            directoryNote: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(_args, exec) {
        const cwd = await context.cwdFor(exec);
        const descriptor = await requireWorkspace(context, cwd, exec.signal);
        const workspaceName = descriptor.workspaceName ?? 'default';
        if (workspaceName === 'default') {
          throw new Error(
            'jj_workspace_cleanup is unnecessary here: this session already runs in the default workspace, which must never be forgotten.',
          );
        }
        if (!ownsWorkspace(exec.agent, workspaceName, descriptor.root)) {
          throw new Error(
            [
              `jj_workspace_cleanup refused: workspace "${workspaceName}" was not created through jj_workspace_add in this session, so the plugin will not unregister it.`,
              'Unregistering a workspace another session or the user created would break their working copy.',
              `If the user should clean it up: from the default workspace run \`jj workspace forget ${workspaceName}\`, then delete ${descriptor.root}. Report those commands; do not run jj workspace forget yourself (the shell guard denies it).`,
            ].join('\n'),
          );
        }
        const status = await operations.status(cwd, exec.signal);
        if (!status.change.empty) {
          throw new Error(
            'The working copy still has uncommitted changes. Commit them with jj_commit (or finish the hand-off with jj_handoff) before cleaning up, so nothing is lost when the workspace is unregistered.',
          );
        }
        if (status.change.conflict) {
          throw new Error(
            'The working copy still has unresolved conflicts. Resolve them and finish the hand-off (jj_handoff) before cleaning up the workspace.',
          );
        }
        const workspaces = await operations.workspaceList(cwd, exec.signal);
        const fallback = workspaces.find((workspace) => workspace.name === 'default');
        if (fallback === undefined) {
          throw new Error(
            'jj_workspace_cleanup could not find the default workspace to move this session back to; report the cleanup commands to the user instead.',
          );
        }
        const workingDirectory = context.host.workingDirectory;
        if (exec.agent === undefined || workingDirectory === undefined || typeof workingDirectory.set !== 'function') {
          throw new Error(
            'jj_workspace_cleanup cannot move this session back to the default workspace (the host workingDirectory service exposes no set). Keep the workspace registered and report the cleanup commands to the user instead.',
          );
        }
        await workingDirectory.set(exec.agent, fallback.root, exec.signal);
        const message = await operations.workspaceForget(fallback.root, workspaceName, exec.signal);
        return {
          forgotten: true,
          workspaceName,
          workspaceRoot: descriptor.root,
          currentWorkspace: 'default',
          currentWorkspaceRoot: fallback.root,
          message,
          directoryNote: `The directory ${descriptor.root} is no longer a jj working copy; its files remain on disk and nothing tracked was lost. The user can delete it whenever convenient.`,
        };
      },
    }),
  ];
}
