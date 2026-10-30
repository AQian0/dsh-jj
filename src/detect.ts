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

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type DetectionConfidence,
  type DetectDeps,
  type DetectInput,
  type JjRemote,
  type JjRunResult,
  type JjWorkspaceInfo,
  type RunCommand,
  type RunJj,
  type VcsDescriptor,
  type VcsEvidenceSource,
  type VcsKind,
  type VcsNotice,
  type VcsNoticeCode,
  type VcsSniff,
} from './types.ts';

/** Default probe deadline in milliseconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * `jj workspace list` template (contract §2.8, verbatim).
 *
 * Every record must end with an explicit `"\n"`, otherwise records concatenate.
 * `json(self)` does not carry `root`, and workspace names may contain spaces, so
 * the JSON form is the only safe parse.
 */
export const TPL_WORKSPACE_LIST = '"{\\"name\\":" ++ json(name) ++ ",\\"root\\":" ++ json(root) ++ "}\\n"';

/** Environment layered onto every jj probe (non-interactive, no pager, no colour). */
export const JJ_PROBE_ENV: Readonly<Record<string, string>> = Object.freeze({
  NO_COLOR: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** Environment layered onto every Git probe (non-interactive, no locks taken). */
export const GIT_PROBE_ENV: Readonly<Record<string, string>> = Object.freeze({
  NO_COLOR: '1',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
});

/**
 * Global jj options that keep a probe read-only. `--no-pager --color=never` are
 * prepended by the runner (`createRunJj` / `adaptRunner`), so they are not
 * repeated here (the 2026-10 verification flagged the duplicate).
 */
const JJ_GLOBAL_ARGS = ['--ignore-working-copy'] as const;

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

interface EntryInfo {
  readonly path: string;
  readonly container: string;
  readonly kind: 'dir' | 'file';
}

const POINTER_RE = /^\s*gitdir:\s*(.+?)\s*$/i;

function entryInfo(path: string): EntryInfo | undefined {
  let stat;
  try {
    stat = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  if (stat === undefined) return undefined;
  return { path, container: dirname(path), kind: stat.isDirectory() ? 'dir' : 'file' };
}

function readFileText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read a Git `gitdir: <path>` pointer file. */
function readPointerPath(entry: EntryInfo): string | undefined {
  const text = readFileText(entry.path);
  if (text === undefined) return undefined;
  const match = POINTER_RE.exec(text);
  if (match === null || match[1] === undefined) return undefined;
  return resolve(entry.container, match[1]);
}

/**
 * Read a `.jj/repo` pointer: jj 0.46 writes a raw relative path
 * (`../../native/.jj/repo`), Git worktree `.git` files use `gitdir: <path>`.
 */
function readJjRepoPointer(entry: EntryInfo): string | undefined {
  const text = readFileText(entry.path)?.trim();
  if (text === undefined || text.length === 0) return undefined;
  const match = POINTER_RE.exec(text);
  return resolve(entry.container, match?.[1] ?? text);
}

/** True when `candidate` is `ancestor` itself or a descendant of it. */
function isInside(ancestor: string, candidate: string): boolean {
  if (candidate === ancestor) return true;
  return candidate.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

function notice(code: VcsNoticeCode, severity: VcsNotice['severity'], message: string, detail = ''): VcsNotice {
  return { code, severity, message, detail };
}

/**
 * Canonical identity of a path (`realpath` when it exists, else the resolved
 * absolute path).
 *
 * Repository roots reach detection from three sources that can spell the same
 * directory differently: the caller's `cwd`, `jj` output, and `git` output. On
 * macOS `/var` is a symlink to `/private/var`; Git reports the canonical
 * spelling while a caller-supplied temp path (and jj output derived from it)
 * keeps the symlinked one. Comparing — and, for workspace selection, matching —
 * canonical paths keeps the colocated/native decision identical to platforms
 * that have no such indirection.
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** True when both paths name the same directory, symlinks resolved. */
function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

/** Filesystem device id of a path, or `undefined` when it cannot be read. */
function deviceOf(path: string): number | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.dev;
  } catch {
    return undefined;
  }
}

/**
 * Filesystem-only repository sniff: no subprocess, no mutation.
 *
 * @param cwd - directory to classify (resolved against the process cwd).
 * @param options - optional walk bound.
 * @returns sniffed layout with depths, pointer targets, and diagnostics.
 */
export function sniffVcsSync(cwd: string, options: SniffOptions = {}): VcsSniff {
  const start = resolve(cwd);
  const diagnostics: VcsNotice[] = [];
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const startDevice = deviceOf(start);

  let jj: EntryInfo | undefined;
  let jjDepth: number | undefined;
  let jjFileEntry: EntryInfo | undefined;
  let git: EntryInfo | undefined;
  let gitDepth: number | undefined;
  let dir = start;
  let depth = 0;
  for (;;) {
    if (jj === undefined) {
      const candidate = entryInfo(join(dir, '.jj'));
      if (candidate !== undefined) {
        if (candidate.kind === 'dir') {
          jj = candidate;
          jjDepth = depth;
        } else if (jjFileEntry === undefined) {
          jjFileEntry = candidate;
        }
      }
    }
    if (git === undefined) {
      const candidate = entryInfo(join(dir, '.git'));
      if (candidate !== undefined) {
        git = candidate;
        gitDepth = depth;
      }
    }
    if ((jj !== undefined && git !== undefined) || depth >= maxDepth) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    const device = deviceOf(parent);
    if (startDevice !== undefined && device !== undefined && device !== startDevice) break;
    dir = parent;
    depth += 1;
  }

  if (jjFileEntry !== undefined && jj === undefined) {
    diagnostics.push(
      notice(
        'jj-metadata-incomplete',
        'error',
        `${jjFileEntry.path} is a plain file, not a directory; only a .jj DIRECTORY marks a jj workspace, so it is ignored.`,
      ),
    );
  }

  let gitRelation: VcsSniff['gitRelation'];
  if (jj !== undefined && git !== undefined) {
    if (git.container === jj.container) gitRelation = 'same-root';
    else if (isInside(git.container, jj.container)) gitRelation = 'ancestor-of-jj-root';
    else gitRelation = 'descendant-of-jj-root';
  }

  let jjRepoEntryKind: VcsSniff['jjRepoEntryKind'];
  let jjRepoPath: string | undefined;
  if (jj !== undefined) {
    const repoEntry = entryInfo(join(jj.path, 'repo'));
    if (repoEntry === undefined) {
      diagnostics.push(
        notice(
          'jj-metadata-incomplete',
          'error',
          `.jj exists at ${jj.path} but .jj/repo is missing; the workspace metadata looks incomplete.`,
        ),
      );
    } else {
      jjRepoEntryKind = repoEntry.kind;
      jjRepoPath = repoEntry.kind === 'file' ? readJjRepoPointer(repoEntry) : repoEntry.path;
      if (repoEntry.kind === 'file') {
        diagnostics.push(
          notice(
            'jj-workspace-pointer',
            'info',
            `.jj/repo is a pointer file (linked jj workspace); the shared repository lives at ${jjRepoPath ?? 'an unreadable path'}.`,
          ),
        );
      }
    }
  }

  let gitDir: string | undefined;
  if (git !== undefined) gitDir = git.kind === 'file' ? readPointerPath(git) : git.path;

  // nearest wins (F6): a nested Git repository owns the directory
  const gitShadowed =
    jj !== undefined && git !== undefined && jjDepth !== undefined && gitDepth !== undefined && gitDepth < jjDepth;
  const kind: VcsKind =
    jj === undefined
      ? git !== undefined
        ? 'git'
        : 'none'
      : gitShadowed
        ? 'git'
        : gitRelation === 'same-root'
          ? 'jj-colocated'
          : 'jj-native';

  if (gitShadowed && jj !== undefined && git !== undefined) {
    diagnostics.push(
      notice(
        'jj-ancestor-shadowed',
        'warning',
        `the nearest Git repository (${git.container}) is closer than the nearest jj workspace (${jj.container}); Git owns this directory.`,
      ),
    );
  }

  return {
    cwd: start,
    kind,
    ...(jj !== undefined ? { jjRoot: jj.container, jjEntryKind: jj.kind } : {}),
    ...(jjRepoEntryKind !== undefined ? { jjRepoEntryKind } : {}),
    ...(jjRepoPath !== undefined ? { jjRepoPath } : {}),
    ...(git !== undefined ? { gitMarkRoot: git.container, gitEntryKind: git.kind } : {}),
    ...(gitDir !== undefined ? { gitDir } : {}),
    ...(jjDepth !== undefined ? { jjDepth } : {}),
    ...(gitDepth !== undefined ? { gitDepth } : {}),
    ...(gitRelation !== undefined ? { gitRelation } : {}),
    diagnostics,
  };
}

/** One parsed `jj workspace list` record. */
export interface JjWorkspaceEntry extends JjWorkspaceInfo {}

/**
 * Parse `jj workspace list -T <TPL_WORKSPACE_LIST>` output (one JSON object per line).
 *
 * @param stdout - raw command output.
 * @returns parsed workspaces; malformed lines are skipped.
 */
export function parseWorkspaceList(stdout: string): JjWorkspaceInfo[] {
  const entries: JjWorkspaceInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (typeof record['name'] === 'string' && typeof record['root'] === 'string') {
          entries.push({ name: record['name'], root: record['root'] });
        }
      }
    } catch {
      // Tolerated: a truncated tail, or a warning line printed by jj.
    }
  }
  return entries;
}

/**
 * Parse `jj git remote list` output (`<name> <url>` per line).
 *
 * @param stdout - raw command output.
 * @returns parsed remotes.
 */
export function parseRemoteList(stdout: string): JjRemote[] {
  const remotes: JjRemote[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.search(/\s/);
    if (space <= 0) continue;
    remotes.push({ name: trimmed.slice(0, space), url: trimmed.slice(space + 1).trim() });
  }
  return remotes;
}

function outputTail(text: string, limit = 200): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function shorten(text: string, limit = 200): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/**
 * Adapt a task-4 `RunCommand` (argv includes the program) into a contract-shaped
 * runner. Non-interactive jj flags are added here for the jj program, mirroring
 * `createRunJj`, so probe argv never carries them twice.
 */
function adaptRunner(
  run: RunCommand,
  program: string,
  defaultTimeoutMs: number,
  baseEnv: Readonly<Record<string, string>>,
  prefix: readonly string[] = [],
): RunJj {
  return async (options) => {
    const result = await run([program, ...prefix, ...options.argv], {
      cwd: options.cwd,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
      env: { ...baseEnv, ...options.env },
    });
    if (result.errorCode !== undefined && result.errorCode !== '') {
      // Contract-shaped runners signal a missing executable by throwing (see probe()).
      throw new Error(`ENOENT: ${program} could not be started (${result.errorCode})`);
    }
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: false,
      killedByTimeout: result.timedOut,
    };
  };
}

function defaultStatKind(path: string): Promise<'dir' | 'file' | 'missing'> {
  const info = entryInfo(path);
  return Promise.resolve(info === undefined ? 'missing' : info.kind);
}

interface ProbeOutcome {
  readonly result?: JjRunResult;
  readonly missing: boolean;
  readonly timedOut: boolean;
  readonly failed: boolean;
}

async function probe(
  run: RunJj,
  cwd: string,
  argv: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
): Promise<ProbeOutcome> {
  try {
    const result = await run({ cwd, argv, ...(signal !== undefined ? { signal } : {}), timeoutMs, env });
    return {
      result,
      missing: false,
      timedOut: result.killedByTimeout,
      failed: result.exitCode !== 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissing = /ENOENT|not found|ExecutableNotFound/i.test(message);
    return { missing: isMissing, timedOut: false, failed: true };
  }
}

/** Resolve the jj store layout from `.jj/repo/store/git_target` (contract §6.2 step 7). */
function readJjStore(
  jjRoot: string,
  jjRepoPath: string | undefined,
): 'external-git-dir' | 'internal-git-dir' | undefined {
  const repoDir = jjRepoPath ?? join(jjRoot, '.jj', 'repo');
  const text = readFileText(join(repoDir, 'store', 'git_target'))?.trim();
  if (text === undefined || text.length === 0) return undefined;
  if (text === 'git') return 'internal-git-dir';
  if (text.endsWith('.git')) return 'external-git-dir';
  return undefined;
}

interface AssembleInput {
  kind: VcsKind;
  root: string;
  cwd: string;
  jjRoot?: string;
  jjWorkspaceRoot?: string;
  workspaceName?: string;
  workspaces?: readonly JjWorkspaceInfo[];
  colocated?: boolean;
  jjStore?: 'external-git-dir' | 'internal-git-dir';
  jjRepoPath?: string;
  gitRoot?: string;
  gitDir?: string;
  jjVersion?: string;
  gitVersion?: string;
  remotes?: readonly JjRemote[];
  verified: boolean;
  confidence: DetectionConfidence;
  confirmedBy: VcsEvidenceSource[];
  jjAvailable: boolean;
  gitAvailable: boolean;
  gitCeilingApplied: boolean;
  probedAt: number;
}

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
export async function detectVcs(
  cwd: string,
  input: DetectInput,
  signal?: AbortSignal,
  options: DetectVcsOptions = {},
): Promise<VcsDescriptor> {
  if (
    typeof input !== 'function' &&
    (typeof input !== 'object' || input === null || typeof input.runJj !== 'function')
  ) {
    throw new TypeError('detectVcs(cwd, input, signal?): `input` must be a RunCommand or DetectDeps with runJj/runGit');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const extraEnv = { ...options.env };
  const notices: VcsNotice[] = [];
  const confirmedBy: VcsEvidenceSource[] = [];
  const probedAt = Date.now();

  let runJj: RunJj;
  let runGit: RunJj;
  let statKind: (path: string) => Promise<'dir' | 'file' | 'missing'>;
  let jjCommand = 'jj';
  let gitCommand = 'git';

  if (typeof input === 'function') {
    runJj = adaptRunner(input, jjCommand, timeoutMs, extraEnv, ['--no-pager', '--color=never']);
    runGit = adaptRunner(input, gitCommand, timeoutMs, extraEnv);
    statKind = defaultStatKind;
  } else {
    const deps: DetectDeps = input;
    jjCommand = deps.jjCommand ?? 'jj';
    gitCommand = deps.gitCommand ?? 'git';
    const depsEnv = { ...extraEnv, ...deps.env };
    const depsTimeout = deps.timeoutMs ?? timeoutMs;
    runJj = async (runOptions) =>
      deps.runJj({
        ...runOptions,
        env: { ...depsEnv, ...runOptions.env },
        timeoutMs: runOptions.timeoutMs ?? depsTimeout,
        ...(runOptions.graceMs === undefined && deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
        ...(runOptions.maxOutputBytes === undefined && deps.maxOutputBytes !== undefined
          ? { maxOutputBytes: deps.maxOutputBytes }
          : {}),
      });
    const rawRunGit = deps.runGit;
    runGit = async (runOptions) =>
      rawRunGit({
        ...runOptions,
        env: { ...depsEnv, ...runOptions.env },
        timeoutMs: runOptions.timeoutMs ?? depsTimeout,
      });
    statKind = deps.statKind ?? defaultStatKind;
  }

  const sniff = sniffVcsSync(cwd);
  notices.push(...sniff.diagnostics);
  const start = sniff.cwd;
  const hasJj = sniff.jjRoot !== undefined;

  const finish = (fields: AssembleInput): VcsDescriptor =>
    ({
      kind: fields.kind,
      root: fields.root,
      cwd: fields.cwd,
      jjRoot: fields.jjRoot ?? undefined,
      jjWorkspaceRoot: fields.jjWorkspaceRoot ?? undefined,
      workspaceName: fields.workspaceName ?? undefined,
      workspaces: Object.freeze([...(fields.workspaces ?? [])]),
      colocated: fields.colocated ?? false,
      jjStore: fields.jjStore ?? undefined,
      gitRoot: fields.gitRoot ?? undefined,
      gitDir: fields.gitDir ?? undefined,
      jjVersion: fields.jjVersion ?? undefined,
      gitVersion: fields.gitVersion ?? undefined,
      remotes: Object.freeze([...(fields.remotes ?? [])]),
      verified: fields.verified,
      notices: Object.freeze([...notices]),
      probedAt,
      confidence: fields.confidence,
      confirmedBy: Object.freeze([...fields.confirmedBy]),
      jjAvailable: fields.jjAvailable,
      gitAvailable: fields.gitAvailable,
      gitCeilingApplied: fields.gitCeilingApplied,
      jjRepoPath: fields.jjRepoPath ?? undefined,
    }) as VcsDescriptor;

  if (signal?.aborted === true) {
    notices.push(
      notice(
        'cancelled',
        'warning',
        'detection was cancelled before any probe ran; the result comes from the filesystem sniff only.',
      ),
    );
    return finish({
      kind: sniff.kind,
      root: sniff.jjRoot ?? sniff.gitMarkRoot ?? start,
      cwd: start,
      ...(sniff.jjRoot !== undefined ? { jjRoot: sniff.jjRoot } : {}),
      ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
      ...(sniff.gitMarkRoot !== undefined ? { gitRoot: sniff.gitMarkRoot } : {}),
      ...(sniff.gitDir !== undefined ? { gitDir: sniff.gitDir } : {}),
      verified: false,
      confidence: 'low',
      confirmedBy: ['filesystem-sniff'],
      jjAvailable: false,
      gitAvailable: false,
      gitCeilingApplied: false,
      probedAt,
    });
  }

  // ---- Git probe (independent of jj; respects an inherited GIT_CEILING_DIRECTORIES)
  let gitVersion: string | undefined;
  let gitAvailable = false;
  let gitRoot: string | undefined;
  let gitDir: string | undefined;
  let gitProbeFailed = false;

  const versionProbe = await probe(runGit, start, ['--version'], signal, timeoutMs, { ...GIT_PROBE_ENV, ...extraEnv });
  if (versionProbe.missing) {
    notices.push(notice('git-cli-missing', 'warning', `the \`${gitCommand}\` executable could not be started.`));
  } else if (versionProbe.result !== undefined && !versionProbe.failed) {
    gitAvailable = true;
    gitVersion = versionProbe.result.stdout.split('\n')[0]?.trim();
  }

  // Stop Git at a jj workspace boundary only when an outer Git repository exists (F7):
  // the caller's own GIT_CEILING_DIRECTORIES is never overridden.
  let ceiling: string | undefined;
  if (
    hasJj &&
    sniff.gitRelation === 'ancestor-of-jj-root' &&
    sniff.jjRoot !== undefined &&
    extraEnv.GIT_CEILING_DIRECTORIES === undefined
  ) {
    const parent = dirname(sniff.jjRoot);
    if (parent !== sniff.jjRoot) ceiling = parent;
  }

  if (gitAvailable) {
    const env: Record<string, string> = { ...GIT_PROBE_ENV, ...extraEnv };
    if (ceiling !== undefined) env.GIT_CEILING_DIRECTORIES = ceiling;
    const revParse = await probe(
      runGit,
      start,
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--is-inside-work-tree'],
      signal,
      timeoutMs,
      env,
    );
    if (revParse.result !== undefined && !revParse.failed) {
      const lines = revParse.result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      gitRoot = lines[0];
      gitDir = lines[1];
    } else if (revParse.failed && !revParse.timedOut && !revParse.missing) {
      const exitCode = revParse.result?.exitCode ?? null;
      const stderr = revParse.result?.stderr ?? '';
      if (exitCode !== 128 && !/not a git repository|不是 Git 仓库/i.test(stderr)) {
        gitProbeFailed = true;
        notices.push(
          notice(
            'git-probe-failed',
            'warning',
            `\`${gitCommand} rev-parse\` exited with code ${exitCode ?? 'null'}.`,
            outputTail(stderr),
          ),
        );
      }
    }
  }

  // An outer Git repository must never be reported as this directory's repository.
  const outerGitRoot = sniff.gitRelation === 'ancestor-of-jj-root' ? sniff.gitMarkRoot : undefined;
  let gitCeilingApplied = false;
  if (
    outerGitRoot !== undefined &&
    (gitRoot === undefined || sniff.jjRoot === undefined || !isInside(sniff.jjRoot, gitRoot))
  ) {
    gitRoot = undefined;
    gitDir = undefined;
    gitCeilingApplied = true;
    notices.push(
      notice(
        'git-ceiling-applied',
        'info',
        `Git discovery stopped at the jj workspace boundary: the Git repository at ${outerGitRoot} is above the jj workspace and does not describe this directory.`,
      ),
    );
  }

  // ---- step 4: no jj marker at all
  if (!hasJj) {
    const kind: VcsKind = gitRoot !== undefined ? 'git' : 'none';
    if (kind === 'none') {
      notices.push(
        notice('not-a-repository', 'info', 'no `.jj` directory or `.git` entry was found at or above this directory.'),
      );
    }
    if (gitRoot !== undefined) confirmedBy.push('git-cli');
    confirmedBy.push('filesystem-sniff');
    return finish({
      kind,
      root: gitRoot ?? start,
      cwd: start,
      ...(gitRoot !== undefined ? { gitRoot } : {}),
      ...(gitDir !== undefined ? { gitDir } : {}),
      ...(gitVersion !== undefined ? { gitVersion } : {}),
      verified: true,
      confidence:
        kind === 'none'
          ? gitAvailable && !gitProbeFailed
            ? 'high'
            : 'medium'
          : gitRoot !== undefined
            ? 'high'
            : 'medium',
      confirmedBy,
      jjAvailable: false,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }

  // ---- step 5: a nearer Git repository owns the directory (F6)
  if (sniff.kind === 'git' && sniff.gitMarkRoot !== undefined) {
    if (gitRoot === undefined) {
      notices.push(
        notice(
          'git-probe-failed',
          'warning',
          `${gitCommand} did not resolve the nearer Git repository at ${sniff.gitMarkRoot}.`,
        ),
      );
    }
    confirmedBy.push('filesystem-sniff');
    if (gitRoot !== undefined) confirmedBy.push('git-cli');
    return finish({
      kind: 'git',
      root: gitRoot ?? sniff.gitMarkRoot,
      cwd: start,
      jjRoot: sniff.jjRoot,
      ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
      ...(gitRoot !== undefined ? { gitRoot } : {}),
      ...(gitDir !== undefined ? { gitDir } : {}),
      ...(gitVersion !== undefined ? { gitVersion } : {}),
      verified: true,
      confidence: gitRoot !== undefined ? 'high' : 'medium',
      confirmedBy,
      jjAvailable: false,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }

  // ---- steps 6-7: jj CLI authority
  const jjRoot = sniff.jjRoot as string;
  let jjVersion: string | undefined;
  let jjAvailable = false;
  let workspaces: JjWorkspaceInfo[] = [];
  let jjWorkspaceRoot: string | undefined;
  let workspaceName: string | undefined;
  let remotes: JjRemote[] = [];
  let verified = false;
  let jjStore = readJjStore(jjRoot, sniff.jjRepoPath);

  const authority = await probe(
    runJj,
    jjRoot,
    [...JJ_GLOBAL_ARGS, 'workspace', 'list', '-T', TPL_WORKSPACE_LIST],
    signal,
    timeoutMs,
    {
      ...JJ_PROBE_ENV,
      ...extraEnv,
    },
  );

  const fileLayerKind: VcsKind = entryInfo(join(jjRoot, '.git')) === undefined ? 'jj-native' : 'jj-colocated';

  if (authority.missing) {
    notices.push(
      notice(
        'jj-cli-missing',
        'warning',
        `\`${jjCommand}\` could not be started; the layout was sniffed from disk only.`,
      ),
    );
    confirmedBy.push('filesystem-sniff');
    return finish({
      kind: fileLayerKind,
      root: jjRoot,
      cwd: start,
      jjRoot,
      ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
      jjStore,
      colocated: fileLayerKind === 'jj-colocated',
      ...(gitRoot !== undefined ? { gitRoot } : {}),
      ...(gitDir !== undefined ? { gitDir } : {}),
      ...(gitVersion !== undefined ? { gitVersion } : {}),
      verified: false,
      confidence: 'medium',
      confirmedBy,
      jjAvailable: false,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }

  if (authority.timedOut || authority.result?.killedByTimeout === true) {
    notices.push(
      notice('jj-cli-timeout', 'warning', `\`${jjCommand} workspace list\` exceeded its ${timeoutMs} ms deadline.`),
    );
    confirmedBy.push('filesystem-sniff');
    return finish({
      kind: fileLayerKind,
      root: jjRoot,
      cwd: start,
      jjRoot,
      ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
      jjStore,
      colocated: fileLayerKind === 'jj-colocated',
      verified: false,
      confidence: 'medium',
      confirmedBy,
      jjAvailable: false,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }

  const authorityExit = authority.result?.exitCode ?? null;
  const authorityStderr = authority.result?.stderr ?? '';
  if (authorityExit === 255 || /appears broken or inaccessible/i.test(authorityStderr)) {
    notices.push(
      notice(
        'jj-repo-broken',
        'error',
        `the jj repository at ${jjRoot} is unusable (exit ${authorityExit ?? 'null'}).`,
        outputTail(authorityStderr),
      ),
    );
    confirmedBy.push('filesystem-sniff');
    return finish({
      kind: 'none',
      root: jjRoot,
      cwd: start,
      jjRoot,
      ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
      jjStore,
      ...(gitRoot !== undefined ? { gitRoot } : {}),
      ...(gitDir !== undefined ? { gitDir } : {}),
      ...(gitVersion !== undefined ? { gitVersion } : {}),
      verified: false,
      confidence: 'low',
      confirmedBy,
      jjAvailable: true,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }
  if (authorityExit === 1 && /Cannot access/i.test(authorityStderr)) {
    notices.push(
      notice(
        'jj-pointer-broken',
        'error',
        `the \`.jj/repo\` pointer at ${jjRoot} cannot be resolved.`,
        outputTail(authorityStderr),
      ),
    );
    confirmedBy.push('filesystem-sniff');
    return finish({
      kind: 'none',
      root: jjRoot,
      cwd: start,
      jjRoot,
      jjStore,
      verified: false,
      confidence: 'low',
      confirmedBy,
      jjAvailable: true,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }
  if (authority.failed) {
    notices.push(
      authority.result === undefined
        ? notice('probe-failed', 'error', `\`${jjCommand} workspace list\` could not be executed at all.`)
        : notice(
            'jj-repo-unreadable',
            'error',
            `\`${jjCommand} workspace list\` exited with code ${authorityExit ?? 'null'}.`,
            outputTail(authorityStderr),
          ),
    );
    confirmedBy.push('filesystem-sniff');
    return finish({
      kind: fileLayerKind,
      root: jjRoot,
      cwd: start,
      jjRoot,
      ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
      jjStore,
      colocated: fileLayerKind === 'jj-colocated',
      verified: false,
      confidence: 'low',
      confirmedBy,
      jjAvailable: true,
      gitAvailable,
      gitCeilingApplied,
      probedAt,
    });
  }

  jjAvailable = true;
  verified = true;
  const workspaceStdout = authority.result?.stdout ?? '';
  workspaces = parseWorkspaceList(workspaceStdout);
  // The workspace list is the CLI authority for workspace identity. A bounded or
  // unparsable list must be diagnosed rather than silently falling back to the
  // sniffed root with `confidence: 'high'` (audit M6).
  let authorityConfidence: 'high' | 'medium' | 'low' = 'high';
  if (authority.result?.truncated === true) {
    notices.push(
      notice(
        'jj-metadata-incomplete',
        'warning',
        `\`${jjCommand} workspace list\` output was truncated by the output bound; the workspace list may be incomplete and the workspace identity falls back to the sniffed root.`,
      ),
    );
    authorityConfidence = 'low';
  } else if (workspaces.length === 0 && workspaceStdout.trim().length > 0) {
    notices.push(
      notice(
        'jj-metadata-incomplete',
        'warning',
        `\`${jjCommand} workspace list\` output could not be parsed; the workspace identity falls back to the sniffed root.`,
        outputTail(workspaceStdout),
      ),
    );
    authorityConfidence = 'low';
  } else if (workspaces.length === 0) {
    notices.push(
      notice(
        'jj-metadata-incomplete',
        'warning',
        `\`${jjCommand} workspace list\` reported no workspaces; the workspace identity falls back to the sniffed root.`,
      ),
    );
    authorityConfidence = 'medium';
  }
  confirmedBy.push('jj-cli');
  if (gitRoot !== undefined) confirmedBy.push('git-cli');

  const canonicalJjRoot = canonicalPath(jjRoot);
  const ancestors = new Set<string>();
  for (let dir = canonicalPath(start); ; dir = dirname(dir)) {
    ancestors.add(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  let best: JjWorkspaceInfo | undefined;
  for (const workspace of workspaces) {
    const root = canonicalPath(workspace.root);
    if (!ancestors.has(root)) continue;
    if (best === undefined || root.length > canonicalPath(best.root).length) best = workspace;
  }
  if (best === undefined) best = workspaces.find((workspace) => canonicalPath(workspace.root) === canonicalJjRoot);
  jjWorkspaceRoot = best?.root ?? canonicalJjRoot;
  workspaceName = best?.name;

  const versionProbeJj = await probe(runJj, jjRoot, ['--version'], signal, timeoutMs, { ...JJ_PROBE_ENV, ...extraEnv });
  if (versionProbeJj.result !== undefined && !versionProbeJj.failed) {
    jjVersion = versionProbeJj.result.stdout.split('\n')[0]?.trim();
  }

  let colocated = fileLayerKind === 'jj-colocated';
  if (gitRoot !== undefined)
    colocated = (await statKind(join(jjWorkspaceRoot, '.git'))) !== 'missing' && samePath(gitRoot, jjWorkspaceRoot);
  const kind: VcsKind = colocated ? 'jj-colocated' : 'jj-native';
  jjStore = readJjStore(jjRoot, sniff.jjRepoPath);

  if (options.probeRemotes !== false) {
    const remoteProbe = await probe(runJj, jjRoot, [...JJ_GLOBAL_ARGS, 'git', 'remote', 'list'], signal, timeoutMs, {
      ...JJ_PROBE_ENV,
      ...extraEnv,
    });
    if (remoteProbe.result !== undefined && !remoteProbe.failed) remotes = parseRemoteList(remoteProbe.result.stdout);
  }

  // F13: a jj-native workspace that sits inside a parent Git repository — Git
  // would act on that unrelated repository (the root cause of the git-only
  // workspace-changes card describing `.jj` metadata as "changes").
  if (
    kind === 'jj-native' &&
    (sniff.gitRelation === 'ancestor-of-jj-root' || (gitRoot !== undefined && !samePath(gitRoot, jjWorkspaceRoot)))
  ) {
    notices.push(
      notice(
        'jj-native-under-git-parent',
        'warning',
        `this jj-native workspace has no root .git, but a Git repository at ${gitRoot ?? sniff.gitMarkRoot ?? 'an ancestor directory'} is ` +
          'not this workspace: git commands here would act on that unrelated repository.',
      ),
    );
  }
  // F14: the session directory *is* the workspace root — repository-wide jj
  // commands rewrite this whole working copy (2026-10-22 incident).
  if (samePath(start, jjWorkspaceRoot)) {
    notices.push(
      notice(
        'jj-shared-workspace',
        'info',
        `the session directory is the jj workspace root itself (${jjWorkspaceRoot}); repository-wide jj commands such as \`jj undo\` or \`jj op restore\` rewrite this entire working copy.`,
      ),
    );
  }

  confirmedBy.push('filesystem-sniff');
  return finish({
    kind,
    root: jjWorkspaceRoot,
    cwd: start,
    jjRoot,
    jjWorkspaceRoot,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    workspaces,
    colocated,
    ...(jjStore !== undefined ? { jjStore } : {}),
    ...(sniff.jjRepoPath !== undefined ? { jjRepoPath: sniff.jjRepoPath } : {}),
    ...(gitRoot !== undefined ? { gitRoot } : {}),
    ...(gitDir !== undefined ? { gitDir } : {}),
    ...(jjVersion !== undefined ? { jjVersion } : {}),
    ...(gitVersion !== undefined ? { gitVersion } : {}),
    remotes,
    verified,
    confidence: authorityConfidence,
    confirmedBy,
    jjAvailable,
    gitAvailable,
    gitCeilingApplied,
    probedAt,
  });
}

/** Re-exported for callers that need the notice shortener. */
export { shorten as boundedText };
