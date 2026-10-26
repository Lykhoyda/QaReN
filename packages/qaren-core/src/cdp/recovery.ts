import { sleep as cancellableSleep } from '../domain/cancellation.js';
import type { CDPClient } from '../cdp-client.js';
import type { EvaluateResult } from '../types.js';

const FRESHNESS_PROBE_MS = 2000;
const STALE_RETRY_DELAY_MS = 500;
const STALE_RETRY_PROBE_MS = 3000;

// GH #186: cross-tool "the CDP target may be stale" signal. A device-session
// runner-leak recovery can re-foreground/relaunch the app out from under CDP,
// after which the next cdp_* call would hit a ~47s STALE_TARGET timeout in the
// handler. The recovery sets this flag; withConnection consumes it before the
// next handler and proactively re-pins via recoverFromStaleTarget, turning that
// 47s catch-path recovery into a fast pre-handler one. Process-scoped boolean —
// a single MCP serves one device at a time, so no per-client keying is needed.
let cdpStale = false;
export function markCdpStale(): void {
  cdpStale = true;
}
/** Read-and-clear: returns whether the stale flag was set, resetting it. */
export function consumeCdpStale(): boolean {
  const was = cdpStale;
  cdpStale = false;
  return was;
}

export interface FreshnessResult {
  fresh: boolean;
  version: number | null;
  probed: boolean;
}

export async function probeFreshness(
  client: CDPClient,
  timeoutMs: number = FRESHNESS_PROBE_MS,
): Promise<FreshnessResult> {
  // The client owns the token/context fence and the actual CDP timeout. Only
  // the exact shipped helper version is fresh; no orphaned outer race remains.
  return client.probeHelperFreshness(timeoutMs);
}

export interface StaleRecoveryResult {
  recovered: boolean;
  reason: 'fresh' | 'not-stale' | 'reconnected' | 'reconnect-failed' | 'probe-failed';
  error?: string;
}

export async function recoverFromStaleTarget(client: CDPClient): Promise<StaleRecoveryResult> {
  if (!client.isConnected) {
    return { recovered: false, reason: 'probe-failed', error: 'Client not connected' };
  }

  let probe = await probeDev(client, FRESHNESS_PROBE_MS);
  let isStale = !probe.ok;

  // D526: retry once to avoid false positives from GC pauses / transient blocks
  if (isStale && probe.timedOut) {
    await sleep(STALE_RETRY_DELAY_MS);
    probe = await probeDev(client, STALE_RETRY_PROBE_MS);
    isStale = !probe.ok;
  }

  if (!isStale) {
    return { recovered: false, reason: 'not-stale' };
  }

  try {
    await client.softReconnect();
    return { recovered: true, reason: 'reconnected' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { recovered: false, reason: 'reconnect-failed', error: msg };
  }
}

async function probeDev(
  client: CDPClient,
  timeoutMs: number,
): Promise<{ ok: boolean; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // No-op catch on the orphaned promise if the timeout wins the race (see
    // probeFreshness) — prevents an unhandledRejection on a mid-probe WS close.
    const evalPromise = client.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true');
    evalPromise.catch(() => {
      /* swallowed if the timeout already settled the race */
    });
    const result = await Promise.race([
      evalPromise,
      new Promise<EvaluateResult>((resolve) => {
        timer = setTimeout(() => resolve({ error: 'probe timeout' }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return {
      ok: result.error === undefined && result.value === true,
      timedOut: result.error === 'probe timeout',
    };
  } catch {
    if (timer) clearTimeout(timer);
    return { ok: false, timedOut: false };
  }
}

function sleep(ms: number): Promise<void> {
  return cancellableSleep(ms);
}
