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
    title: 'Jujutsu',
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
    title: 'Jujutsu',
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

/** Design tokens only: the official theme owns every colour, size and radius. */
const STYLE = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '10px 12px',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: 1.5,
    minHeight: 0,
    overflow: 'auto',
  },
  sectionTitle: {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px',
    margin: '2px 0 0',
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    borderRadius: 'var(--dsw-radius-md)',
    padding: '4px 6px',
  },
  mono: {
    fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  chip: {
    borderRadius: 'var(--dsw-radius-sm)',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px',
    padding: '0 4px',
  },
  note: {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px',
    margin: 0,
  },
  action: {
    alignSelf: 'flex-start',
    borderRadius: 'var(--dsw-radius-sm)',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'none',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px',
    padding: '2px 8px',
    cursor: 'pointer',
  },
} as const;

/** React implementation captured from the host module factory. */
let ReactImpl: ReactLike | undefined;

/** Create one element (the bundle cannot use JSX: it is a classic script). */
function h(type: unknown, props?: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown {
  return ReactImpl?.createElement(type, props, ...children);
}

/** Short change/commit id for display. */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/** One labelled row with an optional trailing chip. */
function row(label: unknown, value: unknown, chip?: string): unknown {
  return h(
    'div',
    { style: STYLE.row, key: String(label) },
    h('span', { style: STYLE.mono }, label),
    h(
      'span',
      { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      value,
    ),
    chip === undefined ? null : h('span', { style: STYLE.chip }, chip),
  );
}

/**
 * Tab body: fetch the read-only overview and render the four sections.
 *
 * The request is document-relative (the host serves the Web app from a route prefix) and
 * carries the session's working directory, which the framework exposes through the
 * session-scoped slot props. Every failure renders a short note instead of an error.
 *
 * @param props - slot props (`sessionId`, `useSessions`, `t`).
 * @returns the React element tree.
 */
function JjPanelBody(props: TabProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const fallbackSessions = (): unknown => undefined;
  const useSessions = props.useSessions ?? fallbackSessions;
  const cwd = useSessions((state) => {
    const byId = (state as { byId?: Record<string, { cwd?: unknown }> } | undefined)?.byId;
    const id = typeof props.sessionId === 'string' ? props.sessionId : undefined;
    return id === undefined ? undefined : byId?.[id]?.cwd;
  });
  const [overview, setOverview] = ReactImpl?.useState<Overview | undefined>(undefined) ?? [undefined, () => {}];
  const [reloading, setReloading] = ReactImpl?.useState(false) ?? [false, () => {}];
  const [failed, setFailed] = ReactImpl?.useState(false) ?? [false, () => {}];

  ReactImpl?.useEffect(() => {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      setOverview(undefined);
      return undefined;
    }
    let alive = true;
    void fetch(`api/jj.overview?cwd=${encodeURIComponent(cwd)}`, {
      headers: { accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((payload: unknown) => {
        if (alive) {
          setOverview(payload as Overview);
          setFailed(false);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [cwd, reloading]);

  const reload = (): void => {
    if (typeof cwd === 'string' && cwd.length > 0) {
      setReloading(!reloading);
      void fetch('api/jj.refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd }),
      }).catch(() => undefined);
    }
  };

  const children: unknown[] = [
    h(
      'p',
      { style: STYLE.sectionTitle, key: 'title' },
      overview?.workspace !== undefined
        ? `${overview.workspace.name} · ${overview.workspace.kind} · ${overview.workspace.root}`
        : t('workingCopy'),
    ),
  ];
  if (failed) children.push(h('p', { style: STYLE.note, key: 'failed' }, t('failed')));
  if (overview === undefined) {
    children.push(h('p', { style: STYLE.note, key: 'loading' }, t('loading')));
  } else if (overview.reason !== undefined || overview.workspace === undefined) {
    children.push(h('p', { style: STYLE.note, key: 'unavailable' }, overview.reason ?? t('unavailable')));
  } else {
    const copy = overview.workingCopy;
    if (copy !== undefined) {
      const chips = [copy.empty ? t('empty') : t('clean'), copy.conflict ? t('conflict') : ''].filter(
        (chip) => chip.length > 0,
      );
      children.push(
        h('p', { style: STYLE.sectionTitle, key: 'wc-title' }, t('workingCopy')),
        row(
          shortId(copy.changeId),
          copy.description.length > 0 ? copy.description : t('noDescription'),
          chips.join(' · '),
        ),
      );
    }
    children.push(h('p', { style: STYLE.sectionTitle, key: 'stack-title' }, t('stack')));
    if (overview.stack.length === 0) children.push(h('p', { style: STYLE.note, key: 'stack-empty' }, t('noStack')));
    for (const change of overview.stack) {
      children.push(
        row(
          shortId(change.changeId),
          change.description.length > 0 ? change.description : t('noDescription'),
          change.currentWorkingCopy ? '@' : change.conflict ? t('conflict') : undefined,
        ),
      );
    }
    children.push(h('p', { style: STYLE.sectionTitle, key: 'ws-title' }, t('workspaces')));
    for (const workspace of overview.workspaces) {
      children.push(row(workspace.name, workspace.root, workspace.current ? t('current') : undefined));
    }
    children.push(h('p', { style: STYLE.sectionTitle, key: 'marks-title' }, t('bookmarks')));
    if (overview.bookmarks.length === 0)
      children.push(h('p', { style: STYLE.note, key: 'marks-empty' }, t('noBookmarks')));
    for (const bookmark of overview.bookmarks) {
      children.push(
        row(
          bookmark.name,
          bookmark.target === undefined ? '' : shortId(bookmark.target),
          bookmark.conflicted ? t('conflict') : undefined,
        ),
      );
    }
    children.push(h('p', { style: STYLE.sectionTitle, key: 'ops-title' }, t('operations')));
    for (const operation of overview.operations) {
      children.push(row(operation.shortId, operation.description));
    }
  }
  children.push(
    h(
      'button',
      { type: 'button', style: STYLE.action, onClick: reload, 'aria-pressed': reloading, key: 'refresh' },
      t('refresh'),
    ),
  );
  return h('div', { style: STYLE.page, className: 'dshjj-panel' }, children);
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
  if (props.phase === 'preparing') return t('running');
  if (props.phase === 'start') return t('running');
  const block = recordOf(props.block);
  if (block?.['isError'] === true) return t('failedCall');
  return '';
}

/** One compact tool card: a title row plus at most three detail lines. */
function toolCard(props: ToolViewProps, title: string, summary: string, lines: readonly string[]): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const state = callState(props, t);
  const chips = [summary, state].filter((chip) => chip.length > 0);
  return h(
    'div',
    {
      className: 'dshjj-toolview',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        borderRadius: 'var(--dsw-radius-md)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        padding: '6px 8px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
      h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, title),
      h(
        'span',
        {
          style: {
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        chips.join(' · '),
      ),
    ),
    ...lines
      .filter((line) => line.length > 0)
      .slice(0, 3)
      .map((line) =>
        h(
          'span',
          {
            style: {
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: '12px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          line,
        ),
      ),
  );
}

/** `jj_status` card: where the working copy is, plus the diff summary when asked for. */
function JjStatusCard(props: ToolViewProps): unknown {
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const args = toolArgs(props.block);
  const result = toolResult(props.block);
  const changeId = typeof result?.['changeId'] === 'string' ? shortId(result['changeId']) : '';
  const description = typeof result?.['description'] === 'string' ? result['description'] : '';
  const chips: string[] = [];
  if (result?.['empty'] === true) chips.push(t('empty'));
  if (result?.['conflict'] === true) chips.push(t('conflict'));
  const lines: string[] = [];
  if (typeof result?.['diffStat'] === 'string') lines.push(result['diffStat'].split('\n')[0] ?? '');
  if (args?.['details'] === true) lines.push(t('workingCopy'));
  return toolCard(props, t('statusCard'), [changeId, description, ...chips].filter(Boolean).join(' · '), lines);
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
  } catch {
    // Without the sidebar-right plugin there is no place to mount the tab.
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

/** Cordis client services this bundle waits for before `apply` runs. */
const inject = ['slots', 'locale', 'sidebarRight'];

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
