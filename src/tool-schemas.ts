/**
 * Output schemas and pure result views for the `jj_*` tools (design contract §7).
 *
 * Data-only module: shared JSON-schema fragments, the pure `jj` change view used
 * by tools that return a change, the workspace identity fields, and the tiny
 * text renderer. It imports types only, so it cannot pull a DSH runtime
 * dependency into the tool surface.
 *
 * @module dsh-jj/tool-schemas
 */
import { isRewritableChange } from './jj-templates.ts';
import type { VcsDescriptor } from './types.ts';

/** One machine-readable follow-up a tool result recommends. */
export interface JjNextAction {
  /** `jj_*` tool name to call next. */
  readonly tool: string;
  /** Arguments to pass with it; omit when the defaults are already correct. */
  readonly args?: Readonly<Record<string, string | number | boolean>>;
  /** Why this is the next step, in one short sentence. */
  readonly reason: string;
}

/**
 * Shared `nextActions` output property.
 *
 * Tool results stay prose-free: instead of a paragraph of instructions they carry at most
 * a few concrete follow-up calls, so a client (or the model) can continue the flow without
 * re-reading documentation. Caps are enforced by the producers (`≤ 3`); the schema only
 * fixes the shape.
 */
export const NEXT_ACTIONS_SCHEMA = {
  type: 'array',
  description: 'Concrete follow-up tool calls this result recommends, at most three, most relevant first.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tool: { type: 'string', required: true },
      args: { type: 'object', additionalProperties: true },
      reason: { type: 'string', required: true },
    },
  },
} as const;

export function textRender(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

export const CHANGE_PROPERTIES = {
  changeId: { type: 'string', description: 'jj change id (stable across rewrites).', required: true },
  commitId: { type: 'string', description: 'Commit id of this change right now.', required: true },
  description: { type: 'string', description: 'Change description (may be empty).', required: true },
  empty: { type: 'boolean', description: 'True when the change has no content changes.', required: true },
  conflict: {
    type: 'boolean',
    description: 'True when the change contains conflicts (jj tracks them as first-class).',
    required: true,
  },
  currentWorkingCopy: { type: 'boolean', description: 'True for the working-copy change @.', required: true },
  bookmarks: {
    type: 'array',
    description: 'Local bookmarks pointing at this change.',
    items: { type: 'string' },
    required: true,
  },
  remoteBookmarks: {
    type: 'array',
    description:
      'Names of remote bookmarks pointing at this change; non-empty means the change is already published and must not be rewritten.',
    items: { type: 'string' },
    required: true,
  },
  rewritable: {
    type: 'boolean',
    description:
      'True while a correction may be folded into this change (jj_amend): no remote bookmark, trunk or tag reaches it. Local bookmarks do not close this window.',
    required: true,
  },
  author: { type: 'string', description: 'Author email.', required: true },
} as const;

export const CHANGE_SCHEMA = { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES } as const;

export function workspaceFields(descriptor: VcsDescriptor): {
  kind: 'jj-colocated' | 'jj-native';
  workspaceRoot: string;
  workspaceName: string;
} {
  return {
    kind: descriptor.kind === 'jj-colocated' ? 'jj-colocated' : 'jj-native',
    workspaceRoot: descriptor.root,
    workspaceName: descriptor.workspaceName ?? 'default',
  };
}

/** Model-facing view of one change record; the field set is declared once by {@link CHANGE_SCHEMA}. */
export interface ChangeView {
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly currentWorkingCopy: boolean;
  readonly bookmarks: string[];
  readonly remoteBookmarks: string[];
  readonly rewritable: boolean;
  readonly author: string;
}

/**
 * Project one change record onto the model-facing view declared by {@link CHANGE_SCHEMA}.
 *
 * @param change - a change record from the jj templates.
 * @returns the view, with `rewritable` derived from the publication window.
 */
export function changeView(change: {
  changeId: string;
  commitId: string;
  description: string;
  empty: boolean;
  conflict: boolean;
  currentWorkingCopy: boolean;
  bookmarks: readonly string[];
  immutable: boolean;
  remoteBookmarks: readonly string[];
  author: string;
}): ChangeView {
  return {
    changeId: change.changeId,
    commitId: change.commitId,
    description: change.description,
    empty: change.empty,
    conflict: change.conflict,
    currentWorkingCopy: change.currentWorkingCopy,
    bookmarks: [...change.bookmarks],
    remoteBookmarks: [...change.remoteBookmarks],
    rewritable: isRewritableChange(change),
    author: change.author,
  };
}
