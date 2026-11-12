/**
 * Cross-process session heartbeats for multi-session workspace guidance.
 *
 * In-process detection only sees the sessions of one DSH process; two `dsh` processes
 * working in the same jj repository were invisible to each other unless the user set
 * `multiSessionGuidance: always`. Each session now drops a small JSON file under the
 * repository's own jj metadata directory (`<jjRepoPath>/dsh-jj/sessions/<id>.json`),
 * which no working copy snapshot can reach, and the guidance reads its peers from there.
 *
 * Everything here is best-effort: a read-only metadata directory, a corrupt file, a
 * clock that jumped, or a missing permission simply yields no heartbeat. Guidance must
 * never block prompt assembly, so every failure is swallowed.
 *
 * @module dsh-jj/session-heartbeat
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directory (relative to the shared jj repository path) that holds the heartbeats. */
export const SESSION_HEARTBEAT_DIR = join('dsh-jj', 'sessions');

/** Default heartbeat lifetime; older entries are ignored as crashed/closed sessions. */
export const SESSION_HEARTBEAT_TTL_MS = 15 * 60_000;

/** One live session's claim about the workspace it is working in. */
export interface SessionHeartbeat {
  /** DSH session id (the file name); opaque, only compared for equality. */
  readonly sessionId: string;
  /** Effective working directory at the time of the write. */
  readonly cwd: string;
  /** jj workspace name (`default` for the root workspace). */
  readonly workspaceName: string;
  /** jj workspace root (canonical path). */
  readonly workspaceRoot: string;
  /** Whether the session was inside an open turn when it wrote the heartbeat. */
  readonly active?: boolean;
  /** Epoch milliseconds of the write. */
  readonly updatedAt: number;
}

/**
 * A safe file name for one session id.
 *
 * DSH session ids are opaque strings; anything outside `[A-Za-z0-9._-]` is replaced so a
 * hostile or unusual id cannot escape the heartbeat directory.
 *
 * @param sessionId - session id.
 * @returns the sanitized file stem.
 */
export function heartbeatFileStem(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe.slice(0, 128) : '_';
}

/**
 * Path of one session heartbeat file.
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param sessionId - session id.
 * @returns the absolute file path.
 */
export function sessionHeartbeatPath(jjRepoPath: string, sessionId: string): string {
  return join(jjRepoPath, SESSION_HEARTBEAT_DIR, `${heartbeatFileStem(sessionId)}.json`);
}

/**
 * Write (or refresh) one heartbeat.
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param heartbeat - the record to persist.
 * @returns true when the file was written; false when the directory is not writable.
 */
export function writeSessionHeartbeat(jjRepoPath: string, heartbeat: SessionHeartbeat): boolean {
  try {
    const dir = join(jjRepoPath, SESSION_HEARTBEAT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${heartbeatFileStem(heartbeat.sessionId)}.json`), JSON.stringify(heartbeat));
    return true;
  } catch {
    return false;
  }
}

/** Structural validation of a decoded heartbeat: everything is optional from disk. */
function decodeHeartbeat(value: unknown): SessionHeartbeat | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { sessionId, cwd, workspaceName, workspaceRoot, active, updatedAt } = record;
  if (
    typeof sessionId !== 'string' ||
    typeof cwd !== 'string' ||
    typeof workspaceName !== 'string' ||
    typeof workspaceRoot !== 'string' ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt)
  ) {
    return undefined;
  }
  return {
    sessionId,
    cwd,
    workspaceName,
    workspaceRoot,
    updatedAt,
    ...(typeof active === 'boolean' ? { active } : {}),
  };
}

/**
 * Read the live heartbeats of one repository.
 *
 * An entry counts only when it is fresh (`now - updatedAt <= ttlMs`) and not the
 * current session's own file; anything unreadable or malformed is skipped. Files from
 * the future (clock skew) are treated as fresh rather than discarded, because dropping
 * them would silently disable detection.
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param options - current time, lifetime, session ids to exclude (for example the current
 *   session and any peers already tracked in-process), and whether expired files may be
 *   deleted (callers that only inspect the repository or run in read-only sandbox mode pass
 *   `purgeExpired: false` so a read never mutates the metadata directory).
 * @returns the fresh peer heartbeats.
 */
export function readSessionHeartbeats(
  jjRepoPath: string,
  options: {
    readonly now: number;
    readonly ttlMs?: number;
    readonly excludeSessionId?: string;
    readonly excludeSessionIds?: Iterable<string>;
    readonly purgeExpired?: boolean;
  },
): SessionHeartbeat[] {
  const ttl = options.ttlMs ?? SESSION_HEARTBEAT_TTL_MS;
  const purgeExpired = options.purgeExpired !== false;
  const excluded = new Set<string>(options.excludeSessionIds);
  if (options.excludeSessionId !== undefined) excluded.add(options.excludeSessionId);
  let entries: string[];
  try {
    entries = readdirSync(join(jjRepoPath, SESSION_HEARTBEAT_DIR));
  } catch {
    return [];
  }
  const heartbeats: SessionHeartbeat[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let heartbeat: SessionHeartbeat | undefined;
    try {
      heartbeat = decodeHeartbeat(JSON.parse(readFileSync(join(jjRepoPath, SESSION_HEARTBEAT_DIR, entry), 'utf8')));
    } catch {
      heartbeat = undefined;
    }
    if (heartbeat === undefined) continue;
    if (excluded.has(heartbeat.sessionId)) continue;
    const age = options.now - heartbeat.updatedAt;
    if (age > ttl) {
      // Expired: the session crashed or closed without removing its file. Best-effort
      // cleanup keeps the directory from growing forever; read-only callers skip it.
      if (purgeExpired) {
        try {
          rmSync(join(jjRepoPath, SESSION_HEARTBEAT_DIR, entry), { force: true });
        } catch {
          // Read-only metadata: leave it for the next reader.
        }
      }
      continue;
    }
    heartbeats.push(heartbeat);
  }
  return heartbeats;
}

/**
 * Remove this session's heartbeat (best effort).
 *
 * @param jjRepoPath - shared repository path behind `.jj/repo`.
 * @param sessionId - session id.
 */
export function removeSessionHeartbeat(jjRepoPath: string, sessionId: string): void {
  try {
    rmSync(sessionHeartbeatPath(jjRepoPath, sessionId), { force: true });
  } catch {
    // Expiry in the reader is the fallback.
  }
}
