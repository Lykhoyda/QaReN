import { withDeadline, throwIfCancelled, sleep } from './domain/cancellation.js';
import WebSocket from 'ws';
import { RingBuffer, DeviceBufferManager, makeDeviceKey } from './ring-buffer.js';
import { getNetworkBufferManager } from './cdp/network-buffer-manager.js';
import { CDPMultiplexer } from './cdp/multiplexer.js';
import type { MultiplexerOptions } from './cdp/multiplexer.js';
import { detectBridge } from './bridge-detector.js';
import { logger } from './logger.js';
import { performSetup, waitForReact } from './cdp/setup.js';
import { HELPERS_VERSION, INJECTED_HELPERS } from './injected-helpers.js';
import { resetState, setActiveFlag, clearActiveFlag } from './cdp/state.js';
import type { ResettableState } from './cdp/state.js';
import { defaultTimeout, timeoutForMethod } from './cdp/timeout-config.js';
import type { Platform } from './cdp/timeout-config.js';
import {
  CDPProtocolError,
  CDPRequestTimeoutError,
  sendWithTimeout as sendMsg,
  rejectAllPending as rejectPending,
  handleMessage as handleMsg,
} from './cdp/transport.js';
import {
  wireEventHandlers,
  parseNetworkHookMessage as parseNetHook,
} from './cdp/event-handlers.js';
import {
  discoverExactPort,
  discoverForList,
  listTargetsOnExactPort,
  TargetReadinessTimeoutError,
  type DiscoveryResult,
} from './cdp/discovery.js';
import {
  helperExpr as helperExprFn,
  bridgeWithFallback as bridgeWithFallbackFn,
} from './cdp/helper-expr.js';
import {
  autoConnect as autoConnectFn,
  ConnectionSetupSupersededError,
  CDPProbeTimeoutError,
  CDPTargetClosedError,
  discoverAndConnect as discoverAndConnectFn,
} from './cdp/connect.js';
import type { ConnectContext, ConnectFilters, ConnectIntent } from './cdp/connect.js';
import { resolveAutoConnect } from './project-config.js';
import type { AutoConnectResolution } from './project-config.js';
import {
  handleClose as handleCloseFn,
  reconnect as reconnectFn,
  softReconnect as softReconnectFn,
  startBackgroundPoll as startBgPoll,
  stopBackgroundPoll as stopBgPoll,
} from './cdp/reconnection.js';
import type { ReconnectContext } from './cdp/reconnection.js';
import type {
  PendingCall,
  HermesTarget,
  ConsoleEntry,
  NetworkEntry,
  LogEntry,
  CDPClientState,
  EvaluateResult,
} from './types.js';

function evaluationErrorKind(error: unknown): NonNullable<EvaluateResult['errorKind']> {
  if (error instanceof CDPRequestTimeoutError) return 'timeout';
  if (error instanceof CDPProtocolError) return 'protocol';
  if (error instanceof CDPTargetClosedError) return 'target_closed';
  return 'other';
}

export interface AuthoritativeSessionPolicy {
  port: number;
  filters: Pick<ConnectFilters, 'platform' | 'bundleId'>;
  resolveTargetId(
    targets: HermesTarget[],
    awaitWithinBoundary?: AwaitWithinBoundary,
  ): Promise<string>;
  verifyAndReconcile(client: CDPClient, awaitWithinBoundary?: AwaitWithinBoundary): Promise<void>;
}

export type AwaitWithinBoundary = <T>(operation: () => Promise<T>) => Promise<T>;

export async function discoverAuthoritativeTarget(
  policy: AuthoritativeSessionPolicy,
  requestedFilters: ConnectFilters,
  discoverFn: typeof discoverExactPort = discoverExactPort,
  awaitWithinBoundary?: AwaitWithinBoundary,
): Promise<DiscoveryResult> {
  const result = await discoverFn(policy.port, {
    ...requestedFilters,
    ...policy.filters,
    targetId: undefined,
    preferredBundleId: undefined,
    deviceName: undefined,
  });
  if (result.errorCode || result.targets.length === 0) return result;
  const resolveTargetId = () => policy.resolveTargetId(result.targets, awaitWithinBoundary);
  const targetId = await (awaitWithinBoundary
    ? awaitWithinBoundary(resolveTargetId)
    : resolveTargetId());
  const target = result.targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new Error(
      'CDP_TARGET_AUTHORITY_MISMATCH: exact-device resolver returned a target outside the managed Metro result',
    );
  }
  return { ...result, targets: [target] };
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private slotId = 0;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, (params: unknown) => void>();
  private _consoleBuffer: RingBuffer<ConsoleEntry>;
  // B128 (D657): DeviceBufferManager is now a module-level singleton keyed by
  // `${metroPort}-${targetId}`. Survives CDPClient lifecycle (destroy/rebuild
  // on force reconnect or cdp_restart). We hold a reference only as a getter
  // convenience; never instantiate a new one here.
  private _networkBufferManager: DeviceBufferManager<NetworkEntry, string>;
  private _port: number;
  private reconnecting = false;
  private disposed = false;
  private lifecycleAuthority: () => boolean = () => true;
  private _helpersInjected = false;
  private _helperWorldGeneration = 0;
  private _helperContext: { id: number; uniqueId?: string } | null = null;
  private _helperToken: {
    generation: number;
    ws: WebSocket | null;
    targetId: string | null;
    contextId: number | null;
    contextUniqueId: string | null;
  } = {
    generation: 0,
    ws: null,
    targetId: null,
    contextId: null,
    contextUniqueId: null,
  };
  private _helperInjectionInFlight: {
    token: CDPClient['_helperToken'];
    promise: Promise<boolean>;
  } | null = null;
  private _networkMode: 'cdp' | 'hook' | 'none' = 'none';
  private _isPaused = false;
  private _connectedTarget: HermesTarget | null = null;
  // M11 / Phase 108: timestamp (ms) of the current CDP connection; null when disconnected.
  // Used by cdp_console_log / cdp_network_log to surface the Metro --clear hint after
  // prolonged empty results. Reset alongside _connectedTarget via buildResettableState.
  private _connectedAt: number | null = null;
  private _timeNowFn: () => number;
  private _state: CDPClientState = 'disconnected';
  private _connectionGeneration = 0;
  private _softReconnectRequested = false;
  private _bgPollTimer: ReturnType<typeof setInterval> | null = null;
  private _bridgeDetected = false;
  private _bridgeVersion: number | null = null;

  private _logBuffer: RingBuffer<LogEntry>;
  private _logDomainEnabled = false;
  private _profilerAvailable = false;
  private _heapProfilerAvailable = false;

  // Tier 3: scriptParsed cache (D592)
  private _scripts = new Map<
    string,
    { scriptId: string; url: string; startLine: number; endLine: number }
  >();
  // Tier 3: reconnection state visibility (D596)
  private _lastReconnectAttempt: string | null = null;
  private _reconnectAttemptCount = 0;

  // Resolved once per process — env/config don't change mid-session.
  private _autoConnectResolution: AutoConnectResolution | null = null;
  private _authoritativeSessionPolicy: AuthoritativeSessionPolicy | undefined;

  // M1b (Phase 100+): multiplexer proxy state. When `_proxyUrl` is non-null, the
  // CDP WebSocket routes through `_multiplexer` instead of connecting directly to
  // Hermes. Lets React Native DevTools share the same Hermes target on RN < 0.85.
  private _proxyUrl: string | null = null;
  private _multiplexer: CDPMultiplexer | null = null;
  private _startProxyInFlight: Promise<string> | null = null;
  // B132 (M1b follow-up): separate user intent from live proxy state. `_proxyUrl`
  // is the live state (null between suspend and resume). `_proxyDesired` is the
  // user's standing wish — set by successful startProxy(), cleared by stopProxy()
  // or disconnect(). Preserved across _suspendProxy() so post-reconnect auto-resume
  // can rehydrate the proxy against the fresh target URL.
  private _proxyDesired = false;

  constructor(port?: number, timeNowFn?: () => number) {
    this._port = port ?? 8081;
    // M11: optional injectable clock for deterministic tests. Production default: Date.now.
    this._timeNowFn = timeNowFn ?? Date.now;
    this._consoleBuffer = new RingBuffer<ConsoleEntry>(200);
    // B128 (D657): use process-scoped singleton instead of per-client instance
    this._networkBufferManager = getNetworkBufferManager();
    this._logBuffer = new RingBuffer<LogEntry>(50);
  }

  get state(): CDPClientState {
    return this._state;
  }
  get isConnected(): boolean {
    return !this.disposed && this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }
  get isPaused(): boolean {
    return this._isPaused;
  }
  get helpersInjected(): boolean {
    return this._helpersInjected;
  }
  /** Private helper-world epoch exposed only for process-local cache identity. */
  get helperWorldGeneration(): number {
    return this._helperWorldGeneration;
  }
  get metroPort(): number {
    return this._port;
  }
  get connectedTarget(): HermesTarget | null {
    return this._connectedTarget;
  }
  /** B132: whether DevTools attachment was requested. Survives soft reconnect (auto-resumes via afterReconnect). Lost on `disconnect()` — caller must re-run cdp_open_devtools after a force-recreate. */
  get proxyDesired(): boolean {
    return this._proxyDesired;
  }
  /** M11: timestamp of the current CDP connection (ms since epoch); null when disconnected. */
  get connectedAt(): number | null {
    return this._connectedAt;
  }
  /** M11: clock source for this client (injectable; defaults to Date.now). */
  get now(): () => number {
    return this._timeNowFn;
  }
  get networkMode(): 'cdp' | 'hook' | 'none' {
    return this._networkMode;
  }
  get consoleBuffer(): RingBuffer<ConsoleEntry> {
    return this._consoleBuffer;
  }
  /** M4 (D655): per-device buffer manager. Use `activeDeviceKey` for single-device queries, `'all'` for cross-device. */
  get networkBufferManager(): DeviceBufferManager<NetworkEntry, string> {
    return this._networkBufferManager;
  }
  /** M4 (D655): the device key for the currently connected target. Used as the default scope for per-device buffer queries. */
  get activeDeviceKey(): string {
    return makeDeviceKey(this._port, this._connectedTarget?.id);
  }
  get connectionGeneration(): number {
    return this._connectionGeneration;
  }

  setLifecycleAuthority(isCurrent: () => boolean): void {
    this.lifecycleAuthority = isCurrent;
  }

  publishLifecycleState(): void {
    if (this.lifecycleAuthority() && this.isConnected && this._helpersInjected) {
      setActiveFlag(this._port, this._connectedTarget);
    }
  }
  get bridgeDetected(): boolean {
    return this._bridgeDetected;
  }
  get bridgeVersion(): number | null {
    return this._bridgeVersion;
  }
  get logBuffer(): RingBuffer<LogEntry> {
    return this._logBuffer;
  }
  get logDomainEnabled(): boolean {
    return this._logDomainEnabled;
  }
  get profilerAvailable(): boolean {
    return this._profilerAvailable;
  }
  get heapProfilerAvailable(): boolean {
    return this._heapProfilerAvailable;
  }
  get scripts(): Map<
    string,
    { scriptId: string; url: string; startLine: number; endLine: number }
  > {
    return this._scripts;
  }
  get reconnectState(): { active: boolean; lastAttempt: string | null; attemptCount: number } {
    return {
      active: this.reconnecting,
      lastAttempt: this._lastReconnectAttempt,
      attemptCount: this._reconnectAttemptCount,
    };
  }
  /**
   * Resolved once per process — env/config don't change mid-session.
   * `enabled: false` gates BACKGROUND reconnect only — explicit tool-call
   * connects (client.autoConnect()) still run regardless of this flag.
   */
  get autoConnectState(): AutoConnectResolution {
    if (!this._autoConnectResolution) this._autoConnectResolution = resolveAutoConnect();
    return this._autoConnectResolution;
  }
  /** M1b: URL the CDPClient routes through (null when connected directly). */
  get proxyUrl(): string | null {
    return this._proxyUrl;
  }
  /** M1b: true when the multiplexer is owned by this client and routing traffic. */
  get isProxyActive(): boolean {
    return this._proxyUrl !== null;
  }
  /** M1b: the multiplexer instance (null when no proxy is active). */
  get proxyMultiplexer(): CDPMultiplexer | null {
    return this._multiplexer;
  }

  helperExpr(call: string): string {
    return helperExprFn(call, this._bridgeDetected);
  }

  bridgeWithFallback(call: string): string {
    return bridgeWithFallbackFn(call, this._bridgeDetected);
  }

  async reinjectHelpers(waitTimeout?: number, reportReadinessTimeout = false): Promise<boolean> {
    if (!this.isConnected) {
      if (reportReadinessTimeout)
        throw new CDPTargetClosedError('reload inspector is disconnected');
      return false;
    }
    // Caller-specific React readiness stays outside the shared injection core.
    await waitForReact((expr) => this.evaluateCurrentHelperWorld(expr), waitTimeout);
    return this.ensureCurrentHelpers('reinject_started', reportReadinessTimeout);
  }

  /**
   * One bounded, context-pinned health read used only at final
   * HELPERS_NOT_INJECTED boundaries. It never returns app values or errors.
   */
  async probeHelperHealth(probeBudgetMs = 2000): Promise<{
    jsWorld: 'responsive' | 'timeout' | 'transport-error' | 'superseded';
    helper: 'current' | 'missing' | 'version-mismatch' | 'invalid' | 'unknown';
    probeBudgetMs: number;
  }> {
    const token = this._helperToken;
    if (!this.isHelperTokenCurrent(token)) {
      return { jsWorld: 'superseded', helper: 'unknown', probeBudgetMs };
    }
    const expression = `(function(){try{var d=Object.getOwnPropertyDescriptor(globalThis,'__QAREN');if(!d)return 'missing';if(!('value' in d)||typeof d.value!=='object'||d.value===null)return 'invalid';var v=Object.getOwnPropertyDescriptor(d.value,'__v');if(!v||!('value' in v)||typeof v.value!=='number')return 'invalid';return v.value===${HELPERS_VERSION}?'current':'version-mismatch';}catch(_){return 'invalid';}})()`;
    try {
      const result = await this.evaluateForHelperToken(token, expression, probeBudgetMs);
      if (!this.isHelperTokenCurrent(token)) {
        return { jsWorld: 'superseded', helper: 'unknown', probeBudgetMs };
      }
      const helper =
        result.value === 'current' ||
        result.value === 'missing' ||
        result.value === 'version-mismatch' ||
        result.value === 'invalid'
          ? result.value
          : 'invalid';
      if (helper === 'current') this.markHelpersReady(token, 'health_reconciled_current');
      return { jsWorld: 'responsive', helper, probeBudgetMs };
    } catch (err) {
      if (!this.isHelperTokenCurrent(token)) {
        return { jsWorld: 'superseded', helper: 'unknown', probeBudgetMs };
      }
      const timedOut = err instanceof Error && err.message.startsWith('CDP timeout (');
      return {
        jsWorld: timedOut ? 'timeout' : 'transport-error',
        helper: 'unknown',
        probeBudgetMs,
      };
    }
  }

  async probeHelperFreshness(timeoutMs = 2000): Promise<{
    fresh: boolean;
    version: number | null;
    probed: boolean;
  }> {
    if (!this.isConnected) return { fresh: false, version: null, probed: false };
    const token = this._helperToken;
    try {
      const result = await this.evaluateForHelperToken(
        token,
        `typeof globalThis.__QAREN === 'object' && globalThis.__QAREN !== null ? globalThis.__QAREN.__v : null`,
        timeoutMs,
      );
      if (!this.isHelperTokenCurrent(token)) return { fresh: false, version: null, probed: true };
      const version = typeof result.value === 'number' ? result.value : null;
      const fresh = version === HELPERS_VERSION;
      if (!fresh) {
        this.markHelpersUnready(
          token,
          version === null ? 'freshness_missing' : 'freshness_version_mismatch',
        );
      }
      return { fresh, version, probed: true };
    } catch {
      this.markHelpersUnready(token, 'freshness_probe_failed');
      return { fresh: false, version: null, probed: true };
    }
  }

  async withPrivateHelperWorld<T>(
    operation: (
      evaluate: (expression: string, timeoutMs: number) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    const token = this._helperToken;
    let active = true;
    const assertCurrent = (): void => {
      if (
        !active ||
        !this.isConnected ||
        !this._helpersInjected ||
        !this.isHelperTokenCurrent(token)
      ) {
        throw new Error('Private helper world unavailable');
      }
    };
    const evaluate = async (expression: string, timeoutMs: number): Promise<unknown> => {
      try {
        assertCurrent();
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new Error('Private helper world unavailable');
        }
        const result = await this.evaluateForHelperToken(token, expression, timeoutMs);
        assertCurrent();
        if (Object.hasOwn(result, 'error')) throw new Error('Private helper world unavailable');
        return result.value;
      } catch {
        active = false;
        throw new Error('Private helper world unavailable');
      }
    };
    try {
      assertCurrent();
      const version = await evaluate(
        `typeof globalThis.__QAREN === 'object' && globalThis.__QAREN !== null ? globalThis.__QAREN.__v : null`,
        1500,
      );
      if (version !== HELPERS_VERSION) throw new Error('Private helper world unavailable');
      assertCurrent();
      const result = await operation(evaluate);
      assertCurrent();
      return result;
    } catch {
      throw new Error('Private helper world unavailable');
    } finally {
      active = false;
    }
  }

  private invalidateHelperWorld(
    cause:
      | 'socket_opened'
      | 'socket_closed'
      | 'explicit_disconnect'
      | 'soft_reconnect'
      | 'candidate_selected'
      | 'candidate_rejected'
      | 'context_created'
      | 'context_destroyed'
      | 'contexts_cleared',
  ): void {
    this._helperWorldGeneration++;
    this._helpersInjected = false;
    this._bridgeDetected = false;
    this._bridgeVersion = null;
    this.clearActiveState();
    this._helperToken = {
      generation: this._helperWorldGeneration,
      ws: this.ws,
      targetId: this._connectedTarget?.id ?? null,
      contextId: this._helperContext?.id ?? null,
      contextUniqueId: this._helperContext?.uniqueId ?? null,
    };
    logger.info(
      'CDP',
      `Helper state invalidated cause=${cause} helperEpoch=${this._helperWorldGeneration} connectionGeneration=${this._connectionGeneration}`,
    );
  }

  private isHelperTokenCurrent(token: CDPClient['_helperToken']): boolean {
    return (
      token === this._helperToken &&
      token.ws === this.ws &&
      token.targetId === (this._connectedTarget?.id ?? null)
    );
  }

  private async evaluateCurrentHelperWorld(expression: string): Promise<EvaluateResult> {
    const token = this._helperToken;
    try {
      return await this.evaluateForHelperToken(
        token,
        expression,
        defaultTimeout(this.effectivePlatform),
      );
    } catch {
      return { error: 'helper-world evaluation unavailable' };
    }
  }

  private async evaluateForHelperToken(
    token: CDPClient['_helperToken'],
    expression: string,
    timeoutMs: number,
  ): Promise<EvaluateResult> {
    if (!this.isHelperTokenCurrent(token)) throw new Error('helper world superseded');
    const params: { expression: string; returnByValue: true; contextId?: number } = {
      expression,
      returnByValue: true,
    };
    if (token.contextId !== null) params.contextId = token.contextId;
    const result = (await this.sendWithTimeout('Runtime.evaluate', params, timeoutMs)) as {
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    };
    if (!this.isHelperTokenCurrent(token)) throw new Error('helper world superseded');
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Object.hasOwn(result, 'exceptionDetails') ||
      Object.hasOwn(result, 'error') ||
      !result.result ||
      typeof result.result !== 'object' ||
      Array.isArray(result.result) ||
      Object.hasOwn(result.result, 'error')
    ) {
      return { error: 'helper-world expression failed' };
    }
    return { value: result.result.value };
  }

  private async ensureCurrentHelpers(
    cause: 'setup_started' | 'reinject_started',
    reportReadinessTimeout = false,
  ): Promise<boolean> {
    const token = this._helperToken;
    if (!this.isHelperTokenCurrent(token) || !this.isConnected) return false;
    if (this._helpersInjected) return true;
    let slot = this._helperInjectionInFlight;
    if (slot?.token !== token) {
      const next = { token, promise: Promise.resolve(false) as Promise<boolean> };
      next.promise = this.injectAndVerifyHelpers(token, cause).finally(() => {
        // An old world's late finally cannot clear a newer slot.
        if (this._helperInjectionInFlight === next) this._helperInjectionInFlight = null;
      });
      this._helperInjectionInFlight = slot = next;
    }
    try {
      const injected = await slot.promise;
      if (reportReadinessTimeout && (!this.isConnected || !this.isHelperTokenCurrent(token)))
        throw new CDPTargetClosedError('reload helper world was replaced');
      return injected;
    } catch (error) {
      if (reportReadinessTimeout && (!this.isConnected || !this.isHelperTokenCurrent(token)))
        throw new CDPTargetClosedError('reload helper world was replaced');
      if (!reportReadinessTimeout && error instanceof CDPRequestTimeoutError) return false;
      throw error;
    }
  }

  private markHelpersUnready(
    token: CDPClient['_helperToken'],
    cause:
      | 'setup_failed'
      | 'reinject_failed'
      | 'freshness_missing'
      | 'freshness_version_mismatch'
      | 'freshness_probe_failed',
  ): false {
    if (!this.isHelperTokenCurrent(token)) return false;
    this._helpersInjected = false;
    this._bridgeDetected = false;
    this._bridgeVersion = null;
    this.clearActiveState();
    logger.warn(
      'CDP',
      `Helper state unavailable cause=${cause} helperEpoch=${token.generation} connectionGeneration=${this._connectionGeneration}`,
    );
    return false;
  }

  private async injectAndVerifyHelpers(
    token: CDPClient['_helperToken'],
    cause: 'setup_started' | 'reinject_started',
  ): Promise<boolean> {
    logger.info(
      'CDP',
      `Helper injection ${cause} helperEpoch=${token.generation} connectionGeneration=${this._connectionGeneration}`,
    );
    try {
      const injected = await this.evaluateForHelperToken(
        token,
        INJECTED_HELPERS,
        this.attachRequestTimeout(),
      );
      if (injected.error) {
        return this.markHelpersUnready(
          token,
          cause === 'setup_started' ? 'setup_failed' : 'reinject_failed',
        );
      }
      const verified = await this.evaluateForHelperToken(
        token,
        `typeof globalThis.__QAREN === 'object' && globalThis.__QAREN !== null && globalThis.__QAREN.__v === ${HELPERS_VERSION}`,
        this.attachRequestTimeout(),
      );
      if (verified.value !== true || !this.isHelperTokenCurrent(token)) {
        return this.markHelpersUnready(
          token,
          cause === 'setup_started' ? 'setup_failed' : 'reinject_failed',
        );
      }
      this.markHelpersReady(
        token,
        cause === 'setup_started' ? 'setup_current' : 'reinject_current',
      );
      return true;
    } catch (error) {
      // A stale world's failure must not change current helper state.
      const unready = this.markHelpersUnready(
        token,
        cause === 'setup_started' ? 'setup_failed' : 'reinject_failed',
      );
      const readiness = this.attachReadinessError(error, 'helper injection');
      if (readiness !== error) throw readiness;
      if (error instanceof CDPRequestTimeoutError) throw error;
      return unready;
    }
  }

  private markHelpersReady(
    token: CDPClient['_helperToken'],
    cause: 'setup_current' | 'reinject_current' | 'health_reconciled_current',
  ): void {
    if (!this.isHelperTokenCurrent(token)) return;
    this._helpersInjected = true;
    if (this.lifecycleAuthority()) setActiveFlag(this._port, this._connectedTarget);
    logger.info(
      'CDP',
      `Helper state ready cause=${cause} helperEpoch=${token.generation} connectionGeneration=${this._connectionGeneration}`,
    );
    detectBridge(this, (expression) =>
      this.evaluateForHelperToken(token, expression, defaultTimeout(this.effectivePlatform)),
    )
      .then((r) => {
        if (!this.isHelperTokenCurrent(token)) return;
        this._bridgeDetected = r.present;
        this._bridgeVersion = r.version;
      })
      .catch(() => {});
  }

  private handleExecutionContextCreated(params: {
    context?: { id?: number; uniqueId?: string; auxData?: { isDefault?: boolean } };
  }): void {
    const id = params.context?.id;
    // Modern RN marks its announced runtime as the default context. Ignore
    // explicitly auxiliary contexts; legacy one-context backends omit auxData.
    if (typeof id !== 'number' || params.context?.auxData?.isDefault === false) return;
    const next = { id, uniqueId: params.context?.uniqueId };
    if (this._helperContext?.id === next.id && this._helperContext.uniqueId === next.uniqueId)
      return;
    this._helperContext = next;
    this.invalidateHelperWorld('context_created');
  }

  private handleExecutionContextDestroyed(params: {
    executionContextId?: number;
    executionContextUniqueId?: string;
  }): void {
    if (!this._helperContext) return;
    const matchesId = params.executionContextId === this._helperContext.id;
    const matchesUnique =
      params.executionContextUniqueId !== undefined &&
      params.executionContextUniqueId === this._helperContext.uniqueId;
    if (!matchesId && !matchesUnique) return;
    this._helperContext = null;
    this.invalidateHelperWorld('context_destroyed');
  }

  private handleExecutionContextsCleared(): void {
    this._helperContext = null;
    this.invalidateHelperWorld('contexts_cleared');
  }

  async autoConnect(
    portHint?: number,
    filtersOrPlatform?: string | ConnectFilters,
    intent: ConnectIntent = 'default',
  ): Promise<string> {
    const filters: ConnectFilters =
      typeof filtersOrPlatform === 'string'
        ? { platform: filtersOrPlatform }
        : (filtersOrPlatform ?? {});
    // A bare reconnect after an exact attach keeps its identity (platform, bundle, device); explicit filters replace it.
    const scoped =
      this._exactDiscoveryPort !== undefined && filtersOrPlatform === undefined
        ? this._connectFilters
        : filters;
    return this.connectWithCurrentPolicy(portHint, scoped, intent);
  }

  async listTargets(portHint?: number): Promise<{ port: number; targets: HermesTarget[] }> {
    if (this._authoritativeSessionPolicy) {
      return listTargetsOnExactPort(this._authoritativeSessionPolicy.port);
    }
    return discoverForList(this._port, portHint);
  }

  async connectExact(
    port: number,
    filters: ConnectFilters,
    intent: ConnectIntent = 'default',
    targetRetries = 5,
    awaitWithinBoundary?: AwaitWithinBoundary,
    deadline?: number,
  ): Promise<string> {
    this._reconnectDiscover = discoverExactPort;
    this._exactDiscoveryPort = port;
    const connect = () =>
      this.connectWithCurrentPolicy(port, filters, intent, targetRetries, awaitWithinBoundary);
    if (deadline === undefined) return connect();
    return this.withAttachDeadline(deadline, () =>
      withDeadline(deadline, new CDPProbeTimeoutError('CDP attach deadline exceeded'), connect),
    );
  }

  async withAttachDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
    // Restore rather than clear: a rejected overlapping attach must not drop the active one's deadline.
    const previous = this._attachDeadline;
    this._attachDeadline = deadline;
    try {
      return await operation();
    } finally {
      this._attachDeadline = previous;
    }
  }

  // Connect-time reads wait on the runtime's answer until the caller's attach deadline, not the fixed default.
  private _attachDeadline: number | undefined;

  private attachRequestTimeout(): number {
    return this._attachDeadline === undefined
      ? defaultTimeout(this.effectivePlatform)
      : Math.max(1, this._attachDeadline - performance.now());
  }

  private attachReadinessError(error: unknown, what: string): unknown {
    return this._attachDeadline !== undefined && error instanceof CDPRequestTimeoutError
      ? new TargetReadinessTimeoutError(`${what} did not answer before the attach deadline`)
      : error;
  }

  private async evaluateWithinAttach(expression: string): Promise<EvaluateResult> {
    try {
      return await this.evaluate(expression, false, this.attachRequestTimeout());
    } catch (error) {
      throw this.attachReadinessError(error, 'the dev check');
    }
  }

  async listTargetsExact(port: number): Promise<{ port: number; targets: HermesTarget[] }> {
    return listTargetsOnExactPort(this._authoritativeSessionPolicy?.port ?? port);
  }

  get authoritativeSessionPolicy(): AuthoritativeSessionPolicy | undefined {
    return this._authoritativeSessionPolicy;
  }

  setAuthoritativeSessionPolicy(policy: AuthoritativeSessionPolicy): void {
    this._authoritativeSessionPolicy = policy;
    this._exactDiscoveryPort = policy.port;
    this._reconnectDiscover = discoverExactPort;
  }

  clearAuthoritativeSessionPolicy(): void {
    this._authoritativeSessionPolicy = undefined;
    this._exactDiscoveryPort = undefined;
    this._reconnectDiscover = undefined;
  }

  matchesAuthoritativeSessionPolicy(
    port: number,
    filters: Pick<ConnectFilters, 'platform' | 'bundleId'>,
  ): boolean {
    const policy = this._authoritativeSessionPolicy;
    return (
      policy?.port === port &&
      policy.filters.platform === filters.platform &&
      policy.filters.bundleId?.toLowerCase() === filters.bundleId?.toLowerCase()
    );
  }

  createReplacement(port: number): CDPClient {
    const replacement = new CDPClient(port, this._timeNowFn);
    if (this._authoritativeSessionPolicy) {
      replacement.setAuthoritativeSessionPolicy(this._authoritativeSessionPolicy);
    }
    return replacement;
  }

  private _connectFilters: ConnectFilters = {};
  private _reconnectDiscover: typeof discoverExactPort | undefined;
  private _exactDiscoveryPort: number | undefined;

  /** GH #625: pinned device affinity, if an explicit targetId pin captured one. */
  get pinnedDeviceName(): string | undefined {
    return this._connectFilters.deviceName;
  }

  private createAuthoritativeDiscover(
    awaitWithinBoundary?: AwaitWithinBoundary,
  ): typeof discoverExactPort {
    return async (_port, filtersOrPlatform) => {
      const policy = this._authoritativeSessionPolicy;
      if (!policy) throw new Error('Authoritative session policy is unavailable');
      const filters =
        typeof filtersOrPlatform === 'string'
          ? { platform: filtersOrPlatform }
          : (filtersOrPlatform ?? {});
      return discoverAuthoritativeTarget(policy, filters, discoverExactPort, awaitWithinBoundary);
    };
  }

  private async connectWithCurrentPolicy(
    portHint: number | undefined,
    filters: ConnectFilters,
    intent: ConnectIntent,
    targetRetries = 5,
    awaitWithinBoundary?: AwaitWithinBoundary,
  ): Promise<string> {
    const policy = this._authoritativeSessionPolicy;
    const result = await autoConnectFn(
      this.buildConnectCtx(),
      policy?.port ?? this._exactDiscoveryPort ?? portHint,
      policy ? { ...filters, ...policy.filters, targetId: undefined } : filters,
      intent,
      policy ? this.createAuthoritativeDiscover(awaitWithinBoundary) : this._reconnectDiscover,
      targetRetries,
    );
    await this.verifyAuthoritativeConnection(awaitWithinBoundary);
    return result;
  }

  private async discoverAndConnect(portHint?: number, filters?: ConnectFilters): Promise<string> {
    const policy = this._authoritativeSessionPolicy;
    const result = await discoverAndConnectFn(
      this.buildConnectCtx(),
      policy?.port ?? this._exactDiscoveryPort ?? portHint,
      policy ? { ...filters, ...policy.filters, targetId: undefined } : filters,
      policy ? this.createAuthoritativeDiscover() : this._reconnectDiscover,
    );
    await this.verifyAuthoritativeConnection();
    return result;
  }

  private async verifyAuthoritativeConnection(
    awaitWithinBoundary?: AwaitWithinBoundary,
  ): Promise<void> {
    if (!this._authoritativeSessionPolicy) return;
    try {
      const verifyAndReconcile = () =>
        this._authoritativeSessionPolicy!.verifyAndReconcile(this, awaitWithinBoundary);
      await (awaitWithinBoundary ? awaitWithinBoundary(verifyAndReconcile) : verifyAndReconcile());
    } catch (error) {
      this.rejectAllPending(new Error('Authoritative runtime verification failed'));
      if (this.ws) {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
        this.ws = null;
      }
      resetState(this.buildResettableState());
      this.clearActiveState();
      throw error;
    }
  }

  async softReconnect(): Promise<string> {
    // B132: if the proxy is active, suspend it first so the reconnect goes
    // DIRECT to Hermes (not through the potentially-stale proxy), then resume
    // on success so DevTools can reconnect. This covers auto-recovery paths
    // like `cdp_status` __DEV__=false recovery.
    const wasProxyActive = this._proxyUrl !== null;
    if (wasProxyActive) {
      await this._suspendProxy();
    }
    const result = await this._softReconnectDirect();
    if (wasProxyActive) {
      await this._resumeProxy();
    }
    return result;
  }

  /**
   * B132: softReconnect that BYPASSES the suspend/resume wrapper. Used only
   * by `_doStartProxy` — we must not suspend the multiplexer we just allocated.
   * Kept as a named private method (not an inline call) so tests can stub it
   * independently of the public `softReconnect`.
   */
  private async _softReconnectDirect(): Promise<string> {
    return softReconnectFn(this.buildReconnectCtx());
  }

  /**
   * M1b (Phase 100+): start the multiplexer proxy and switch this client's CDP
   * WebSocket to ride through it. After this resolves, React Native DevTools
   * (or any other WS consumer) can connect to the same port and coexist with
   * the MCP. Requires an already-connected target — call `autoConnect` first.
   *
   * No-op if the proxy is already active (returns existing URL). Concurrent
   * callers share a single in-flight promise — the multiplexer is allocated
   * exactly once per successful `(connected → active)` transition.
   */
  async startProxy(opts?: Partial<Omit<MultiplexerOptions, 'hermesUrl'>>): Promise<string> {
    if (this._proxyUrl) return this._proxyUrl;
    if (this._startProxyInFlight) return this._startProxyInFlight;
    this._startProxyInFlight = this._doStartProxy(opts).finally(() => {
      this._startProxyInFlight = null;
    });
    return this._startProxyInFlight;
  }

  private async _doStartProxy(
    opts?: Partial<Omit<MultiplexerOptions, 'hermesUrl'>>,
  ): Promise<string> {
    if (!this._connectedTarget) {
      throw new Error('startProxy requires an active CDP connection — call autoConnect first');
    }
    const hermesUrl = this._connectedTarget.webSocketDebuggerUrl;
    const multiplexer = new CDPMultiplexer({ hermesUrl, ...opts });
    const port = await multiplexer.start();
    this._multiplexer = multiplexer;
    // Phase 134.4: include the per-instance capability token in the
    // exposed URL. DevTools (or any other consumer the user authorizes)
    // connects to `ws://127.0.0.1:<port>/<token>`. Without the token
    // in the path, the multiplexer rejects the WebSocket upgrade.
    // The token itself never appears in logs.
    this._proxyUrl = `ws://127.0.0.1:${port}/${multiplexer.token}`;
    logger.info(
      'CDP',
      `Proxy started on ws://127.0.0.1:${port}/<token>, soft-reconnecting current session`,
    );
    try {
      // B132: call `_softReconnectDirect` instead of `this.softReconnect()`. The
      // wrapper would observe _proxyUrl just set above and try to suspend the
      // multiplexer we just allocated — infinite rollback. `_softReconnectDirect`
      // is also testable in isolation (tests can stub it to simulate failure
      // without the full softReconnectFn machinery).
      await this._softReconnectDirect();
    } catch (err) {
      // Soft-reconnect failed — tear the proxy back down so we don't leave a
      // half-switched state (proxy running but CDPClient disconnected).
      try {
        await multiplexer.stop();
      } catch {
        /* best-effort */
      }
      this._multiplexer = null;
      this._proxyUrl = null;
      throw err;
    }
    // B132: set intent ONLY after the full startup+softReconnect succeeds.
    // If any step failed, _proxyDesired stays false — no surprise auto-resume
    // on the next reconnect.
    this._proxyDesired = true;
    return this._proxyUrl;
  }

  /**
   * M1b: stop the multiplexer and reconnect this client directly to Hermes.
   * No-op if the proxy isn't active.
   */
  async stopProxy(): Promise<void> {
    // B132: clear intent FIRST so the softReconnect wrapper's auto-resume hook
    // (and any in-flight afterReconnect hook from a concurrent reconnect) sees
    // _proxyDesired=false and skips re-allocating a new proxy.
    this._proxyDesired = false;
    if (!this._proxyUrl) return;
    logger.info('CDP', `Stopping proxy at ${this._proxyUrl}`);
    const mux = this._multiplexer;
    this._proxyUrl = null;
    this._multiplexer = null;
    // Reconnect first (uses direct target URL now that _proxyUrl is null), then
    // stop the old proxy. Reverse order would briefly leave the client trying
    // to route through an already-stopped proxy.
    try {
      await this.softReconnect();
    } finally {
      if (mux) {
        try {
          await mux.stop();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * B132: stop the multiplexer without reconnecting the MCP. Called from
   * `handleClose` and the `softReconnect` wrapper BEFORE a reconnect fires, so
   * the reconnect attempts go DIRECT to Hermes. Preserves `_proxyDesired` so
   * `_resumeProxy` can rehydrate the proxy against the fresh target URL after
   * the reconnect succeeds.
   */
  private async _suspendProxy(): Promise<void> {
    if (!this._proxyUrl) return;
    const mux = this._multiplexer;
    // Clear _proxyUrl SYNCHRONOUSLY so any concurrent reconnect observes it
    // cleared before the multiplexer's HTTP server is actually torn down.
    this._proxyUrl = null;
    this._multiplexer = null;
    if (mux) {
      try {
        await mux.stop();
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * B132: if `_proxyDesired` is set and no proxy is currently active, restart
   * the multiplexer against the CURRENT `_connectedTarget` (which may have a
   * different `webSocketDebuggerUrl` after reconnect — that's the whole point).
   *
   * Failure policy: log a warning and CLEAR `_proxyDesired` so we don't
   * silently loop on every subsequent reconnect. User can re-run
   * `cdp_open_devtools` to retry manually. This is "predictable over resilient"
   * — noisy failures are easier to debug than silent retries.
   */
  private async _resumeProxy(): Promise<void> {
    if (!this._proxyDesired) return;
    if (this.disposed) return;
    if (!this._connectedTarget) return;
    if (this._proxyUrl) return;
    try {
      await this.startProxy();
      logger.info('CDP', 'Proxy auto-resumed after reconnect');
    } catch (err) {
      logger.warn(
        'CDP',
        `Proxy auto-resume failed — clearing desired flag. Run cdp_open_devtools to retry: ${err instanceof Error ? err.message : err}`,
      );
      this._proxyDesired = false;
    }
  }

  async disconnect(): Promise<void> {
    // B76/D644: idempotent guard — graceful-shutdown may race with a tool-triggered
    // disconnect (e.g. cdp_restart calling disconnect() while SIGTERM fires). Second
    // caller sees already-disposed and returns cleanly.
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateHelperWorld('explicit_disconnect');
    resetState(this.buildResettableState());
    this.clearActiveState();
    this.stopBackgroundPoll();

    // M1b: tear down multiplexer if one is active. This is the only reliable
    // end-of-session cleanup hook for the proxy (SIGTERM → disconnect → here).
    if (this._multiplexer) {
      try {
        await this._multiplexer.stop();
      } catch {
        /* best-effort */
      }
      this._multiplexer = null;
      this._proxyUrl = null;
    }
    // B132: clear intent on disposal — a fresh CDPClient must not inherit
    // desired=true from a previous session.
    this._proxyDesired = false;

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.rejectAllPending(new Error('Client disconnected'));
  }

  private get effectivePlatform(): Platform {
    return this._connectedTarget?.platform ?? null;
  }

  async evaluate(
    expression: string,
    awaitPromise = false,
    timeoutMs?: number,
  ): Promise<EvaluateResult> {
    if (awaitPromise) {
      return this.evaluateAsync(expression, timeoutMs);
    }

    const timeout = timeoutMs ?? defaultTimeout(this.effectivePlatform);
    const result = (await this.sendWithTimeout(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
      },
      timeout,
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (result?.exceptionDetails) {
      return {
        error:
          result.exceptionDetails.text ??
          result.exceptionDetails.exception?.description ??
          'Unknown evaluation error',
        errorKind: 'evaluation',
      };
    }
    return { value: result?.result?.value };
  }

  private async evaluateAsync(expression: string, timeoutMs?: number): Promise<EvaluateResult> {
    // Hermes needs an expiring async slot because CDP awaitPromise is unsupported.
    throwIfCancelled();
    const timeout = timeoutMs ?? defaultTimeout(this.effectivePlatform);
    const deadline = Date.now() + timeout;
    const slot = '__rn_agent_async_' + ++this.slotId + '_' + Date.now();
    const ASYNC_CLEANUP_MS = timeout * 2;
    const wrapper = `(function() {
      function safeVal(v) {
        try { return JSON.stringify(v); } catch(e) { return JSON.stringify(String(v)); }
      }
      var p = ${expression};
      var startValue;
      try { startValue = p && p.__rnAgentStartValue; } catch(e) {}
      if (p && typeof p.then === 'function') {
        p.then(function(v) { globalThis['${slot}'] = { v: safeVal(v) }; })
         .catch(function(e) { globalThis['${slot}'] = { e: (e && e.message) || String(e) }; });
      } else {
        globalThis['${slot}'] = { v: safeVal(p) };
      }
      setTimeout(function() { delete globalThis['${slot}']; }, ${ASYNC_CLEANUP_MS});
      return { s: safeVal(startValue) };
    })()`;

    let requestDispatched = false;
    let initResult: {
      result?: { value?: { s?: string } };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    try {
      throwIfCancelled();
      if (Date.now() >= deadline)
        return {
          error: 'Async evaluation deadline expired',
          errorKind: 'timeout',
          requestDispatched: false,
        };
      initResult = (await this.sendWithTimeout(
        'Runtime.evaluate',
        {
          expression: wrapper,
          returnByValue: true,
        },
        Math.max(1, deadline - Date.now()),
        () => {
          requestDispatched = true;
        },
      )) as typeof initResult;
    } catch (error) {
      throwIfCancelled();
      return {
        errorKind: evaluationErrorKind(error),
        error: `Async evaluation initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        requestDispatched: requestDispatched && !(error instanceof CDPProtocolError),
      };
    }

    if (initResult?.exceptionDetails) {
      return {
        error:
          initResult.exceptionDetails.text ??
          initResult.exceptionDetails.exception?.description ??
          'Unknown evaluation error',
        errorKind: 'evaluation',
      };
    }
    let asyncStartValue: unknown;
    try {
      if (typeof initResult.result?.value?.s === 'string') {
        asyncStartValue = JSON.parse(initResult.result.value.s);
      }
    } catch {
      asyncStartValue = undefined;
    }

    const clearAsyncSlot = async () => {
      throwIfCancelled();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        await this.sendWithTimeout(
          'Runtime.evaluate',
          { expression: `delete globalThis['${slot}']`, returnByValue: true },
          Math.min(1000, remaining),
        );
      } catch {
        throwIfCancelled();
      }
    };

    while (Date.now() < deadline) {
      throwIfCancelled();
      const remaining = deadline - Date.now();
      if (remaining < 500) break;
      const pollTimeout = Math.min(remaining - 100, 1500);

      let check: { result?: { value?: unknown } };
      try {
        check = (await this.sendWithTimeout(
          'Runtime.evaluate',
          {
            expression: `globalThis['${slot}']`,
            returnByValue: true,
          },
          pollTimeout,
        )) as { result?: { value?: unknown } };
      } catch (error) {
        throwIfCancelled();
        await clearAsyncSlot();
        return {
          value: asyncStartValue,
          errorKind: evaluationErrorKind(error),
          error: `Async evaluation polling failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const val = check?.result?.value as { v?: string; e?: string } | undefined;
      if (val && typeof val === 'object') {
        throwIfCancelled();
        await clearAsyncSlot();

        if ('e' in val)
          return { value: asyncStartValue, error: String(val.e), errorKind: 'evaluation' };
        try {
          return { value: JSON.parse(val.v as string) };
        } catch {
          return { value: val.v };
        }
      }
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }

    throwIfCancelled();
    return {
      errorKind: 'timeout',
      value: asyncStartValue,
      error: 'Promise did not resolve within ' + timeout + 'ms',
    };
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    return this.sendWithTimeout(method, params, timeoutForMethod(method, this.effectivePlatform));
  }

  private handleMessage(data: WebSocket.RawData): void {
    handleMsg(data, this.pending, this.eventHandlers, (params) =>
      this.parseNetworkHookMessage(params),
    );
  }

  private parseNetworkHookMessage(params: unknown): void {
    parseNetHook(params, this._networkMode, this._networkBufferManager, this.activeDeviceKey);
  }

  private async setup(): Promise<void> {
    const setupWs = this.ws;
    const setupTargetId = this._connectedTarget?.id ?? null;
    let setupHelperToken: CDPClient['_helperToken'] | null = null;
    const assertSetupCurrent = (): void => {
      if (
        this._attachDeadline !== undefined &&
        setupWs !== null &&
        this.ws === setupWs &&
        setupWs.readyState === WebSocket.CLOSED
      ) {
        throw new CDPTargetClosedError('CDP target closed during setup');
      }
      const connectionIsCurrent =
        this.ws === setupWs && (this._connectedTarget?.id ?? null) === setupTargetId;
      const helpersAreCurrent =
        setupHelperToken === null || this.isHelperTokenCurrent(setupHelperToken);
      if (!connectionIsCurrent || !helpersAreCurrent) {
        throw new ConnectionSetupSupersededError();
      }
    };
    const sendForSetup = async (
      method: string,
      params?: unknown,
      ms?: number,
    ): Promise<unknown> => {
      assertSetupCurrent();
      const response = await this.sendWithTimeout(
        method,
        params,
        ms ?? timeoutForMethod(method, this.effectivePlatform),
      );
      assertSetupCurrent();
      return response;
    };
    const evaluateForSetup = async (expression: string): Promise<EvaluateResult> => {
      assertSetupCurrent();
      const response = await this.evaluate(expression);
      assertSetupCurrent();
      return response;
    };

    const result = await performSetup({
      send: sendForSetup,
      evaluate: evaluateForSetup,
      setupHelpers: async (waitTimeout) => {
        assertSetupCurrent();
        await waitForReact((expr) => this.evaluateCurrentHelperWorld(expr), waitTimeout);
        assertSetupCurrent();
        setupHelperToken = this._helperToken;
        const helpersInjected = await this.ensureCurrentHelpers('setup_started');
        assertSetupCurrent();
        return helpersInjected;
      },
      port: this._port,
      networkManager: this._networkBufferManager,
      getDeviceKey: () => this.activeDeviceKey,
      setupEventHandlers: () => this.setupEventHandlers(),
      clearScripts: () => this._scripts.clear(),
      clearEventHandlers: () => this.eventHandlers.clear(),
    });
    assertSetupCurrent();
    this._networkMode = result.networkMode;
    // Helper state is owned exclusively by the token-scoped coordinator.
    this._logDomainEnabled = result.logDomainEnabled;
    this._profilerAvailable = result.profilerAvailable;
    this._heapProfilerAvailable = result.heapProfilerAvailable;
  }

  private setupEventHandlers(): void {
    wireEventHandlers(
      this.eventHandlers,
      {
        console: this._consoleBuffer,
        network: this._networkBufferManager,
        log: this._logBuffer,
        scripts: this._scripts,
      },
      (method, params, ms) =>
        this.sendWithTimeout(
          method,
          params,
          ms ?? timeoutForMethod(method, this.effectivePlatform),
        ),
      () => this._isPaused,
      (v) => {
        this._isPaused = v;
      },
      () => this.activeDeviceKey,
      {
        created: (params) => this.handleExecutionContextCreated(params),
        destroyed: (params) => this.handleExecutionContextDestroyed(params),
        cleared: () => this.handleExecutionContextsCleared(),
      },
    );
  }

  private handleClose(code: number): void {
    // Invalidate synchronously before reconnect/reset can await or select a new world.
    this.invalidateHelperWorld('socket_closed');
    // Suspend the proxy before reconnect so the replacement attaches directly.
    if (this._proxyUrl) {
      void this._suspendProxy();
    }
    // The bounded attach owns retry and disposal of its closed socket.
    if (this._attachDeadline !== undefined) {
      resetState(this.buildResettableState());
      return;
    }
    this.ws = null;
    handleCloseFn(this.buildReconnectCtx(), code);
  }

  private async reconnect(): Promise<void> {
    return reconnectFn(this.buildReconnectCtx());
  }

  private startBackgroundPoll(): void {
    startBgPoll(this.buildReconnectCtx());
  }

  private stopBackgroundPoll(): void {
    stopBgPoll(this.buildReconnectCtx());
  }

  private buildReconnectCtx(): ReconnectContext {
    return {
      isDisposed: () => this.disposed,
      isReconnecting: () => this.reconnecting,
      isConnected: () => this.isConnected,
      isSoftReconnectRequested: () => this._softReconnectRequested,
      setReconnecting: (v) => {
        this.reconnecting = v;
      },
      setSoftReconnectRequested: (v) => {
        this._softReconnectRequested = v;
      },
      setState: (s) => {
        this._state = s as CDPClientState;
      },
      setReconnectAttempt: (count, timestamp) => {
        this._reconnectAttemptCount = count;
        this._lastReconnectAttempt = timestamp;
      },
      closeWs: () => {
        if (this.ws) {
          this.ws.removeAllListeners();
          if (
            this.ws.readyState === WebSocket.OPEN ||
            this.ws.readyState === WebSocket.CONNECTING
          ) {
            this.ws.close();
          }
          this.ws = null;
          this._helperContext = null;
          this.invalidateHelperWorld('soft_reconnect');
        }
      },
      rejectAllPending: (reason) => this.rejectAllPending(reason),
      discoverAndConnect: () => this.discoverAndConnect(),
      getResettableState: () => this.buildResettableState(),
      getPort: () => this._port,
      setBgPollTimer: (timer) => {
        this._bgPollTimer = timer;
      },
      getBgPollTimer: () => this._bgPollTimer,
      clearActiveState: () => this.clearActiveState(),
      // B132: after the exponential-backoff reconnect loop succeeds, rehydrate
      // the proxy if one was desired. This is the "auto-resume" half of the
      // suspend→reconnect→resume sequence. softReconnect has its own wrapper
      // and does NOT go through this hook — would double-fire the resume.
      afterReconnect: () => this._resumeProxy(),
      isAutoConnectEnabled: () => this.autoConnectState.enabled,
    };
  }

  private buildConnectCtx(): ConnectContext {
    return {
      isDisposed: () => this.disposed,
      isReconnecting: () => this.reconnecting,
      isSoftReconnectRequested: () => this._softReconnectRequested,
      getState: () => this._state,
      setState: (s) => {
        if (this.disposed && s !== 'disconnected') return;
        this._state = s;
      },
      getPort: () => this._port,
      setPort: (v) => {
        this._port = v;
      },
      getConnectFilters: () => this._connectFilters,
      setConnectFilters: (v) => {
        this._connectFilters = v;
      },
      getWs: () => this.ws,
      setWs: (ws) => {
        if (this.disposed && ws) {
          try {
            ws.terminate();
          } catch {}
          return;
        }
        if (this.ws === ws) return;
        this.ws = ws;
        this._helperContext = null;
        this.invalidateHelperWorld(ws ? 'socket_opened' : 'socket_closed');
      },
      setHelpersInjected: (v) => {
        if (!v) this.invalidateHelperWorld('candidate_rejected');
      },
      setConnectedTarget: (t) => {
        if (this.disposed && t) return;
        if (this._connectedTarget === t) return;
        this._connectedTarget = t;
        this.invalidateHelperWorld(t ? 'candidate_selected' : 'candidate_rejected');
      },
      setConnectedAt: (ms) => {
        if (this.disposed && ms !== null) return;
        this._connectedAt = ms;
      },
      now: () => this._timeNowFn(),
      incrementConnectionGeneration: () => ++this._connectionGeneration,
      evaluate: (expr) => this.evaluate(expr),
      evaluateWithinAttach: (expr) => this.evaluateWithinAttach(expr),
      sendWithTimeout: (method, params, ms) => this.sendWithTimeout(method, params, ms),
      handleMessage: (data) => this.handleMessage(data),
      handleClose: (code) => this.handleClose(code),
      rejectAllPending: (reason) => this.rejectAllPending(reason),
      setup: () => this.setup(),
      getProxyUrl: () => this._proxyUrl,
    };
  }

  private buildResettableState(): ResettableState {
    return {
      setState: (v) => {
        this._state = v;
      },
      setHelpersInjected: (v) => {
        this._helpersInjected = v;
      },
      setBridgeDetected: (v) => {
        this._bridgeDetected = v;
      },
      setBridgeVersion: (v) => {
        this._bridgeVersion = v;
      },
      setConnectedTarget: (v) => {
        this._connectedTarget = v;
      },
      setConnectedAt: (v) => {
        this._connectedAt = v;
      },
      setLogDomainEnabled: (v) => {
        this._logDomainEnabled = v;
      },
      setProfilerAvailable: (v) => {
        this._profilerAvailable = v;
      },
      setHeapProfilerAvailable: (v) => {
        this._heapProfilerAvailable = v;
      },
      clearScripts: () => {
        this._scripts.clear();
      },
    };
  }

  private rejectAllPending(reason: Error): void {
    rejectPending(this.pending, reason);
  }

  private clearActiveState(): void {
    if (this.lifecycleAuthority()) clearActiveFlag();
  }

  private sendWithTimeout(
    method: string,
    params: unknown,
    ms: number,
    onDispatched?: () => void,
  ): Promise<unknown> {
    return sendMsg(this.ws, this.pending, () => ++this.msgId, method, params, ms, onDispatched);
  }
}
