/**
 * Jujutsu (jj) / Git repository detection (design contract §6).
 *
 * Two layers:
 * 1. **Filesystem sniff** ({@link sniffVcsSync}) — a synchronous walk from `cwd`
 *    to the filesystem root that records the *depth* of the nearest `.jj`
 *    directory and the nearest `.git` entry. Depth matters: a Git repository
 *    nested inside a jj workspace owns the current directory (F6, nearest wins),
 *    while a jj workspace inside a Git repository keeps jj as the authority (F5).
 *    A plain `.jj` *file* is not a jj marker (F3).
 * 2. **CLI authority** ({@link detectVcs}) — `jj --ignore-working-copy workspace
 *    list -T <TPL_WORKSPACE_LIST>` is the authority, not `jj root`: a stray empty
 *    `.jj` directory makes `jj root` exit 0 while `workspace list` exits 255
 *    (F2). Git is probed separately and never overrides a jj workspace root (F5),
 *    and `GIT_CEILING_DIRECTORIES` is respected for outer repositories (F7).
 *
 * Failure semantics: a {@link VcsDescriptor} is always returned; problems are
 * reported through `notices` plus `verified === false`. Only programmer errors
 * (a non-function/non-object input) throw.
 *
 * @module dsh-jj/detect
 */
import { type DetectInput, type JjRemote, type JjWorkspaceInfo, type VcsDescriptor, type VcsSniff } from './types.ts';
/** Default probe deadline in milliseconds. */
export declare const DEFAULT_PROBE_TIMEOUT_MS = 5000;
/**
 * `jj workspace list` template (contract §2.8, verbatim).
 *
 * Every record must end with an explicit `"\n"`, otherwise records concatenate.
 * `json(self)` does not carry `root`, and workspace names may contain spaces, so
 * the JSON form is the only safe parse.
 */
export declare const TPL_WORKSPACE_LIST = "\"{\\\"name\\\":\" ++ json(name) ++ \",\\\"root\\\":\" ++ json(root) ++ \"}\\n\"";
/** Environment layered onto every jj probe (non-interactive, no pager, no colour). */
export declare const JJ_PROBE_ENV: Readonly<Record<string, string>>;
/** Environment layered onto every Git probe (non-interactive, no locks taken). */
export declare const GIT_PROBE_ENV: Readonly<Record<string, string>>;
/** Options for {@link sniffVcsSync}. */
export interface SniffOptions {
    /** Maximum number of parent directories to visit (default: unbounded). */
    readonly maxDepth?: number;
}
/** Options for {@link detectVcs} (additive to the contract signature). */
export interface DetectVcsOptions {
    /** Per-probe deadline in milliseconds. */
    readonly timeoutMs?: number;
    /** Extra environment entries layered onto every probe. */
    readonly env?: Readonly<Record<string, string>>;
    /** When false, skip `jj git remote list` (default true). */
    readonly probeRemotes?: boolean;
}
/**
 * Filesystem-only repository sniff: no subprocess, no mutation.
 *
 * @param cwd - directory to classify (resolved against the process cwd).
 * @param options - optional walk bound.
 * @returns sniffed layout with depths, pointer targets, and diagnostics.
 */
export declare function sniffVcsSync(cwd: string, options?: SniffOptions): VcsSniff;
/** One parsed `jj workspace list` record. */
export interface JjWorkspaceEntry extends JjWorkspaceInfo {
}
/**
 * Parse `jj workspace list -T <TPL_WORKSPACE_LIST>` output (one JSON object per line).
 *
 * @param stdout - raw command output.
 * @returns parsed workspaces; malformed lines are skipped.
 */
export declare function parseWorkspaceList(stdout: string): JjWorkspaceInfo[];
/**
 * Parse `jj git remote list` output (`<name> <url>` per line).
 *
 * @param stdout - raw command output.
 * @returns parsed remotes.
 */
export declare function parseRemoteList(stdout: string): JjRemote[];
declare function shorten(text: string, limit?: number): string;
/**
 * Classify the repository that owns `cwd`.
 *
 * @param cwd - directory to classify.
 * @param input - a task-4 `RunCommand` (argv includes the program) or contract-shaped {@link DetectDeps}.
 * @param signal - caller cancellation, forwarded to every probe.
 * @param options - deadline, extra environment, and remote-probe toggle.
 * @returns the descriptor; repository problems are notices, never thrown errors.
 * @throws TypeError when `input` is neither a function nor an object with `runJj`/`runGit`.
 */
export declare function detectVcs(cwd: string, input: DetectInput, signal?: AbortSignal, options?: DetectVcsOptions): Promise<VcsDescriptor>;
/** Re-exported for callers that need the notice shortener. */
export { shorten as boundedText };
