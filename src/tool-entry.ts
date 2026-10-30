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
import { resolveConfig, warnMisplacedConfig, type JjPluginConfig } from './config.ts';
import { jjToolDefinitions } from './tool-definitions.ts';
import type { JjToolService, JjToolsHost } from './tool-shared.ts';

/**
 * Read the host logger without touching an unavailable Cordis service property.
 *
 * The tools row injects `tools`/`jj`/`workingDirectory`; `logger` is a built-in context
 * member, but a defensive read keeps a bare test context (no `get`, no `logger`) working.
 */
function hostLogger(ctx: Context): unknown {
  try {
    const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get;
    if (typeof get === 'function') return get.call(ctx, 'logger');
  } catch {
    // Fall through to the optional member read.
  }
  try {
    return (ctx as unknown as { logger?: unknown }).logger;
  } catch {
    return undefined;
  }
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
  const cwdFor = async (exec: { agent?: unknown; signal?: AbortSignal }): Promise<string> => {
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
  // Every row re-exports the same Config, so Cordis accepts keys this row ignores.
  // Warn (never fail) so a key placed on the wrong bundle row is visible.
  warnMisplacedConfig(hostLogger(ctx), config, 'tools');
  const service = (ctx as unknown as { jj: JjToolService }).jj;
  const disposer = registerJjTools(ctx as unknown as JjToolsHost, { service, config });
  const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
  if (typeof effect === 'function') effect.call(ctx, () => () => disposer(), 'dsh-jj: jj tools');
}
