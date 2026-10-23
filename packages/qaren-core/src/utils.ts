import type { CDPClient } from './cdp-client.js';
import type { ResultEnvelope, ToolErrorCode } from './types.js';
import { hasActiveSession } from './agent-device-wrapper.js';
import { handleDevClientPicker } from './handlers/dev-client-picker.js';
import { probeFreshness, recoverFromStaleTarget, consumeCdpStale } from './cdp/recovery.js';

// Cache exact-version freshness for up to 2s per private helper world. Public
// connectionGeneration advances only per opened socket and cannot fence
// helper reset or context churn within one socket.
const FRESHNESS_CACHE_MS = 2000;
const freshnessCache = new WeakMap<CDPClient, { generation: number; expiresAt: number }>();

function isFreshnessCached(client: CDPClient): boolean {
  const entry = freshnessCache.get(client);
  if (!entry) return false;
  if (entry.generation !== client.helperWorldGeneration) return false;
  return Date.now() < entry.expiresAt;
}

function rememberFreshness(client: CDPClient): void {
  freshnessCache.set(client, {
    generation: client.helperWorldGeneration,
    expiresAt: Date.now() + FRESHNESS_CACHE_MS,
  });
}

function forgetFreshness(client: CDPClient): void {
  freshnessCache.delete(client);
}

export async function helpersNotInjectedResult(
  client: CDPClient,
  boundary: 'initial' | 'stale-recovery',
): Promise<ToolResult | null> {
  const helperHealth = await client.probeHelperHealth(2000);
  if (helperHealth.jsWorld === 'responsive' && helperHealth.helper === 'current') {
    rememberFreshness(client);
    return null;
  }
  forgetFreshness(client);
  const message =
    helperHealth.jsWorld === 'timeout'
      ? `Helpers are not ready and the bounded ${helperHealth.probeBudgetMs}ms health probe received no response; JavaScript may be busy, paused, or blocked.`
      : helperHealth.jsWorld === 'transport-error'
        ? 'Helpers are not ready and their health could not be measured because the CDP transport failed.'
        : helperHealth.jsWorld === 'superseded'
          ? 'Helpers are not ready because the JavaScript execution world changed during the bounded health probe.'
          : helperHealth.helper === 'version-mismatch'
            ? 'Helpers are not ready because the responsive JavaScript world contains a different helper version.'
            : helperHealth.helper === 'missing'
              ? 'Helpers are not ready because they are missing from the responsive JavaScript world.'
              : 'Helpers are not ready because the responsive JavaScript world contains an invalid helper value.';
  return failResult(
    `${boundary === 'stale-recovery' ? 'Stale target recovery completed, but ' : ''}${message} Fall back to device_* tools or call cdp_reload once.`,
    'HELPERS_NOT_INJECTED',
    { helperHealth },
  );
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

// Per-step timing collector for the `meta.timings_ms` convention (CLAUDE.md):
// instrument variable-cost paths (dispatch, snapshot, repair, reconnect) so the
// breakdown is visible. `mark(label)` records elapsed-since-last-mark under
// `label`; `timings()` returns the accumulated map for meta.timings_ms.
export function createStepTimer(): {
  mark: (label: string) => void;
  timings: () => Record<string, number>;
} {
  let last = Date.now();
  const acc: Record<string, number> = {};
  return {
    mark(label: string): void {
      const now = Date.now();
      acc[label] = (acc[label] ?? 0) + (now - last);
      last = now;
    },
    timings(): Record<string, number> {
      return acc;
    },
  };
}

// Forwards structured helper fields to a tool envelope's meta; undefined when
// the payload carries none, so envelopes without guidance stay unchanged.
export function pickDefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function okResult<T>(
  data: T,
  opts?: { truncated?: boolean; meta?: Record<string, unknown> },
): ToolResult {
  const envelope: ResultEnvelope<T> = { ok: true, data };
  if (opts?.truncated) envelope.truncated = true;
  if (opts?.meta) envelope.meta = opts.meta;
  return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
}

export function failResult(
  error: string,
  metaOrCode?: Record<string, unknown> | ToolErrorCode,
  maybeMeta?: Record<string, unknown>,
): ToolResult {
  const envelope: ResultEnvelope = { ok: false, error };
  if (typeof metaOrCode === 'string') {
    envelope.code = metaOrCode;
    if (maybeMeta) envelope.meta = maybeMeta;
  } else if (metaOrCode) {
    envelope.meta = metaOrCode;
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}

export function warnResult<T>(
  data: T,
  warning: string,
  meta?: Record<string, unknown>,
): ToolResult {
  const envelope: ResultEnvelope<T> = { ok: true, data, meta: { ...meta, warning } };
  return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
}

export type ToolHandler<T> = (args: T, client: CDPClient) => Promise<ToolResult>;

export function withConnection<T>(
  getClient: () => CDPClient,
  handler: ToolHandler<T>,
  options: { requireHelpers?: boolean } = {},
): (args: T) => Promise<ToolResult> {
  const { requireHelpers = true } = options;

  return async (args: T): Promise<ToolResult> => {
    const client = getClient();
    try {
      if (client.reconnectState.active) {
        const deadline = Date.now() + 30_000;
        while (client.reconnectState.active && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        }
        if (client.reconnectState.active || !client.isConnected) {
          return failResult(
            'Reconnection timed out. Call cdp_status to retry.',
            'RECONNECT_TIMEOUT',
          );
        }
      }
      if (!client.isConnected) {
        try {
          await client.autoConnect();
        } catch (connectErr) {
          const msg = connectErr instanceof Error ? connectErr.message : String(connectErr);
          if (msg.includes('Already connecting')) {
            // Reconnection in progress — wait up to 30s for it to complete (B89)
            const deadline = Date.now() + 30_000;
            while ((!client.isConnected || client.reconnectState.active) && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 500));
            }
            if (!client.isConnected || client.reconnectState.active) {
              return failResult(
                'Reconnection timed out. Call cdp_status to retry.',
                'RECONNECT_TIMEOUT',
              );
            }
          } else {
            return failResult(
              `Auto-connect failed: ${msg}. If Metro was restarted, wait a moment then call cdp_status to reconnect.`,
              'NOT_CONNECTED',
            );
          }
        }
      }
      if (requireHelpers && !client.helpersInjected) {
        const helperDeadline = Date.now() + 5_000;
        while (!client.helpersInjected && Date.now() < helperDeadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
        // D1202: Active 1-shot re-inject. The initial inject during connect
        // setup can race with bundle re-load on app relaunch (Hermes recreates
        // the runtime mid-injection, dropping __QAREN). Without an active
        // retry the loop above just spins because nothing triggers a fresh
        // injection — sessions get stuck on HELPERS_NOT_INJECTED until the
        // caller switches tools or calls cdp_reload. One bounded reinject
        // covers the race; falls through to picker logic on failure.
        //
        // Latency budget: the 3s arg here only bounds waitForReact's slice.
        // The subsequent evaluate(INJECTED_HELPERS) + verify each carry their
        // own per-method CDP timeouts, so worst-case wall time on a hung JS
        // world is ~6-7s, not 3s. That's still well under the user-visible
        // 30s picker fallback.
        //
        // Concurrent callers and connect-time setup share one helper-world
        // payload+exact-version operation inside CDPClient.
        if (!client.helpersInjected && client.isConnected) {
          try {
            const reinjected = await client.reinjectHelpers(3_000);
            // reinjectHelpersFn already verified __QAREN === "object" before
            // returning true, so we can pre-seed the freshness cache and skip
            // the redundant proactive probe at line ~135.
            if (reinjected) rememberFreshness(client);
          } catch (err) {
            console.error(
              `CDP: active re-inject during freshness wait failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        // D503: If helpers still not ready, Dev Client picker may be blocking React
        if (!client.helpersInjected) {
          const pickerResult = await handleDevClientPicker();
          if (pickerResult?.dismissed) {
            console.error('CDP: Dev Client picker dismissed, waiting for helpers...');
            const extDeadline = Date.now() + 30_000;
            while (!client.helpersInjected && Date.now() < extDeadline) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          if (!client.helpersInjected) {
            const helperError = await helpersNotInjectedResult(client, 'initial');
            if (helperError) return helperError;
          }
        }
      }
      // GH #186: a device-session runner-leak recovery may have re-foregrounded
      // or relaunched the app out from under CDP. If it flagged the target as
      // stale, re-pin proactively NOW (recoverFromStaleTarget is a no-op when
      // the target is actually fresh) so the handler doesn't hit a ~47s
      // STALE_TARGET timeout. Best-effort — the catch-path recovery still covers
      // any failure here.
      if (client.isConnected && consumeCdpStale()) {
        try {
          await recoverFromStaleTarget(client);
          forgetFreshness(client);
        } catch {
          /* fall through — handler + catch-path recovery still apply */
        }
      }
      // D502: Proactive freshness check (D631/S1 caches result for 2s per generation).
      // D633: delegated to cdp/recovery.probeFreshness.
      if (requireHelpers && client.helpersInjected && !isFreshnessCached(client)) {
        const probe = await probeFreshness(client);
        if (probe.probed && !probe.fresh) {
          console.error('CDP: helpers stale (globals missing), re-injecting...');
          forgetFreshness(client);
          const reinjected = await client.reinjectHelpers();
          if (!reinjected) {
            return failResult(
              'Helpers became stale and re-injection failed. Try cdp_reload.',
              'HELPERS_STALE',
            );
          }
          rememberFreshness(client);
        } else if (probe.fresh) {
          rememberFreshness(client);
        } else {
          forgetFreshness(client);
        }
      }
      const result = await handler(args, client);

      // B63 (D634): after a handler failure, re-probe freshness. If globals are gone,
      // re-inject and retry. Uses the __QAREN.__v probe as the primary signal
      // instead of error-message string matching.
      if (requireHelpers && result.isError && client.isConnected) {
        const probe = await probeFreshness(client);
        if (probe.probed && !probe.fresh) {
          console.error(
            'CDP: stale handler result detected (version probe failed), re-injecting helpers...',
          );
          forgetFreshness(client);
          const reinjected = await client.reinjectHelpers();
          if (reinjected) {
            try {
              return await handler(args, client);
            } catch {
              // Retry failed — return original result
            }
          }
        }
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isDisconnect =
        message.includes('WebSocket closed') || message.includes('WebSocket not connected');

      if (isDisconnect) {
        // Path A: Clean disconnect — wait for auto-reconnect, then retry once
        const retryDeadline = Date.now() + 30_000;
        while (!client.isConnected && Date.now() < retryDeadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (client.isConnected) {
          if (requireHelpers && !client.helpersInjected) {
            const hd = Date.now() + 5_000;
            while (!client.helpersInjected && Date.now() < hd) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
          if (!requireHelpers || client.helpersInjected) {
            try {
              return await handler(args, client);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              return failResult(`Retry after reconnect failed: ${retryMsg}`);
            }
          }
        }
        return failResult(
          'Connection lost during operation and reconnect timed out. Metro may be restarting — call cdp_status to retry connection, or check: curl localhost:8081/status',
        );
      }

      // Path B (B58 fix): stale-target recovery delegated to cdp/recovery.ts (D633).
      if (client.isConnected) {
        forgetFreshness(client);
        const recovery = await recoverFromStaleTarget(client);
        if (recovery.recovered) {
          console.error('CDP: stale target detected (confirmed after retry), re-discovering...');
          if (requireHelpers && !client.helpersInjected) {
            const hd = Date.now() + 5_000;
            while (!client.helpersInjected && Date.now() < hd) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
          if (!requireHelpers || client.helpersInjected) {
            try {
              return await handler(args, client);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              return failResult(
                `Retry after stale-target recovery failed: ${retryMsg}`,
                'STALE_TARGET',
                { originalError: message },
              );
            }
          }
          const helperError = await helpersNotInjectedResult(client, 'stale-recovery');
          if (helperError) return helperError;
          try {
            return await handler(args, client);
          } catch {
            return failResult(
              'Retry after stale-target helper reconciliation failed.',
              'STALE_TARGET',
            );
          }
        }
        if (recovery.reason === 'reconnect-failed') {
          return failResult(`Stale target recovery failed: ${recovery.error}`, 'STALE_TARGET', {
            originalError: message,
          });
        }
      }

      return failResult(message);
    }
  };
}

export type DeviceToolHandler<T> = (args: T) => Promise<ToolResult>;

export function withSession<T>(handler: DeviceToolHandler<T>): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    if (!hasActiveSession()) {
      return failResult(
        'No device session open. Call device_snapshot with action="open" and provide appId and platform first.',
        {
          hint: 'device_snapshot action=open starts a session. All device_press/device_fill/device_find/device_swipe/device_back tools require an open session.',
        },
      );
    }
    return handler(args);
  };
}
