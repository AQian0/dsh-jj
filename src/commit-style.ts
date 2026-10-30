/**
 * Commit-description style handling: inherit the repository's conventions, ask the
 * user when history cannot decide, and support configured or custom styles.
 *
 * Policy (2026-10-30): descriptions default to the style already used by the
 * repository's recent jj/Git descriptions. When history is missing, thin, or mixed
 * the model is told to ask the user to choose a common convention (Conventional
 * Commits, Angular, Gitmoji, plain subjects) or provide a custom one. A configured
 * preset/custom style and an explicit instruction from the user always win over
 * history.
 *
 * The same module carries the companion commit-granularity guidance: work should
 * advance as a series of small, self-contained commits (`jj commit` / `jj new`)
 * instead of one growing working-copy change, because a single giant change is
 * hard for a human to review.
 *
 * This module is pure: no I/O, no subprocess, and no `@deepseek-ai/*` imports.
 * Callers feed it descriptions (typically from `jj log`) and read back
 * model-facing text.
 *
 * @module dsh-jj/commit-style
 */

/** Every accepted `commitStyle` configuration value. */
export const COMMIT_STYLE_IDS = ['auto', 'conventional', 'angular', 'gitmoji', 'plain', 'custom'] as const;

/** Configured description-style choice (the `auto` sentinel means "inherit history"). */
export type CommitStyleId = (typeof COMMIT_STYLE_IDS)[number];

/** Style presets that can be detected from history or configured directly. */
export const CONCRETE_COMMIT_STYLE_IDS = ['conventional', 'angular', 'gitmoji', 'plain'] as const;

/** A concrete preset id (everything except the `auto`/`custom` sentinels). */
export type ConcreteCommitStyleId = (typeof CONCRETE_COMMIT_STYLE_IDS)[number];

/** Description families that can be recognised from a sample of descriptions. */
export type CommitStyleFamily = 'conventional' | 'gitmoji' | 'plain';

/** Detection outcome; `mixed`/`unknown` mean history alone cannot decide. */
export type CommitStyleDetectionKind = CommitStyleFamily | 'mixed' | 'unknown';

/** Detection confidence (`none` means "no usable sample"). */
export type CommitStyleConfidence = 'high' | 'medium' | 'low' | 'none';

/** Per-family counts for one description sample. */
export interface CommitStyleCounts {
  readonly conventional: number;
  readonly gitmoji: number;
  readonly plain: number;
}

/** Result of classifying a sample of recent descriptions. */
export interface CommitStyleDetection {
  readonly style: CommitStyleDetectionKind;
  readonly confidence: CommitStyleConfidence;
  /** Non-empty first lines that were classified. */
  readonly sampleCount: number;
  readonly counts: CommitStyleCounts;
  /** True when the model must ask the user to pick a style before describing/committing. */
  readonly needsUserChoice: boolean;
  /** One-line explanation of the outcome (model-facing, English). */
  readonly reason: string;
}

/** Fewest non-empty descriptions required before inheriting a style. */
export const MIN_COMMIT_STYLE_SAMPLES = 3;

/** Share of the sample one family must cover before it counts as the repository style. */
export const COMMIT_STYLE_DOMINANCE = 0.8;

/** One model-facing style preset. */
export interface CommitStylePreset {
  readonly id: ConcreteCommitStyleId;
  /** Human/menu label, also used in the ask-the-user choices. */
  readonly label: string;
  /** One-line summary shown to the model (and in the choice list). */
  readonly summary: string;
  /** Full model-facing rules for this style. */
  readonly guidance: string;
}

/** The built-in presets. Angular and Conventional Commits share the same grammar. */
export const COMMIT_STYLE_PRESETS: Readonly<Record<ConcreteCommitStyleId, CommitStylePreset>> = {
  conventional: {
    id: 'conventional',
    label: 'Conventional Commits',
    summary: 'type(scope)!: subject with the conventional type list',
    guidance: [
      'Commit descriptions: follow Conventional Commits — `<type>(<optional scope>)!: <subject>` on the first line, then an optional body after one blank line.',
      '- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
      '- Subject: imperative mood, lowercase first letter, no trailing period, ~72 characters at most.',
      '- Scope: a short module/package name when it adds information.',
      '- Body: explain what changed and why (wrap ~72 columns); use footers such as `BREAKING CHANGE: <description>` and `Refs: <id>`.',
      "- Use the language (English, Chinese, …) of the repository's existing descriptions.",
    ].join('\n'),
  },
  angular: {
    id: 'angular',
    label: 'Angular convention',
    summary: 'type(scope): subject with the Angular type list and strict subject rules',
    guidance: [
      'Commit descriptions: follow the Angular commit convention — `<type>(<scope>): <subject>`.',
      '- Types: build, ci, docs, feat, fix, perf, refactor, style, test, chore, revert.',
      '- Scope: the affected package/module in lowercase; omit it only when the change is global.',
      '- Subject: imperative, lowercase first letter, no trailing period, <= 50 characters if possible.',
      '- Body: after one blank line, explain the motivation and the previous behavior.',
      '- Footers: `BREAKING CHANGE: <description>`, `Closes #<n>`, `Refs #<n>`.',
      "- Keep the language of the repository's existing descriptions.",
    ].join('\n'),
  },
  gitmoji: {
    id: 'gitmoji',
    label: 'Gitmoji',
    summary: ':sparkles: subject — an emoji/shortcode prefix for the change kind',
    guidance: [
      'Commit descriptions: follow Gitmoji — prefix the subject with a gitmoji shortcode (`:sparkles:`) or the emoji itself.',
      '- Common: :sparkles: feature, :bug: fix, :memo: docs, :recycle: refactor, :white_check_mark: tests, :wrench: config, :package: build, :zap: performance, :lipstick: UI, :fire: removal, :tada: initial commit.',
      '- Subject: short, imperative, no trailing period; add an optional scope in parentheses.',
      '- Body: after one blank line; explain why and keep the language of existing descriptions.',
    ].join('\n'),
  },
  plain: {
    id: 'plain',
    label: 'Plain subjects',
    summary: 'A short descriptive sentence with no prefix',
    guidance: [
      'Commit descriptions: use plain descriptive subjects — a short sentence that says what changed, without a `type:` prefix.',
      "- Match the capitalization, tense, and language of the repository's existing descriptions; no trailing period.",
      '- Keep the subject under ~72 characters; put the rationale in a body after one blank line.',
      '- When the repository uses issue ids, name them in the body rather than the subject.',
    ].join('\n'),
  },
};

/** One option in the "which style should we use?" question asked of the user. */
export interface CommitStyleChoice {
  readonly id: ConcreteCommitStyleId | 'custom';
  readonly label: string;
  readonly summary: string;
}

/** Choices offered when the history cannot determine a style (last is always "custom"). */
export const COMMIT_STYLE_CHOICES: readonly CommitStyleChoice[] = [
  {
    id: 'conventional',
    label: 'Conventional Commits',
    summary: 'feat(scope): subject — feat/fix/docs/refactor/test/chore/…',
  },
  {
    id: 'angular',
    label: 'Angular convention',
    summary: 'type(scope): subject with the Angular type list and strict subject rules',
  },
  { id: 'gitmoji', label: 'Gitmoji', summary: ':sparkles: subject — an emoji/shortcode prefix for the change kind' },
  { id: 'plain', label: 'Plain subjects', summary: 'A short descriptive sentence with no prefix' },
  { id: 'custom', label: 'Custom style', summary: 'The user pastes their own rules or an example description' },
];

/**
 * Guidance used while the style is still unknown: sample history first, and only
 * then ask the user.
 */
const PENDING_HISTORY_GUIDANCE = [
  "Commit descriptions: inherit this repository's existing style instead of inventing one.",
  'Before your first description or commit in this session, call jj_commit_style when the jj_* tools are installed: it samples recent jj/Git descriptions (including their bodies) and classifies their style. Without those tools, inspect recent descriptions with jj_log and copy their first-line grammar.',
  'Copy the existing grammar (type prefix, scope), capitalization, language, subject length, and — when the examples show them — body/footer habits; an explicit style instruction from the user always wins over the profile config and the history.',
  'If jj_commit_style reports needsUserChoice, ask the user before writing any description — do not guess.',
].join('\n');

/** Choice list rendered into the ask-the-user guidance. */
function choiceListText(): string {
  return COMMIT_STYLE_CHOICES.map((choice, index) => `${index + 1}. ${choice.label} — ${choice.summary}`).join('\n');
}

/** Guidance telling the model to stop and ask the user which style to use. */
function needsUserChoiceGuidance(reason: string): string {
  return [
    `Commit descriptions: the existing description history cannot decide a style (${reason}).`,
    'Do not describe or commit anything yet. Ask the user one concise question (use ask_user_question when available): which commit-description style should this repository use?',
    choiceListText(),
    'If the user chooses a custom style, ask them to paste the rules or an example description, then follow the chosen style exactly for the rest of the session and state which style you will use.',
  ].join('\n');
}

/** Guidance used when the config asks for a custom style but no rules were supplied. */
const EMPTY_CUSTOM_GUIDANCE = [
  'Commit descriptions: the profile selected a custom style but supplied no rules.',
  'Ask the user to paste the style rules or an example description, then follow them exactly for the rest of the session.',
].join('\n');

/** Companion guidance: keep work as a readable stack of small commits. */
export const SPLIT_COMMITS_GUIDANCE = [
  'Commit granularity: advance the work as a series of small, self-contained commits.',
  'After each coherent step (one feature, one bug fix, one refactor, one docs or test change), finish it with jj_commit (`jj commit -m "…"`), which describes the current change and starts a new empty working copy; use jj_squash only to fold small corrections into the previous commit.',
  'Do not accumulate a whole task in @ — one giant change is hard for humans to review. Split by concern, not by file, and explain the why in the description.',
  'Use jj_new only when starting an intentionally empty change, and never use git commit.',
].join('\n');

/** First line of a description, with trailing whitespace removed. */
export function firstDescriptionLine(description: string): string {
  const newline = description.search(/[\r\n]/);
  return (newline === -1 ? description : description.slice(0, newline)).trim();
}

/** Narrow a detection kind to a concrete family (`mixed`/`unknown` mean undecidable). */
function isCommitStyleFamily(style: CommitStyleDetectionKind): style is CommitStyleFamily {
  return style === 'conventional' || style === 'gitmoji' || style === 'plain';
}

/** Lowercase `type(scope)!: subject` — the Conventional/Angular grammar. */
const CONVENTIONAL_SUBJECT_RE = /^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S/u;

/** Leading `:shortcode:` or emoji character (Gitmoji). */
const GITMOJI_RE = /^(?::[a-z0-9_+-]+:|\p{Extended_Pictographic})/u;

/** Classify one first line; `undefined` for an empty description (root commit, undescribed change). */
export function classifyDescriptionStyle(description: string): CommitStyleFamily | undefined {
  const line = firstDescriptionLine(description);
  if (line.length === 0) return undefined;
  if (GITMOJI_RE.test(line)) return 'gitmoji';
  if (CONVENTIONAL_SUBJECT_RE.test(line)) return 'conventional';
  return 'plain';
}

/** Human label for one detected family. */
function familyLabel(family: CommitStyleFamily): string {
  return COMMIT_STYLE_PRESETS[family].label;
}

/**
 * Classify a sample of recent descriptions.
 *
 * Fewer than {@link MIN_COMMIT_STYLE_SAMPLES} non-empty descriptions, or no family
 * covering at least {@link COMMIT_STYLE_DOMINANCE} of them, yields a detection with
 * `needsUserChoice: true` so the caller asks the user instead of guessing.
 *
 * @param descriptions - recent descriptions, newest first (multiline allowed; only the first line is used).
 * @returns the detection, including per-family counts and a model-facing reason.
 */
export function detectCommitStyle(descriptions: readonly string[]): CommitStyleDetection {
  const counts = { conventional: 0, gitmoji: 0, plain: 0 };
  for (const description of descriptions) {
    const family = classifyDescriptionStyle(description);
    if (family !== undefined) counts[family] += 1;
  }
  const sampleCount = counts.conventional + counts.gitmoji + counts.plain;
  if (sampleCount < MIN_COMMIT_STYLE_SAMPLES) {
    return {
      style: 'unknown',
      confidence: 'none',
      sampleCount,
      counts,
      needsUserChoice: true,
      reason: `Only ${sampleCount} non-empty description${sampleCount === 1 ? '' : 's'} found; at least ${MIN_COMMIT_STYLE_SAMPLES} are needed to inherit a style.`,
    };
  }
  const ranked: ReadonlyArray<readonly [CommitStyleFamily, number]> = [
    ['conventional', counts.conventional],
    ['gitmoji', counts.gitmoji],
    ['plain', counts.plain],
  ];
  const [winner, winnerCount] = ranked.reduce((best, candidate) => (candidate[1] > best[1] ? candidate : best));
  const share = winnerCount / sampleCount;
  if (share >= COMMIT_STYLE_DOMINANCE) {
    return {
      style: winner,
      confidence: winnerCount === sampleCount ? 'high' : 'medium',
      sampleCount,
      counts,
      needsUserChoice: false,
      reason: `${winnerCount}/${sampleCount} recent descriptions match the ${familyLabel(winner)} style.`,
    };
  }
  return {
    style: 'mixed',
    confidence: 'low',
    sampleCount,
    counts,
    needsUserChoice: true,
    reason: `Recent descriptions are mixed (${counts.conventional} Conventional, ${counts.gitmoji} Gitmoji, ${counts.plain} plain); no style covers ${Math.round(COMMIT_STYLE_DOMINANCE * 100)}% of the sample.`,
  };
}

/** Where a resolved style came from. */
export type CommitStyleSource = 'config' | 'history' | 'needs-user-choice' | 'pending-history';

/** Resolved style policy handed to the model and the `jj_commit_style` tool. */
export interface CommitStylePolicy {
  /** Configured/detected style id; `auto` while the history has not been sampled or a choice is pending. */
  readonly style: CommitStyleId;
  readonly source: CommitStyleSource;
  /** Model-facing rules for writing descriptions. */
  readonly guidance: string;
  /** True when the model must ask the user to choose a style before describing/committing. */
  readonly needsUserChoice: boolean;
  /** Detection details when history was sampled. */
  readonly detection?: CommitStyleDetection;
}

/** Options for {@link resolveCommitStylePolicy}. */
export interface ResolveCommitStyleOptions {
  /** Profile `commitStyle`; defaults to `auto` (inherit the repository history). */
  readonly configured?: CommitStyleId;
  /** Profile `commitStyleCustom`; only meaningful with `commitStyle: 'custom'`. */
  readonly customStyle?: string;
  /** History sample result; omit while the style has not been sampled yet (prompt-context path). */
  readonly detection?: CommitStyleDetection;
}

/**
 * Resolve the effective style policy.
 *
 * Precedence: configured preset/custom style > detected history > ask the user.
 * Without a detection the policy stays pending and the model is told to sample
 * history first (prompt-context path, which cannot run jj synchronously).
 *
 * @param options - configured style, custom rules, and an optional detection.
 * @returns a policy with model-facing guidance and the ask-user flag.
 */
export function resolveCommitStylePolicy(options: ResolveCommitStyleOptions = {}): CommitStylePolicy {
  const configured = options.configured ?? 'auto';
  if (configured === 'custom') {
    const custom = (options.customStyle ?? '').trim();
    if (custom.length === 0) {
      return { style: 'custom', source: 'config', guidance: EMPTY_CUSTOM_GUIDANCE, needsUserChoice: true };
    }
    return {
      style: 'custom',
      source: 'config',
      guidance: `Commit descriptions: follow this user-defined style exactly (it overrides history and presets).\n${custom}`,
      needsUserChoice: false,
    };
  }
  if (configured !== 'auto') {
    return {
      style: configured,
      source: 'config',
      guidance: COMMIT_STYLE_PRESETS[configured].guidance,
      needsUserChoice: false,
    };
  }
  const detection = options.detection;
  if (detection === undefined) {
    return { style: 'auto', source: 'pending-history', guidance: PENDING_HISTORY_GUIDANCE, needsUserChoice: false };
  }
  if (detection.needsUserChoice || !isCommitStyleFamily(detection.style)) {
    return {
      style: 'auto',
      source: 'needs-user-choice',
      guidance: needsUserChoiceGuidance(detection.reason),
      needsUserChoice: true,
      detection,
    };
  }
  const style = detection.style;
  return {
    style,
    source: 'history',
    guidance: COMMIT_STYLE_PRESETS[style].guidance,
    needsUserChoice: false,
    detection,
  };
}

/** Options for {@link commitStylePromptText}. */
export interface CommitStylePromptOptions extends ResolveCommitStyleOptions {
  /**
   * Append the split-commit guidance (default true). Set `false` to leave commit
   * granularity entirely to the user.
   */
  readonly preferSplitCommits?: boolean;
}

/**
 * Model-facing guidance block: description style policy plus (by default) the
 * split-commit workflow.
 *
 * @param options - configured style, optional custom rules, optional detection, split preference.
 * @returns multi-line text; empty never.
 */
export function commitStylePromptText(options: CommitStylePromptOptions = {}): string {
  const policy = resolveCommitStylePolicy(options);
  const sections = [policy.guidance];
  if (options.preferSplitCommits !== false) sections.push(SPLIT_COMMITS_GUIDANCE);
  return sections.join('\n');
}
