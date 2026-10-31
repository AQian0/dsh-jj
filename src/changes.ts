/**
 * jj-backed workspace-change recording for the Web "changed files" card.
 *
 * DSH's built-in `workspace-changes` plugin records each turn's changed files
 * from Git working-tree snapshots. That works in a colocated jj repository, but
 * a jj-native workspace (`.jj` only) has no Git work tree to snapshot, and even
 * in a colocated repository the Git index is not Jujutsu's authority: changes
 * made through jj commands, linked jj workspaces, and any repository whose Git
 * view is stale are invisible to it.
 *
 * This entry replaces the provider for profiles where the bundle disables the
 * built-in row:
 *
 * - **`auto`** (default): the built-in recorder runs in an isolated Cordis
 *   service scope (so it still records Git/capture-based summaries for every
 *   non-jj Session), while a jj recorder snapshots the working-copy commit at
 *   turn start and diffs it at turn end for every Session inside a jj
 *   workspace. The `workspaceChanges` service the Host sees is a bridge that
 *   merges both recorders' summaries: jj data wins for files both report, and
 *   the built-in recorder still contributes file-tool captures it alone saw.
 * - **`builtin`**: keep the built-in behavior exactly (no jj recording). Use it
 *   to compare behavior or as an escape hatch.
 * - **`off`**: provide no `workspaceChanges` service at all; the deliverables
 *   card stays off.
 *
 * Recording is a best-effort side channel: every jj failure (missing binary,
 * broken repository, stale working copy, truncated output) resolves to "no
 * summary for this turn", never to a broken turn. If another plugin already
 * provides `workspaceChanges`, this entry warns and does nothing instead of
 * failing the profile.
 *
 * @module dsh-jj/changes
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceChanges } from '@deepseek-ai/dsh-workspace-changes/types';
import { resolveConfig, type ResolvedJjConfig } from './config.ts';
import { createRunJj } from './jj-command.ts';
import { createChangesService } from './changes-service.ts';
import { createJjChangesReader } from './changes-jj.ts';
import { TurnChangesRecorder, type ChangesSessionLike } from './changes-recorder.ts';
import { sniffVcsSync } from './detect.ts';
import type { VcsSniff } from './types.ts';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';

/** Stable Loader identity of the jj workspace-change row. */
export const name = 'jj-changes';

/**
 * Services this row consumes.
 *
 * `jj` is the runtime row: it supplies the resolved jj command and process
 * limits the recorder reuses instead of introducing a second set of config
 * keys. A profile that removes the runtime row cannot load this one, which is
 * already true of the tools and guard rows.
 */
export const inject = ['subprocess', 'fs', 'jj'] as const;

/**
 * How this row serves the Host's `workspaceChanges` service.
 *
 * - `auto`: jj recording for jj-workspace Sessions plus the built-in recorder
 *   for everything else, merged per turn.
 * - `builtin`: the unmodified built-in recorder (no jj recording).
 * - `off`: leave the service unprovided so the changed-files card is disabled.
 */
export const WORKSPACE_CHANGES_MODES = ['auto', 'builtin', 'off'] as const;
export type WorkspaceChangesMode = (typeof WORKSPACE_CHANGES_MODES)[number];

/** Cordis config schema for the `jj-changes` bundle row. */
export const Config = z.object({
  /** Serving strategy; see {@link WORKSPACE_CHANGES_MODES}. */
  workspaceChanges: z.union(['auto', 'builtin', 'off']).default('auto'),
  /** Maximum files one summary carries; `total` still reports the complete count. */
  maxFiles: z.natural().default(500),
  /** Largest per-file diff the comparison view serves; a larger change is refused as oversized. */
  maxFileBytes: z.natural().default(2 * 1024 * 1024),
  /** Bytes of `jj diff` output retained per turn; a larger diff abandons that turn's record. */
  outputMaxBytes: z.natural().default(8 * 1024 * 1024),
  /** Milliseconds the built-in recorder's line comparison may run before it degrades. */
  diffTimeoutMs: z.natural().default(100),
});

/** Resolved configuration of the `jj-changes` row (schema defaults applied). */
export type ResolvedChangesConfig = Schemastery.TypeT<typeof Config>;

/** Configuration accepted by {@link apply} (every key optional; defaults from {@link Config}). */
export type ChangesConfig = Partial<ResolvedChangesConfig>;

/** Schema defaults: the single source of truth for this row's resolved values. */
const SCHEMA_DEFAULTS: ResolvedChangesConfig = Config({});

/**
 * Apply contract defaults to a partial configuration.
 *
 * @param config - partial plugin configuration (schema-validated when the Cordis
 *   loader mounts this row).
 * @returns a fully populated configuration.
 */
export function resolveChangesConfig(config: ChangesConfig = {}): ResolvedChangesConfig {
  const resolved: ResolvedChangesConfig = { ...SCHEMA_DEFAULTS };
  const writable = resolved as Record<string, unknown>;
  for (const key of Object.keys(SCHEMA_DEFAULTS) as (keyof ResolvedChangesConfig)[]) {
    const value = config[key];
    if (value !== undefined) writable[key] = value;
  }
  return resolved;
}

/**
 * Construction-time validation of the bound values.
 *
 * @param config - resolved configuration.
 * @throws Error naming the offending key when a bound is not a positive safe integer.
 */
function assertServiceableChangesConfig(config: ResolvedChangesConfig): void {
  for (const key of ['maxFiles', 'maxFileBytes', 'outputMaxBytes', 'diffTimeoutMs'] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-jj: \`${key}\` must be a positive safe integer, received ${String(value)}`);
    }
  }
}

/** The subset of one DSH Session this row reads. */
interface SessionLike {
  readonly id?: unknown;
  readonly header?: {
    readonly cwd?: unknown;
    readonly origin?: unknown;
    readonly delegationDepth?: unknown;
  };
  append?: unknown;
}

/** The subset of one Session event this row reads. */
interface SessionEventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly data?: unknown;
}

/** Host logger surface used for diagnostics. */
interface LoggerLike {
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

/** A permissive listener registration view of the context (event names are host-owned). */
type Listen = (event: string, listener: (...args: unknown[]) => unknown) => unknown;

/** Read one non-empty string field off an unknown record. */
function stringField(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : undefined;
}

/** Read one finite non-negative integer field off an unknown record. */
function turnField(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const turn = (value as Record<string, unknown>)['turn'];
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined;
}

/** Canonical home directory used for `~` display paths; best effort outside symlinks. */
function canonicalHome(): string {
  const home = homedir();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/** Whether one Session is a top-level user Session the recorders are allowed to summarize. */
function isTopLevelSession(session: SessionLike): boolean {
  const header = session.header;
  if (header === undefined) return true;
  if (header.origin === 'subagent') return false;
  const depth = header.delegationDepth;
  return !(typeof depth === 'number' && depth > 0);
}

/**
 * Whether `cwd` is inside a Jujutsu workspace that jj itself owns.
 *
 * The nearest marker wins (the detection contract's F5/F6 rules): a Git
 * repository nested inside a jj workspace is reported as `git`, and the
 * built-in recorder keeps owning it. A stray `.jj` directory without a usable
 * `.jj/repo` pointer is not treated as a workspace.
 *
 * @param cwd - absolute Session working directory.
 * @returns the jj workspace root, or undefined when jj does not own this directory.
 */
export function jjWorkspaceRootAt(cwd: string): string | undefined {
  let sniff: VcsSniff;
  try {
    sniff = sniffVcsSync(cwd);
  } catch {
    return undefined;
  }
  if (
    (sniff.kind !== 'jj-native' && sniff.kind !== 'jj-colocated') ||
    sniff.jjRoot === undefined ||
    sniff.jjRepoPath === undefined
  ) {
    return undefined;
  }
  return sniff.jjRoot;
}

/**
 * Observe top-level turns of every Session with a working directory, record jj
 * workspace changes for those inside a Jujutsu workspace, and serve the merged
 * summaries and comparisons as the Host's `workspaceChanges` service.
 *
 * @param ctx - Host context providing `subprocess`, `fs`, and `jj`.
 * @param config - partial row configuration; the Cordis loader passes the schema-resolved value.
 */
export async function apply(ctx: Context, config: ChangesConfig = {}): Promise<void> {
  const resolved = resolveChangesConfig(config);
  assertServiceableChangesConfig(resolved);
  const logger = (ctx as unknown as { logger?: LoggerLike }).logger;
  const warn = (message: string): void => {
    try {
      logger?.warn?.(message);
    } catch {
      // Diagnostics must never break plugin startup or a turn.
    }
  };
  const info = (message: string): void => {
    try {
      logger?.info?.(message);
    } catch {}
  };
  if (resolved.workspaceChanges === 'off') {
    info('dsh-jj changes: `workspaceChanges: off`; no changed-files summary is served');
    return;
  }
  const existing = ctx.get('workspaceChanges', false);
  if (existing !== undefined) {
    warn(
      'dsh-jj changes: another plugin already provides `workspaceChanges`; ' +
        'jj workspace-change recording is disabled. Disable the other provider or set `workspaceChanges: off`.',
    );
    return;
  }
  let upstream: typeof import('@deepseek-ai/dsh-workspace-changes') | undefined;
  try {
    // Imported dynamically so a profile without the deliverables bundle (for example
    // a headless one) still boots: this row then degrades to no service instead of
    // failing module resolution for the whole profile.
    upstream = await import('@deepseek-ai/dsh-workspace-changes');
  } catch (error) {
    warn(
      `dsh-jj changes: the host does not provide \`@deepseek-ai/dsh-workspace-changes\` (${String(error)}); ` +
        'changed-files recording is disabled',
    );
    return;
  }
  const runtime = (ctx as unknown as { jj?: { operations?: { config?: ResolvedJjConfig } } }).jj;
  const runtimeConfig = runtime?.operations?.config ?? resolveConfig({});
  const upstreamConfig = upstream.Config({
    timeoutMs: runtimeConfig.timeoutMs,
    outputMaxBytes: resolved.outputMaxBytes,
    maxFiles: resolved.maxFiles,
    maxFileBytes: resolved.maxFileBytes,
    diffTimeoutMs: resolved.diffTimeoutMs,
  });
  try {
    if (resolved.workspaceChanges === 'builtin') {
      upstream.apply(ctx, upstreamConfig);
      info('dsh-jj changes: `workspaceChanges: builtin`; only the built-in recorder is active');
      return;
    }
    // Isolate the built-in provider so it can be composed with the jj recorder
    // instead of owning the Host-facing service: two providers of the same
    // service name cannot share one Cordis scope.
    const isolated = ctx.isolate('workspaceChanges');
    upstream.apply(isolated, upstreamConfig);
    const builtin = isolated.get('workspaceChanges', false) as WorkspaceChanges | undefined;
    if (builtin === undefined) {
      warn(
        'dsh-jj changes: the built-in workspace-changes recorder did not start; changed-files recording is disabled',
      );
      return;
    }
    const runJj = createRunJj(ctx, runtimeConfig);
    const reader = createJjChangesReader(runJj, {
      timeoutMs: runtimeConfig.timeoutMs,
      graceMs: runtimeConfig.graceMs,
      maxOutputBytes: resolved.outputMaxBytes,
    });
    const recorder = new TurnChangesRecorder({
      reader,
      maxFiles: resolved.maxFiles,
      maxFileBytes: resolved.maxFileBytes,
      home: canonicalHome(),
      warn: (message) => warn(`dsh-jj changes: ${message}`),
    });
    /** Effective working directory per Session, maintained from the durable change events. */
    const sessionCwds = new Map<string, string>();
    /** Turn number per observed `workspace/changes` sequence, for the bridge's alias lookups. */
    const observedTurns = new Map<string, Map<number, number>>();
    /** Observed `workspace/changes` sequences per turn, oldest first, for the bridge. */
    const observedSeqs = new Map<string, Map<number, number[]>>();
    const sessionId = (session: SessionLike): string | undefined => stringField(session, 'id');
    /** Record one observed `workspace/changes` event against its turn. */
    const observeChangeEvent = (session: SessionLike, event: SessionEventLike): void => {
      const id = sessionId(session);
      const seq = event.seq;
      const turn = turnField(event.data);
      if (id === undefined || typeof seq !== 'number' || turn === undefined) return;
      let turns = observedTurns.get(id);
      if (turns === undefined) {
        turns = new Map();
        observedTurns.set(id, turns);
      }
      turns.set(seq, turn);
      let seqs = observedSeqs.get(id);
      if (seqs === undefined) {
        seqs = new Map();
        observedSeqs.set(id, seqs);
      }
      const forTurn = seqs.get(turn);
      if (forTurn === undefined) seqs.set(turn, [seq]);
      else forTurn.push(seq);
    };
    /** Drop every per-Session observation and recorder state once the Session is disposed. */
    const forgetSession = (id: string): void => {
      sessionCwds.delete(id);
      observedTurns.delete(id);
      observedSeqs.delete(id);
      recorder.forget(id);
    };
    const listen = (ctx as unknown as { on?: Listen }).on;
    if (typeof listen === 'function') {
      listen.call(ctx, 'session/event', (...args: unknown[]) => {
        const session = args[0] as SessionLike | undefined;
        const event = args[1] as SessionEventLike | undefined;
        if (session === undefined || event === undefined) return;
        const id = sessionId(session);
        if (id === undefined) return;
        if (event.type === 'working-directory/change') {
          const cwd = stringField(event.data, 'cwd');
          if (cwd !== undefined) sessionCwds.set(id, cwd);
          return;
        }
        if (!isTopLevelSession(session)) return;
        const headerCwd = stringField(session.header, 'cwd');
        if (!sessionCwds.has(id) && headerCwd !== undefined) sessionCwds.set(id, headerCwd);
        if (event.type === 'turn/start') {
          const turn = turnField(event.data);
          const cwd = sessionCwds.get(id);
          if (turn === undefined || cwd === undefined) return;
          const root = jjWorkspaceRootAt(cwd);
          if (root !== undefined) recorder.startTurn(session as unknown as ChangesSessionLike, { turn, cwd, root });
          return;
        }
        if (event.type === 'tool/result') {
          const turn = turnField(event.data);
          if (turn !== undefined)
            recorder.noteToolResult(session as unknown as ChangesSessionLike, turn, event.seq as number);
          return;
        }
        if (event.type === 'turn/end') {
          const turn = turnField(event.data);
          if (turn !== undefined) recorder.end(session as unknown as ChangesSessionLike, turn);
          return;
        }
        if (event.type === 'workspace/changes') observeChangeEvent(session, event);
      });
      listen.call(ctx, 'agent/turn-stopping', async (...args: unknown[]) => {
        const payload = args[0];
        if (payload === null || typeof payload !== 'object') return;
        const agent = (payload as { agent?: { session?: SessionLike } }).agent;
        const session = agent?.session;
        const turn =
          typeof (payload as { turn?: unknown }).turn === 'number' ? (payload as { turn: number }).turn : undefined;
        if (session === undefined || turn === undefined) return;
        if (!isTopLevelSession(session)) return;
        await recorder.stopping(session as unknown as ChangesSessionLike, turn);
      });
      listen.call(ctx, 'session/disposed', (...args: unknown[]) => {
        const id = sessionId((args[0] ?? {}) as SessionLike);
        if (id !== undefined) forgetSession(id);
      });
    }
    const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown }).effect;
    if (typeof effect === 'function') {
      effect.call(ctx, () => () => recorder.dispose(), 'dsh-jj: jj change recording');
    }
    const service = createChangesService({
      recorder,
      upstream: builtin,
      observedTurn: (id, seq) => observedTurns.get(id)?.get(seq),
      upstreamSeqs: (id, turn) => observedSeqs.get(id)?.get(turn) ?? [],
      maxFiles: resolved.maxFiles,
    });
    ctx.provide('workspaceChanges', service as unknown as WorkspaceChanges);
    info('dsh-jj changes: jj workspace-change recording enabled');
  } catch (error) {
    warn(
      'dsh-jj changes: failed to start change recording ' +
        `(${error instanceof Error ? error.message : String(error)}); the built-in Git-only provider stays in charge`,
    );
  }
}
