/**
 * Shared context types and model-facing text for the `jj_*` tools (design contract §7.4).
 *
 * The refusal templates, hand-off next-step guidance, and workspace-ownership
 * helpers are used by both the tool definitions and the plugin entry; keeping
 * them together lets `tools.ts` re-export the same public surface as before the
 * split without a dependency cycle.
 *
 * @module dsh-jj/tool-shared
 */
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ResolvedJjConfig } from './config.ts';
import type { JjAmendResult, JjHandoffResult, JjOperations } from './service.ts';
import type { VcsDescriptor } from './types.ts';

/** Structural view of the service the tools need (a live `JjService` satisfies it). */
export interface JjToolService {
  readonly operations: JjOperations;
  detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
}

/** Structural view of the host context used by the tools entry. */
export interface JjToolsHost {
  readonly tools: { register(definition: ToolDefinition): () => void };
  readonly workingDirectory?: {
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    /** Move one session to another directory (`workingDirectory.set`); optional on older hosts. */
    set?(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
  };
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

/** Canonical workspace root for ownership checks (realpath when it exists, else the path as given). */
export function canonicalWorkspacePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether this session runs in the repository's root ("default") workspace.
 *
 * Determined from the layout, not the name: the root workspace owns `.jj/repo` as
 * a real directory, while a linked workspace's `.jj/repo` is a pointer file. This
 * keeps the `firstChange` safety requirement when the root workspace was renamed.
 */
export function isRootWorkspace(descriptor: VcsDescriptor): boolean {
  try {
    return statSync(join(descriptor.root, '.jj', 'repo')).isDirectory();
  } catch {
    return (descriptor.workspaceName ?? 'default') === 'default';
  }
}

/** The caller identity and cancellation one tool call runs with (the `execute` `exec` argument). */
export interface ToolExec {
  readonly agent?: unknown;
  readonly signal?: AbortSignal;
}

export interface ToolContext {
  readonly service: JjToolService;
  readonly config: ResolvedJjConfig;
  readonly host: JjToolsHost;
  readonly cwdFor: (exec: ToolExec) => Promise<string>;
}

export async function requireWorkspace(
  context: ToolContext,
  cwd: string,
  signal?: AbortSignal,
): Promise<VcsDescriptor> {
  const descriptor = await context.service.detect(cwd, signal);
  if (descriptor.kind === 'jj-colocated' || descriptor.kind === 'jj-native') return descriptor;
  throw new Error(jjRefusalText(descriptor, cwd, context.config.jjCommand));
}

/**
 * Cleanup line for a hand-off result: say exactly who unregisters the workspace.
 *
 * A temporary workspace created through `jj_workspace_add` in this session may be
 * cleaned by `jj_workspace_cleanup`; anything else (user-created or another
 * session's workspace) stays a user action, with the exact command quoted.
 */
function workspaceCleanupText(descriptor: VcsDescriptor, cleanupOwned: boolean): string {
  const workspaceName = descriptor.workspaceName ?? 'default';
  if (workspaceName === 'default') return 'This is the default workspace; there is no temporary workspace to clean up.';
  if (cleanupOwned) {
    return `This session created workspace "${workspaceName}" with jj_workspace_add: after the hand-off is verified, call jj_workspace_cleanup to return to the default workspace and unregister it.`;
  }
  return `Workspace cleanup stays a user action for "${workspaceName}" at ${descriptor.root} (it was not created through jj_workspace_add in this session): report the exact commands — run \`jj workspace forget ${workspaceName}\` from the default workspace, then delete ${descriptor.root} — and do not run jj workspace forget yourself.`;
}

/**
 * Model-facing warning about empty changes carried by the handed-off stack.
 *
 * A moved stack can contain empty changes for two reasons: another workspace's
 * empty working-copy change became an ancestor (it was created with a
 * `parents: ["@"]` workspace add), or a rebased change became empty because the
 * destination already contains its content. Both would be exported to Git as empty
 * commits, so the hand-off reports them instead of calling the stack clean.
 *
 * @param result - the hand-off result whose stack was just integrated.
 * @returns one sentence naming the empty changes, or `''` when there are none.
 */
function handoffEmptyChangesNote(result: JjHandoffResult): string {
  const empty = result.stack.filter((change) => change.empty && !change.currentWorkingCopy);
  if (empty.length === 0) return '';
  const listed = empty
    .map((change) => `${change.changeId} (${change.description.length > 0 ? change.description : 'no description'})`)
    .join(', ');
  const count = empty.length;
  return [
    `The integrated stack carries ${count} empty change${count === 1 ? '' : 's'}: ${listed}. They would become empty commits in Git history.`,
    "A described change that became empty because the destination already contains its content may be dropped with `jj abandon <change id>` when it is this session's own unpushed change;",
    'an empty change without a description is usually another workspace\'s empty working-copy change: never abandon it, report it to the user so the next workspace is created without `parents: ["@"]`.',
  ].join(' ');
}

/**
 * Model-facing next step for one hand-off result.
 *
 * The whole point of jj_handoff is that the model does not re-delegates its steps
 * to the user: every branch below names the concrete next tool call. The only
 * user interaction left is an explicit integration target when the repository
 * genuinely has none.
 */
export function handoffNextSteps(result: JjHandoffResult, descriptor: VcsDescriptor, cleanupOwned: boolean): string {
  const cleanup = workspaceCleanupText(descriptor, cleanupOwned);
  const emptyNote = handoffEmptyChangesNote(result);
  const emptySuffix = emptyNote.length > 0 ? ` ${emptyNote}` : '';
  if (result.needsCommit) {
    return "Commit the working copy with jj_commit (a description following this repository's style), then call jj_handoff again. Do not ask the user to commit.";
  }
  if (result.ambiguousRoots.length > 0) {
    return `Pass firstChange with one of these change ids and call jj_handoff again: ${result.ambiguousRoots.join(', ')}.`;
  }
  const cleanupNote = result.bookmarkSkipped !== undefined ? ` ${result.bookmarkSkipped}` : '';
  if (result.conflicts.length > 0) {
    const ids = result.conflicts.map((conflict) => conflict.changeId).join(', ');
    return [
      'Resolve the conflicts yourself; do not ask the user to do it.',
      'Edit the files to their final content (remove the `<<<<<<<` / `%%%%%%%` / `>>>>>>>` marker blocks) and run jj_status so jj snapshots the resolution. For a conflict inside a middle commit, `jj edit <change>`, fix it, then `jj new <top change>` to return.',
      `Then call jj_handoff again to confirm no conflicts remain, and report the rebased change ids. Conflicted changes: ${ids}.${cleanupNote}`,
      cleanup,
    ].join('\n');
  }
  // A workspace behind the destination has no stack above it to rebase, so no
  // rebase ran: say that instead of claiming the base is wrong after a rebase.
  if (!result.rebased && !result.alreadyIntegrated) {
    return `This workspace is behind ${result.destination}: the destination already contains this workspace's history, so nothing was rebased and nothing changed. Inspect the graph with jj_log and report the situation to the user; do not hand the remaining steps to the user.${cleanupNote} ${cleanup}`;
  }
  if (!result.onTarget) {
    return `The rebase command ran but the stack base is not the resolved destination yet. Inspect the change graph with jj_log and report the change ids; do not hand the remaining steps to the user.${emptySuffix} ${cleanup}`;
  }
  if (result.alreadyIntegrated) {
    return `Nothing to rebase and no conflicts: the stack already sits on ${result.destination}. Report the destination, the change ids, any bookmark outcome and any empty change to the user.${emptySuffix}${cleanupNote} ${cleanup}`;
  }
  return `Rebase finished and verified: the stack now sits directly on ${result.destination}. Report the rebased change ids, the destination, the resolved-by-fallback provenance (destinationSource), any bookmark outcome and any empty change to the user.${emptySuffix}${cleanupNote} ${cleanup}`;
}

/**
 * Model-facing next step for one `jj_amend` result.
 *
 * A successful fold keeps the target change id stable, so the only follow-up that
 * needs instructions is conflict resolution (the model resolves them itself, never
 * the user). A published target never reaches this helper: {@link
 * JjOperations.amend} refuses it before rewriting anything.
 *
 * @param result - the amend result.
 * @returns the next-step text (never empty).
 */
export function amendNextSteps(result: JjAmendResult): string {
  const conflicted = result.rewritten.filter((change) => change.conflict).map((change) => change.changeId);
  if (conflicted.length > 0) {
    return [
      `The correction is folded into ${result.amended.changeId}, but the rewrite left conflicts in ${conflicted.join(', ')}.`,
      'Resolve them yourself: edit the files to their final content, remove the `<<<<<<<` / `%%%%%%%` / `>>>>>>>` marker blocks, run jj_status, then call jj_amend again with the same `into` to verify. Report only a conflict you cannot resolve safely.',
    ].join(' ');
  }
  const note = result.warnings.length > 0 ? ` Warnings: ${result.warnings.join(' ')}` : '';
  const workingCopy = result.workingCopy.empty
    ? 'the working copy is a fresh empty change'
    : 'the working copy still holds the changes outside `paths`';
  return `The correction is now part of ${result.amended.changeId} (change id unchanged); ${result.rewritten.length} descendant${result.rewritten.length === 1 ? '' : 's'} were rebased and ${workingCopy}. Report the amended change id and the rebased changes; later corrections can target the same change until it is pushed.${note}`;
}
