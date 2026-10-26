import {
  HELPERS_VERSION,
  NETWORK_CB_BUFFERED_SCRIPT,
  NETWORK_HOOK_SCRIPT,
  REACT_READY_PROBE_JS,
} from '../injected-helpers.js';
import { logger } from '../logger.js';
import { sleep } from './state.js';
import { CDP_TIMEOUT_FAST, timeoutForMethod } from './timeout-config.js';
import type { DeviceBufferManager } from '../ring-buffer.js';
import type { NetworkEntry, EvaluateResult } from '../types.js';

export const REACT_READY_TIMEOUT_MS = 30_000;
export const REACT_READY_POLL_MS = 500;

export interface SetupResult {
  networkMode: 'cdp' | 'hook' | 'none';
  helpersInjected: boolean;
  logDomainEnabled: boolean;
  profilerAvailable: boolean;
  heapProfilerAvailable: boolean;
}

export async function performSetup(opts: {
  send: (method: string, params?: unknown, ms?: number) => Promise<unknown>;
  evaluate: (expr: string) => Promise<EvaluateResult>;
  setupHelpers: (waitTimeout: number) => Promise<boolean>;
  port: number;
  networkManager: DeviceBufferManager<NetworkEntry, string>;
  getDeviceKey: () => string;
  setupEventHandlers: () => void;
  clearScripts: () => void;
  clearEventHandlers: () => void;
  /**
   * Test seam: probe wait intervals forwarded to probeNetworkDomain. Defaults
   * to its production [500, 1500]. Lets tests drive the fallback path without
   * paying the ~2s real probe wait. Mirrors the existing `waits` seam.
   */
  probeWaits?: number[];
}): Promise<SetupResult> {
  const {
    send,
    evaluate,
    setupHelpers,
    port,
    networkManager,
    getDeviceKey,
    setupEventHandlers,
    clearScripts,
    clearEventHandlers,
    probeWaits,
  } = opts;

  // Runtime.enable may synchronously announce the current execution context.
  // Install lifecycle observation first so helper-world identity cannot miss it.
  clearEventHandlers();
  clearScripts();
  setupEventHandlers();

  logger.debug('CDP', 'Running setup: Runtime.enable, Debugger.enable...');
  await send('Runtime.enable', undefined, timeoutForMethod('Runtime.enable'));
  await send('Debugger.enable', undefined, timeoutForMethod('Debugger.enable'));

  let networkMode: 'cdp' | 'hook' | 'none';
  // GH #214: track whether the CDP Network domain is actually enabled, so the
  // hook fallback can disable it and avoid double-feeding the buffer.
  let networkDomainEnabled = false;
  try {
    await send('Network.enable', undefined, timeoutForMethod('Network.enable'));
    networkMode = 'cdp';
    networkDomainEnabled = true;
  } catch {
    networkMode = 'none';
  }

  let logDomainEnabled: boolean;
  try {
    await send('Log.enable', undefined, timeoutForMethod('Log.enable'));
    logDomainEnabled = true;
  } catch {
    logDomainEnabled = false;
  }

  const [profilerProbe, heapProbe] = await Promise.allSettled([
    send('Profiler.enable', undefined, CDP_TIMEOUT_FAST)
      .then(() => send('Profiler.disable', undefined, CDP_TIMEOUT_FAST))
      .then(() => true),
    send('HeapProfiler.enable', undefined, CDP_TIMEOUT_FAST)
      .then(() => send('HeapProfiler.disable', undefined, CDP_TIMEOUT_FAST))
      .then(() => true),
  ]);
  const profilerAvailable = profilerProbe.status === 'fulfilled' && profilerProbe.value === true;
  const heapProfilerAvailable = heapProbe.status === 'fulfilled' && heapProbe.value === true;

  // Connect setup and reinjection share one token-keyed payload + exact-version
  // verification operation. The React-ready budget remains caller-specific.
  const helpersInjected = await setupHelpers(REACT_READY_TIMEOUT_MS);
  if (!helpersInjected) {
    return {
      networkMode,
      helpersInjected: false,
      logDomainEnabled,
      profilerAvailable,
      heapProfilerAvailable,
    };
  }

  // Test seam: force the hook fallback on RN >= 0.83 so the buffered
  // transport can be live-verified without an old-RN app. Also disable the
  // Network domain so CDP events don't double-feed the buffer during seam
  // testing, making live verification vacuous.
  if (process.env.RN_FORCE_NETWORK_HOOK === '1') {
    networkMode = 'none';
    try {
      await send('Network.disable', undefined, CDP_TIMEOUT_FAST);
    } catch {
      /* best-effort */
    }
    networkDomainEnabled = false;
  }

  logger.info('CDP', `Helpers current (v${HELPERS_VERSION}), network mode: ${networkMode}`);

  // D626 (B1 fix): Probe whether Network.enable actually delivers events.
  // GH #59 #9: a single 500ms probe is too tight after platform switches /
  // reload — the fresh JS context needs time to flush the probe fetch through
  // its CDP event channel. Retry once at a longer interval before declaring
  // RN<0.83. Total worst-case wait for legitimate fallback: 500ms + 1500ms.
  if (networkMode === 'cdp') {
    networkMode = await probeNetworkDomain({
      evaluate,
      port,
      networkManager,
      getDeviceKey,
      waits: probeWaits,
    });
  }

  if (networkMode === 'none') {
    // GH #214: if the CDP Network domain is still enabled here, the probe fell
    // back to the hook despite Network.enable succeeding — a false negative on
    // RN >= 0.83 where the probe fetch's events flush after the probe window.
    // Disable the domain so the injected hook is the SINGLE capture source.
    // Leaving it on double-feeds the buffer (CDP numeric-id entries + hook
    // UUID-id entries for the same request); the getByKey dedup can't collapse
    // them because the two id schemes never collide. This also makes
    // cdp_status's networkDomain:false truthful instead of a label over a
    // still-running domain.
    if (networkDomainEnabled) {
      try {
        await send('Network.disable', undefined, CDP_TIMEOUT_FAST);
      } catch {
        /* best-effort */
      }
      networkDomainEnabled = false;
    }
    const hookResult = await evaluate(NETWORK_HOOK_SCRIPT);
    if (hookResult.error) {
      console.error('CDP: failed to inject network hooks:', hookResult.error);
    } else {
      await evaluate(NETWORK_CB_BUFFERED_SCRIPT);
      networkMode = 'hook';
    }
  }

  return {
    networkMode,
    helpersInjected: true,
    logDomainEnabled,
    profilerAvailable,
    heapProfilerAvailable,
  };
}

/**
 * GH #59 #9: probe whether Network.enable actually delivers events on the
 * current Hermes context. RN >= 0.83 (Bridgeless) accepts Network.enable AND
 * fires events; older runtimes accept the call but no events flow. The probe
 * fires a localhost fetch and watches the per-device buffer for growth.
 *
 * Two attempts at increasing timeouts (500ms, 1500ms). One-shot 500ms was
 * the original D626 implementation but produced false negatives after
 * platform switches and reloads where the fresh context needs longer to
 * flush the probe fetch through CDP. Total worst-case latency for legitimate
 * RN<0.83 fallback: ~2 seconds (was 500ms).
 *
 * Returns the post-probe network mode: 'cdp' if events fired, 'none'
 * otherwise (caller will then try hook injection).
 */
export async function probeNetworkDomain(opts: {
  evaluate: (expr: string) => Promise<EvaluateResult>;
  port: number;
  networkManager: DeviceBufferManager<NetworkEntry, string>;
  getDeviceKey: () => string;
  /**
   * Wait intervals between probe fetch and buffer-size check, in ms.
   * Defaults to [500, 1500]. Exposed for tests to inject deterministic short
   * waits without changing production behavior.
   */
  waits?: number[];
}): Promise<'cdp' | 'none'> {
  const { evaluate, port, networkManager, getDeviceKey } = opts;
  const waits = opts.waits ?? [500, 1500];
  const deviceKey = getDeviceKey();

  for (let attempt = 0; attempt < waits.length; attempt++) {
    const bufSizeBefore = networkManager.size(deviceKey);
    await evaluate(`void fetch('http://localhost:${port}/status').catch(function(){})`);
    await sleep(waits[attempt]);
    if (networkManager.size(deviceKey) > bufSizeBefore) {
      return 'cdp';
    }
  }

  logger.info(
    'CDP',
    `Network.enable accepted but no events fired after ${waits.length} attempt(s) — falling back to hooks`,
  );
  return 'none';
}

/**
 * GH #184: bounded variant of waitForReact that RETURNS whether React became
 * reachable within `budgetMs` (vs waitForReact which always resolves void after
 * logging). Used by the status-scoped picker-blocking probe to decide fast,
 * before the full REACT_READY_TIMEOUT_MS wait in setup(), whether a non-Hermes
 * target is a stale (picker-blocked) connection.
 */
export async function probeReactReachable(
  evaluate: (expr: string) => Promise<EvaluateResult>,
  budgetMs: number,
  pollMs: number = REACT_READY_POLL_MS,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    try {
      const result = await evaluate(REACT_READY_PROBE_JS);
      if (result.value === true) return true;
    } catch {
      // not ready yet
    }
    await sleep(pollMs);
  }
  return false;
}

export async function waitForReact(
  evaluate: (expr: string) => Promise<EvaluateResult>,
  timeout?: number,
  pollInterval?: number,
): Promise<void> {
  const effectiveTimeout = timeout ?? REACT_READY_TIMEOUT_MS;
  const effectivePoll = pollInterval ?? REACT_READY_POLL_MS;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    try {
      const result = await evaluate(REACT_READY_PROBE_JS);
      if (result.value === true) return;
    } catch {
      // Not ready yet
    }
    await sleep(effectivePoll);
  }
  console.error(
    `CDP: React not ready after ${effectiveTimeout}ms — helpers will be injected anyway`,
  );
}
