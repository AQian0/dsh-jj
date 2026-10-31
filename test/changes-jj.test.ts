/**
 * Reader tests for the workspace-changes recorder.
 *
 * The reader is exercised against real jj 0.46 repositories (native and
 * colocated), because the point of `readCommit`/`readDiff` is jj's own snapshot
 * and diff behaviour: no mocked repository can prove the turn-start commit id
 * changes after a file write or that a rename keeps its source path. A small set
 * of fake-runner tests pins the command shape, limit binding, and every
 * failure-to-`undefined` path without paying for another subprocess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JjChangesReader } from '../src/changes-types.ts';
import { createJjChangesReader, type JjChangesCommandLimits } from '../src/changes-jj.ts';
import { resolveConfig } from '../src/config.ts';
import { createCommandRunJj } from '../src/jj-command.ts';
import type { Fixture } from './helpers/fixtures.ts';
import { initJjColocated, initJjNative, makeFixture } from './helpers/fixtures.ts';
import type { JjRunResult, RunJj, RunJjOptions } from '../src/types.ts';

/** Build the production-shaped reader over the fixture's real jj runner. */
function readerFor(fx: Fixture): JjChangesReader {
  const config = resolveConfig({});
  const limits: JjChangesCommandLimits = {
    timeoutMs: config.timeoutMs,
    graceMs: config.graceMs,
    maxOutputBytes: config.maxOutputBytes,
  };
  return createJjChangesReader(createCommandRunJj(fx.run, config), limits);
}

/** A settled run result with only the facts under test overridden. */
function runResult(overrides: Partial<JjRunResult> = {}): JjRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, killedByTimeout: false, ...overrides };
}

/** A runner that records its calls and returns (or throws) the queued results in order. */
function recordingRunner(results: readonly (JjRunResult | Error)[]): {
  readonly runJj: RunJj;
  readonly calls: RunJjOptions[];
} {
  const calls: RunJjOptions[] = [];
  let index = 0;
  const runJj: RunJj = async (options) => {
    calls.push(options);
    const next = results[index];
    index += 1;
    if (next === undefined) return runResult();
    if (next instanceof Error) throw next;
    return next;
  };
  return { runJj, calls };
}

/** Distinctive limits so a test can prove they were bound into every command. */
const LIMITS: JjChangesCommandLimits = { timeoutMs: 1_234, graceMs: 56, maxOutputBytes: 7_890_123 };

const FAKE_DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111111..2222222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,1 +1,2 @@',
  ' one',
  '+two',
  '',
].join('\n');

test('readCommit returns a 40-hex id, changes after a write, and is stable without changes', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  const reader = readerFor(fx);

  const first = await reader.readCommit({ cwd: repo });
  assert.ok(first !== undefined, 'a fresh jj-native repo must produce a commit id');
  assert.match(first, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  assert.equal(await reader.readCommit({ cwd: repo }), first, 'no changes means no new working-copy commit');

  writeFileSync(join(repo, 'added.txt'), 'hello\n');
  const afterWrite = await reader.readCommit({ cwd: repo });
  assert.ok(afterWrite !== undefined, 'the snapshot after a write must still produce a commit id');
  assert.match(afterWrite, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  assert.notEqual(afterWrite, first, 'readCommit must snapshot the working copy, not return a cached parent id');
  assert.equal(await reader.readCommit({ cwd: repo }), afterWrite, 'a second read without edits must be stable');
});

test('readDiff reports added/deleted counts, renames, mode-only and binary changes', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  const reader = readerFor(fx);

  // Turn-start state (snapshotted by readCommit).
  writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'delete-me.txt'), 'gone one\ngone two\n');
  writeFileSync(join(repo, 'rename-src.txt'), 'r1\nr2\nr3\nr4\nr5\nr6\nr7\nr8\n');
  writeFileSync(join(repo, 'mode.sh'), '#!/bin/sh\necho hi\n');
  const from = await reader.readCommit({ cwd: repo });
  assert.ok(from !== undefined, 'turn-start commit id');

  // Turn-end state.
  writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\nfour\n'); // +2
  writeFileSync(join(repo, 'new.txt'), 'alpha\nbeta\ngamma\n'); // +3
  rmSync(join(repo, 'delete-me.txt')); // -2
  renameSync(join(repo, 'rename-src.txt'), join(repo, 'rename-dst.txt'));
  writeFileSync(join(repo, 'rename-dst.txt'), 'r1\nr2\nr3\nr4\nr5-changed\nr6\nr7\nr8\nr9\n'); // +2 / -1
  chmodSync(join(repo, 'mode.sh'), 0o755); // mode-only
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff])); // binary add
  const to = await reader.readCommit({ cwd: repo });
  assert.ok(to !== undefined, 'turn-end commit id');
  assert.notEqual(to, from);

  const changes = await reader.readDiff({ cwd: repo, from, to });
  assert.ok(changes !== undefined, 'readDiff over two recorded commits must resolve');
  assert.equal(changes.length, 6, `unexpected files: ${changes.map((change) => change.path).join(', ')}`);
  const byPath = new Map(changes.map((change) => [change.path, change]));

  const keep = byPath.get('keep.txt');
  assert.ok(keep !== undefined, 'keep.txt must be listed');
  assert.equal(keep.status, 'modified');
  assert.equal(keep.added, 2);
  assert.equal(keep.deleted, 0);
  assert.equal(keep.binary, false);
  assert.equal(keep.hunks.length, 1);
  assert.equal(keep.hunks[0]?.oldStart, 1);

  const added = byPath.get('new.txt');
  assert.ok(added !== undefined, 'new.txt must be listed');
  assert.equal(added.status, 'added');
  assert.equal(added.added, 3);
  assert.equal(added.deleted, 0);

  const deleted = byPath.get('delete-me.txt');
  assert.ok(deleted !== undefined, 'delete-me.txt must be listed');
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.added, 0);
  assert.equal(deleted.deleted, 2);

  const renamed = byPath.get('rename-dst.txt');
  assert.ok(renamed !== undefined, 'rename-dst.txt must be listed under its target path');
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'rename-src.txt');
  assert.equal(renamed.added, 2);
  assert.equal(renamed.deleted, 1);

  const modeOnly = byPath.get('mode.sh');
  assert.ok(modeOnly !== undefined, 'a chmod-only change must still be listed');
  assert.equal(modeOnly.status, 'modified');
  assert.equal(modeOnly.added, 0);
  assert.equal(modeOnly.deleted, 0);
  assert.equal(modeOnly.binary, false);
  assert.equal(modeOnly.hunks.length, 0);

  const binary = byPath.get('bin.dat');
  assert.ok(binary !== undefined, 'bin.dat must be listed');
  assert.equal(binary.status, 'added');
  assert.equal(binary.binary, true);
  assert.equal(binary.added, 0);
  assert.equal(binary.deleted, 0);
  assert.equal(binary.hunks.length, 0);

  for (const change of changes) assert.ok(change.diffBytes > 0, `${change.path} must carry its diff bytes`);
});

test('readDiff returns [] when from and to are the same commit', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  const reader = readerFor(fx);
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  const id = await reader.readCommit({ cwd: repo });
  assert.ok(id !== undefined);
  assert.deepEqual(await reader.readDiff({ cwd: repo, from: id, to: id }), []);
});

test('readDiff works in both jj-native and colocated repositories', async (t) => {
  for (const [label, init] of [
    ['jj-native', initJjNative],
    ['jj-colocated', initJjColocated],
  ] as const) {
    const fx = makeFixture(t, `dsh-jj-changes-${label}`);
    const repo = await init(fx.run, fx.path('repo'));
    const reader = readerFor(fx);
    writeFileSync(join(repo, 'f.txt'), 'a\n');
    const from = await reader.readCommit({ cwd: repo });
    assert.ok(from !== undefined, `${label}: turn-start commit id`);
    writeFileSync(join(repo, 'f.txt'), 'a\nb\n');
    const to = await reader.readCommit({ cwd: repo });
    assert.ok(to !== undefined, `${label}: turn-end commit id`);
    const changes = await reader.readDiff({ cwd: repo, from, to });
    assert.ok(changes !== undefined, `${label}: readDiff must resolve`);
    assert.equal(changes.length, 1, `${label}: exactly one changed file`);
    assert.equal(changes[0]?.path, 'f.txt', `${label}: changed path`);
    assert.equal(changes[0]?.status, 'modified', `${label}: status`);
    assert.equal(changes[0]?.added, 1, `${label}: added lines`);
    assert.equal(changes[0]?.deleted, 0, `${label}: deleted lines`);
  }
});

test('readCommit and readDiff resolve undefined outside a jj repository', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes');
  const plain = fx.path('not-a-repository');
  const reader = readerFor(fx);
  assert.equal(await reader.readCommit({ cwd: plain }), undefined);
  assert.equal(await reader.readDiff({ cwd: plain, from: 'a'.repeat(40), to: 'b'.repeat(40) }), undefined);
});

test('readDiff resolves undefined when a commit id is not a known revision', async (t) => {
  const fx = makeFixture(t, 'dsh-jj-changes');
  const repo = await initJjNative(fx.run, fx.path('repo'));
  const reader = readerFor(fx);
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  const id = await reader.readCommit({ cwd: repo });
  assert.ok(id !== undefined);
  // `'0'.repeat(40)` is jj's root commit, so use an id that cannot resolve instead.
  const bogus = 'deadbeef'.repeat(5);
  assert.equal(await reader.readDiff({ cwd: repo, from: bogus, to: id }), undefined);
  assert.equal(await reader.readDiff({ cwd: repo, from: id, to: bogus }), undefined);
});

test('readCommit binds limits, forwards the signal, and never passes --ignore-working-copy', async () => {
  const id = '0123456789abcdef0123456789abcdef01234567';
  const { runJj, calls } = recordingRunner([runResult({ stdout: `${id}\n` })]);
  const reader = createJjChangesReader(runJj, LIMITS);
  const signal = new AbortController().signal;
  assert.equal(await reader.readCommit({ cwd: '/repo', signal }), id);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.deepEqual(call.argv, ['log', '--no-graph', '-r', '@', '-T', 'commit_id ++ "\\n"']);
  assert.equal(call.cwd, '/repo');
  assert.equal(call.signal, signal);
  assert.equal(call.timeoutMs, LIMITS.timeoutMs);
  assert.equal(call.graceMs, LIMITS.graceMs);
  assert.equal(call.maxOutputBytes, LIMITS.maxOutputBytes);
  assert.ok(!call.argv.includes('--ignore-working-copy'), 'readCommit must snapshot the working copy');

  const sha256 = 'a'.repeat(64);
  const sha256Reader = createJjChangesReader(recordingRunner([runResult({ stdout: sha256 })]).runJj, LIMITS);
  assert.equal(await sha256Reader.readCommit({ cwd: '/repo' }), sha256, 'SHA-256 commit ids are accepted');
});

test('readCommit resolves undefined for every failed read shape', async () => {
  const bad: (JjRunResult | Error)[] = [
    runResult({ exitCode: 1 }),
    runResult({ killedByTimeout: true }),
    runResult({ truncated: true }),
    runResult({ stdout: 'not a commit id\n' }),
    runResult({ stdout: '' }),
    new Error('runner exploded'),
  ];
  for (const result of bad) {
    const reader = createJjChangesReader(recordingRunner([result]).runJj, LIMITS);
    assert.equal(await reader.readCommit({ cwd: '/repo' }), undefined);
  }
});

test('readDiff binds limits and uses --ignore-working-copy for both commands', async () => {
  const from = 'a'.repeat(40);
  const to = 'b'.repeat(40);
  const { runJj, calls } = recordingRunner([runResult({ stdout: 'a.txt\0' }), runResult({ stdout: FAKE_DIFF })]);
  const reader = createJjChangesReader(runJj, LIMITS);
  const changes = await reader.readDiff({ cwd: '/repo', from, to });
  assert.ok(changes !== undefined);
  assert.equal(changes.length, 1);
  assert.deepEqual(
    changes.map((change) => [change.status, change.path, change.added, change.deleted]),
    [['modified', 'a.txt', 1, 0]],
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.timeoutMs, LIMITS.timeoutMs);
    assert.equal(call.graceMs, LIMITS.graceMs);
    assert.equal(call.maxOutputBytes, LIMITS.maxOutputBytes);
    assert.ok(call.argv.includes('--ignore-working-copy'), 'both diff commands must ignore the working copy');
  }
  assert.deepEqual(calls[0].argv, ['diff', '--ignore-working-copy', '--from', from, '--to', to, '-T', 'path ++ "\\0"']);
  assert.deepEqual(calls[1].argv, ['diff', '--ignore-working-copy', '--from', from, '--to', to, '--git']);
});

test('readDiff returns [] and runs no command when from and to match', async () => {
  const id = 'c'.repeat(40);
  const { runJj, calls } = recordingRunner([]);
  const reader = createJjChangesReader(runJj, LIMITS);
  assert.deepEqual(await reader.readDiff({ cwd: '/repo', from: id, to: id }), []);
  assert.equal(calls.length, 0);
});

test('readDiff resolves undefined when either command fails', async () => {
  const from = 'a'.repeat(40);
  const to = 'b'.repeat(40);
  const failures: (JjRunResult | Error)[] = [
    runResult({ exitCode: 1 }),
    runResult({ killedByTimeout: true }),
    runResult({ truncated: true }),
    new Error('runner exploded'),
  ];
  for (const failure of failures) {
    // First command fails: exactly one call, no diff command.
    const first = recordingRunner([failure]);
    const firstReader = createJjChangesReader(first.runJj, LIMITS);
    assert.equal(await firstReader.readDiff({ cwd: '/repo', from, to }), undefined);
    assert.equal(first.calls.length, 1);

    // Second command fails: both commands ran, still undefined.
    const second = recordingRunner([runResult({ stdout: 'a.txt\0' }), failure]);
    const secondReader = createJjChangesReader(second.runJj, LIMITS);
    assert.equal(await secondReader.readDiff({ cwd: '/repo', from, to }), undefined);
    assert.equal(second.calls.length, 2);
  }
});

test('reader resolves undefined for an empty diff without throwing', async () => {
  const from = 'a'.repeat(40);
  const to = 'b'.repeat(40);
  const { runJj } = recordingRunner([runResult(), runResult()]);
  const reader = createJjChangesReader(runJj, LIMITS);
  assert.deepEqual(await reader.readDiff({ cwd: '/repo', from, to }), []);
});
