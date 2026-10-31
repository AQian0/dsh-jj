/**
 * jj-side command classification: repository-wide / workspace-local / read-only
 * / destructive scope and invocation recognition (design contract §8.3b).
 *
 * `jj undo` / `jj op restore` are jj's preferred recovery path and stay allowed by
 * default, but their scope is the whole repository, so the jj side is classified
 * separately from the Git side and reported conservatively.
 *
 * Pure module: no I/O, no subprocess, no `@deepseek-ai/*` imports. Parsing
 * primitives live in `./git-tokenize.ts`.
 *
 * @module dsh-jj/jj-rules
 */

import {
  baseName,
  isStaticDirectoryTarget,
  MAX_NESTING,
  nestedCommandStrings,
  scanPrelude,
  segmentDirectoryChange,
  tokenize,
} from './git-tokenize.ts';
import type { RawSegment, Token } from './git-tokenize.ts';

// ---------------------------------------------------------------------------
// jj-side classification (contract §8.3b)
//
// `jj undo` / `jj op restore` are jj's *preferred recovery path* and must stay
// allowed by default, but their scope is the whole repository: they rewind the
// operation view and rewrite the entire working copy of the current workspace.
// The 2026-10-22 shared-workspace incident (a `jj undo` deleted ~28 files) is the
// reason this side is classified and reported separately from the Git side.
// ---------------------------------------------------------------------------

/** Scope of one jj invocation. */
export type JjScope = 'repo-wide' | 'workspace-local' | 'read-only' | 'scope-creep' | 'destructive' | 'unknown';

/** One jj invocation found in a shell command line. */
export interface JjInvocation {
  readonly argv: readonly string[];
  readonly raw: string;
  /** Normalized subcommand, e.g. `undo`, `op restore`, `workspace forget`. */
  readonly subcommand: string;
  readonly scope: JjScope;
  readonly globalOptions: readonly string[];
  /**
   * `-R`/`--repository` target, when given. jj's global options are accepted
   * after the subcommand too, so this is populated for either position.
   */
  readonly repository?: string;
  /** `--at-op`/`--at-operation` value, when given (read-only replay). */
  readonly atOp?: string;
  /** Argument of `jj workspace forget <name>`. */
  readonly targetWorkspace?: string;
  /** True for `jj undo --allow-cross-workspace` (hard-deny per contract §8.3b). */
  readonly allowCrossWorkspace?: boolean;
  /** Non-flag arguments after the subcommand (used for `abandon @` / `restore` pathspecs). */
  readonly positionals?: readonly string[];
  readonly confidence: 'high' | 'low';
  readonly reason: string;
}

/**
 * One shell segment of a jj command line.
 *
 * `changeDir` is set only when the segment starts with `cd`/`pushd` and its target
 * can be resolved statically: `cd <literal>`, `cd -P <literal>`, `cd -- <literal>`
 * and `pushd <literal>` are followed; `$VAR`, command substitution, backticks, an
 * unexpanded `~`, `cd -`, bare `pushd` and `popd` are not. The guard follows it in
 * {@link JjCommandClassification.segments} order to compute the directory each
 * invocation would actually run in; a missing field means "cannot be determined
 * statically" (callers must fail open).
 */
export interface JjParsedSegment {
  /** Raw shell segment text this segment was parsed from. */
  readonly raw: string;
  /** `substitution` marks the inner text of `$(…)` or `` `…` ``. */
  readonly kind: 'command' | 'substitution';
  /** Dequoted words of the segment (no redirection targets, no heredoc bodies). */
  readonly words: readonly string[];
  /** False when the segment contained an unterminated quote/heredoc or a trailing escape. */
  readonly parsed: boolean;
  /** Statically resolvable target of a leading `cd <path>` in this segment. */
  readonly changeDir?: string;
  /** Indexes into {@link JjCommandClassification.invocations}. */
  readonly invocationIndexes: readonly number[];
}

/** Result of {@link classifyJjInvocation}. */
export interface JjCommandClassification {
  readonly invocations: readonly JjInvocation[];
  /** Segments in command-line order; the guard follows `changeDir` changes through them. */
  readonly segments: readonly JjParsedSegment[];
  readonly warnings: readonly string[];
}

/** jj subcommands whose scope is repository-wide (contract §8.3b). */
export const JJ_REPO_WIDE_SUBCOMMANDS: readonly string[] = Object.freeze([
  'undo',
  'redo',
  'abandon',
  'op restore',
  'op revert',
  'op abandon',
  'workspace forget',
  'workspace rename',
]);

/** jj subcommands that only touch the current workspace (never blocked). */
export const JJ_WORKSPACE_LOCAL_SUBCOMMANDS: readonly string[] = Object.freeze([
  'new',
  'describe',
  'commit',
  'squash',
  'rebase',
  'edit',
  'restore',
  'split',
  'absorb',
  'metaedit',
  'duplicate',
  'diffedit',
  'fix',
  'resolve',
  'next',
  'prev',
  'squash',
  'move',
  'parallelize',
  'simplify-parents',
  'bookmark create',
  'bookmark set',
  'bookmark delete',
  'bookmark list',
  'tag set',
  'tag delete',
  'file list',
  'file show',
  'sparse set',
  'workspace add',
  'workspace list',
  'workspace root',
  'git fetch',
  'git push',
  'git remote',
  'util gc',
  'config',
]);

/** jj subcommands that never write the repository. */
export const JJ_READ_ONLY_SUBCOMMANDS: readonly string[] = Object.freeze([
  'status',
  'log',
  'diff',
  'show',
  'evolog',
  'op log',
  'op show',
  'op diff',
  'file list',
  'file show',
  'file search',
  'bookmark list',
  'tag list',
  'workspace list',
  'workspace root',
  'root',
  'version',
  'debug',
  'help',
]);

/** Subcommands whose second word belongs to the subcommand (`jj op restore`). */
const JJ_TWO_WORD = new Set([
  'op',
  'workspace add',
  'workspace forget',
  'file',
  'bookmark',
  'tag',
  'git',
  'util',
  'sparse',
  'debug',
]);

const JJ_VALUE_FLAGS = new Set([
  '-R',
  '--repository',
  '--at-op',
  '--at-operation',
  '--config',
  '--config-file',
  '--color',
]);

/**
 * jj subcommand options that take a value. Their values must never be counted
 * as positionals: `jj new -m "msg"` has no revset argument, while
 * `jj new -m "msg" @-` does, and `jj restore --from @-` has no filesets.
 */
const JJ_SUBCOMMAND_VALUE_FLAGS = new Set([
  '-R',
  '--repository',
  '--at-op',
  '--at-operation',
  '-m',
  '--message',
  '-r',
  '--revisions',
  '--revision',
  '-o',
  '-A',
  '--insert-after',
  '-B',
  '--insert-before',
  '--after',
  '--before',
  '-f',
  '--from',
  '-t',
  '--into',
  '--to',
  '-c',
  '--changes-in',
  '-d',
  '--destination',
  '-s',
  '--source',
  '-T',
  '--template',
  '--config',
  '--config-file',
  '--color',
  '--tool',
]);

/** Revision-taking aliases whose value still names a revision (`-r @-`). */
const JJ_REVISION_FLAGS = new Set(['-r', '--revisions', '--revision', '-o']);

/** Flags whose value is the revision `jj restore` writes into (`--into`/`--to`/`-t`). */
const JJ_INTO_FLAGS = new Set(['-t', '--into', '--to']);

interface ScannedJjArgs {
  readonly flags: string[];
  readonly positionals: string[];
  /** Values of `-r/--revisions/-o` (revsets, not filesets). */
  readonly revisionTargets: string[];
  /** Values of `-t/--into/--to` (the revision `jj restore`/`jj squash` writes into). */
  readonly intoTargets: string[];
  /** `-R`/`--repository` value: a global option jj also accepts after the subcommand. */
  readonly repository?: string;
}

/**
 * Split jj subcommand arguments into flags, positionals, and revision/into targets.
 *
 * jj's global options are declared `global = true` in clap, so they are accepted
 * **after** the subcommand too (`jj op restore <id> -R <other-repo>`). Capturing
 * the repository here keeps the scope-creep hard deny independent of the option
 * position.
 */
function scanJjArgs(rest: readonly string[]): ScannedJjArgs {
  const flags: string[] = [];
  const positionals: string[] = [];
  const revisionTargets: string[] = [];
  const intoTargets: string[] = [];
  let repository: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token === '--') {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (token.startsWith('-') && token !== '-') {
      const eq = token.indexOf('=');
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      const attachedShort = eq < 0 && token.length > 2 && !token.startsWith('--') ? token.slice(0, 2) : undefined;
      if (attachedShort !== undefined && JJ_SUBCOMMAND_VALUE_FLAGS.has(attachedShort)) {
        flags.push(attachedShort);
        if (attachedShort === '-R') repository = token.slice(2);
        else if (JJ_REVISION_FLAGS.has(attachedShort)) revisionTargets.push(token.slice(2));
        else if (JJ_INTO_FLAGS.has(attachedShort)) intoTargets.push(token.slice(2));
        continue;
      }
      flags.push(flag);
      if (eq < 0 && JJ_SUBCOMMAND_VALUE_FLAGS.has(flag)) {
        const value = rest[index + 1];
        if (value !== undefined) {
          index += 1;
          if (flag === '-R' || flag === '--repository') repository = value;
          else if (JJ_REVISION_FLAGS.has(flag)) revisionTargets.push(value);
          else if (JJ_INTO_FLAGS.has(flag)) intoTargets.push(value);
        }
      } else if (eq >= 0 && (flag === '-R' || flag === '--repository')) {
        repository = token.slice(eq + 1);
      } else if (eq >= 0 && JJ_INTO_FLAGS.has(flag)) {
        intoTargets.push(token.slice(eq + 1));
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals, revisionTargets, intoTargets, ...(repository !== undefined ? { repository } : {}) };
}

/** jj global boolean flags. */
const JJ_BOOLEAN_FLAGS = new Set([
  '--ignore-working-copy',
  '--no-integrate-operation',
  '--ignore-immutable',
  '--no-pager',
  '--quiet',
  '--debug',
]);

function jjSubcommandOf(words: readonly string[]): { subcommand: string; rest: string[] } | undefined {
  const first = words[0];
  if (first === undefined || first.startsWith('-')) return undefined;
  const second = words[1];
  // `operation` is the canonical spelling and `op` is its alias: normalize both to
  // `op <verb>` so the scope table and the `workspace forget`-style special cases
  // apply identically.
  if ((first === 'op' || first === 'operation') && second !== undefined && !second.startsWith('-')) {
    return { subcommand: `op ${second}`, rest: words.slice(2) };
  }
  if (first === 'workspace' && second !== undefined && !second.startsWith('-')) {
    return { subcommand: `workspace ${second}`, rest: words.slice(2) };
  }
  if (second !== undefined && JJ_TWO_WORD.has(first) && !second.startsWith('-')) {
    return { subcommand: `${first} ${second}`, rest: words.slice(2) };
  }
  return { subcommand: first, rest: words.slice(1) };
}

function classifyJjWords(
  words: readonly Token[],
  raw: string,
  parsed: boolean,
  warnings: string[],
): JjInvocation | undefined {
  if (!parsed || words.length === 0) return undefined;
  const index = scanPrelude(words, warnings).programIndex;
  const program = words[index]?.value ?? '';
  if (baseName(program) !== 'jj' && baseName(program) !== 'jj.exe') return undefined;

  const globalOptions: string[] = [];
  let repository: string | undefined;
  let atOp: string | undefined;
  let cursor = index + 1;
  while (cursor < words.length) {
    const token = words[cursor]?.value ?? '';
    if (token === '--') {
      cursor += 1;
      break;
    }
    if (!token.startsWith('-') || token === '-') break;
    const eq = token.indexOf('=');
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    globalOptions.push(token);
    // Attached short-option value: `jj -R<path>` (clap accepts both spellings).
    if (inline === undefined && token.startsWith('-R') && token.length > 2) {
      repository = token.slice(2);
      cursor += 1;
      continue;
    }
    if (JJ_VALUE_FLAGS.has(flag)) {
      const value = inline ?? words[cursor + 1]?.value;
      if (inline === undefined) cursor += 1;
      globalOptions.push(value ?? '');
      if (flag === '-R' || flag === '--repository') repository = value;
      if (flag === '--at-op' || flag === '--at-operation') atOp = value;
    } else if (!JJ_BOOLEAN_FLAGS.has(flag) && !/^--(color|config|at-op)/.test(flag)) {
      globalOptions.push('(unrecognised)');
    }
    cursor += 1;
  }

  let tail = words.slice(cursor).map((token) => token.value);
  // Tolerate a repeated program token (`jj --at-op=<id> jj log`, as printed in some
  // jj hints) by dropping it before resolving the subcommand.
  if (tail.length > 1 && (baseName(tail[0] ?? '') === 'jj' || baseName(tail[0] ?? '') === 'jj.exe'))
    tail = tail.slice(1);
  const parsedSub = jjSubcommandOf(tail);
  if (parsedSub === undefined) {
    return {
      argv: ['jj', ...globalOptions],
      raw,
      subcommand: '',
      scope: 'unknown',
      globalOptions,
      ...(repository !== undefined ? { repository } : {}),
      ...(atOp !== undefined ? { atOp } : {}),
      confidence: 'low',
      reason: 'jj was invoked without a recognizable subcommand',
    };
  }
  const { subcommand, rest } = parsedSub;

  const { flags: restFlags, positionals, revisionTargets, intoTargets, repository: restRepository } = scanJjArgs(rest);
  // jj global options may follow the subcommand (`jj op restore <id> -R <repo>`);
  // the scope-creep decision must not depend on where the option was written.
  if (restRepository !== undefined) repository = restRepository;
  const allowCrossWorkspace = restFlags.includes('--allow-cross-workspace');
  const hasRevisionArgument = positionals.length >= 1 || revisionTargets.length >= 1;
  const abandonsWorkingCopy = positionals.includes('@') || revisionTargets.includes('@');
  // `jj restore`/`jj squash` with `--into <revision other than @>` write a revision
  // outside the working copy (its descendants are rebased), so they are
  // repository-wide rather than workspace-local. `--into @` keeps the default
  // working-copy semantics.
  const intoOther =
    subcommand === 'restore' || subcommand === 'squash'
      ? intoTargets.find((target) => target.trim() !== '@')
      : undefined;

  let scope: JjScope;
  let reason: string;
  if (restFlags.includes('--help') || restFlags.includes('-h')) {
    scope = 'read-only';
    reason = `\`jj ${subcommand} --help\` only prints help`;
  } else if (intoOther !== undefined) {
    scope = 'repo-wide';
    reason = `\`jj ${subcommand} --into ${intoOther}\` rewrites a revision other than the working copy and rebases its descendants`;
  } else if (subcommand === 'restore' && positionals.length === 0) {
    scope = 'destructive';
    reason = '`jj restore` without a fileset silently discards the entire working-copy change';
  } else if (subcommand === 'abandon' && (abandonsWorkingCopy || !hasRevisionArgument)) {
    scope = 'destructive';
    reason = '`jj abandon` (default `@`) discards the working-copy commit and its uncommitted files from disk';
  } else if (subcommand === 'undo' && allowCrossWorkspace) {
    scope = 'destructive';
    reason = "`jj undo --allow-cross-workspace` disables jj's only built-in cross-workspace protection";
  } else if (atOp !== undefined && JJ_READ_ONLY_SUBCOMMANDS.includes(subcommand)) {
    scope = 'read-only';
    reason = `\`jj --at-op=${atOp} ${subcommand}\` replays an old operation read-only`;
  } else if (subcommand === 'edit' && hasRevisionArgument) {
    scope = 'repo-wide';
    reason =
      '`jj edit <rev>` switches the working copy to another revision, so files outside that tree disappear from disk';
  } else if (subcommand === 'new' && hasRevisionArgument) {
    scope = 'repo-wide';
    reason =
      '`jj new <revset>` moves the working copy onto another revision, so files outside that tree disappear from disk';
  } else if (subcommand === 'op abandon') {
    scope = 'repo-wide';
    reason =
      '`jj op abandon` discards operation history shared with other workspaces (their `jj undo`/`jj op restore` recoverability)';
  } else if (subcommand === 'workspace rename') {
    scope = 'repo-wide';
    reason = '`jj workspace rename` changes shared repository metadata that other sessions address workspaces by';
  } else if (JJ_REPO_WIDE_SUBCOMMANDS.includes(subcommand)) {
    scope = 'repo-wide';
    reason = `\`jj ${subcommand}\` is repository-wide: it rewinds the operation view and rewrites the whole working copy of the current workspace`;
  } else if (JJ_READ_ONLY_SUBCOMMANDS.includes(subcommand)) {
    scope = 'read-only';
    reason = `\`jj ${subcommand}\` does not write the repository`;
  } else if (JJ_WORKSPACE_LOCAL_SUBCOMMANDS.includes(subcommand)) {
    scope = 'workspace-local';
    reason = `\`jj ${subcommand}\` only affects the current workspace`;
  } else {
    scope = 'unknown';
    reason = `\`jj ${subcommand}\` is not in the scope table; not treated as repository-wide`;
  }

  const targetWorkspace = subcommand === 'workspace forget' ? positionals[0] : undefined;
  return {
    argv: ['jj', ...globalOptions, ...tail],
    raw,
    subcommand,
    scope,
    globalOptions,
    ...(repository !== undefined ? { repository } : {}),
    ...(atOp !== undefined ? { atOp } : {}),
    ...(targetWorkspace !== undefined ? { targetWorkspace } : {}),
    ...(allowCrossWorkspace ? { allowCrossWorkspace } : {}),
    positionals,
    confidence: 'high',
    reason,
  };
}

/**
 * Recognize jj invocations in a shell command line (contract §8.3b).
 *
 * The returned {@link JjCommandClassification.segments} mirror the Git-side
 * `ParsedSegment` shape: each segment carries a statically resolvable
 * `changeDir` (only for `cd`/`pushd` with a literal target), and
 * `invocationIndexes` point into `invocations`, so a synchronous guard can follow
 * directory changes between invocations without spawning anything. Shell wrappers
 * are expanded recursively, so a nested `bash -c '…'` segment also appears here.
 *
 * @param commandLine - raw shell command string.
 * @returns jj invocations with their scope, the parsed segments, and warnings.
 */
export function classifyJjInvocation(commandLine: string): JjCommandClassification {
  const outer = tokenize(commandLine, 'command', 0);
  const warnings = [...outer.warnings];
  const invocations: JjInvocation[] = [];
  const segments: JjParsedSegment[] = [];
  const record = (segment: RawSegment): void => {
    const invocation = classifyJjWords(segment.words, segment.raw, segment.parsed, warnings);
    const invocationIndexes: number[] = [];
    if (invocation !== undefined) {
      invocationIndexes.push(invocations.length);
      invocations.push(invocation);
    }
    // `cd` options (`cd -P dir`, `cd -- dir`) and `pushd` are followed like a
    // plain `cd`; `cd -` and stack commands cannot be resolved statically and are
    // reported through the parser warnings instead.
    const change = segment.parsed ? segmentDirectoryChange(segment.words) : undefined;
    if (change?.warning !== undefined) warnings.push(change.warning);
    const target = change?.target;
    const changeDir = target !== undefined && isStaticDirectoryTarget(target) ? target : undefined;
    segments.push({
      raw: segment.raw,
      kind: segment.kind,
      words: segment.words.map((token) => token.value),
      parsed: segment.parsed,
      ...(changeDir !== undefined ? { changeDir } : {}),
      invocationIndexes,
    });
  };
  // Recursive expansion (with a depth cap) so nested/prelude shell wrappers are
  // classified instead of silently skipped.
  const recordTree = (segment: RawSegment, depth: number): void => {
    record(segment);
    if (!segment.parsed) return;
    if (depth >= MAX_NESTING) {
      warnings.push('Shell wrapper nesting limit reached; deeper wrapped commands were not classified.');
      return;
    }
    for (const inner of nestedCommandStrings(segment, warnings)) {
      const nested = tokenize(inner, 'substitution', depth + 1);
      warnings.push(...nested.warnings);
      for (const nestedSegment of nested.segments) recordTree(nestedSegment, depth + 1);
    }
  };
  for (const segment of outer.segments) recordTree(segment, 0);
  return {
    invocations: Object.freeze(invocations),
    segments: Object.freeze(segments),
    warnings: Object.freeze(warnings),
  };
}
