/**
 * The Cordis `ctx.jj` service: TTL detection cache and the disposal ladder.
 *
 * Extracted from `service.ts`; that barrel re-exports this module, and this file
 * imports `JjOperations` back from it. The intentional ESM cycle is safe: the
 * `JjOperations` binding is only read inside the `JjService` constructor, i.e.
 * after both modules have finished evaluating. Nothing at module-evaluation time
 * depends on it.
 *
 * @module dsh-jj/jj-service
 */

import { Service, type Context } from '@deepseek-ai/cordis';
import { assertServiceableConfig, Config, resolveConfig, type JjPluginConfig } from './config.ts';
import { detectVcs } from './detect.ts';
import { createRunGit, createRunJj } from './jj-command.ts';
import { JjOperations } from './service.ts';
import type { VcsDescriptor, VcsKind } from './types.ts';

/**
 * Merge the service-lifetime abort signal with a caller signal.
 *
 * Disposal aborts the lifetime controller, so merging it into every runner call is
 * what makes the documented disposal ladder ("abort → settle pending → clear cache")
 * actually cancel in-flight `jj`/`git` work instead of awaiting it until its timeout.
 * `AbortSignal.any` is available on the supported Node versions; the fallback keeps
 * older hosts working by forwarding both sources into one controller.
 *
 * @param lifetime - controller aborted by {@link JjService} disposal.
 * @param caller - per-call cancellation signal, when the caller supplied one.
 * @returns a signal that aborts when either source aborts.
 */
function mergeAbortSignals(lifetime: AbortSignal, caller?: AbortSignal): AbortSignal {
  if (caller === undefined) return lifetime;
  const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') return anyOf([lifetime, caller]);
  const controller = new AbortController();
  const onLifetime = (): void => controller.abort(lifetime.reason);
  const onCaller = (): void => controller.abort(caller.reason);
  if (lifetime.aborted) onLifetime();
  else lifetime.addEventListener('abort', onLifetime, { once: true });
  if (caller.aborted) onCaller();
  else caller.addEventListener('abort', onCaller, { once: true });
  controller.signal.addEventListener(
    'abort',
    () => {
      lifetime.removeEventListener('abort', onLifetime);
      caller.removeEventListener('abort', onCaller);
    },
    { once: true },
  );
  return controller.signal;
}

/**
 * `ctx.jj` — the Cordis service face of {@link JjOperations}.
 *
 * The TTL cache is what makes the synchronous guard possible: `peek` never
 * spawns, `warm` refreshes, and disposal aborts in-flight work and clears it.
 * Concurrent probes for one cwd are coalesced (one `detectVcs` per in-flight key)
 * and the cache is pruned so a long-lived process with many workspaces cannot grow
 * it without bound.
 */
export class JjService extends Service {
  /** Hard cap on cached descriptors (one descriptor is ≈1.5 KB in JSON). */
  static readonly DETECT_CACHE_MAX_ENTRIES = 64;
  /** Cached descriptors older than max(ttl × 6, 5 min) are pruned on refresh. */
  static readonly DETECT_CACHE_MIN_MAX_AGE_MS = 5 * 60_000;

  static inject = ['subprocess', 'workingDirectory'];
  static Config = Config;

  readonly operations: JjOperations;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cache = new Map<string, { descriptor: VcsDescriptor; probedAt: number }>();
  /** In-flight detection per cache key; concurrent detect/warm calls share one probe. */
  private readonly inflight = new Map<string, Promise<VcsDescriptor>>();

  constructor(ctx: Context, config: JjPluginConfig = {}) {
    super(ctx, 'jj');
    const resolved = resolveConfig(config);
    assertServiceableConfig(resolved);
    this.operations = new JjOperations({
      config,
      // Every operation runs through the lifetime signal so disposal cancels in-flight
      // jj calls instead of blocking `Promise.allSettled(pending)` until their timeout.
      runJj: (options) =>
        this.track(createRunJj(ctx, resolved)({ ...options, signal: mergeAbortSignals(this.lifetime.signal, options.signal) })),
    });
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('dsh-jj service disposed'));
      await Promise.allSettled(this.pending);
      this.pending.clear();
      this.inflight.clear();
      this.cache.clear();
    });
  }

  /** Track one in-flight jj call so disposal can settle it. */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** TTL-cached detection (contract §6.4). */
  async detect(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor> {
    const key = this.cacheKey(cwd);
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() - cached.probedAt <= this.operations.config.detectCacheTtlMs) {
      return cached.descriptor;
    }
    return await this.warm(cwd, signal);
  }

  /**
   * Forced refresh of the detection cache.
   *
   * Concurrent calls for the same cwd share one probe: the guard warm-up and
   * parallel tool calls would otherwise each run the full 5-process `detectVcs`.
   * The shared probe is cleaned up on success and on failure.
   */
  async warm(cwd: string, signal?: AbortSignal): Promise<VcsDescriptor> {
    const key = this.cacheKey(cwd);
    const pendingProbe = this.inflight.get(key);
    if (pendingProbe !== undefined) return await pendingProbe;
    const probe = (async (): Promise<VcsDescriptor> => {
      const descriptor = await detectVcs(cwd, this.detectDeps(), mergeAbortSignals(this.lifetime.signal, signal));
      this.cache.set(key, { descriptor, probedAt: descriptor.probedAt });
      this.pruneCache();
      return descriptor;
    })();
    const tracked = this.track(probe);
    this.inflight.set(key, tracked);
    try {
      return await tracked;
    } finally {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    }
  }

  /**
   * Keep the synchronous cache bounded: drop stale entries and evict the oldest
   * descriptors above {@link JjService.DETECT_CACHE_MAX_ENTRIES}.
   */
  private pruneCache(): void {
    const ttl = this.operations.config.detectCacheTtlMs;
    const maxAge = Math.max(ttl * 6, JjService.DETECT_CACHE_MIN_MAX_AGE_MS);
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.probedAt > maxAge) this.cache.delete(key);
    }
    if (this.cache.size <= JjService.DETECT_CACHE_MAX_ENTRIES) return;
    const oldestFirst = [...this.cache.entries()].sort((left, right) => left[1].probedAt - right[1].probedAt);
    for (const [key] of oldestFirst.slice(0, this.cache.size - JjService.DETECT_CACHE_MAX_ENTRIES)) {
      this.cache.delete(key);
    }
  }

  /** Synchronous cache read for the guard; `undefined` on a miss (fail-open). */
  peek(cwd: string): VcsDescriptor | undefined {
    return this.cache.get(this.cacheKey(cwd))?.descriptor;
  }

  /** Single-line human summary (contract §5.4). */
  describe(target: VcsDescriptor | VcsKind): string {
    if (typeof target === 'string') {
      switch (target) {
        case 'git':
          return 'Git repository (no Jujutsu workspace)';
        case 'jj-native':
          return 'Jujutsu (jj) native repository';
        case 'jj-colocated':
          return 'Jujutsu (jj) colocated with Git';
        case 'none':
          return 'No repository';
      }
    }
    const descriptor = target;
    return `${descriptor.kind} workspace "${descriptor.workspaceName ?? 'unknown'}" at ${descriptor.root} (${descriptor.jjVersion ?? 'jj version unknown'})`;
  }

  private cacheKey(cwd: string): string {
    try {
      return resolveKey(cwd);
    } catch {
      return cwd;
    }
  }

  private detectDeps() {
    const resolved = this.operations.config;
    return {
      runJj: createRunJj(this.ctx, resolved),
      runGit: createRunGit(this.ctx, resolved),
      jjCommand: resolved.jjCommand,
      gitCommand: resolved.gitCommand,
      timeoutMs: resolved.timeoutMs,
    };
  }
}

function resolveKey(cwd: string): string {
  // path.resolve without realpath: the guard's sync path cannot do I/O.
  return cwd.startsWith('/') ? cwd.replace(/\/+$/, '') || '/' : cwd;
}
