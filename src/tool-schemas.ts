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
import type { VcsDescriptor } from './types.ts';

export function textRender(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

export const CHANGE_PROPERTIES = {
  changeId: { type: 'string', description: 'jj change id (stable across rewrites).', required: true },
  commitId: { type: 'string', description: 'Commit id of this change right now.', required: true },
  description: { type: 'string', description: 'Change description (may be empty).', required: true },
  empty: { type: 'boolean', description: 'True when the change has no content changes.', required: true },
  conflict: { type: 'boolean', description: 'True when the change contains conflicts (jj tracks them as first-class).', required: true },
  currentWorkingCopy: { type: 'boolean', description: 'True for the working-copy change @.', required: true },
  bookmarks: { type: 'array', description: 'Local bookmarks pointing at this change.', items: { type: 'string' }, required: true },
  author: { type: 'string', description: 'Author email.', required: true },
} as const;

export const CHANGE_SCHEMA = { type: 'object', additionalProperties: false, properties: CHANGE_PROPERTIES } as const;

export function workspaceFields(descriptor: VcsDescriptor): { kind: 'jj-colocated' | 'jj-native'; workspaceRoot: string; workspaceName: string } {
  return {
    kind: descriptor.kind === 'jj-colocated' ? 'jj-colocated' : 'jj-native',
    workspaceRoot: descriptor.root,
    workspaceName: descriptor.workspaceName ?? 'default',
  };
}

export interface ChangeView {
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly currentWorkingCopy: boolean;
  readonly bookmarks: string[];
  readonly author: string;
}

export function changeView(change: {
  changeId: string;
  commitId: string;
  description: string;
  empty: boolean;
  conflict: boolean;
  currentWorkingCopy: boolean;
  bookmarks: readonly string[];
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
    author: change.author,
  };
}

