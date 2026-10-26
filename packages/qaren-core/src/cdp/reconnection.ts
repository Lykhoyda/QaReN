import { cancellableFetch } from '../domain/cancellation.js';
import { logger } from '../logger.js';
import { resetState, clearActiveFlag, sleep } from './state.js';
import type { ResettableState } from './state.js';

const RECONNECT_ATTEMPTS = 30;

export interface ReconnectDelayOpts {
  baseMs?: number;
  capMs?: number;
  jitterMs?: number;
  rng?: () => number;
}

/**
 * Exponential reconnect delay with jitter (M2 / Phase 90 Tier 1).
 *
 * Replaces the old linear 1.5s × 30 retry loop. The curve keeps attempt 0 at 0ms
 * so hot-reload reconnects are instant, then grows to cap at 30s:
 *
 *   attempt 0  → 0ms        (hot-reload happy path)
 *   attempt 1  → 500ms     ±jitter
 *   attempt 2  → 1_000ms   ±jitter
 *   attempt 3  → 2_000ms   ±jitter
 *   attempt 4  → 4_000ms   ±jitter
 *   attempt 5  → 8_000ms   ±jitter
 *   attempt 6  → 16_000ms  ±jitter
 *   attempt 7+ → 30_000ms  ±jitter (capped)
 *
 * Why the jitter: when two MCPs reconnect in lockstep after a Metro restart,
 * linear retries hammer Metro synchronously. ±500ms of jitter breaks the lockstep
 * within a few attempts. The cap prevents a 30-minute Metro outage from tripling
 * into an hour of reconnect attempts.
 *
 * `rng` is injectable so tests can assert exact values without flakiness.
 */
export function computeReconnectDelay(attempt: number, opts: ReconnectDelayOpts = {}): number {
  if (attempt <= 0) return 0;
  const baseMs = opts.baseMs ?? 500;
  const capMs = opts.capMs ?? 30_000;
  const jitterMs = opts.jitterMs ?? 500;
  const rng = opts.rng ?? Math.random;

  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, capMs);
  const jitter = Math.floor(rng() * jitterMs);
  return capped + jitter;
}

export interface ReconnectContext {
  isDisposed: () => boolean;
  isReconnecting: () => boolean;
  isSoftReconnectRequested: () => boolean;
  setReconnecting: (v: boolean) => void;
  setSoftReconnectRequested: (v: boolean) => void;
  setState: (s: string) => void;
  setReconnectAttempt: (count: number, timestamp: string) => void;
  closeWs: () => void;
  rejectAllPending: (reason: Error) => void;
  discoverAndConnect: () => Promise<string>;
  getResettableState: () => ResettableState;
  getPort: () => number;
  setBgPollTimer: (timer: ReturnType<typeof setInterval> | null) => void;
  getBgPollTimer: () => ReturnType<typeof setInterval> | null;
  isConnected: () => boolean;
  clearActiveState?: () => void;
  /**
   * Debugger-seat opt-out (spec 2026-06-10): when present and false, the
   * BACKGROUND reconnect paths (handleClose loop, background poll) are
   * disabled — the bridge yields the single RN debugger seat to a human
   * DevTools until the next explicit tool call. Optional so existing
   * ReconnectContext consumers/tests keep today's behavior.
   */
  isAutoConnectEnabled?: () => boolean;
  /**
   * B132 (M1b follow-up): invoked after a successful reconnect inside the
   * exponential-backoff `reconnect()` loop. Used by CDPClient to auto-resume
   * the multiplexer proxy after reconnecting directly to Hermes. NOT fired
   * by `softReconnect()` — that path has its own wrapper on the CDPClient.
   * Failures are logged, never propagated — post-reconnect hooks must not
   * undo a successful reconnect.
   */
  afterReconnect?: () => Promise<void>;
}

function isPassive(ctx: ReconnectContext): boolean {
  return ctx.isAutoConnectEnabled !== undefined && !ctx.isAutoConnectEnabled();
}

function clearActiveState(ctx: ReconnectContext): void {
  if (ctx.clearActiveState) {
    ctx.clearActiveState();
    return;
  }
  clearActiveFlag();
}

export function handleClose(ctx: ReconnectContext, code: number): void {
  resetState(ctx.getResettableState());

  if (ctx.isDisposed() || ctx.isReconnecting()) return;

  if (isPassive(ctx)) {
    ctx.setState('disconnected');
    clearActiveState(ctx);
    logger.info('CDP', `WebSocket closed (code ${code}); auto-reconnect disabled — staying down`);
    console.error(
      'CDP: connection closed (code ' +
        code +
        '). Auto-reconnect is disabled ' +
        '(RN_CDP_AUTOCONNECT or .qaren/config.json cdp.autoConnect) — ' +
        'the bridge will reconnect on the next CDP tool call. ' +
        'Re-enable with RN_CDP_AUTOCONNECT=1 or by removing the config override.',
    );
    return;
  }

  logger.info('CDP', `WebSocket closed (code ${code}), starting reconnect`);
  if (code === 1006) {
    console.error(
      'CDP: abnormal close (1006). App may have reloaded or crashed. Attempting reconnect...',
    );
  } else {
    console.error('CDP: connection closed (code ' + code + '). Reconnecting...');
  }

  ctx.setReconnecting(true);
  ctx.setState('reconnecting');

  reconnect(ctx).catch((err) => {
    console.error('CDP: reconnect failed:', err instanceof Error ? err.message : err);
    ctx.setReconnecting(false);
  });
}

/**
 * Sleep for `delayMs` total, but check for `isDisposed()` / `isSoftReconnectRequested()`
 * every `sliceMs` (default 500ms) so soft-reconnect requests are honored within one slice
 * instead of waiting out the full exponential backoff window.
 *
 * Returns `true` if the full delay elapsed without interruption, `false` if a disposal
 * or soft-reconnect request was observed. Critical for M2 / D653 — once the backoff
 * curve hits the 30s cap, a non-interruptible sleep would exceed `softReconnect`'s 3s
 * bail window, letting both paths race to call `discoverAndConnect()` concurrently.
 */
// Exported for unit testing — the `reconnect()` loop is a tight ReconnectContext
// consumer, so exercising the sleep separately from the loop catches preemption
// bugs without mocking every context field.
export async function interruptibleSleep(
  delayMs: number,
  ctx: ReconnectContext,
  sliceMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (ctx.isDisposed() || ctx.isSoftReconnectRequested()) return false;
    const remaining = deadline - Date.now();
    await sleep(Math.min(sliceMs, remaining));
  }
  return true;
}

export async function reconnect(ctx: ReconnectContext): Promise<void> {
  for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
    const delayMs = computeReconnectDelay(i);
    if (delayMs > 0) {
      logger.info('CDP', `reconnect attempt ${i + 1}/${RECONNECT_ATTEMPTS} in ${delayMs}ms`);
      const completed = await interruptibleSleep(delayMs, ctx);
      if (!completed) {
        ctx.setReconnecting(false);
        return;
      }
    }

    ctx.setReconnectAttempt(i + 1, new Date().toISOString());
    if (ctx.isDisposed() || ctx.isSoftReconnectRequested()) {
      ctx.setReconnecting(false);
      return;
    }
    try {
      await ctx.discoverAndConnect();
      ctx.setReconnecting(false);
      console.error('CDP: reconnected successfully');
      if (ctx.afterReconnect) {
        try {
          await ctx.afterReconnect();
        } catch (err) {
          logger.warn(
            'CDP',
            `afterReconnect hook failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      return;
    } catch {
      // Fall through to next iteration — delay for attempt i+1 applied at top of loop.
    }
  }
  ctx.setReconnecting(false);
  ctx.setState('disconnected');
  clearActiveState(ctx);
  console.error(
    'CDP: reconnect failed after ' + RECONNECT_ATTEMPTS + ' attempts. Starting background poll...',
  );
  startBackgroundPoll(ctx);
}

export async function softReconnect(ctx: ReconnectContext): Promise<string> {
  if (ctx.isDisposed()) throw new Error('Client is disposed');
  logger.info('CDP', 'softReconnect initiated');

  if (ctx.isReconnecting()) {
    ctx.setSoftReconnectRequested(true);
    const bailDeadline = Date.now() + 3_000;
    while (ctx.isReconnecting() && Date.now() < bailDeadline) {
      await sleep(200);
    }
    ctx.setSoftReconnectRequested(false);
  }

  ctx.setReconnecting(true);
  try {
    resetState(ctx.getResettableState());
    ctx.closeWs();
    ctx.rejectAllPending(new Error('Stale target — re-discovering'));
    const result = await ctx.discoverAndConnect();
    ctx.setReconnecting(false);
    return result;
  } catch (err) {
    ctx.setReconnecting(false);
    throw err;
  }
}

export function startBackgroundPoll(ctx: ReconnectContext): void {
  if (ctx.getBgPollTimer() || ctx.isDisposed()) return;
  if (isPassive(ctx)) return;
  ctx.setBgPollTimer(
    setInterval(async () => {
      if (isPassive(ctx)) {
        stopBackgroundPoll(ctx);
        return;
      }
      if (ctx.isDisposed() || ctx.isConnected() || ctx.isReconnecting()) {
        stopBackgroundPoll(ctx);
        return;
      }
      try {
        const res = await cancellableFetch(fetch, `http://127.0.0.1:${ctx.getPort()}/status`, {
          signal: AbortSignal.timeout(2000),
        });
        const text = await res.text();
        if (text === 'packager-status:running') {
          console.error('CDP: Metro detected via background poll. Reconnecting...');
          stopBackgroundPoll(ctx);
          ctx.setReconnecting(true);
          ctx.setState('reconnecting');
          reconnect(ctx).catch(() => {
            ctx.setReconnecting(false);
          });
        }
      } catch {
        // Metro not available yet — keep polling
      }
    }, 5000),
  );
}

export function stopBackgroundPoll(ctx: ReconnectContext): void {
  const timer = ctx.getBgPollTimer();
  if (timer) {
    clearInterval(timer);
    ctx.setBgPollTimer(null);
  }
}
