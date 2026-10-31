/**
 * Unit tests for the pure `jj diff` parsers.
 *
 * The literal fixtures use the exact byte shapes jj 0.46 prints (verified against
 * the installed binary); one additional test runs a real jj repository so the
 * literals cannot quietly drift from the real format.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitFormatDiff, parseNulPaths } from '../src/changes-diff.ts';
import { makeTempRoot, writeJjConfig } from './helpers/fixtures.ts';

/** Join diff lines with LF; the appended LF makes every fixture end like jj output. */
function diffOf(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** Modified file: one context line kept, one line appended. */
const MODIFIED = diffOf([
  'diff --git a/a.txt b/a.txt',
  'index 5626abf0f7..4c7442bcf5 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,1 +1,2 @@',
  ' one',
  '+three',
]);

/** New file: no source side. */
const ADDED = diffOf([
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000000..4c7442bcf5',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
]);

/** Deleted file: no target side. */
const DELETED = diffOf([
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 4c7442bcf5..0000000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-old',
]);

/** Rename with an edited line. */
const RENAMED = diffOf([
  'diff --git a/multi.txt b/rename-edit.txt',
  'rename from multi.txt',
  'rename to rename-edit.txt',
  'index 2220e0f034..1f74146344 100644',
  '--- a/multi.txt',
  '+++ b/rename-edit.txt',
  '@@ -1,5 +1,5 @@',
  ' aaa',
  '-bbb',
  '+CHANGED',
  ' ccc',
  ' ddd',
  ' eee',
]);

/** Pure rename: only the rename markers, no content hunks. */
const PURE_RENAME = diffOf(['diff --git a/orig.txt b/renamed.txt', 'rename from orig.txt', 'rename to renamed.txt']);

/** Copy (Git syntax; jj 0.46 does not emit it yet, but the parser tolerates it). */
const COPIED = diffOf(['diff --git a/src.txt b/dst.txt', 'copy from src.txt', 'copy to dst.txt']);

/** Binary add. */
const BINARY_ADD = diffOf([
  'diff --git a/bin.dat b/bin.dat',
  'new file mode 100644',
  'index 0000000000..b1feab49a0',
  'Binary files /dev/null and b/bin.dat differ',
]);

/** Binary modify. */
const BINARY_MODIFY = diffOf([
  'diff --git a/bin.dat b/bin.dat',
  'index 7845b27cc9..96efe40d78 100644',
  'Binary files a/bin.dat and b/bin.dat differ',
]);

/** Binary delete: the target side is `/dev/null`, so the source side names the path. */
const BINARY_DELETE = diffOf([
  'diff --git a/gone.bin b/gone.bin',
  'deleted file mode 100644',
  'index 7845b27cc9..0000000000',
  'Binary files a/gone.bin and /dev/null differ',
]);

/** Mode-only section: metadata, no hunks. */
const MODE_ONLY = diffOf(['diff --git a/mode.sh b/mode.sh', 'old mode 100644', 'new mode 100755']);

/** Two hunks in one file. */
const MULTI_HUNK = diffOf([
  'diff --git a/big.txt b/big.txt',
  'index 1c99002b20..3246f5cd41 100644',
  '--- a/big.txt',
  '+++ b/big.txt',
  '@@ -1,5 +1,5 @@',
  ' 1',
  '-2',
  '+two-changed',
  ' 3',
  ' 4',
  ' 5',
  '@@ -32,7 +32,7 @@',
  ' 32',
  ' 33',
  ' 34',
  '-35',
  '+thirtyfive-changed',
  ' 36',
  ' 37',
]);

/** Missing-newline marker appears inside the hunk, not as body content. */
const MISSING_NEWLINE = diffOf([
  'diff --git a/nonl.txt b/nonl.txt',
  'index 2802503926..8ac312b411 100644',
  '--- a/nonl.txt',
  '+++ b/nonl.txt',
  '@@ -1,1 +1,1 @@',
  '-no newline at end',
  '\\ No newline at end of file',
  '+no newline at end!!',
  '\\ No newline at end of file',
]);

/** Git-style quoting (jj 0.46 does not quote, but a future release might). */
const QUOTED = diffOf([
  'diff --git "a/x y.txt" "b/x y.txt"',
  'index 1111111111..2222222222 100644',
  '--- "a/x y.txt"',
  '+++ "b/x y.txt"',
  '@@ -1 +1 @@',
  '-old',
  '+new',
]);

/** Quoted rename pair. */
const QUOTED_RENAME = diffOf([
  'diff --git "a/old name.txt" "b/new name.txt"',
  'rename from "old name.txt"',
  'rename to "new name.txt"',
]);

test('parseNulPaths splits NUL records and tolerates the trailing NUL', () => {
  assert.deepEqual(parseNulPaths('a.txt\0b.txt\0'), ['a.txt', 'b.txt']);
  assert.deepEqual(parseNulPaths('single.txt\0'), ['single.txt']);
  assert.deepEqual(parseNulPaths('no-trailing-nul.txt'), ['no-trailing-nul.txt']);
  assert.deepEqual(parseNulPaths('sp ace.txt\0ünïcode/文件.txt\0'), ['sp ace.txt', 'ünïcode/文件.txt']);
  assert.deepEqual(parseNulPaths(''), []);
  assert.deepEqual(parseNulPaths('\0'), []);
});

test('parseGitFormatDiff parses a modified file with counts, hunks and exact byte size', () => {
  const changes = parseGitFormatDiff(MODIFIED, ['a.txt']);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    status: 'modified',
    path: 'a.txt',
    added: 1,
    deleted: 0,
    binary: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' one', '+three'] }],
    diffBytes: Buffer.byteLength(MODIFIED, 'utf8'),
  });
});

test('parseGitFormatDiff derives the path from the `+++ b/` line when the list is empty', () => {
  const changes = parseGitFormatDiff(MODIFIED, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'a.txt');
  assert.equal(changes[0].status, 'modified');
});

test('parseGitFormatDiff marks a new file as added', () => {
  const changes = parseGitFormatDiff(ADDED, ['new.txt']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'added');
  assert.equal(changes[0].path, 'new.txt');
  assert.equal(changes[0].added, 2);
  assert.equal(changes[0].deleted, 0);
  assert.deepEqual(changes[0].hunks, [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+hello', '+world'] },
  ]);
});

test('parseGitFormatDiff marks a deleted file as deleted and derives its path from the header', () => {
  const changes = parseGitFormatDiff(DELETED, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'deleted');
  assert.equal(changes[0].path, 'old.txt');
  assert.equal(changes[0].added, 0);
  assert.equal(changes[0].deleted, 1);
});

test('parseGitFormatDiff reports a rename with edits as renamed with an oldPath', () => {
  const changes = parseGitFormatDiff(RENAMED, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'renamed');
  assert.equal(changes[0].path, 'rename-edit.txt');
  assert.equal(changes[0].oldPath, 'multi.txt');
  assert.equal(changes[0].added, 1);
  assert.equal(changes[0].deleted, 1);
  assert.deepEqual(changes[0].hunks, [
    { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' aaa', '-bbb', '+CHANGED', ' ccc', ' ddd', ' eee'] },
  ]);
});

test('parseGitFormatDiff reports a pure rename with no counts or hunks', () => {
  const changes = parseGitFormatDiff(PURE_RENAME, []);
  assert.deepEqual(changes, [
    {
      status: 'renamed',
      path: 'renamed.txt',
      oldPath: 'orig.txt',
      added: 0,
      deleted: 0,
      binary: false,
      hunks: [],
      diffBytes: Buffer.byteLength(PURE_RENAME, 'utf8'),
    },
  ]);
});

test('parseGitFormatDiff reports a copy as copied with an oldPath', () => {
  const changes = parseGitFormatDiff(COPIED, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'copied');
  assert.equal(changes[0].path, 'dst.txt');
  assert.equal(changes[0].oldPath, 'src.txt');
  assert.equal(changes[0].added, 0);
  assert.equal(changes[0].deleted, 0);
  assert.deepEqual(changes[0].hunks, []);
});

test('parseGitFormatDiff reports a binary add without counts and marks it binary', () => {
  const changes = parseGitFormatDiff(BINARY_ADD, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'added');
  assert.equal(changes[0].path, 'bin.dat');
  assert.equal(changes[0].binary, true);
  assert.equal(changes[0].added, 0);
  assert.equal(changes[0].deleted, 0);
  assert.deepEqual(changes[0].hunks, []);
  assert.ok(changes[0].diffBytes > 0);
});

test('parseGitFormatDiff reports a binary modify and a binary delete', () => {
  const modified = parseGitFormatDiff(BINARY_MODIFY, ['bin.dat']);
  assert.equal(modified.length, 1);
  assert.equal(modified[0].status, 'modified');
  assert.equal(modified[0].binary, true);
  assert.equal(modified[0].path, 'bin.dat');

  const deleted = parseGitFormatDiff(BINARY_DELETE, []);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].status, 'deleted');
  assert.equal(deleted[0].binary, true);
  assert.equal(deleted[0].path, 'gone.bin');
});

test('parseGitFormatDiff keeps a mode-only section as modified with no hunks', () => {
  const changes = parseGitFormatDiff(MODE_ONLY, ['mode.sh']);
  assert.deepEqual(changes, [
    {
      status: 'modified',
      path: 'mode.sh',
      added: 0,
      deleted: 0,
      binary: false,
      hunks: [],
      diffBytes: Buffer.byteLength(MODE_ONLY, 'utf8'),
    },
  ]);
});

test('parseGitFormatDiff parses multiple hunks with header starts and counts', () => {
  const changes = parseGitFormatDiff(MULTI_HUNK, ['big.txt']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].added, 2);
  assert.equal(changes[0].deleted, 2);
  assert.equal(changes[0].hunks.length, 2);
  assert.deepEqual(changes[0].hunks[0], {
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 5,
    lines: [' 1', '-2', '+two-changed', ' 3', ' 4', ' 5'],
  });
  assert.deepEqual(changes[0].hunks[1], {
    oldStart: 32,
    oldLines: 7,
    newStart: 32,
    newLines: 7,
    lines: [' 32', ' 33', ' 34', '-35', '+thirtyfive-changed', ' 36', ' 37'],
  });
});

test('parseGitFormatDiff ignores the missing-newline marker', () => {
  const changes = parseGitFormatDiff(MISSING_NEWLINE, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].added, 1);
  assert.equal(changes[0].deleted, 1);
  assert.deepEqual(changes[0].hunks, [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-no newline at end', '+no newline at end!!'] },
  ]);
});

test('parseGitFormatDiff handles Git-style quoted paths and missing hunk counts', () => {
  const changes = parseGitFormatDiff(QUOTED, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'x y.txt');
  assert.deepEqual(changes[0].hunks, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]);

  const renamed = parseGitFormatDiff(QUOTED_RENAME, []);
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].status, 'renamed');
  assert.equal(renamed[0].path, 'new name.txt');
  assert.equal(renamed[0].oldPath, 'old name.txt');
});

test('parseGitFormatDiff uses the authoritative path list in entry order, even for mode-only sections', () => {
  const text = `${MODE_ONLY}${MODIFIED}`;
  const paths = ['renamed/by/list.txt', 'a.txt'];
  const changes = parseGitFormatDiff(text, paths);
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((change) => [change.status, change.path]),
    [
      ['modified', 'renamed/by/list.txt'],
      ['modified', 'a.txt'],
    ],
  );
});

test('parseGitFormatDiff falls back to per-section derivation when the path list length mismatches', () => {
  const text = `${DELETED}${MODIFIED}`;
  const changes = parseGitFormatDiff(text, ['only-one-path']);
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((change) => [change.status, change.path]),
    [
      ['deleted', 'old.txt'],
      ['modified', 'a.txt'],
    ],
  );
});

test('parseGitFormatDiff keeps section order and byte sizes summing to the raw diff', () => {
  const text = `${DELETED}${MODIFIED}${PURE_RENAME}`;
  const changes = parseGitFormatDiff(text, ['old.txt', 'a.txt', 'renamed.txt']);
  assert.deepEqual(
    changes.map((change) => change.path),
    ['old.txt', 'a.txt', 'renamed.txt'],
  );
  const total = changes.reduce((sum, change) => sum + change.diffBytes, 0);
  assert.equal(total, Buffer.byteLength(text, 'utf8'));
});

test('parseGitFormatDiff returns [] for empty and malformed input', () => {
  assert.deepEqual(parseGitFormatDiff('', []), []);
  assert.deepEqual(parseGitFormatDiff('\n', []), []);
  assert.deepEqual(parseGitFormatDiff('not a diff at all\n', []), []);
  assert.deepEqual(parseGitFormatDiff('@@ -1 +1 @@\n-old\n+new\n', []), []);
  assert.deepEqual(parseGitFormatDiff('diff --git \n', []), []);
});

/** Run one real jj command against a fixture repository and fail loudly on error. */
function jj(repo: string, env: NodeJS.ProcessEnv, argv: readonly string[]): string {
  const result = spawnSync('jj', ['--no-pager', '--color=never', ...argv], { cwd: repo, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`jj ${argv.join(' ')} failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}

test('parses a real jj 0.46 Git-format diff for a mixed change', (t) => {
  const root = makeTempRoot('dsh-jj-changes-diff');
  t.after(() => root.cleanup());
  const repo = join(root.dir, 'repo');
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = { ...process.env, JJ_CONFIG: writeJjConfig(root.dir) };

  jj(repo, env, ['git', 'init', '--no-colocate']);
  assert.equal(realpathSync(jj(repo, env, ['root']).trim()), realpathSync(repo), 'fixture must be its own jj root');
  writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'delete-me.txt'), 'gone one\ngone two\n');
  writeFileSync(join(repo, 'rename-src.txt'), 'r1\nr2\nr3\nr4\nr5\nr6\nr7\nr8\n');
  jj(repo, env, ['describe', '-m', 'base']);
  const from = jj(repo, env, ['log', '--no-graph', '-r', '@', '-T', 'commit_id ++ "\\n"']).trim();

  writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repo, 'new.txt'), 'alpha\nbeta\n');
  rmSync(join(repo, 'delete-me.txt'));
  renameSync(join(repo, 'rename-src.txt'), join(repo, 'rename-dst.txt'));
  writeFileSync(join(repo, 'rename-dst.txt'), 'r1\nr2\nr3\nr4\nr5-changed\nr6\nr7\nr8\nr9\n');
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0xff]));
  const to = jj(repo, env, ['log', '--no-graph', '-r', '@', '-T', 'commit_id ++ "\\n"']).trim();
  assert.notEqual(to, from);

  const diffArgs = ['diff', '--ignore-working-copy', '--from', from, '--to', to];
  const paths = parseNulPaths(jj(repo, env, [...diffArgs, '-T', 'path ++ "\\0"']));
  const changes = parseGitFormatDiff(jj(repo, env, [...diffArgs, '--git']), paths);

  assert.deepEqual(
    changes.map((change) => [change.status, change.path, change.added, change.deleted, change.oldPath]),
    [
      ['added', 'bin.dat', 0, 0, undefined],
      ['deleted', 'delete-me.txt', 0, 2, undefined],
      ['modified', 'keep.txt', 1, 0, undefined],
      ['added', 'new.txt', 2, 0, undefined],
      ['renamed', 'rename-dst.txt', 2, 1, 'rename-src.txt'],
    ],
  );
  assert.equal(changes[0].binary, true, 'bin.dat is binary');
  assert.equal(changes[2].hunks.length, 1, 'keep.txt has one hunk');
  assert.deepEqual(
    changes.map((change) => change.path),
    paths,
    'the NUL path listing is the authoritative entry order',
  );
});
