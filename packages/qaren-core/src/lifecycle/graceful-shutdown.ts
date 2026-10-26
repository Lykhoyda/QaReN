import type { CDPClient } from '../cdp-client.js';
import { logger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 3000;

export interface GracefulShutdownDeps {
  getClient: () => CDPClient;
  stopFastRunnerFn: () => void | Promise<void>;
  /**
   * Reaps observe-mirror capture children (idb/ffmpeg/simctl) — GH #182 zombie
   * class for the live-mirror subsystem. Optional: undefined when the mirror
   * is config-disabled. MirrorManager.shutdown() is synchronous and idempotent,
   * so calling it here is safe even if another exit path also calls it.
   */
  stopMirrorFn?: () => void;
  exitFn?: (code: number) => never;
  timeoutMs?: number;
}

/**
 * Factory for the process-lifecycle shutdown path. B73/B76/zombie-cleanup (D644).
 *
 * All termination signals + stdin.end funnel into the returned `shutdown(exitCode)`:
 *   1. Guard against re-entry (idempotent — multiple simultaneous signals collapse to one run).
 *   2. Disconnect the CDPClient — internally clears the 5s background poll setInterval
 *      (the root cause of MCP zombies surviving parent CC quit) and closes the WebSocket.
 *   3. Stop the fast-runner child process (xcodebuild).
 *   4. Stop the observe-mirror capture pipeline, if present (GH #182 zombie class).
 *   5. Race cleanup against DEFAULT_TIMEOUT_MS — if cleanup hangs, force-exit anyway so
 *      the parent CC session never waits on a stuck MCP.
 *
 * `exitFn` is injectable so tests can observe the exit code without killing the test runner.
 */
export function buildGracefulShutdown(
  deps: GracefulShutdownDeps,
): (exitCode: number) => Promise<void> {
  const exitFn = deps.exitFn ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let shuttingDown = false;

  return async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    const cleanup = (async () => {
      try {
        await deps.getClient().disconnect();
      } catch (err) {
        logger.warn(
          'MCP',
          `shutdown: disconnect failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await deps.stopFastRunnerFn();
      } catch (err) {
        logger.warn(
          'MCP',
          `shutdown: stopFastRunner failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        deps.stopMirrorFn?.();
      } catch (err) {
        logger.warn(
          'MCP',
          `shutdown: stopMirror failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    })();

    // Timeout is NOT unref'd: it must keep the event loop alive so it can fire
    // even if no other work is pending (otherwise Node would exit the loop while
    // cleanup is still pending, and process.exit never runs). The timer is always
    // cleared on the happy path so it doesn't block shutdown when cleanup wins.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        logger.warn('MCP', `shutdown: cleanup timeout after ${timeoutMs}ms, forcing exit`);
        resolve();
      }, timeoutMs);
    });

    await Promise.race([cleanup, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    exitFn(exitCode);
  };
}
