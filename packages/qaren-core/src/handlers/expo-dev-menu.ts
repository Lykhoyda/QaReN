import { interruptible, sleep, cancellationSignal } from '../domain/cancellation.js';
import type { CDPClient } from '../cdp-client.js';
import type { ForegroundSurface } from '../domain/foreground-surface-remedy.js';
import type { ToolResult } from '../utils.js';

export type { ForegroundSurface } from '../domain/foreground-surface-remedy.js';

interface SurfaceNode {
  label?: unknown;
  identifier?: unknown;
  type?: unknown;
  packageName?: unknown;
  rect?: unknown;
}

interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ForegroundSurfaceProbeSession {
  platform?: string;
  deviceId?: string;
  appId?: string;
}

interface ForegroundSurfaceProbeAuthority {
  available: boolean;
  bindings?: Record<string, unknown>;
}

interface ForegroundSurfaceProbeDependencies {
  getAuthorityStatus: () => ForegroundSurfaceProbeAuthority;
  getActiveSession: () => ForegroundSurfaceProbeSession | null;
  runNative: (args: string[], options: { platform: 'ios' | 'android' }) => Promise<ToolResult>;
}

export const RESOLVE_EXPO_DEV_MENU = `(function () {
  try { var e = globalThis.expo; if (e && e.modules && e.modules.ExpoDevMenu) return e.modules.ExpoDevMenu; } catch (e0) {}
  try { var nm = require("react-native").NativeModules; if (nm && nm.ExpoDevMenu) return nm.ExpoDevMenu; } catch (e1) {}
  try { if (typeof __turboModuleProxy === "function") { var t = __turboModuleProxy("ExpoDevMenu"); if (t) return t; } } catch (e2) {}
  try { if (typeof globalThis.nativeModuleProxy !== "undefined") { var p = globalThis.nativeModuleProxy.ExpoDevMenu; if (p) return p; } } catch (e3) {}
  return null;
})()`;

export const HIDE_EXPO_DEV_MENU_EXPRESSION = `(function () {
  var m = ${RESOLVE_EXPO_DEV_MENU};
  if (!m) return "no_module";
  var method = null;
  var close = null;
  try {
    if (typeof m.hideMenu === "function") { method = "hideMenu"; close = m.hideMenu; }
    else if (typeof m.closeMenu === "function") { method = "closeMenu"; close = m.closeMenu; }
    if (!method) return "no_method_available";
  } catch (e) { return "resolution_error:" + (e && e.message ? e.message : String(e)); }
  try {
    var pending = Promise.resolve(close.call(m)).then(function () { return "ok:" + method; }, function (e) { return "error:" + method + ":" + (e && e.message ? e.message : String(e)); });
    return { __rnAgentStartValue: "sent:" + method, then: function (resolve, reject) { return pending.then(resolve, reject); } };
  } catch (e) { return "error:" + method + ":" + (e && e.message ? e.message : String(e)); }
})()`;

export interface HideDevMenuCallOutcome {
  callSent: boolean;
  method?: 'hideMenu' | 'closeMenu';
  reason: string;
  attempts: number;
}

export interface HideDevMenuOptions {
  retries?: number;
  retryDelayMs?: number;
  evaluationTimeoutMs?: number;
}

function surfaceText(nodes: SurfaceNode[]): string[] {
  return nodes.flatMap((node) =>
    [node.label, node.identifier]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

const SYSTEM_CHROME_REGION_IDENTIFIERS = new Set([
  'status_bar',
  'status_bar_container',
  'navigation_bar_frame',
  'nav_bar_background',
  'taskbar_container',
  'navbuttons_view',
]);

const SYSTEM_CHROME_IDENTIFIERS = new Set([
  ...SYSTEM_CHROME_REGION_IDENTIFIERS,
  'status_bar_launch_animation_container',
  'status_bar_contents',
  'status_bar_start_side_container',
  'status_bar_start_side_content',
  'status_bar_start_side_except_heads_up',
  'status_bar_end_side_container',
  'status_bar_end_side_content',
  'clock',
  'notification_icon_area',
  'notificationicons',
  'cutout_space_view',
  'system_icons',
  'statusicons',
  'wifi_combo',
  'wifi_group',
  'wifi_signal',
  'mobile_combo',
  'mobile_group',
  'mobile_signal',
  'battery',
  'taskbar_scrim',
  'start_contextual_buttons',
  'end_contextual_buttons',
  'end_nav_buttons',
  'taskbar_bubbles_container',
  'back',
  'home',
  'recent_apps',
  'recents',
  'overview',
  'home_handle',
]);

function surfaceRect(node: SurfaceNode): SurfaceRect | null {
  if (!node.rect || typeof node.rect !== 'object') return null;
  const rect = node.rect as Record<string, unknown>;
  if (
    typeof rect.x !== 'number' ||
    typeof rect.y !== 'number' ||
    typeof rect.width !== 'number' ||
    typeof rect.height !== 'number' ||
    rect.width < 0 ||
    rect.height < 0
  ) {
    return null;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function rectContains(container: SurfaceRect, candidate: SurfaceRect): boolean {
  return (
    candidate.x >= container.x &&
    candidate.y >= container.y &&
    candidate.x + candidate.width <= container.x + container.width &&
    candidate.y + candidate.height <= container.y + container.height
  );
}

function hasBlockingForeignSurface(nodes: SurfaceNode[], boundAppId: string): boolean {
  const systemNodes = nodes.filter((node) => node.packageName === 'com.android.systemui');
  const chromeRegions = systemNodes.flatMap((node) => {
    const identifier =
      typeof node.identifier === 'string' ? node.identifier.trim().toLowerCase() : '';
    const rect = SYSTEM_CHROME_REGION_IDENTIFIERS.has(identifier) ? surfaceRect(node) : null;
    return rect ? [rect] : [];
  });

  return nodes.some((node) => {
    const packageName = typeof node.packageName === 'string' ? node.packageName.trim() : '';
    if (!packageName || packageName === boundAppId) return false;
    if (packageName !== 'com.android.systemui') return true;
    const identifier =
      typeof node.identifier === 'string' ? node.identifier.trim().toLowerCase() : '';
    if (SYSTEM_CHROME_IDENTIFIERS.has(identifier)) return false;
    const rect = surfaceRect(node);
    return !rect || !chromeRegions.some((region) => rectContains(region, rect));
  });
}

export function classifyForegroundSurface(
  nodes: SurfaceNode[],
  boundAppId?: string,
): ForegroundSurface {
  const text = surfaceText(nodes);
  const has = (value: string) => text.some((candidate) => candidate.includes(value));
  if (
    nodes.some((node) => node.type === 'Alert') ||
    (boundAppId && hasBlockingForeignSurface(nodes, boundAppId))
  ) {
    return 'unknown';
  }

  const hasBoundApp =
    Boolean(boundAppId) &&
    nodes.some((node) => node.packageName === boundAppId || node.type === 'Application');
  if (text.length === 0) return hasBoundApp ? 'app' : 'unknown';

  if (has('development servers')) return 'dev_client_picker';
  if (
    has('open debugger') ||
    has('configure bundler') ||
    (has('react native dev menu') && has('open devtools') && has('change bundle location'))
  ) {
    return 'react_native_dev_menu';
  }
  const hasTutorialCopy = has('this is the developer menu');
  const hasGenericTogglePair = has('toggle performance monitor') && has('toggle element inspector');
  const hasExpoControlPair = has('copy system info') && has('open devtools');
  if (
    hasExpoControlPair ||
    (hasGenericTogglePair && (hasTutorialCopy || has('copy system info')))
  ) {
    return 'expo_dev_menu';
  }
  if (hasTutorialCopy) return 'first_run_tutorial';
  if (!boundAppId) return 'unknown';
  return hasBoundApp ? 'app' : 'unknown';
}

export function foregroundSurfaceFromSnapshot(
  result: ToolResult,
  boundAppId?: string,
): ForegroundSurface {
  if (result.isError) return 'unknown';
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '') as {
      ok?: boolean;
      data?: { nodes?: SurfaceNode[] };
    };
    if (!envelope.ok || !Array.isArray(envelope.data?.nodes)) return 'unknown';
    return classifyForegroundSurface(envelope.data.nodes, boundAppId);
  } catch {
    return 'unknown';
  }
}

export function createForegroundSurfaceProbe(
  dependencies: ForegroundSurfaceProbeDependencies,
): () => Promise<ForegroundSurface> {
  return async () => {
    const status = dependencies.getAuthorityStatus();
    const session = dependencies.getActiveSession();
    const runner = status.bindings?.runner;
    if (!status.available || !runner || !session) return 'unknown';
    const device = status.bindings?.device as Record<string, unknown> | undefined;
    const platform = device?.platform;
    if (
      (platform !== 'ios' && platform !== 'android') ||
      session.platform !== platform ||
      session.deviceId !== device?.deviceId ||
      session.appId !== device?.appId
    ) {
      return 'unknown';
    }
    return foregroundSurfaceFromSnapshot(
      await dependencies.runNative(['snapshot'], { platform }),
      session.appId,
    );
  };
}

function parseSentinel(value: unknown, attempts: number): HideDevMenuCallOutcome {
  const sentinel = typeof value === 'string' ? value : '';
  if (sentinel === 'ok:hideMenu') {
    return {
      callSent: true,
      method: 'hideMenu',
      reason: 'ExpoDevMenu.hideMenu() completed.',
      attempts,
    };
  }
  if (sentinel === 'ok:closeMenu') {
    return {
      callSent: true,
      method: 'closeMenu',
      reason: 'ExpoDevMenu.closeMenu() completed.',
      attempts,
    };
  }
  if (sentinel === 'sent:hideMenu') {
    return {
      callSent: true,
      method: 'hideMenu',
      reason: 'ExpoDevMenu.hideMenu() was invoked but did not settle.',
      attempts,
    };
  }
  if (sentinel === 'sent:closeMenu') {
    return {
      callSent: true,
      method: 'closeMenu',
      reason: 'ExpoDevMenu.closeMenu() was invoked but did not settle.',
      attempts,
    };
  }
  if (sentinel === 'no_module') {
    return {
      callSent: false,
      reason: 'No ExpoDevMenu native module resolved.',
      attempts,
    };
  }
  if (sentinel === 'no_method_available') {
    return {
      callSent: false,
      reason: 'ExpoDevMenu resolved but exposes no hideMenu/closeMenu method.',
      attempts,
    };
  }
  if (sentinel.startsWith('resolution_error:')) {
    return {
      callSent: false,
      reason: `ExpoDevMenu resolution failed: ${sentinel.slice(17)}`,
      attempts,
    };
  }
  const invocationError = sentinel.match(/^error:(hideMenu|closeMenu):(.*)$/s);
  if (invocationError) {
    return {
      callSent: true,
      method: invocationError[1] as 'hideMenu' | 'closeMenu',
      reason: `ExpoDevMenu ${invocationError[1]} invocation failed: ${invocationError[2]}`,
      attempts,
    };
  }
  return {
    callSent: false,
    reason: `Unexpected dev-menu hide result: ${sentinel || '(empty)'}`,
    attempts,
  };
}

export async function hideExpoDevMenu(
  client: CDPClient,
  options: HideDevMenuOptions = {},
): Promise<HideDevMenuCallOutcome> {
  const retries = Math.min(1, Math.max(0, options.retries ?? 0));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 300);
  const evaluationTimeoutMs = Math.min(5_000, Math.max(1, options.evaluationTimeoutMs ?? 5_000));
  let outcome: HideDevMenuCallOutcome = {
    callSent: false,
    reason: 'Dev menu hide not attempted.',
    attempts: 0,
  };
  let successfulCall: HideDevMenuCallOutcome | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const attempts = attempt + 1;
    try {
      const result = await interruptible(() =>
        client.evaluate(HIDE_EXPO_DEV_MENU_EXPRESSION, true, evaluationTimeoutMs),
      );
      const startOutcome = parseSentinel(result.value, attempts);
      const attemptOutcome = result.error
        ? startOutcome.callSent
          ? {
              ...startOutcome,
              reason: `${startOutcome.reason} Async evaluation failed: ${result.error}`,
            }
          : result.requestDispatched
            ? {
                callSent: true,
                reason: `Dev menu hide evaluation was dispatched but its invocation could not be confirmed: ${result.error}`,
                attempts,
              }
            : {
                callSent: false,
                reason: `Dev menu hide evaluation failed before dispatch: ${result.error}`,
                attempts,
              }
        : startOutcome;
      outcome = attemptOutcome;
      if (attemptOutcome.callSent) successfulCall = attemptOutcome;
    } catch (error) {
      cancellationSignal();
      outcome = {
        callSent: false,
        reason: `Dev menu hide evaluation threw: ${error instanceof Error ? error.message : String(error)}`,
        attempts,
      };
    }

    if (outcome.reason.startsWith('No ExpoDevMenu')) {
      if (!successfulCall) return outcome;
      break;
    }
    if (attempt < retries) await sleep(retryDelayMs);
  }

  return successfulCall ? { ...successfulCall, attempts: outcome.attempts } : outcome;
}
