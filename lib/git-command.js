/**
 * Pure, table-driven recognizer for Git invocations inside shell command lines
 * (design contract §8.2 / §8.3).
 *
 * Safety classes:
 * - `read`    — inspects the repository; allowed inside a jj workspace.
 * - `mutate`  — changes refs, HEAD, the index, the working copy, or shared
 *               storage; refused inside a jj workspace by the guard.
 * - `unknown` — unrecognized subcommand, no subcommand, or unparsable input.
 *               **Never** treated as `mutate` (no misjudgement).
 *
 * Rules:
 * - No I/O, no subprocess, no environment access: a pure function over a string.
 * - Table-driven; the only per-command logic is for `contextual` subcommands,
 *   which need flag/subcommand inspection.
 * - An unterminated quote or trailing escape yields zero invocations, because the
 *   shell itself would reject the line before running anything.
 *
 * Known limitations (documented in README): Git aliases, shell functions and
 * wrapper scripts are configuration/state dependent and cannot be resolved here;
 * heredoc bodies are scanned line-wise but a heredoc's structure is not modelled.
 *
 * @module dsh-jj/git-command
 */
/** jj replacement lines (contract §8.3 / §8.6), verbatim where the contract fixes the wording. */
export const JJ_EQUIVALENCE = Object.freeze({
    commit: 'jj commit -m "…"      (or: jj describe -m "…" then jj new)',
    checkout: 'jj new <rev>          (or: jj edit <rev> to edit that change in place)',
    switchCreate: 'jj new -m "…" then jj bookmark create <name> -r @',
    resetHard: 'jj edit <rev>         (or: jj op restore <op-id>)',
    reset: 'jj undo               (jj has no index to reset)',
    restore: 'jj restore <path>',
    stash: 'jj new                (jj keeps your changes; no stash needed)',
    merge: 'jj new @ <rev>        (a merge is just a change with two parents)',
    rebase: 'jj rebase -r @ -d <dest>',
    cherryPick: 'jj duplicate <rev>    (or: jj rebase -r <rev> -d <dest>)',
    worktreeAdd: 'jj workspace add <path>',
    worktreeList: 'jj workspace list',
    worktreeRemove: 'jj workspace forget <name>',
    branchCreate: 'jj bookmark create <name> -r @',
    branchForce: 'jj bookmark set <name> -r <r> --allow-backwards',
    bookmark: 'jj bookmark create/set/delete <name> -r <revset>',
    push: 'jj git push -b <bookmark>',
    fetch: 'jj git fetch',
    pull: 'jj git fetch && jj rebase -d <bookmark>@origin',
    gc: 'jj util gc',
    revert: 'jj revert -r <revset>',
    historyEdit: 'jj undo / jj op restore <op-id> / jj edit <revset>',
    conflict: 'jj restore / jj resolve / jj fix',
    remote: 'jj git remote add/remove/rename/set-url',
    submoduleLimited: 'jj has limited submodule support; prefer jj-native commands such as `jj git fetch`',
    store: 'jj util gc (jj understands its own reachability; git gc does not)',
    noEquivalent: '(no single jj equivalent; inspect with jj_log / jj_status first, then use jj_new, jj_describe, jj_squash, jj_rebase, jj_undo, jj_workspace_* as appropriate)',
});
const READ_RULE = {
    safety: 'read',
    subtype: 'read-only',
    reason: 'read-only Git subcommand',
    equivalence: '',
};
function readRule(reason = READ_RULE.reason) {
    return { safety: 'read', subtype: 'read-only', reason, equivalence: '' };
}
function mutateRule(reason, equivalence) {
    return { safety: 'mutate', subtype: 'mutating', reason, ...(equivalence !== undefined ? { equivalence } : {}) };
}
/** True when any of `names` is present in `flags`. */
function anyFlag(flags, names) {
    return flags.some((flag) => names.includes(flag));
}
/**
 * Classification table (contract §8.3). Keys are Git subcommands; `contextual`
 * entries resolve through `refine`.
 */
export const GIT_SUBCOMMAND_RULES = Object.freeze({
    // ---- mutate: history / working copy / refs
    commit: mutateRule('subcommand `commit` creates a Git commit', JJ_EQUIVALENCE.commit),
    checkout: mutateRule('subcommand `checkout` moves Git HEAD and rewrites the working copy', JJ_EQUIVALENCE.checkout),
    switch: {
        safety: 'mutate',
        subtype: 'mutating',
        reason: 'subcommand `switch` switches Git branches',
        equivalence: JJ_EQUIVALENCE.checkout,
        refine: ({ flags }) => anyFlag(flags, ['-c', '-C', '--create', '--force-create'])
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
        refine: ({ flags }) => anyFlag(flags, ['--hard', '--merge', '--keep'])
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
        refine: ({ flags }) => anyFlag(flags, ['--check', '--stat', '--numstat', '--summary'])
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
        refine: ({ flags }) => anyFlag(flags, ['-w', '--stdin-paths'])
            ? {
                safety: 'mutate',
                subtype: 'mutating',
                reason: 'subcommand `hash-object -w` writes objects into the shared store',
                equivalence: JJ_EQUIVALENCE.noEquivalent,
            }
            : { safety: 'read', subtype: 'read-only', reason: 'subcommand `hash-object` without `-w` only computes an object id', equivalence: '' },
    },
    'checkout-index': mutateRule('subcommand `checkout-index` writes files from Git\'s index', JJ_EQUIVALENCE.restore),
    clean: mutateRule('subcommand `clean` deletes untracked files', JJ_EQUIVALENCE.historyEdit),
    rm: mutateRule('subcommand `rm` removes files and updates Git\'s index', JJ_EQUIVALENCE.restore),
    mv: mutateRule('subcommand `mv` moves files and updates Git\'s index', JJ_EQUIVALENCE.noEquivalent),
    add: {
        safety: 'mutate',
        subtype: 'index',
        reason: 'subcommand `add` stages files in Git\'s index, which jj does not use',
        equivalence: 'no staging step is needed in jj; `jj status` already sees the change',
        refine: ({ flags }) => anyFlag(flags, ['-n', '--dry-run'])
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
            if (sub === 'list')
                return { safety: 'read', subtype: 'read-only', reason: 'subcommand `worktree list` only lists Git worktrees', equivalence: '' };
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
        refine: ({ flags }) => anyFlag(flags, ['-n', '--dry-run'])
            ? { safety: 'read', subtype: 'read-only', reason: 'subcommand `push --dry-run` only reports what would be pushed', equivalence: '' }
            : { safety: 'mutate', subtype: 'mutating', reason: 'subcommand `push` writes Git refs on the remote', equivalence: JJ_EQUIVALENCE.push },
    },
    fetch: {
        safety: 'mutate',
        subtype: 'mutating',
        reason: 'subcommand `fetch` updates Git remote-tracking refs outside jj\'s import path',
        equivalence: JJ_EQUIVALENCE.fetch,
        refine: ({ flags }) => anyFlag(flags, ['-n', '--dry-run'])
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
        refine: ({ flags, positionals }) => positionals.length >= 2 || anyFlag(flags, ['-m', '--delete', '-d'])
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
        refine: ({ positionals }) => positionals[0] === 'verify' || positionals[0] === 'list-heads'
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
    fsck: readRule(),
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
});
const GIT_PROGRAM_RE = /^git(\.exe|\.cmd|\.bat)?$/i;
const WRAPPERS = new Set([
    'sudo',
    'doas',
    'command',
    'builtin',
    'nohup',
    'setsid',
    'exec',
    'time',
    'nice',
    'ionice',
    'stdbuf',
    'env',
    'xargs',
    'timeout',
]);
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const WRAPPER_VALUE_FLAGS = Object.freeze({
    sudo: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '--user', '--group', '--prompt', '--chdir', '--host', '--role', '--type', '--other-user'],
    doas: ['-u', '-C'],
    env: ['-u', '--unset', '-S', '--split-string', '-C', '--chdir'],
    nice: ['-n', '--adjustment'],
    ionice: ['-c', '-n', '-p'],
    stdbuf: ['-i', '-o', '-e'],
    xargs: ['-I', '-n', '-P', '-d', '-E', '-s', '-a', '-L', '--arg-file', '--max-args', '--max-procs', '--delimiter', '--eof', '--max-chars', '--replace'],
    command: ['-p'],
});
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
const OPERATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')']);
const MAX_NESTING = 6;
function isAssignment(word) {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}
function baseName(word) {
    const parts = word.split(/[\\/]/);
    return parts[parts.length - 1] ?? word;
}
function isGitProgram(word) {
    return GIT_PROGRAM_RE.test(baseName(word));
}
/** Split a command line into words and operator-delimited segments. */
function tokenize(commandLine, kind, nesting) {
    const segments = [];
    const warnings = [];
    let words = [];
    let current = '';
    let currentText = '';
    let quote;
    let escaped = false;
    let parsed = true;
    let raw = '';
    const flushWord = () => {
        if (currentText.length > 0 || current.length > 0) {
            words.push({ value: current, text: currentText });
            current = '';
            currentText = '';
        }
    };
    const flushSegment = () => {
        flushWord();
        if (words.length > 0)
            segments.push({ raw, kind, words, parsed });
        words = [];
        raw = '';
        parsed = true;
    };
    for (let index = 0; index < commandLine.length; index += 1) {
        const char = commandLine[index] ?? '';
        if (escaped) {
            current += char === '\n' ? '' : char;
            currentText += char;
            escaped = false;
            continue;
        }
        if (char === '\\' && quote !== "'") {
            escaped = true;
            raw += char;
            currentText += char;
            continue;
        }
        if (quote === "'") {
            if (char === "'")
                quote = undefined;
            else
                current += char;
            raw += char;
            currentText += char;
            continue;
        }
        if ((char === '$' && commandLine[index + 1] === '(') || char === '`') {
            const closing = char === '`' ? '`' : ')';
            const start = index + (char === '`' ? 1 : 2);
            let depth = 1;
            let end = start;
            for (; end < commandLine.length; end += 1) {
                const inner = commandLine[end] ?? '';
                if (inner === '\\') {
                    end += 1;
                    continue;
                }
                if (char === '$' && inner === '(')
                    depth += 1;
                if (inner === closing) {
                    depth -= 1;
                    if (depth === 0)
                        break;
                }
            }
            const innerText = commandLine.slice(start, end);
            if (nesting < MAX_NESTING) {
                const nested = tokenize(innerText, 'substitution', nesting + 1);
                segments.push(...nested.segments);
                warnings.push(...nested.warnings);
            }
            else {
                warnings.push('Command substitution nesting limit reached; deeper substitutions were not classified.');
            }
            const text = commandLine.slice(index, Math.min(end + 1, commandLine.length));
            words.push({ value: '$SUBST', text });
            raw += text;
            index = end;
            continue;
        }
        if (quote === '"') {
            if (char === '"')
                quote = undefined;
            else
                current += char;
            raw += char;
            currentText += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            raw += char;
            currentText += char;
            continue;
        }
        if (char === ' ' || char === '\t') {
            flushWord();
            raw += char;
            continue;
        }
        if (OPERATORS.has(char)) {
            let operator = char;
            if ((char === '&' || char === '|') && commandLine[index + 1] === char) {
                operator = char + char;
                index += 1;
            }
            flushSegment();
            raw = operator;
            flushSegment();
            continue;
        }
        current += char;
        currentText += char;
        raw += char;
    }
    if (escaped) {
        warnings.push('Command line ends with a trailing backslash; the shell would wait for more input.');
        parsed = false;
    }
    if (quote !== undefined) {
        warnings.push(`Command line contains an unterminated ${quote === "'" ? 'single' : 'double'} quote; the shell would reject it before running anything.`);
        parsed = false;
    }
    flushSegment();
    return { segments, warnings };
}
/** Split arguments into flags and positionals, honouring value-taking flags. */
function scanArgs(args, valueFlags) {
    const flags = [];
    const positionals = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index] ?? '';
        if (token === '--') {
            positionals.push(...args.slice(index + 1));
            break;
        }
        if (token.startsWith('-') && token !== '-') {
            const eq = token.indexOf('=');
            const flag = eq >= 0 ? token.slice(0, eq) : token;
            flags.push(flag);
            if (eq < 0 && valueFlags.includes(flag))
                index += 1;
            continue;
        }
        positionals.push(token);
    }
    return { flags, positionals };
}
/** Skip leading `VAR=value` assignments, wrapper commands, and shell wrappers; returns the program index. */
function skipPrelude(words, warnings) {
    let index = 0;
    for (;;) {
        while (index < words.length && isAssignment(words[index]?.value ?? ''))
            index += 1;
        const head = words[index]?.value;
        if (head === undefined)
            return index;
        const name = baseName(head);
        if (SHELL_WRAPPERS.has(name)) {
            const rest = words.slice(index + 1).map((token) => token.value);
            const cIndex = rest.findIndex((token) => token === '-c' || /^-[a-z]*c[a-z]*$/.test(token));
            if (cIndex >= 0 && rest[cIndex + 1] !== undefined) {
                const nested = tokenize(rest[cIndex + 1] ?? '', 'substitution', MAX_NESTING);
                warnings.push(...nested.warnings);
            }
            return index;
        }
        if (!WRAPPERS.has(name))
            break;
        const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? [];
        index += 1;
        while (index < words.length) {
            const token = words[index]?.value ?? '';
            if (isAssignment(token)) {
                index += 1;
                continue;
            }
            if (token === '--') {
                index += 1;
                break;
            }
            if (token.startsWith('-') && token !== '-') {
                const eq = token.indexOf('=');
                const flag = eq >= 0 ? token.slice(0, eq) : token;
                index += eq < 0 && valueFlags.includes(flag) ? 2 : 1;
                continue;
            }
            break;
        }
        if (name === 'timeout' && index < words.length && !(words[index]?.value ?? '').startsWith('-'))
            index += 1;
    }
    return index;
}
function classifyWords(words, raw, parsed, warnings) {
    if (!parsed || words.length === 0)
        return undefined;
    let index = skipPrelude(words, warnings);
    let lowConfidenceNote;
    const program = words[index]?.value ?? '';
    if (!isGitProgram(program))
        return undefined;
    index += 1;
    const globalOptions = [];
    let subcommand = null;
    let changeDir;
    let gitDir;
    let workTree;
    let terminalFlag;
    while (index < words.length) {
        const token = words[index] ?? { value: '', text: '' };
        index += 1;
        if (token.value === '--') {
            subcommand = words[index]?.value ?? null;
            if (subcommand !== null)
                index += 1;
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
            continue;
        }
        if (GIT_VALUE_FLAGS.has(flag)) {
            const value = inlineValue ?? words[index]?.value;
            if (inlineValue === undefined) {
                index += 1;
                // Contract §8.2: globalOptions carries the option and its value, e.g. ['-C','sub'].
                if (value !== undefined)
                    globalOptions.push(value);
            }
            if (flag === '-C')
                changeDir = value;
            else if (flag === '--git-dir') {
                gitDir = value;
                if (inlineValue === undefined && value !== undefined) {
                    lowConfidenceNote = '`--git-dir` was given as a separate argument; Git itself only accepts `--git-dir=<path>`.';
                }
            }
            else if (flag === '--work-tree')
                workTree = value;
            continue;
        }
        if (GIT_BOOLEAN_FLAGS.has(flag))
            continue;
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
    const resolved = rule.refine !== undefined
        ? rule.refine({ args: rest, flags, positionals })
        : { safety: rule.safety, subtype: rule.subtype ?? (rule.safety === 'mutate' ? 'mutating' : 'read-only'), reason: rule.reason, ...(rule.equivalence !== undefined ? { equivalence: rule.equivalence } : {}) };
    const confidence = lowConfidenceNote === undefined ? 'high' : 'low';
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
export function classifyGitInvocation(commandLine) {
    const outer = tokenize(commandLine, 'command', 0);
    const warnings = [...outer.warnings];
    const invocations = [];
    const segments = [];
    const record = (segment) => {
        const invocation = classifyWords(segment.words, segment.raw, segment.parsed, warnings);
        const invocationIndexes = [];
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
        const head = segment.words[0]?.value === undefined ? undefined : baseName(segment.words[0].value);
        if (head !== undefined && SHELL_WRAPPERS.has(head)) {
            const rest = segment.words.slice(1).map((token) => token.value);
            const cIndex = rest.findIndex((token) => token === '-c' || /^-[a-z]*c[a-z]*$/.test(token));
            const inner = cIndex >= 0 ? rest[cIndex + 1] : undefined;
            if (inner !== undefined && inner.length > 0) {
                for (const nestedSegment of tokenize(inner, 'substitution', 1).segments)
                    segments.push(record(nestedSegment));
            }
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
export function gitEquivalence(invocation) {
    return invocation.equivalence;
}
/** True when the classification contains at least one mutating Git invocation. */
export function hasMutatingGitInvocation(classification) {
    return classification.invocations.some((invocation) => invocation.mutating);
}
/** jj subcommands whose scope is repository-wide (contract §8.3b). */
export const JJ_REPO_WIDE_SUBCOMMANDS = Object.freeze([
    'undo',
    'redo',
    'abandon',
    'op restore',
    'op revert',
    'workspace forget',
]);
/** jj subcommands that only touch the current workspace (never blocked). */
export const JJ_WORKSPACE_LOCAL_SUBCOMMANDS = Object.freeze([
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
export const JJ_READ_ONLY_SUBCOMMANDS = Object.freeze([
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
const JJ_TWO_WORD = new Set(['op', 'workspace add', 'workspace forget', 'file', 'bookmark', 'tag', 'git', 'util', 'sparse', 'debug']);
const JJ_VALUE_FLAGS = new Set(['-R', '--repository', '--at-op', '--at-operation', '--config', '--config-file', '--color']);
/** jj global boolean flags. */
const JJ_BOOLEAN_FLAGS = new Set([
    '--ignore-working-copy',
    '--no-integrate-operation',
    '--ignore-immutable',
    '--no-pager',
    '--quiet',
    '--debug',
]);
function jjSubcommandOf(words) {
    const first = words[0];
    if (first === undefined || first.startsWith('-'))
        return undefined;
    const second = words[1];
    if (first === 'op' && second !== undefined && !second.startsWith('-')) {
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
function classifyJjWords(words, raw, parsed, warnings) {
    if (!parsed || words.length === 0)
        return undefined;
    const index = skipPrelude(words, warnings);
    const program = words[index]?.value ?? '';
    if (baseName(program) !== 'jj' && baseName(program) !== 'jj.exe')
        return undefined;
    const globalOptions = [];
    let repository;
    let atOp;
    let cursor = index + 1;
    while (cursor < words.length) {
        const token = words[cursor]?.value ?? '';
        if (token === '--') {
            cursor += 1;
            break;
        }
        if (!token.startsWith('-') || token === '-')
            break;
        const eq = token.indexOf('=');
        const flag = eq >= 0 ? token.slice(0, eq) : token;
        const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
        globalOptions.push(token);
        if (JJ_VALUE_FLAGS.has(flag)) {
            const value = inline ?? words[cursor + 1]?.value;
            if (inline === undefined)
                cursor += 1;
            globalOptions.push(value ?? '');
            if (flag === '-R' || flag === '--repository')
                repository = value;
            if (flag === '--at-op' || flag === '--at-operation')
                atOp = value;
        }
        else if (!JJ_BOOLEAN_FLAGS.has(flag) && !/^--(color|config|at-op)/.test(flag)) {
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
    const restFlags = rest.filter((token) => token.startsWith('-'));
    const positionals = rest.filter((token) => !token.startsWith('-') && token !== '--');
    const allowCrossWorkspace = restFlags.includes('--allow-cross-workspace');
    let scope;
    let reason;
    if (subcommand === 'restore' && positionals.length === 0) {
        scope = 'destructive';
        reason = '`jj restore` without a pathspec silently discards the entire working-copy change';
    }
    else if (subcommand === 'abandon' && positionals[0] === '@') {
        scope = 'destructive';
        reason = '`jj abandon @` discards the current working-copy commit and its uncommitted files from disk';
    }
    else if (subcommand === 'undo' && allowCrossWorkspace) {
        scope = 'destructive';
        reason = '`jj undo --allow-cross-workspace` disables jj\'s only built-in cross-workspace protection';
    }
    else if (atOp !== undefined && JJ_READ_ONLY_SUBCOMMANDS.includes(subcommand)) {
        scope = 'read-only';
        reason = `\`jj --at-op=${atOp} ${subcommand}\` replays an old operation read-only`;
    }
    else if (subcommand === 'edit' && positionals.length >= 1) {
        scope = 'repo-wide';
        reason = '`jj edit <rev>` switches the working copy to another revision, so files outside that tree disappear from disk';
    }
    else if (subcommand === 'new' && positionals.length >= 1) {
        scope = 'repo-wide';
        reason = '`jj new <revset>` moves the working copy onto another revision, so files outside that tree disappear from disk';
    }
    else if (JJ_REPO_WIDE_SUBCOMMANDS.includes(subcommand)) {
        scope = 'repo-wide';
        reason = `\`jj ${subcommand}\` is repository-wide: it rewinds the operation view and rewrites the whole working copy of the current workspace`;
    }
    else if (JJ_READ_ONLY_SUBCOMMANDS.includes(subcommand)) {
        scope = 'read-only';
        reason = `\`jj ${subcommand}\` does not write the repository`;
    }
    else if (JJ_WORKSPACE_LOCAL_SUBCOMMANDS.includes(subcommand)) {
        scope = 'workspace-local';
        reason = `\`jj ${subcommand}\` only affects the current workspace`;
    }
    else {
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
 * @param commandLine - raw shell command string.
 * @returns jj invocations with their scope, plus parse warnings.
 */
export function classifyJjInvocation(commandLine) {
    const outer = tokenize(commandLine, 'command', 0);
    const warnings = [...outer.warnings];
    const invocations = [];
    const record = (segment) => {
        const invocation = classifyJjWords(segment.words, segment.raw, segment.parsed, warnings);
        if (invocation !== undefined)
            invocations.push(invocation);
    };
    for (const segment of outer.segments) {
        record(segment);
        const head = segment.words[0]?.value === undefined ? undefined : baseName(segment.words[0].value);
        if (head !== undefined && SHELL_WRAPPERS.has(head)) {
            const rest = segment.words.slice(1).map((token) => token.value);
            const cIndex = rest.findIndex((token) => token === '-c' || /^-[a-z]*c[a-z]*$/.test(token));
            const inner = cIndex >= 0 ? rest[cIndex + 1] : undefined;
            if (inner !== undefined && inner.length > 0) {
                for (const nestedSegment of tokenize(inner, 'substitution', 1).segments)
                    record(nestedSegment);
            }
        }
    }
    return { invocations: Object.freeze(invocations), warnings: Object.freeze(warnings) };
}
