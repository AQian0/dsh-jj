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
  };
  effect?(body: () => unknown, label?: string): unknown;
}

/** Translation dictionaries; both baselines are required by the client locale service. */
const DICTIONARIES: Record<string, Record<string, string>> = {
  zh: {
    title: 'Jujutsu',
    loading: '正在读取 jj 状态…',
    unavailable: '这个会话不在 jj 仓库中，或 jj 服务不可用。',
    refresh: '刷新',
    empty: '暂无可显示的内容。',
  },
  en: {
    title: 'Jujutsu',
    loading: 'Reading jj status…',
    unavailable: 'This session is not in a jj workspace, or the jj service is unavailable.',
    refresh: 'Refresh',
    empty: 'Nothing to show yet.',
  },
};

/**
 * Tab body: a placeholder that the data slice replaces with the overview sections.
 *
 * @param props - slot props; only the translation function is used.
 * @returns the React element tree.
 */
function JjPanelBody(props: { readonly t?: (key: string) => string; readonly React?: ReactLike }): unknown {
  const React = props.React;
  if (React === undefined) return null;
  const t = props.t ?? ((key: string) => DICTIONARIES.en?.[key] ?? key);
  const [refreshing, setRefreshing] = React.useState(false);
  React.useEffect(() => {
    // Data loading arrives with the overview slice; keep the body side-effect free.
    setRefreshing(false);
  }, []);
  const refresh = (): void => setRefreshing(!refreshing);
  return React.createElement(
    'div',
    { className: 'dshjj-panel' },
    React.createElement('p', { className: 'dshjj-panel__note' }, t('loading')),
    React.createElement('p', { className: 'dshjj-panel__note' }, t('empty')),
    React.createElement(
      'button',
      { type: 'button', className: 'dshjj-panel__action', onClick: refresh, 'aria-pressed': refreshing },
      t('refresh'),
    ),
  );
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
  try {
    ctx.sidebarRightTabs?.register?.({
      id: JJ_TAB_ID,
      kind: 'jj',
      title: 'Jujutsu',
      guide: { title: 'Jujutsu', description: 'Working copy, stack, workspaces and bookmarks.' },
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
    void require; // React is required by the data slice; the skeleton renders text only.
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
