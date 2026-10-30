/**
 * Commit-description style policy: history inheritance, ask-the-user fallback,
 * configured/custom styles, and the split-commit guidance.
 *
 * The module is pure, so these are plain unit tests over description samples and
 * config-shaped options; no repository fixture is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMIT_STYLE_CHOICES,
  COMMIT_STYLE_DOMINANCE,
  COMMIT_STYLE_IDS,
  COMMIT_STYLE_PRESETS,
  CONCRETE_COMMIT_STYLE_IDS,
  MIN_COMMIT_STYLE_SAMPLES,
  SPLIT_COMMITS_GUIDANCE,
  classifyDescriptionStyle,
  commitStylePromptText,
  detectCommitStyle,
  firstDescriptionLine,
  resolveCommitStylePolicy,
  type CommitStyleDetection,
} from '../src/commit-style.ts';

test('firstDescriptionLine keeps only the subject line and trims it', () => {
  assert.equal(firstDescriptionLine('feat: add parser\n\nbody text'), 'feat: add parser');
  assert.equal(firstDescriptionLine('fix: crlf\r\nbody'), 'fix: crlf');
  assert.equal(firstDescriptionLine('  chore: padded  '), 'chore: padded');
  assert.equal(firstDescriptionLine(''), '');
  assert.equal(firstDescriptionLine('\nbody only'), '');
});

test('classifyDescriptionStyle recognises Conventional/Angular, Gitmoji, and plain subjects', () => {
  assert.equal(classifyDescriptionStyle('feat(parser): add strict mode'), 'conventional');
  assert.equal(classifyDescriptionStyle('fix!: drop old API'), 'conventional');
  assert.equal(classifyDescriptionStyle('chore(deps): bump typescript'), 'conventional');
  assert.equal(classifyDescriptionStyle('revert: feat(parser): add strict mode'), 'conventional');
  assert.equal(classifyDescriptionStyle(':sparkles: add strict mode'), 'gitmoji');
  assert.equal(classifyDescriptionStyle(':bug: fix parser'), 'gitmoji');
  assert.equal(classifyDescriptionStyle('✨ add strict mode'), 'gitmoji');
  assert.equal(classifyDescriptionStyle('Add strict parser mode'), 'plain');
  assert.equal(classifyDescriptionStyle('修复解析器问题'), 'plain');
  // Capitalised "Fix: …" is not the lowercase Conventional grammar; it stays plain.
  assert.equal(classifyDescriptionStyle('Fix: parser crash'), 'plain');
  // Empty descriptions (root commit, undescribed change) are ignored.
  assert.equal(classifyDescriptionStyle(''), undefined);
  assert.equal(classifyDescriptionStyle('\nbody only'), undefined);
});

test('detectCommitStyle inherits a dominant family and reports counts', () => {
  const detection = detectCommitStyle([
    'feat(core): add alpha',
    'fix: correct beta',
    'docs: explain gamma',
    'refactor: split delta',
    '',
    'feat(cli): add epsilon',
  ]);
  assert.equal(detection.style, 'conventional');
  assert.equal(detection.confidence, 'high');
  assert.equal(detection.sampleCount, 5, 'empty descriptions are ignored');
  assert.equal(detection.needsUserChoice, false);
  assert.deepEqual(detection.counts, { conventional: 5, gitmoji: 0, plain: 0 });
  assert.match(detection.reason, /5\/5/);
});

test('detectCommitStyle asks the user when history is too thin', () => {
  for (const sample of [[], ['feat: only one'], ['feat: one', 'fix: two']]) {
    const detection = detectCommitStyle(sample);
    assert.equal(detection.style, 'unknown');
    assert.equal(detection.confidence, 'none');
    assert.equal(detection.needsUserChoice, true);
    assert.ok(detection.sampleCount < MIN_COMMIT_STYLE_SAMPLES);
    assert.match(detection.reason, /at least 3/);
  }
});

test('detectCommitStyle asks the user when the sample is mixed', () => {
  const detection = detectCommitStyle([
    'feat: one',
    'fix: two',
    'Add three',
    'Explain four',
    'feat: five',
    'Fix five again',
  ]);
  assert.equal(detection.style, 'mixed');
  assert.equal(detection.confidence, 'low');
  assert.equal(detection.needsUserChoice, true);
  assert.match(detection.reason, /mixed/);
});

test('detectCommitStyle accepts a strong (80%) majority as the repository style', () => {
  const detection = detectCommitStyle(['feat: one', 'fix: two', 'docs: three', 'chore: four', 'plain sentence five']);
  assert.equal(detection.style, 'conventional');
  assert.equal(detection.confidence, 'medium');
  assert.equal(detection.needsUserChoice, false);
  assert.equal(detection.counts.conventional / detection.sampleCount, COMMIT_STYLE_DOMINANCE);
});

test('detectCommitStyle inherits Gitmoji and plain styles as well', () => {
  assert.equal(detectCommitStyle([':sparkles: one', ':bug: two', ':memo: three']).style, 'gitmoji');
  assert.equal(detectCommitStyle(['Add one', 'Fix two', 'Document three']).style, 'plain');
});

test('auto policy samples history first and never guesses without a sample', () => {
  const policy = resolveCommitStylePolicy();
  assert.equal(policy.style, 'auto');
  assert.equal(policy.source, 'pending-history');
  assert.equal(policy.needsUserChoice, false, 'the model samples history before asking');
  assert.match(policy.guidance, /jj_commit_style/);
  assert.match(policy.guidance, /inherit/i);
});

test('auto policy asks the user when the sample cannot decide', () => {
  const detection = detectCommitStyle(['feat: one']);
  const policy = resolveCommitStylePolicy({ detection });
  assert.equal(policy.style, 'auto');
  assert.equal(policy.source, 'needs-user-choice');
  assert.equal(policy.needsUserChoice, true);
  for (const choice of COMMIT_STYLE_CHOICES)
    assert.match(policy.guidance, new RegExp(choice.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(policy.guidance, /ask_user_question/);
});

test('an inconsistent mixed/unknown detection still asks the user instead of crashing', () => {
  const detection = {
    style: 'mixed',
    confidence: 'low',
    sampleCount: 4,
    counts: { conventional: 2, gitmoji: 1, plain: 1 },
    needsUserChoice: false,
    reason: 'inconsistent test double',
  } satisfies CommitStyleDetection;
  const policy = resolveCommitStylePolicy({ detection });
  assert.equal(policy.style, 'auto');
  assert.equal(policy.source, 'needs-user-choice');
  assert.equal(policy.needsUserChoice, true);
});

test('detected history resolves to the matching preset', () => {
  const detection = detectCommitStyle(['feat: one', 'fix: two', 'docs: three']);
  const policy = resolveCommitStylePolicy({ detection });
  assert.equal(policy.style, 'conventional');
  assert.equal(policy.source, 'history');
  assert.equal(policy.guidance, COMMIT_STYLE_PRESETS.conventional.guidance);
  assert.equal(policy.detection, detection);
});

test('a configured preset overrides history', () => {
  const detection = detectCommitStyle(['feat: one', 'fix: two', 'docs: three']);
  const policy = resolveCommitStylePolicy({ configured: 'angular', detection });
  assert.equal(policy.style, 'angular');
  assert.equal(policy.source, 'config');
  assert.equal(policy.needsUserChoice, false);
  assert.equal(policy.guidance, COMMIT_STYLE_PRESETS.angular.guidance);
});

test('custom style uses the configured rules verbatim and asks when they are missing', () => {
  const rules = 'Describe the change in lowercase Chinese, ending with a full stop.';
  const policy = resolveCommitStylePolicy({ configured: 'custom', customStyle: rules });
  assert.equal(policy.style, 'custom');
  assert.equal(policy.source, 'config');
  assert.equal(policy.needsUserChoice, false);
  assert.ok(policy.guidance.includes(rules));

  const missing = resolveCommitStylePolicy({ configured: 'custom', customStyle: '   ' });
  assert.equal(missing.needsUserChoice, true);
  assert.match(missing.guidance, /paste the style rules/i);
});

test('commitStylePromptText always carries the style policy and the split-commit workflow', () => {
  const text = commitStylePromptText();
  assert.ok(text.includes(resolveCommitStylePolicy().guidance));
  assert.ok(text.includes(SPLIT_COMMITS_GUIDANCE));
  assert.match(text, /jj_commit/);
  assert.match(text, /small, self-contained commits/);
  assert.match(text, /never use git commit/);

  const flat = commitStylePromptText({ preferSplitCommits: false });
  assert.ok(!flat.includes(SPLIT_COMMITS_GUIDANCE), 'split guidance can be disabled');
  assert.match(flat, /jj_commit_style/);
});

test('style constants stay internally consistent', () => {
  assert.deepEqual([...COMMIT_STYLE_IDS], ['auto', 'conventional', 'angular', 'gitmoji', 'plain', 'custom']);
  assert.deepEqual([...CONCRETE_COMMIT_STYLE_IDS], ['conventional', 'angular', 'gitmoji', 'plain']);
  for (const id of CONCRETE_COMMIT_STYLE_IDS) assert.equal(COMMIT_STYLE_PRESETS[id].id, id);
  assert.equal(COMMIT_STYLE_CHOICES.at(-1)?.id, 'custom');
  assert.equal(COMMIT_STYLE_CHOICES.length, CONCRETE_COMMIT_STYLE_IDS.length + 1);
  assert.ok(MIN_COMMIT_STYLE_SAMPLES >= 1 && COMMIT_STYLE_DOMINANCE <= 1);
});
