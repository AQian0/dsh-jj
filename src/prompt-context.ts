/**
 * Session-start jj preference context (model-facing).
 *
 * Policy (2026-10-22): a jj workspace PREFERS jj — it does not forbid git. The guard's
 * post-execute notice only helps *after* a model already chose git, so this module puts
 * the preference into the model's own prompt from the first assembly.
 *
 * Shape follows DSH's own repository-fact precedent, `@deepseek-ai/dsh-working-directory`:
 * one **global** `ctx.systemPrompt.context(...)` whose text provider reads
 * `context.agent` (augmented onto `AssembleContext` by `@deepseek-ai/dsh-agent`) and
 * resolves that agent's session directory. One registration therefore covers every agent,
 * every provider, and every model in the profile — subagents included.
 *
 * The provider is synchronous (context text cannot await), which is enough here because
 * both inputs are synchronous: `WorkingDirectoryService.get(session)` and the filesystem
 * sniff. The warmed `ctx.jj` cache is consulted first when it already has an answer.
 * Outside a jj workspace the provider returns `''`, which contributes nothing.
 *
 * Policy (2026-10-30): the same context carries the commit-description policy (inherit
 * the repository's history, ask the user when undecidable, or a configured preset/custom
 * style) and the split-commit workflow. Those strings live in `./commit-style.ts`; this
 * module only decides whether to append them (`commitGuidance`).
 *
 * Policy (2026-10-30, multi-session): when several top-level DSH sessions are live in the
 * same jj project, the context also tells this session to isolate in its own jj workspace
 * before writing and to rebase the finished stack onto the trunk. Detection is injected
 * (`liveRootSessions`) and fail-open; the wording lives in `./multi-session.ts`.
 *
 * Policy refinement (2026-10-30, activity gate): "live" is not "working". The host keeps
 * an Agent alive after its turn ends, so the peer list only counts sessions whose injected
 * activity is not positively idle; sessions that were merely opened earlier no longer make
 * a single session isolate itself in a new jj workspace.
 *
 * @module dsh-jj/prompt-context
 */

import { commitStylePromptText, type CommitStyleId } from './commit-style.ts';
import { sniffVcsSync } from './detect.ts';
import {
  DEFAULT_REBASE_TARGET,
  detectParallelSessions,
  multiSessionFinishChecklistText,
  multiSessionPromptText,
  parallelPeerCwds,
  type JjLiveSession,
  type JjWorkspaceIdentity,
  type JjWorkspaceProbe,
  type MultiSessionGuidanceMode,
  type ParallelSessionDetection,
} from './multi-session.ts';
import type { VcsKind, VcsSniff } from './types.ts';

/** Prompt-context name (unique in its scope; a duplicate registration throws). */
export const JJ_CONTEXT_NAME = 'dsh-jj-workspace';

/** Fallback placement when the host cannot resolve the canonical order. */
export const JJ_CONTEXT_ORDER_FALLBACK = 100;

/** Minimal view of a Cordis context: only inject-free accessors are used. */
export interface JjPromptHost {
  readonly get?: (name: string, strict?: boolean) => unknown;
}

/** The provider's view of the agent for one assembly (`AssembleContext.agent`). */
export interface JjPromptAgent {
  readonly session?: unknown;
}

/** Commit-description/granularity options reflected in the injected context. */
export interface JjPromptCommitOptions {
  /** Inject the description-style and split-commit guidance at all (default true). */
  readonly commitGuidance?: boolean;
  /** `auto` (inherit history) or a configured preset/custom style. */
  readonly commitStyle?: CommitStyleId;
  /** Rules for `commitStyle: 'custom'`. */
  readonly commitStyleCustom?: string;
  /** Recommend a stack of small commits (default true). */
  readonly preferSplitCommits?: boolean;
}

/** Multi-session guidance options reflected in the injected context. */
export interface JjPromptMultiSessionOptions {
  /** `multiSessionGuidance` config: `auto` (default; detect live sessions), `always`, or `off`. */
  readonly multiSessionGuidance?: MultiSessionGuidanceMode;
  /** jj revset used as the end-of-task rebase destination (default `trunk()`). */
  readonly rebaseTarget?: string;
  /**
   * Live top-level DSH sessions, INCLUDING the current one (the current session is
   * recognised by session identity). Omit it when the host cannot enumerate agents;
   * `auto` mode then contributes nothing and `always` stays generic.
   *
   * Set `active: false` for sessions whose agent is known to be idle (its turn ended):
   * they are not concurrent work and never trigger the jj-workspace guidance. Leaving
   * it `undefined` keeps the fail-open behavior and counts the session as a peer.
   */
  readonly liveRootSessions?: () => readonly JjLiveSession[];
}

/**
 * The subset of a cached `VcsDescriptor` (`ctx.jj.peek`) the prompt context needs.
 *
 * `jjRepoPath` is the resolved shared-repository path behind `.jj/repo`: it tells two
 * different workspaces of one repository apart from two unrelated repositories.
 */
export interface JjPeekedDescriptor {
  readonly kind: VcsKind;
  readonly root: string;
  readonly workspaceName?: string;
  readonly jjRepoPath?: string;
}

/** Options for {@link installJjPromptContext}. */
export interface JjPromptContextOptions extends JjPromptCommitOptions, JjPromptMultiSessionOptions {
  /** Sync cached lookup (`ctx.jj.peek`) — consulted before the sniff. */
  readonly peek?: (cwd: string) => JjPeekedDescriptor | undefined;
  /** Injectable sniff for tests. */
  readonly sniff?: (cwd: string) => VcsSniff;
  /** Force a numeric order instead of the canonical `WORKING_DIRECTORY` slot. */
  readonly order?: number;
}

/**
 * Model-facing preference text for one jj workspace.
 *
 * @param kind - jj repository flavour.
 * @param root - workspace root.
 * @param workspaceName - workspace name when known.
 * @param commitOptions - description-style and split-commit guidance (on by default).
 * @returns the multi-line context text.
 */
export function jjPreferenceContextText(
  kind: VcsKind,
  root: string,
  workspaceName?: string,
  commitOptions: JjPromptCommitOptions = {},
): string {
  const place = `${kind}: ${root}${workspaceName !== undefined ? ` (workspace "${workspaceName}")` : ''}`;
  const lines = [
    `This session's working directory is a Jujutsu (jj) workspace (${place}).`,
    'Prefer jj for version control here: use the jj_* tools and jj-native commands (jj status / log / diff / new / commit / describe / squash / undo / op log / bookmark / workspace) and address revisions with revsets and change ids rather than git branch names.',
    "Git still works, but a git write is not recorded in jj's operation log (so `jj undo` cannot take it back) and jj re-imports the result afterwards. Prefer `jj describe` / `jj new` / `jj commit` over `git commit`, and `jj bookmark` over `git branch`.",
  ];
  if (commitOptions.commitGuidance !== false) {
    lines.push(
      commitStylePromptText({
        configured: commitOptions.commitStyle ?? 'auto',
        customStyle: commitOptions.commitStyleCustom ?? '',
        preferSplitCommits: commitOptions.preferSplitCommits ?? true,
      }),
    );
  }
  return lines.join('\n');
}

/**
 * Install the global jj preference prompt context.
 *
 * @param host - context exposing `get` (used for `workingDirectory` and `systemPrompt`).
 * @param options - cached peek, injectable sniff, forced order, commit policy, and the
 *   multi-session source (`liveRootSessions`) plus its mode/rebase target.
 * @returns the disposer that unregisters the context (idempotent, never throws).
 */
export function installJjPromptContext(host: JjPromptHost, options: JjPromptContextOptions = {}): () => void {
  const systemPrompt = host.get?.('systemPrompt') as
    | { context?: (context: unknown) => unknown; getContextOrder?: (name: string) => number }
    | undefined;
  if (typeof systemPrompt?.context !== 'function') return () => {};

  const order =
    options.order ??
    (typeof systemPrompt.getContextOrder === 'function'
      ? systemPrompt.getContextOrder('WORKING_DIRECTORY')
      : JJ_CONTEXT_ORDER_FALLBACK);

  const commitOptions: JjPromptCommitOptions = {
    ...(options.commitGuidance !== undefined ? { commitGuidance: options.commitGuidance } : {}),
    ...(options.commitStyle !== undefined ? { commitStyle: options.commitStyle } : {}),
    ...(options.commitStyleCustom !== undefined ? { commitStyleCustom: options.commitStyleCustom } : {}),
    ...(options.preferSplitCommits !== undefined ? { preferSplitCommits: options.preferSplitCommits } : {}),
  };

  /**
   * Sessions that have already seen a parallel peer. Latching keeps the end-of-task
   * rebase checklist in the context after the peer session ends, so the hand-off
   * reminder is not lost on this session's final turns. Keyed by the live session
   * object (weakly, so ended sessions stay collectable).
   */
  const parallelSeen = new WeakSet<object>();
  const mode = options.multiSessionGuidance ?? 'auto';
  const rebaseTarget = options.rebaseTarget ?? DEFAULT_REBASE_TARGET;
  const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

  /**
   * Resolve one directory to its jj workspace identity, peeking at the warm cache
   * first (no subprocess either way). Failures are contained by the caller.
   */
  const probeWorkspace: JjWorkspaceProbe = (cwd: string): JjWorkspaceIdentity | undefined => {
    const peeked = options.peek?.(cwd);
    if (peeked !== undefined) {
      if (!peeked.kind.startsWith('jj-')) return undefined;
      return {
        workspaceRoot: peeked.root,
        ...(peeked.jjRepoPath !== undefined ? { jjRepoPath: peeked.jjRepoPath } : {}),
      };
    }
    const sniffed = (options.sniff ?? sniffVcsSync)(cwd);
    if (!sniffed.kind.startsWith('jj-')) return undefined;
    return {
      workspaceRoot: sniffed.jjRoot ?? sniffed.cwd,
      ...(sniffed.jjRepoPath !== undefined ? { jjRepoPath: sniffed.jjRepoPath } : {}),
    };
  };

  /** One agent's multi-session applicability plus detection result. */
  interface MultiSessionState {
    /** False when the host enumerates sessions and this agent is not a top-level one. */
    readonly applicable: boolean;
    readonly detection?: ParallelSessionDetection;
  }

  /**
   * Resolve parallel top-level sessions for one agent.
   *
   * Only independent (top-level) sessions count: a subagent's parent and its siblings
   * are not concurrent peers of the shared working copy, so a subagent never receives
   * this guidance (also in `always` mode). Among the top-level sessions, only peers
   * that are not positively idle count as concurrent work ({@link parallelPeerCwds}):
   * the host keeps an Agent alive after its turn ends, so a merely-open session must
   * not make this session isolate in a new jj workspace. Without a session source,
   * detection is unknown but `always` may still contribute its generic section
   * (fail-open).
   */
  const multiSessionStateFor = (session: unknown, identity: JjWorkspaceIdentity): MultiSessionState => {
    const liveRootSessions = options.liveRootSessions;
    if (liveRootSessions === undefined) return { applicable: true };
    const roots = liveRootSessions();
    if (!roots.some((entry) => entry.session === session)) return { applicable: false };
    const peers = parallelPeerCwds(session, roots);
    return { applicable: true, detection: detectParallelSessions(identity, peers, probeWorkspace) };
  };

  const textForAgent = (agent: JjPromptAgent | undefined): string => {
    if (agent === undefined) return '';
    try {
      const workingDirectory = host.get?.('workingDirectory') as { get?: (key: unknown) => unknown } | undefined;
      if (typeof workingDirectory?.get !== 'function') return '';
      const cwd = workingDirectory.get(agent.session);
      if (typeof cwd !== 'string' || cwd.length === 0) return '';

      const peeked = options.peek?.(cwd);
      let kind: VcsKind;
      let root: string;
      let workspaceName: string | undefined;
      let identity: JjWorkspaceIdentity;
      if (peeked !== undefined) {
        if (!peeked.kind.startsWith('jj-')) return '';
        kind = peeked.kind;
        root = peeked.root;
        workspaceName = peeked.workspaceName;
        identity = { workspaceRoot: root, ...(peeked.jjRepoPath !== undefined ? { jjRepoPath: peeked.jjRepoPath } : {}) };
      } else {
        const sniffed = (options.sniff ?? sniffVcsSync)(cwd);
        if (!sniffed.kind.startsWith('jj-')) return '';
        kind = sniffed.kind;
        root = sniffed.jjRoot ?? sniffed.cwd;
        workspaceName = (sniffed as { workspaceName?: string }).workspaceName;
        identity = {
          workspaceRoot: root,
          ...(sniffed.jjRepoPath !== undefined ? { jjRepoPath: sniffed.jjRepoPath } : {}),
        };
      }

      // Multi-session guidance is optional and must never break an assembly.
      let multiSessionText = '';
      try {
        const state = multiSessionStateFor(agent.session, identity);
        if (state.applicable) {
          const seenPeer =
            (state.detection?.sharedWorkspace.length ?? 0) > 0 || (state.detection?.siblingWorkspace.length ?? 0) > 0;
          if (seenPeer && mode !== 'off' && isObject(agent.session)) parallelSeen.add(agent.session);
          multiSessionText = multiSessionPromptText({
            mode,
            ...(state.detection !== undefined ? { detection: state.detection } : {}),
            rebaseTarget,
          });
          // A session that already saw a parallel peer keeps the finish checklist even
          // after the peer ends: that is exactly when its stack is handed off.
          const latched = mode !== 'off' && isObject(agent.session) && parallelSeen.has(agent.session);
          if (multiSessionText.length === 0 && latched) multiSessionText = multiSessionFinishChecklistText(rebaseTarget);
        }
      } catch {
        multiSessionText = '';
      }

      const base = jjPreferenceContextText(kind, root, workspaceName, commitOptions);
      return multiSessionText.length > 0 ? `${base}\n${multiSessionText}` : base;
    } catch {
      // A prompt contribution must never break an assembly.
      return '';
    }
  };

  let disposed = false;
  try {
    const unregister = systemPrompt.context({
      name: JJ_CONTEXT_NAME,
      order,
      // Optional context: dropped when a deployment disables runtime-context snapshots.
      required: false,
      // Literal text: never interpolate `{{…}}` that a repository path could contain.
      interpolate: false,
      text: (context: { agent?: JjPromptAgent } | undefined) => textForAgent(context?.agent),
    });
    return () => {
      if (disposed) return;
      disposed = true;
      if (typeof unregister === 'function') {
        try {
          (unregister as () => void)();
        } catch {
          // Teardown must not throw.
        }
      }
    };
  } catch {
    // Duplicate registration or an incompatible host: the notice is optional.
    return () => {};
  }
}