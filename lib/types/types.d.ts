/**
 * Shared vocabulary for first-class Jujutsu (jj) support in DeepSeek Harness.
 *
 * Types follow the design contract (§5.3) and add a few documented extras used
 * by the base layer (severity on notices, detection confidence, availability
 * flags). Pure declarations: no I/O, no subprocess.
 *
 * Terminology (jj 0.46): `jj root` is documented as a shortcut for
 * `jj workspace root`, so a jj "root" is a *workspace* root. `jjRoot` here is
 * the sniffed directory containing `.jj`; `jjWorkspaceRoot` is the workspace
 * root that `jj workspace list` reports for the workspace containing `cwd`.
 *
 * @module dsh-jj/types
 */
/**
 * Repository classification.
 *
 * - `jj-colocated`: `.jj` and a root `.git` in the same root (jj 0.46 default of
 *   `jj git init`).
 * - `jj-native`: `.jj` only; the Git backend lives inside `.jj/repo/store/git`
 *   (`jj git init --no-colocate`).
 * - `none` covers both "not a repository" and "unusable jj repository"
 *   (for example a stray empty `.jj` directory).
 */
export type VcsKind = 'git' | 'jj-colocated' | 'jj-native' | 'none';
/** Detection confidence (extra beyond the contract, used by tests and reports). */
export type DetectionConfidence = 'high' | 'medium' | 'low';
/** Evidence source that contributed to a {@link VcsDescriptor}. */
export type VcsEvidenceSource = 'jj-cli' | 'git-cli' | 'filesystem-sniff';
/** One jj workspace, as reported by `jj workspace list -T <TPL_WORKSPACE_LIST>`. */
export interface JjWorkspaceInfo {
    readonly name: string;
    /** Absolute workspace root as reported by the template's `root` field. */
    readonly root: string;
}
/** One jj change, as parsed from the JSON templates (contract §5.3). */
export interface JjChange {
    readonly changeId: string;
    readonly commitId: string;
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly currentWorkingCopy: boolean;
    readonly bookmarks: readonly string[];
    readonly author: string;
}
/** One jj operation from `jj op log -T 'json(self) ++ "\n"'` (contract §5.3). */
export interface JjOperation {
    readonly id: string;
    readonly shortId: string;
    readonly description: string;
    readonly time: string;
    readonly user: string;
    readonly workspaceName: string | null;
    readonly isSnapshot: boolean;
    readonly tags: readonly string[];
}
/** One jj remote, as reported by `jj git remote list`. */
export interface JjRemote {
    readonly name: string;
    readonly url: string;
}
/** Stable diagnostic codes; each maps to one detection failure mode (contract §2.10). */
export type VcsNoticeCode = 'jj-cli-missing' | 'jj-cli-timeout' | 'jj-repo-broken' | 'jj-repo-unreadable' | 'jj-ancestor-shadowed' | 'jj-pointer-broken' | 'jj-native-under-git-parent' | 'jj-shared-workspace' | 'git-cli-missing' | 'git-probe-failed' | 'git-ceiling-applied' | 'jj-workspace-pointer' | 'jj-metadata-incomplete' | 'not-a-repository' | 'cancelled' | 'probe-failed' | 'sniff-cli-mismatch';
/** One recorded observation about how a descriptor was derived. */
export interface VcsNotice {
    readonly code: VcsNoticeCode;
    /** Untrusted diagnostic text (bounded stderr or a one-line explanation). Never a command to run. */
    readonly detail: string;
    /** Extra: severity for reporting. */
    readonly severity?: 'info' | 'warning' | 'error';
    /** Extra: English, model-facing one-liner when `detail` carries raw process output. */
    readonly message?: string;
}
/** One injected command execution, program name included in `argv` (task-4 form). */
export interface RunResult {
    readonly argv: readonly string[];
    /** Exit code, or `null` when killed by a signal or never started. */
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    /** Node errno-style code when the process could not start (for example `ENOENT`). */
    readonly errorCode?: string;
    readonly durationMs: number;
}
/** Options for one injected command execution. */
export interface RunCommandOptions {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    /** Runner-side deadline; the runner kills the child and sets `timedOut`. */
    readonly timeoutMs?: number;
    /** Explicit environment entries layered over the runner's scrubbed environment. */
    readonly env?: Readonly<Record<string, string>>;
}
/**
 * Injected command runner (task-4 form).
 *
 * Contract: never rejects because the process exited non-zero; may reject only
 * for programmer errors; applies its own scrubbed environment.
 */
export type RunCommand = (argv: readonly string[], options: RunCommandOptions) => Promise<RunResult>;
/** Result of one jj/git execution through the contract-shaped adapter (program name excluded). */
export interface JjRunResult {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
    readonly killedByTimeout: boolean;
}
/** Options for the contract-shaped runner; `argv` excludes the executable name. */
export interface RunJjOptions {
    readonly cwd: string;
    readonly argv: readonly string[];
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly graceMs?: number;
    readonly maxOutputBytes?: number;
    /** Executable name to run for this call (defaults to the configured command). */
    readonly jjCommand?: string;
    /** Extra env merged after the scrubbed parent environment. */
    readonly env?: Readonly<Record<string, string>>;
}
/** Contract-shaped runner for one executable (jj or git). */
export type RunJj = (options: RunJjOptions) => Promise<JjRunResult>;
/** Dependencies accepted by `detectVcs` (contract §6.1). */
export interface DetectDeps {
    /** Stats a path without following provider policy; defaults to a local `lstat`. */
    readonly statKind?: (path: string) => Promise<'dir' | 'file' | 'missing'>;
    readonly runJj: RunJj;
    readonly runGit: RunJj;
    readonly jjCommand?: string;
    readonly gitCommand?: string;
    readonly cacheTtlMs?: number;
    readonly timeoutMs?: number;
    readonly graceMs?: number;
    readonly maxOutputBytes?: number;
    /** Extra environment for probes (for example `GIT_CEILING_DIRECTORIES`). */
    readonly env?: Readonly<Record<string, string>>;
}
/** `detectVcs` accepts either a plain runner (task-4) or full {@link DetectDeps} (contract §6.1). */
export type DetectInput = RunCommand | DetectDeps;
/**
 * Repository facts observed for one directory.
 *
 * Failure semantics: a descriptor is always returned. Repository problems are
 * reported through {@link VcsDescriptor.notices} and `verified === false`
 * instead of throwing. `detectVcs` throws only for programmer errors (a
 * non-function/non-object input).
 */
export interface VcsDescriptor {
    readonly kind: VcsKind;
    /** Working root: jj workspace root for jj kinds, Git worktree root for `git`, else `cwd`. */
    readonly root: string;
    /** Absolute, resolved input directory. */
    readonly cwd: string;
    /** Nearest ancestor directory containing a `.jj` **directory** (sniff layer). */
    readonly jjRoot: string | undefined;
    /** Workspace root that `jj workspace list` reports for the workspace containing `cwd`. */
    readonly jjWorkspaceRoot: string | undefined;
    /** Workspace name whose `root` matches `jjWorkspaceRoot`. */
    readonly workspaceName: string | undefined;
    /** Every workspace of the repository (same call); empty when not a usable jj repo. */
    readonly workspaces: readonly JjWorkspaceInfo[];
    /** True when `<root>/.git` exists and Git resolves that directory as its worktree root. */
    readonly colocated: boolean;
    /** Where jj keeps its Git object store. */
    readonly jjStore: 'external-git-dir' | 'internal-git-dir' | undefined;
    /** Git worktree root, when Git resolves one for `cwd`. */
    readonly gitRoot: string | undefined;
    /** Absolute Git directory, when Git resolves one for `cwd`. */
    readonly gitDir: string | undefined;
    readonly jjVersion: string | undefined;
    readonly gitVersion: string | undefined;
    readonly remotes: readonly JjRemote[];
    /** False when only the filesystem-sniff fast path succeeded (jj CLI missing, timed out, or unusable). */
    readonly verified: boolean;
    readonly notices: readonly VcsNotice[];
    /** `Date.now()` of the probe that produced this descriptor (0 for sniff-only results). */
    readonly probedAt: number;
    /** Detection confidence, derived from the evidence chain. */
    readonly confidence: DetectionConfidence;
    /** Every source that contributed evidence, in consultation order. */
    readonly confirmedBy: readonly VcsEvidenceSource[];
    /** False when the jj executable could not be started. */
    readonly jjAvailable: boolean;
    /** False when the git executable could not be started. */
    readonly gitAvailable: boolean;
    /**
     * True when Git discovery was deliberately stopped at the jj workspace
     * boundary, so an outer Git repository is not reported as this directory's.
     */
    readonly gitCeilingApplied: boolean;
    /** Resolved path behind `.jj/repo` (directory, or the target of a workspace pointer file). */
    readonly jjRepoPath: string | undefined;
}
/** Filesystem-only sniff result (no subprocess); used by the synchronous guard path. */
export interface VcsSniff {
    /** Absolute input directory. */
    readonly cwd: string;
    readonly kind: VcsKind;
    /** Directory containing the nearest `.jj` **directory**, if any. */
    readonly jjRoot?: string;
    /** Entry type of `.jj`: only `dir` counts as a jj marker (a plain file does not). */
    readonly jjEntryKind?: 'dir' | 'file';
    /** Entry type of `.jj/repo`: `dir` for the default workspace, `file` for a linked workspace pointer. */
    readonly jjRepoEntryKind?: 'dir' | 'file';
    /** Resolved path behind `.jj/repo`. */
    readonly jjRepoPath?: string;
    /** Directory containing the nearest `.git` entry (directory or file). */
    readonly gitMarkRoot?: string;
    /** Entry type of `.git`. */
    readonly gitEntryKind?: 'dir' | 'file';
    /** Git directory behind the `.git` entry (pointer target for worktree/submodule files). */
    readonly gitDir?: string;
    /** Levels from `cwd` up to the nearest `.jj` directory (0 = `cwd` itself). */
    readonly jjDepth?: number;
    /** Levels from `cwd` up to the nearest `.git` entry (0 = `cwd` itself). */
    readonly gitDepth?: number;
    /** How the nearest `.git` relates to the nearest `.jj` directory. */
    readonly gitRelation?: 'same-root' | 'ancestor-of-jj-root' | 'descendant-of-jj-root';
    readonly diagnostics: readonly VcsNotice[];
}
/** Human-readable one-liner for a repository family. */
export declare function describeVcsKind(kind: VcsKind): string;
