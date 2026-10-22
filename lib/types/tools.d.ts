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
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { Config, type JjPluginConfig, type ResolvedJjConfig } from './config.ts';
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
    readonly tools: {
        register(definition: ToolDefinition): () => void;
    };
    readonly workingDirectory?: {
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    };
}
/** Refusal text for a directory that is not a usable jj workspace (contract §7.4). */
export declare function jjRefusalText(descriptor: VcsDescriptor, cwd: string, jjCommand?: string): string;
interface ToolContext {
    readonly service: JjToolService;
    readonly config: ResolvedJjConfig;
    readonly host: JjToolsHost;
    readonly cwdFor: (exec: {
        agent?: unknown;
        signal?: AbortSignal;
    }) => Promise<string>;
}
/**
 * Build every `jj_*` tool definition (contract §7.3).
 *
 * @param context - service access, resolved config, host, and the cwd resolver.
 * @returns the 13 tool definitions in a stable order.
 */
export declare function jjToolDefinitions(context: ToolContext): ToolDefinition[];
/**
 * Register every `jj_*` tool.
 *
 * @param host - context providing `tools` (and optionally `workingDirectory`).
 * @param options - service plus partial plugin config.
 * @returns one disposer that unregisters every tool.
 */
export declare function registerJjTools(host: JjToolsHost, options: {
    service: JjToolService;
    config?: JjPluginConfig;
}): () => void;
/** Cordis plugin name for the tools entry. */
export declare const name = "jj-tools";
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
export declare const inject: readonly ["tools", "jj", "workingDirectory"];
/**
 * Install the tools entry on a Cordis context.
 *
 * @param ctx - context providing `tools`, the `jj` service, and `workingDirectory`.
 * @param config - partial plugin configuration.
 */
export declare function apply(ctx: Context, config?: JjPluginConfig): void;
