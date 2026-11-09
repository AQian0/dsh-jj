/**
 * Jujutsu panel — browser half (classic script, no module syntax).
 *
 * DSH serves third-party client plugins as **classic scripts** that register a lazy
 * CommonJS factory through `window.__ModuleLoader__.load({ id, factory })`. The id must
 * be this package's manifest name; the factory receives the host's frozen module
 * `require` (React, cordis, the shared client primitives) and returns the plugin module.
 * That is why this file intentionally has no `import`/`export` statements: `tsc` then
 * emits it unchanged and the shipped artifact is already a valid bundle.
 *
 * The half rendered here is deliberately small for now: it registers the right-sidebar
 * tab type and its body so the packaging contract is exercised end to end. The tab body
 * reads `/api/jj.overview` (the Host half) and renders it in the next slice.
 *
 * @module dsh-jj/panel-client
 */

/** Module id the host resolves the bundle under (must equal the package name). */
const PANEL_BUNDLE_ID = '@aqian0/dsh-jj';
/** Slot/tab key of the Jujutsu tab (unique inside this package). */
const JJ_TAB_ID = 'jj-panel';
/** Client locale namespace (dictionaries are registered below, not shipped as files). */
const JJ_LOCALE_NS = 'jjPanel';

/** Minimal React surface this bundle uses; the host provides React 18 at runtime. */
interface ReactLike {
  createElement(type: unknown, props?: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown;
  useState<T>(initial: T): [T, (next: T) => void];
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

/** Translation dictionaries; both baselines are required by the client locale service. */
const DICTIONARIES: Record<string, Record<string, string>> = {
  zh: {
    title: 'Jujutsu 状态',
    guideDescription: '工作副本、栈、工作区与书签',
    refresh: '刷新',
    loading: '正在读取 jj 状态…',
    unavailable: '暂无可显示的内容（这个会话可能不在 jj 仓库里）。',
    failed: '读取 jj 状态失败。',
    workingCopy: '工作副本',
    noDescription: '（无描述）',
    empty: '空',
    conflict: '冲突',
    clean: '干净',
    stale: 'stale',
    stack: '栈',
    noStack: '没有待集成的提交。',
    workspaces: '工作区',
    current: '当前',
    bookmarks: '书签',
    noBookmarks: '没有书签。',
    operations: '操作日志',
    changeId: 'change',
    commitId: 'commit',
    root: '路径',
    description: '描述',
    updated: '更新于',
    refreshing: '刷新中…',
    copy: '复制',
    copied: '已复制',
    retry: '重试',
    failedDetail: '原因',
    emptyHint: '这个会话的目录不在 jj 工作区里，或者 jj 服务不可用。',
    readOnly: '只读面板 · 数据来自 jj --ignore-working-copy',
    statusCard: '工作副本',
    logCard: '提交历史',
    workspacesCard: '工作区清单',
    handoffCard: '收尾集成',
    running: '执行中…',
    failedCall: '调用失败',
    noConflicts: '无冲突',
    conflicts: '冲突',
  },
  en: {
    title: 'Jujutsu status',
    guideDescription: 'Working copy, stack, workspaces and bookmarks',
    refresh: 'Refresh',
    loading: 'Reading jj status…',
    unavailable: 'Nothing to show (this session may not be in a jj workspace).',
    failed: 'Could not read jj status.',
    workingCopy: 'Working copy',
    noDescription: '(no description)',
    empty: 'empty',
    conflict: 'conflict',
    clean: 'clean',
    stale: 'stale',
    stack: 'Stack',
    noStack: 'No commits to integrate.',
    workspaces: 'Workspaces',
    current: 'current',
    bookmarks: 'Bookmarks',
    noBookmarks: 'No bookmarks.',
    operations: 'Operations',
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
    readOnly: 'Read-only panel · data from jj --ignore-working-copy',
    statusCard: 'Working copy',
    logCard: 'History',
    workspacesCard: 'Workspaces',
    handoffCard: 'Hand-off',
    running: 'Running…',
    failedCall: 'Call failed',
    noConflicts: 'no conflicts',
    conflicts: 'conflicts',
  },
};

/** One change row as the Host sends it. */
interface OverviewChange {
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly currentWorkingCopy: boolean;
}

/** One workspace row as the Host sends it. */
interface OverviewWorkspace {
  readonly name: string;
  readonly root: string;
  readonly current: boolean;
  readonly changeId: string;
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly stale: 'yes' | 'no' | 'unknown';
}

/** The `/api/jj.overview` payload this bundle renders. */
interface Overview {
  readonly enabled: boolean;
  readonly workspace?: { readonly kind: string; readonly root: string; readonly name: string };
  readonly workingCopy?: {
    readonly changeId: string;
    readonly commitId: string;
    readonly description: string;
    readonly empty: boolean;
    readonly conflict: boolean;
    readonly stale: 'yes' | 'no' | 'unknown';
  };
  readonly stack: readonly OverviewChange[];
  readonly workspaces: readonly OverviewWorkspace[];
  readonly bookmarks: readonly { readonly name: string; readonly target?: string; readonly conflicted: boolean }[];
  readonly operations: readonly {
    readonly id: string;
    readonly shortId: string;
    readonly description: string;
    readonly time: string;
    readonly workspaceName: string | null;
    readonly isSnapshot: boolean;
  }[];
  readonly reason?: string;
}

/** Slot props the framework composes for a session-scoped tab body. */
interface TabProps {
  readonly sessionId?: unknown;
  readonly useSessions?: (selector: (state: unknown) => unknown) => unknown;
  readonly t?: (key: string) => string;
}

/**
 * Panel styles, injected once per page. Every colour, radius and font comes from the
 * DSH design tokens (`--dsw-*` / `--dsh-*`), so the panel follows the app theme instead
 * of shipping its own palette.
 */
const PANEL_STYLE_ID = 'dshjj-panel-style';
const PANEL_CSS = `
.dshjj{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.dshjj *{box-sizing:border-box}
.dshjj-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none}
.dshjj-head-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.dshjj-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshjj-head-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsh-font-family-code,ui-monospace,monospace)}
.dshjj-updated{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshjj-body{display:flex;flex-direction:column;gap:14px;padding:10px 12px 16px;overflow:auto;min-height:0}
.dshjj-sec{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshjj-sec-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;cursor:pointer;user-select:none;padding:2px 0;border-radius:var(--dsw-radius-sm)}
.dshjj-sec-head:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshjj-chevron{display:inline-block;width:10px;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease;font-size:10px}
.dshjj-chevron[data-open=true]{transform:rotate(90deg)}
.dshjj-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}
.dshjj-sec-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshjj-stack{display:flex;flex-direction:column;min-width:0}
.dshjj-stackrow{display:grid;grid-template-columns:16px 1fr;column-gap:8px;min-width:0}
.dshjj-graph{display:flex;flex-direction:column;align-items:center;min-height:100%}
.dshjj-node{width:9px;height:9px;border-radius:50%;margin-top:6px;flex:none;background:var(--dsw-alias-border-l4);border:1.5px solid var(--dsw-alias-bg-base)}
.dshjj-node[data-current=true]{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dshjj-node[data-conflict=true]{background:var(--dsw-alias-state-error-primary);box-shadow:none}
.dshjj-node[data-empty=true]{background:transparent;border:1.5px dashed var(--dsw-alias-label-tertiary)}
.dshjj-rail{flex:1;width:1.5px;background:var(--dsw-alias-border-l3);margin-top:2px}
.dshjj-row{display:flex;flex-direction:column;gap:2px;padding:3px 6px;border-radius:var(--dsw-radius-sm);min-width:0}
@media(hover:hover){.dshjj-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshjj-desc{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.dshjj-desc[data-muted=true]{color:var(--dsw-alias-label-tertiary);font-weight:400;font-style:italic}
.dshjj-row-sub{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.dshjj-id{font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshjj-chip{font-size:11px;line-height:17px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dshjj-chip[data-tone=brand]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dshjj-chip[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dshjj-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dshjj-chip[data-tone=muted]{color:var(--dsw-alias-label-tertiary)}
.dshjj-card{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:8px 10px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dshjj-card[data-current=true]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dshjj-kv{display:flex;gap:8px;align-items:baseline;min-width:0}
.dshjj-k{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:54px;flex:none}
.dshjj-v{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dshjj-v[data-mono=true]{font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:11.5px}
.dshjj-btn{border:.5px solid var(--dsw-alias-border-l3);background:none;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);font-size:12px;padding:2px 8px;cursor:pointer;line-height:18px}
.dshjj-btn:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media(hover:hover){.dshjj-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshjj-copy{border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;padding:0 2px;opacity:0;transition:opacity .12s ease}
.dshjj-row:hover .dshjj-copy,.dshjj-copy:focus-visible{opacity:1}
.dshjj-ops{display:grid;grid-template-columns:56px 1fr;column-gap:8px;row-gap:1px;font-size:12px;min-width:0}
.dshjj-op-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:11px}
.dshjj-op-desc{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshjj-op-desc[data-snapshot=true]{color:var(--dsw-alias-label-tertiary)}
.dshjj-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dshjj-foot{color:var(--dsw-alias-label-tertiary);font-size:11px;padding-top:2px}
.dshjj-skel{height:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:dshjj-pulse 1.4s ease-in-out infinite}
@keyframes dshjj-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.dshjj-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:48px 20px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dshjj-empty-icon{width:40px;height:40px;border-radius:var(--dsw-radius-lg);border:1px dashed var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;font-family:var(--dsh-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary);font-size:14px}
.dshjj-error{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.dshjj-error-title{color:var(--dsw-alias-state-error-primary);font-weight:500}
`;

/** Structural view of the page globals the style injection needs (no DOM lib here). */
interface PanelDom {
  getElementById(id: string): unknown;
  createElement(tag: string): { id: string; textContent: string };
  head?: { appendChild(node: unknown): void };
}

/** Inject the panel stylesheet once; a missing DOM (tests) is a no-op. */
function ensurePanelStyles(): void {
  const doc = (globalThis as { document?: PanelDom }).document;
  if (doc === undefined || typeof doc.createElement !== 'function' || doc.head === undefined) return;
  try {
    if (doc.getElementById(PANEL_STYLE_ID) !== null) return;
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

/** Create one element (the bundle cannot use JSX: it is a classic script). */
function h(type: unknown, props?: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown {
  return ReactImpl?.createElement(type, props, ...children);
}

/** Short change/commit id for display. */
function shortId(id: string, length = 10): string {
  return id.length > length ? id.slice(0, length) : id;
}

/** Local wall-clock time of a jj operation timestamp (best effort, never throws). */
function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** One pill. */
function chip(text: string, tone: 'brand' | 'error' | 'warn' | 'muted' = 'muted'): unknown {
  return h('span', { className: 'dshjj-chip', 'data-tone': tone }, text);
}

/** A key/value line inside a card. */
function kv(label: string, value: string, mono = false): unknown {
  return h(
    'div',
    { className: 'dshjj-kv' },
    h('span', { className: 'dshjj-k', style: {} }, label),
    h('span', { className: 'dshjj-v', 'data-mono': mono, title: value }, value),
  );
}

/**
 * Copy-to-clipboard affordance for one id.
 *
 * @param props - the text, localized labels, and the copy button's visible state.
 * @returns the button element.
 */
function CopyButton(props: { text: string; copyLabel: string; copiedLabel: string }): unknown {
  const [copied, setCopied] = ReactImpl?.useState(false) ?? [false, () => {}];
  const copy = (): void => {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } })
      .navigator?.clipboard;
    if (clipboard === undefined) return;
    void clipboard.writeText(props.text).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return h(
    'button',
    { type: 'button', className: 'dshjj-copy', onClick: copy, title: props.text, 'aria-label': props.copyLabel },
    copied ? props.copiedLabel : props.copyLabel,
  );
}

/** One collapsible section with a count badge. */
function Section(props: { title: string; count?: number; children?: unknown; defaultOpen?: boolean }): unknown {
  const [open, setOpen] = ReactImpl?.useState(props.defaultOpen !== false) ?? [true, () => {}];
  return h(
    'section',
    { className: 'dshjj-sec' },
    h(
      'div',
      {
        className: 'dshjj-sec-head',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: () => setOpen(!open),
        onKeyDown: (event: { key?: string }) => {
          if (event.key === 'Enter' || event.key === ' ') setOpen(!open);
        },
      },
      h('span', { className: 'dshjj-chevron', 'data-open': open, 'aria-hidden': 'true' }, '▶'),
      h('span', null, props.title),
      props.count === undefined ? null : h('span', { className: 'dshjj-count' }, String(props.count)),
    ),
    open ? h('div', { className: 'dshjj-sec-body' }, props.children) : null,
  );
}

/**
 * Tab body: the read-only Jujutsu panel.
 *
 * Layout: a sticky header (workspace + refresh), then the working-copy card, the change
 * graph (rails, nodes, bookmark labels), sibling workspaces, bookmarks and the operation
 * timeline. Data comes from `/api/jj.overview`; the layout is a pure render of that
 * snapshot, and every failure renders an error card with a retry button instead of
 * blanking the tab.
 *
 * @param props - slot props (`sessionId`, `useSessions`, `t`).
 * @returns the React element tree.
 */
function JjPanelBody(props: TabProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  ensurePanelStyles();
  const fallbackSessions = (): unknown => undefined;
  const useSessions = props.useSessions ?? fallbackSessions;
  const cwd = useSessions((state) => {
    const byId = (state as { byId?: Record<string, { cwd?: unknown }> } | undefined)?.byId;
    const id = typeof props.sessionId === 'string' ? props.sessionId : undefined;
    return id === undefined ? undefined : byId?.[id]?.cwd;
  });
  const [overview, setOverview] = ReactImpl?.useState<Overview | undefined>(undefined) ?? [undefined, () => {}];
  const [reloading, setReloading] = ReactImpl?.useState(false) ?? [false, () => {}];
  const [failure, setFailure] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];
  const [updated, setUpdated] = ReactImpl?.useState<string | undefined>(undefined) ?? [undefined, () => {}];

  ReactImpl?.useEffect(() => {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      setOverview(undefined);
      return undefined;
    }
    let alive = true;
    void fetch(`api/jj.overview?cwd=${encodeURIComponent(cwd)}`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((payload: unknown) => {
        if (alive) {
          setOverview(payload as Overview);
          setFailure(undefined);
          setUpdated(new Date().toLocaleTimeString());
        }
      })
      .catch((error: unknown) => {
        if (alive) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, [cwd, reloading]);

  const reload = (): void => {
    if (typeof cwd !== 'string' || cwd.length === 0) return;
    setReloading(!reloading);
    void fetch('api/jj.refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    }).catch(() => undefined);
  };

  /** Header: workspace identity, last refresh and the refresh button. */
  const header = h(
    'header',
    { className: 'dshjj-head' },
    h(
      'div',
      { className: 'dshjj-head-main' },
      h('span', { className: 'dshjj-title' }, t('title')),
      h(
        'span',
        { className: 'dshjj-head-sub', title: overview?.workspace?.root ?? '' },
        overview?.workspace !== undefined
          ? `${overview.workspace.name} · ${overview.workspace.root}`
          : ((cwd as string | undefined) ?? ''),
      ),
    ),
    updated === undefined ? null : h('span', { className: 'dshjj-updated' }, `${t('updated')} ${updated}`),
    h(
      'button',
      { type: 'button', className: 'dshjj-btn', onClick: reload, 'aria-busy': reloading },
      reloading ? t('refreshing') : t('refresh'),
    ),
  );

  const bodyChildren: unknown[] = [];

  if (failure !== undefined) {
    bodyChildren.push(
      h(
        'div',
        { className: 'dshjj-error' },
        h('span', { className: 'dshjj-error-title' }, t('failed')),
        h('span', { className: 'dshjj-note' }, `${t('failedDetail')}: ${failure}`),
        h('button', { type: 'button', className: 'dshjj-btn', onClick: reload }, t('retry')),
      ),
    );
  } else if (overview === undefined) {
    bodyChildren.push(
      h(
        'div',
        { className: 'dshjj-sec-body', 'aria-busy': true },
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
        h('span', { className: 'dshjj-empty-icon' }, 'jj'),
        h('span', null, overview.reason ?? t('unavailable')),
        h('span', { className: 'dshjj-note' }, t('emptyHint')),
      ),
    );
  } else {
    const copy = overview.workingCopy;
    const stack = overview.stack;
    const bookmarkByCommit = new Map<string, string[]>();
    for (const bookmark of overview.bookmarks) {
      if (bookmark.target === undefined) continue;
      const names = bookmarkByCommit.get(bookmark.target) ?? [];
      names.push(bookmark.name);
      bookmarkByCommit.set(bookmark.target, names);
    }

    if (copy !== undefined) {
      const stateChips: unknown[] = [];
      if (copy.empty) stateChips.push(chip(t('empty'), 'muted'));
      if (copy.conflict) stateChips.push(chip(t('conflict'), 'error'));
      if (!copy.empty && !copy.conflict) stateChips.push(chip(t('clean'), 'brand'));
      if (copy.stale === 'yes') stateChips.push(chip(t('stale'), 'warn'));
      bodyChildren.push(
        h(
          'div',
          { className: 'dshjj-card', 'data-current': true },
          h(
            'div',
            { className: 'dshjj-row-top' },
            h('span', { className: 'dshjj-desc' }, copy.description.length > 0 ? copy.description : t('noDescription')),
            ...stateChips,
          ),
          kv(t('changeId'), shortId(copy.changeId), true),
          kv(t('commitId'), shortId(copy.commitId, 12), true),
        ),
      );
    }

    bodyChildren.push(
      h(
        Section,
        { title: t('stack'), count: stack.length },
        stack.length === 0
          ? h('p', { className: 'dshjj-note' }, t('noStack'))
          : h(
              'div',
              { className: 'dshjj-stack' },
              stack.map((change, index) =>
                h(
                  'div',
                  { className: 'dshjj-stackrow', key: change.changeId },
                  h(
                    'div',
                    { className: 'dshjj-graph' },
                    h('span', {
                      className: 'dshjj-node',
                      'data-current': change.currentWorkingCopy,
                      'data-conflict': change.conflict,
                      'data-empty': change.empty,
                    }),
                    index === stack.length - 1 ? null : h('span', { className: 'dshjj-rail' }),
                  ),
                  h(
                    'div',
                    { className: 'dshjj-row' },
                    h(
                      'div',
                      { className: 'dshjj-row-top' },
                      h(
                        'span',
                        { className: 'dshjj-desc', 'data-muted': change.description.length === 0 },
                        change.description.length > 0 ? change.description : t('noDescription'),
                      ),
                      change.currentWorkingCopy ? chip('@', 'brand') : null,
                      change.empty ? chip(t('empty'), 'muted') : null,
                      change.conflict ? chip(t('conflict'), 'error') : null,
                    ),
                    h(
                      'div',
                      { className: 'dshjj-row-sub' },
                      h('span', { className: 'dshjj-id' }, shortId(change.changeId)),
                      h('span', { className: 'dshjj-id' }, shortId(change.commitId, 8)),
                      ...(bookmarkByCommit.get(change.commitId) ?? []).map((name) => chip(name, 'brand')),
                      h(CopyButton, {
                        text: change.changeId,
                        copyLabel: t('copy'),
                        copiedLabel: t('copied'),
                      }),
                    ),
                  ),
                ),
              ),
            ),
      ),
    );

    bodyChildren.push(
      h(
        Section,
        { title: t('workspaces'), count: overview.workspaces.length },
        overview.workspaces.map((workspace) =>
          h(
            'div',
            { className: 'dshjj-card', key: workspace.name, 'data-current': workspace.current },
            h(
              'div',
              { className: 'dshjj-row-top' },
              h('span', { className: 'dshjj-desc' }, workspace.name),
              workspace.current ? chip(t('current'), 'brand') : null,
              workspace.stale === 'yes' ? chip(t('stale'), 'warn') : null,
              workspace.conflict ? chip(t('conflict'), 'error') : null,
            ),
            kv(t('root'), workspace.root, true),
            kv(t('changeId'), shortId(workspace.changeId), true),
            kv(t('description'), workspace.description.length > 0 ? workspace.description : t('noDescription')),
          ),
        ),
      ),
    );

    bodyChildren.push(
      h(
        Section,
        { title: t('bookmarks'), count: overview.bookmarks.length },
        overview.bookmarks.length === 0
          ? h('p', { className: 'dshjj-note' }, t('noBookmarks'))
          : h(
              'div',
              { className: 'dshjj-row-sub' },
              overview.bookmarks.map((bookmark) =>
                chip(
                  bookmark.conflicted
                    ? `${bookmark.name} ${t('conflict')}`
                    : bookmark.target === undefined
                      ? bookmark.name
                      : `${bookmark.name} @ ${shortId(bookmark.target, 8)}`,
                  bookmark.conflicted ? 'error' : 'muted',
                ),
              ),
            ),
      ),
    );

    bodyChildren.push(
      h(
        Section,
        { title: t('operations'), count: overview.operations.length, defaultOpen: false },
        overview.operations.length === 0
          ? h('p', { className: 'dshjj-note' }, t('empty'))
          : h(
              'div',
              { className: 'dshjj-ops' },
              overview.operations.map((operation) => [
                h('span', { className: 'dshjj-op-time', key: `${operation.id}-t` }, timeOf(operation.time)),
                h(
                  'span',
                  {
                    className: 'dshjj-op-desc',
                    'data-snapshot': operation.isSnapshot,
                    key: operation.id,
                    title: operation.id,
                  },
                  operation.description,
                  operation.workspaceName !== null ? ` · ${operation.workspaceName}` : '',
                ),
              ]),
            ),
      ),
    );

    bodyChildren.push(h('span', { className: 'dshjj-foot' }, t('readOnly')));
  }

  return h('div', { className: 'dshjj' }, header, h('div', { className: 'dshjj-body' }, ...bodyChildren));
}

/** Slot props the framework composes for a keyed tool view. */
interface ToolViewProps {
  readonly phase?: string;
  readonly block?: unknown;
  readonly t?: (key: string) => string;
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

/** Human-readable state of one tool call. */
function callState(props: ToolViewProps, t: (key: string) => string): string {
  if (props.phase === 'preparing' || props.phase === 'start') return t('running');
  const block = recordOf(props.block);
  if (block?.['isError'] === true) return t('failedCall');
  return '';
}

/** One compact tool card: a title row plus at most three detail lines. */
function toolCard(props: ToolViewProps, title: string, summary: string, lines: readonly string[]): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const state = callState(props, t);
  return h(
    'div',
    { className: 'dshjj-card' },
    h(
      'div',
      { className: 'dshjj-row-top' },
      h('span', { className: 'dshjj-k' }, title),
      h('span', { className: 'dshjj-desc' }, summary),
      state.length > 0 ? chip(state, 'muted') : null,
    ),
    ...lines
      .filter((line) => line.length > 0)
      .slice(0, 3)
      .map((line) => h('span', { className: 'dshjj-note' }, line)),
  );
}

/** `jj_status` card: where the working copy is, plus the diff summary when asked for. */
function JjStatusCard(props: ToolViewProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const args = toolArgs(props.block);
  const result = toolResult(props.block);
  const changeId = typeof result?.['changeId'] === 'string' ? shortId(result['changeId']) : '';
  const description = typeof result?.['description'] === 'string' ? result['description'] : '';
  const state: string[] = [];
  if (result?.['empty'] === true) state.push(t('empty'));
  if (result?.['conflict'] === true) state.push(t('conflict'));
  const lines: string[] = [];
  if (typeof result?.['diffStat'] === 'string') lines.push(result['diffStat'].split('\n')[0] ?? '');
  if (args?.['details'] === true) lines.push(t('workingCopy'));
  return toolCard(props, t('statusCard'), [changeId, description, ...state].filter(Boolean).join(' · '), lines);
}

/** `jj_log` card: the requested revset and how many revisions came back. */
function JjLogCard(props: ToolViewProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const args = toolArgs(props.block);
  const revset = typeof args?.['revset'] === 'string' ? args['revset'] : '@ | @-';
  const result = toolResult(props.block);
  const count = Array.isArray(result?.['changes']) ? result['changes'].length : undefined;
  return toolCard(props, t('logCard'), revset, count === undefined ? [] : [`${count} revisions`]);
}

/** `jj_workspace_list` card: how many workspaces share the repository. */
function JjWorkspacesCard(props: ToolViewProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const result = toolResult(props.block);
  const workspaces = Array.isArray(result?.['workspaces']) ? result['workspaces'] : undefined;
  const names = (workspaces ?? [])
    .map((workspace) => recordOf(workspace)?.['name'])
    .filter((name): name is string => typeof name === 'string');
  return toolCard(props, t('workspacesCard'), names.length > 0 ? names.join(', ') : '', []);
}

/** `jj_handoff` card: destination and how the integration ended. */
function JjHandoffCard(props: ToolViewProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const result = toolResult(props.block);
  const destination = typeof result?.['destination'] === 'string' ? result['destination'] : '';
  const rebased = result?.['rebased'] === true;
  const conflicts = Array.isArray(result?.['conflicts']) ? result['conflicts'].length : 0;
  const actions = Array.isArray(result?.['nextActions']) ? result['nextActions'] : [];
  const firstAction = recordOf(actions[0]);
  const reason = typeof firstAction?.['reason'] === 'string' ? firstAction['reason'] : '';
  return toolCard(props, t('handoffCard'), destination, [
    rebased ? 'rebased' : 'already integrated',
    conflicts > 0 ? `${conflicts} ${t('conflicts')}` : t('noConflicts'),
    reason,
  ]);
}

/** Tab title: the localized name printed on the tab chip. */
function JjPanelTitle(props: { readonly t?: (key: string) => string }): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  return t('title');
}

/**
 * Client plugin entry: register the locale dictionaries, the tab type and its body.
 *
 * Everything is optional on purpose: a Host assembled without the sidebar-right plugin
 * must still load this bundle (it simply registers nothing), because a client bundle
 * that throws during activation breaks the whole page.
 *
 * @param ctx - the client plugin context.
 */
function apply(ctx: ClientContext): void {
  try {
    ctx.locale?.register?.(JJ_LOCALE_NS, DICTIONARIES);
  } catch {
    // Localization is cosmetic: a failure here must not stop the tab registration.
  }
  // `title` and every guide `title`/`description` are functions the sidebar calls
  // lazily (the guide entry type is an ARRAY); a string here throws at registration and
  // silently removes the tab, which is exactly how the tab "disappeared" once.
  const t =
    typeof ctx.locale?.bind === 'function'
      ? ctx.locale.bind(JJ_LOCALE_NS)
      : (key: string) => DICTIONARIES.en?.[key] ?? key;
  if (ctx.sidebarRightTabs === undefined) {
    // Never fail silently again: a missing injected service is a wiring bug, not a
    // missing product feature, so say so where a developer will see it.
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
    // Without the sidebar-right plugin there is no place to mount the tab, but a real
    // registration failure must be visible: this exact path hid a wrong declaration
    // shape for two release cycles of testing.
    console.error('[dsh-jj] sidebar tab registration failed:', error);
  }
  const registerBody = (): unknown =>
    ctx.slots?.register?.({ name: 'sidebar.right.pane.tab', key: JJ_TAB_ID, locale: JJ_LOCALE_NS }, JjPanelBody);
  const registerTitle = (): unknown =>
    ctx.slots?.register?.({ name: 'sidebar.right.pane.tab.title', key: JJ_TAB_ID }, JjPanelTitle);
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
  // Keyed tool views: the key is the wire tool name, so a typo silently falls back to
  // the generic row (that is the framework contract). Cards only summarize; the full
  // JSON stays available through the generic call payload.
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

/**
 * Cordis client services this bundle waits for before `apply` runs.
 *
 * `sidebarRightTabs` is required, not just `sidebarRight`: the tab-type registry is a
 * separate service, and without it in this list the client runtime does not expose it to
 * `apply` — the registration was silently skipped and the tab never appeared (the
 * optional chaining hid the missing service).
 */
const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

// The host evaluates this file as a classic script: register the lazy factory once.
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
    // React is provided by the host's frozen module table; the bundle never ships its own.
    ReactImpl = require('react') as ReactLike;
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
