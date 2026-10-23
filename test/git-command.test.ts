/**
 * Git invocation classification (design contract §8.2 / §8.3). Pure function:
 * no I/O, no subprocess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGitInvocation,
  gitEquivalence,
  hasMutatingGitInvocation,
  GIT_SUBCOMMAND_RULES,
  type GitInvocation,
} from '../src/git-command.ts';

function only(commandLine: string): GitInvocation {
  const classification = classifyGitInvocation(commandLine);
  assert.equal(classification.invocations.length, 1, `expected exactly one invocation in: ${commandLine}`);
  return classification.invocations[0];
}

const MUTATING_CASES: ReadonlyArray<readonly [string, string]> = [
  ['git commit -m "msg"', 'commit'],
  ['git commit --amend', 'commit'],
  ['git checkout main', 'checkout'],
  ['git switch main', 'switch'],
  ['git switch -c feature', 'switch'],
  ['git reset --hard HEAD', 'reset'],
  ['git reset', 'reset'],
  ['git restore src/app.ts', 'restore'],
  ['git revert HEAD', 'revert'],
  ['git stash', 'stash'],
  ['git stash pop', 'stash'],
  ['git merge main', 'merge'],
  ['git rebase main', 'rebase'],
  ['git cherry-pick 0123abc', 'cherry-pick'],
  ['git am < patch.mbox', 'am'],
  ['git apply patch.diff', 'apply'],
  ['git format-patch HEAD~1', 'format-patch'],
  ['git worktree add ../wt', 'worktree'],
  ['git worktree remove ../wt', 'worktree'],
  ['git branch -f main HEAD', 'branch'],
  ['git branch feature/x', 'branch'],
  ['git update-ref refs/heads/main HEAD', 'update-ref'],
  ['git push origin main', 'push'],
  ['git fetch origin', 'fetch'],
  ['git pull', 'pull'],
  ['git gc --prune=now', 'gc'],
  ['git prune', 'prune'],
  ['git repack -ad', 'repack'],
  ['git pack-refs --all', 'pack-refs'],
  ['git maintenance run', 'maintenance'],
  ['git filter-branch --all', 'filter-branch'],
  ['git filter-repo --force', 'filter-repo'],
  ['git clone https://example.invalid/repo.git', 'clone'],
  ['git init', 'init'],
  ['git tag -d v1.0.0', 'tag'],
  ['git tag v1.0.0', 'tag'],
  ['git config user.name "Someone"', 'config'],
  ['git config --unset user.name', 'config'],
  ['git remote add origin https://example.invalid/r.git', 'remote'],
  ['git submodule update --init', 'submodule'],
  ['git reflog expire --all', 'reflog'],
  ['git symbolic-ref HEAD refs/heads/main', 'symbolic-ref'],
  ['git bisect start', 'bisect'],
  ['git notes add -m x', 'notes'],
  ['git sparse-checkout set src', 'sparse-checkout'],
  ['git archive HEAD', 'archive'],
  ['git rm file', 'rm'],
  ['git mv a b', 'mv'],
  ['git clean -fd', 'clean'],
  ['git add file', 'add'],
  ['git checkout-index -a', 'checkout-index'],
  ['git update-index --add file', 'update-index'],
  ['git read-tree HEAD', 'read-tree'],
  ['git write-tree', 'write-tree'],
  ['git commit-tree HEAD^{tree}', 'commit-tree'],
  ['git hash-object -w file', 'hash-object'],
  ['git bundle create repo.bundle HEAD', 'bundle'],
  ['git replace HEAD~1 HEAD', 'replace'],
  ['git lfs install', 'lfs'],
];

for (const [commandLine, subcommand] of MUTATING_CASES) {
  test(`mutate: ${commandLine}`, () => {
    const invocation = only(commandLine);
    assert.equal(invocation.subcommand, subcommand);
    assert.equal(invocation.mutating, true, `${commandLine} must be mutating`);
    assert.equal(invocation.safety, 'mutate');
    assert.equal(invocation.confidence, 'high');
    assert.ok(invocation.reason.length > 0);
  });
}

test('every mutating invocation carries a jj equivalence line (contract §8.6)', () => {
  for (const [commandLine, subcommand] of MUTATING_CASES) {
    const invocation = only(commandLine);
    assert.equal(invocation.mutating, true, `${commandLine} must be mutating`);
    const equivalence = gitEquivalence(invocation);
    // `''` means "no single equivalent known"; the refusal text then falls back to
    // the contract's no-equivalent sentence (§8.5).
    assert.ok(
      equivalence === '' || /jj |no .*equivalent|no single jj equivalent/i.test(equivalence),
      `${subcommand} (${commandLine}) needs a jj equivalence, got ${JSON.stringify(equivalence)}`,
    );
    if (equivalence !== '') assert.match(equivalence, /jj |no .*equivalent/i);
  }
});

test('non-contextual mutating table entries are mutating in their bare form', () => {
  for (const [subcommand, rule] of Object.entries(GIT_SUBCOMMAND_RULES)) {
    if (rule.safety !== 'mutate' || rule.contextual === true) continue;
    const invocation = only(`git ${subcommand}`);
    assert.equal(invocation.mutating, true, `git ${subcommand} must be mutating`);
    assert.ok(gitEquivalence(invocation).length > 0, `git ${subcommand} needs a jj equivalence`);
  }
});

test('key equivalence lines match contract §8.6', () => {
  assert.match(gitEquivalence(only('git commit -m x')), /jj commit -m "…"/);
  assert.match(gitEquivalence(only('git checkout main')), /jj new <rev>/);
  assert.match(gitEquivalence(only('git reset --hard HEAD')), /jj edit <rev>/);
  assert.match(gitEquivalence(only('git reset')), /jj undo/);
  assert.match(gitEquivalence(only('git stash')), /jj new/);
  assert.match(gitEquivalence(only('git merge main')), /jj new @ <rev>/);
  assert.match(gitEquivalence(only('git rebase main')), /jj rebase -r @ -d <dest>/);
  assert.match(gitEquivalence(only('git cherry-pick abc')), /jj duplicate <rev>/);
  assert.match(gitEquivalence(only('git worktree add ../wt')), /jj workspace add <path>/);
  assert.match(gitEquivalence(only('git worktree remove ../wt')), /jj workspace forget <name>/);
  assert.match(gitEquivalence(only('git branch feature')), /jj bookmark create <name> -r @/);
  assert.match(gitEquivalence(only('git branch -f main HEAD')), /jj bookmark set <name> -r <r> --allow-backwards/);
  assert.match(gitEquivalence(only('git push')), /jj git push -b <bookmark>/);
  assert.match(gitEquivalence(only('git fetch')), /jj git fetch/);
  assert.match(gitEquivalence(only('git pull')), /jj git fetch && jj rebase -d <bookmark>@origin/);
  assert.match(gitEquivalence(only('git gc')), /jj util gc/);
});

const READ_CASES: readonly string[] = [
  'git status',
  'git log --oneline -5',
  'git diff HEAD',
  'git show HEAD',
  'git rev-parse HEAD',
  'git rev-list --count HEAD',
  'git cat-file -p HEAD',
  'git ls-files',
  'git ls-tree HEAD',
  'git ls-remote origin',
  'git blame src/app.ts',
  'git grep TODO',
  'git shortlog -sn',
  'git describe --tags',
  'git for-each-ref',
  'git show-ref',
  'git merge-base main HEAD',
  'git name-rev HEAD',
  'git count-objects -v',
  'git verify-pack -v pack.idx',
  'git check-ignore -v file',
  'git check-attr text file',
  'git fsck',
  'git whatchanged',
  'git cherry main',
  'git range-diff main..HEAD',
  'git help commit',
  'git version',
  'git --version',
  'git stash list',
  'git stash show',
  'git worktree list',
  'git submodule status',
  'git notes list',
  'git remote -v',
  'git remote show origin',
  'git remote get-url origin',
  'git tag -l',
  'git branch',
  'git branch -a',
  'git branch --show-current',
  'git config --get user.name',
  'git config --list',
  'git reflog',
  'git symbolic-ref HEAD',
  'git hash-object file',
  'git apply --check patch.diff',
  'git add --dry-run file',
  'git fetch --dry-run',
  'git push --dry-run',
  'git bisect log',
  'git bundle verify repo.bundle',
];

for (const commandLine of READ_CASES) {
  test(`read: ${commandLine}`, () => {
    const invocation = only(commandLine);
    assert.equal(invocation.mutating, false, `${commandLine} must not be mutating`);
    assert.equal(invocation.safety, 'read', `expected read for ${commandLine}, got ${invocation.safety}: ${invocation.reason}`);
    assert.equal(invocation.confidence, 'high');
  });
}

const PROGRAM_FORMS: readonly string[] = [
  '/usr/bin/git commit -m x',
  './git commit -m x',
  '"git" commit -m x',
  "'git' commit -m x",
  'git.exe commit -m x',
  'sudo git commit -m x',
  'sudo -u root git commit -m x',
  'env git commit -m x',
  'env A=1 git commit -m x',
  'A=1 GIT_PAGER=cat git commit -m x',
  'command git commit -m x',
  'nohup git commit -m x',
  'time git commit -m x',
  'nice -n 5 git commit -m x',
  'stdbuf -o0 git commit -m x',
  'xargs git commit -m x',
  'timeout 5 git commit -m x',
  'cd /tmp/repo && git commit -m x',
  'git -C /tmp/repo commit -m x',
  'git --git-dir=/tmp/repo/.git commit -m x',
  'git --work-tree=/tmp/repo commit -m x',
  'git -c user.name=x commit -m x',
  'git --no-pager commit -m x',
  'true && git commit -m x',
  'false || git commit -m x',
  'echo hi | git commit -m x',
  'git status; git commit -m x',
  'git commit -m x\ngit status',
  'bash -c "git commit -m x"',
  'sh -c \'git commit -m x\'',
  'echo "$(git rev-parse HEAD)" && git commit -m x',
  'echo "`git push`"',
];

for (const commandLine of PROGRAM_FORMS) {
  test(`recognition: ${JSON.stringify(commandLine)}`, () => {
    const classification = classifyGitInvocation(commandLine);
    assert.ok(classification.invocations.length >= 1, `expected a git invocation in: ${commandLine}`);
    assert.ok(
      classification.invocations.some((entry) => entry.mutating),
      `expected a mutating invocation in: ${commandLine}`,
    );
  });
}

test('global options are extracted and lower the confidence for the non-canonical spellings', () => {
  const withChangeDir = only('git -C sub commit');
  assert.deepEqual(withChangeDir.globalOptions, ['-C', 'sub']);
  assert.equal(withChangeDir.changeDir, 'sub');
  const withGitDir = only('git --git-dir=/x/.git commit');
  assert.equal(withGitDir.gitDir, '/x/.git');
  const withWorkTree = only('git --work-tree=/x commit');
  assert.equal(withWorkTree.workTree, '/x');
});

test('compound command keeps invocation order and records the cd target', () => {
  const classification = classifyGitInvocation('cd /tmp/repo && git status; git log');
  assert.deepEqual(classification.invocations.map((entry) => entry.subcommand), ['status', 'log']);
  assert.ok(classification.segments.some((segment) => segment.cdTarget === '/tmp/repo'));
});

test('unknown subcommand is low confidence and never mutating', () => {
  const invocation = classifyGitInvocation('git frobnicate --weird').invocations[0];
  assert.equal(invocation?.subcommand, 'frobnicate');
  assert.equal(invocation?.safety, 'unknown');
  assert.equal(invocation?.mutating, false);
  assert.equal(invocation?.confidence, 'low');
  assert.equal(gitEquivalence(invocation), '');
});

test('bare git invocation has a null subcommand and is never mutating', () => {
  const invocation = classifyGitInvocation('git').invocations[0];
  assert.equal(invocation?.subcommand, null);
  assert.equal(invocation?.safety, 'unknown');
  assert.equal(invocation?.mutating, false);
  assert.equal(invocation?.confidence, 'low');
});

test('unparsable input yields zero invocations', () => {
  const classification = classifyGitInvocation('git commit -m "oops');
  assert.equal(classification.invocations.length, 0);
  assert.equal(hasMutatingGitInvocation(classification), false);
  assert.ok(classification.warnings.some((warning) => warning.includes('unterminated')));
});

test('variable program and eval are not misclassified', () => {
  for (const commandLine of ['$GIT commit -m x', 'eval "git commit -m x"', 'ls -la', 'node --test', 'jj commit -m x']) {
    const classification = classifyGitInvocation(commandLine);
    assert.equal(hasMutatingGitInvocation(classification), false, `must not classify as mutating: ${commandLine}`);
  }
});

test('dangerous subcommands from the DSH audit are all covered', () => {
  const dangerous = ['commit', 'checkout', 'switch', 'reset', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'worktree', 'branch', 'update-ref', 'pull', 'push', 'fetch', 'gc', 'prune', 'filter-branch'];
  for (const subcommand of dangerous) {
    assert.ok(GIT_SUBCOMMAND_RULES[subcommand], `${subcommand} must be in the table`);
  }
});

test('classification is a pure, repeatable function', () => {
  const first = classifyGitInvocation('git -C /tmp/x commit -m "a; b" && git status');
  const second = classifyGitInvocation('git -C /tmp/x commit -m "a; b" && git status');
  assert.deepEqual(first, second);
});
// ---------------------------------------------------------------------------
// jj-side classification (contract §8.3b / v2.0)
// ---------------------------------------------------------------------------

test('classifyJjInvocation: repository-wide commands', async () => {
  const { classifyJjInvocation } = await import('../src/git-command.ts');
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['jj undo', 'undo'],
    ['jj redo', 'redo'],
    ['jj abandon xyz', 'abandon'],
    ['jj op restore abcdef', 'op restore'],
    ['jj op revert abcdef', 'op revert'],
    ['sudo jj undo', 'undo'],
    ['cd /tmp/x && jj op restore abc', 'op restore'],
  ];
  for (const [commandLine, subcommand] of cases) {
    const classification = classifyJjInvocation(commandLine);
    assert.equal(classification.invocations.length, 1, commandLine);
    assert.equal(classification.invocations[0]?.subcommand, subcommand);
    assert.equal(classification.invocations[0]?.scope, 'repo-wide');
  }
});

test('classifyJjInvocation: workspace-local, read-only, and at-op replay', async () => {
  const { classifyJjInvocation } = await import('../src/git-command.ts');
  for (const command of ['jj new', 'jj describe -m x', 'jj commit -m x', 'jj squash', 'jj rebase -d main', 'jj restore file', 'jj split']) {
    assert.equal(classifyJjInvocation(command).invocations[0]?.scope, 'workspace-local', command);
  }
  for (const command of ['jj status', 'jj log', 'jj diff', 'jj show', 'jj evolog', 'jj op log', 'jj file list']) {
    assert.equal(classifyJjInvocation(command).invocations[0]?.scope, 'read-only', command);
  }
  const atOp = classifyJjInvocation('jj --at-op=abcdef log').invocations[0];
  assert.equal(atOp?.scope, 'read-only');
  assert.equal(atOp?.atOp, 'abcdef');
  // The repeated-token form printed in jj hints is tolerated too.
  assert.equal(classifyJjInvocation('jj --at-op=abcdef jj log').invocations[0]?.scope, 'read-only');
});

test('classifyJjInvocation: -R target and workspace forget argument are captured', async () => {
  const { classifyJjInvocation } = await import('../src/git-command.ts');
  const withRepo = classifyJjInvocation('jj -R /tmp/other undo').invocations[0];
  assert.equal(withRepo?.repository, '/tmp/other');
  assert.equal(withRepo?.scope, 'repo-wide');
  const forget = classifyJjInvocation('jj workspace forget other').invocations[0];
  assert.equal(forget?.subcommand, 'workspace forget');
  assert.equal(forget?.targetWorkspace, 'other');
});

test('classifyJjInvocation is pure and ignores git commands', async () => {
  const { classifyJjInvocation } = await import('../src/git-command.ts');
  assert.deepEqual(classifyJjInvocation('git commit -m x'), classifyJjInvocation('git commit -m x'));
  assert.equal(classifyJjInvocation('git commit -m x').invocations.length, 0);
  assert.equal(classifyJjInvocation('jj frobnicate').invocations[0]?.scope, 'unknown');
  assert.equal(classifyJjInvocation('jj undo "unterminated').invocations.length, 0);
});
