/**
 * `dsh-jj/tools` plugin entry (Cordis name `jj-tools`, design contract §4.1b).
 *
 * Registers every `jj_*` tool on the host `tools` service and owns the session
 * working-directory resolver; the definitions themselves live in
 * `tool-definitions.ts`, shared context types and text in `tool-shared.ts`.
 *
 * @module dsh-jj/tool-entry
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  assertScopedConfig,
  assertServiceableConfig,
  configSchemaFor,
  resolveConfig,
  type JjPluginConfig,
} from './config.ts';
import { evaluateJjToolSandbox, jjToolDefinitions } from './tool-definitions.ts';
import type { JjLiveToolSession, JjToolService, JjToolsHost, ToolContext, ToolExec } from './tool-shared.ts';

/**
 * Build the live-session provider the workspace tools use for liveness decisions.
 *
 * Reads `ctx.agents` and `workingDirectory` tolerantly (the same pattern as the runtime
 * entry): a profile without those services yields an empty list instead of breaking the
 * tools. The provider never throws; failures degrade to "cannot enumerate", and the
 * cross-process heartbeat files remain the other liveness source.
 *
 * @param ctx - live Cordis context of the tools row.
 * @returns a provider of live top-level sessions.
 */
function liveSessionsProvider(ctx: Context): () => readonly JjLiveToolSession[] {
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get;
  if (typeof get !== 'function') return () => [];
  const readService = <T>(name: string): T | undefined => {
    try {
      return get.call(ctx, name) as T | undefined;
    } catch {
      return undefined;
    }
  };
  return () => {
    const sessions: JjLiveToolSession[] = [];
    let roots: readonly { session?: unknown }[] | undefined;
    try {
      roots = readService<{ roots?: () => readonly { session?: unknown }[] }>('agents')?.roots?.();
    } catch {
      roots = undefined;
    }
    if (!Array.isArray(roots)) return sessions;
    const workingDirectory = readService<{ get?: (session: unknown) => unknown }>('workingDirectory');
    for (const entry of roots) {
      const session = entry?.session;
      if (session === undefined) continue;
      let cwd: unknown;
      try {
        cwd = workingDirectory?.get?.(session);
      } catch {
        continue;
      }
      if (typeof cwd !== 'string' || cwd.length === 0) continue;
      const id = (session as { id?: unknown }).id;
      sessions.push({
        session,
        ...(typeof id === 'string' && id.length > 0 ? { sessionId: id } : {}),
        cwd,
      });
    }
    return sessions;
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
  /**
   * Resolve the directory one tool call runs in.
   *
   * With a calling agent, the session directory is authoritative and a failed
   * resolution is an error: guessing `defaultCwd`/`process.cwd()` could run jj in
   * the wrong repository (the tools entry declares `workingDirectory` as required).
   * `defaultCwd` remains the documented path only for calls without an agent
   * (tests/embedders).
   */
  const cwdFor = async (exec: ToolExec): Promise<string> => {
    const fallback = config.defaultCwd.length > 0 ? config.defaultCwd : process.cwd();
    if (exec.agent === undefined) return fallback;
    if (host.workingDirectory === undefined) {
      throw new Error(
        'dsh-jj: cannot resolve the session working directory (the host exposes no workingDirectory service); ' +
          'refusing to guess a repository. Fix the host wiring or configure `defaultCwd` for agent-less calls.',
      );
    }
    try {
      const cwd = await host.workingDirectory.ensure(exec.agent, exec.signal);
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
      throw new Error('the workingDirectory service returned an empty path');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `dsh-jj: cannot resolve the session working directory (${reason}); ` +
          'refusing to run jj in a guessed repository. Fix the session working directory and retry.',
      );
    }
  };
  const preCheckedExecs = new WeakSet<object>();
  const preCheckedCallIds = new Set<string>();
  const toolContext: ToolContext = {
    service: options.service,
    config,
    host,
    cwdFor,
    preCheckedExecs,
    preCheckedCallIds,
  };
  const definitions = jjToolDefinitions(toolContext);
  const registeredNames = new Set(definitions.map((definition) => definition.name));
  const disposers = definitions.map((definition) => host.tools.register(definition));

  let preExecuteDispose: (() => void) | undefined;
  if (typeof host.on === 'function') {
    try {
      const listenerDispose = host.on('tools/pre-execute', async (rawExec: unknown, rawNext: unknown) => {
        const next =
          typeof rawNext === 'function'
            ? (rawNext as () => Promise<unknown>)
            : () => Promise.resolve({ kind: 'allow' });
        if (typeof rawExec !== 'object' || rawExec === null) return await next();
        const execRecord = rawExec as {
          readonly name?: unknown;
          readonly arguments?: unknown;
          readonly agent?: unknown;
          readonly callId?: unknown;
          readonly signal?: unknown;
        };
        const toolName = typeof execRecord.name === 'string' ? execRecord.name : '';
        if (!registeredNames.has(toolName)) return await next();
        const downstream = await next();
        if (
          typeof downstream === 'object' &&
          downstream !== null &&
          'kind' in downstream &&
          (downstream as { kind?: unknown }).kind !== 'allow'
        ) {
          return downstream;
        }
        const exec: ToolExec = {
          ...(execRecord.agent !== undefined ? { agent: execRecord.agent } : {}),
          ...(typeof execRecord.callId === 'string' ? { callId: execRecord.callId } : {}),
          ...(execRecord.signal instanceof AbortSignal ? { signal: execRecord.signal } : {}),
        };
        const decision = await evaluateJjToolSandbox(toolContext, toolName, execRecord.arguments, exec);
        preCheckedExecs.add(rawExec);
        if (typeof execRecord.callId === 'string' && execRecord.callId.length > 0) {
          preCheckedCallIds.add(execRecord.callId);
          if (preCheckedCallIds.size > 512) {
            const oldest = preCheckedCallIds.values().next();
            if (!oldest.done) preCheckedCallIds.delete(oldest.value);
          }
        }
        if (decision.kind === 'ask') return decision;
        return downstream ?? { kind: 'allow' };
      });
      if (typeof listenerDispose === 'function') preExecuteDispose = listenerDispose as () => void;
    } catch {
      // Hosts without a compatible waterfall API still enforce the gate inside `withSandboxGate`.
    }
  }

  return () => {
    try {
      preExecuteDispose?.();
    } catch {
      // Unregistration must not throw during teardown.
    }
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

/** Configuration schema of the tools row (the keys this row reads). */
export const Config = configSchemaFor('tools');

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
  // Validate before installing anything: an invalid profile config must fail at boot,
  // like the runtime/guard entries, instead of surfacing at tool-call time (for example
  // `maxLogLimit: 0` silently clamping jj_log to one entry).
  assertServiceableConfig(resolveConfig(config));
  // Scoped schema: a key owned by another row is a configuration mistake, not a value
  // this row silently ignores.
  assertScopedConfig(config, 'tools');
  const service = (ctx as unknown as { jj: JjToolService }).jj;
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get;
  const readOptionalService = <T>(serviceName: string): T | undefined => {
    if (typeof get !== 'function') return undefined;
    try {
      return get.call(ctx, serviceName) as T | undefined;
    } catch {
      return undefined;
    }
  };
  const rawOn = (ctx as unknown as { on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown }).on;
  // Build an explicit host view: the tools need `workingDirectory.get`, `sandboxPolicy`,
  // `approval`, and the live session list, and optional Cordis services must be read
  // tolerantly without expanding `inject`.
  const view = ctx as unknown as JjToolsHost;
  const host: JjToolsHost = {
    tools: view.tools,
    ...(view.workingDirectory !== undefined ? { workingDirectory: view.workingDirectory } : {}),
    ...(typeof rawOn === 'function' ? { on: rawOn.bind(ctx) } : {}),
    get sandboxPolicy() {
      return readOptionalService<JjToolsHost['sandboxPolicy']>('sandboxPolicy');
    },
    get approval() {
      return readOptionalService<JjToolsHost['approval']>('approval');
    },
    liveSessions: liveSessionsProvider(ctx),
  };
  const disposer = registerJjTools(host, { service, config });
  const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
  if (typeof effect === 'function') effect.call(ctx, () => () => disposer(), 'dsh-jj: jj tools');
}
