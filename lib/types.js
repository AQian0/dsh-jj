/**
 * Shared vocabulary for first-class Jujutsu (jj) support in DeepSeek Harness.
 *
 * Types follow the design contract (§5.3) and add a few documented extras used
 * by the base layer (severity on notices, detection confidence, availability
 * flags). Pure declarations: no I/O, no subprocess.
 *
 * Terminology (jj 0.46): `jj root` is documented as a shortcut for
 * `jj workspace root`, so a jj "root" is a *workspace* root. `jjRoot` here is
 * the sniffed directory containing `.jj`; `jjWorkspaceRoot` is the workspace
 * root that `jj workspace list` reports for the workspace containing `cwd`.
 *
 * @module dsh-jj/types
 */
/** Human-readable one-liner for a repository family. */
export function describeVcsKind(kind) {
    switch (kind) {
        case 'git':
            return 'plain Git repository (no jj metadata)';
        case 'jj-colocated':
            return 'colocated Jujutsu (jj) + Git repository (`.jj` and `.git` in the same root)';
        case 'jj-native':
            return 'jj-native repository (`.jj` only; Git backend stored inside `.jj`)';
        case 'none':
            return 'not a repository';
    }
}
