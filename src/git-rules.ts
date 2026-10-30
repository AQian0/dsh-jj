/**
 * Table-driven Git command classification: safety types, the subcommand rule
 * table, and invocation recognition (design contract §8.2 / §8.3).
 *
 * Pure module: no I/O, no subprocess, no `@deepseek-ai/*` imports. Parsing
 * primitives live in `./git-tokenize.ts`; the jj replacement strings and rule
 * shapes live in `./git-equivalence.ts`.
 *
 * @module dsh-jj/git-rules
 */

import { JJ_EQUIVALENCE, mutateRule, readRule } from './git-equivalence.ts';
import type { GitSafety, GitSafetySubtype, RuleResult, SubcommandRule } from './git-equivalence.ts';
import { baseName, nestedCommandStrings, scanArgs, skipPrelude, tokenize } from './git-tokenize.ts';
import type { RawSegment, Token } from './git-tokenize.ts';

/** True when any of `names` is present in `flags`. */
function anyFlag(flags: readonly string[], names: readonly string[]): boolean {
  return flags.some((flag) => names.includes(flag));
}

const GIT_PROGRAM_RE = /^git(\.exe|\.cmd|\.bat)?$/i;

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);

const GIT_BOOLEAN_FLAGS = new Set([
  '--bare',
  '--no-pager',
  '--paginate',
  '-p',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
]);

const GIT_TERMINAL_FLAGS = new Set(['--version', '--help', '-h', '--html-path', '--man-path', '--info-path', '--exec-path']);

/** One Git invocation found in a shell command line. */
export interface GitInvocation {
  /** Normalized Git argv (program plus its arguments; leading wrappers stripped). */
  readonly argv: readonly string[];
  /** Raw shell segment this invocation was found in (base-layer extra). */
  readonly raw: string;
  /** The Git program token as written (`git`, `git.exe`, `/usr/bin/git`, …). */
  readonly program: string;
  /** Git subcommand, or `null` when Git was invoked without one. */
  readonly subcommand: string | null;
  readonly safety: GitSafety;
  /** True iff `safety === 'mutate'`. */
  readonly mutating: boolean;
  readonly confidence: 'high' | 'low';
  /** Why this classification, e.g. ``subcommand `commit` is in the mutate table``. */
  readonly reason: string;
  /** Leading global options that change cwd/repo, in order (for example `['-C','sub']`). */
  readonly globalOptions: readonly string[];
  /** jj replacement text shown in refusals; `''` when none is known. */
  readonly equivalence: string;
  /** Base-layer extras: finer class, `-C`, `--git-dir`, `--work-tree`. */
  readonly subtype: GitSafetySubtype;
  readonly changeDir?: string;
  readonly gitDir?: string;
  readonly workTree?: string;
}

/** One shell segment (a command between `;`, `&&`, `||`, `|`, `&`, `(`, `)`, or a newline). */
export interface ParsedSegment {
  readonly raw: string;
  /** `substitution` marks the inner text of `$(…)` or `` `…` ``. */
  readonly kind: 'command' | 'substitution';
  readonly words: readonly string[];
  /** False when the segment contained an unterminated quote or a trailing escape. */
  readonly parsed: boolean;
  /** Target of a leading `cd <path>` in this segment. */
  readonly cdTarget?: string;
  /** Indexes into {@link GitCommandClassification.invocations}. */
  readonly invocationIndexes: readonly number[];
}

/** Result of {@link classifyGitInvocation}. */
export interface GitCommandClassification {
  readonly invocations: readonly GitInvocation[];
  /** Segments in command-line order; the guard follows `cd` changes through them. */
  readonly segments: readonly ParsedSegment[];
  /** Non-fatal parse defects, in English. */
  readonly warnings: readonly string[];
}

/**
 * Classification table (contract §8.3). Keys are Git subcommands; `contextual`
 * entries resolve through `refine`.
 */
export const GIT_SUBCOMMAND_RULES: Readonly<Record<string, SubcommandRule>> = Object.freeze({
  // ---- mutate: history / working copy / refs
  commit: mutateRule('subcommand `commit` creates a Git commit', JJ_EQUIVALENCE.commit),
  checkout: mutateRule('subcommand `checkout` moves Git HEAD and rewrites the working copy', JJ_EQUIVALENCE.checkout),
  switch: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `switch` switches Git branches',
    equivalence: JJ_EQUIVALENCE.checkout,
    refine: ({ flags }) =>
      anyFlag(flags, ['-c', '-C', '--create', '--force-create'])
        ? {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `switch` with `-c` creates and checks out a new Git branch',
            equivalence: JJ_EQUIVALENCE.switchCreate,
          }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `switch` switches Git branches',
            equivalence: JJ_EQUIVALENCE.checkout,
          },
  },
  reset: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `reset` moves Git HEAD/branch and can discard the index and working copy',
    equivalence: JJ_EQUIVALENCE.reset,
    refine: ({ flags }) =>
      anyFlag(flags, ['--hard', '--merge', '--keep'])
        ? {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `reset` with `--hard`/`--merge`/`--keep` rewrites the working copy',
            equivalence: JJ_EQUIVALENCE.resetHard,
          }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `reset` moves Git HEAD/branch (jj has no index to reset)',
            equivalence: JJ_EQUIVALENCE.reset,
          },
  },
  restore: mutateRule('subcommand `restore` restores paths from the Git index/commit', JJ_EQUIVALENCE.restore),
  revert: mutateRule('subcommand `revert` creates inverse Git commits', JJ_EQUIVALENCE.revert),
  stash: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `stash` hides changes in a Git side ref',
    equivalence: JJ_EQUIVALENCE.stash,
    refine: ({ positionals }) => {
      const sub = positionals[0];
      return sub === 'list' || sub === 'show'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `stash list`/`stash show` only lists stash entries', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `stash` hides changes in a Git side ref',
            equivalence: JJ_EQUIVALENCE.stash,
          };
    },
  },
  merge: mutateRule('subcommand `merge` creates a Git merge commit', JJ_EQUIVALENCE.merge),
  rebase: mutateRule('subcommand `rebase` rewrites Git commits and refs', JJ_EQUIVALENCE.rebase),
  'cherry-pick': mutateRule('subcommand `cherry-pick` applies commits onto Git HEAD', JJ_EQUIVALENCE.cherryPick),
  am: mutateRule('subcommand `am` applies mailbox patches as Git commits', JJ_EQUIVALENCE.conflict),
  'merge-file': mutateRule('subcommand `merge-file` rewrites files outside jj\'s conflict model', JJ_EQUIVALENCE.conflict),
  mergetool: mutateRule('subcommand `mergetool` resolves Git merge state', JJ_EQUIVALENCE.conflict),
  apply: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `apply` writes patch content',
    equivalence: JJ_EQUIVALENCE.conflict,
    refine: ({ flags }) =>
      anyFlag(flags, ['--check', '--stat', '--numstat', '--summary'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `apply --check` only inspects the patch', equivalence: '' }
        : { safety: 'mutate', subtype: 'mutating', reason: 'subcommand `apply` writes patch content', equivalence: JJ_EQUIVALENCE.conflict },
  },
  'format-patch': mutateRule('subcommand `format-patch` writes patch files into the working copy', JJ_EQUIVALENCE.noEquivalent),
  'update-ref': mutateRule('subcommand `update-ref` writes Git refs directly', JJ_EQUIVALENCE.bookmark),
  'update-index': mutateRule('subcommand `update-index` writes Git\'s index, which jj does not use', JJ_EQUIVALENCE.noEquivalent),
  'read-tree': mutateRule('subcommand `read-tree` replaces Git\'s index contents', JJ_EQUIVALENCE.noEquivalent),
  'write-tree': mutateRule('subcommand `write-tree` writes the index into a tree object', JJ_EQUIVALENCE.noEquivalent),
  'commit-tree': mutateRule('subcommand `commit-tree` writes commit objects outside jj\'s change graph', JJ_EQUIVALENCE.noEquivalent),
  mktree: mutateRule('subcommand `mktree` writes tree objects outside jj\'s change graph', JJ_EQUIVALENCE.noEquivalent),
  'hash-object': {
    safety: 'read',
    subtype: 'read-only',
    reason: 'subcommand `hash-object` without `-w` only computes an object id',
    equivalence: '',
    refine: ({ flags }) =>
      anyFlag(flags, ['-w', '--stdin-paths'])
        ? {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `hash-object -w` writes objects into the shared store',
            equivalence: JJ_EQUIVALENCE.noEquivalent,
          }
        : { safety: 'read', subtype: 'read-only', reason: 'subcommand `hash-object` without `-w` only computes an object id', equivalence: '' },
  },
  'checkout-index': mutateRule('subcommand `checkout-index` writes files from Git\'s index', JJ_EQUIVALENCE.restore),
  clean: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `clean` deletes untracked files',
    equivalence: JJ_EQUIVALENCE.historyEdit,
    refine: ({ flags }) =>
      anyFlag(flags, ['-n', '--dry-run'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `clean --dry-run` only reports what would be deleted', equivalence: '' }
        : { safety: 'mutate', subtype: 'mutating', reason: 'subcommand `clean` deletes untracked files', equivalence: JJ_EQUIVALENCE.historyEdit },
  },
  rm: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `rm` removes files and updates Git\'s index',
    equivalence: JJ_EQUIVALENCE.restore,
    refine: ({ flags }) =>
      anyFlag(flags, ['-n', '--dry-run'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `rm --dry-run` only reports what would be removed', equivalence: '' }
        : { safety: 'mutate', subtype: 'mutating', reason: 'subcommand `rm` removes files and updates Git\'s index', equivalence: JJ_EQUIVALENCE.restore },
  },
  mv: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `mv` moves files and updates Git\'s index',
    equivalence: JJ_EQUIVALENCE.noEquivalent,
    refine: ({ flags }) =>
      anyFlag(flags, ['-n', '--dry-run'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `mv --dry-run` only reports what would be moved', equivalence: '' }
        : { safety: 'mutate', subtype: 'mutating', reason: 'subcommand `mv` moves files and updates Git\'s index', equivalence: JJ_EQUIVALENCE.noEquivalent },
  },
  add: {
    safety: 'mutate',
    subtype: 'index',
    reason: 'subcommand `add` stages files in Git\'s index, which jj does not use',
    equivalence: 'no staging step is needed in jj; `jj status` already sees the change',
    refine: ({ flags }) =>
      anyFlag(flags, ['-n', '--dry-run'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `add --dry-run` only reports what would be added', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'index',
            reason: 'subcommand `add` stages files in Git\'s index, which jj does not use',
            equivalence: 'no staging step is needed in jj; `jj status` already sees the change',
          },
  },
  init: mutateRule('subcommand `init` creates Git metadata jj will not own', 'jj git init --colocate (jj 0.46 default) or `jj git init --no-colocate`'),
  clone: mutateRule('subcommand `clone` creates a plain Git checkout jj cannot manage', 'jj git clone <url>'),
  worktree: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `worktree` creates or removes Git worktrees, which are not jj workspaces',
    equivalence: JJ_EQUIVALENCE.worktreeAdd,
    refine: ({ positionals }) => {
      const sub = positionals[0];
      if (sub === 'list') return { safety: 'read', subtype: 'read-only', reason: 'subcommand `worktree list` only lists Git worktrees', equivalence: '' };
      if (sub === 'remove') {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `worktree remove` deletes a Git worktree that jj does not track',
          equivalence: JJ_EQUIVALENCE.worktreeRemove,
        };
      }
      return {
        safety: 'mutate',
        subtype: 'mutating',
        reason: 'subcommand `worktree` changes Git worktrees, which are not jj workspaces',
        equivalence: JJ_EQUIVALENCE.worktreeAdd,
      };
    },
  },
  branch: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `branch` changes Git branches',
    equivalence: JJ_EQUIVALENCE.bookmark,
    refine: ({ flags, positionals }) => {
      const writeFlags = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'];
      const readFlags = ['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'];
      if (anyFlag(flags, ['-f', '--force']) || (positionals.length >= 2 && anyFlag(flags, ['-m', '-M', '--move', '-c', '-C', '--copy']))) {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `branch` force-moves or rewrites a Git branch',
          equivalence: JJ_EQUIVALENCE.branchForce,
        };
      }
      if (anyFlag(flags, writeFlags)) {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `branch` creates, moves, or deletes a Git branch',
          equivalence: JJ_EQUIVALENCE.bookmark,
        };
      }
      if (positionals.length >= 1) {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `branch <name>` creates a Git branch',
          equivalence: JJ_EQUIVALENCE.branchCreate,
        };
      }
      if (anyFlag(flags, readFlags) || flags.length === 0) {
        return { safety: 'read', subtype: 'read-only', reason: 'subcommand `branch` only lists branches', equivalence: '' };
      }
      return {
        safety: 'unknown',
        subtype: 'unknown',
        reason: 'subcommand `branch` with unrecognized flags; not classified as mutate',
        equivalence: '',
      };
    },
  },
  tag: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `tag` creates, edits, or deletes Git tags',
    equivalence: 'jj tag (0.46 has `jj tag`; `jj bookmark` also works for named pointers)',
    refine: ({ flags, positionals }) => {
      const listFlags = ['-l', '--list', '-v', '--verify', '-n', '--contains', '--points-at', '--sort', '--format', '--merged', '--no-merged'];
      const writeFlags = ['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F', '--edit'];
      if (anyFlag(flags, writeFlags)) {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `tag` creates, edits, or deletes Git tags',
          equivalence: 'jj tag set/delete',
        };
      }
      if (anyFlag(flags, listFlags) || (positionals.length === 0 && flags.length === 0)) {
        return { safety: 'read', subtype: 'read-only', reason: 'subcommand `tag` only lists tags', equivalence: '' };
      }
      if (positionals.length >= 1) {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `tag <name>` creates a Git tag',
          equivalence: 'jj tag set <name> -r <revset>',
        };
      }
      return {
        safety: 'unknown',
        subtype: 'unknown',
        reason: 'subcommand `tag` with unrecognized flags; not classified as mutate',
        equivalence: '',
      };
    },
  },
  push: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `push` writes Git refs on the remote',
    equivalence: JJ_EQUIVALENCE.push,
    refine: ({ flags }) =>
      anyFlag(flags, ['-n', '--dry-run'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `push --dry-run` only reports what would be pushed', equivalence: '' }
        : { safety: 'mutate', subtype: 'mutating', reason: 'subcommand `push` writes Git refs on the remote', equivalence: JJ_EQUIVALENCE.push },
  },
  fetch: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `fetch` updates Git remote-tracking refs outside jj\'s import path',
    equivalence: JJ_EQUIVALENCE.fetch,
    refine: ({ flags }) =>
      anyFlag(flags, ['-n', '--dry-run'])
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `fetch --dry-run` only reports what would be fetched', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `fetch` updates Git remote-tracking refs outside jj\'s import path',
            equivalence: JJ_EQUIVALENCE.fetch,
          },
  },
  pull: mutateRule('subcommand `pull` fetches and merges into Git HEAD', JJ_EQUIVALENCE.pull),
  remote: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `remote` reconfigures Git remotes',
    equivalence: JJ_EQUIVALENCE.remote,
    refine: ({ flags, positionals }) => {
      const sub = positionals[0];
      if (sub === undefined || sub === 'show' || sub === 'get-url' || anyFlag(flags, ['-v', '--verbose'])) {
        return { safety: 'read', subtype: 'read-only', reason: 'subcommand `remote` only lists or shows remotes', equivalence: '' };
      }
      return {
        safety: 'mutate',
        subtype: 'mutating',
        reason: 'subcommand `remote` reconfigures Git remotes',
        equivalence: JJ_EQUIVALENCE.remote,
      };
    },
  },
  submodule: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `submodule` changes Git submodules',
    equivalence: JJ_EQUIVALENCE.submoduleLimited,
    refine: ({ positionals }) => {
      const sub = positionals[0];
      return sub === undefined || sub === 'status' || sub === 'summary'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `submodule status` only reports submodule state', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `submodule` adds, updates, or removes Git submodules',
            equivalence: JJ_EQUIVALENCE.submoduleLimited,
          };
    },
  },
  config: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `config` writes Git configuration',
    equivalence: 'jj config set --repo <name> <value>',
    refine: ({ flags, positionals }) => {
      const readFlags = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--name-only'];
      const writeFlags = ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit', '-e'];
      if (anyFlag(flags, writeFlags)) {
        return {
          safety: 'mutate',
          subtype: 'mutating',
          reason: 'subcommand `config` writes Git configuration',
          equivalence: 'jj config set --repo <name> <value> / `jj config unset --repo <name>`',
        };
      }
      if (anyFlag(flags, readFlags) || positionals.length <= 1) {
        return { safety: 'read', subtype: 'read-only', reason: 'subcommand `config` only reads Git configuration', equivalence: '' };
      }
      return {
        safety: 'mutate',
        subtype: 'mutating',
        reason: 'subcommand `config <key> <value>` writes Git configuration',
        equivalence: 'jj config set --repo <name> <value>',
      };
    },
  },
  reflog: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `reflog` deletes Git reflog entries',
    equivalence: 'jj op log / `jj undo` / `jj op restore <operation-id>`',
    refine: ({ positionals }) => {
      const sub = positionals[0];
      return sub === 'expire' || sub === 'delete'
        ? {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `reflog delete`/`expire` deletes Git reflog entries',
            equivalence: 'jj op log / `jj undo` / `jj op restore <operation-id>`',
          }
        : { safety: 'read', subtype: 'read-only', reason: 'subcommand `reflog` only shows Git\'s reflog', equivalence: '' };
    },
  },
  'symbolic-ref': {
    contextual: true,
    safety: 'read',
    subtype: 'read-only',
    reason: 'subcommand `symbolic-ref` only reads a symbolic ref',
    equivalence: '',
    refine: ({ flags, positionals }) =>
      positionals.length >= 2 || anyFlag(flags, ['-m', '--delete', '-d'])
        ? {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `symbolic-ref` writes a symbolic ref (HEAD)',
            equivalence: JJ_EQUIVALENCE.historyEdit,
          }
        : { safety: 'read', subtype: 'read-only', reason: 'subcommand `symbolic-ref` only reads a symbolic ref', equivalence: '' },
  },
  bisect: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `bisect` moves Git HEAD during a bisection',
    equivalence: 'jj bisect (jj has native bisection)',
    refine: ({ positionals }) => {
      const sub = positionals[0];
      return sub === 'log' || sub === 'view' || sub === 'visualize'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `bisect log`/`view` only reads bisection state', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `bisect` moves Git HEAD during a bisection',
            equivalence: 'jj bisect (jj has native bisection)',
          };
    },
  },
  notes: {
    contextual: true,
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `notes` writes Git notes outside jj\'s model',
    equivalence: 'put the information in the change description with `jj describe`',
    refine: ({ positionals }) => {
      const sub = positionals[0];
      return sub === undefined || sub === 'list' || sub === 'show' || sub === 'get-ref'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `notes list`/`show` only reads Git notes', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `notes` writes Git notes outside jj\'s model',
            equivalence: 'put the information in the change description with `jj describe`',
          };
    },
  },
  bundle: {
    contextual: true,
    safety: 'mutate',
    subtype: 'worktree',
    reason: 'subcommand `bundle create` writes a bundle file',
    equivalence: '',
    refine: ({ positionals }) =>
      positionals[0] === 'verify' || positionals[0] === 'list-heads'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `bundle verify`/`list-heads` only inspects a bundle', equivalence: '' }
        : { safety: 'mutate', subtype: 'worktree', reason: 'subcommand `bundle create` writes a bundle file', equivalence: '' },
  },
  'sparse-checkout': mutateRule('subcommand `sparse-checkout` changes which files are checked out', 'jj sparse set/edit (jj manages sparse checkouts natively)'),
  archive: mutateRule('subcommand `archive` writes an archive into the working copy', JJ_EQUIVALENCE.noEquivalent),
  lfs: mutateRule('subcommand `lfs` manages Git LFS state outside jj', JJ_EQUIVALENCE.noEquivalent),
  rerere: mutateRule('subcommand `rerere` replays recorded Git conflict resolutions', JJ_EQUIVALENCE.conflict),
  'send-email': mutateRule('subcommand `send-email` sends patches and can rewrite Git state', JJ_EQUIVALENCE.noEquivalent),
  'request-pull': mutateRule('subcommand `request-pull` generates a pull request description', JJ_EQUIVALENCE.noEquivalent),
  gc: {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `gc` prunes the object store that jj and git share',
    equivalence: JJ_EQUIVALENCE.gc,
  },
  prune: mutateRule('subcommand `prune` deletes unreachable objects from the store jj depends on', JJ_EQUIVALENCE.gc),
  repack: mutateRule('subcommand `repack` rewrites pack files in the store jj depends on', JJ_EQUIVALENCE.store),
  'pack-refs': mutateRule('subcommand `pack-refs` rewrites refs that jj expects to manage', JJ_EQUIVALENCE.store),
  maintenance: mutateRule('subcommand `maintenance` runs gc/repack tasks on jj\'s backend store', JJ_EQUIVALENCE.gc),
  'filter-branch': mutateRule('subcommand `filter-branch` rewrites all Git history', 'no jj equivalent — do this in a separate clone, then `jj git fetch`'),
  'filter-repo': mutateRule('subcommand `filter-repo` rewrites Git refs outside jj', 'no jj equivalent — do this in a separate clone, then `jj git fetch`'),
  replace: mutateRule('subcommand `replace` creates replacement refs that rewrite object history', JJ_EQUIVALENCE.noEquivalent),

  // ---- read-only
  status: readRule(),
  log: readRule(),
  show: readRule(),
  diff: readRule(),
  'diff-tree': readRule(),
  'diff-index': readRule(),
  'diff-files': readRule(),
  shortlog: readRule(),
  describe: readRule(),
  blame: readRule(),
  annotate: readRule(),
  grep: readRule(),
  'rev-list': readRule(),
  'rev-parse': readRule(),
  'merge-base': readRule(),
  'name-rev': readRule(),
  'for-each-ref': readRule(),
  'show-ref': readRule(),
  'ls-files': readRule(),
  'ls-tree': readRule(),
  'ls-remote': readRule(),
  'cat-file': readRule(),
  'count-objects': readRule(),
  'verify-pack': readRule(),
  whatchanged: readRule(),
  cherry: readRule(),
  'range-diff': readRule(),
  help: readRule(),
  version: readRule(),
  'check-ignore': readRule(),
  'check-attr': readRule(),
  fsck: {
    safety: 'read',
    subtype: 'read-only',
    reason: 'subcommand `fsck` only verifies object connectivity',
    equivalence: '',
    refine: ({ flags }) =>
      anyFlag(flags, ['--lost-found'])
        ? {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `fsck --lost-found` writes dangling objects under `.git/lost-found`',
            equivalence: JJ_EQUIVALENCE.noEquivalent,
          }
        : { safety: 'read', subtype: 'read-only', reason: 'subcommand `fsck` only verifies object connectivity', equivalence: '' },
  },
  'verify-commit': readRule(),
  'verify-tag': readRule(),
  'show-branch': readRule(),
  'show-index': readRule(),
  'get-tar-commit-id': readRule(),
  'patch-id': readRule(),
  'check-ref-format': readRule(),
  'check-mailmap': readRule(),
  var: readRule(),
  column: readRule(),
  bugreport: readRule(),
  diagnose: readRule(),
  'credential': readRule('subcommand `credential` only fills credential helper data'),
  'unpack-objects': mutateRule('subcommand `unpack-objects` writes objects into the shared store', JJ_EQUIVALENCE.noEquivalent),
  'commit-graph': {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `commit-graph write` writes commit-graph files into the shared store',
    equivalence: JJ_EQUIVALENCE.noEquivalent,
    refine: ({ positionals }) =>
      positionals[0] === 'verify'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `commit-graph verify` only checks the graph file', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `commit-graph write` writes commit-graph files into the shared store',
            equivalence: JJ_EQUIVALENCE.noEquivalent,
          },
  },
  'multi-pack-index': {
    safety: 'mutate',
    subtype: 'mutating',
    reason: 'subcommand `multi-pack-index` writes or rewrites pack index files',
    equivalence: JJ_EQUIVALENCE.noEquivalent,
    refine: ({ positionals }) =>
      positionals[0] === 'verify'
        ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `multi-pack-index verify` only checks the index files', equivalence: '' }
        : {
            safety: 'mutate',
            subtype: 'mutating',
            reason: 'subcommand `multi-pack-index` writes or rewrites pack index files',
            equivalence: JJ_EQUIVALENCE.noEquivalent,
          },
  },
  'pack-objects': mutateRule('subcommand `pack-objects` writes pack files and deltas into the object store', JJ_EQUIVALENCE.noEquivalent),
  'index-pack': mutateRule('subcommand `index-pack` writes pack index files into the object store', JJ_EQUIVALENCE.noEquivalent),
  'update-server-info': mutateRule('subcommand `update-server-info` rewrites the repository info files', JJ_EQUIVALENCE.noEquivalent),
  'fast-import': mutateRule('subcommand `fast-import` writes commits, refs, and objects into the shared store', JJ_EQUIVALENCE.noEquivalent),
});

function isGitProgram(word: string): boolean {
  return GIT_PROGRAM_RE.test(baseName(word));
}

function classifyWords(words: readonly Token[], raw: string, parsed: boolean, warnings: string[]): GitInvocation | undefined {
  if (!parsed || words.length === 0) return undefined;
  let index = skipPrelude(words, warnings);
  let lowConfidenceNote: string | undefined;

  const program = words[index]?.value ?? '';
  if (!isGitProgram(program)) return undefined;
  index += 1;

  const globalOptions: string[] = [];
  let subcommand: string | null = null;
  let changeDir: string | undefined;
  let gitDir: string | undefined;
  let workTree: string | undefined;
  let terminalFlag: string | undefined;

  while (index < words.length) {
    const token = words[index] ?? { value: '', text: '' };
    index += 1;
    if (token.value === '--') {
      subcommand = words[index]?.value ?? null;
      if (subcommand !== null) index += 1;
      break;
    }
    if (!token.value.startsWith('-') || token.value === '-') {
      subcommand = token.value;
      break;
    }
    const eq = token.value.indexOf('=');
    const flag = eq >= 0 ? token.value.slice(0, eq) : token.value;
    const inlineValue = eq >= 0 ? token.value.slice(eq + 1) : undefined;
    globalOptions.push(token.value);

    if (GIT_TERMINAL_FLAGS.has(flag) && (flag !== '--exec-path' || inlineValue === undefined)) {
      terminalFlag = flag;
      // `git --help commit` / `git -h commit`: the rest is the help topic, not a subcommand.
      break;
    }
    // Attached short-option value: `git -C<path>` (Git accepts both spellings).
    if (eq < 0 && token.value.startsWith('-C') && token.value.length > 2) {
      changeDir = token.value.slice(2);
      continue;
    }
    if (GIT_VALUE_FLAGS.has(flag)) {
      const value = inlineValue ?? words[index]?.value;
      if (inlineValue === undefined) {
        index += 1;
        // Contract §8.2: globalOptions carries the option and its value, e.g. ['-C','sub'].
        if (value !== undefined) globalOptions.push(value);
      }
      if (flag === '-C') changeDir = value;
      else if (flag === '--git-dir') {
        gitDir = value;
        if (inlineValue === undefined && value !== undefined) {
          lowConfidenceNote = '`--git-dir` was given as a separate argument; Git itself only accepts `--git-dir=<path>`.';
        }
      } else if (flag === '--work-tree') workTree = value;
      continue;
    }
    if (GIT_BOOLEAN_FLAGS.has(flag)) continue;
    lowConfidenceNote = `unrecognised Git global option \`${token.value}\``;
  }

  const extras = {
    ...(changeDir !== undefined ? { changeDir } : {}),
    ...(gitDir !== undefined ? { gitDir } : {}),
    ...(workTree !== undefined ? { workTree } : {}),
  };

  if (subcommand === null) {
    const isInfoFlag = terminalFlag !== undefined;
    return {
      argv: ['git', ...globalOptions],
      raw,
      program,
      globalOptions,
      subcommand: null,
      safety: isInfoFlag ? 'read' : 'unknown',
      mutating: false,
      confidence: isInfoFlag && lowConfidenceNote === undefined ? 'high' : 'low',
      reason: isInfoFlag
        ? `\`git ${terminalFlag}\` only prints information`
        : 'Git was invoked without a subcommand; not classified as mutate',
      equivalence: '',
      subtype: isInfoFlag ? 'read-only' : 'unknown',
      ...extras,
    };
  }

  const rest = words.slice(index).map((token) => token.value);
  // `git <subcommand> --help` / `-h` only prints help, even for mutating subcommands.
  if (rest.includes('--help') || rest.includes('-h')) {
    return {
      argv: ['git', ...globalOptions, subcommand, ...rest],
      raw,
      program,
      globalOptions,
      subcommand,
      safety: 'read',
      mutating: false,
      confidence: 'high',
      reason: `\`git ${subcommand} --help\` only prints help`,
      equivalence: '',
      subtype: 'read-only',
      ...extras,
    };
  }
  const rule = GIT_SUBCOMMAND_RULES[subcommand];
  if (rule === undefined) {
    return {
      argv: ['git', ...globalOptions, subcommand, ...rest],
      raw,
      program,
      globalOptions,
      subcommand,
      safety: 'unknown',
      mutating: false,
      confidence: 'low',
      reason: `unrecognised Git subcommand \`${subcommand}\` (Git alias, Git LFS/subtree extension, or typo); not classified as mutate`,
      equivalence: '',
      subtype: 'unknown',
      ...extras,
    };
  }

  const { flags, positionals } = scanArgs(rest, []);
  const resolved: RuleResult = rule.refine !== undefined
    ? rule.refine({ args: rest, flags, positionals })
    : { safety: rule.safety, subtype: rule.subtype ?? (rule.safety === 'mutate' ? 'mutating' : 'read-only'), reason: rule.reason, ...(rule.equivalence !== undefined ? { equivalence: rule.equivalence } : {}) };

  const confidence: 'high' | 'low' = lowConfidenceNote === undefined ? 'high' : 'low';
  const reason = lowConfidenceNote === undefined ? resolved.reason : `${resolved.reason} (${lowConfidenceNote})`;

  return {
    argv: ['git', ...globalOptions, subcommand, ...rest],
    raw,
    program,
    globalOptions,
    subcommand,
    safety: resolved.safety,
    mutating: resolved.safety === 'mutate',
    confidence,
    reason,
    equivalence: resolved.equivalence ?? '',
    subtype: resolved.subtype ?? (resolved.safety === 'mutate' ? 'mutating' : resolved.safety === 'read' ? 'read-only' : 'unknown'),
    ...extras,
  };
}

/**
 * Recognize Git invocations in a shell command line.
 *
 * @param commandLine - the raw shell command string (as the model wrote it).
 * @returns recognized invocations in order, the parsed segments, and parse warnings.
 */
export function classifyGitInvocation(commandLine: string): GitCommandClassification {
  const outer = tokenize(commandLine, 'command', 0);
  const warnings = [...outer.warnings];
  const invocations: GitInvocation[] = [];
  const segments: ParsedSegment[] = [];

  const record = (segment: RawSegment): ParsedSegment => {
    const invocation = classifyWords(segment.words, segment.raw, segment.parsed, warnings);
    const invocationIndexes: number[] = [];
    if (invocation !== undefined) {
      invocationIndexes.push(invocations.length);
      invocations.push(invocation);
    }
    const head = segment.words[0]?.value;
    const cdTarget = head === 'cd' && segment.parsed ? segment.words[1]?.value.trim() : undefined;
    return {
      raw: segment.raw,
      kind: segment.kind,
      words: segment.words.map((token) => token.value),
      parsed: segment.parsed,
      ...(cdTarget !== undefined && cdTarget.length > 0 ? { cdTarget } : {}),
      invocationIndexes,
    };
  };

  for (const segment of outer.segments) {
    segments.push(record(segment));
    for (const inner of nestedCommandStrings(segment)) {
      for (const nestedSegment of tokenize(inner, 'substitution', 1).segments) segments.push(record(nestedSegment));
    }
  }

  return {
    invocations: Object.freeze(invocations),
    segments: Object.freeze(segments),
    warnings: Object.freeze(warnings),
  };
}

/**
 * jj replacement text for a denied invocation (contract §8.2).
 *
 * @param invocation - a classified invocation.
 * @returns the §8.6/§8.3 equivalence line, or `''` when no single equivalent is known.
 */
export function gitEquivalence(invocation: GitInvocation): string {
  return invocation.equivalence;
}

/** True when the classification contains at least one mutating Git invocation. */
export function hasMutatingGitInvocation(classification: GitCommandClassification): boolean {
  return classification.invocations.some((invocation) => invocation.mutating);
}
