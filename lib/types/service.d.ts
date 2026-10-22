/**
 * jj operations and the `ctx.jj` service (design contract §5.4 / §5.6).
 *
 * {@link JjOperations} holds every jj-native operation; it is pure with respect
 * to the host (one injected {@link RunJj}), which makes the whole operation layer
 * testable against real repositories without mounting Cordis.
 *
 * {@link JjService} is the Cordis face: it owns the TTL cache used by the
 * synchronous guard, the disposal ladder (abort → settle pending → clear cache),
 * and the process-lifetime version cache.
 *
 * @module dsh-jj/service
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { Config, type JjPluginConfig, type ResolvedJjConfig } from './config.ts';
import { type RunJj } from './jj-command.ts';
import type { JjChange, JjOperation, VcsDescriptor, VcsKind } from './types.ts';
/** `jj log -r <rev> --no-graph -T <TPL_STATUS>` template (contract §2.8, verbatim). */
export declare const TPL_STATUS = "\"{\\\"change_id\\\":\" ++ json(change_id) ++ \",\\\"commit_id\\\":\" ++ json(commit_id) ++ \",\\\"description\\\":\" ++ json(description) ++ \",\\\"empty\\\":\" ++ json(empty) ++ \",\\\"conflict\\\":\" ++ json(conflict) ++ \",\\\"current_working_copy\\\":\" ++ json(current_working_copy) ++ \",\\\"bookmarks\\\":\" ++ json(local_bookmarks.map(|b| b.name())) ++ \",\\\"author\\\":\" ++ json(author.email()) ++ \",\\\"paths\\\":\" ++ json(self.diff().files().map(|f| f.path())) ++ \"}\\n\"";
/** `jj log` per-change template (contract §2.8, verbatim). */
export declare const TPL_LOG = "\"{\\\"change_id\\\":\" ++ json(change_id) ++ \",\\\"commit_id\\\":\" ++ json(commit_id) ++ \",\\\"description\\\":\" ++ json(description.first_line()) ++ \",\\\"empty\\\":\" ++ json(empty) ++ \",\\\"conflict\\\":\" ++ json(conflict) ++ \",\\\"current_working_copy\\\":\" ++ json(current_working_copy) ++ \",\\\"bookmarks\\\":\" ++ json(local_bookmarks.map(|b| b.name())) ++ \",\\\"author\\\":\" ++ json(author.email()) ++ \"}\\n\"";
/** `jj workspace list` template used by the tools (tab-separated; names may contain spaces). */
export declare const TPL_WORKSPACE_LIST_TAB = "name ++ \"\\t\" ++ root ++ \"\\n\"";
/**
 * `jj op log` template (contract §7.3.8): `json(self)` exposes id/description/
 * time/username/hostname/workspace_name/is_snapshot/attributes.
 */
export declare const TPL_OP_LOG = "json(self) ++ \"\\n\"";
/** `jj bookmark list` template (contract §7.3.11). */
export declare const TPL_BOOKMARK_LIST = "json(self) ++ \"\\n\"";
/** One jj change, as parsed from the JSON templates. */
export interface JjChangeRecord extends JjChange {
    readonly paths: readonly string[];
}
/** Result of `status()`. */
export interface JjStatusResult {
    readonly change: JjChangeRecord;
    readonly changedPaths: readonly string[];
    readonly diffStat: string;
    readonly raw: string;
    readonly truncated: boolean;
}
/** Result of `undo()`. */
export interface JjUndoResult {
    readonly mode: 'undo' | 'restore';
    readonly operationId: string;
    readonly headOperationId: string;
    readonly message: string;
}
/** Result of `workspaceAdd()`. */
export interface JjWorkspaceAddResult {
    readonly path: string;
    readonly name: string;
    readonly change: JjChangeRecord;
}
/** Every jj-native operation dsh-jj exposes, over one injected runner. */
export declare class JjOperations {
    readonly config: ResolvedJjConfig;
    private readonly runJj;
    constructor(options: {
        runJj: RunJj;
        config?: JjPluginConfig;
    });
    /** Base jj options shared by every call. */
    private options;
    private run;
    /** `jj --version` / `git --version` (the only git call dsh-jj allows). */
    version(cwd: string, signal?: AbortSignal): Promise<{
        jj: string | undefined;
        git: string | undefined;
    }>;
    /** `jj log -r @ --no-graph -T <TPL_STATUS>` plus `jj status`. */
    status(cwd: string, signal?: AbortSignal): Promise<JjStatusResult>;
    /** `jj log -r <revset> --no-graph --limit <n> -T <TPL_LOG>`. */
    log(cwd: string, revset: string, limit: number, signal?: AbortSignal): Promise<readonly JjChangeRecord[]>;
    /** `jj diff -r <revset> (--stat|--git) [-- <paths…>]`. */
    diff(cwd: string, revset: string, format: 'stat' | 'patch', paths: readonly string[], signal?: AbortSignal): Promise<{
        text: string;
        truncated: boolean;
    }>;
    /** `jj new [-m <message>] [<parent>…]` then read back `@`. */
    newChange(cwd: string, parents: readonly string[], message: string | undefined, signal?: AbortSignal): Promise<JjChangeRecord>;
    /** `jj describe -r <revset> -m <message>` then read the revision back. */
    describeChange(cwd: string, revset: string, message: string, signal?: AbortSignal): Promise<JjChangeRecord>;
    /** `jj squash --from <from> --into <into> [-m msg | --use-destination-message]`. */
    squash(cwd: string, from: string, into: string, message: string | undefined, useDestinationMessage: boolean, signal?: AbortSignal): Promise<JjChangeRecord>;
    /** `jj undo` or `jj op restore <operationId>`; records the head operation first. */
    undo(cwd: string, operationId: string | undefined, signal?: AbortSignal): Promise<JjUndoResult>;
    /** `jj op log -n 1 --no-graph -T 'self.id()'` — the self-protection step (contract §8.3b). */
    headOperationId(cwd: string, signal?: AbortSignal): Promise<string>;
    /** `jj op log -n <n> --no-graph -T 'json(self) ++ "\n"'`. */
    opLog(cwd: string, limit: number, signal?: AbortSignal): Promise<readonly JjOperation[]>;
    /** `jj workspace add <path> [--name n] [-r r]… [-m m] [--colocate]`, then read the workspace back. */
    workspaceAdd(cwd: string, path: string, name: string | undefined, parents: readonly string[], message: string | undefined, colocate: boolean | undefined, signal?: AbortSignal): Promise<JjWorkspaceAddResult>;
    /** `jj workspace list -T 'name ++ "\t" ++ root ++ "\n"'`. */
    workspaceList(cwd: string, signal?: AbortSignal): Promise<readonly {
        name: string;
        root: string;
    }[]>;
    /** `jj bookmark list [--all-remotes] -T 'json(self) ++ "\n"'`. */
    bookmarkList(cwd: string, allRemotes: boolean, signal?: AbortSignal): Promise<readonly {
        name: string;
        target: string;
        remote: string | null;
    }[]>;
    /** `jj bookmark set <name> -r <revset> [--allow-backwards]`, then read the target back. */
    bookmarkSet(cwd: string, name: string, revset: string, allowBackwards: boolean, signal?: AbortSignal): Promise<{
        name: string;
        target: string;
        moved: boolean;
    }>;
    /** `jj rebase -r <revision> -d <destination>`. */
    rebase(cwd: string, revision: string, destination: string, signal?: AbortSignal): Promise<string>;
    /** Read `@` (or a revset) as a {@link JjChangeRecord}. */
    private readAt;
}
/** Plugin configuration schema re-exported for the service entry. */
export { Config };
/**
 * `ctx.jj` — the Cordis service face of {@link JjOperations}.
 *
 * The TTL cache is what makes the synchronous guard possible: `peek` never
 * spawns, `warm` refreshes, and disposal aborts in-flight work and clears it.
 */
export declare class JjService extends Service {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        jjCommand: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        gitCommand: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        graceMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        detectCacheTtlMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        guardMutatingGit: import("@deepseek-ai/schemastery").default<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
        guardGitInJjNative: import("@deepseek-ai/schemastery").default<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
        guardJjRepositoryWide: import("@deepseek-ai/schemastery").default<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
        guardTools: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        guardCreateWorktree: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        readOnlyGitNotice: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        preferJjContext: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        defaultLogLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxLogLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        defaultCwd: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        jjCommand: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        gitCommand: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        graceMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputBytes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        detectCacheTtlMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        guardMutatingGit: import("@deepseek-ai/schemastery").default<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
        guardGitInJjNative: import("@deepseek-ai/schemastery").default<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
        guardJjRepositoryWide: import("@deepseek-ai/schemastery").default<"deny" | "warn" | "off", "deny" | "warn" | "off", "defined">;
        guardTools: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        guardCreateWorktree: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        readOnlyGitNotice: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        preferJjContext: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        defaultLogLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxLogLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        defaultCwd: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "plain">;
    readonly operations: JjOperations;
    private readonly lifetime;
    private readonly pending;
    private readonly cache;
    private versionCache;
    constructor(ctx: Context, config?: JjPluginConfig);
    /** Track one in-flight jj call so disposal can settle it. */
    private track;
    /** TTL-cached detection (contract §6.4). */
    detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
    /** Forced refresh of the detection cache. */
    warm(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor>;
    /** Synchronous cache read for the guard; `undefined` on a miss (fail-open). */
    peek(cwd: string): VcsDescriptor | undefined;
    /** Single-line human summary (contract §5.4). */
    describe(target: VcsDescriptor | VcsKind): string;
    /** Process-lifetime version cache. */
    version(cwd: string, signal?: AbortSignal): Promise<{
        jj: string | undefined;
        git: string | undefined;
    }>;
    private cacheKey;
    private detectDeps;
}
