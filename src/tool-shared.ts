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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ResolvedJjConfig } from './config.ts';
import type { WorkspaceOwnership } from './policies.ts';
import type { JjOperations } from './service.ts';
import type { VcsDescriptor } from './types.ts';

/** Structural view of the service the tools need (a live `JjService` satisfies it). */
export interface JjToolService {
  readonly operations: JjOperations;
  /** Per-session workspace ownership, owned by the service (see `WorkspaceOwnership`). */
  readonly workspaceOwnership: WorkspaceOwnership;
  detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
}

/** One live top-level session, as the host enumerates it for workspace-liveness checks. */
export interface JjLiveToolSession {
  /** DSH session id, when the host exposes one. */
  readonly sessionId?: string;
  /** The session object, so the calling agent's own session compares by reference. */
  readonly session?: unknown;
  /** Effective working directory of that session. */
  readonly cwd: string;
}

/** Structural view of the host context used by the tools entry. */
export interface JjToolsHost {
  readonly tools: { register(definition: ToolDefinition): () => void };
  readonly workingDirectory?: {
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    /** Read one session's effective directory (`workingDirectory.get`); optional on older hosts. */
    get?(session: unknown): unknown;
    /** Move one session to another directory (`workingDirectory.set`); optional on older hosts. */
    set?(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
  };
  /**
   * Live top-level sessions of this host, or `undefined` when it cannot enumerate them.
   *
   * Workspace cleanup and the hand-off refuse to unregister/rewrite a workspace another
   * live session is using; the tools fall back to the cross-process heartbeat files when
   * this provider is absent. Must never throw (callers contain failures anyway).
   */
  readonly liveSessions?: () => readonly JjLiveToolSession[];
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

export { canonicalWorkspacePath, isRootWorkspace } from './policies.ts';

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
