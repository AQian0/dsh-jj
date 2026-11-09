/**
 * The 24 `jj_*` tool definitions (design contract §7.3).
 *
 * Every tool is jj-native: it names "Jujutsu (jj)" in its first sentence, states
 * that it is *not* git, and never falls back to Git commands. Outside a usable jj
 * workspace the tools refuse with the shared §7.4 templates instead of failing
 * silently. Schemas and views live in `tool-schemas.ts`, refusal/next-step text
 * and the tool context type in `tool-shared.ts`.
 *
 * @module dsh-jj/tool-definitions
 */
import { existsSync, readdirSync } from 'node:fs';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  COMMIT_STYLE_CHOICES,
  COMMIT_STYLE_IDS,
  CONCRETE_COMMIT_STYLE_IDS,
  detectCommitStyle,
  resolveCommitStylePolicy,
} from './commit-style.ts';
import { isRewritableChange } from './jj-templates.ts';
import {
  CHANGE_PROPERTIES,
  CHANGE_SCHEMA,
  changeView,
  NEXT_ACTIONS_SCHEMA,
  textRender,
  workspaceFields,
  type JjNextAction,
} from './tool-schemas.ts';
import type { VcsDescriptor } from './types.ts';
import { cleanupWorkspace } from './flows/cleanup.ts';
import { requireWorkspace, type ToolContext, type ToolExec } from './tool-shared.ts';
import { canonicalWorkspacePath, isRootWorkspace } from './policies.ts';

/**
 * Build every `jj_*` tool definition (contract §7.3).
 *
 * @param context - service access, resolved config, host, and the cwd resolver.
 * @returns the 18 tool definitions in a stable order.
 */
export function jjToolDefinitions(context: ToolContext): ToolDefinition[] {
  const { service, config } = context;
  const operations = service.operations;
  /**
   * Workspace ownership is service state, not tool state: the cleanup flow, the panel
   * and (later) the guard read the same registry, and a restarted host starts empty.
   * The tools only report what they created and ask before unregistering.
   */
  const ownership = service.workspaceOwnership;
  /**
   * Keep every result's `nextActions` short and JSON-clean: at most three entries, in the
   * order an agent should try them. Prose belongs in `reason`, not in the tool result.
   */
  const nextActions = (...actions: readonly JjNextAction[]): JjNextAction[] => actions.slice(0, 3);
  // Commit-description policy is owned by the runtime entry (`ctx.jj`) so the
  // session prompt and jj_commit_style cannot disagree; the tools row only carries
  // tool-specific tuning (limits, default cwd, …).
  const commitConfig = operations.config;
  /**
   * Resolve one tool call's directory and refuse it when it is not a usable jj
   * workspace (contract §7.4).
   *
   * Every tool starts here, so "never guess a repository, never fall back to Git" is
   * stated once instead of in every `execute` body.
   */
  const openWorkspace = async (exec: ToolExec): Promise<{ cwd: string; descriptor: VcsDescriptor }> => {
    const cwd = await context.cwdFor(exec);
    return { cwd, descriptor: await requireWorkspace(context, cwd, exec.signal) };
  };

  return [
    defineTool({
      name: 'jj_status',
      description:
        'Report Jujutsu (jj) working-copy state. This is jj, not git: there is no staging area, and the working copy is already a commit (@) that jj snapshots automatically. By default this is a cheap orientation read (change id, commit id, description, bookmarks, rewrite window); pass details: true only when you need the changed paths and diff stat, because that costs a full working-copy diff.',
      parameters: {
        details: {
          type: 'boolean',
          description:
            'Include changedPaths and the `jj status` summary (diff stat). Defaults to false: the cheap read answers "where am I" without a full working-copy diff.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            kind: { type: 'string', enum: ['jj-colocated', 'jj-native'], required: true },
            workspaceRoot: { type: 'string', required: true },
            workspaceName: { type: 'string', required: true },
            changeId: { type: 'string', required: true },
            commitId: { type: 'string', required: true },
            description: { type: 'string', required: true },
            empty: { type: 'boolean', required: true },
            conflict: { type: 'boolean', required: true },
            bookmarks: { type: 'array', items: { type: 'string' }, required: true },
            remoteBookmarks: { type: 'array', items: { type: 'string' }, required: true },
            rewritable: { type: 'boolean', required: true },
            changedPaths: { type: 'array', items: { type: 'string' } },
            diffStat: { type: 'string' },
            statusText: { type: 'string' },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd, descriptor } = await openWorkspace(exec);
        const details = args.details === true;
        const status = await operations.status(cwd, exec.signal, { details });
        return {
          ...workspaceFields(descriptor),
          changeId: status.change.changeId,
          commitId: status.change.commitId,
          description: status.change.description,
          empty: status.change.empty,
          conflict: status.change.conflict,
          bookmarks: [...status.change.bookmarks],
          remoteBookmarks: [...status.change.remoteBookmarks],
          rewritable: isRewritableChange(status.change),
          ...(details
            ? {
                changedPaths: [...status.changedPaths],
                diffStat: status.diffStat,
                statusText: status.truncated ? `[truncated]\n${status.raw}` : status.raw,
              }
            : {}),
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
            nextActions: NEXT_ACTIONS_SCHEMA,
            revset: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            changes: { type: 'array', items: CHANGE_SCHEMA, required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const revset = args.revset ?? '@ | @-';
        const requested = args.limit ?? config.defaultLogLimit;
        const limit = Math.max(1, Math.min(requested, config.maxLogLimit));
        const changes = await operations.log(cwd, revset, limit, exec.signal);
        return {
          revset,
          truncated: changes.length >= limit,
          changes: changes.map(changeView),
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
            nextActions: NEXT_ACTIONS_SCHEMA,
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
        const { cwd } = await openWorkspace(exec);
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
        'Create a new Jujutsu (jj) change on top of the given parents and make it the working copy (@). This is jj, not git: the previous change keeps its identity and is not re-created, and no commit step is needed — the new change is already real. To finish the current change with a description and start the next one in a single step, use jj_commit. Prefer a series of small changes over one growing working copy. With no parents it is refused while @ is already an empty change: that would only add another empty commit to the chain; pass explicit parents to start on another revision.',
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
        const { cwd } = await openWorkspace(exec);
        const change = await operations.newChange(cwd, args.parents ?? [], args.message, exec.signal);
        return changeView(change);
      },
    }),

    defineTool({
      name: 'jj_commit',
      description:
        'Commit the current Jujutsu (jj) working-copy change with a description and start a new change on top. This is jj, not git: jj commit is jj describe plus jj new, so the described change stays in history and a new working-copy change is created (empty unless paths leave changes behind); there is no staging area. Prefer it after each coherent step to keep the change stack reviewable for humans, and pass paths to commit only part of the working copy when splitting work. Follow the repository description style — jj_commit_style reports it. It refuses when @ has no content changes, because that would leave an empty commit in the chain; call jj_handoff directly when the work is already committed, and use jj_new for an intentionally empty change.',
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
            nextActions: NEXT_ACTIONS_SCHEMA,
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
        const { cwd } = await openWorkspace(exec);
        const result = await operations.commit(cwd, args.message, args.paths ?? [], exec.signal);
        return {
          committed: changeView(result.committed),
          workingCopy: changeView(result.workingCopy),
          committedPaths: [...result.committed.paths],
          workingCopyPaths: [...result.workingCopy.paths],
          warnings: [...result.warnings],
          nextActions: nextActions(
            ...(isRewritableChange(result.committed)
              ? [
                  {
                    tool: 'jj_amend',
                    args: { into: result.committed.changeId },
                    reason: 'While this commit is unpushed, corrections belong in it via jj_amend.',
                  },
                ]
              : []),
            {
              tool: 'jj_handoff',
              reason: 'When this stack is finished, integrate it onto the rebase target with one call.',
            },
          ),
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
        const { cwd } = await openWorkspace(exec);
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
            nextActions: NEXT_ACTIONS_SCHEMA,
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
        const { cwd } = await openWorkspace(exec);
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
        'Move changes from one Jujutsu (jj) revision into another; by default from @ into @-. This is jj, not git: it replaces git commit --amend and interactive staging, and descendants are rebased automatically. For a correction to a change you made in this session that is not pushed yet, prefer jj_amend: it validates the target (published changes are refused) and reports the rebased descendants.',
      parameters: {
        from: { type: 'string', description: "jj revset to move changes out of; defaults to '@'." },
        into: { type: 'string', description: "jj revset to move changes into; defaults to '@-'." },
        message: {
          type: 'string',
          description: 'New description for the destination change. Mutually exclusive with useDestinationMessage.',
        },
        useDestinationMessage: { type: 'boolean', description: "Keep the destination change's existing description." },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional repository-relative paths to move only those changes; the remaining changes stay in the source.',
        },
      },
      output: { schema: CHANGE_SCHEMA, render: (_args, value) => textRender(value) },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const change = await operations.squash(
          cwd,
          args.from ?? '@',
          args.into ?? '@-',
          args.message,
          args.useDestinationMessage ?? false,
          args.paths ?? [],
          exec.signal,
        );
        return changeView(change);
      },
    }),

    defineTool({
      name: 'jj_amend',
      description:
        'Fold a correction into an earlier Jujutsu (jj) change instead of appending a new commit. This is jj, not git: it is `jj squash --from … --into …`, not `git commit --amend`; the target change is rewritten in place, its descendants are rebased, local bookmarks follow it, and its change id stays stable. Use it while the target is still unpushed (rewritable: true in jj_log): it refuses a change that a remote bookmark, trunk or tag already reaches, because rewriting that would need a forced push (dsh-jj never does that), and it only folds into changes in this workspace’s own stack. A correction that is a new increment, or a target that is ambiguous, should stay a new commit.',
      parameters: {
        into: {
          type: 'string',
          required: true,
          description:
            'Change the correction belongs to: exactly one revision (a change id from jj_log, or @-/@--). It must be an ancestor of the source and still rewritable.',
        },
        from: {
          type: 'string',
          description:
            "Source of the correction; defaults to '@' (the working copy). Pass the correction commit's change id when the fix was already committed — jj abandons that change after folding it.",
        },
        message: {
          type: 'string',
          description:
            "Replace the target's description with this one (follow the repository style). Omit to keep the target's existing description.",
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional repository-relative paths to fold only those changes; the remaining changes stay in the source.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            amended: { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES, required: true },
            workingCopy: { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES, required: true },
            sourceAbandoned: {
              type: 'boolean',
              required: true,
              description: 'True when the source was a committed change that jj removed after folding it.',
            },
            rewritten: {
              type: 'array',
              required: true,
              description: 'Descendants rebased by the rewrite, newest first (target and @ excluded).',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  changeId: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  conflict: { type: 'boolean', required: true },
                },
              },
            },
            warnings: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const result = await operations.amend(cwd, args, exec.signal);
        return {
          amended: changeView(result.amended),
          workingCopy: changeView(result.workingCopy),
          sourceAbandoned: result.sourceAbandoned,
          rewritten: result.rewritten.map((change) => ({ ...change })),
          warnings: [...result.warnings],
          nextActions: nextActions(
            ...(result.rewritten.some((change) => change.conflict)
              ? [
                  {
                    tool: 'jj_status',
                    args: { details: true },
                    reason: 'The rewrite produced conflicts: inspect them before continuing.',
                  },
                ]
              : []),
            {
              tool: 'jj_log',
              args: { revset: '@ | @-' },
              reason: 'Confirm the folded change and its rebased descendants look right.',
            },
          ),
        };
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
            nextActions: NEXT_ACTIONS_SCHEMA,
            mode: { type: 'string', enum: ['undo', 'restore'], required: true },
            operationId: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const result = await operations.undo(cwd, args.operationId, exec.signal);
        return { mode: result.mode, operationId: result.operationId, message: result.message };
      },
    }),

    defineTool({
      name: 'jj_op_log',
      description:
        'Show the Jujutsu (jj) operation log — the recorded history of repository mutations, including automatic working-copy snapshots. This is jj, not git: the operation log is not a git reflog and captures every jj mutation, so use it to find an operation id for jj_undo.',
      parameters: {
        limit: {
          type: 'integer',
          description: `Maximum operations to return; 1…${config.maxLogLimit}, default ${config.defaultLogLimit}.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
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
        const { cwd } = await openWorkspace(exec);
        const limit = Math.max(1, Math.min(args.limit ?? config.defaultLogLimit, config.maxLogLimit));
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
        'Create an additional Jujutsu (jj) workspace — a second working copy of the same repository — at a path, start a new change in it, and move this session into it (like create_worktree in the official Git tooling). This is jj, not git: the workspace is registered in jj and visible to jj_workspace_list, unlike a raw git worktree. Prefer an absolute path outside the repository root (a path inside it leaves a phantom entry in git-side snapshots). Omit `parents` to start from the parents of the current change: after jj_commit that bases the new workspace on the commit you just made, which is the intended way to carry your committed work over. Do not pass `parents: ["@"]` for that — @ is the working-copy change (usually the fresh empty change), so it would become an empty commit in the new workspace\'s chain and reach the handed-off/pushed history; the tool drops a bare empty @ and refuses @ while the working copy still has uncommitted changes.',
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
          description:
            "Revsets the new workspace's change starts on; omit to share the current change's parents (recommended: after jj_commit this is the commit you just made). A literal @ is dropped while @ is the empty working-copy change and refused while @ still has uncommitted content, because basing the new workspace on @ would leave the working-copy change as an empty/undescribed commit in its chain.",
        },
        message: { type: 'string', description: 'Description for the new workspace working-copy change.' },
        colocate: {
          type: 'boolean',
          description:
            "Also create a matching Git worktree for the new workspace. Defaults to the repository's own colocation setting.",
        },
        enter: {
          type: 'boolean',
          description:
            'Move this session into the new workspace (default true). Pass false to create the workspace without switching directories, for example when another session will use it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            path: { type: 'string', required: true },
            name: { type: 'string', required: true },
            changeId: { type: 'string', required: true },
            commitId: { type: 'string', required: true },
            note: {
              type: 'string',
              description:
                'Set when the requested parents were adjusted (a bare empty @ was dropped) or when the session could not be moved into the new workspace.',
            },
            entered: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        // Remember the base the new working copy starts on, so a later restore can
        // recreate the workspace on the same parent after its directory is gone. Only
        // the implicit-parents form is recorded: explicit multi-parent bases cannot be
        // reproduced from a single change id.
        const explicitParents = args.parents ?? [];
        const baseChange =
          explicitParents.length === 0
            ? await operations.readAt(cwd, exec.signal, '@-').catch(() => undefined)
            : undefined;
        const result = await operations.workspaceAdd(
          cwd,
          args.path,
          args.name,
          explicitParents,
          args.message,
          args.colocate,
          exec.signal,
        );
        ownership.remember(exec.agent, result.name, result.path, baseChange?.changeId);
        const enter = args.enter !== false;
        const workingDirectory = context.host.workingDirectory;
        const canEnter = exec.agent !== undefined && typeof workingDirectory?.set === 'function';
        let entered = false;
        let enterNote = '';
        if (enter && canEnter) {
          await (workingDirectory as { set(agent: unknown, path: string, signal?: AbortSignal): Promise<string> }).set(
            exec.agent,
            result.path,
            exec.signal,
          );
          entered = true;
        } else if (enter) {
          enterNote =
            ' The session could not be moved into the new workspace (the host exposes no workingDirectory.set); switch with the working_directory tool before editing files.';
        }
        const note = [result.note, enterNote].filter((line) => line !== undefined && line.length > 0).join(' ');
        return {
          path: result.path,
          name: result.name,
          changeId: result.change.changeId,
          commitId: result.change.commitId,
          entered,
          ...(note.length > 0 ? { note } : {}),
          nextActions: nextActions({
            tool: 'jj_status',
            reason: entered
              ? 'Confirm the new workspace is the current working copy before editing files.'
              : 'Switch into the new workspace, then confirm it before editing files.',
          }),
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_list',
      description:
        'List the Jujutsu (jj) workspaces of this repository. This is jj, not git: each workspace is a separate jj working copy with its own current change (@), registered with jj — not a git worktree. Pass `detail: "full"` to also get each workspace\'s @ change id, description, empty/conflict state and whether it is the current one; the listing never snapshots any working copy.',
      parameters: {
        detail: {
          type: 'string',
          enum: ['basic', 'full'],
          description:
            'basic (default): name, root and which workspace is current. full: additionally the @ change id/commit id, first description line, empty/conflict flags and staleness of the current workspace.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
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
                  changeId: { type: 'string' },
                  commitId: { type: 'string' },
                  description: { type: 'string' },
                  empty: { type: 'boolean' },
                  conflict: { type: 'boolean' },
                  stale: { type: 'string', enum: ['yes', 'no', 'unknown'] },
                },
              },
            },
            currentWorkspace: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd, descriptor } = await openWorkspace(exec);
        const currentWorkspace = descriptor.workspaceName ?? 'default';
        if (args.detail === 'full') {
          const states = await operations.workspaceStates(cwd, exec.signal);
          return {
            workspaces: states.map((state) => ({
              name: state.name,
              root: state.root,
              isCurrent: state.current,
              changeId: state.changeId,
              commitId: state.commitId,
              description: state.description,
              empty: state.empty,
              conflict: state.conflict,
              stale: state.stale,
            })),
            currentWorkspace,
          };
        }
        const workspaces = await operations.workspaceList(cwd, exec.signal);
        return {
          workspaces: workspaces.map((workspace) => ({
            name: workspace.name,
            root: workspace.root,
            isCurrent: workspace.name === currentWorkspace,
          })),
          currentWorkspace,
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_enter',
      description:
        'Move this session into another existing Jujutsu (jj) workspace of the same repository. This is jj, not git: the target is a registered jj workspace (not a git worktree), and switching means the session working directory changes, so later tool calls and file edits happen in that working copy. It refuses workspaces of a different repository and a missing directory.',
      parameters: {
        workspace: {
          type: 'string',
          description: 'Workspace name from jj_workspace_list, or its absolute root path.',
          required: true,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            workspaceName: { type: 'string', required: true },
            workspaceRoot: { type: 'string', required: true },
            alreadyCurrent: { type: 'boolean', required: true },
            change: CHANGE_SCHEMA,
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd, descriptor } = await openWorkspace(exec);
        const requested = args.workspace.trim();
        if (requested.length === 0) {
          throw new Error('jj_workspace_enter needs a workspace name or absolute path; call jj_workspace_list first.');
        }
        const states = await operations.workspaceStates(cwd, exec.signal);
        const requestedPath = canonicalWorkspacePath(requested);
        const target =
          states.find((state) => state.name === requested) ??
          states.find((state) => canonicalWorkspacePath(state.root) === requestedPath);
        if (target === undefined) {
          throw new Error(
            `jj_workspace_enter found no workspace named or located at ${JSON.stringify(requested)}; call jj_workspace_list to see this repository's workspaces.`,
          );
        }
        if (target.current) {
          return {
            workspaceName: target.name,
            workspaceRoot: target.root,
            alreadyCurrent: true,
            change: changeView(await operations.readAt(cwd, exec.signal)),
          };
        }
        const targetDescriptor = await service.detect(target.root, exec.signal);
        if (
          (targetDescriptor.kind !== 'jj-colocated' && targetDescriptor.kind !== 'jj-native') ||
          targetDescriptor.jjRepoPath !== descriptor.jjRepoPath
        ) {
          throw new Error(
            `jj_workspace_enter refuses ${JSON.stringify(target.root)}: it is not a working copy of this repository (the directory may be missing or belong to another repository). Recreate it or stay in this workspace.`,
          );
        }
        const workingDirectory = context.host.workingDirectory;
        if (exec.agent === undefined || typeof workingDirectory?.set !== 'function') {
          throw new Error(
            'jj_workspace_enter cannot move this session (the host workingDirectory service exposes no set); use the working_directory tool instead.',
          );
        }
        await (workingDirectory as { set(agent: unknown, path: string, signal?: AbortSignal): Promise<string> }).set(
          exec.agent,
          target.root,
          exec.signal,
        );
        return {
          workspaceName: target.name,
          workspaceRoot: target.root,
          alreadyCurrent: false,
          change: changeView(await operations.readAt(target.root, exec.signal)),
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_restore',
      description:
        'Rebuild a temporary Jujutsu (jj) workspace this session created with jj_workspace_add after its directory was deleted or its registration was forgotten. This is jj, not git: it re-runs `jj workspace add` on the recorded base change, so the rebuilt working copy starts on exactly the same parent. It only restores workspaces this process created, refuses to touch a non-empty directory, refuses a name that is still registered (use jj_workspace_enter or jj_workspace_update_stale instead) and never deletes files.',
      parameters: {
        name: {
          type: 'string',
          description: 'Workspace name as reported by jj_workspace_add earlier in this session.',
          required: true,
        },
        message: { type: 'string', description: 'Description for the rebuilt working-copy change.' },
        enter: {
          type: 'boolean',
          description: 'Move this session into the rebuilt workspace (default true).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            path: { type: 'string', required: true },
            name: { type: 'string', required: true },
            changeId: { type: 'string', required: true },
            commitId: { type: 'string', required: true },
            baseChangeId: { type: 'string', required: true },
            entered: { type: 'boolean', required: true },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const requested = args.name.trim();
        if (requested.length === 0) {
          throw new Error('jj_workspace_restore needs the workspace name recorded by jj_workspace_add.');
        }
        const owned = ownership.list(exec.agent).find((entry) => entry.name === requested);
        if (owned === undefined) {
          throw new Error(
            `jj_workspace_restore only rebuilds a workspace this session created with jj_workspace_add (no record for ${JSON.stringify(requested)}): the directory and registration are both gone, so use jj_workspace_add with a new name, or ask the user to recreate it.`,
          );
        }
        if (owned.baseChangeId === undefined) {
          throw new Error(
            `jj_workspace_restore has no base change for ${JSON.stringify(requested)}: it was created with explicit parents, so the base cannot be reproduced from one change id. Create it again with jj_workspace_add and an explicit parents list.`,
          );
        }
        const baseChangeId = owned.baseChangeId;
        const states = await operations.workspaceStates(cwd, exec.signal);
        if (states.some((state) => canonicalWorkspacePath(state.root) === owned.root)) {
          throw new Error(
            `jj_workspace_restore: ${JSON.stringify(requested)} is still registered at ${owned.root}. Use jj_workspace_enter to switch to it, or jj_workspace_update_stale when its working copy is stale.`,
          );
        }
        if (!(await operations.changeExists(cwd, baseChangeId, exec.signal))) {
          throw new Error(
            `jj_workspace_restore: the recorded base change ${baseChangeId} no longer exists (it was abandoned or garbage-collected), so the workspace cannot be rebuilt on its original base. Create it again with jj_workspace_add.`,
          );
        }
        if (existsSync(owned.root) && readdirSync(owned.root).length > 0) {
          throw new Error(
            `jj_workspace_restore refuses to write into ${owned.root}: the directory exists and is not empty. Move or delete it yourself, then call the tool again — the plugin never deletes files.`,
          );
        }
        const result = await operations.workspaceAdd(
          cwd,
          owned.root,
          owned.name,
          [baseChangeId],
          args.message,
          undefined,
          exec.signal,
        );
        ownership.remember(exec.agent, result.name, result.path, baseChangeId);
        const enter = args.enter !== false;
        const workingDirectory = context.host.workingDirectory;
        const canEnter = exec.agent !== undefined && typeof workingDirectory?.set === 'function';
        let entered = false;
        let enterNote = '';
        if (enter && canEnter) {
          await (workingDirectory as { set(agent: unknown, path: string, signal?: AbortSignal): Promise<string> }).set(
            exec.agent,
            result.path,
            exec.signal,
          );
          entered = true;
        } else if (enter) {
          enterNote =
            ' The session could not be moved into the rebuilt workspace (the host exposes no workingDirectory.set); switch with the working_directory tool before editing files.';
        }
        return {
          path: result.path,
          name: result.name,
          changeId: result.change.changeId,
          commitId: result.change.commitId,
          baseChangeId,
          entered,
          ...(enterNote.length > 0 ? { note: enterNote } : {}),
          nextActions: nextActions({
            tool: 'jj_status',
            reason: entered
              ? 'Confirm the rebuilt workspace is the current working copy before editing files.'
              : 'Switch into the rebuilt workspace, then confirm it before editing files.',
          }),
        };
      },
    }),

    defineTool({
      name: 'jj_bookmark_list',
      description:
        "List Jujutsu (jj) bookmarks. This is jj, not git: bookmarks are jj's optional named pointers, not git branches — they are not required to create or keep changes, so most changes may have no bookmark at all.",
      parameters: {
        allRemotes: { type: 'boolean', description: 'Also include remote-tracking entries (name@remote).' },
        includeGitMirror: {
          type: 'boolean',
          description:
            'Also list `@git` entries. In a colocated repository every local bookmark has an `@git` mirror that jj keeps in sync; it is hidden unless you explicitly ask for it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
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
                  conflicted: {
                    type: 'boolean',
                    required: true,
                    description:
                      'True when concurrent operations left the bookmark with several or absent targets; target is then only one side. Resolve it with jj_bookmark_set.',
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const bookmarks = await operations.bookmarkList(cwd, args.allRemotes ?? false, exec.signal);
        const includeGitMirror = args.includeGitMirror === true;
        const visible = bookmarks.filter((bookmark) => includeGitMirror || bookmark.remote !== 'git');
        return {
          bookmarks: visible.map((bookmark) => ({
            name: bookmark.name,
            target: bookmark.target,
            remote: bookmark.remote,
            conflicted: bookmark.conflicted,
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
            nextActions: NEXT_ACTIONS_SCHEMA,
            name: { type: 'string', required: true },
            target: { type: 'string', required: true },
            moved: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
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
            nextActions: NEXT_ACTIONS_SCHEMA,
            revision: { type: 'string', required: true },
            destination: { type: 'string', required: true },
            mode: { type: 'string', enum: ['revisions', 'source', 'branch'], required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const mode = args.mode ?? 'revisions';
        const message = await operations.rebase(cwd, args.revision, args.destination, exec.signal, mode);
        return { revision: args.revision, destination: args.destination, mode, message };
      },
    }),

    defineTool({
      name: 'jj_handoff',
      description:
        "Finish work in this Jujutsu (jj) workspace end to end: fetch (a repository without remotes is fine), resolve the integration target, rebase this workspace's whole change stack onto it with source mode, verify the base, report conflicts, and optionally move a bookmark this session owns. This is jj, not git: no checkout and no merge commit. It refuses a destination that shares no real history with this workspace (only jj's empty root commit) and it never rewrites shared history; a workspace that is behind the destination is reported (onTarget: false) without a rebase. Use it instead of running fetch/rebase/verification as separate commands, and never hand those steps to the user — the tool already resolves the target and stale-working-copy recovery on its own.",
      parameters: {
        destination: {
          type: 'string',
          description:
            "jj revset to integrate onto (only when the user named a revision/bookmark). It must be part of this workspace history or share real history with it: a revision that only shares jj's empty root is rejected. Omit for automatic resolution: the configured rebaseTarget (default trunk()), then local main/master; a local-only repository without a remote is handled.",
        },
        firstChange: {
          type: 'string',
          description:
            "Bottom-most change id of this workspace's stack above the resolved target. Omit inside a dedicated session workspace (the stack above the destination is detected automatically). Required in the root (default) workspace — detected by layout, so a renamed root workspace cannot bypass it — whose history may contain changes this session does not own; the tool rejects a change that is not the stack bottom (for example '@') because moving only part of the stack would falsely report success.",
        },
        bookmark: {
          type: 'string',
          description:
            "Local bookmark to move to the rebased tip. Existing bookmarks only move when they already point into the stack being rebased; a bookmark on shared history is reported as bookmarkSkipped instead of being moved. Pass it only when this session owns the bookmark; never move another session's bookmark.",
        },
        fetch: {
          type: 'boolean',
          description:
            'Run `jj git fetch` first (default true). Set false when the user explicitly asked to stay offline.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Plan only (default false): resolve the target, run the same boundary validations and read the stack, but do not fetch, rebase or move a bookmark. Use it when the user asks what a hand-off would do.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
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
            dryRun: { type: 'boolean', required: true },
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
            emptyChanges: {
              type: 'array',
              required: true,
              description:
                "Empty changes carried by the integrated stack. A described one may be dropped with jj_abandon only when it is this session's own unpushed change; an undescribed one is usually another workspace's empty working-copy change and must never be abandoned.",
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  changeId: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  currentWorkingCopy: { type: 'boolean', required: true },
                },
              },
            },
            cleanup: {
              type: 'object',
              required: true,
              description:
                'Who unregisters this workspace after the hand-off: `owned` means this session created it with jj_workspace_add, so jj_workspace_cleanup may run; otherwise the user runs jj workspace forget.',
              additionalProperties: false,
              properties: {
                required: { type: 'boolean', required: true },
                owned: { type: 'boolean', required: true },
                workspaceName: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd, descriptor } = await openWorkspace(exec);
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
            ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
          },
          exec.signal,
        );
        const cleanupOwned = workspaceName !== 'default' && ownership.owns(exec.agent, workspaceName, descriptor.root);
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
          dryRun: result.dryRun,
          ambiguousRoots: [...result.ambiguousRoots],
          conflicts: result.conflicts.map((conflict) => ({
            changeId: conflict.changeId,
            description: conflict.description,
          })),
          fetch: result.fetch,
          message: result.message,
          ...(result.bookmark !== undefined ? { bookmark: result.bookmark } : {}),
          ...(result.bookmarkSkipped !== undefined ? { bookmarkSkipped: result.bookmarkSkipped } : {}),
          emptyChanges: result.stack
            .filter((change) => change.empty && !change.currentWorkingCopy)
            .map((change) => ({
              changeId: change.changeId,
              description: change.description,
              currentWorkingCopy: change.currentWorkingCopy,
            })),
          cleanup: {
            required: workspaceName !== 'default',
            owned: cleanupOwned,
            workspaceName,
          },
          nextActions: nextActions(
            ...(result.dryRun
              ? [
                  {
                    tool: 'jj_handoff',
                    args: {
                      ...(args.destination !== undefined ? { destination: args.destination } : {}),
                      ...(explicitFirst !== undefined && explicitFirst.length > 0
                        ? { firstChange: explicitFirst }
                        : {}),
                      dryRun: false,
                    },
                    reason: 'The plan was accepted: run the same hand-off without dryRun to rebase the stack.',
                  },
                ]
              : []),
            ...(result.needsCommit
              ? [
                  {
                    tool: 'jj_commit',
                    reason: 'The working copy still has uncommitted changes: commit them, then hand off again.',
                  },
                ]
              : []),
            ...(result.conflicts.length > 0
              ? [
                  {
                    tool: 'jj_status',
                    args: { details: true },
                    reason: 'The rebase left conflicts: inspect and resolve them before finishing.',
                  },
                ]
              : []),
            ...(cleanupOwned
              ? [
                  {
                    tool: 'jj_workspace_cleanup',
                    reason:
                      'The stack is integrated: unregister this temporary workspace and return to the default one.',
                  },
                ]
              : []),
            ...(!result.needsCommit && result.conflicts.length === 0 && !cleanupOwned
              ? [
                  {
                    tool: 'jj_log',
                    args: { revset: '@ | @-' },
                    reason: 'Confirm the rebased stack on its destination.',
                  },
                ]
              : []),
          ),
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
            nextActions: NEXT_ACTIONS_SCHEMA,
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
        const { cwd, descriptor } = await openWorkspace(exec);
        // The decision, the stale recovery and the ordering of "move the session, then
        // forget" live in the flow (src/flows/cleanup.ts); the tool only supplies facts.
        return await cleanupWorkspace({
          operations,
          owns: (name, root) => ownership.owns(exec.agent, name, root),
          host: context.host,
          agent: exec.agent,
          cwd,
          descriptor,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'jj_abandon',
      description:
        'Abandon (drop) Jujutsu (jj) revisions, rebasing their descendants onto the parents. This is jj, not git: there is no staging area and no garbage commit — an abandoned change leaves the graph, and the change ids of its descendants stay stable. The tool refuses a revset that includes the working copy (@) or a published change, so it cannot silently discard work or rewrite pushed history.',
      parameters: {
        revset: {
          type: 'string',
          description:
            'jj revset naming the revisions to drop (change ids from jj_log). Required: jj would otherwise default to @.',
          required: true,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            abandoned: { type: 'array', items: CHANGE_SCHEMA, required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const result = await operations.abandon(cwd, args.revset, exec.signal);
        return {
          abandoned: result.abandoned.map((change) => changeView(change)),
          message: result.message,
          nextActions: nextActions({
            tool: 'jj_log',
            args: { revset: '@ | @-' },
            reason: 'Confirm the dropped revisions are gone and the descendants landed on their new parents.',
          }),
        };
      },
    }),

    defineTool({
      name: 'jj_fetch',
      description:
        'Fetch new commits and bookmarks from the Git remote into this Jujutsu (jj) repository (`jj git fetch`). This is jj, not git: fetching updates jj remote bookmarks, it never touches the working copy, and it never pushes. A repository without a remote is a normal result (status "no-remote"), not an error.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            status: { type: 'string', enum: ['fetched', 'no-remote', 'skipped', 'failed'], required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(_args, exec) {
        const { cwd } = await openWorkspace(exec);
        const result = await operations.fetch(cwd, exec.signal);
        return {
          status: result.status,
          message: result.message,
          nextActions: nextActions({
            tool: 'jj_handoff',
            args: { fetch: false },
            reason: 'Fetched state is in the log: integrate this stack onto the updated target.',
          }),
        };
      },
    }),

    defineTool({
      name: 'jj_workspace_update_stale',
      description:
        'Recover a stale Jujutsu (jj) working copy (`jj workspace update-stale`). A workspace becomes stale when another workspace rebased the change it had checked out; every read fails until it is recovered. This is jj, not git: the command only reloads this workspace onto the rewritten change, it does not move or rewrite any commit.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            message: { type: 'string', required: true },
            change: CHANGE_SCHEMA,
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(_args, exec) {
        const { cwd } = await openWorkspace(exec);
        const message = await operations.updateStale(cwd, exec.signal);
        const change = await operations.readAt(cwd, exec.signal);
        return { message, change: changeView(change) };
      },
    }),

    defineTool({
      name: 'jj_op_restore',
      description:
        'Restore the whole repository to an earlier Jujutsu (jj) operation (`jj op restore <id>`). This is jj, not git: the operation log records every mutation, and restoring replays the repository view as of that operation, rewriting this workspace working copy to match. Prefer jj_undo for "undo the last operation"; use this when you know the exact operation id from jj_op_log.',
      parameters: {
        operationId: {
          type: 'string',
          description: 'Operation id (or unique hexadecimal prefix) from jj_op_log.',
          required: true,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nextActions: NEXT_ACTIONS_SCHEMA,
            operationId: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => textRender(value),
      },
      async execute(args, exec) {
        const { cwd } = await openWorkspace(exec);
        const result = await operations.undo(cwd, args.operationId, exec.signal);
        return { operationId: result.operationId, message: result.message };
      },
    }),
  ];
}
