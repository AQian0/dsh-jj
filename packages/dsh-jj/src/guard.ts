/**
 * Git-confusion guard (design contract §8).
 *
 * Why: jj and Git keep different models of the same repository
 * (working-copy-as-a-commit vs index + HEAD, change ids vs SHAs, operation log
 * vs reflog, first-class conflicts vs merge state). A mutating Git command inside
 * a jj workspace silently desynchronises `jj status`/`jj log` from reality, and
 * jj-side destructive commands have repository-wide blast radius.
 *
 * Architecture (contract §8.1): the tool guard is **synchronous**, while
 * detection needs subprocesses. So:
 * - **warm-up**: a `tools/pre-execute` waterfall listener resolves the call's cwd
 *   and awaits `service.warm(cwd)` (and precomputes the decision) before guards run;
 * - **decision**: `ctx.tools.guard(...)` reads the precomputed decision, or falls
 *   back to the synchronous filesystem sniff when nothing was precomputed
 *   (standalone use, or the warm-up listener failing — fail-open).
 *
 * @module dsh-jj/guard
 */

import { isAbsolute, resolve } from 'node:path';
import { Config, resolveConfig, type JjPluginConfig, type ResolvedJjConfig } from './config.ts';

export { Config };
import { sniffVcsSync } from './detect.ts';
import {
  classifyGitInvocation,
  classifyJjInvocation,
  gitEquivalence,
  JJ_EQUIVALENCE,
  type GitCommandClassification,
  type GitInvocation,
  type JjInvocation,
} from './git-command.ts';
import type { VcsDescriptor, VcsKind, VcsSniff } from './types.ts';

/** Structural view of the tool execution the guard inspects. */
export interface GuardExecutionLike {
  readonly name: string;
  readonly arguments?: unknown;
  readonly agent?: unknown;
  readonly callId?: unknown;
  readonly signal?: unknown;
}

/** Structural view of the jj service the guard uses for warm/peek. */
export interface GuardServiceLike {
  /** Synchronous cache lookup (contract §6.4). */
  peek(cwd: string): VcsDescriptor | undefined;
  /** Refreshes the cache for `cwd` (contract §6.4). */
  warm(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor | void> | VcsDescriptor | void;
  /** Optional: head operation id used by repo-wide warnings (contract §8.3b self-protection). */
  operations?: { headOperationId(cwd: string, signal?: AbortSignal): Promise<string> };
}

/** Structural view of the Cordis context the guard needs. */
export interface ToolGuardHost {
  readonly tools: {
    guard(guard: (execution: GuardExecutionLike) => string | undefined): () => void;
  };
  /**
   * Optional: registers the guard's waterfall listeners.
   *
   * The same `on` carries both `tools/pre-execute` (warm-up + decision) and
   * `tools/post-execute` (append the jj-preference notice to an allowed git write).
   * Typed loosely because the two events have different listener shapes.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly on?: (event: string, listener: (...args: any[]) => unknown) => unknown;
  /** Optional: Cordis logger service (or a plain `{ warn }` object in tests). */
  readonly logger?: unknown;
  /** Optional: Cordis emit function (feature-detected; used for warn-mode events). */
  readonly emit?: unknown;
  /** Optional: working-directory service with a synchronous `get`. */
  readonly workingDirectory?: unknown;
}

/** Options for {@link installGitConfusionGuard} (contract §8.1). */
export interface GuardOptions {
  readonly service?: GuardServiceLike;
  readonly config?: JjPluginConfig;
  /** Explicit warm function, when the caller does not pass a full service. */
  readonly warm?: (cwd: string, signal?: AbortSignal) => Promise<void> | void;
}

/** One warn-mode observation. */
export interface GitConfusionGuardWarning {
  readonly at: number;
  readonly tool: string;
  readonly commandLine: string;
  readonly subcommand: string | null;
  readonly cwd: string;
  readonly root: string;
  readonly kind: VcsKind;
  readonly message: string;
}

/** One mutating Git invocation found inside a jj workspace. */
export interface GitGuardFinding {
  readonly invocation: GitInvocation;
  /** Directory the invocation would actually run in (after `cd`/`-C`). */
  readonly cwd: string;
  readonly root: string;
  readonly kind: VcsKind;
  readonly workspaceName?: string;
  /** Model-facing refusal text. */
  readonly message: string;
}

/** Options for {@link evaluateGitCommand}. */
export interface EvaluateGitCommandOptions {
  /** Injectable sniff (tests simulate layouts without touching the disk). */
  readonly sniff?: (cwd: string) => GuardDescriptorLike;
}

/** Minimal descriptor view the guard needs (full descriptor or sniff fallback). */
export interface GuardDescriptorLike {
  readonly kind: VcsKind;
  readonly jjRoot: string | undefined;
  readonly root: string;
  readonly workspaceName?: string | undefined;
}

/** Result of {@link evaluateGitCommand}. */
export interface GitCommandEvaluation {
  readonly classification: GitCommandClassification;
  readonly findings: readonly GitGuardFinding[];
  /** Effective directory per invocation index (parallel to `classification.invocations`). */
  readonly effectiveCwds: readonly string[];
}

/** Handle returned by {@link installGitConfusionGuard}: callable as the disposer, with test hooks. */
export type GitConfusionGuardHandle = (() => void) & {
  readonly dispose: () => void;
  readonly config: ResolvedJjConfig;
  readonly check: (execution: GuardExecutionLike) => string | undefined;
  readonly warnings: () => readonly GitConfusionGuardWarning[];
  readonly clearWarnings: () => void;
  /** Synchronous descriptor lookup used by the decision (service cache, else sniff). */
  readonly peek: (cwd: string) => GuardDescriptorLike | undefined;
};

function isJjKind(kind: VcsKind): boolean {
  return kind === 'jj-colocated' || kind === 'jj-native';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function optionalMember(value: unknown, key: string): unknown {
  const record = asRecord(value);
  return record === undefined ? undefined : record[key];
}

function descriptorFromSniff(sniff: VcsSniff): GuardDescriptorLike {
  return {
    kind: sniff.kind,
    jjRoot: sniff.jjRoot,
    root: sniff.jjRoot ?? sniff.gitMarkRoot ?? sniff.cwd,
  };
}

/** Reason text for one kind (contract §8.5, verbatim). */
export function gitConfusionWhy(kind: VcsKind): string {
  return kind === 'jj-native'
    ? 'This is a jj-native repository: it has no root .git, so git would act on an unrelated Git repository found in a parent directory (or on nothing at all). Either way the jj repository\'s state would be untouched and the result misleading.'
    : 'This is a colocated repository: git and jj share one working copy, but only jj knows the real change graph. A git write here does not create a jj change, is invisible to the jj operation log, and cannot be undone with jj undo — and jj then resets the working-copy parent to the new Git HEAD, so your original @ becomes an extra head while bookmarks do not advance.';
}

/**
 * Model-facing refusal text for one mutating Git invocation (contract §8.5).
 *
 * @param invocation - the classified Git invocation.
 * @param descriptor - descriptor of the effective directory (jj kind).
 * @returns the refusal text.
 */
export function buildGitRefusalMessage(invocation: GitInvocation, descriptor: GuardDescriptorLike): string {
  const equivalence = gitEquivalence(invocation);
  return [
    `Blocked: \`git ${invocation.subcommand ?? ''}\` in a Jujutsu (jj) workspace (${descriptor.kind}: ${descriptor.root}).`,
    gitConfusionWhy(descriptor.kind),
    '',
    'Use the jj equivalent instead:',
    `  ${equivalence.length > 0 ? equivalence : JJ_EQUIVALENCE.noEquivalent}`,
    '',
    'Read-only git commands are still allowed for inspection (for example `git log`, `git diff`, `git show`, `git rev-parse`).',
    'If raw git is genuinely required here, your user can set the dsh-jj setting guardMutatingGit to "warn" or "off".',
  ].join('\n');
}

/**
 * Model-facing preference notice for a git write that was **allowed** in a jj workspace.
 *
 * Policy: a jj workspace prefers jj, it does not forbid git. Mutating git commands run
 * (warn mode) and this notice is appended to the tool result so the model learns the
 * preference from the outcome instead of being blocked. The text stays short: it must
 * read as guidance next to the command's own output.
 */
export function buildGitPreferenceNotice(invocation: GitInvocation, descriptor: GuardDescriptorLike): string {
  const equivalence = gitEquivalence(invocation);
  const shape =
    descriptor.kind === 'jj-colocated'
      ? 'git and jj share this working copy, so jj re-imports the result and resets the working-copy parent to the new Git HEAD'
      : 'this jj workspace has no root .git, so git acted on whatever Git repository discovery found (possibly an unrelated parent one)';
  return [
    `Note (dsh-jj): \`git ${invocation.subcommand ?? ''}\` ran in a Jujutsu (jj) workspace (${descriptor.kind}: ${descriptor.root}).`,
    `This repository prefers jj — it is not blocked, but ${shape}, and the change does not appear in jj's operation log (so \`jj undo\` cannot take it back).`,
    `Prefer the jj equivalent: ${equivalence.length > 0 ? equivalence : JJ_EQUIVALENCE.noEquivalent}`,
  ].join('\n');
}

/** Model-facing refusal text for `create_worktree` (contract §8.7, verbatim structure). */
export function buildWorktreeToolRefusalMessage(toolName: string, descriptor: GuardDescriptorLike): string {
  return [
    `Blocked: \`${toolName}\` in a Jujutsu (jj) workspace (${descriptor.kind}: ${descriptor.root}).`,
    'This tool creates a raw Git worktree and a Git branch. jj does not see such a checkout as one of its workspaces, so the new directory would be invisible to jj (no working-copy change, no operation-log entry) while this session\'s working directory moved into it.',
    'Measured facts about `git worktree` inside a jj repository:',
    '  - the checkout is not listed by `jj workspace list` (it has no working-copy commit);',
    '  - the new Git branch is imported as a jj bookmark on the next snapshot/import;',
    '  - jj commands run inside that checkout operate on the main workspace, not on the checkout;',
    '  - the reported `baseCommit` is the Git commit of `@-`, not of `@`.',
    '',
    'Use the jj equivalent instead:',
    '  jj_workspace_add with the same directory (jj creates a registered workspace, and a matching Git worktree when the repository is colocated).',
    '',
    'Then switch directories with the working-directory tool.',
  ].join('\n');
}

/**
 * Refusal text for a repository-wide jj command (contract §8.3b, verbatim).
 *
 * @param invocation - the classified jj invocation.
 * @param descriptor - descriptor of the effective directory.
 * @param cwd - the directory the command would start in.
 * @returns the refusal text.
 */
export function buildJjRepoWideRefusal(invocation: JjInvocation, descriptor: GuardDescriptorLike, cwd: string): string {
  return [
    `Blocked: \`jj ${invocation.subcommand}\` targets repository-wide state from a directory that is not this repository's own workspace root (${cwd} -> ${descriptor.root}).`,
    `This operation would rewrite the working copy of ${descriptor.root}, which is shared with other sessions or agents working in this directory, and would delete any file created after the restored operation.`,
    '',
    'Safer alternatives:',
    '  - Inspect first: `jj --at-op=<op-id> <read-command>` replays an old operation read-only.',
    '  - Recover a single path: `jj restore --from <revset> <path>` touches only that path.',
    '  - To roll back the whole workspace deliberately, use the jj_undo tool, which reports exactly what was undone and what was restored.',
    '',
    'An operator can change this with the dsh-jj setting guardJjRepositoryWide ("warn" allows it with a warning, "off" disables the check).',
  ].join('\n');
}

/**
 * Hard-deny text for jj commands that discard working-copy content with no
 * explicit target (contract §8.3b; never short-circuited by config).
 *
 * @param invocation - the classified jj invocation.
 * @param descriptor - descriptor of the effective directory.
 * @returns the refusal text.
 */
export function buildJjHardDenyRefusal(invocation: JjInvocation, _descriptor: GuardDescriptorLike): string {
  const detail =
    invocation.subcommand === 'restore'
      ? 'It silently discarded working-copy changes in testing, reporting only "removed 1 files".'
      : invocation.subcommand === 'abandon'
        ? '@ is the current working copy; abandoning it dropped the uncommitted files from disk in testing.'
        : "The flag disables jj's only built-in protection: jj refuses to undo another workspace's operation by default.";
  return [
    `Blocked: \`jj ${invocation.subcommand}\` is refused in this workspace because it discards working-copy content with no explicit target.`,
    detail,
    '',
    'Instead:',
    '  - `jj restore <path>` restores exactly the paths you name (no arguments means "restore everything", which is why it is blocked).',
    '  - `jj op log -n 3` shows the last operations; `jj op restore <op-id>` rolls the repository back deliberately and is itself undoable.',
    '  - `jj --at-op=<op-id> <read-command>` inspects an old operation without changing anything.',
    "Abandoning the working copy (`jj abandon @`) or undoing another workspace's operations (--allow-cross-workspace) is never performed implicitly here.",
  ].join('\n');
}

/** One-time warning text for a repository-wide jj command (contract §8.3b, verbatim). */
export function buildJjRepoWideWarning(invocation: JjInvocation, descriptor: GuardDescriptorLike, headOperationId?: string): string {
  const head =
    headOperationId === undefined || headOperationId === 'unknown'
      ? ''
      : ` Head operation before this call: ${headOperationId} — to roll back, run \`jj op restore ${headOperationId}\`.`;
  return (
    `jj warning: \`jj ${invocation.subcommand}\` is repository-wide. It rewrites the entire working copy of ${descriptor.root} (${descriptor.kind}) ` +
    'and can delete files created after the restored operation. If this workspace is shared with other agents or sessions, confirm before proceeding; ' +
    '`jj --at-op=<op-id> jj log` inspects an old operation read-only.' +
    head
  );
}

/**
 * Find mutating Git invocations that would run inside a jj workspace.
 *
 * Pure with respect to the repository: classifies the command line, follows
 * `cd`/`-C` to compute each invocation's effective directory, and sniffs that
 * directory. It never executes anything.
 *
 * @param commandLine - shell command line as written by the model.
 * @param baseCwd - directory the shell starts in.
 * @param options - injectable sniff for tests.
 * @returns classification, per-invocation effective cwd, and findings.
 */
export function evaluateGitCommand(
  commandLine: string,
  baseCwd: string,
  options: EvaluateGitCommandOptions = {},
): GitCommandEvaluation {
  const sniff = options.sniff ?? ((cwd: string) => descriptorFromSniff(sniffVcsSync(cwd)));
  const classification = classifyGitInvocation(commandLine);
  const findings: GitGuardFinding[] = [];
  const effectiveCwds: string[] = [];
  let cursor: string;
  try {
    cursor = resolve(baseCwd);
  } catch {
    cursor = baseCwd;
  }

  for (const segment of classification.segments) {
    if (segment.cdTarget !== undefined) {
      cursor = isAbsolute(segment.cdTarget) ? segment.cdTarget : resolve(cursor, segment.cdTarget);
    }
    for (const invocationIndex of segment.invocationIndexes) {
      const invocation = classification.invocations[invocationIndex];
      if (invocation === undefined) continue;
      const effective = invocation.changeDir === undefined
        ? cursor
        : isAbsolute(invocation.changeDir)
          ? invocation.changeDir
          : resolve(cursor, invocation.changeDir);
      effectiveCwds[invocationIndex] = effective;
      if (!invocation.mutating) continue;
      const descriptor = sniff(effective);
      if (!isJjKind(descriptor.kind)) continue;
      findings.push({
        invocation,
        cwd: effective,
        root: descriptor.root,
        kind: descriptor.kind,
        ...(descriptor.workspaceName !== undefined ? { workspaceName: descriptor.workspaceName } : {}),
        message: buildGitRefusalMessage(invocation, descriptor),
      });
    }
  }

  return { classification, findings: Object.freeze(findings), effectiveCwds: Object.freeze(effectiveCwds) };
}

function looksLikeGuardOptions(value: unknown): value is GuardOptions {
  const record = asRecord(value);
  if (record === undefined) return false;
  return 'service' in record || 'config' in record || 'warm' in record;
}

/**
 * Install the git-confusion guard (and, when the host supports it, the async
 * warm-up listener) on a Cordis context.
 *
 * @param host - context exposing `tools.guard`; `on`, `logger`, `emit`, and
 *   `workingDirectory` are used opportunistically when present.
 * @param options - either a bare {@link JjPluginConfig} (standalone use) or
 *   {@link GuardOptions} with the jj service.
 * @returns a disposer function that also exposes `check`, `warnings`, and `config`.
 */
export function installGitConfusionGuard(
  host: ToolGuardHost,
  options: JjPluginConfig | GuardOptions = {},
): GitConfusionGuardHandle {
  const guardOptions: GuardOptions = looksLikeGuardOptions(options) ? options : { config: options };
  const resolved = resolveConfig(guardOptions.config ?? {});
  const service = guardOptions.service;
  const warmExplicit = guardOptions.warm;

  const warnings: GitConfusionGuardWarning[] = [];
  const decisions = new Map<string, string | undefined>();
  /** callId → model-visible jj-preference notice for a git write that warn mode ALLOWED. */
  const preferenceNotices = new Map<string, string>();
  const emittedNotices = new Set<string>();
  const headOperations = new Map<string, string>();

  const readCommandLine = (args: Record<string, unknown> | undefined): string | undefined => {
    if (args === undefined) return undefined;
    for (const key of ['command', 'text']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return undefined;
  };

  /**
   * Resolve the directory a tool call would run in (contract §5.10).
   *
   * Order: explicit `workdir` argument → the session's working directory through
   * `workingDirectory.get(agent.session)` (the real `WorkingDirectoryService` is
   * keyed by **Session**; a live Agent carries it at `agent.session`) → for calls
   * with no agent at all, the configured `defaultCwd`.
   *
   * Resolution failure never falls back to `process.cwd()` silently: the guard
   * emits a one-time `jj/guard-degraded` diagnostic and **allows** this call
   * (fail-open, contract §5.10 / §8.1).
   */
  const resolveBaseCwd = (
    execution: GuardExecutionLike,
    args: Record<string, unknown> | undefined,
  ): { cwd: string; degraded: boolean } => {
    const fallback = resolved.defaultCwd.length > 0 ? resolved.defaultCwd : process.cwd();
    const workdir = args?.['workdir'];
    if (typeof workdir === 'string' && workdir.length > 0) {
      return { cwd: isAbsolute(workdir) ? workdir : resolve(fallback, workdir), degraded: false };
    }
    if (execution.agent === undefined) {
      // No calling agent: the documented defaultCwd path (tests/embedders).
      return { cwd: fallback, degraded: false };
    }

    const workingDirectory = optionalMember(host, 'workingDirectory');
    const get = optionalMember(workingDirectory, 'get');
    if (typeof get !== 'function' || workingDirectory === undefined) {
      return { cwd: fallback, degraded: diagnoseCwdFailure(execution, 'the host exposes no workingDirectory service') };
    }
    // The real service wants the Session; keep the agent itself as a second
    // candidate for implementations that key on either.
    const candidates: unknown[] = [optionalMember(execution.agent, 'session'), execution.agent];
    let lastError: unknown;
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      try {
        const cwd = (get as (key: unknown) => unknown).call(workingDirectory, candidate);
        if (typeof cwd === 'string' && cwd.length > 0) return { cwd, degraded: false };
      } catch (error) {
        lastError = error;
      }
    }
    return {
      cwd: fallback,
      degraded: diagnoseCwdFailure(
        execution,
        lastError === undefined ? 'the working directory was empty' : lastError instanceof Error ? lastError.message : String(lastError),
      ),
    };
  };

  /** One-time diagnostic for a degraded cwd resolution; returns true (degraded). */
  const diagnoseCwdFailure = (execution: GuardExecutionLike, reason: string): boolean => {
    emitOnce(
      'cwd-degraded',
      {
        tool: execution.name,
        cwd: resolved.defaultCwd.length > 0 ? resolved.defaultCwd : process.cwd(),
        kind: 'none' as VcsKind,
        subcommand: '',
        message:
          `dsh-jj could not resolve the session working directory (${reason}); ` +
          'the git-confusion guard allowed this call instead of guessing a directory.',
      },
      'jj/guard-degraded',
    );
    return true;
  };

  const peek = (cwd: string): GuardDescriptorLike | undefined => {
    if (service !== undefined) {
      try {
        const descriptor = service.peek(cwd);
        if (descriptor !== undefined) {
          return {
            kind: descriptor.kind,
            jjRoot: descriptor.jjRoot,
            root: descriptor.root,
            workspaceName: descriptor.workspaceName,
          };
        }
      } catch {
        // Fall through to the sniff fast path.
      }
    }
    return descriptorFromSniff(sniffVcsSync(cwd));
  };

  const emitOnce = (key: string, payload: Record<string, unknown>, event = 'jj/git-confusion'): boolean => {
    if (emittedNotices.has(key)) return false;
    emittedNotices.add(key);
    const emit = optionalMember(host, 'emit');
    if (typeof emit === 'function') {
      try {
        (emit as (event: string, value: unknown) => void).call(host, event, payload);
      } catch {
        // Observability must never break the tool pipeline.
      }
    }
    const logger = optionalMember(host, 'logger');
    const warn = optionalMember(logger, 'warn');
    if (typeof warn === 'function' && logger !== undefined) {
      (warn as (message: string) => void).call(logger, String(payload['message'] ?? 'dsh-jj guard notice'));
    }
    return true;
  };

  const observe = (tool: string, commandLine: string, finding: GitGuardFinding): void => {
    const warning: GitConfusionGuardWarning = {
      at: Date.now(),
      tool,
      commandLine,
      subcommand: finding.invocation.subcommand,
      cwd: finding.cwd,
      root: finding.root,
      kind: finding.kind,
      message: finding.message,
    };
    warnings.push(warning);
    if (warnings.length > 50) warnings.splice(0, warnings.length - 50);
    emitOnce(`${finding.cwd}|guard|${finding.invocation.subcommand ?? ''}`, {
      tool,
      cwd: finding.cwd,
      kind: finding.kind,
      subcommand: finding.invocation.subcommand ?? '',
      message: finding.message,
    });
  };

  /**
   * Repository-wide jj commands and scope creep (contract §8.3b). Scope creep is
   * always denied; repository-wide commands follow `guardJjRepositoryWide`, whose
   * default (`warn`) deliberately allows jj's preferred recovery path.
   */
  const decideJjCommand = (
    execution: GuardExecutionLike,
    args: Record<string, unknown> | undefined,
    commandLine: string,
  ): string | undefined => {
    if (!resolved.guardTools.includes(execution.name)) return undefined;
    const classification = classifyJjInvocation(commandLine);
    if (classification.invocations.length === 0) return undefined;
    const resolvedCwd = resolveBaseCwd(execution, args);
    if (resolvedCwd.degraded) return undefined; // fail-open (contract §5.10)
    const baseCwd = resolvedCwd.cwd;
    const base = peek(baseCwd);

    for (const invocation of classification.invocations) {
      // Scope creep: a jj command aimed at another repository is never allowed.
      if (invocation.repository !== undefined) {
        const target = isAbsolute(invocation.repository) ? invocation.repository : resolve(baseCwd, invocation.repository);
        const targetDescriptor = peek(target);
        if (targetDescriptor === undefined || !isJjKind(targetDescriptor.kind) || (base !== undefined && targetDescriptor.jjRoot !== base.jjRoot)) {
          return [
            `Blocked: \`jj ${invocation.subcommand}\` targets \`${invocation.repository}\`, which is not the repository this session is working in.`,
            'Running jj against another repository (or an ancestor workspace) can rewrite a working copy owned by another session or agent.',
            '',
            'Safer alternatives:',
            '  - Run the command from that directory in its own session.',
            '  - Inspect this repository with `jj log` / `jj status` / `jj --at-op=<op-id> jj log`.',
          ].join('\n');
        }
      }
      const descriptor = base ?? { kind: 'none' as VcsKind, jjRoot: undefined, root: baseCwd };
      if (!isJjKind(descriptor.kind)) continue;

      // Hard denies (contract §8.3b): never short-circuited by config.
      if (invocation.scope === 'destructive') {
        return buildJjHardDenyRefusal(invocation, descriptor);
      }
      if (invocation.scope !== 'repo-wide') continue;

      // `jj workspace forget <other>` affects someone else's workspace: always deny.
      if (invocation.subcommand === 'workspace forget' && invocation.targetWorkspace !== undefined && invocation.targetWorkspace !== descriptor.workspaceName) {
        return buildJjRepoWideRefusal(invocation, descriptor, baseCwd);
      }
      const mode = resolved.guardJjRepositoryWide;
      if (mode === 'off') continue;
      if (mode === 'deny') return buildJjRepoWideRefusal(invocation, descriptor, baseCwd);
      emitOnce(
        `${baseCwd}|repo-wide|${invocation.subcommand}`,
        {
          tool: execution.name,
          cwd: baseCwd,
          kind: descriptor.kind,
          subcommand: invocation.subcommand,
          message: buildJjRepoWideWarning(invocation, descriptor, headOperations.get(baseCwd)),
        },
        'jj/repo-wide-op',
      );
    }
    return undefined;
  };

  const decideGitCommand = (execution: GuardExecutionLike, args: Record<string, unknown> | undefined): string | undefined => {
    if (resolved.guardMutatingGit === 'off') return undefined;
    if (!resolved.guardTools.includes(execution.name)) return undefined;
    const commandLine = readCommandLine(args);
    if (commandLine === undefined) return undefined;

    const classification = classifyGitInvocation(commandLine);
    if (classification.invocations.length === 0) return undefined;

    const resolvedCwd = resolveBaseCwd(execution, args);
    if (resolvedCwd.degraded) return undefined; // fail-open (contract §5.10)
    let cursor: string;
    try {
      cursor = resolve(resolvedCwd.cwd);
    } catch {
      cursor = resolvedCwd.cwd;
    }

    for (const segment of classification.segments) {
      if (segment.cdTarget !== undefined) {
        cursor = isAbsolute(segment.cdTarget) ? segment.cdTarget : resolve(cursor, segment.cdTarget);
      }
      for (const invocationIndex of segment.invocationIndexes) {
        const invocation = classification.invocations[invocationIndex];
        if (invocation === undefined) continue;
        const cwd = invocation.changeDir === undefined
          ? cursor
          : isAbsolute(invocation.changeDir)
            ? invocation.changeDir
            : resolve(cursor, invocation.changeDir);
        const descriptor = peek(cwd);
        if (descriptor === undefined) continue; // fail-open (contract §8.4)
        if (!isJjKind(descriptor.kind)) {
          // `git` / `none`: no interference. A jj workspace above a nearer Git
          // repository (F6) gets a one-time notice instead.
          if (descriptor.kind === 'git' && descriptor.jjRoot !== undefined) {
            emitOnce(`${cwd}|shadowed|${invocation.subcommand ?? ''}`, {
              tool: execution.name,
              cwd,
              kind: descriptor.kind,
              subcommand: invocation.subcommand ?? '',
              message: 'Notice: this directory is owned by a Git repository nested inside a jj workspace; the jj workspace was not used for the decision.',
            });
          }
          continue;
        }
        if (invocation.safety === 'unknown') continue; // never deny an unclassified invocation
        if (invocation.safety === 'read') {
          if (descriptor.kind === 'jj-native' && resolved.guardGitInJjNative !== 'off') {
            const message =
              `Notice: \`git ${invocation.subcommand ?? ''}\` is a read-only Git command inside a jj-native workspace (${descriptor.root}). ` +
              'Git has no root .git here, so it either failed or inspected an unrelated parent repository; use jj-native inspection commands (jj_log / jj_status) for the authoritative view.';
            if (resolved.guardGitInJjNative === 'deny') {
              return [
                `Blocked: \`git ${invocation.subcommand ?? ''}\` in a Jujutsu (jj) workspace (jj-native: ${descriptor.root}).`,
                'This is a jj-native repository with no root .git: git cannot inspect it meaningfully.',
                '',
                'Use the jj equivalent instead:',
                '  jj log / jj status / jj diff / jj show (jj-native inspection)',
              ].join('\n');
            }
            emitOnce(`${cwd}|read-jj-native|${invocation.subcommand ?? ''}`, { tool: execution.name, cwd, kind: descriptor.kind, subcommand: invocation.subcommand ?? '', message });
          } else if (descriptor.kind === 'jj-colocated' && resolved.readOnlyGitNotice) {
            emitOnce(`${cwd}|read-colocated|${invocation.subcommand ?? ''}`, {
              tool: execution.name,
              cwd,
              kind: descriptor.kind,
              subcommand: invocation.subcommand ?? '',
              message: `Notice: \`git ${invocation.subcommand ?? ''}\` inside a colocated jj workspace: git's HEAD/index view differs from jj's working-copy commit @; prefer jj-native inspection.`,
            });
          }
          continue;
        }

        // safety === 'mutate'
        const finding: GitGuardFinding = {
          invocation,
          cwd,
          root: descriptor.root,
          kind: descriptor.kind,
          ...(descriptor.workspaceName !== undefined ? { workspaceName: descriptor.workspaceName } : {}),
          message: buildGitRefusalMessage(invocation, descriptor),
        };
        if (resolved.guardMutatingGit === 'warn') {
          observe(execution.name, commandLine, finding);
          // Preference policy: the command runs, and the model is told to prefer jj.
          if (typeof execution.callId === 'string') {
            if (preferenceNotices.size > 200) preferenceNotices.clear();
            preferenceNotices.set(execution.callId, buildGitPreferenceNotice(invocation, descriptor));
          }
          continue;
        }
        observe(execution.name, commandLine, finding);
        return finding.message;
      }
    }
    return undefined;
  };

  const decide = (execution: GuardExecutionLike, args: Record<string, unknown> | undefined): string | undefined => {
    if (execution.name === 'create_worktree') {
      if (!resolved.guardCreateWorktree) return undefined;
      const resolvedCwd = resolveBaseCwd(execution, args);
      if (resolvedCwd.degraded) return undefined; // fail-open (contract §5.10)
      const cwd = resolvedCwd.cwd;
      const descriptor = peek(cwd);
      if (descriptor === undefined) return undefined;
      if (!isJjKind(descriptor.kind) && descriptor.jjRoot === undefined) return undefined;
      const message = buildWorktreeToolRefusalMessage(execution.name, descriptor);
      const emit = optionalMember(host, 'emit');
      if (typeof emit === 'function') {
        try {
          (emit as (event: string, value: unknown) => void).call(host, 'jj/git-confusion', {
            tool: execution.name,
            cwd,
            kind: descriptor.kind,
            subcommand: 'worktree',
            message,
          });
        } catch {
          // ignore observability failures
        }
      }
      return message;
    }
    const args2 = args;
    const commandLine = readCommandLine(args2);
    if (commandLine !== undefined) {
      const jjReason = decideJjCommand(execution, args2, commandLine);
      if (jjReason !== undefined) return jjReason;
    }
    return decideGitCommand(execution, args);
  };

  const check = (execution: GuardExecutionLike): string | undefined => {
    if (typeof execution?.name !== 'string' || execution.name.length === 0) return undefined;
    const callId = execution.callId;
    if (typeof callId === 'string' && decisions.has(callId)) return decisions.get(callId);
    try {
      return decide(execution, asRecord(execution.arguments));
    } catch {
      // The guard never breaks a tool call; a failure is fail-open (contract §8.1).
      return undefined;
    }
  };

  // ---- async warm-up listener (contract §8.1)
  let warmDispose: (() => void) | undefined;
  const on = host.on;
  if (typeof on === 'function' && (service !== undefined || warmExplicit !== undefined)) {
    try {
      const result = on('tools/pre-execute', async (execution, next) => {
        try {
          const args = asRecord(execution.arguments);
          if (resolved.guardTools.includes(execution.name) || execution.name === 'create_worktree') {
            const resolvedCwd = resolveBaseCwd(execution, args);
            const cwd = resolvedCwd.cwd;
            const signal = execution.signal instanceof AbortSignal ? execution.signal : undefined;
            if (resolvedCwd.degraded) return next(); // fail-open (contract §5.10)
            if (service !== undefined) {
              await service.warm(cwd, signal);
              // Self-protection (contract §8.3b): record the head operation before a
              // repository-wide call so the warning can name a rollback target.
              if (typeof service.operations?.headOperationId === 'function') {
                try {
                  headOperations.set(cwd, await service.operations.headOperationId(cwd, signal));
                } catch {
                  // The warning still renders without a head id.
                }
              }
            } else if (warmExplicit !== undefined) {
              await warmExplicit(cwd);
            }
            if (typeof execution.callId === 'string') decisions.set(execution.callId, decide(execution, args));
          }
        } catch {
          // Warm-up failure must not block the tool call (fail-open).
        }
        return next();
      });
      if (typeof result === 'function') warmDispose = result as () => void;
    } catch {
      // Host without a compatible event API: the sync sniff path still decides.
    }
  }

  // ---- post-execute listener: make the jj preference MODEL-VISIBLE without blocking.
  // A jj workspace prefers jj; it does not forbid git. When warn mode let a git write
  // through, its own output would never mention jj, so the notice is appended here.
  const onPost = host.on;
  if (typeof onPost === 'function') {
    try {
      const postResult = onPost(
        'tools/post-execute',
        async (execution: GuardExecutionLike, result: unknown, next: () => Promise<unknown>) => {
          const decision = (await next()) as { kind?: string; content?: unknown } | undefined;
          const callId = execution?.callId;
          const notice = typeof callId === 'string' ? preferenceNotices.get(callId) : undefined;
          if (notice === undefined || decision === undefined || decision.kind !== 'accept') return decision;
          if (typeof callId === 'string') preferenceNotices.delete(callId);
          const existing = Array.isArray(decision.content)
            ? decision.content
            : Array.isArray((result as { content?: unknown } | undefined)?.content)
              ? ((result as { content: unknown[] }).content)
              : [];
          return { ...decision, content: [...existing, { type: 'text', text: notice }] };
        },
      );
      if (typeof postResult === 'function' && warmDispose === undefined) warmDispose = postResult as () => void;
    } catch {
      // A host without post-execute support simply keeps git allowed and silent.
    }
  }

  const disposeGuard = host.tools.guard(check);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    disposeGuard();
    warmDispose?.();
  };

  const handle = dispose as GitConfusionGuardHandle & Record<string, unknown>;
  Object.assign(handle, {
    dispose,
    config: Object.freeze(resolved),
    check,
    warnings: () => Object.freeze([...warnings]),
    clearWarnings: () => {
      warnings.length = 0;
      emittedNotices.clear();
      decisions.clear();
    },
    peek,
  });
  return handle as GitConfusionGuardHandle;
}
// ---------------------------------------------------------------------------
// Plugin entry (`dsh-jj/guard`, contract §4.1b): a profile can install the
// guard without the service entry. When the `ctx.jj` service exists (tools
// layer), `inject` gains `'jj'` and `apply` passes it as `options.service`.
// ---------------------------------------------------------------------------

/** Cordis plugin name for the guard entry. */
export const name = 'jj-guard';

/** Services required by the guard entry (`jj` is the service from the runtime entry). */
export const inject = ['tools', 'jj'] as const;

/**
 * Install the guard entry on a Cordis context.
 *
 * @param ctx - context providing `tools` (plus optional `logger`/`emit`/`workingDirectory`).
 * @param config - partial plugin configuration.
 */
export function apply(
  ctx: ToolGuardHost & {
    effect?: (body: () => () => void, label?: string) => unknown;
    jj?: GuardServiceLike;
    logger?: unknown;
    emit?: unknown;
    workingDirectory?: unknown;
    on?: (...args: unknown[]) => unknown;
  },
  config: JjPluginConfig = {},
): void {
  // Build the host once with every optional member the guard can use. Reading the
  // live Cordis context directly is what makes `workingDirectory.get(session)` and
  // the warm-up listener available in a production profile (V5).
  //
  // `logger`/`emit` are built-in context members, but a SERVICE must be injected
  // before it can be read as a property — `ctx.workingDirectory` throws
  // "cannot get property \"workingDirectory\" without inject" in a real boot
  // (found by live profile testing 2026-10-22, where the row silently stayed
  // inactive). Optional services therefore go through `ctx.get`, which returns
  // `undefined` instead of throwing, keeping contract §5.10's degrade-and-allow
  // path reachable without a hard dependency on the service.
  const optionalService = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get;
  const workingDirectory =
    typeof optionalService === 'function' ? optionalService.call(ctx, 'workingDirectory') : undefined;
  const rawOn = ctx.on;
  const host: ToolGuardHost = {
    tools: ctx.tools,
    ...(typeof rawOn === 'function'
      ? { on: (event: string, listener: (...args: unknown[]) => unknown) => rawOn.call(ctx, event, listener) }
      : {}),
    ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
    ...(ctx.emit !== undefined ? { emit: ctx.emit } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
  };
  const guard = installGitConfusionGuard(host, { config, ...(ctx.jj !== undefined ? { service: ctx.jj } : {}) });
  if (typeof ctx.effect === 'function') ctx.effect(() => () => guard.dispose(), 'dsh-jj: git-confusion guard');
}
