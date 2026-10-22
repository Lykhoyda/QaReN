import {
  interruptible,
  isAbort,
  sleep,
  cancellationSignal,
  throwIfCancelled,
} from '../domain/cancellation.js';
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

// Walk start: hide Expo's floating dev-menu button first, then shake, hot reloading (so QaReN's own writes cannot refresh the app mid-recording) and any open menu.
export const WALK_DEV_SETTINGS = [
  'hideDevMenuFab',
  'disableDevMenu',
  'disableFastRefresh',
  'hideDevMenu',
] as const;

// The floating button fades out over ~0.3 s after its preference flips.
const DEV_FAB_READS = 4;
const DEV_FAB_READ_INTERVAL_MS = 250;
// A loaded host can time out the preferences call; the reads below stay the proof.
const DEV_FAB_HIDE_ATTEMPTS = 3;

// Android reloads the JS bundle whenever hot loading is set, so the walk must wait for the reloaded app.
export interface FastRefreshReload {
  // Before the setting: marks the runtime the reload replaces.
  mark(): Promise<void>;
  // After it: resolves once the reloaded app is proven ready, and throws a typed refusal otherwise.
  settled(): Promise<void>;
}

export interface DevOverlayDependencies {
  devSettings(args: { action: (typeof WALK_DEV_SETTINGS)[number] }): Promise<ToolResult>;
  devOverlayUncleared(): Promise<boolean>;
  log(message: string): void;
  sleep?(ms: number): Promise<void>;
  fastRefreshReload?: FastRefreshReload;
  // Only where the native reads can see the floating button may they stand in for a failed hide.
  fabVisibleToReads?: boolean;
}

function envelopeError(result: ToolResult): string {
  try {
    const { error } = JSON.parse(result.content[0]?.text ?? '') as { error?: unknown };
    return typeof error === 'string' ? error : 'failed';
  } catch {
    return 'failed';
  }
}

export function clearDevOverlays(deps: DevOverlayDependencies): Promise<ToolResult> {
  return clearOverlays(deps, WALK_DEV_SETTINGS);
}

// The one walk-start and post-recovery proof that no Expo dev chrome is in front of the app.
async function clearOverlays(
  deps: DevOverlayDependencies,
  actions: readonly (typeof WALK_DEV_SETTINGS)[number][],
): Promise<ToolResult> {
  const pause = deps.sleep ?? sleep;
  let fabError: string | undefined;
  for (const action of actions) {
    const attempts = action === 'hideDevMenuFab' ? DEV_FAB_HIDE_ATTEMPTS : 1;
    let error: string | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      throwIfCancelled();
      if (attempt > 0) await pause(DEV_FAB_READ_INTERVAL_MS);
      const reload = action === 'disableFastRefresh' ? deps.fastRefreshReload : undefined;
      await reload?.mark();
      const result = await deps.devSettings({ action }).catch((thrown: unknown) => {
        if (isAbort(thrown)) throw thrown;
        return thrown instanceof Error ? thrown.message : String(thrown);
      });
      error =
        typeof result === 'string' ? result : result.isError ? envelopeError(result) : undefined;
      if (typeof result !== 'string' && !result.isError && envelopeData(result)?.executed === true)
        await reload?.settled();
      if (error === undefined) break;
    }
    if (error === undefined) continue;
    if (action === 'hideDevMenuFab' && deps.fabVisibleToReads !== true)
      return failResult(
        `The Expo dev-client floating button could not be confirmed hidden: ${error}`,
        'DEV_MENU_HIDE_UNVERIFIED',
        { action: 'clearDevOverlays', outcome: 'DEV_MENU_HIDE_UNVERIFIED' },
      );
    deps.log(`${action}: ${error}`);
    if (action === 'hideDevMenuFab') fabError = error;
  }
  let readError: string | undefined;
  for (let read = 0; read < DEV_FAB_READS; read++) {
    throwIfCancelled();
    const shown = await deps.devOverlayUncleared().catch((thrown: unknown) => {
      if (isAbort(thrown)) throw thrown;
      readError = thrown instanceof Error ? thrown.message : String(thrown);
      return true;
    });
    if (!shown) return okResult({ action: 'clearDevOverlays', executed: true });
    if (read + 1 < DEV_FAB_READS) await pause(DEV_FAB_READ_INTERVAL_MS);
  }
  throwIfCancelled();
  if (fabError !== undefined)
    return failResult(
      `The Expo dev-client floating button could not be confirmed hidden: ${fabError}${readError ? `; ${readError}` : ''}`,
      'DEV_MENU_HIDE_UNVERIFIED',
      { action: 'clearDevOverlays', outcome: 'DEV_MENU_HIDE_UNVERIFIED' },
    );
  return failResult(
    `The Expo dev overlays could not be proven gone${readError ? `: ${readError}` : '.'}`,
    'DEV_MENU_HIDE_UNVERIFIED',
    { action: 'clearDevOverlays', outcome: 'DEV_MENU_HIDE_UNVERIFIED' },
  );
}

export async function recoverDevOverlays(deps: DevOverlayDependencies): Promise<ToolResult> {
  const overlayUncleared = await deps.devOverlayUncleared().catch((thrown: unknown) => {
    if (isAbort(thrown)) throw thrown;
    return true;
  });
  const hidden = await deps.devSettings({ action: 'hideDevMenu' });
  if (hidden.isError || (!overlayUncleared && envelopeData(hidden)?.executed === false))
    return hidden;
  // Hot loading stays off once the walk start set it; setting it again on Android would reload the app mid-walk.
  return clearOverlays(
    deps,
    deps.fastRefreshReload
      ? WALK_DEV_SETTINGS.filter((action) => action !== 'disableFastRefresh')
      : WALK_DEV_SETTINGS,
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
  const handler = async (args: { action: DevAction }, client: CDPClient) => {
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
      const result = await interruptible(() => client.evaluate(HIDE_DEV_MENU_FAB, true));
      if (result.value === 'no_method_available')
        return warnResult(
          { action: args.action, executed: false },
          'hideDevMenuFab not available — no Expo dev-menu preferences module.',
        );
      if (result.error || result.value !== 'ok')
        return failResult(
          `The Expo dev-client floating button could not be confirmed hidden: ${result.error ? 'the preferences call failed or timed out' : 'the preferences did not read back hidden'}.`,
          'DEV_MENU_HIDE_UNVERIFIED',
          { action: args.action, outcome: 'DEV_MENU_HIDE_UNVERIFIED' },
        );
      await interruptible(() => dependencies.settleAfterHide?.() ?? sleep(300));
      return okResult({ action: args.action, executed: true, outcome: 'hidden' });
    }

    const expression = ACTION_EXPRESSIONS[args.action];

    try {
      const result = await interruptible(() => client.evaluate(expression));
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
  return (args: { action: DevAction }) =>
    args.action === 'hideDevMenu' || args.action === 'hideDevMenuFab'
      ? helperIndependent(args)
      : helperAware(args);
}
