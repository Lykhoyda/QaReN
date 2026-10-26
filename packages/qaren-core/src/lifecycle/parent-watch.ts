import { logger } from '../logger.js';

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * GH #182: one tick of the parent-death watch. Compares the bridge's *current* PPID
 * against the PPID it observed at startup. If it CHANGED, the original parent (the
 * Claude Code host) died and the bridge was reparented (to init, launchd, or a
 * subreaper) — it's now a LIVE orphan still holding the single-instance lock, so
 * trigger onOrphaned (self-exit). Otherwise onHeartbeat (refresh the lock).
 *
 * We compare against the initial PPID rather than testing `=== 1` so a bridge whose
 * Claude Code host runs as PID 1 (a container with no init system) does NOT
 * self-exit on every tick — its PPID is legitimately 1 and never changes while CC
 * is alive (Gemini HIGH). Subreaper reparenting (PPID → some non-1 PID) is caught too.
 * Pure + injectable so the decision is unit-tested without timers or real PPIDs.
 */
export function parentWatchTick(
  getppid: () => number,
  initialPpid: number,
  onOrphaned: () => void,
  onHeartbeat: () => void,
): void {
  if (getppid() !== initialPpid) onOrphaned();
  else onHeartbeat();
}

export interface ParentDeathWatchOptions {
  /** Defaults to reading process.getppid(). Injectable for tests. */
  getppid?: () => number;
  onOrphaned: () => void;
  onHeartbeat: () => void;
  intervalMs?: number;
}

/**
 * Read the parent PID. B200: Node exposes this as the `process.ppid` PROPERTY —
 * there is no process.getppid() function (the old feature-detect always returned
 * 0, so the orphan watch never fired: 0 === 0 forever, silently dead since #182).
 * Returns 0 if somehow unavailable; the watch compares current-vs-initial PPID,
 * so a constant 0 fails safe to "parent alive".
 */
function defaultGetppid(): number {
  return typeof process.ppid === 'number' ? process.ppid : 0;
}

/**
 * GH #182: belt-and-suspenders host-death detection. The existing stdin-EOF + signal
 * handlers can silently fail to fire when CC dies abnormally (SIGKILL/crash/window
 * close on macOS) without closing the child's stdin — leaving a LIVE orphan that
 * holds the project lock for up to 24h (the PID-alive reclaim can't catch it). This
 * polls getppid() and self-exits on orphan; on a live parent it refreshes the lock
 * heartbeat. The timer is unref'd so it never keeps a should-be-dead process alive.
 * Returns a stop() that clears the timer (called from the shutdown path).
 */
export function startParentDeathWatch(opts: ParentDeathWatchOptions): () => void {
  const getppid = opts.getppid ?? defaultGetppid;
  // Capture the PPID at startup; "orphaned" means it later changes (parent died →
  // reparented). This makes a CC-as-PID-1 container safe: initial PPID 1 stays 1.
  const initialPpid = getppid();
  const interval = setInterval(() => {
    try {
      parentWatchTick(getppid, initialPpid, opts.onOrphaned, opts.onHeartbeat);
    } catch (err) {
      logger.warn(
        'MCP',
        `parent-death watch tick failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}
