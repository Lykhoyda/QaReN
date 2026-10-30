import {
  interruptible,
  isAbort,
  sleep,
  cancellationSignal,
  throwIfCancelled,
  withDeadline,
} from '../domain/cancellation.js';
import type { DevOverlayObservation, DevOverlayReadError } from '../domain/dev-overlay.js';
import { AppProcessGoneError } from '../domain/app-process.js';
import { defaultTimeout } from '../cdp/timeout-config.js';
import { SessionAuthorityError } from '../domain/authority-error.js';
import { CDPRequestTimeoutError, CDPTargetClosedError } from '../cdp/transport.js';
import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, warnResult, withConnection, type ToolResult } from '../utils.js';
import {
  hideExpoDevMenu,
  type ForegroundSurface,
  type HideDevMenuCallOutcome,
} from './expo-dev-menu.js';

type DevAction =
  | 'reload'
  | 'toggleInspector'
  | 'togglePerfMonitor'
  | 'dismissRedBox'
  | 'disableDevMenu'
  | 'disableFastRefresh'
  | 'hideDevMenu'
  | 'hideDevMenuFab';

// Close an open menu before changing its preferences.
export const WALK_DEV_SETTINGS = [
  'hideDevMenu',
  'hideDevMenuFab',
  'disableDevMenu',
  'disableFastRefresh',
] as const;

const DEV_FAB_READ_INTERVAL_MS = 250;
// A loaded host can time out the preferences call once; a hide that keeps failing still refuses.
const DEV_FAB_HIDE_ATTEMPTS = 3;

// Android reloads the JS bundle whenever hot loading is set, so the walk must wait for the reloaded app.
export interface FastRefreshReload {
  // Before the setting: marks the runtime the reload replaces.
  mark(): Promise<void>;
  // After it: resolves once the reloaded app is proven ready, and throws a typed refusal otherwise.
  settled(): Promise<void>;
}

export interface DevOverlayDependencies {
  devSettings(args: {
    action: (typeof WALK_DEV_SETTINGS)[number];
    timeoutMs?: number;
  }): Promise<ToolResult>;
  observeDevOverlay(): Promise<DevOverlayObservation>;
  deadline: number;
  reconnect?(): Promise<void>;
  now?(): number;
  log(message: string): void;
  sleep?(ms: number): Promise<void>;
  fastRefreshReload?: FastRefreshReload;
}

type OverlaySubreason = 'READ_FAILED' | 'NOT_HIDDEN' | 'EVALUATE_TIMEOUT' | 'EVALUATE_FAILED';

function envelopeCode(result: ToolResult): unknown {
  try {
    return JSON.parse(result.content[0]?.text ?? '').code;
  } catch {
    return undefined;
  }
}

function readErrorClass(error: unknown): DevOverlayReadError {
  if (
    error instanceof CDPRequestTimeoutError ||
    (error instanceof DOMException && error.name === 'TimeoutError')
  )
    return 'timeout';
  if (error instanceof CDPTargetClosedError) return 'transport';
  return 'other';
}

function rethrowCancellationOrAuthority(error: unknown): void {
  if (
    isAbort(error) ||
    error instanceof SessionAuthorityError ||
    error instanceof AppProcessGoneError
  )
    throw error;
}

export function clearDevOverlays(deps: DevOverlayDependencies): Promise<ToolResult> {
  return clearOverlays(deps, WALK_DEV_SETTINGS);
}

async function clearOverlays(
  deps: DevOverlayDependencies,
  actions: readonly (typeof WALK_DEV_SETTINGS)[number][],
  recovering = false,
): Promise<ToolResult> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const expired = new Error('dev-overlay admission deadline');
  const witness: {
    phase: 'read' | 'evaluate' | 'evaluate_retry' | 'other';
    observation: DevOverlayObservation;
  } = { phase: 'read', observation: { state: 'unknown', error: 'timeout' } };
  let readAttempts = 0;
  let evaluateAttempts = 0;
  let lastEvaluationSubreason: OverlaySubreason = 'EVALUATE_FAILED';
  let lastError: DevOverlayReadError | 'evaluation' | 'none' = 'none';
  const remaining = () => Math.max(0, deps.deadline - now());
  const pause = async () => {
    const ms = Math.min(DEV_FAB_READ_INTERVAL_MS, remaining());
    if (ms > 0) await (deps.sleep ?? sleep)(ms);
    throwIfCancelled();
  };
  const refused = (subreason: OverlaySubreason) =>
    failResult(
      `Dev-overlay proof: ${subreason.toLowerCase()}; reads=${readAttempts}; evaluations=${evaluateAttempts}; elapsed_ms=${Math.max(0, Math.round(now() - started))}; last_error=${lastError}${witness.observation.state === 'shown' ? `; front=${witness.observation.front}` : ''}.`,
      `DEV_MENU_HIDE_UNVERIFIED_${subreason}`,
      { action: 'clearDevOverlays' },
    );
  const read = async () => {
    witness.phase = 'read';
    witness.observation = { state: 'unknown', error: 'timeout' };
    readAttempts++;
    try {
      witness.observation = await deps.observeDevOverlay();
    } catch (error) {
      rethrowCancellationOrAuthority(error);
      witness.observation = { state: 'unknown', error: readErrorClass(error) };
    }
    throwIfCancelled();
    lastError = witness.observation.state === 'unknown' ? witness.observation.error : 'none';
    return witness.observation;
  };
  const operation = async () => {
    if (recovering) {
      try {
        await deps.reconnect?.();
      } catch (error) {
        rethrowCancellationOrAuthority(error);
        lastError = readErrorClass(error);
        return refused('READ_FAILED');
      }
      throwIfCancelled();
      const initial = await read();
      const hidden = await deps.devSettings({ action: 'hideDevMenu', timeoutMs: remaining() });
      throwIfCancelled();
      if (hidden.isError || (initial.state === 'clear' && envelopeData(hidden)?.executed === false))
        return hidden;
    }
    for (const action of actions) {
      const attempts = action === 'hideDevMenuFab' ? DEV_FAB_HIDE_ATTEMPTS : 1;
      let failed = false;
      let subreason: OverlaySubreason = 'EVALUATE_FAILED';
      for (let attempt = 0; attempt < attempts; attempt++) {
        throwIfCancelled();
        if (remaining() <= 0) throw expired;
        if (attempt > 0) await pause();
        if (remaining() <= 0) throw expired;
        witness.phase = action === 'hideDevMenuFab' ? 'evaluate' : 'other';
        if (witness.phase === 'evaluate') evaluateAttempts++;
        const reload = action === 'disableFastRefresh' ? deps.fastRefreshReload : undefined;
        await reload?.mark();
        let result: ToolResult;
        try {
          result = await deps.devSettings({ action, timeoutMs: remaining() });
        } catch (error) {
          rethrowCancellationOrAuthority(error);
          lastError = readErrorClass(error);
          result = failResult(
            'Dev settings failed',
            lastError === 'timeout'
              ? 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT'
              : 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_FAILED',
          );
        }
        throwIfCancelled();
        failed = result.isError === true;
        if (!failed && envelopeData(result)?.executed === true) await reload?.settled();
        if (!failed) break;
        subreason =
          envelopeCode(result) === 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT'
            ? 'EVALUATE_TIMEOUT'
            : 'EVALUATE_FAILED';
        lastError = subreason === 'EVALUATE_TIMEOUT' ? 'timeout' : 'evaluation';
        if (action === 'hideDevMenuFab') {
          lastEvaluationSubreason = subreason;
          witness.phase = 'evaluate_retry';
        }
      }
      if (!failed) continue;
      if (action === 'hideDevMenuFab') return refused(subreason);
      deps.log(`${action}: failed`);
    }
    witness.phase = 'read';
    while (remaining() > 0) {
      if ((await read()).state === 'clear')
        return okResult({ action: 'clearDevOverlays', executed: true });
      await pause();
    }
    throw expired;
  };
  try {
    return await withDeadline(deps.deadline, expired, operation);
  } catch (error) {
    throwIfCancelled();
    if (error !== expired) throw error;
    if (witness.phase === 'evaluate_retry') return refused(lastEvaluationSubreason);
    if (witness.phase === 'evaluate') {
      lastError = 'timeout';
      return refused('EVALUATE_TIMEOUT');
    }
    if (witness.observation.state === 'shown') return refused('NOT_HIDDEN');
    lastError = witness.observation.state === 'unknown' ? witness.observation.error : 'timeout';
    return refused('READ_FAILED');
  }
}

export function recoverDevOverlays(deps: DevOverlayDependencies): Promise<ToolResult> {
  return clearOverlays(
    deps,
    WALK_DEV_SETTINGS.filter(
      (action) =>
        action !== 'hideDevMenu' && (!deps.fastRefreshReload || action !== 'disableFastRefresh'),
    ),
    true,
  );
}

function envelopeData(result: ToolResult): { executed?: unknown } | undefined {
  try {
    const { data } = JSON.parse(result.content[0]?.text ?? '') as { data?: { executed?: unknown } };
    return data;
  } catch {
    return undefined;
  }
}

const HIDE_DEV_MENU_FAB = `(async function () {
  var m = globalThis.expo && globalThis.expo.modules && globalThis.expo.modules.DevMenuPreferences;
  if (!m || typeof m.setPreferencesAsync !== 'function') return "no_method_available";
  await m.setPreferencesAsync({ showFloatingActionButton: false, showsAtLaunch: false, motionGestureEnabled: false, touchGestureEnabled: false });
  var p = typeof m.getPreferencesAsync === 'function' ? await m.getPreferencesAsync() : null;
  return p && p.showFloatingActionButton === false ? "ok" : "unverified";
})()`;

const RESOLVE_DEV_SETTINGS = `(function() {
  if (typeof __turboModuleProxy === 'function') try { var ds = __turboModuleProxy("DevSettings"); if (ds) return ds; } catch(e) {}
  if (typeof globalThis.nativeModuleProxy !== 'undefined') try { var ds2 = globalThis.nativeModuleProxy.DevSettings; if (ds2) return ds2; } catch(e) {}
  if (typeof globalThis.__fbBatchedBridge !== 'undefined') try { var ds3 = globalThis.__fbBatchedBridge.getCallableModule("DevSettings"); if (ds3) return ds3; } catch(e) {}
  try { return require("react-native").DevSettings; } catch(e) {}
  return null;
})()`;

const ACTION_EXPRESSIONS: Record<Exclude<DevAction, 'hideDevMenu' | 'hideDevMenuFab'>, string> = {
  reload: `(function() { var ds = ${RESOLVE_DEV_SETTINGS}; if (!ds || !ds.reload) throw new Error("DevSettings not available"); ds.reload(); return "ok"; })()`,
  toggleInspector: `(function() { var ds = ${RESOLVE_DEV_SETTINGS}; if (!ds || !ds.toggleElementInspector) throw new Error("DevSettings not available"); ds.toggleElementInspector(); return "ok"; })()`,
  togglePerfMonitor: `(function() { var ds = ${RESOLVE_DEV_SETTINGS}; if (!ds) throw new Error("DevSettings not available"); if (ds.togglePerformanceMonitor) { ds.togglePerformanceMonitor(); } else if (ds.togglePerfMonitor) { ds.togglePerfMonitor(); } else { return "no_method_available"; } return "ok"; })()`,
  disableDevMenu: `(function() {
    try {
      var ds = ${RESOLVE_DEV_SETTINGS};
      if (ds && typeof ds.setIsShakeToShowDevMenuEnabled === 'function') {
        ds.setIsShakeToShowDevMenuEnabled(false);
        return "ok";
      }
    } catch(e) {}
    return "no_method_available";
  })()`,
  disableFastRefresh: `(function() {
    try {
      var ds = ${RESOLVE_DEV_SETTINGS};
      if (ds && typeof ds.setHotLoadingEnabled === 'function') {
        ds.setHotLoadingEnabled(false);
        return "ok";
      }
    } catch(e) {}
    return "no_method_available";
  })()`,
  dismissRedBox: `(function() {
    try { var ds = (typeof __turboModuleProxy === 'function') ? __turboModuleProxy("DevSettings") : null; if (ds && typeof ds.dismissRedbox === 'function') { ds.dismissRedbox(); return "ok"; } } catch(e0) {}
    try { var ds2 = require("react-native").DevSettings; if (ds2 && typeof ds2.dismissRedbox === 'function') { ds2.dismissRedbox(); return "ok"; } } catch(e0b) {}
    try { require("react-native/Libraries/LogBox/Data/LogBoxData").clear(); return "ok"; } catch(e1) {}
    try { var gd = globalThis.__logBoxData; if (gd && typeof gd.clear === 'function') { gd.clear(); return "ok"; } } catch(e2) {}
    try { var LB = require("react-native").LogBox; if (LB && typeof LB.ignoreAllLogs === 'function') { LB.ignoreAllLogs(true); LB.ignoreAllLogs(false); return "ok"; } } catch(e3) {}
    return "no_method_available";
  })()`,
};

interface DevSettingsHandlerDependencies {
  probeForegroundSurface?: () => Promise<ForegroundSurface>;
  settleAfterHide?: () => Promise<void>;
}

function unverifiedHideResult(
  call: HideDevMenuCallOutcome,
  before: ForegroundSurface,
  after: ForegroundSurface,
) {
  return failResult(
    `${call.reason} The Expo Developer Menu close could not be verified; classify the foreground surface again before choosing a remedy.`,
    'DEV_MENU_HIDE_UNVERIFIED',
    {
      action: 'hideDevMenu',
      outcome: 'DEV_MENU_HIDE_UNVERIFIED',
      callSent: call.callSent,
      attempts: call.attempts,
      method: call.method,
      surfaceBefore: before,
      surfaceAfter: after,
      remedy: 'Classify the foreground surface again and invoke only its matching remedy.',
    },
  );
}

function failedHideResult(call: HideDevMenuCallOutcome, before: ForegroundSurface) {
  return failResult(call.reason, 'DEV_MENU_HIDE_FAILED', {
    action: 'hideDevMenu',
    outcome: 'DEV_MENU_HIDE_FAILED',
    callSent: false,
    attempts: call.attempts,
    surfaceBefore: before,
    remedy: 'Classify the foreground surface again before choosing a remedy.',
  });
}

export function createDevSettingsHandler(
  getClient: () => CDPClient,
  dependencies: DevSettingsHandlerDependencies = {},
) {
  const handler = async (args: { action: DevAction; timeoutMs?: number }, client: CDPClient) => {
    const timeoutMs = Math.min(
      args.timeoutMs ?? Infinity,
      defaultTimeout(client.connectedTarget?.platform),
    );
    if (args.action === 'hideDevMenu') {
      const probe = dependencies.probeForegroundSurface;
      const before = probe
        ? await interruptible(probe).catch(() => {
            cancellationSignal();
            return 'unknown' as const;
          })
        : 'unknown';
      if (before !== 'unknown' && before !== 'expo_dev_menu') {
        return okResult({
          action: args.action,
          executed: false,
          outcome: 'no_menu_present',
          surface: before,
        });
      }

      const call = await hideExpoDevMenu(client, { retries: 1 });
      if (!call.callSent) return failedHideResult(call, before);

      await interruptible(() => dependencies.settleAfterHide?.() ?? sleep(300));
      const after = probe
        ? await interruptible(probe).catch(() => {
            cancellationSignal();
            return 'unknown' as const;
          })
        : 'unknown';
      if (before === 'expo_dev_menu' && after === 'app') {
        return okResult({
          action: args.action,
          executed: true,
          outcome: 'hidden',
          method: call.method,
          attempts: call.attempts,
          surface: after,
        });
      }
      return unverifiedHideResult(call, before, after);
    }

    if (args.action === 'hideDevMenuFab') {
      if (timeoutMs < 500)
        return failResult(
          'Insufficient time to verify the dev-menu preferences.',
          'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT',
          { action: args.action },
        );
      const result = await interruptible(() => client.evaluate(HIDE_DEV_MENU_FAB, true, timeoutMs));
      if (result.value === 'no_method_available')
        return warnResult(
          { action: args.action, executed: false },
          'hideDevMenuFab not available — no Expo dev-menu preferences module.',
        );
      if (result.error || result.value !== 'ok')
        return failResult(
          `The Expo dev-client floating button could not be confirmed hidden: ${result.error ? 'the preferences call failed' : 'the preferences did not read back hidden'}.`,
          result.errorKind === 'timeout'
            ? 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT'
            : 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_FAILED',
          { action: args.action },
        );
      await interruptible(() => dependencies.settleAfterHide?.() ?? sleep(300));
      return okResult({ action: args.action, executed: true, outcome: 'hidden' });
    }

    const expression = ACTION_EXPRESSIONS[args.action];

    try {
      const result = await interruptible(() => client.evaluate(expression, false, timeoutMs));
      if (result.error) {
        return failResult(`Dev settings error: ${result.error}`);
      }
      if (result.value === 'no_method_available') {
        return warnResult(
          { action: args.action, executed: false },
          `${args.action} not available — all fallback approaches failed.`,
        );
      }
    } catch (evalErr) {
      const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
      const isDisconnect =
        msg.includes('WebSocket closed') || msg.includes('WebSocket not connected');
      if (args.action === 'reload' && isDisconnect) {
        return okResult(
          { action: args.action, executed: true },
          { meta: { note: 'Connection will close — use cdp_status to reconnect.' } },
        );
      }
      throw evalErr;
    }

    return okResult({ action: args.action, executed: true });
  };
  const helperIndependent = withConnection(getClient, handler, { requireHelpers: false });
  const helperAware = withConnection(getClient, handler);
  return (args: { action: DevAction; timeoutMs?: number }) => {
    // Walk admission owns connection recovery and the remaining startup deadline.
    if (args.timeoutMs !== undefined) {
      throwIfCancelled();
      return handler(args, getClient());
    }
    return args.action === 'hideDevMenu' || args.action === 'hideDevMenuFab'
      ? helperIndependent(args)
      : helperAware(args);
  };
}
