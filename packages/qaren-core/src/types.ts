import type { ReplayEngineStatus } from './domain/engine-pin.js';

export interface CDPMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HermesTarget {
  id: string;
  title: string;
  /** Legacy inspector metadata. Modern Bridgeless Hermes targets may omit this field. */
  vm?: string;
  webSocketDebuggerUrl: string;
  description?: string;
  /** Metro may expose the exact application identifier separately from description. */
  appId?: string;
  type?: string;
  platform?: 'ios' | 'android';
  /**
   * Metro /json/list includes this field for RN 0.76+. It disambiguates
   * iOS vs Android when the same bundleId is installed on both (B131/D660).
   */
  deviceName?: string;
  /**
   * B116 (D639): set true when the bundleId is installed on BOTH iOS sim AND
   * Android emulator and neither inference source could disambiguate. Callers
   * should pass `targetId` or `bundleId + platform` for exact selection.
   */
  ambiguousPlatform?: boolean;
  /** Internal discovery evidence; public platform remains the legacy union. */
  platformInference?: 'probed' | 'defaulted' | 'ambiguous';
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  timestamp: string;
  status?: number;
  duration_ms?: number;
  bodyAvailable?: boolean;
  bodySize?: number;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  isFatal?: boolean;
  type?: string;
  timestamp: string;
}

export interface LogEntry {
  source: string;
  level: string;
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export type CDPClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** GH #303: a candidate Metro found while resolving which port to drive. */
export interface MetroCandidate {
  port: number;
  attached: boolean;
  cwd: string | null;
  isConnected: boolean;
  matchesProjectRoot: boolean;
}

export interface StatusResult {
  metro: {
    running: boolean;
    port: number | null;
    /** M5 (D656): true when the MetroEventsClient has an open WS to Metro's /events endpoint. */
    eventsConnected?: boolean;
    /** M5 (D656): most recent bundle build status + timestamp (null if no events seen yet). */
    lastBuild?: { status: 'started' | 'done' | 'failed'; timestamp: string } | null;
    /** M5 (D656): count of bundle_build_failed events observed since MCP connected. */
    buildErrors?: number;
    // GH #303: worktree disambiguation diagnostics.
    candidates?: MetroCandidate[];
    projectRoot?: string;
    servingCwd?: string | null;
    timings_ms?: { probe: number; cwd: number };
  };
  cdp: {
    connected: boolean;
    device: string | null;
    pageId: string | null;
    platform: string | null;
    /** B111 (D643): target.description (bundleId from Metro) — surfaces which app the MCP attached to. */
    bundleId: string | null;
    /** iOS sessions bind only to platform+bundle class; Metro exposes no UDID. */
    affinityScope?: 'best-available' | 'platform-bundle-class' | 'platform-bundle-device-kind';
  };
  app: {
    platform: string | null;
    dev: boolean | null;
    hermes: boolean | null;
    rnVersion: string | null;
    dimensions: { width: number; height: number } | null;
    hasRedBox: boolean;
    isPaused: boolean;
    errorCount: number;
    bootErrorCount?: number;
    /** M10 / Phase 110: RN architecture — 'new' (Fabric), 'old' (classic bridge), 'unknown' (probe failed or non-RN). Optional for older callers. */
    architecture?: 'new' | 'old' | 'unknown';
  };
  capabilities: {
    networkDomain: boolean;
    fiberTree: boolean;
    networkFallback: boolean;
    bridgeDetected: boolean;
    bridgeVersion: number | null;
    /** M1 (D654): true when RN >= 0.85 supports native multi-debugger (DevTools + MCP can coexist without proxy). */
    supportsMultipleDebuggers: boolean;
    /**
     * D1202: explicit __QAREN helpers status. true when the helper bundle
     * is exactly current in the captured Hermes execution context; false
     * during setup, context churn, or after missing/version-mismatched evidence.
     * A false value alone does not prove that JavaScript is hung.
     */
    helpersInjected: boolean;
  };
  domains: {
    runtime: boolean;
    debugger: boolean;
    network: boolean;
    log: boolean;
    profiler: boolean;
    heapProfiler: boolean;
  };
  reconnect: {
    active: boolean;
    lastAttempt: string | null;
    attemptCount: number;
  };
  /** Spec 2026-06-10-debugger-seat-optout: resolved autoConnect mode and its source. */
  // keep in sync with AutoConnectResolution (project-config.ts)
  autoConnect?: {
    enabled: boolean;
    source: 'env' | 'config' | 'default';
  };
  /** GH#264 Phase 5: supervision facts the supervisor sets via env at each worker spawn. */
  bridge?: {
    supervised: boolean;
    workerRestarts: number;
    lastWorkerExit: string | null;
  };
  /**
   * #210: iOS device-session visibility. `sessionOpen` is whether a device session
   * has been opened; `rnFastRunner` is the XCUITest runner's liveness (only probed
   * when an iOS session is open — `dead` otherwise, never misreported as down when
   * simply never started). `foreignRunner.detected` means a Maestro/WDA flow currently
   * owns the device. iOS-focused; on Android `rnFastRunner` is always `'dead'` (the iOS
   * runner is never used). Always populated by buildStatusResult.
   */
  deviceSession?: {
    sessionOpen: boolean;
    rnFastRunner: 'alive' | 'stale' | 'dead';
    appId?: string;
    deviceId?: string;
    foreignRunner?: { detected: true };
    runnerProtocol?: {
      expected: number;
      runner?: number;
      runnerVersion?: string;
      pluginVersion?: string;
      compatible: boolean;
    };
    // GH #382: prebuilt (cache/download) vs local xcodebuild — /doctor renders it.
    runnerProvenance?: 'prebuilt' | 'local';
  };
  /**
   * Task 6: active action-store backend. One of `'sqlite'`, `'legacy-files'`,
   * or a `degraded:<reason>` string (`'degraded:sqlite-unavailable'` /
   * `'degraded:open-failed'`). Populated by `storeMode()` — read-only, never
   * creates or migrates the DB.
   */
  actionStore?: string;
  /**
   * GH #397: which replay engine will run + version-vs-pin + known quirks.
   * Computed lazily from getEngineStatus(); omitted only if
   * detection itself throws (fail-open).
   */
  replayEngine?: ReplayEngineStatus;
  /**
   * M1b (Phase 100+): multiplexer proxy state. `active: true` means React Native
   * DevTools can coexist with the MCP by connecting to `port` on localhost.
   * `consumerCount` is the number of DevTools/other-debugger instances connected
   * to the proxy (excluding the MCP itself).
   */
  proxy: {
    active: boolean;
    port: number | null;
    url: string | null;
    consumerCount: number;
  };
}

export interface EvaluateResult {
  value?: unknown;
  error?: string;
  requestDispatched?: boolean;
}

export type ToolErrorCode =
  | 'SESSION_AUTHORITY_REQUIRED'
  | 'SESSION_NOT_INITIALIZED'
  | 'SESSION_OWNER_LOST'
  | 'AUTHORITY_STORE_UNAVAILABLE'
  | 'PROCESS_BIRTH_UNAVAILABLE'
  | 'SOURCE_WORKTREE_MISMATCH'
  | 'SOURCE_ROOT_DIVERGENCE' // GH #776: caller's declared project root is not the session's bound source root
  | 'SOURCE_REVISION_NOT_BUNDLED'
  | 'METRO_PORT_CLAIM_CONFLICT'
  | 'PORT_OCCUPIED_UNOWNED'
  | 'METRO_AUTHORITY_MISMATCH'
  | 'METRO_CLEANUP_PENDING'
  | 'METRO_ORIGIN_MISMATCH'
  | 'METRO_INSTANCE_CHANGED'
  | 'PHYSICAL_ANDROID_METRO_UNREACHABLE'
  | 'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN'
  | 'DEVICE_CLAIM_CONFLICT'
  | 'DEVICE_DISCOVERY_UNAVAILABLE'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_RECEIPT_INCOMPATIBLE'
  | 'APP_INSTALL_IDENTITY_CHANGED'
  | 'PLATFORM_AUTHORITY_MISMATCH'
  | 'BUNDLE_HANDSHAKE_UNAVAILABLE'
  | 'BUNDLE_IDENTITY_MISMATCH'
  | 'CDP_TARGET_AUTHORITY_MISMATCH'
  | 'RUNNER_OWNERSHIP_MISMATCH'
  | 'RUNNER_ADOPTION_REQUIRED'
  | 'ANDROID_API_UNSUPPORTED' // GH #741: device API below the pinned engine's minimum
  | 'EXACT_ANDROID_DEVICE_REQUIRED'
  | 'AUTOMATION_CLEANUP_UNPROVEN'
  | 'PICK_DATE_TIMEOUT'
  | 'PICK_DATE_INCOMPLETE'
  | 'RECORDING_AUTHORITY_MISMATCH'
  | 'OBSERVE_AUTHORITY_MISMATCH'
  | 'PROOF_AUTHORITY_MISMATCH'
  | 'HANDOFF_NOT_AUTHORIZED'
  | 'STALE_LEASE_NOT_RECLAIMABLE'
  | 'AUTHORITY_LOST_DURING_OPERATION'
  | 'OPERATION_ALREADY_IN_PROGRESS'
  | 'AUTHORITY_STORE_BUSY'
  | 'DIAGNOSTIC_MODE_READ_ONLY'
  | 'TARGET_SESSION_MISMATCH'
  | 'PLATFORM_TARGET_NOT_FOUND'
  | 'TARGET_PLATFORM_CONFLICT'
  | 'STALE_TARGET'
  | 'HELPERS_STALE'
  | 'DEV_MENU_HIDE_FAILED'
  | 'RECONNECT_TIMEOUT'
  | 'CONNECT_IN_FLIGHT' // GH #616: a reconnect/connect is in flight; force=true supersedes it
  | 'APP_DETACHED' // GH #208 (RC2/RC3): Metro up but 0 Hermes targets (app detached)
  | 'DEV_MENU_HIDE_UNVERIFIED'
  | 'APP_NOT_INSTALLED' // GH #262: relaunch failed and get_app_container confirms the bundle is missing
  | 'NOT_CONNECTED'
  | 'HELPERS_NOT_INJECTED'
  // M6 / Phase 112 (D669): cdp_record_test_* tool family.
  | 'DEV_MODE_REQUIRED'
  | 'EVAL_FAILED'
  | 'BAD_RESPONSE'
  | 'START_FAILED'
  | 'NO_EVENTS'
  | 'NOT_IMPLEMENTED'
  | 'NOT_RECORDING'
  | 'NO_PROJECT_ROOT'
  | 'BAD_FILENAME'
  | 'LOAD_FAILED'
  | 'BAD_RECORDING'
  // GH #60 Feature-c (D687): device_reset_state composite tool.
  | 'DEVICE_RESET_INVALID_ARGS'
  | 'DEVICE_RESET_STATE_PARTIAL'
  | 'DEVICE_RESET_RECONNECT_FAILED'
  | 'CDP_NOT_CONNECTED'
  // CDP tool review batch 2026-04-29.
  | 'CDP_TARGET_APP_MISMATCH' // CDP-003
  | 'INVALID_PLATFORM' // CDP-014
  | 'PROFILER_UNAVAILABLE' // CDP-007
  | 'NATIVE_LOG_UNAVAILABLE' // CDP-016
  // D1206 Tier 2 Sprint A/B post-review batch 2026-04-30.
  | 'TESTID_NOT_FOUND' // device_batch testID-keyed step / expect_visible_by_testid
  // GH #386 (Story 05 Task 8): device_batch testID resolved to >1 element for
  // a mutating step (press / fill / find+tap) — refuse rather than guess-tap.
  | 'AMBIGUOUS_TESTID'
  // GH #588: device_press argument refusal (exactly one of ref / x+y required).
  | 'INVALID_ARGUMENT'
  | 'ASSERTION_FAILED' // expect_redux / expect_route / expect_text / expect_visible_by_testid
  | 'APP_HAS_REDBOX' // React-tree proof cannot classify selectors while the app error screen is active
  | 'SNAPSHOT_FAILED' // agent-device snapshot returned ok:false (distinct from "not present")
  | 'RN_FAST_RUNNER_DOWN' // #210: iOS rn-fast-runner not running and could not be auto-spawned (not prebuilt / no device)
  | 'RN_ANDROID_RUNNER_DOWN' // #243: rn-android-runner not reachable (cold-start race / can't bind port)
  | 'APP_LAUNCH_FAILED' // app launcher failed after the native runner was already ready
  | 'SCREENSHOT_FAILED' // rn-android-runner screenshot response missing pngBase64 payload
  | 'PATH_NOT_FOUND' // expect_redux when getStoreState surfaces __agent_error
  | 'STORE_TRUNCATED' // expect_redux when store payload exceeded safeStringify cap
  // Phase 134.2: appId / packageName validation at adb shell boundary.
  | 'INVALID_APPID' // device_permission
  // The exact Android owner rejected its single accessibility mutation.
  | 'SET_TEXT_REJECTED'
  // GH #581: exact fill truth — no unique bound input (nothing was typed)…
  | 'NO_TEXT_INPUT_TARGET'
  // …or the bound input did not gain/keep focus, or the focus point sits
  // inside the visible keyboard (typed by the runner; mutation:'none').
  | 'TEXT_TARGET_FOCUS_FAILED'
  | 'FOCUS_TARGET_OCCLUDED'
  | 'TYPE_OPERATION_FAILED' // runner type raised; field value unknown (mutation:'possible')
  | 'VERIFY_OPERATION_FAILED' // runner verifyInput failed to execute
  | 'TYPE_IDLE_TIMEOUT' // Android idle-detect fired post-dispatch; unverified (mutation:'possible')
  // GH #418: command-surface gate.
  | 'UNSUPPORTED_COMMAND' // runner rejected a verb its artifact predates (typed by the runner)
  | 'RUNNER_COMMANDS_STALE' // liveness gate: artifact lacks required commands; re-open to rebuild
  | 'DEVICE_RESET_INVALID_APPID' // device_reset_state
  | 'INVALID_PACKAGE_NAME' // device_deeplink
  | 'INVALID_BUNDLE_ID' // GH #262 codex-pair: cdp_restart explicit bundleId arg failed strict validation
  // GH #105 / B153: cdp_repair_action's snapshot landed on Agent Device Runner.
  | 'RUNNER_LEAK'
  // GH #317: rn-fast-runner sees the selector but Maestro/WDA reported it not visible (empty a11y tree).
  | 'TRANSPORT_BLIND'
  // GH #317 Phase 2
  | 'UNSUPPORTED_STEP'
  // GH #397 Phase 2: probe-routed CDP/JS replay failed — maestro was never
  // attempted, so this is NOT transport-blindness evidence (may be app drift
  // or a stale anchor); non-decisive for the blind-probe latch.
  | 'FALLBACK_REPLAY_FAILED'
  // GH #397 Phase 1: RN_ENGINE_PIN_STRICT=1 and the engine pin status is a
  // proven divergence (drift-newer / drift-older / checksum-mismatch).
  | 'ENGINE_PIN_MISMATCH'
  // Managed dev-client replay refuses state clearing before runner invocation.
  | 'DEV_CLIENT_CLEARSTATE_REFUSED'
  // GH #105 / iOS-MVP §3.1: runIOS press/fill with a @ref no longer in the
  // ref-map (snapshot is stale / UI re-rendered). Caller must device_snapshot
  // to refresh refs, then retry.
  | 'TARGET_AMBIGUOUS'
  | 'STALE_REF'
  | 'KEYBOARD_TARGET_STALE'
  // GH #370/#379: iOS keyboard guard verify-or-refuse arm. The TS layer may
  // retry after injected Keyboard.dismiss() proves the keyboard hidden (#379).
  | 'KEYBOARD_OCCLUDED'
  | 'KEYBOARD_DISMISS_FAILED'
  | 'INTERACTION_NOT_ACTUATED'
  // GH #736: an Android @ref owned by a package other than the session app was
  // handed to an app-scoped mutating verb (device_press / device_fill / longpress).
  | 'OUTSIDE_APP_WINDOW'
  | 'INTERACTION_EFFECT_UNVERIFIED'
  | 'RUNNER_TIMEOUT'
  | 'WDA_BOOTSTRAP_FAILED'
  // Same-screen native proof saw a selector that XCTest/WDA missed; versions remain diagnostic only.
  | 'NATIVE_SURFACE_BLIND'
  // Direct maestro-runner/WDA device evidence did not match the exact target.
  | 'DEVICE_AUTHORITY_MISMATCH'
  // GH #791: an authority session is present but no device binding is provable.
  | 'DEVICE_AUTHORITY_UNBOUND'
  // Audit B5: cross_platform_verify verdict FAIL (elements differ across
  // platforms) — distinct from the partial-coverage missing-snapshot warning.
  | 'CROSS_PLATFORM_MISMATCH'
  // GH #184: cdp_status aborted fast because the Dev Client picker was blocking
  // the bundle (React unreachable on a non-Hermes target within the budget).
  | 'PICKER_BLOCKING'
  // GH #186: cdp_run_action replay hit structural route-drift (live route off
  // the action's expectedRouteSequence) — distinct from a stale selector.
  | 'ROUTE_DRIFT'
  // GH #136: cdp_dismiss_dev_client_picker called with no active device session.
  | 'DEV_CLIENT_PICKER_NO_SESSION'
  // GH #202 Phase 2a: DeviceSessionArbiter refused an op because an exclusive
  // Maestro flow is in flight (or the requesting op is a flow and another op is
  // active). Refuse-fast, never queue.
  | 'BUSY_FLOW_ACTIVE'
  // GH#186 Phase 6: a FOREIGN Maestro/XCUITest session holds the flow plane
  // (UDID-scoped detection). L2/L3 refuse fast; L1 reads stay free.
  | 'BUSY_FOREIGN_FLOW'
  // GH #581: exact fill refused before or after its single mutation.
  | 'TEXT_ENTRY_UNVERIFIED'
  | 'NO_TEXT_INPUT_TARGET'
  | 'TEXT_TARGET_LOST'
  | 'TEXT_TARGET_FOCUS_FAILED'
  // eradicate-agent-device Phase 2: runNative has no legacy daemon/CLI tier to fall to.
  | 'NO_NATIVE_ROUTE'
  // eradicate-agent-device Phase 2 Task 9: RN_ANDROID_RUNNER=0 set explicitly — disabled by operator.
  | 'RUNNER_DISABLED'
  // GH #656: runner lacks the feature required for exact keyboard targeting.
  | 'RN_FAST_RUNNER_STALE'
  // A SpringBoard alert tap the runner refused before tapping, or one it could not prove.
  | 'SYSTEM_ALERT_NOT_FOUND'
  | 'SYSTEM_ALERT_BUTTON_NOT_FOUND'
  | 'SYSTEM_ALERT_BUTTON_AMBIGUOUS'
  | 'SYSTEM_ALERT_CHANGED'
  | 'SYSTEM_ALERT_TAP_FAILED'
  | 'DIALOG_TAP_UNPROVEN'
  // GH #383: runner speaks an incompatible wire protocol even after the
  // reap-and-reinstall path ran — stale prebuilt artifacts need a rebuild.
  | 'RUNNER_PROTOCOL_MISMATCH'
  // E2E regression runner (2026-06-18)
  | 'NOT_FOUND'
  | 'ALREADY_LOCKED'
  | 'STRICT_RUN_FAILED'
  | 'PARAMS_UNSUPPORTED'
  | 'MISSING_PARAMS'
  | 'SETUP_ERROR'
  | 'NO_E2E_TESTS'
  | 'E2E_RUN_ACTIVE'
  | 'E2E_RUN_CRASHED';

export interface ResultEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: ToolErrorCode;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

export interface SessionState {
  name: string;
  platform?: string;
  deviceId?: string;
  openedAt: string;
  /**
   * B35: bundleId saved at session-open time. Used by runner-leak-recovery to
   * close+reopen the session when the agent-device daemon misroutes commands
   * to AgentDeviceRunner instead of the target app on iOS.
   */
  appId?: string;
}

export interface FastRunnerState {
  schemaVersion: 1;
  port: number;
  pid: number;
  deviceId: string;
  bundleId: string;
  startedAt: string;
  protocolVersion: number;
  runnerVersion?: string;
  // GH #382: how this runner's artifact was obtained — prebuilt (cache/download)
  // vs a local xcodebuild. Surfaced by doctor / cdp_status.
  provenance?: 'prebuilt' | 'local';
  quiescence?: 'active' | 'disabled' | 'unavailable';
  instanceId?: string;
  sessionId?: string;
  claimEpoch?: number;
  capability?: string;
  processBirth?: string;
}
