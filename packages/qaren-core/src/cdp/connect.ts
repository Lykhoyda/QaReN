import { isAbort, cancellationSignal, interruptible } from '../domain/cancellation.js';
import WebSocket from 'ws';
import { logger } from '../logger.js';
import { metroOrigin } from '../ws-origin.js';
import { resolveBundleId } from '../project-config.js';
import {
  discover,
  targetBundleIdentity,
  TargetReadinessTimeoutError,
  TargetSelectionError,
} from './discovery.js';
import type { SelectTargetFilters } from './discovery.js';
import { sleep } from './state.js';
import { CDP_TIMEOUT_FAST } from './timeout-config.js';
import { CDPRequestTimeoutError, CDPTargetClosedError } from './transport.js';
export { CDPTargetClosedError } from './transport.js';
import { probeReactReachable } from './setup.js';
import type { CDPClientState, EvaluateResult, HermesTarget } from '../types.js';

// GH #184: distinguishes a quick health-check connect (cdp_status) from every
// other connect path. Only 'status' connects run the bounded picker probe; all
// other paths keep the full waitForReact budget for legitimate slow builds.
export type ConnectIntent = 'default' | 'status';

// Budget for the status-scoped React-reachability probe. Generous enough to
// clear a normal Bridgeless reload (React ready in <~2s) but far below setup()'s
// 30s waitForReact, so cdp_status fails fast instead of hanging when the Dev
// Client picker blocks the bundle. Env-overridable for tuning/tests.
const PICKER_PROBE_BUDGET_MS = (() => {
  const n = parseInt(process.env.RN_PICKER_PROBE_BUDGET_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();

/**
 * GH #184: thrown when a status-scoped connect can't reach React within the
 * bounded budget on a non-Hermes target — the signature of the Expo Dev Client
 * "Development servers" picker leaving stale C++ targets advertised while the
 * bundle never loads. status.ts maps it to a fast, actionable failResult
 * instead of letting setup() burn the full 30s waitForReact.
 */
export class PickerBlockingBundleError extends Error {
  readonly target: HermesTarget;
  constructor(target: HermesTarget) {
    super(
      `Dev Client picker appears to be blocking the bundle: React was not reachable on target ` +
        `"${target.title}" (vm=${target.vm}). If the Expo "Development servers" picker is showing on ` +
        `the simulator, select your Metro server, then retry cdp_status. (If the bundle is still building, just retry.)`,
    );
    this.name = 'PickerBlockingBundleError';
    this.target = target;
  }
}

export class ConnectionSetupSupersededError extends Error {
  constructor() {
    super('Connection setup superseded');
    this.name = 'ConnectionSetupSupersededError';
  }
}

export class CDPHandshakeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CDPHandshakeTimeoutError';
  }
}

export class CDPProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CDPProbeTimeoutError';
  }
}

/**
 * GH #184: run the bounded picker probe only for a status-intent connect against
 * a non-Hermes target. Hermes targets are skipped so a genuinely slow Hermes
 * first-build keeps the full waitForReact budget rather than being aborted.
 */
export function shouldRunPickerProbe(intent: ConnectIntent, target: HermesTarget): boolean {
  return intent === 'status' && target.vm !== 'Hermes';
}

export interface ConnectFilters {
  platform?: string;
  deviceKind?: 'emulator' | 'physical';
  targetId?: string;
  bundleId?: string;
  preferredBundleId?: string;
  /** GH #625: durable device affinity captured when a targetId is pinned. */
  deviceName?: string;
}

export interface ConnectContext {
  isDisposed(): boolean;
  isReconnecting(): boolean;
  isSoftReconnectRequested(): boolean;
  getState(): CDPClientState;
  setState(s: CDPClientState): void;
  getPort(): number;
  setPort(v: number): void;
  getConnectFilters(): ConnectFilters;
  setConnectFilters(v: ConnectFilters): void;
  getWs(): WebSocket | null;
  setWs(ws: WebSocket | null): void;
  setHelpersInjected(v: boolean): void;
  setConnectedTarget(t: HermesTarget | null): void;
  setConnectedAt(ms: number | null): void;
  now(): number;
  incrementConnectionGeneration(): number;
  evaluate(expr: string): Promise<EvaluateResult>;
  // Bounded by the caller's attach deadline when one is set; expiry is a TargetReadinessTimeoutError.
  evaluateWithinAttach(expr: string): Promise<EvaluateResult>;
  sendWithTimeout(method: string, params: unknown, ms: number): Promise<unknown>;
  handleMessage(data: WebSocket.RawData): void;
  handleClose(code: number): void;
  rejectAllPending(reason: Error): void;
  setup(): Promise<void>;
  /**
   * M1b (Phase 100+): when non-null, connectToTarget routes through this URL
   * instead of the target's direct `webSocketDebuggerUrl`. This is how the
   * CDPClient rides the local multiplexer proxy, allowing React Native DevTools
   * (or any second consumer) to coexist on RN < 0.85.
   */
  getProxyUrl(): string | null;
}

export async function autoConnect(
  ctx: ConnectContext,
  portHint?: number,
  filters?: ConnectFilters,
  intent: ConnectIntent = 'default',
  discoverFn: typeof discover = discover,
  targetRetries = 5,
): Promise<string> {
  if (ctx.getState() === 'connecting' || ctx.isReconnecting()) {
    throw new Error('Already connecting to Metro...');
  }
  if (ctx.isDisposed()) {
    throw new Error('Client is disposed. Create a new CDPClient instance.');
  }
  const effective: ConnectFilters = { ...filters };
  if (!effective.platform) {
    const envPlatform = process.env.RN_PREFERRED_PLATFORM;
    if (envPlatform && envPlatform !== 'auto') effective.platform = envPlatform;
  }
  // B111 (D643): auto-populate preferredBundleId from project-config so the
  // smart auto-selection in selectTarget fires for callers that didn't pass
  // explicit filters. resolveBundleId returns null when no app.json — graceful no-op.
  if (!effective.preferredBundleId) {
    const resolved = resolveBundleId(effective.platform ?? 'ios');
    if (resolved) effective.preferredBundleId = resolved;
  }
  return discoverAndConnect(ctx, portHint, effective, discoverFn, intent, targetRetries);
}

// B111 (D643): discoverFn is injectable for unit tests. GH #184 keeps intent
// after it for compatibility. Exact-session re-registration passes targetRetries=1
// so a stale inspector cannot consume the outer deadline; other paths retain five.
export async function discoverAndConnect(
  ctx: ConnectContext,
  portHint?: number,
  filters?: ConnectFilters,
  discoverFn: typeof discover = discover,
  intent: ConnectIntent = 'default',
  targetRetries = 5,
): Promise<string> {
  if (ctx.isDisposed()) {
    throw new Error('Client is disposed. Create a new CDPClient instance.');
  }

  if (portHint) ctx.setPort(portHint);
  // B111 (D643/G7): preserve _connectFilters across softReconnect — only overwrite
  // when caller explicitly passes filters. softReconnect calls with filters=undefined
  // so the previously-set targetId/bundleId/preferredBundleId survive the reload.
  if (filters !== undefined) ctx.setConnectFilters(filters);
  ctx.setState('connecting');

  const mergedFilters = ctx.getConnectFilters();
  const filtersForDiscover: SelectTargetFilters = {
    platform: mergedFilters.platform,
    deviceKind: mergedFilters.deviceKind,
    targetId: mergedFilters.targetId,
    bundleId: mergedFilters.bundleId,
    preferredBundleId: mergedFilters.preferredBundleId,
    deviceName: mergedFilters.deviceName,
  };

  let result;
  try {
    result = await interruptible(() => discoverFn(ctx.getPort(), filtersForDiscover));
  } catch (err) {
    if (isAbort(err)) throw err;
    ctx.setState('disconnected');
    throw err;
  }

  const {
    port: metroPort,
    targets: sorted,
    warning: selectionWarning,
    errorCode,
    candidates,
    inference,
  } = result;
  ctx.setPort(metroPort);
  if (errorCode) {
    ctx.setState('disconnected');
    throw new TargetSelectionError(
      errorCode,
      selectionWarning ?? errorCode,
      candidates ?? [],
      inference,
    );
  }

  // B111 (D643/G9): selectTarget hard-fails (returns []) on explicit filter
  // mismatch — surface that as a connect error rather than crashing on the
  // candidate loop's connectedTarget! non-null assertion below.
  if (sorted.length === 0) {
    ctx.setState('disconnected');
    throw new Error(selectionWarning ?? 'No matching CDP targets found.');
  }

  let connectedTarget: HermesTarget | null = null;
  for (let idx = 0; idx < sorted.length; idx++) {
    const candidate = sorted[idx];
    const isLast = idx === sorted.length - 1;
    try {
      await connectToTarget(ctx, candidate, targetRetries, intent);
      const devCheck = await interruptible(() =>
        ctx.evaluateWithinAttach('typeof __DEV__ !== "undefined" && __DEV__ === true'),
      );
      if (devCheck.value === true) {
        connectedTarget = candidate;
        break;
      }
      console.error(
        `CDP: target ${candidate.id} (${candidate.title}) has __DEV__=${devCheck.value}, skipping`,
      );
      if (!isLast) {
        closeAndResetWs(ctx);
        ctx.setState('disconnected');
        ctx.setHelpersInjected(false);
        ctx.setConnectedTarget(null);
        continue;
      }
      console.error('CDP: no target with __DEV__=true found, using last available target');
      connectedTarget = candidate;
    } catch (err) {
      if (isAbort(err)) throw err;
      // Refusal or page replacement returns control to the discovery owner.
      if (err instanceof ConnectionSetupSupersededError) throw err;
      if (
        err instanceof PickerBlockingBundleError ||
        err instanceof TargetReadinessTimeoutError ||
        err instanceof CDPTargetClosedError
      ) {
        ctx.setState('disconnected');
        throw err;
      }
      if (!isLast) continue;
      throw err;
    }
  }

  if (ctx.isDisposed()) throw new ConnectionSetupSupersededError();

  logger.info(
    'CDP',
    `Connected to target ${connectedTarget!.id} (${connectedTarget!.title}) on port ${metroPort}`,
  );

  // GH #59 #5: persist the resolved platform into _connectFilters when the
  // caller didn't pin one explicitly. Without this, softReconnect after
  // cdp_reload has nothing to filter on and may pick the wrong simulator
  // (e.g. iOS user reloads, sortTargets returns Android first, reconnect
  // lands on Android). Explicit filters from the caller already survive
  // (B111/D643/G7); this closes the auto-detect gap.
  const stickyFilters = stickyPlatformFilters(ctx.getConnectFilters(), connectedTarget!.platform);
  if (stickyFilters) ctx.setConnectFilters(stickyFilters);

  // GH #625: an explicit targetId pin persists the connected target's durable
  // device + bundle identity so reconnects re-resolve on the SAME device (page
  // ids churn on reload) and fail closed instead of binding a sibling simulator.
  const pinnedDeviceFilters = stickyPinnedDeviceFilters(ctx.getConnectFilters(), connectedTarget!);
  if (pinnedDeviceFilters) ctx.setConnectFilters(pinnedDeviceFilters);

  const msg = `Connected to ${connectedTarget!.title} on port ${metroPort}`;
  return selectionWarning ? `${msg}. WARNING: ${selectionWarning}` : msg;
}

/**
 * GH #59 #5: pure helper that pins the resolved platform into a copy of the
 * current connect filters when (a) no platform filter was explicitly set and
 * (b) the connect resolved a target whose platform we now know. Returns null
 * when no update is needed — caller skips the setConnectFilters call.
 *
 * Extracted so the auto-detect → reconnect-stays-on-same-platform invariant
 * can be unit-tested without spinning a real WebSocket connect.
 */
export function stickyPlatformFilters(
  current: ConnectFilters,
  resolvedPlatform: string | undefined,
): ConnectFilters | null {
  if (current.platform) return null;
  if (!resolvedPlatform) return null;
  return { ...current, platform: resolvedPlatform };
}

/**
 * GH #625: pure helper that persists the durable identity of an explicitly
 * pinned target — deviceName plus proven bundle identity — and refreshes the
 * volatile page-scoped targetId to the live one. Returns null when there is no
 * pin, no durable identity to capture, or nothing changed.
 */
export function stickyPinnedDeviceFilters(
  current: ConnectFilters,
  connectedTarget: HermesTarget,
): ConnectFilters | null {
  if (!current.targetId) return null;
  const deviceName = connectedTarget.deviceName?.trim();
  if (!deviceName) return null;
  const bundleId = current.bundleId ?? targetBundleIdentity(connectedTarget) ?? undefined;
  if (
    current.targetId === connectedTarget.id &&
    current.deviceName === deviceName &&
    current.bundleId === bundleId
  ) {
    return null;
  }
  return {
    ...current,
    targetId: connectedTarget.id,
    deviceName,
    ...(bundleId ? { bundleId } : {}),
  };
}

/**
 * GH #105 / B154: pure helper. Decide which final error string to surface
 * after `retries` failed connection attempts. The previous unconditional
 * "Failed to connect after 5 attempts." was misleading when every attempt
 * actually connected at the WebSocket layer and only the Runtime.evaluate
 * pre-flight probe timed out — that means the JS thread is paused (almost
 * always because the app is backgrounded by the Agent Device Runner
 * foregrounding itself), not that Metro is unreachable.
 *
 * Pure & exported so unit tests can pin the message shape without spinning
 * a real WebSocket.
 */
export function formatConnectFailureMessage(
  retries: number,
  attempts: { handshakeOk: boolean; probeTimedOut: boolean }[],
  bundleHint: string | null,
  lastErrorMessage: string | null,
): string {
  const allHandshakesSucceeded = attempts.length > 0 && attempts.every((a) => a.handshakeOk);
  const anyProbeTimeout = attempts.some((a) => a.probeTimedOut);
  if (allHandshakesSucceeded && anyProbeTimeout) {
    const bid = bundleHint ?? '<bundleId>';
    return (
      `CDP probe timeout after ${retries} attempts: WebSocket handshake succeeded but Runtime.evaluate('1+1') consistently timed out — JS thread paused. ` +
      `The target app is most likely backgrounded. ` +
      `Recovery: call cdp_restart with hardReset=true (kills the fast-runner, terminates+relaunches ${bid}, reconnects — no /reload-plugins required). ` +
      `Or manually: xcrun simctl terminate booted ${bid} && xcrun simctl launch booted ${bid} (iOS), or restart the app from the launcher (Android).`
    );
  }
  const hint = lastErrorMessage?.includes('1006')
    ? ' Another debugger may be connected — close React Native DevTools, Flipper, or Chrome DevTools.'
    : '';
  return `Failed to connect after ${retries} attempts.${hint}`;
}

async function connectToTarget(
  ctx: ConnectContext,
  target: HermesTarget,
  retries = 5,
  intent: ConnectIntent = 'default',
): Promise<void> {
  let lastError: Error | null = null;
  // GH #105 / B154: track per-attempt outcome (handshake ok vs probe timeout).
  // Fed into formatConnectFailureMessage at the end.
  const attempts: { handshakeOk: boolean; probeTimedOut: boolean; handshakeTimedOut: boolean }[] =
    [];
  for (let i = 0; i < retries; i++) {
    if (ctx.isDisposed() || ctx.isSoftReconnectRequested()) {
      throw new Error('Client disposed or preempted during connection');
    }
    let handshakeOk = false;
    let probeTimedOut = false;
    let attemptWs: WebSocket | null = null;
    try {
      // M1b: ride the multiplexer when _proxyUrl is set (from CDPClient.startProxy).
      // Falls back to the target's direct webSocketDebuggerUrl when no proxy is active.
      const proxyUrl = ctx.getProxyUrl();
      const url = proxyUrl ?? target.webSocketDebuggerUrl;
      if (proxyUrl) {
        logger.info('CDP', `Routing via multiplexer proxy: ${proxyUrl}`);
      }
      attemptWs = await connectWebSocket(ctx, url);
      handshakeOk = true;
      // D594: Early stale-target detection — quick probe before full setup
      try {
        await interruptible(() =>
          ctx.sendWithTimeout(
            'Runtime.evaluate',
            {
              expression: '1+1',
              returnByValue: true,
            },
            CDP_TIMEOUT_FAST,
          ),
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        if (!(error instanceof CDPRequestTimeoutError)) throw error;
        probeTimedOut = true;
        throw new Error('Target failed pre-flight probe (1+1) — likely a dead JS context');
      }
      ctx.setConnectedTarget(target);
      // M11: stamp connection time so cdp_console_log / cdp_network_log can reason
      // about "how long have we been connected with nothing happening?"
      ctx.setConnectedAt(ctx.now());
      // GH #184: for a status-scoped connect, bounded-probe React reachability
      // BEFORE the up-to-30s waitForReact inside setup(). A non-Hermes target
      // that can't reach React within the budget is a stale C++ connection the
      // Dev Client picker leaves advertised — abort fast with a typed error
      // instead of hanging. Hermes targets are skipped (legit slow builds).
      if (shouldRunPickerProbe(intent, target)) {
        const reachable = await probeReactReachable(
          (expr) => ctx.evaluate(expr),
          PICKER_PROBE_BUDGET_MS,
        );
        if (!reachable) throw new PickerBlockingBundleError(target);
      }
      await interruptible(() => ctx.setup());
      if (ctx.isDisposed()) throw new ConnectionSetupSupersededError();
      return;
    } catch (err) {
      if (isAbort(err)) {
        closeConnectionAttempt(ctx, attemptWs);
        throw err;
      }
      cancellationSignal();
      if (err instanceof ConnectionSetupSupersededError) {
        closeConnectionAttempt(ctx, attemptWs);
        throw err;
      }
      // The caller owns refusal, deadline expiry and rediscovery after page replacement.
      if (
        err instanceof PickerBlockingBundleError ||
        err instanceof TargetReadinessTimeoutError ||
        err instanceof CDPTargetClosedError
      ) {
        if (!closeConnectionAttempt(ctx, attemptWs)) {
          throw new ConnectionSetupSupersededError();
        }
        ctx.setConnectedTarget(null);
        ctx.setState('disconnected');
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      attempts.push({
        handshakeOk,
        probeTimedOut,
        handshakeTimedOut: err instanceof CDPHandshakeTimeoutError,
      });
      if (!closeConnectionAttempt(ctx, attemptWs)) {
        if (err instanceof ConnectionSetupSupersededError) throw err;
        throw new ConnectionSetupSupersededError();
      }
      if (lastError.message.includes('refused')) {
        ctx.setState('disconnected');
        throw new Error('CDP connection refused. Is Metro running and the app loaded?');
      }
      if (i < retries - 1) await sleep(2000);
    }
  }
  ctx.setState('disconnected');
  const failureMessage = formatConnectFailureMessage(
    retries,
    attempts,
    target.description ?? null,
    lastError?.message ?? null,
  );
  if (attempts.length > 0 && attempts.every((attempt) => attempt.probeTimedOut)) {
    throw new CDPProbeTimeoutError(failureMessage);
  }
  if (
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.handshakeTimedOut || attempt.probeTimedOut)
  ) {
    throw new CDPHandshakeTimeoutError(failureMessage);
  }
  throw new Error(failureMessage);
}

export type ConnectWebSocketFactory = (url: string) => WebSocket;

export function connectWebSocket(
  ctx: ConnectContext,
  url: string,
  createSocket: ConnectWebSocketFactory = (socketUrl) =>
    new WebSocket(socketUrl, {
      handshakeTimeout: 5000,
      maxPayload: 100 * 1024 * 1024,
      headers: { Origin: metroOrigin(socketUrl) },
    }),
): Promise<WebSocket> {
  return interruptible(
    (signal) =>
      new Promise((resolve, reject) => {
        const ws = createSocket(url);
        let settled = false;
        // Backstop: handshakeTimeout should emit 'error', but if the socket ever
        // wedges without firing open/error/close it would leak with its listeners.
        // Terminate it after a grace window so it can't linger.
        const guard = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            ws.terminate();
          } catch (error) {
            if (isAbort(error)) throw error;
            /* already gone */
          }
          reject(new CDPHandshakeTimeoutError('WebSocket connect timed out'));
        }, 7000);

        const abort = () => {
          clearTimeout(guard);
          settled = true;
          ws.terminate();
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        ws.on('open', () => {
          if (signal?.aborted) return abort();
          signal?.removeEventListener('abort', abort);
          settled = true;
          clearTimeout(guard);
          if (ctx.isDisposed()) {
            try {
              ws.terminate();
            } catch (error) {
              if (isAbort(error)) throw error;
            }
            reject(new ConnectionSetupSupersededError());
            return;
          }
          ctx.setWs(ws);
          ctx.incrementConnectionGeneration();
          ctx.setState('connected');
          resolve(ws);
        });

        ws.on('error', (err) => {
          signal?.removeEventListener('abort', abort);
          if (!settled) {
            settled = true;
            clearTimeout(guard);
            try {
              ws.terminate();
            } catch (error) {
              if (isAbort(error)) throw error;
              /* already closing */
            }
            reject(
              err.message === 'Opening handshake has timed out'
                ? new CDPHandshakeTimeoutError(err.message)
                : err,
            );
          } else {
            console.error('CDP WebSocket error:', err instanceof Error ? err.message : err);
          }
        });

        ws.on('message', (data) => {
          ctx.handleMessage(data);
        });

        ws.on('close', (code) => {
          signal?.removeEventListener('abort', abort);
          if (!settled) {
            settled = true;
            clearTimeout(guard);
            reject(new CDPTargetClosedError(`WebSocket closed before connecting: ${code}`));
            return;
          }
          if (ctx.getWs() === ws) {
            ctx.rejectAllPending(new CDPTargetClosedError(`WebSocket closed: ${code}`));
            ctx.handleClose(code);
          }
        });
      }),
  );
}

function closeAndResetWs(ctx: ConnectContext): void {
  const ws = ctx.getWs();
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ctx.setWs(null);
  }
}

export function closeConnectionAttempt(
  ctx: Pick<ConnectContext, 'getWs' | 'setWs'>,
  attemptWs: WebSocket | null,
): boolean {
  if (ctx.getWs() !== attemptWs) return false;
  if (!attemptWs) return true;
  attemptWs.removeAllListeners();
  if (attemptWs.readyState === WebSocket.OPEN || attemptWs.readyState === WebSocket.CONNECTING) {
    attemptWs.close();
  }
  ctx.setWs(null);
  return true;
}
