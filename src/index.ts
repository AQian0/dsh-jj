/**
 * dsh-jj runtime entry (`dsh-jj` bundle row).
 *
 * The base layer owns repository detection and the `ctx.jj` service (`name: 'jj'`).
 * The `jj_*` tools and the git-confusion guard are separate bundle rows
 * (`dsh-jj/tools`, `dsh-jj/guard`) that consume the service. `apply` therefore does
 * not install the guard: a profile that wants protection must load the
 * `dsh-jj/guard` row (the shipped `cordis.patch.yml` always does).
 * {@link assembleBaseLayer} is exported for tests/embedders that assemble the guard
 * around a bare context without Cordis; production loads use the guard row.
 *
 * @module dsh-jj
 */

import type { Context } from '@deepseek-ai/cordis';
import type { VcsKind } from './types.ts';
// Type-only: loads the `@deepseek-ai/dsh-tools` module augmentation that adds `ctx.tools`.
import type {} from '@deepseek-ai/dsh-tools';
import {
  assertScopedConfig,
  assertServiceableConfig,
  configSchemaFor,
  resolveConfig,
  type JjPluginConfig,
} from './config.ts';
import {
  installGitConfusionGuard,
  type GitConfusionGuardHandle,
  type GuardServiceLike,
  type ToolGuardHost,
} from './guard.ts';
import type { JjLiveSession } from './multi-session.ts';
import { sniffVcsSync } from './detect.ts';
import { readSessionHeartbeats, removeSessionHeartbeat, writeSessionHeartbeat } from './session-heartbeat.ts';
import { registerJjPanelRoutes, type JjPanelRouteHost } from './panel-host.ts';
import { installJjPromptContext } from './prompt-context.ts';
import { JjService } from './service.ts';

/** The subset of a cached `ctx.jj` descriptor the heartbeat needs. */
interface JjPeekedDescriptorLike {
  readonly kind: string;
  readonly root: string;
  readonly workspaceName?: string;
  readonly jjRepoPath?: string;
}

/** Cordis plugin name (bare package name so a bundle row can resolve it). */
export const name = 'jj';

/** Services required before `apply` runs (the tools layer adds `tools`-dependent work). */
export const inject = ['subprocess', 'workingDirectory'] as const;

/**
 * Configuration schema of the runtime row.
 *
 * Every bundle row exports its own scoped schema ({@link configSchemaFor}); this is the
 * runtime row's projection of the union, so a profile editor shows exactly the keys
 * this row reads.
 */
export const Config = configSchemaFor('runtime');
export type { JjPluginConfig };

/**
 * Build the guard host view from a live Cordis context (keeps the `tools.guard`
 * check real).
 *
 * Returns `undefined` when this profile did not mount a tool registry: reading an
 * unavailable service through the Cordis proxy can throw, and a profile that only
 * installs `dsh-jj` must still boot. The caller then installs no guard instead of
 * failing the profile.
 */
function guardHostFrom(ctx: Context): ToolGuardHost | undefined {
  let tools: unknown;
  try {
    tools = (ctx as unknown as { tools?: unknown }).tools;
  } catch {
    tools = undefined;
  }
  if (typeof (tools as { guard?: unknown } | undefined)?.guard !== 'function') return undefined;
  const view = ctx as unknown as {
    on?: (...args: unknown[]) => unknown;
    logger?: unknown;
    emit?: unknown;
    workingDirectory?: unknown;
  };
  const rawOn = view.on;
  return {
    tools: tools as ToolGuardHost['tools'],
    ...(typeof rawOn === 'function'
      ? {
          on: (event: string, listener: (...args: unknown[]) => unknown) => rawOn.call(ctx, event, listener),
        }
      : {}),
    ...(view.logger !== undefined ? { logger: view.logger } : {}),
    ...(view.emit !== undefined ? { emit: view.emit } : {}),
    ...(view.workingDirectory !== undefined ? { workingDirectory: view.workingDirectory } : {}),
  };
}

/** Best-effort warning when the guard cannot be installed. */
function warnMissingTools(ctx: Context): void {
  try {
    const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger;
    logger?.warn?.('dsh-jj: the tools service is unavailable; the git-confusion guard was not installed.');
  } catch {
    // Logging must never break plugin startup.
  }
}

/**
 * Assemble the base layer (configuration validation plus the git-confusion guard).
 *
 * This is a test/embedding helper: the production profile installs the guard through
 * the dedicated `dsh-jj/guard` row, and the runtime `apply` below does not call it.
 *
 * @param ctx - live Cordis context.
 * @param config - partial plugin configuration.
 * @returns the guard handle (also callable as its own disposer), or `undefined`
 *   when the profile mounted no tool registry.
 */
export function assembleBaseLayer(ctx: Context, config: JjPluginConfig = {}): GitConfusionGuardHandle | undefined {
  const resolved = resolveConfig(config);
  assertServiceableConfig(resolved);
  const host = guardHostFrom(ctx);
  if (host === undefined) {
    warnMissingTools(ctx);
    return undefined;
  }
  const service = (ctx as unknown as { jj?: GuardServiceLike }).jj;
  return installGitConfusionGuard(host, { config, ...(service !== undefined ? { service } : {}) });
}

/**
 * Install the plugin on a Cordis context.
 *
 * @param ctx - live context providing `subprocess`, `workingDirectory`, and `tools`.
 * @param config - partial plugin configuration; every key is optional.
 */
export function apply(ctx: Context, config: JjPluginConfig = {}): void {
  // Entry one (`dsh-jj`) owns the service and detection; the tools and guard
  // entries consume `ctx.jj` (contract §4.1b). Registering the service here is
  // what makes `inject: ['tools','jj']` loadable for the other two rows.
  const resolved = resolveConfig(config);
  assertServiceableConfig(resolved);
  const jjService = new JjService(ctx, config);
  // Session-start preference (policy 2026-10-22): the model is told, in its own prompt,
  // that this workspace is a jj one and that jj is preferred. Registered globally with a
  // provider reading `AssembleContext.agent` — the pattern DSH's own
  // `dsh-working-directory` uses — so one registration covers every agent and model.
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get;
  /** Tolerant service read: an absent or mid-unload service must not break prompt assembly. */
  const readService = <T>(name: string): T | undefined => {
    try {
      return get?.call(ctx, name) as T | undefined;
    } catch {
      return undefined;
    }
  };
  // Each row validates its own scoped schema; a key belonging to another row is a
  // configuration mistake, so fail construction with a message naming that row instead
  // of silently ignoring the value here.
  assertScopedConfig(config, 'runtime');
  /**
   * Whether one live session's agent is inside an open turn right now.
   *
   * A live Agent outlives its turn: the host resumes GUI sessions for the lifetime of
   * the app and does not dispose the Agent when the user switches away, so presence in
   * `agents.roots()` alone cannot tell concurrent work from a chat the user opened
   * earlier. `dsh-agent-loop` registers the `turnBoundary` session projection;
   * `openTurnStartSeq` is null between turns and a sequence number while a turn is open
   * (including one waiting for an approval or an answer). Reading it is synchronous and
   * adds no peer dependency: the lookup is contained, and a host without the projection
   * reports `undefined`, which keeps the guidance fail-open.
   */
  const sessionIsActive = (session: unknown): boolean | undefined => {
    const projections = readService<{ stateOf?: (session: unknown, key: string) => unknown }>('sessionProjections');
    if (typeof projections?.stateOf !== 'function') return undefined;
    let state: unknown;
    try {
      state = projections.stateOf(session, 'turnBoundary');
    } catch {
      return undefined;
    }
    if (state === null || typeof state !== 'object') return undefined;
    const openTurnStartSeq = (state as { openTurnStartSeq?: unknown }).openTurnStartSeq;
    // A missing field is an unexpected projection shape: stay fail-open.
    if (openTurnStartSeq === undefined) return undefined;
    return openTurnStartSeq !== null;
  };
  /**
   * Enumerate the live TOP-LEVEL DSH sessions with their effective working directories
   * and whether each is inside an open turn.
   *
   * `ctx.agents.roots()` returns independent user sessions only (subagents are created
   * with an owning parent and therefore never appear here). This is what lets the prompt
   * context tell whether another session is working in the same jj project, without a
   * subprocess: the agent registry, `workingDirectory.get`, and the `turnBoundary`
   * projection are all synchronous. Missing services (older hosts, headless assemblies)
   * simply yield no detection; missing activity reporting stays fail-open in the prompt
   * context (a peer of unknown state is still treated as possibly parallel).
   */
  /** Structural read of a session id (opaque to the host interfaces used here). */
  const sessionIdOf = (session: unknown): string | undefined => {
    const id = (session as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  };
  /** Synchronous identity read for the heartbeat: warm cache first, then the filesystem sniff. */
  const workspaceIdentityOf = (
    cwd: string,
  ): { readonly workspaceRoot: string; readonly workspaceName: string; readonly jjRepoPath?: string } | undefined => {
    const peeked = (() => {
      try {
        return (
          readService<{ peek?: (cwd: string) => JjPeekedDescriptorLike | undefined }>('jj')?.peek?.(cwd) ?? undefined
        );
      } catch {
        return undefined;
      }
    })();
    if (peeked !== undefined) {
      if (!peeked.kind.startsWith('jj-')) return undefined;
      return {
        workspaceRoot: peeked.root,
        workspaceName: peeked.workspaceName ?? 'default',
        ...(peeked.jjRepoPath !== undefined ? { jjRepoPath: peeked.jjRepoPath } : {}),
      };
    }
    const sniffed = sniffVcsSync(cwd);
    if (!sniffed.kind.startsWith('jj-')) return undefined;
    return {
      workspaceRoot: sniffed.jjRoot ?? sniffed.cwd,
      workspaceName: 'default',
      ...(sniffed.jjRepoPath !== undefined ? { jjRepoPath: sniffed.jjRepoPath } : {}),
    };
  };
  /**
   * Live top-level sessions, both in this process and in other `dsh` processes.
   *
   * In-process agents are authoritative for activity; sessions in other processes are
   * known from the repository heartbeat files, which each session refreshes while its
   * prompt is assembled. Heartbeat peers are synthesised as opaque session objects: they
   * are never the current session, and their id is only used for display-free matching.
   */
  const liveRootSessions = (cwd: string, current: unknown): readonly JjLiveSession[] => {
    const sessions: JjLiveSession[] = [];
    const agents = readService<{ roots?: () => readonly { session?: unknown }[] }>('agents');
    let roots: readonly { session?: unknown }[] | undefined;
    try {
      roots = agents?.roots?.();
    } catch {
      roots = [];
    }
    const workingDirectory = readService<{ get?: (session: unknown) => unknown }>('workingDirectory');
    if (Array.isArray(roots) && typeof workingDirectory?.get === 'function') {
      for (const entry of roots) {
        const session = entry?.session;
        if (session === undefined) continue;
        let peerCwd: unknown;
        try {
          peerCwd = workingDirectory.get(session);
        } catch {
          continue;
        }
        if (typeof peerCwd !== 'string' || peerCwd.length === 0) continue;
        const active = sessionIsActive(session);
        sessions.push({ session, cwd: peerCwd, ...(active !== undefined ? { active } : {}) });
      }
    }
    const identity = workspaceIdentityOf(cwd);
    if (identity?.jjRepoPath === undefined) return sessions;
    const currentId = sessionIdOf(current);
    for (const heartbeat of readSessionHeartbeats(identity.jjRepoPath, {
      now: Date.now(),
      ...(currentId !== undefined ? { excludeSessionId: currentId } : {}),
    })) {
      sessions.push({
        session: { id: heartbeat.sessionId, heartbeat: true },
        cwd: heartbeat.cwd,
        ...(heartbeat.active !== undefined ? { active: heartbeat.active } : {}),
      });
    }
    return sessions;
  };
  /** Heartbeats written by this process, for disposal. */
  const writtenHeartbeats = new Set<string>();
  /**
   * Install the session prompt context, reading `systemPrompt` through the host view.
   *
   * Split out of {@link apply} so it can run whenever the `systemPrompt` service
   * becomes available instead of only during `apply`.
   */
  const installPromptContext = (): (() => void) => {
    if (!resolved.preferJjContext) return () => {};
    return installJjPromptContext(
      { get: typeof get === 'function' ? get.bind(ctx) : undefined },
      {
        peek: (cwd) => {
          try {
            const service = get?.call(ctx, 'jj') as
              | {
                  peek?: (cwd: string) =>
                    | {
                        kind: VcsKind;
                        root: string;
                        workspaceName?: string;
                        jjRepoPath?: string;
                      }
                    | undefined;
                }
              | undefined;
            return service?.peek?.(cwd);
          } catch {
            return undefined;
          }
        },
        // Commit-description handling (policy 2026-10-30): inherit the repository's
        // description style by default, ask the user when history cannot decide, and
        // prefer a stack of small commits; a configured preset/custom style wins.
        commitGuidance: resolved.commitGuidance,
        commitStyle: resolved.commitStyle,
        commitStyleCustom: resolved.commitStyleCustom,
        preferSplitCommits: resolved.preferSplitCommits,
        preferAmendCorrections: resolved.preferAmendCorrections,
        // Multi-session handling (policy 2026-10-30): when a parallel top-level session
        // shares the project, ask this session to isolate in its own jj workspace and to
        // rebase the finished stack onto `rebaseTarget`.
        multiSessionGuidance: resolved.multiSessionGuidance,
        rebaseTarget: resolved.rebaseTarget,
        liveRootSessions,
        // Refresh this session's cross-process heartbeat whenever its prompt is
        // assembled: other DSH processes read it to detect parallel work in the same
        // repository without a shared process.
        onAssemble: ({ agent, cwd, workspace }) => {
          const sessionId = sessionIdOf(agent);
          if (sessionId === undefined || workspace.jjRepoPath === undefined) return;
          const active = sessionIsActive(agent);
          const written = writeSessionHeartbeat(workspace.jjRepoPath, {
            sessionId,
            cwd,
            workspaceName: workspace.workspaceName ?? 'default',
            workspaceRoot: workspace.workspaceRoot,
            updatedAt: Date.now(),
            ...(active !== undefined ? { active } : {}),
          });
          if (written) writtenHeartbeats.add(`${workspace.jjRepoPath}\u0000${sessionId}`);
        },
      },
    );
  };
  // Remove the heartbeats this process wrote when the runtime row unloads, so other
  // processes stop seeing this session immediately instead of waiting for the TTL.
  const registerEffect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
  if (typeof registerEffect === 'function') {
    registerEffect.call(
      ctx,
      () => () => {
        for (const entry of writtenHeartbeats) {
          const separator = entry.indexOf('\u0000');
          if (separator < 0) continue;
          removeSessionHeartbeat(entry.slice(0, separator), entry.slice(separator + 1));
        }
        writtenHeartbeats.clear();
      },
      'dsh-jj: session heartbeats',
    );
  }
  // The service set of a profile is not ordered: the Cordis loader boots every bundle
  // row concurrently and a row only waits for the services it declares in `inject`.
  // Reading `systemPrompt` once during `apply` would silently skip the jj session
  // context whenever the system-prompt provider finishes later. When the service is
  // already available the context is registered synchronously (exactly as before);
  // when it is not, a child fiber registered through `ctx.inject` installs it as soon
  // as the service appears (and re-registers after a service reload), disposing with
  // this row. `inject` is deliberately NOT added to the row's static inject list:
  // profiles without `systemPrompt` must keep booting (the context is optional).
  const systemPromptAvailable = (): boolean => {
    const service = readService<{ context?: unknown }>('systemPrompt');
    return typeof service?.context === 'function';
  };
  const inject = (ctx as unknown as { inject?: (names: readonly string[], callback: () => () => void) => unknown })
    .inject;
  const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
  if (systemPromptAvailable() || typeof inject !== 'function') {
    // Available now, or no child-fiber support (bare test doubles): the original eager
    // registration. A missing systemPrompt makes `installJjPromptContext` a no-op.
    if (typeof effect === 'function') effect.call(ctx, installPromptContext, 'dsh-jj: jj prompt context');
  } else {
    try {
      inject.call(ctx, ['systemPrompt'], installPromptContext);
    } catch {
      if (typeof effect === 'function') effect.call(ctx, installPromptContext, 'dsh-jj: jj prompt context');
    }
  }
  // Web panel (read-only): the routes exist only when the Host has a connection service
  // and `uiPanel` is not `off`. Headless profiles simply have no `connection`, and a
  // panel failure must never affect the session.
  //
  // The service set is not ordered: this row applies early (the base bundle), while the
  // Web app's `connection` row applies later, so reading it once here was a race that
  // left the panel routes unregistered and the tab showing "could not read jj status".
  // A child fiber through `ctx.inject` installs the routes as soon as `connection`
  // appears (and re-installs them after a service reload), exactly like `systemPrompt`.
  if (resolved.uiPanel === 'auto') {
    const installPanelRoutes = (): (() => void) => {
      const connection = readService<JjPanelRouteHost>('connection');
      if (connection?.fetch === undefined || typeof connection.fetch.register !== 'function') {
        return () => {};
      }
      try {
        return registerJjPanelRoutes(connection, { service: jjService, enabled: true });
      } catch {
        return () => {};
      }
    };
    const hasConnection = (): boolean => {
      const connection = readService<JjPanelRouteHost>('connection');
      return connection?.fetch !== undefined && typeof connection.fetch.register === 'function';
    };
    if (hasConnection() || typeof inject !== 'function') {
      if (typeof registerEffect === 'function') {
        registerEffect.call(ctx, installPanelRoutes, 'dsh-jj: panel routes');
      }
    } else {
      try {
        inject.call(ctx, ['connection'], installPanelRoutes);
      } catch {
        // A missing connection degrades the panel, never the runtime row.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry surface
//
// The root entry exports the bundle contract (name/inject/apply/Config) plus the
// service and the embed helper. Everything else lives on its own subpath
// (./service, ./jj-command, ./tools, ./guard, ./changes, ./detect, ./git-command,
// ./commit-style, ./multi-session, ./prompt-context): a component's implementation
// must not leak through the runtime row's module, because that is what turns one
// component into a façade over all the others.
// ---------------------------------------------------------------------------

export { JjService } from './service.ts';
export { describeVcsKind } from './types.ts';

export type { ResolvedJjConfig } from './config.ts';
export type {
  JjChange,
  JjOperation,
  JjRunResult,
  RunCommand,
  RunCommandOptions,
  RunJj,
  RunJjOptions,
  RunResult,
  VcsDescriptor,
  VcsEvidenceSource,
  VcsKind,
  VcsNotice,
  VcsNoticeCode,
  VcsSniff,
} from './types.ts';
export type { DetectionConfidence } from './types.ts';
export type { GitConfusionGuardHandle, GuardOptions } from './guard.ts';
