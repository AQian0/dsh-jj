/**
 * Git/jj command classification (design contract §8.2 / §8.3 / §8.3b).
 *
 * This module is a barrel: the implementation lives in pure submodules
 * (`./git-tokenize.ts`, `./git-equivalence.ts`, `./git-rules.ts`,
 * `./jj-rules.ts`) and every previously exported name is re-exported here so
 * importers do not change.
 *
 * @module dsh-jj/git-command
 */

export { classifyGitInvocation, gitEquivalence, hasMutatingGitInvocation, GIT_SUBCOMMAND_RULES } from './git-rules.ts';
export type { GitCommandClassification, GitInvocation, ParsedSegment } from './git-rules.ts';
export { JJ_EQUIVALENCE } from './git-equivalence.ts';
export type { GitSafety, GitSafetySubtype } from './git-equivalence.ts';
export {
  classifyJjInvocation,
  JJ_READ_ONLY_SUBCOMMANDS,
  JJ_REPO_WIDE_SUBCOMMANDS,
  JJ_WORKSPACE_LOCAL_SUBCOMMANDS,
} from './jj-rules.ts';
export type { JjCommandClassification, JjInvocation, JjParsedSegment, JjScope } from './jj-rules.ts';
