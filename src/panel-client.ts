/**
 * Jujutsu panel — browser half (classic script, no module syntax).
 *
 * DSH serves third-party client plugins as **classic scripts** that register a lazy
 * CommonJS factory through `window.__ModuleLoader__.load({ id, factory })`. The id must
 * be this package's manifest name; the factory receives the host's frozen module
 * `require` (React, cordis, and optional shared client primitives) and returns the plugin
 * module. This file intentionally has no `import`/`export` statements so `tsc` emits it
 * unchanged as a valid classic-script bundle.
 *
 * The panel stays strictly read-only: it consumes `/api/jj.overview`, `/api/jj.refresh`
 * and `/api/jj.revision` (all backed by `--ignore-working-copy`) and aligns with DSH's
 * native sidebar design tokens (`--dsw-alias-*`, `--ds-font-family-code`, 38px pane
 * header, card/diff surfaces, and compact 24px tool disclosure rows).
 *
 * @module dsh-jj/panel-client
 */

// Everything lives inside one function scope. Classic scripts share the page's global
// lexical scope, so top-level `const`/`let` would collide when the host re-executes this
// bundle at a new revision (HMR / plugin upgrade): the second run throws
// "Identifier '…' has already been declared" before `__ModuleLoader__.load` runs, and
// the loader reports "loaded without registering". Function declarations would also
// leak onto `window` and clash with other plugins' globals.
(() => {
  /** Module id the host resolves the bundle under (must equal the package name). */
  const PANEL_BUNDLE_ID = '@aqian0/dsh-jj';
  /** Slot/tab key of the Jujutsu tab (unique inside this package). */
  const JJ_TAB_ID = 'jj-panel';
  /** Client locale namespace (dictionaries are registered below, not shipped as files). */
  const JJ_LOCALE_NS = 'jjPanel';

  /** Minimal React surface this bundle uses; the host provides React 18 at runtime. */
  interface ReactLike {
    createElement(type: unknown, props?: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown;
    useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  }

  /** The host's module factory signature. */
  type RequireFn = (id: string) => unknown;

  /** Structural view of the client plugin context (only what this bundle touches). */
  interface ClientContext {
    readonly slots?: {
      inject?(name: string, callback: () => unknown): unknown;
      register?(definition: Record<string, unknown>, component: unknown): unknown;
    };
    readonly sidebarRightTabs?: {
      register?(definition: Record<string, unknown>): unknown;
    };
    readonly locale?: {
      register?(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown;
      /** Bind a namespace to a `t(key)` function (the host exposes this on `ctx.locale`). */
      bind?(namespace: string): (key: string) => string;
    };
    effect?(body: () => unknown, label?: string): unknown;
  }

  /**
   * Translation dictionaries; both baselines are required by the client locale service.
   *
   * `zh` is the key-set source of truth and `en` must carry exactly the same keys; the
   * build test enforces that so a missing translation can never surface as a raw key in
   * either language. Only chrome copy lives here: jj's own operation/commit descriptions,
   * workspace names and paths are data and stay in the language jj or the user wrote them.
   */
  const DICTIONARIES: Record<string, Record<string, string>> = {
    zh: {
      title: 'Jujutsu 状态',
      guideDescription: '工作副本、栈、工作区与书签',
      refresh: '刷新',
      loading: '正在读取 jj 状态…',
      unavailable: '暂无可显示的内容。',
      failed: '读取 jj 状态失败。',
      workingCopy: '工作副本',
      noDescription: '（无描述）',
      empty: '空',
      conflict: '冲突',
      modified: '有改动',
      stale: '过期',
      stack: '栈',
      noStack: '没有待集成的提交。',
      workspaces: '工作区',
      current: '当前',
      bookmarks: '书签',
      noBookmarks: '没有书签。',
      operations: '操作日志',
      noOperations: '没有操作记录。',
      changeId: '变更',
      commitId: '提交',
      root: '路径',
      description: '描述',
      updated: '更新于',
      refreshing: '刷新中…',
      copy: '复制',
      copied: '已复制',
      retry: '重试',
      failedDetail: '原因',
      emptyHint: '这个会话的目录不在 jj 工作区里，或者 jj 服务不可用。',
      statusCard: '工作副本',
      logCard: '提交历史',
      workspacesCard: '工作区清单',
      handoffCard: '收尾集成',
      running: '执行中…',
      failedCall: '调用失败',
      noConflicts: '无冲突',
      conflictCount: '{count} 处冲突',
      revisionCount: '{count} 条修订',
      workspaceCount: '{count} 个工作区',
      moreItems: '另有 {count} 项',
      destination: '目标',
      diffStat: '改动统计',
      integration: '集成',
      nextAction: '下一步',
      truncated: '结果已截断',
      rebased: '已 rebase',
      alreadyIntegrated: '已集成',
      // Redesigned panel copy
      tabHistory: '提交',
      tabBookmarks: '书签',
      tabWorkspaces: '工作区',
      tabOperations: '日志',
      workingCopyEmpty: '工作副本为空',
      workingCopyFiles: '工作副本改动',
      basedOn: '基于',
      fileCount: '{count} 个文件',
      graphTitle: '提交图',
      scopeAll: '全部',
      scopeStack: '仅栈',
      publishedDivider: '已发布历史',
      noHistory: '没有可显示的提交记录。',
      rewritable: '可改写',
      immutable: '不可变',
      inspectRevision: '查看变更详情',
      back: '返回',
      revisionDetail: '变更详情',
      changedFiles: '改动文件',
      noChangedFiles: '此变更未改动任何文件。',
      author: '作者',
      time: '时间',
      parents: '父提交',
      loadingDetail: '正在读取变更详情…',
      loadingDiff: '正在读取差异…',
      binaryFile: '二进制文件，不显示文本差异。',
      emptyDiff: '此文件无文本行差异。',
      diffTruncated: '差异较长，已截断显示。',
      syncSynced: '已同步',
      syncAhead: '领先',
      syncBehind: '落后',
      syncDiverged: '已分叉',
      syncUnsynced: '未同步',
      syncLocalOnly: '仅本地',
      remoteOnlyBookmarks: '仅远端书签',
      sessionActive: '活跃会话',
      sessionIdle: '空闲会话',
      sessionOrphaned: '孤儿工作区',
      managedWorkspace: '托管',
      parallelSessionsNotice: '同仓库另有 {count} 个并行活跃会话',
      hideSnapshots: '隐藏快照',
      snapshot: '快照',
      opId: '操作 ID',
      user: '用户',
      tags: '标签',
      noFilteredOperations: '隐藏快照后没有其它操作记录。',
      justNow: '刚刚',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
      daysAgo: '{count} 天前',
      copyPath: '复制路径',
      copyChangeId: '复制变更 ID',
      copyCommitId: '复制提交 ID',
      copyOpId: '复制操作 ID',
      repoColocated: 'colocated',
      repoNative: 'native',
    },
    en: {
      title: 'Jujutsu status',
      guideDescription: 'Working copy, stack, workspaces and bookmarks',
      refresh: 'Refresh',
      loading: 'Reading jj status…',
      unavailable: 'Nothing to show.',
      failed: 'Could not read jj status.',
      workingCopy: 'Working copy',
      noDescription: '(no description)',
      empty: 'empty',
      conflict: 'conflict',
      modified: 'modified',
      stale: 'stale',
      stack: 'Stack',
      noStack: 'No commits to integrate.',
      workspaces: 'Workspaces',
      current: 'current',
      bookmarks: 'Bookmarks',
      noBookmarks: 'No bookmarks.',
      operations: 'Operations',
      noOperations: 'No operations.',
      changeId: 'change',
      commitId: 'commit',
      root: 'path',
      description: 'description',
      updated: 'updated',
      refreshing: 'Refreshing…',
      copy: 'copy',
      copied: 'copied',
      retry: 'Retry',
      failedDetail: 'reason',
      emptyHint: 'This session is not in a jj workspace, or the jj service is unavailable.',
      statusCard: 'Working copy',
      logCard: 'History',
      workspacesCard: 'Workspaces',
      handoffCard: 'Hand-off',
      running: 'Running…',
      failedCall: 'Call failed',
      noConflicts: 'no conflicts',
      conflictCount: '{count} conflicts',
      revisionCount: '{count} revisions',
      workspaceCount: '{count} workspaces',
      moreItems: '{count} more',
      destination: 'Destination',
      diffStat: 'Diff stat',
      integration: 'Integration',
      nextAction: 'Next step',
      truncated: 'Result truncated',
      rebased: 'rebased',
      alreadyIntegrated: 'already integrated',
      // Redesigned panel copy
      tabHistory: 'Graph',
      tabBookmarks: 'Bookmarks',
      tabWorkspaces: 'Workspaces',
      tabOperations: 'Ops',
      workingCopyEmpty: 'Working copy is empty',
      workingCopyFiles: 'Working copy changes',
      basedOn: 'on',
      fileCount: '{count} files',
      graphTitle: 'Commit graph',
      scopeAll: 'All',
      scopeStack: 'Stack',
      publishedDivider: 'Published history',
      noHistory: 'No revisions to show.',
      rewritable: 'rewritable',
      immutable: 'immutable',
      inspectRevision: 'Inspect revision',
      back: 'Back',
      revisionDetail: 'Revision detail',
      changedFiles: 'Changed files',
      noChangedFiles: 'No files changed in this revision.',
      author: 'Author',
      time: 'Time',
      parents: 'Parents',
      loadingDetail: 'Loading revision…',
      loadingDiff: 'Loading diff…',
      binaryFile: 'Binary file; text diff unavailable.',
      emptyDiff: 'No textual line changes.',
      diffTruncated: 'Diff truncated for display.',
      syncSynced: 'synced',
      syncAhead: 'ahead',
      syncBehind: 'behind',
      syncDiverged: 'diverged',
      syncUnsynced: 'unsynced',
      syncLocalOnly: 'local only',
      remoteOnlyBookmarks: 'Remote-only bookmarks',
      sessionActive: 'active',
      sessionIdle: 'idle',
      sessionOrphaned: 'orphaned',
      managedWorkspace: 'managed',
      parallelSessionsNotice: '{count} other active session(s) in this repo',
      hideSnapshots: 'Hide snapshots',
      snapshot: 'snapshot',
      opId: 'Op ID',
      user: 'User',
      tags: 'Tags',
      noFilteredOperations: 'No non-snapshot operations in this window.',
      justNow: 'just now',
      minutesAgo: '{count}m ago',
      hoursAgo: '{count}h ago',
      daysAgo: '{count}d ago',
      copyPath: 'Copy path',
      copyChangeId: 'Copy change ID',
      copyCommitId: 'Copy commit ID',
      copyOpId: 'Copy operation ID',
      repoColocated: 'colocated',
      repoNative: 'native',
    },
  };

  /** One changed file entry inside working copy or revision detail. */
  interface OverviewDiffFile {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
    readonly added: number;
    readonly removed: number;
    readonly conflict: boolean;
  }

  /** One change row as the Host sends it. */
  interface OverviewChange {
    readonly changeId: string;
    readonly shortestChangeId?: string;
    readonly commitId: string;
    readonly parents?: readonly string[];
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly currentWorkingCopy: boolean;
    readonly immutable?: boolean;
    readonly rewritable?: boolean;
    readonly bookmarks?: readonly string[];
    readonly remoteBookmarks?: readonly string[];
    readonly author?: string;
    readonly timestamp?: string;
    readonly inStack?: boolean;
  }

  /** One workspace row as the Host sends it. */
  interface OverviewWorkspace {
    readonly name: string;
    readonly root: string;
    readonly current: boolean;
    readonly changeId: string;
    readonly commitId?: string;
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly stale: 'yes' | 'no' | 'unknown';
    readonly managed?: boolean;
    readonly baseChangeId?: string;
    readonly sessionState?: 'active' | 'idle' | 'orphaned' | 'none';
  }

  /** One remote tracking entry on a local bookmark. */
  interface OverviewBookmarkRemote {
    readonly remote: string;
    readonly target?: string;
    readonly conflicted: boolean;
    readonly sync: 'synced' | 'ahead' | 'behind' | 'diverged' | 'unsynced';
  }

  /** One local bookmark row. */
  interface OverviewBookmark {
    readonly name: string;
    readonly target?: string;
    readonly conflicted: boolean;
    readonly targetChangeId?: string;
    readonly targetShortestChangeId?: string;
    readonly targetDescription?: string;
    readonly remotes?: readonly OverviewBookmarkRemote[];
  }

  /** One remote-only bookmark row. */
  interface OverviewRemoteBookmark {
    readonly name: string;
    readonly remote: string;
    readonly target?: string;
    readonly conflicted: boolean;
  }

  /** One operation row. */
  interface OverviewOperation {
    readonly id: string;
    readonly shortId: string;
    readonly description: string;
    readonly time: string;
    readonly user?: string;
    readonly workspaceName: string | null;
    readonly isSnapshot: boolean;
    readonly tags?: readonly string[];
  }

  /** The `/api/jj.overview` payload this bundle renders. */
  interface Overview {
    readonly enabled: boolean;
    readonly workspace?: {
      readonly kind: string;
      readonly root: string;
      readonly name: string;
      readonly jjVersion?: string;
    };
    readonly workingCopy?: {
      readonly changeId: string;
      readonly shortestChangeId?: string;
      readonly commitId: string;
      readonly description: string;
      readonly empty: boolean;
      readonly conflict: boolean;
      readonly immutable?: boolean;
      readonly rewritable?: boolean;
      readonly stale: 'yes' | 'no' | 'unknown';
      readonly parentCommitIds?: readonly string[];
      readonly files?: readonly OverviewDiffFile[];
      readonly totalAdded?: number;
      readonly totalRemoved?: number;
      readonly conflictFiles?: readonly string[];
    };
    readonly stack: readonly OverviewChange[];
    readonly history?: readonly OverviewChange[];
    readonly workspaces: readonly OverviewWorkspace[];
    readonly parallelActiveSessions?: number;
    readonly bookmarks: readonly OverviewBookmark[];
    readonly remoteOnlyBookmarks?: readonly OverviewRemoteBookmark[];
    readonly operations: readonly OverviewOperation[];
    readonly reason?: string;
  }

  /** Revision detail payload from `/api/jj.revision`. */
  interface RevisionDetailPayload {
    readonly enabled: boolean;
    readonly revision?: {
      readonly changeId: string;
      readonly shortestChangeId: string;
      readonly commitId: string;
      readonly parents: readonly string[];
      readonly description: string;
      readonly empty: boolean;
      readonly conflict: boolean;
      readonly currentWorkingCopy: boolean;
      readonly immutable: boolean;
      readonly rewritable: boolean;
      readonly bookmarks: readonly string[];
      readonly remoteBookmarks: readonly string[];
      readonly author: string;
      readonly authorEmail: string;
      readonly timestamp: string;
      readonly files: readonly OverviewDiffFile[];
      readonly totalAdded: number;
      readonly totalRemoved: number;
    };
    readonly reason?: string;
  }

  /** Single-file diff payload from `/api/jj.revision?file=…`. */
  interface FileDiffPayload {
    readonly enabled: boolean;
    readonly rev?: string;
    readonly path?: string;
    readonly oldPath?: string;
    readonly status?: string;
    readonly added?: number;
    readonly removed?: number;
    readonly binary?: boolean;
    readonly truncated?: boolean;
    readonly hunks?: readonly {
      readonly oldStart: number;
      readonly oldLines: number;
      readonly newStart: number;
      readonly newLines: number;
      readonly lines: readonly string[];
    }[];
    readonly reason?: string;
  }

  /** Slot props the framework composes for a session-scoped tab body. */
  interface TabProps {
    readonly sessionId?: unknown;
    readonly useSessions?: (selector: (state: unknown) => unknown) => unknown;
    readonly useSessionStatus?: (selector: (state: unknown) => unknown) => unknown;
    readonly t?: (key: string) => string;
  }

  /** Active primary tab in the Jujutsu sidebar panel. */
  type PanelTab = 'history' | 'bookmarks' | 'workspaces' | 'operations';

  /**
   * Panel styles, injected once per page. Every colour, radius, border and font comes from
   * the DSH design tokens (`--dsw-alias-*`, `--ds-font-family-code`, `--dsw-radius-*`),
   * matching DSH's own sidebar panels (`FilesBody`, `ForgeTab`, `ChangedFiles`, `FileDiff`).
   */
  const PANEL_STYLE_ID = 'dshjj-panel-style';
  const PANEL_CSS = `
.dshjj{container:dshjj / inline-size;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;background:var(--dsw-alias-bg-base)}
.dshjj *{box-sizing:border-box}
.dshjj-tab-title{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dshjj-tab-title-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dshjj-tab-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-head{display:flex;align-items:center;gap:6px;height:38px;padding:0 6px 0 14px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;min-width:0}
.dshjj-head-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dshjj-head-ws{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dshjj-head-kind{flex:none;font-size:10.5px;line-height:16px;padding:0 5px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-card-fill);color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace))}
.dshjj-head-end{display:inline-flex;align-items:center;gap:2px;margin-left:auto;flex:none}
.dshjj-updated{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;margin-right:2px}
@container dshjj (max-width:340px){.dshjj-updated{display:none}}
.dshjj-icon-btn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
.dshjj-icon-btn[data-size=sm]{width:24px;height:24px}
.dshjj-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
@media(hover:hover){.dshjj-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.dshjj-icon-btn:disabled{opacity:.5;cursor:default}
.dshjj-spin{animation:dshjj-rotate .8s linear infinite}
@keyframes dshjj-rotate{to{transform:rotate(360deg)}}
.dshjj-body{display:flex;flex-direction:column;gap:10px;padding:10px 12px 16px;overflow-y:auto;min-height:0;flex:1 1 auto;scrollbar-gutter:stable}
.dshjj-status{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-card-fill);min-width:0}
.dshjj-status-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshjj-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dshjj-dot[data-tone=business]{background:var(--dsw-alias-state-business-primary)}
.dshjj-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}
.dshjj-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.dshjj-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
.dshjj-status-btn{display:inline-flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshjj-status-btn:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs,4px)}
.dshjj-status-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dshjj-status-summary[data-tone=error]{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshjj-status-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:13px}
.dshjj-banner{display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));font-size:12px;line-height:17px}
.dshjj-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px;padding:3px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-card-fill);flex:none}
.dshjj-tab{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:0;height:26px;padding:0 6px;border:0;border-radius:calc(var(--dsw-radius-sm,8px) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:400;line-height:18px;cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
.dshjj-tab:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
@media(hover:hover){.dshjj-tab:hover:not([aria-selected=true]){color:var(--dsw-alias-label-primary)}}
.dshjj-tab[aria-selected=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 .5px 2px rgba(0,0,0,.08),0 0 0 .5px var(--dsw-alias-border-l2)}
.dshjj-tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-tab-cnt{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshjj-tab[aria-selected=true] .dshjj-tab-cnt{color:var(--dsw-alias-label-secondary)}
.dshjj-sec{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshjj-sec-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;min-height:24px}
.dshjj-sec-title{margin:0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:5px}
.dshjj-sec-cnt{color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}
.dshjj-pills{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-card-fill)}
.dshjj-pill-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;padding:2px 7px;border-radius:3px;cursor:pointer}
.dshjj-pill-btn[aria-pressed=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 .5px 1px rgba(0,0,0,.08)}
.dshjj-toggle-btn{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:16px;padding:3px 8px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer}
.dshjj-toggle-btn[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);color:var(--dsw-alias-state-business-primary)}
@media(hover:hover){.dshjj-toggle-btn:hover:not([aria-pressed=true]){background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-cid{font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11.5px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dshjj-cid-pre{color:var(--dsw-alias-state-business-primary);font-weight:600}
.dshjj-id{font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshjj-badge{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:var(--dsw-radius-xs,4px);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;flex:none}
.dshjj-badge[data-tone=business]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}
.dshjj-badge[data-tone=success]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.dshjj-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.dshjj-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dshjj-badge[data-tone=muted]{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}
.dshjj-added{color:var(--dsw-alias-state-success-primary);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11px;font-variant-numeric:tabular-nums}
.dshjj-removed{color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11px;font-variant-numeric:tabular-nums}
.dshjj-diff-counts{display:inline-flex;align-items:center;gap:5px;flex:none}
.dshjj-files-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:0}
.dshjj-files-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;background:var(--dsw-alias-card-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;text-align:left;cursor:pointer}
@media(hover:hover){.dshjj-files-head:hover{background:var(--dsw-alias-card-fill-hover)}}
.dshjj-files-head:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dshjj-files-list{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshjj-file-item{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshjj-file-item:last-child{border-bottom:0}
.dshjj-file-row{display:flex;align-items:center;gap:7px;width:100%;min-height:30px;padding:5px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;min-width:0}
@media(hover:hover){.dshjj-file-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-file-row[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dshjj-file-row:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dshjj-fstat{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;flex:none;border-radius:3px;font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:10px;font-weight:600}
.dshjj-fstat[data-status=added]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dshjj-fstat[data-status=modified]{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.dshjj-fstat[data-status=deleted]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dshjj-fstat[data-status=renamed],.dshjj-fstat[data-status=copied]{color:var(--dsw-alias-state-done-primary,var(--dsw-alias-state-business-primary));background:color-mix(in srgb,var(--dsw-alias-state-done-primary,var(--dsw-alias-state-business-primary)) 12%,transparent)}
.dshjj-fstat[data-conflict=true]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dshjj-fpath{display:flex;align-items:baseline;gap:5px;flex:1;min-width:0;overflow:hidden}
.dshjj-fname{color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;max-width:65%}
.dshjj-fdir{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dshjj-diff-box{border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);overflow-x:auto;font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11px;line-height:18px}
.dshjj-diff-note{padding:8px 12px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family,inherit);font-size:11.5px}
.dshjj-diff-hunk{padding:2px 10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-card-fill);font-size:10.5px;border-top:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshjj-diff-line{display:grid;grid-template-columns:34px 34px 14px minmax(0,1fr);min-width:max-content;width:100%}
.dshjj-diff-num{padding:0 5px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none;font-variant-numeric:tabular-nums}
.dshjj-diff-sign{text-align:center;user-select:none;color:var(--dsw-alias-label-tertiary)}
.dshjj-diff-text{padding:0 10px 0 2px;white-space:pre;color:var(--dsw-alias-label-secondary)}
.dshjj-diff-line[data-kind=add]{background:var(--dsw-alias-file-diff-added-bg,color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent))}
.dshjj-diff-line[data-kind=add] .dshjj-diff-num{background:var(--dsw-alias-file-diff-added-gutter,transparent);color:var(--dsw-alias-file-diff-added-marker,var(--dsw-alias-state-success-primary))}
.dshjj-diff-line[data-kind=add] .dshjj-diff-num:first-child{box-shadow:inset 2.5px 0 0 var(--dsw-alias-file-diff-added-marker,var(--dsw-alias-state-success-primary))}
.dshjj-diff-line[data-kind=add] .dshjj-diff-sign,.dshjj-diff-line[data-kind=add] .dshjj-diff-text{color:var(--dsw-alias-label-primary)}
.dshjj-diff-line[data-kind=add] .dshjj-diff-sign{color:var(--dsw-alias-file-diff-added-marker,var(--dsw-alias-state-success-primary))}
.dshjj-diff-line[data-kind=del]{background:var(--dsw-alias-file-diff-deleted-bg,color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent))}
.dshjj-diff-line[data-kind=del] .dshjj-diff-num{background:var(--dsw-alias-file-diff-deleted-gutter,transparent);color:var(--dsw-alias-file-diff-deleted-marker,var(--dsw-alias-state-error-primary))}
.dshjj-diff-line[data-kind=del] .dshjj-diff-num:first-child{box-shadow:inset 2.5px 0 0 var(--dsw-alias-file-diff-deleted-marker,var(--dsw-alias-state-error-primary))}
.dshjj-diff-line[data-kind=del] .dshjj-diff-sign{color:var(--dsw-alias-file-diff-deleted-marker,var(--dsw-alias-state-error-primary))}
.dshjj-diff-line[data-kind=del] .dshjj-diff-text{color:var(--dsw-alias-label-primary)}
.dshjj-graph-list{display:flex;flex-direction:column;min-width:0}
.dshjj-divider{display:flex;align-items:center;gap:8px;padding:6px 4px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshjj-divider::before,.dshjj-divider::after{content:'';flex:1;height:.5px;background:var(--dsw-alias-border-l2)}
.dshjj-grow{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:6px;min-width:0}
.dshjj-rail-col{display:flex;flex-direction:column;align-items:center;position:relative}
.dshjj-rail-top{width:1.5px;height:11px;background:var(--dsw-alias-border-l3);flex:none}
.dshjj-rail-top[data-hidden=true]{background:transparent}
.dshjj-rail-bot{width:1.5px;flex:1;min-height:8px;background:var(--dsw-alias-border-l3)}
.dshjj-rail-bot[data-hidden=true]{background:transparent}
.dshjj-node{width:10px;height:10px;border-radius:50%;flex:none;display:grid;place-items:center;border:1.75px solid var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dshjj-node[data-has-dot=true]::after{content:'';width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.dshjj-node[data-kind=current]{width:11px;height:11px;border-color:var(--dsw-alias-state-business-primary)}
.dshjj-node[data-kind=current][data-has-dot=true]::after{background:var(--dsw-alias-state-business-primary)}
.dshjj-node[data-kind=immutable]{width:7px;height:7px;border-radius:1.5px;transform:rotate(45deg);border:0;background:var(--dsw-alias-label-tertiary);margin:1.5px 0}
.dshjj-node[data-kind=conflict]{width:11px;height:11px;border-color:var(--dsw-alias-state-error-primary)}
.dshjj-node[data-kind=conflict]::after{content:'';width:4.5px;height:4.5px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
.dshjj-commit{display:flex;align-items:flex-start;gap:4px;min-width:0;padding:5px 6px 6px 8px;border-radius:var(--dsw-radius-sm,8px);transition:background-color 100ms ease}
@media(hover:hover){.dshjj-commit:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-commit-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshjj-commit-main:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs,4px)}
.dshjj-commit-top{display:flex;align-items:center;gap:5px;min-width:0}
.dshjj-desc{font-size:12.5px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.dshjj-desc[data-muted=true]{color:var(--dsw-alias-label-tertiary);font-weight:400;font-style:italic}
.dshjj-commit-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshjj-meta-sep{color:var(--dsw-alias-border-l4)}
.dshjj-author{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-hover-act{opacity:0;transition:opacity 120ms ease}
.dshjj-commit:hover .dshjj-hover-act,.dshjj-bm-row:hover .dshjj-hover-act,.dshjj-hover-act:focus-visible{opacity:1}
@media(hover:none){.dshjj-hover-act{opacity:1}}
.dshjj-list-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:0}
.dshjj-bm-row{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);min-width:0}
.dshjj-bm-row:last-child{border-bottom:0}
@media(hover:hover){.dshjj-bm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-bm-btn{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshjj-bm-btn:disabled{cursor:default}
.dshjj-bm-btn:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs,4px)}
.dshjj-bm-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshjj-bm-name{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace))}
.dshjj-bm-sub{display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshjj-bm-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);min-width:0;flex:1}
.dshjj-ws-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:7px;min-width:0}
.dshjj-ws-card[data-current=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.dshjj-ws-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshjj-ws-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-ws-path{display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace))}
.dshjj-ws-path-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-ws-change{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-card-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;min-width:0}
@media(hover:hover){.dshjj-ws-change:hover{background:var(--dsw-alias-card-fill-hover)}}
.dshjj-ws-change:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshjj-op-item{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshjj-op-item:last-child{border-bottom:0}
.dshjj-op-row{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;min-width:0}
@media(hover:hover){.dshjj-op-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-op-row:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dshjj-op-desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dshjj-op-desc[data-snapshot=true]{color:var(--dsw-alias-label-tertiary)}
.dshjj-op-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshjj-op-detail{display:flex;flex-direction:column;gap:4px;padding:6px 10px 10px 10px;background:var(--dsw-alias-card-fill);border-top:.5px solid var(--dsw-alias-border-l1);font-size:11.5px}
.dshjj-detail-bar{display:flex;align-items:center;gap:6px;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}
.dshjj-back-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px 0 4px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;flex:none}
@media(hover:hover){.dshjj-back-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.dshjj-back-btn:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshjj-detail-msg{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.dshjj-detail-msg[data-muted=true]{color:var(--dsw-alias-label-tertiary);font-style:italic}
.dshjj-meta-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-card-fill);min-width:0}
.dshjj-kv{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px}
.dshjj-k{color:var(--dsw-alias-label-tertiary);font-size:11.5px;min-width:52px;flex:none}
.dshjj-v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dshjj-v[data-mono=true]{font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11.5px}
.dshjj-parent-btn{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-business-primary);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11px;padding:1px 6px;border-radius:var(--dsw-radius-xs,4px);cursor:pointer}
@media(hover:hover){.dshjj-parent-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-btn{border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,8px);font:inherit;font-size:12px;font-weight:500;padding:4px 10px;cursor:pointer;line-height:18px}
.dshjj-btn:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
@media(hover:hover){.dshjj-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0;padding:8px 2px}
.dshjj-skel-stack{display:flex;flex-direction:column;gap:8px;padding:4px 0}
.dshjj-skel{height:14px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-card-fill));animation:dshjj-pulse 1.4s ease-in-out infinite}
.dshjj-skel[data-lg=true]{height:42px;border-radius:var(--dsw-radius-sm,8px)}
@keyframes dshjj-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.dshjj-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:44px 20px;text-align:center;color:var(--dsw-alias-label-primary)}
.dshjj-empty-icon{width:40px;height:40px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-card-fill);border:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dshjj-error{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:var(--dsw-alias-card-fill);border-radius:var(--dsw-radius-md,12px);padding:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.dshjj-error-title{color:var(--dsw-alias-state-error-primary);font-weight:500;display:inline-flex;align-items:center;gap:6px}
.dshjj-tool-row{display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.dshjj-tool-row-title{flex:none;color:inherit}
.dshjj-tool-collapsed{display:inline-flex;align-items:center;flex:1 1 auto;min-width:0;overflow:hidden}
.dshjj-tool-sep{display:inline-block;flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption);margin:0 8px}
.dshjj-tool-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.dshjj-tool-summary[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dshjj-tool-detail{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px 22px;min-width:0}
.dshjj-tool-dkv{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px}
.dshjj-tool-dk{flex:none;min-width:64px;color:var(--dsw-alias-label-tertiary)}
.dshjj-tool-dv{min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-tool-raw{max-height:180px;margin:2px 0 0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
@media(pointer:coarse){.dshjj-file-row,.dshjj-op-row{min-height:40px}.dshjj-icon-btn{width:34px;height:34px}}
`;

  /** Structural view of the page globals the style injection needs (no DOM lib here). */
  interface PanelDom {
    getElementById(id: string): unknown;
    createElement(tag: string): { id: string; textContent: string };
    head?: { appendChild(node: unknown): void };
  }

  /**
   * Inject the panel stylesheet once; a missing DOM (tests) is a no-op. An element left by
   * an earlier revision of this bundle (HMR / upgrade) is refreshed so CSS changes apply.
   */
  function ensurePanelStyles(): void {
    const doc = (globalThis as { document?: PanelDom }).document;
    if (doc === undefined || typeof doc.createElement !== 'function' || doc.head === undefined) return;
    try {
      const existing = doc.getElementById(PANEL_STYLE_ID) as { textContent: string } | null;
      if (existing !== null) {
        if (existing.textContent !== PANEL_CSS) existing.textContent = PANEL_CSS;
        return;
      }
      const style = doc.createElement('style');
      style.id = PANEL_STYLE_ID;
      style.textContent = PANEL_CSS;
      doc.head.appendChild(style);
    } catch {
      // Styling is cosmetic: a blocked <style> must not blank the panel.
    }
  }

  /** React implementation captured from the host module factory. */
  let ReactImpl: ReactLike | undefined;

  /** Host module `require` captured from the bundle factory (used lazily for tool-row primitives). */
  let hostRequire: RequireFn | undefined;

  /** Cached `@deepseek-ai/dsh-client-ui-primitives` module, resolved on first tool render. */
  let primitivesModule: Record<string, unknown> | undefined;
  /** Whether the lazy primitives lookup above already ran (regardless of its outcome). */
  let primitivesResolved = false;

  /** Forget the lazy primitives lookup; a bundle materialization always starts fresh. */
  function resetHostModules(): void {
    primitivesResolved = false;
    primitivesModule = undefined;
  }

  /**
   * Resolve the shell's shared UI primitives lazily for the compact chat tool rows.
   *
   * @returns the primitives module, or `undefined` when this host does not provide it.
   */
  function hostPrimitives(): Record<string, unknown> | undefined {
    if (!primitivesResolved) {
      primitivesResolved = true;
      if (hostRequire !== undefined) {
        try {
          primitivesModule = recordOf(hostRequire('@deepseek-ai/dsh-client-ui-primitives'));
        } catch {
          primitivesModule = undefined;
        }
      }
    }
    return primitivesModule;
  }

  /** Create one element (the bundle cannot use JSX: it is a classic script). */
  function h(type: unknown, props?: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown {
    return ReactImpl?.createElement(type, props, ...children);
  }

  /** Short change/commit id for display. */
  function shortId(id: string, length = 8): string {
    return id.length > length ? id.slice(0, length) : id;
  }

  /** Fill the `{count}` placeholder of a localized count template. */
  function countText(template: string, count: number): string {
    return template.replace('{count}', String(count));
  }

  /** Local wall-clock time of an ISO timestamp (best effort, never throws). */
  function timeOf(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** Full local date-time string for detail tooltips and expanded records. */
  function dateTimeOf(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /** Human-friendly relative timestamp (`just now`, `5m ago`, `2d ago`). */
  function relativeTimeOf(iso: string, t: (key: string) => string): string {
    if (iso.length === 0) return '';
    const date = new Date(iso);
    const ms = date.getTime();
    if (Number.isNaN(ms)) return iso;
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return t('justNow');
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return countText(t('minutesAgo'), diffMin);
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return countText(t('hoursAgo'), diffHr);
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return countText(t('daysAgo'), diffDay);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /** Split a workspace-relative path into basename and muted directory prefix. */
  function splitPath(path: string): { readonly name: string; readonly dir: string } {
    const slash = path.lastIndexOf('/');
    if (slash < 0) return { name: path, dir: '' };
    return { name: path.slice(slash + 1), dir: path.slice(0, slash) };
  }

  /** Minimal monochrome SVG wrapper matching DSH's 14–16px stroke glyphs. */
  function svgIcon(size: number, children: readonly unknown[], extraClass?: string): unknown {
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.45,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...(extraClass !== undefined ? { className: extraClass } : {}),
      },
      ...children,
    );
  }

  /** Monochrome Jujutsu branch-and-node glyph echoing the package icon. */
  function iconJj(size = 15): unknown {
    return svgIcon(size, [
      h('path', { d: 'M4.5 5v4.5a2.5 2.5 0 0 0 2.5 2.5h2.5', key: 'p1' }),
      h('circle', { cx: 4.5, cy: 3.5, r: 1.5, key: 'c1' }),
      h('circle', { cx: 11.5, cy: 12, r: 1.5, key: 'c2' }),
      h('path', { d: 'M11.5 5v3', key: 'p2' }),
      h('circle', { cx: 11.5, cy: 3.5, r: 1.25, key: 'c3' }),
    ]);
  }

  function iconRefresh(size = 14, spinning = false): unknown {
    return svgIcon(
      size,
      [h('path', { d: 'M13.2 8A5.2 5.2 0 1 1 11.7 4.3', key: 'p1' }), h('path', { d: 'M12.2 2.2v2.4H9.8', key: 'p2' })],
      spinning ? 'dshjj-spin' : undefined,
    );
  }

  function iconCopy(size = 13): unknown {
    return svgIcon(size, [
      h('rect', { x: 5.5, y: 5.5, width: 7.5, height: 7.5, rx: 1.5, key: 'r1' }),
      h('path', { d: 'M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5', key: 'p1' }),
    ]);
  }

  function iconCheck(size = 13): unknown {
    return svgIcon(size, [h('path', { d: 'M3.2 8.3 6.5 11.5 12.8 4.8', key: 'p1' })]);
  }

  function iconChevron(size = 12, open = false): unknown {
    return svgIcon(size, [
      h('path', {
        d: open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4',
        key: 'p1',
      }),
    ]);
  }

  function iconArrowLeft(size = 14): unknown {
    return svgIcon(size, [
      h('path', { d: 'M12.5 8H3.5', key: 'p1' }),
      h('path', { d: 'M7.2 4.3 3.5 8l3.7 3.7', key: 'p2' }),
    ]);
  }

  function iconBookmark(size = 13): unknown {
    return svgIcon(size, [
      h('path', { d: 'M4 2.5h8a.8.8 0 0 1 .8.8v10.2L8 10.7 3.2 13.5V3.3a.8.8 0 0 1 .8-.8Z', key: 'p1' }),
    ]);
  }

  function iconWorkspace(size = 13): unknown {
    return svgIcon(size, [
      h('path', {
        d: 'M2.2 4.3a1 1 0 0 1 1-1h3l1.3 1.4h5.3a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V4.3Z',
        key: 'p1',
      }),
    ]);
  }

  function iconAlert(size = 14): unknown {
    return svgIcon(size, [
      h('path', { d: 'M8 2.5 14 13H2L8 2.5Z', key: 'p1' }),
      h('path', { d: 'M8 6.3v3', key: 'p2' }),
      h('circle', { cx: 8, cy: 11.2, r: 0.4, fill: 'currentColor', key: 'c1' }),
    ]);
  }

  /** One subtle DSH badge. */
  function badge(
    text: string,
    tone: 'business' | 'success' | 'warn' | 'error' | 'muted' = 'muted',
    key?: string,
  ): unknown {
    return h('span', { className: 'dshjj-badge', 'data-tone': tone, ...(key !== undefined ? { key } : {}) }, text);
  }

  /** Render a jj change ID with its unique shortest prefix highlighted in accent ink. */
  function ChangeIdText(changeId: string, shortest?: string, length = 8): unknown {
    const shown = shortId(changeId, length);
    const prefix =
      shortest !== undefined && shortest.length > 0 && shown.startsWith(shortest)
        ? shortest
        : shown.slice(0, Math.min(2, shown.length));
    const rest = shown.slice(prefix.length);
    return h(
      'span',
      { className: 'dshjj-cid', title: changeId },
      h('span', { className: 'dshjj-cid-pre' }, prefix),
      rest,
    );
  }

  /** Render `+added -removed` tabular diff counts. */
  function diffCounts(added: number, removed: number): unknown {
    if (added === 0 && removed === 0) return null;
    return h(
      'span',
      { className: 'dshjj-diff-counts' },
      added > 0 ? h('span', { className: 'dshjj-added' }, `+${String(added)}`) : null,
      removed > 0 ? h('span', { className: 'dshjj-removed' }, `-${String(removed)}`) : null,
    );
  }

  /** Icon copy button with brief checkmark feedback (never throws without clipboard API). */
  function CopyIconButton(props: {
    readonly text: string;
    readonly label: string;
    readonly copiedLabel: string;
    readonly hoverOnly?: boolean;
  }): unknown {
    const [copied, setCopied] = ReactImpl?.useState(false) ?? [false, () => {}];
    const copy = (event?: { stopPropagation?: () => void }): void => {
      event?.stopPropagation?.();
      const clipboard = (globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } })
        .navigator?.clipboard;
      if (clipboard === undefined) return;
      void clipboard.writeText(props.text).then(
        () => {
          setCopied(true);
          const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
          timer?.(() => setCopied(false), 1500);
        },
        () => undefined,
      );
    };
    return h(
      'button',
      {
        type: 'button',
        className: props.hoverOnly === true ? 'dshjj-icon-btn dshjj-hover-act' : 'dshjj-icon-btn',
        'data-size': 'sm',
        onClick: copy,
        title: copied ? props.copiedLabel : props.label,
        'aria-label': copied ? props.copiedLabel : props.label,
      },
      copied ? iconCheck(13) : iconCopy(13),
    );
  }

  /** One single-letter file status marker (`A` / `M` / `D` / `R` / `C` / `!`). */
  function fileStatusLetter(file: OverviewDiffFile): string {
    if (file.conflict) return '!';
    switch (file.status) {
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'copied':
        return 'C';
      default:
        return 'M';
    }
  }

  /**
   * Inline read-only unified diff viewer for one file of one revision.
   *
   * Fetches `/api/jj.revision?cwd=…&rev=…&file=…` on mount and renders numbered diff
   * lines with DSH's `--dsw-alias-file-diff-*` tokens.
   */
  function InlineFileDiff(props: {
    readonly cwd: string;
    readonly rev: string;
    readonly path: string;
    readonly t: (key: string) => string;
  }): unknown {
    const [diff, setDiff] = ReactImpl?.useState<FileDiffPayload | undefined>(undefined) ?? [undefined, () => {}];
    const [error, setError] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];

    ReactImpl?.useEffect(() => {
      let alive = true;
      setDiff(undefined);
      setError(undefined);
      const url = `api/jj.revision?cwd=${encodeURIComponent(props.cwd)}&rev=${encodeURIComponent(props.rev)}&file=${encodeURIComponent(props.path)}`;
      void fetch(url, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((payload: unknown) => {
          if (alive) setDiff(payload as FileDiffPayload);
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        alive = false;
      };
    }, [props.cwd, props.rev, props.path]);

    if (error !== undefined) {
      return h(
        'div',
        { className: 'dshjj-diff-box' },
        h('div', { className: 'dshjj-diff-note' }, `${props.t('failedDetail')}: ${error}`),
      );
    }
    if (diff === undefined) {
      return h(
        'div',
        { className: 'dshjj-diff-box' },
        h('div', { className: 'dshjj-diff-note' }, props.t('loadingDiff')),
      );
    }
    if (diff.reason !== undefined) {
      return h('div', { className: 'dshjj-diff-box' }, h('div', { className: 'dshjj-diff-note' }, diff.reason));
    }
    if (diff.binary === true) {
      return h(
        'div',
        { className: 'dshjj-diff-box' },
        h('div', { className: 'dshjj-diff-note' }, props.t('binaryFile')),
      );
    }
    const hunks = diff.hunks ?? [];
    if (hunks.length === 0) {
      return h(
        'div',
        { className: 'dshjj-diff-box' },
        h('div', { className: 'dshjj-diff-note' }, props.t('emptyDiff')),
      );
    }

    const rows: unknown[] = [];
    for (let hIdx = 0; hIdx < hunks.length; hIdx += 1) {
      const hunk = hunks[hIdx]!;
      rows.push(
        h(
          'div',
          { className: 'dshjj-diff-hunk', key: `h-${String(hIdx)}` },
          `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
        ),
      );
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (let lIdx = 0; lIdx < hunk.lines.length; lIdx += 1) {
        const raw = hunk.lines[lIdx]!;
        const prefix = raw.slice(0, 1);
        const text = raw.slice(1);
        const kind = prefix === '+' ? 'add' : prefix === '-' ? 'del' : 'ctx';
        const leftNum = kind === 'add' ? '' : String(oldNo++);
        const rightNum = kind === 'del' ? '' : String(newNo++);
        rows.push(
          h(
            'div',
            { className: 'dshjj-diff-line', 'data-kind': kind, key: `l-${String(hIdx)}-${String(lIdx)}` },
            h('span', { className: 'dshjj-diff-num' }, leftNum),
            h('span', { className: 'dshjj-diff-num' }, rightNum),
            h('span', { className: 'dshjj-diff-sign' }, prefix === ' ' ? '' : prefix),
            h('span', { className: 'dshjj-diff-text' }, text),
          ),
        );
      }
    }
    if (diff.truncated === true) {
      rows.push(h('div', { className: 'dshjj-diff-note', key: 'trunc' }, props.t('diffTruncated')));
    }
    return h('div', { className: 'dshjj-diff-box' }, ...rows);
  }

  /**
   * Reusable DSH-styled changed-files card with click-to-expand inline unified diffs.
   */
  function DiffFilesCard(props: {
    readonly title: string;
    readonly cwd: string;
    readonly rev: string;
    readonly files: readonly OverviewDiffFile[];
    readonly totalAdded: number;
    readonly totalRemoved: number;
    readonly defaultOpen?: boolean;
    readonly t: (key: string) => string;
  }): unknown {
    const [open, setOpen] = ReactImpl?.useState(props.defaultOpen !== false) ?? [true, () => {}];
    const [expandedPath, setExpandedPath] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];

    return h(
      'section',
      { className: 'dshjj-files-card' },
      h(
        'button',
        {
          type: 'button',
          className: 'dshjj-files-head',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
        iconChevron(12, open),
        h(
          'span',
          { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          props.title,
        ),
        diffCounts(props.totalAdded, props.totalRemoved),
        h('span', { className: 'dshjj-sec-cnt' }, countText(props.t('fileCount'), props.files.length)),
      ),
      open
        ? h(
            'div',
            { className: 'dshjj-files-list' },
            props.files.map((file) => {
              const isExpanded = expandedPath === file.path;
              const parts = splitPath(file.path);
              return h(
                'div',
                { className: 'dshjj-file-item', key: file.path },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshjj-file-row',
                    'aria-expanded': isExpanded,
                    title: file.path,
                    onClick: () => setExpandedPath(isExpanded ? undefined : file.path),
                  },
                  h(
                    'span',
                    { className: 'dshjj-fstat', 'data-status': file.status, 'data-conflict': file.conflict },
                    fileStatusLetter(file),
                  ),
                  h(
                    'span',
                    { className: 'dshjj-fpath' },
                    h('span', { className: 'dshjj-fname' }, parts.name),
                    parts.dir.length > 0 ? h('span', { className: 'dshjj-fdir' }, parts.dir) : null,
                  ),
                  file.conflict ? badge(props.t('conflict'), 'error') : diffCounts(file.added, file.removed),
                  h(
                    'span',
                    { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)' } },
                    iconChevron(11, isExpanded),
                  ),
                ),
                isExpanded ? h(InlineFileDiff, { cwd: props.cwd, rev: props.rev, path: file.path, t: props.t }) : null,
              );
            }),
          )
        : null,
    );
  }

  /**
   * Drill-in Revision Inspector view: full multi-line description, metadata, clickable
   * parents, and changed files with inline unified diffs.
   */
  function RevisionInspector(props: {
    readonly cwd: string;
    readonly rev: string;
    readonly onBack: () => void;
    readonly onSelectRev: (rev: string) => void;
    readonly t: (key: string) => string;
  }): unknown {
    const [detail, setDetail] = ReactImpl?.useState<RevisionDetailPayload | undefined>(undefined) ?? [
      undefined,
      () => {},
    ];
    const [error, setError] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];

    ReactImpl?.useEffect(() => {
      let alive = true;
      setDetail(undefined);
      setError(undefined);
      const url = `api/jj.revision?cwd=${encodeURIComponent(props.cwd)}&rev=${encodeURIComponent(props.rev)}`;
      void fetch(url, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((payload: unknown) => {
          if (alive) setDetail(payload as RevisionDetailPayload);
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        alive = false;
      };
    }, [props.cwd, props.rev]);

    const rev = detail?.revision;
    const headerBar = h(
      'div',
      { className: 'dshjj-detail-bar' },
      h(
        'button',
        { type: 'button', className: 'dshjj-back-btn', onClick: props.onBack },
        iconArrowLeft(14),
        props.t('back'),
      ),
      rev !== undefined
        ? ChangeIdText(rev.changeId, rev.shortestChangeId, 10)
        : h('span', { className: 'dshjj-id' }, shortId(props.rev, 10)),
      rev?.currentWorkingCopy === true ? badge('@', 'business') : null,
      rev !== undefined
        ? rev.conflict
          ? badge(props.t('conflict'), 'error')
          : rev.immutable
            ? badge(props.t('immutable'), 'muted')
            : rev.rewritable
              ? badge(props.t('rewritable'), 'business')
              : null
        : null,
      rev !== undefined
        ? h(
            'span',
            { style: { marginLeft: 'auto', display: 'inline-flex' } },
            h(CopyIconButton, {
              text: rev.changeId,
              label: props.t('copyChangeId'),
              copiedLabel: props.t('copied'),
            }),
          )
        : null,
    );

    if (error !== undefined) {
      return h(
        'div',
        { className: 'dshjj-sec' },
        headerBar,
        h(
          'div',
          { className: 'dshjj-error' },
          h('span', { className: 'dshjj-error-title' }, iconAlert(14), props.t('failed')),
          h('span', { className: 'dshjj-note' }, `${props.t('failedDetail')}: ${error}`),
        ),
      );
    }

    if (detail === undefined) {
      return h(
        'div',
        { className: 'dshjj-sec' },
        headerBar,
        h(
          'div',
          { className: 'dshjj-skel-stack', 'aria-busy': true },
          h('span', { className: 'dshjj-skel', 'data-lg': true }),
          h('span', { className: 'dshjj-skel' }),
          h('span', { className: 'dshjj-skel' }),
        ),
      );
    }

    if (rev === undefined) {
      return h(
        'div',
        { className: 'dshjj-sec' },
        headerBar,
        h('p', { className: 'dshjj-note' }, detail.reason ?? props.t('unavailable')),
      );
    }

    const authorLabel =
      rev.author.length > 0 && rev.authorEmail.length > 0 && rev.author !== rev.authorEmail
        ? `${rev.author} <${rev.authorEmail}>`
        : rev.author || rev.authorEmail;

    return h(
      'div',
      { className: 'dshjj-sec' },
      headerBar,
      h(
        'p',
        { className: 'dshjj-detail-msg', 'data-muted': rev.description.length === 0 },
        rev.description.length > 0 ? rev.description : props.t('noDescription'),
      ),
      h(
        'div',
        { className: 'dshjj-meta-card' },
        h(
          'div',
          { className: 'dshjj-kv' },
          h('span', { className: 'dshjj-k' }, props.t('changeId')),
          h('span', { className: 'dshjj-v', 'data-mono': true, title: rev.changeId }, rev.changeId),
          h(CopyIconButton, { text: rev.changeId, label: props.t('copyChangeId'), copiedLabel: props.t('copied') }),
        ),
        h(
          'div',
          { className: 'dshjj-kv' },
          h('span', { className: 'dshjj-k' }, props.t('commitId')),
          h('span', { className: 'dshjj-v', 'data-mono': true, title: rev.commitId }, shortId(rev.commitId, 16)),
          h(CopyIconButton, { text: rev.commitId, label: props.t('copyCommitId'), copiedLabel: props.t('copied') }),
        ),
        authorLabel.length > 0
          ? h(
              'div',
              { className: 'dshjj-kv' },
              h('span', { className: 'dshjj-k' }, props.t('author')),
              h('span', { className: 'dshjj-v', title: authorLabel }, authorLabel),
            )
          : null,
        rev.timestamp.length > 0
          ? h(
              'div',
              { className: 'dshjj-kv' },
              h('span', { className: 'dshjj-k' }, props.t('time')),
              h(
                'span',
                { className: 'dshjj-v', title: rev.timestamp },
                `${dateTimeOf(rev.timestamp)} (${relativeTimeOf(rev.timestamp, props.t)})`,
              ),
            )
          : null,
        rev.bookmarks.length > 0 || rev.remoteBookmarks.length > 0
          ? h(
              'div',
              { className: 'dshjj-kv' },
              h('span', { className: 'dshjj-k' }, props.t('bookmarks')),
              h(
                'span',
                { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 } },
                ...rev.bookmarks.map((name) => badge(name, 'business', `lb-${name}`)),
                ...rev.remoteBookmarks
                  .filter((name) => !rev.bookmarks.includes(name))
                  .map((name) => badge(name, 'muted', `rb-${name}`)),
              ),
            )
          : null,
        rev.parents.length > 0
          ? h(
              'div',
              { className: 'dshjj-kv' },
              h('span', { className: 'dshjj-k' }, props.t('parents')),
              h(
                'span',
                { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 } },
                ...rev.parents.map((parentId) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshjj-parent-btn',
                      key: parentId,
                      title: parentId,
                      onClick: () => props.onSelectRev(parentId),
                    },
                    shortId(parentId, 8),
                  ),
                ),
              ),
            )
          : null,
      ),
      rev.files.length === 0
        ? h('p', { className: 'dshjj-note' }, props.t('noChangedFiles'))
        : h(DiffFilesCard, {
            title: props.t('changedFiles'),
            cwd: props.cwd,
            rev: rev.commitId,
            files: rev.files,
            totalAdded: rev.totalAdded,
            totalRemoved: rev.totalRemoved,
            defaultOpen: true,
            t: props.t,
          }),
    );
  }

  /** Format one remote sync badge (`origin · synced`, `origin · ahead`, etc.). */
  function remoteSyncBadge(remote: OverviewBookmarkRemote, t: (key: string) => string): unknown {
    if (remote.conflicted) return badge(`${remote.remote} · ${t('conflict')}`, 'error', `rem-${remote.remote}`);
    switch (remote.sync) {
      case 'synced':
        return badge(`${remote.remote} · ${t('syncSynced')}`, 'success', `rem-${remote.remote}`);
      case 'ahead':
        return badge(`${remote.remote} · ${t('syncAhead')}`, 'business', `rem-${remote.remote}`);
      case 'behind':
        return badge(`${remote.remote} · ${t('syncBehind')}`, 'warn', `rem-${remote.remote}`);
      case 'diverged':
        return badge(`${remote.remote} · ${t('syncDiverged')}`, 'warn', `rem-${remote.remote}`);
      default:
        return badge(`${remote.remote} · ${t('syncUnsynced')}`, 'muted', `rem-${remote.remote}`);
    }
  }

  /**
   * Tab body: the read-only Jujutsu panel.
   *
   * Layout: 38px DSH pane header (workspace identity + copy path + icon refresh), compact
   * working-copy status strip (with shortest-prefix change id, diff totals, base ref and
   * parallel-session indicator), 4-way segmented view bar (Graph / Bookmarks / Workspaces /
   * Operations), and a unified drill-in Revision Inspector with inline unified diffs.
   *
   * @param props - slot props (`sessionId`, `useSessions`, `useSessionStatus`, `t`).
   * @returns the React element tree.
   */
  function JjPanelBody(props: TabProps): unknown {
    const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
    ensurePanelStyles();

    const fallbackSelector = (): unknown => undefined;
    const useSessions = props.useSessions ?? fallbackSelector;
    const useSessionStatus = props.useSessionStatus ?? fallbackSelector;
    const id = typeof props.sessionId === 'string' ? props.sessionId : undefined;

    const cwd = useSessions((state) => {
      const byId = (state as { byId?: Record<string, { cwd?: unknown }> } | undefined)?.byId;
      return id === undefined ? undefined : byId?.[id]?.cwd;
    });
    const sessionRunning =
      useSessionStatus((snapshot) => {
        if (id === undefined || !(snapshot instanceof Map)) return false;
        const entry = snapshot.get(id) as { running?: unknown } | undefined;
        return entry?.running === true;
      }) === true;

    const [overview, setOverview] = ReactImpl?.useState<Overview | undefined>(undefined) ?? [undefined, () => {}];
    const [refreshing, setRefreshing] = ReactImpl?.useState(false) ?? [false, () => {}];
    const [failure, setFailure] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];
    const [updated, setUpdated] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];
    const [activeTab, setActiveTab] = ReactImpl?.useState<PanelTab>('history') ?? ['history', () => {}];
    const [graphScope, setGraphScope] = ReactImpl?.useState<'all' | 'stack'>('all') ?? ['all', () => {}];
    const [hideSnapshots, setHideSnapshots] = ReactImpl?.useState(false) ?? [false, () => {}];
    const [expandedOpId, setExpandedOpId] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];
    const [showRemoteOnly, setShowRemoteOnly] = ReactImpl?.useState(false) ?? [false, () => {}];
    const [inspectedRev, setInspectedRev] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];
    const [wasRunning, setWasRunning] = ReactImpl?.useState(false) ?? [false, () => {}];
    const [autoRefreshSeq, setAutoRefreshSeq] = ReactImpl?.useState(0) ?? [0, () => {}];

    // Initial load & cwd switch via cached GET `/api/jj.overview`.
    ReactImpl?.useEffect(() => {
      if (typeof cwd !== 'string' || cwd.length === 0) {
        setOverview(undefined);
        setInspectedRev(undefined);
        return undefined;
      }
      let alive = true;
      setInspectedRev(undefined);
      void fetch(`api/jj.overview?cwd=${encodeURIComponent(cwd)}`, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((payload: unknown) => {
          if (alive) {
            setOverview(payload as Overview);
            setFailure(undefined);
            setUpdated(
              new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            );
          }
        })
        .catch((error: unknown) => {
          if (alive) setFailure(error instanceof Error ? error.message : String(error));
        });
      return () => {
        alive = false;
      };
    }, [cwd]);

    // Detect session turn completion (`running: true -> false`) and queue a passive refresh.
    ReactImpl?.useEffect(() => {
      if (sessionRunning && !wasRunning) {
        setWasRunning(true);
      } else if (!sessionRunning && wasRunning) {
        setWasRunning(false);
        setAutoRefreshSeq((seq) => seq + 1);
      }
    }, [sessionRunning, wasRunning]);

    const fetchFresh = (targetCwd: string): void => {
      setRefreshing(true);
      void fetch('api/jj.refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ cwd: targetCwd }),
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((payload: unknown) => {
          setOverview(payload as Overview);
          setFailure(undefined);
          setUpdated(
            new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          );
        })
        .catch((error: unknown) => {
          setFailure(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setRefreshing(false);
        });
    };

    // Execute passive refresh after an agent turn ends.
    ReactImpl?.useEffect(() => {
      if (autoRefreshSeq === 0 || typeof cwd !== 'string' || cwd.length === 0) return;
      fetchFresh(cwd);
    }, [autoRefreshSeq, cwd]);

    const reload = (): void => {
      if (typeof cwd !== 'string' || cwd.length === 0 || refreshing) return;
      fetchFresh(cwd);
    };

    const wsInfo = overview?.workspace;
    const cwdText = typeof cwd === 'string' ? cwd : '';
    const repoKindLabel =
      wsInfo?.kind === 'jj-colocated' ? t('repoColocated') : wsInfo?.kind === 'jj-native' ? t('repoNative') : undefined;

    /** 38px DSH pane header aligned with the conversation and Files/Review header rule. */
    const header = h(
      'header',
      { className: 'dshjj-head' },
      h('span', { className: 'dshjj-head-icon' }, iconJj(15)),
      h(
        'span',
        { className: 'dshjj-head-ws', title: wsInfo?.root ?? (cwdText || t('title')) },
        wsInfo !== undefined ? wsInfo.name : t('title'),
      ),
      repoKindLabel !== undefined ? h('span', { className: 'dshjj-head-kind' }, repoKindLabel) : null,
      wsInfo !== undefined
        ? h(CopyIconButton, { text: wsInfo.root, label: t('copyPath'), copiedLabel: t('copied') })
        : null,
      h(
        'div',
        { className: 'dshjj-head-end' },
        updated === undefined
          ? null
          : h('span', { className: 'dshjj-updated', title: `${t('updated')} ${updated}` }, updated),
        h(
          'button',
          {
            type: 'button',
            className: 'dshjj-icon-btn',
            onClick: reload,
            disabled: refreshing || cwdText.length === 0,
            'aria-busy': refreshing,
            'aria-label': refreshing ? t('refreshing') : t('refresh'),
            title: refreshing ? t('refreshing') : t('refresh'),
          },
          iconRefresh(14, refreshing),
        ),
      ),
    );

    const bodyChildren: unknown[] = [];

    if (failure !== undefined) {
      bodyChildren.push(
        h(
          'div',
          { className: 'dshjj-error' },
          h('span', { className: 'dshjj-error-title' }, iconAlert(14), t('failed')),
          h('span', { className: 'dshjj-note' }, `${t('failedDetail')}: ${failure}`),
          h('button', { type: 'button', className: 'dshjj-btn', onClick: reload }, t('retry')),
        ),
      );
    } else if (overview === undefined) {
      bodyChildren.push(
        h(
          'div',
          { className: 'dshjj-skel-stack', 'aria-busy': true },
          h('span', { className: 'dshjj-skel', 'data-lg': true }),
          h('span', { className: 'dshjj-skel' }),
          h('span', { className: 'dshjj-skel' }),
          h('span', { className: 'dshjj-skel' }),
        ),
      );
    } else if (overview.reason !== undefined || overview.workspace === undefined) {
      bodyChildren.push(
        h(
          'div',
          { className: 'dshjj-empty' },
          h('span', { className: 'dshjj-empty-icon' }, iconJj(20)),
          h('span', { style: { fontWeight: 500 } }, t('unavailable')),
          overview.reason === undefined
            ? h('span', { className: 'dshjj-note' }, t('emptyHint'))
            : h(
                'span',
                { className: 'dshjj-note', title: overview.reason },
                `${t('failedDetail')}: ${overview.reason}`,
              ),
        ),
      );
    } else if (inspectedRev !== undefined && cwdText.length > 0) {
      bodyChildren.push(
        h(RevisionInspector, {
          cwd: cwdText,
          rev: inspectedRev,
          onBack: () => setInspectedRev(undefined),
          onSelectRev: (nextRev: string) => setInspectedRev(nextRev),
          t,
        }),
      );
    } else {
      const copy = overview.workingCopy;
      const historyList =
        overview.history !== undefined && overview.history.length > 0 ? overview.history : overview.stack;
      const stackCount = overview.stack.length;
      const remoteOnly = overview.remoteOnlyBookmarks ?? [];

      // Map commit id -> local bookmark names for graph pill rendering and base lookup.
      const bookmarksByCommit = new Map<string, string[]>();
      for (const bm of overview.bookmarks) {
        if (bm.target === undefined) continue;
        const names = bookmarksByCommit.get(bm.target) ?? [];
        names.push(bm.name);
        bookmarksByCommit.set(bm.target, names);
      }
      const workspacesByChange = new Map<string, string[]>();
      for (const ws of overview.workspaces) {
        if (ws.current) continue;
        const names = workspacesByChange.get(ws.changeId) ?? [];
        names.push(ws.name);
        workspacesByChange.set(ws.changeId, names);
      }

      // Derive parent bookmark / commit label for the compact status strip.
      const primaryParentId = copy?.parentCommitIds?.[0];
      const parentBookmarks = primaryParentId !== undefined ? (bookmarksByCommit.get(primaryParentId) ?? []) : [];
      const baseLabel =
        parentBookmarks.length > 0
          ? `${t('basedOn')} ${parentBookmarks[0]!}`
          : primaryParentId !== undefined
            ? `${t('basedOn')} ${shortId(primaryParentId, 8)}`
            : '';

      // 1. Compact working-copy status strip (always visible at top, zero repetition).
      if (copy !== undefined) {
        const files = copy.files ?? [];
        const conflictCount = copy.conflictFiles?.length ?? 0;
        const dotTone = copy.conflict ? 'error' : copy.stale === 'yes' ? 'warn' : !copy.empty ? 'business' : 'success';
        const statusSummary = copy.conflict
          ? conflictCount > 0
            ? countText(t('conflictCount'), conflictCount)
            : t('conflict')
          : copy.empty
            ? baseLabel.length > 0
              ? `${t('workingCopyEmpty')} · ${baseLabel}`
              : t('workingCopyEmpty')
            : files.length > 0
              ? `${t('modified')} · ${countText(t('fileCount'), files.length)}`
              : t('modified');

        bodyChildren.push(
          h(
            'div',
            { className: 'dshjj-status' },
            h(
              'div',
              { className: 'dshjj-status-top' },
              h('span', { className: 'dshjj-dot', 'data-tone': dotTone }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshjj-status-btn',
                  title: t('inspectRevision'),
                  onClick: () => setInspectedRev(copy.commitId),
                },
                ChangeIdText(copy.changeId, copy.shortestChangeId, 8),
                h(
                  'span',
                  { className: 'dshjj-status-summary', 'data-tone': copy.conflict ? 'error' : 'none' },
                  statusSummary,
                ),
                !copy.empty ? diffCounts(copy.totalAdded ?? 0, copy.totalRemoved ?? 0) : null,
              ),
              copy.stale === 'yes' ? badge(t('stale'), 'warn') : null,
              h(CopyIconButton, {
                text: copy.changeId,
                label: t('copyChangeId'),
                copiedLabel: t('copied'),
              }),
            ),
            copy.description.length > 0
              ? h('div', { className: 'dshjj-status-desc', title: copy.description }, copy.description)
              : null,
          ),
        );
      }

      if ((overview.parallelActiveSessions ?? 0) > 0) {
        bodyChildren.push(
          h(
            'div',
            { className: 'dshjj-banner', role: 'status' },
            iconAlert(14),
            h('span', null, countText(t('parallelSessionsNotice'), overview.parallelActiveSessions!)),
          ),
        );
      }

      // 2. Segmented navigation bar.
      const tabDefs: readonly { readonly id: PanelTab; readonly label: string; readonly count: number }[] = [
        { id: 'history', label: t('tabHistory'), count: historyList.length },
        { id: 'bookmarks', label: t('tabBookmarks'), count: overview.bookmarks.length },
        { id: 'workspaces', label: t('tabWorkspaces'), count: overview.workspaces.length },
        { id: 'operations', label: t('tabOperations'), count: overview.operations.length },
      ];
      bodyChildren.push(
        h(
          'div',
          { className: 'dshjj-tabs', role: 'tablist', 'aria-label': t('title') },
          ...tabDefs.map((tab) =>
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                key: tab.id,
                className: 'dshjj-tab',
                'aria-selected': activeTab === tab.id,
                onClick: () => setActiveTab(tab.id),
              },
              h('span', { className: 'dshjj-tab-label' }, tab.label),
              h('span', { className: 'dshjj-tab-cnt' }, String(tab.count)),
            ),
          ),
        ),
      );

      // 3. Active view content.
      if (activeTab === 'history') {
        // Working copy changed files card (only rendered when `@` actually has file changes).
        const wcFiles = copy?.files ?? [];
        if (copy !== undefined && wcFiles.length > 0 && cwdText.length > 0) {
          bodyChildren.push(
            h(DiffFilesCard, {
              title: t('workingCopyFiles'),
              cwd: cwdText,
              rev: '@',
              files: wcFiles,
              totalAdded: copy.totalAdded ?? 0,
              totalRemoved: copy.totalRemoved ?? 0,
              defaultOpen: true,
              t,
            }),
          );
        }

        const visibleChanges = graphScope === 'stack' ? overview.stack : historyList;
        const graphRows: unknown[] = [];
        let seenPublishedDivider = false;

        for (let index = 0; index < visibleChanges.length; index += 1) {
          const change = visibleChanges[index]!;
          const isImmutable = change.immutable === true;
          const prev = index > 0 ? visibleChanges[index - 1] : undefined;
          if (
            graphScope === 'all' &&
            !seenPublishedDivider &&
            isImmutable &&
            prev !== undefined &&
            prev.immutable !== true
          ) {
            seenPublishedDivider = true;
            graphRows.push(h('div', { className: 'dshjj-divider', key: 'pub-div' }, t('publishedDivider')));
          }

          const nodeKind = change.conflict
            ? 'conflict'
            : change.currentWorkingCopy
              ? 'current'
              : isImmutable
                ? 'immutable'
                : 'mutable';
          const localBms =
            change.bookmarks !== undefined && change.bookmarks.length > 0
              ? change.bookmarks
              : (bookmarksByCommit.get(change.commitId) ?? []);
          const otherWs = workspacesByChange.get(change.changeId) ?? [];
          const relTime = change.timestamp !== undefined ? relativeTimeOf(change.timestamp, t) : '';

          graphRows.push(
            h(
              'div',
              { className: 'dshjj-grow', key: change.commitId || change.changeId },
              h(
                'div',
                { className: 'dshjj-rail-col' },
                h('span', { className: 'dshjj-rail-top', 'data-hidden': index === 0 }),
                h('span', {
                  className: 'dshjj-node',
                  'data-kind': nodeKind,
                  'data-has-dot': !change.empty && !isImmutable,
                }),
                h('span', { className: 'dshjj-rail-bot', 'data-hidden': index === visibleChanges.length - 1 }),
              ),
              h(
                'div',
                { className: 'dshjj-commit' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshjj-commit-main',
                    title: t('inspectRevision'),
                    onClick: () => setInspectedRev(change.commitId),
                  },
                  h(
                    'div',
                    { className: 'dshjj-commit-top' },
                    h(
                      'span',
                      { className: 'dshjj-desc', 'data-muted': change.description.length === 0 },
                      change.description.length > 0 ? change.description : t('noDescription'),
                    ),
                    change.currentWorkingCopy ? badge('@', 'business') : null,
                    change.conflict ? badge(t('conflict'), 'error') : null,
                    change.empty ? badge(t('empty'), 'muted') : null,
                  ),
                  h(
                    'div',
                    { className: 'dshjj-commit-meta' },
                    ChangeIdText(change.changeId, change.shortestChangeId, 8),
                    h('span', { className: 'dshjj-id' }, shortId(change.commitId, 7)),
                    ...localBms.map((name) => badge(name, 'business', `bm-${name}`)),
                    ...otherWs.map((wsName) => badge(`${wsName}@`, 'muted', `ws-${wsName}`)),
                    change.author !== undefined && change.author.length > 0
                      ? h('span', { className: 'dshjj-author', title: change.author }, change.author)
                      : null,
                    relTime.length > 0 ? h('span', { title: dateTimeOf(change.timestamp!) }, relTime) : null,
                  ),
                ),
                h(CopyIconButton, {
                  text: change.changeId,
                  label: t('copyChangeId'),
                  copiedLabel: t('copied'),
                  hoverOnly: true,
                }),
              ),
            ),
          );
        }

        bodyChildren.push(
          h(
            'section',
            { className: 'dshjj-sec' },
            h(
              'div',
              { className: 'dshjj-sec-bar' },
              h(
                'h3',
                { className: 'dshjj-sec-title' },
                t('graphTitle'),
                h('span', { className: 'dshjj-sec-cnt' }, String(visibleChanges.length)),
              ),
              h(
                'div',
                { className: 'dshjj-pills' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshjj-pill-btn',
                    'aria-pressed': graphScope === 'all',
                    onClick: () => setGraphScope('all'),
                  },
                  t('scopeAll'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshjj-pill-btn',
                    'aria-pressed': graphScope === 'stack',
                    onClick: () => setGraphScope('stack'),
                  },
                  `${t('scopeStack')} (${String(stackCount)})`,
                ),
              ),
            ),
            visibleChanges.length === 0
              ? h('p', { className: 'dshjj-note' }, graphScope === 'stack' ? t('noStack') : t('noHistory'))
              : h('div', { className: 'dshjj-graph-list' }, ...graphRows),
          ),
        );
      } else if (activeTab === 'bookmarks') {
        bodyChildren.push(
          h(
            'section',
            { className: 'dshjj-sec' },
            overview.bookmarks.length === 0
              ? h('p', { className: 'dshjj-note' }, t('noBookmarks'))
              : h(
                  'div',
                  { className: 'dshjj-list-card' },
                  overview.bookmarks.map((bm) => {
                    const remotes = bm.remotes ?? [];
                    return h(
                      'div',
                      { className: 'dshjj-bm-row', key: bm.name },
                      h(
                        'span',
                        { style: { color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px', flex: 'none' } },
                        iconBookmark(13),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshjj-bm-btn',
                          disabled: bm.target === undefined,
                          title: bm.target !== undefined ? t('inspectRevision') : undefined,
                          onClick: () => {
                            if (bm.target !== undefined) setInspectedRev(bm.target);
                          },
                        },
                        h(
                          'div',
                          { className: 'dshjj-bm-top' },
                          h('span', { className: 'dshjj-bm-name' }, bm.name),
                          bm.conflicted ? badge(t('conflict'), 'error') : null,
                          remotes.length === 0 && !bm.conflicted
                            ? badge(t('syncLocalOnly'), 'muted')
                            : remotes.map((rem) => remoteSyncBadge(rem, t)),
                        ),
                        h(
                          'div',
                          { className: 'dshjj-bm-sub' },
                          bm.targetChangeId !== undefined
                            ? ChangeIdText(bm.targetChangeId, bm.targetShortestChangeId, 8)
                            : null,
                          bm.target !== undefined ? h('span', { className: 'dshjj-id' }, shortId(bm.target, 8)) : null,
                          bm.targetDescription !== undefined
                            ? h(
                                'span',
                                { className: 'dshjj-bm-desc' },
                                bm.targetDescription.length > 0 ? bm.targetDescription : t('noDescription'),
                              )
                            : null,
                        ),
                      ),
                      h(CopyIconButton, {
                        text: bm.name,
                        label: t('copy'),
                        copiedLabel: t('copied'),
                        hoverOnly: true,
                      }),
                    );
                  }),
                ),
          ),
        );

        if (remoteOnly.length > 0) {
          bodyChildren.push(
            h(
              'section',
              { className: 'dshjj-sec' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshjj-toggle-btn',
                  'aria-expanded': showRemoteOnly,
                  'aria-pressed': showRemoteOnly,
                  style: { alignSelf: 'flex-start' },
                  onClick: () => setShowRemoteOnly(!showRemoteOnly),
                },
                iconChevron(11, showRemoteOnly),
                `${t('remoteOnlyBookmarks')} (${String(remoteOnly.length)})`,
              ),
              showRemoteOnly
                ? h(
                    'div',
                    { className: 'dshjj-list-card' },
                    remoteOnly.map((rem) =>
                      h(
                        'div',
                        { className: 'dshjj-bm-row', key: `${rem.name}@${rem.remote}` },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dshjj-bm-btn',
                            disabled: rem.target === undefined,
                            onClick: () => {
                              if (rem.target !== undefined) setInspectedRev(rem.target);
                            },
                          },
                          h(
                            'div',
                            { className: 'dshjj-bm-top' },
                            h('span', { className: 'dshjj-bm-name' }, `${rem.name}@${rem.remote}`),
                            rem.conflicted ? badge(t('conflict'), 'error') : null,
                          ),
                          rem.target !== undefined
                            ? h('span', { className: 'dshjj-id' }, shortId(rem.target, 8))
                            : null,
                        ),
                      ),
                    ),
                  )
                : null,
            ),
          );
        }
      } else if (activeTab === 'workspaces') {
        bodyChildren.push(
          h(
            'section',
            { className: 'dshjj-sec' },
            overview.workspaces.map((ws) =>
              h(
                'div',
                { className: 'dshjj-ws-card', key: ws.name, 'data-current': ws.current },
                h(
                  'div',
                  { className: 'dshjj-ws-head' },
                  h(
                    'span',
                    { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' } },
                    iconWorkspace(14),
                  ),
                  h('span', { className: 'dshjj-ws-name' }, ws.name),
                  ws.current ? badge(t('current'), 'business') : null,
                  ws.sessionState === 'active'
                    ? badge(t('sessionActive'), 'success')
                    : ws.sessionState === 'idle'
                      ? badge(t('sessionIdle'), 'muted')
                      : ws.sessionState === 'orphaned'
                        ? badge(t('sessionOrphaned'), 'warn')
                        : null,
                  ws.managed === true && ws.sessionState !== 'orphaned' ? badge(t('managedWorkspace'), 'muted') : null,
                  ws.stale === 'yes' ? badge(t('stale'), 'warn') : null,
                  ws.conflict ? badge(t('conflict'), 'error') : null,
                  !ws.conflict ? badge(ws.empty ? t('empty') : t('modified'), ws.empty ? 'muted' : 'business') : null,
                ),
                h(
                  'div',
                  { className: 'dshjj-ws-path' },
                  h('span', { className: 'dshjj-ws-path-text', title: ws.root }, ws.root),
                  h(CopyIconButton, { text: ws.root, label: t('copyPath'), copiedLabel: t('copied') }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshjj-ws-change',
                    title: t('inspectRevision'),
                    onClick: () => setInspectedRev(ws.commitId ?? ws.changeId),
                  },
                  ChangeIdText(ws.changeId, undefined, 8),
                  h(
                    'span',
                    { className: 'dshjj-desc', 'data-muted': ws.description.length === 0 },
                    ws.description.length > 0 ? ws.description : t('noDescription'),
                  ),
                  h(
                    'span',
                    { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)' } },
                    iconChevron(11, false),
                  ),
                ),
              ),
            ),
          ),
        );
      } else {
        const snapshotCount = overview.operations.filter((op) => op.isSnapshot).length;
        const visibleOps = hideSnapshots ? overview.operations.filter((op) => !op.isSnapshot) : overview.operations;
        bodyChildren.push(
          h(
            'section',
            { className: 'dshjj-sec' },
            h(
              'div',
              { className: 'dshjj-sec-bar' },
              h(
                'h3',
                { className: 'dshjj-sec-title' },
                t('operations'),
                h('span', { className: 'dshjj-sec-cnt' }, String(visibleOps.length)),
              ),
              snapshotCount > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshjj-toggle-btn',
                      'aria-pressed': hideSnapshots,
                      onClick: () => setHideSnapshots(!hideSnapshots),
                    },
                    `${t('hideSnapshots')} (${String(snapshotCount)})`,
                  )
                : null,
            ),
            overview.operations.length === 0
              ? h('p', { className: 'dshjj-note' }, t('noOperations'))
              : visibleOps.length === 0
                ? h('p', { className: 'dshjj-note' }, t('noFilteredOperations'))
                : h(
                    'div',
                    { className: 'dshjj-list-card' },
                    visibleOps.map((op) => {
                      const isOpen = expandedOpId === op.id;
                      return h(
                        'div',
                        { className: 'dshjj-op-item', key: op.id },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dshjj-op-row',
                            'aria-expanded': isOpen,
                            onClick: () => setExpandedOpId(isOpen ? undefined : op.id),
                          },
                          h('span', { className: 'dshjj-id' }, shortId(op.shortId, 8)),
                          h('span', { className: 'dshjj-op-desc', 'data-snapshot': op.isSnapshot }, op.description),
                          op.workspaceName !== null && overview.workspaces.length > 1
                            ? badge(op.workspaceName, 'muted')
                            : null,
                          h(
                            'span',
                            { className: 'dshjj-op-time', title: dateTimeOf(op.time) },
                            relativeTimeOf(op.time, t) || timeOf(op.time),
                          ),
                        ),
                        isOpen
                          ? h(
                              'div',
                              { className: 'dshjj-op-detail' },
                              h(
                                'div',
                                { className: 'dshjj-kv' },
                                h('span', { className: 'dshjj-k' }, t('opId')),
                                h(
                                  'span',
                                  { className: 'dshjj-v', 'data-mono': true, title: op.id },
                                  shortId(op.id, 16),
                                ),
                                h(CopyIconButton, { text: op.id, label: t('copyOpId'), copiedLabel: t('copied') }),
                              ),
                              h(
                                'div',
                                { className: 'dshjj-kv' },
                                h('span', { className: 'dshjj-k' }, t('time')),
                                h('span', { className: 'dshjj-v' }, dateTimeOf(op.time)),
                              ),
                              op.user !== undefined && op.user.length > 0
                                ? h(
                                    'div',
                                    { className: 'dshjj-kv' },
                                    h('span', { className: 'dshjj-k' }, t('user')),
                                    h('span', { className: 'dshjj-v' }, op.user),
                                  )
                                : null,
                              op.workspaceName !== null
                                ? h(
                                    'div',
                                    { className: 'dshjj-kv' },
                                    h('span', { className: 'dshjj-k' }, t('workspaces')),
                                    h('span', { className: 'dshjj-v' }, op.workspaceName),
                                  )
                                : null,
                              op.tags !== undefined && op.tags.length > 0
                                ? h(
                                    'div',
                                    { className: 'dshjj-kv' },
                                    h('span', { className: 'dshjj-k' }, t('tags')),
                                    h('span', { className: 'dshjj-v' }, op.tags.join(', ')),
                                  )
                                : null,
                            )
                          : null,
                      );
                    }),
                  ),
          ),
        );
      }
    }

    return h(
      'div',
      { className: 'dshjj', 'aria-label': t('title') },
      header,
      h('div', { className: 'dshjj-body' }, ...bodyChildren),
    );
  }

  /** Slot props the framework composes for a keyed tool view. */
  interface ToolViewProps {
    readonly phase?: string;
    readonly block?: unknown;
    readonly t?: (key: string) => string;
    /**
     * Chat-owned expansion state for one call. The host hands its stable `useDisclosure`
     * to every atomic tool view so collapsing the surrounding turn resets a row body;
     * hosts from before that contract omit it and the row falls back to local state.
     */
    readonly useDisclosure?: () => { readonly expanded?: boolean; readonly toggle?: () => void };
  }

  /** One labelled line in an expanded tool row. */
  interface ToolDetail {
    readonly label: string;
    readonly value: string;
  }

  /** Everything one tool view renders: a localized title, a one-line summary and details. */
  interface ToolCardModel {
    readonly title: string;
    readonly summary: string;
    readonly tone: 'none' | 'error';
    readonly details: readonly ToolDetail[];
    readonly raw?: string;
  }

  /** Above this many labelled lines an expanded row ends with a localized "n more". */
  const MAX_TOOL_DETAILS = 6;

  /** Resolve a localized translator; a host seat that misses keys falls back to English. */
  function translator(props: ToolViewProps): (key: string) => string {
    const fallback = (key: string): string => DICTIONARIES.en?.[key] ?? key;
    const t = props.t;
    if (typeof t !== 'function') return fallback;
    return (key: string): string => {
      const value = t(key);
      return typeof value === 'string' && value.length > 0 ? value : fallback(key);
    };
  }

  /** Read a non-empty string field without trusting a payload's shape. */
  function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** First line of a multi-line payload (a collapsed row stays one line). */
  function firstLine(text: string): string {
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  }

  /** Read a nested record without trusting its shape. */
  function recordOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  /**
   * Parse a tool call's arguments from the recorded raw JSON.
   *
   * The framework exposes partial (preparing) arguments through accessors and the final
   * call through `argsRaw`; only the latter is stable across tool phases, so both are read
   * defensively and an unparsable payload simply yields no summary.
   */
  function toolArgs(block: unknown): Record<string, unknown> | undefined {
    const record = recordOf(block);
    if (record === undefined) return undefined;
    const accessors = recordOf(record['args']);
    if (accessors !== undefined) return accessors;
    const call = recordOf(record['call']);
    const raw = call?.['argsRaw'] ?? record['argsRaw'];
    if (typeof raw !== 'string') return undefined;
    try {
      return recordOf(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  /** Parse a tool result's JSON payload from its first text content item. */
  function toolResult(block: unknown): Record<string, unknown> | undefined {
    const record = recordOf(block);
    const content = record?.['content'];
    if (!Array.isArray(content)) return undefined;
    for (const item of content) {
      const entry = recordOf(item);
      const text = entry?.['text'];
      if (typeof text !== 'string') continue;
      try {
        return recordOf(JSON.parse(text));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** First non-empty plain-text result item, used for error summaries and raw bodies. */
  function toolResultText(block: unknown): string | undefined {
    const content = recordOf(block)?.['content'];
    if (!Array.isArray(content)) return undefined;
    for (const item of content) {
      const text = recordOf(item)?.['text'];
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
    return undefined;
  }

  /**
   * Lifecycle of one atomic call: `preparing`/`start` before dispatch, then a result.
   */
  function toolState(props: ToolViewProps): 'preparing' | 'running' | 'error' | 'ok' {
    const block = recordOf(props.block);
    if (block === undefined) return props.phase === 'preparing' ? 'preparing' : 'running';
    const settled = 'kind' in block || 'call' in block || 'content' in block || 'isError' in block || 'error' in block;
    if (!settled) return block['phase'] === 'preparing' ? 'preparing' : 'running';
    return block['isError'] === true || block['error'] !== undefined ? 'error' : 'ok';
  }

  /** Chat-owned disclosure hook, with local state when the host does not pass one. */
  function useToolDisclosure(props: ToolViewProps): { expanded: boolean; toggle: () => void } {
    const [expanded, setExpanded] = ReactImpl?.useState(false) ?? [false, () => {}];
    const host = props.useDisclosure;
    if (typeof host === 'function') {
      const state: { expanded?: boolean; toggle?: () => void } = host();
      return {
        expanded: state.expanded === true,
        toggle: typeof state.toggle === 'function' ? state.toggle : () => {},
      };
    }
    return { expanded, toggle: () => setExpanded(!expanded) };
  }

  /** One 14px leading icon from the host's shared primitives, or nothing without them. */
  function toolIcon(name: string): unknown {
    const icon = hostPrimitives()?.[name];
    return typeof icon === 'function' ? h(icon, { size: 14 }) : undefined;
  }

  /** Expanded body: labelled lines plus the raw error payload when the call failed. */
  function toolDetailBody(model: ToolCardModel): unknown {
    return h(
      'div',
      { className: 'dshjj-tool-detail' },
      ...model.details.map((detail, index) =>
        h(
          'div',
          { className: 'dshjj-tool-dkv', key: `detail-${String(index)}` },
          detail.label.length > 0 ? h('span', { className: 'dshjj-tool-dk' }, detail.label) : null,
          h('span', { className: 'dshjj-tool-dv', title: detail.value }, detail.value),
        ),
      ),
      model.raw === undefined ? null : h('pre', { className: 'dshjj-tool-raw' }, model.raw),
    );
  }

  /** Keep one long stack from filling the transcript; the tail is counted, not dropped. */
  function cappedDetails(details: readonly ToolDetail[], t: (key: string) => string): ToolDetail[] {
    if (details.length <= MAX_TOOL_DETAILS) return [...details];
    return [
      ...details.slice(0, MAX_TOOL_DETAILS),
      { label: '', value: countText(t('moreItems'), details.length - MAX_TOOL_DETAILS) },
    ];
  }

  /** Render one tool call as a compact 24px disclosure row matching DSH's own tool rows. */
  function toolRow(props: ToolViewProps, icon: string, model: ToolCardModel): unknown {
    ensurePanelStyles();
    const t = translator(props);
    const state = toolState(props);
    const running = state === 'preparing' || state === 'running';
    const expandable = !running && (model.details.length > 0 || model.raw !== undefined);
    const disclosure = useToolDisclosure(props);
    const open = expandable && disclosure.expanded;
    const summary = running ? t('running') : model.summary;
    const collapsed =
      summary.length === 0
        ? null
        : h(
            'span',
            { className: 'dshjj-tool-collapsed' },
            h('span', { className: 'dshjj-tool-sep', 'aria-hidden': 'true' }),
            h('span', { className: 'dshjj-tool-summary', 'data-tone': model.tone }, summary),
          );
    const primitives = hostPrimitives();
    const disclosureRow = primitives?.['DisclosureRow'];
    if (typeof disclosureRow === 'function') {
      return h(
        disclosureRow,
        {
          icon: toolIcon(icon),
          title: model.title,
          running,
          open,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: disclosure.toggle,
          collapsedContent: collapsed,
        },
        toolDetailBody(model),
      );
    }
    return h(
      'div',
      { className: 'dshjj-tool-row', 'data-state': state },
      h('span', { className: 'dshjj-tool-row-title' }, model.title),
      collapsed,
    );
  }

  /** Collapse a failed call into a one-line error summary plus its raw payload. */
  function failedModel(props: ToolViewProps, t: (key: string) => string, title: string): ToolCardModel | undefined {
    if (toolState(props) !== 'error') return undefined;
    const raw = toolResultText(props.block);
    return {
      title,
      summary: raw === undefined ? t('failedCall') : firstLine(raw),
      tone: 'error',
      details: [],
      ...(raw === undefined ? {} : { raw }),
    };
  }

  /** `jj_status` row: where the working copy is, plus ids and the diff summary. */
  function statusModel(props: ToolViewProps, t: (key: string) => string): ToolCardModel {
    const title = t('statusCard');
    const failed = failedModel(props, t, title);
    if (failed !== undefined) return failed;
    const result = toolResult(props.block);
    const changeId = stringOf(result?.['changeId']);
    const commitId = stringOf(result?.['commitId']);
    const description = stringOf(result?.['description']);
    const flags: string[] = [];
    if (result?.['empty'] === true) flags.push(t('empty'));
    if (result?.['conflict'] === true) flags.push(t('conflict'));
    const summary = [changeId === undefined ? '' : shortId(changeId, 10), description ?? t('noDescription'), ...flags]
      .filter((part) => part.length > 0)
      .join(' · ');
    const details: ToolDetail[] = [];
    if (changeId !== undefined) details.push({ label: t('changeId'), value: changeId });
    if (commitId !== undefined) details.push({ label: t('commitId'), value: commitId });
    const diffStat = stringOf(result?.['diffStat']);
    if (diffStat !== undefined) details.push({ label: t('diffStat'), value: firstLine(diffStat) });
    const workspaceRoot = stringOf(result?.['workspaceRoot']);
    if (workspaceRoot !== undefined) details.push({ label: t('root'), value: workspaceRoot });
    return { title, summary, tone: 'none', details: cappedDetails(details, t) };
  }

  /** `jj_log` row: the requested revset and the revisions that matched. */
  function logModel(props: ToolViewProps, t: (key: string) => string): ToolCardModel {
    const title = t('logCard');
    const failed = failedModel(props, t, title);
    if (failed !== undefined) return failed;
    const args = toolArgs(props.block);
    const revset = stringOf(args?.['revset']) ?? '@ | @-';
    const result = toolResult(props.block);
    const changes = Array.isArray(result?.['changes']) ? result['changes'] : [];
    const details: ToolDetail[] = [];
    if (result?.['truncated'] === true) details.push({ label: '', value: t('truncated') });
    for (const change of changes) {
      const record = recordOf(change);
      const changeId = stringOf(record?.['changeId']);
      if (changeId === undefined) continue;
      details.push({ label: shortId(changeId, 8), value: stringOf(record?.['description']) ?? t('noDescription') });
    }
    return {
      title,
      summary: `${revset} · ${countText(t('revisionCount'), changes.length)}`,
      tone: 'none',
      details: cappedDetails(details, t),
    };
  }

  /** `jj_workspace_list` row: how many workspaces share the repository. */
  function workspacesModel(props: ToolViewProps, t: (key: string) => string): ToolCardModel {
    const title = t('workspacesCard');
    const failed = failedModel(props, t, title);
    if (failed !== undefined) return failed;
    const result = toolResult(props.block);
    const workspaces = Array.isArray(result?.['workspaces']) ? result['workspaces'] : [];
    const details: ToolDetail[] = [];
    for (const workspace of workspaces) {
      const record = recordOf(workspace);
      const name = stringOf(record?.['name']);
      if (name === undefined) continue;
      const label = recordIsCurrent(record) ? `${name} · ${t('current')}` : name;
      details.push({ label, value: stringOf(record?.['root']) ?? '' });
    }
    return {
      title,
      summary: workspaces.length === 0 ? '' : countText(t('workspaceCount'), workspaces.length),
      tone: 'none',
      details: cappedDetails(details, t),
    };
  }

  /** Whether a workspace record marks itself as the current working copy. */
  function recordIsCurrent(record: Record<string, unknown> | undefined): boolean {
    return record?.['isCurrent'] === true || record?.['current'] === true;
  }

  /** `jj_handoff` row: destination, how the integration ended and the next action. */
  function handoffModel(props: ToolViewProps, t: (key: string) => string): ToolCardModel {
    const title = t('handoffCard');
    const failed = failedModel(props, t, title);
    if (failed !== undefined) return failed;
    const result = toolResult(props.block);
    const destination = stringOf(result?.['destination']);
    const integration = result?.['rebased'] === true ? t('rebased') : t('alreadyIntegrated');
    const conflicts = Array.isArray(result?.['conflicts']) ? result['conflicts'].length : 0;
    const details: ToolDetail[] = [];
    if (destination !== undefined) details.push({ label: t('destination'), value: destination });
    details.push({ label: t('integration'), value: integration });
    details.push({
      label: '',
      value: conflicts > 0 ? countText(t('conflictCount'), conflicts) : t('noConflicts'),
    });
    const actions = Array.isArray(result?.['nextActions']) ? result['nextActions'] : [];
    const reason = stringOf(recordOf(actions[0])?.['reason']);
    if (reason !== undefined) details.push({ label: t('nextAction'), value: reason });
    return {
      title,
      summary: destination === undefined ? integration : `${destination} · ${integration}`,
      tone: 'none',
      details: cappedDetails(details, t),
    };
  }

  /** `jj_status` row. */
  function JjStatusCard(props: ToolViewProps): unknown {
    const t = translator(props);
    return toolRow(props, 'IconChecklistOutlineRegular', statusModel(props, t));
  }

  /** `jj_log` row. */
  function JjLogCard(props: ToolViewProps): unknown {
    const t = translator(props);
    return toolRow(props, 'IconBranchOutlineRegular', logModel(props, t));
  }

  /** `jj_workspace_list` row. */
  function JjWorkspacesCard(props: ToolViewProps): unknown {
    const t = translator(props);
    return toolRow(props, 'IconWorkspaceTreeOutlineRegular', workspacesModel(props, t));
  }

  /** `jj_handoff` row. */
  function JjHandoffCard(props: ToolViewProps): unknown {
    const t = translator(props);
    return toolRow(props, 'IconShareOutlineRegular', handoffModel(props, t));
  }

  /** Tab title chip: monochrome Jujutsu glyph + localized name (mirrors DSH's Forge/Files titles). */
  function JjPanelTitle(props: { readonly t?: (key: string) => string }): unknown {
    const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
    ensurePanelStyles();
    return h(
      'span',
      { className: 'dshjj-tab-title' },
      h('span', { className: 'dshjj-tab-title-icon' }, iconJj(15)),
      h('span', { className: 'dshjj-tab-title-text' }, t('title')),
    );
  }

  /**
   * Client plugin entry: register the locale dictionaries, the tab type, its body, and
   * the four compact tool rows.
   *
   * @param ctx - the client plugin context.
   */
  function apply(ctx: ClientContext): void {
    try {
      ctx.locale?.register?.(JJ_LOCALE_NS, DICTIONARIES);
    } catch {
      // Localization is cosmetic: a failure here must not stop the tab registration.
    }
    const t =
      typeof ctx.locale?.bind === 'function'
        ? ctx.locale.bind(JJ_LOCALE_NS)
        : (key: string) => DICTIONARIES.en?.[key] ?? key;
    if (ctx.sidebarRightTabs === undefined) {
      console.error('[dsh-jj] sidebarRightTabs is not injected; the Jujutsu tab cannot register.');
    }
    try {
      ctx.sidebarRightTabs?.register?.({
        id: JJ_TAB_ID,
        kind: 'jj',
        title: () => t('title'),
        guide: [
          {
            id: 'jj',
            title: () => t('title'),
            description: () => t('guideDescription'),
            order: 50,
          },
        ],
      });
    } catch (error) {
      console.error('[dsh-jj] sidebar tab registration failed:', error);
    }
    const registerBody = (): unknown =>
      ctx.slots?.register?.({ name: 'sidebar.right.pane.tab', key: JJ_TAB_ID, locale: JJ_LOCALE_NS }, JjPanelBody);
    const registerTitle = (): unknown =>
      ctx.slots?.register?.(
        { name: 'sidebar.right.pane.tab.title', key: JJ_TAB_ID, locale: JJ_LOCALE_NS },
        JjPanelTitle,
      );
    try {
      if (typeof ctx.slots?.inject === 'function') {
        ctx.slots.inject('sidebar.right.pane.tab', registerBody);
        ctx.slots.inject('sidebar.right.pane.tab.title', registerTitle);
      } else {
        registerBody();
        registerTitle();
      }
    } catch {
      // Slot registration failures stay inside this bundle.
    }
    const views: readonly (readonly [string, (props: ToolViewProps) => unknown])[] = [
      ['jj_status', JjStatusCard],
      ['jj_log', JjLogCard],
      ['jj_workspace_list', JjWorkspacesCard],
      ['jj_handoff', JjHandoffCard],
    ];
    for (const [key, component] of views) {
      const registerView = (): unknown =>
        ctx.slots?.register?.({ name: 'tool.call.toolview', key, locale: JJ_LOCALE_NS }, component);
      try {
        if (typeof ctx.slots?.inject === 'function') ctx.slots.inject('tool.call.toolview', registerView);
        else registerView();
      } catch {
        // One tool view failing must not affect the others or the tab.
      }
    }
  }

  /** Cordis client services this bundle waits for before `apply` runs. */
  const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

  interface LoaderGlobal {
    __ModuleLoader__?: {
      load(module: { id: string; factory: (require: RequireFn) => unknown }): void;
    };
  }

  const loader = (globalThis as unknown as LoaderGlobal).__ModuleLoader__;
  loader?.load({
    id: PANEL_BUNDLE_ID,
    factory: (require: RequireFn) => {
      const module = { exports: {} as { apply: (ctx: ClientContext) => void; inject: readonly string[] } };
      ReactImpl = require('react') as ReactLike;
      hostRequire = require;
      resetHostModules();
      module.exports.apply = apply;
      module.exports.inject = inject;
      return module.exports;
    },
  });
})();
