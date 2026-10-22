/**
 * Plugin configuration and its defaults (design contract §5.2).
 *
 * Every entry point (`dsh-jj`, `dsh-jj/tools`, `dsh-jj/guard`) re-exports the
 * same schemastery `Config`, so an invalid profile config is rejected by the
 * Cordis loader before `apply` runs.
 *
 * @module dsh-jj/config
 */
import z from '@deepseek-ai/schemastery';
/** Cordis config schema for every dsh-jj entry point. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    jjCommand: z<string, string, "defined">;
    gitCommand: z<string, string, "defined">;
    timeoutMs: z<number, number, "defined">;
    graceMs: z<number, number, "defined">;
    maxOutputBytes: z<number, number, "defined">;
    detectCacheTtlMs: z<number, number, "defined">;
    guardMutatingGit: z<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
    guardGitInJjNative: z<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
    guardJjRepositoryWide: z<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
    guardTools: z<string[], string[], "defined">;
    guardCreateWorktree: z<boolean, boolean, "defined">;
    readOnlyGitNotice: z<boolean, boolean, "defined">;
    preferJjContext: z<boolean, boolean, "defined">;
    defaultLogLimit: z<number, number, "defined">;
    maxLogLimit: z<number, number, "defined">;
    defaultCwd: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    jjCommand: z<string, string, "defined">;
    gitCommand: z<string, string, "defined">;
    timeoutMs: z<number, number, "defined">;
    graceMs: z<number, number, "defined">;
    maxOutputBytes: z<number, number, "defined">;
    detectCacheTtlMs: z<number, number, "defined">;
    guardMutatingGit: z<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
    guardGitInJjNative: z<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
    guardJjRepositoryWide: z<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
    guardTools: z<string[], string[], "defined">;
    guardCreateWorktree: z<boolean, boolean, "defined">;
    readOnlyGitNotice: z<boolean, boolean, "defined">;
    preferJjContext: z<boolean, boolean, "defined">;
    defaultLogLimit: z<number, number, "defined">;
    maxLogLimit: z<number, number, "defined">;
    defaultCwd: z<string, string, "defined">;
}>>, "plain">;
/** Plugin configuration accepted by `apply` (every key optional; defaults from {@link Config}). */
export interface JjPluginConfig {
    readonly jjCommand?: string;
    readonly gitCommand?: string;
    readonly timeoutMs?: number;
    readonly graceMs?: number;
    readonly maxOutputBytes?: number;
    readonly detectCacheTtlMs?: number;
    readonly guardMutatingGit?: 'deny' | 'warn' | 'off';
    readonly guardGitInJjNative?: 'warn' | 'deny' | 'off';
    /** Treatment of repository-wide jj commands (`jj undo`, `jj op restore`, …) in shell tools (default warn). */
    readonly guardJjRepositoryWide?: 'warn' | 'deny' | 'off';
    readonly guardTools?: readonly string[];
    readonly guardCreateWorktree?: boolean;
    readonly readOnlyGitNotice?: boolean;
    readonly preferJjContext?: boolean;
    readonly defaultLogLimit?: number;
    readonly maxLogLimit?: number;
    readonly defaultCwd?: string;
}
/** Configuration with every default applied. */
export interface ResolvedJjConfig {
    readonly jjCommand: string;
    readonly gitCommand: string;
    readonly timeoutMs: number;
    readonly graceMs: number;
    readonly maxOutputBytes: number;
    readonly detectCacheTtlMs: number;
    readonly guardMutatingGit: 'deny' | 'warn' | 'off';
    readonly guardGitInJjNative: 'warn' | 'deny' | 'off';
    readonly guardJjRepositoryWide: 'warn' | 'deny' | 'off';
    readonly guardTools: readonly string[];
    readonly guardCreateWorktree: boolean;
    readonly readOnlyGitNotice: boolean;
    readonly preferJjContext: boolean;
    readonly defaultLogLimit: number;
    readonly maxLogLimit: number;
    readonly defaultCwd: string;
}
/** Hard upper bound accepted for timer-valued keys (mirrors DSH MAX_TIMER_DELAY_MS). */
export declare const MAX_TIMER_DELAY_MS = 2147483647;
/**
 * Apply contract defaults to a partial config.
 *
 * @param config - partial plugin config (already schema-validated when loaded by Cordis).
 * @returns a fully populated configuration.
 */
export declare function resolveConfig(config?: JjPluginConfig): ResolvedJjConfig;
/**
 * Construction-time validation (contract §5.2 MUST): non-empty commands and
 * positive finite timing values.
 *
 * @param config - resolved configuration.
 * @throws Error naming the offending key.
 */
export declare function assertServiceableConfig(config: ResolvedJjConfig): void;
