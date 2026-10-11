import { sleep as cancellableSleep } from '../domain/cancellation.js';
import type { ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import type { QaDispatchContext } from '../domain/qa-dispatch.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { maestroRefusalResult, runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { detectPlatform } from './platform-utils.js';
import { extractMutationDisposition, fetchSnapshotNodes } from './device-interact.js';
import type { SnapshotFetchResult } from './device-interact.js';
import { hasActiveSession, getActiveSession, runNative } from '../agent-device-wrapper.js';
import { shouldRejectMaestroDeviceAuthority } from '../domain/maestro-device-authority.js';

// iOS dialog button labels. Note: "Don't Allow" uses U+2019 typographic apostrophe,
// not ASCII '. We emit both spellings so the first-matching Maestro step wins.
const APOSTROPHE_ASCII = "'";
const APOSTROPHE_CURLY = '\u2019';

const ACCEPT_LABELS_IOS = [
  'Allow',
  'Allow Once',
  'Allow While Using App',
  'OK',
  'Open',
  'Continue',
  'Yes',
  'Accept',
];

const DISMISS_LABELS_IOS_BASE = ['Cancel', 'No', 'Deny', 'Not Now', 'Reject'];

const DISMISS_LABELS_IOS = [
  ...DISMISS_LABELS_IOS_BASE,
  `Don${APOSTROPHE_ASCII}t Allow`,
  `Don${APOSTROPHE_CURLY}t Allow`,
];

const ACCEPT_LABELS_ANDROID = [
  'Allow',
  'ALLOW',
  'While using the app',
  'Only this time',
  'OK',
  'Open',
  'Continue',
  'Yes',
];

const DISMISS_LABELS_ANDROID = ['Deny', 'DENY', 'Cancel', 'CANCEL', 'No', 'Not now'];

export interface SystemDialogArgs {
  qaContext?: QaDispatchContext;
  label?: string;
  platform?: 'ios' | 'android';
  timeoutMs?: number;
}

// GH #545 test seams — same pattern as dev-client-picker.ts: production code
// calls through these indirections so unit tests can swap mocks without
// touching the fast-runner or a live session.
const realSleep = cancellableSleep;

let fetchSnapshotNodesFn: typeof fetchSnapshotNodes = fetchSnapshotNodes;
type TapSystemAlert = (label: string, qaContext?: QaDispatchContext) => Promise<ToolResult>;
const tapSystemAlert: TapSystemAlert = (label, qaContext) =>
  runNative(['system-alert-tap', label], { qaContext });
let tapSystemAlertFn: TapSystemAlert = tapSystemAlert;
let runMaestroInlineFn: typeof runMaestroInline = runMaestroInline;
let sleepFn: (ms: number) => Promise<void> = realSleep;
let iosSessionActiveFn: () => boolean = () =>
  hasActiveSession() && getActiveSession()?.platform === 'ios';

export function _setFetchSnapshotNodesForTest(fn: typeof fetchSnapshotNodes): void {
  fetchSnapshotNodesFn = fn;
}
export function _resetFetchSnapshotNodesForTest(): void {
  fetchSnapshotNodesFn = fetchSnapshotNodes;
}
export function _setSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}
export function _resetSleepForTest(): void {
  sleepFn = realSleep;
}
export function _setTapSystemAlertForTest(fn: TapSystemAlert): void {
  tapSystemAlertFn = fn;
}
export function _resetTapSystemAlertForTest(): void {
  tapSystemAlertFn = tapSystemAlert;
}
export function _setRunMaestroInlineForTest(fn: typeof runMaestroInline): void {
  runMaestroInlineFn = fn;
}
export function _resetRunMaestroInlineForTest(): void {
  runMaestroInlineFn = runMaestroInline;
}
export function _setIosSessionActiveForTest(value: boolean): void {
  iosSessionActiveFn = () => value;
}
export function _resetIosSessionActiveForTest(): void {
  iosSessionActiveFn = () => hasActiveSession() && getActiveSession()?.platform === 'ios';
}

export interface RunnerDialogOutcome {
  tapped: boolean;
  matchedLabel?: string;
  dialogTitle?: string;
  availableButtons?: string[];
  tappedRect?: { x: number; y: number; width: number; height: number };
  refusal?: { code: ToolErrorCode; message: string; mutation: 'none' | 'observed' };
}

function tapProof(result: ToolResult): {
  tappedLabel?: unknown;
  tappedRect?: unknown;
  alertClosed?: unknown;
} {
  try {
    const data = (JSON.parse(result.content[0]?.text ?? '{}') as { data?: unknown }).data;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k]),
  );
}

// SpringBoard modals require the native runner; QA snapshot uncertainty never permits fallback.
export async function tapSystemDialogViaRunner(
  labels: string[],
  qaContext?: QaDispatchContext,
): Promise<RunnerDialogOutcome | null> {
  qaContext?.check();
  if (!iosSessionActiveFn()) {
    qaContext?.invalidate();
    return null;
  }
  let snap: SnapshotFetchResult;
  try {
    snap = await fetchSnapshotNodesFn(false, qaContext);
  } catch {
    qaContext?.invalidate();
    return null;
  }
  if (!snap.ok) {
    qaContext?.invalidate();
    return null;
  }
  const root = snap.nodes[0];
  if (qaContext && (!root?.type || snap.recoveredTier)) qaContext.invalidate();
  if (!root || root.type !== 'Alert') return null;
  const buttons = snap.nodes.slice(1);
  for (const label of labels) {
    // Exact label only: the chosen label is always one of these known constants, never app or user text.
    if (!buttons.some((n) => n.label === label)) continue;
    // One chosen label, one dispatch: the runner taps that SpringBoard button element, never a coordinate.
    const chosen = label;
    let tap: ToolResult;
    try {
      tap = await tapSystemAlertFn(chosen, qaContext);
    } catch (error) {
      qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      throw error;
    }
    qaContext?.assertComplete();
    if (tap.isError) {
      if (extractMutationDisposition(tap) !== 'none') qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      const { code, error } = JSON.parse(tap.content[0]?.text ?? '{}') as {
        code?: ToolErrorCode;
        error?: string;
      };
      return {
        tapped: false,
        dialogTitle: root.label,
        refusal: {
          code: code ?? 'DIALOG_TAP_UNPROVEN',
          message: error ?? 'the alert button tap was refused; nothing was tapped',
          mutation: 'none',
        },
      };
    }
    const proof = tapProof(tap);
    const unproven = (why: string): RunnerDialogOutcome => ({
      tapped: false,
      dialogTitle: root.label,
      refusal: {
        code: 'DIALOG_TAP_UNPROVEN',
        message: `DIALOG_TAP_UNPROVEN: ${why}`,
        mutation: 'observed',
      },
    });
    if (proof.tappedLabel !== chosen || !isRect(proof.tappedRect))
      return unproven(`the runner did not prove it tapped the "${chosen}" button`);
    if (proof.alertClosed !== true)
      return unproven(`"${chosen}" was tapped but the alert stayed open`);
    return {
      tapped: true,
      matchedLabel: chosen,
      dialogTitle: root.label,
      tappedRect: proof.tappedRect,
    };
  }
  return {
    tapped: false,
    dialogTitle: root.label,
    availableButtons: buttons.map((n) => n.label ?? n.identifier ?? '').filter((l) => l.length > 0),
  };
}

// GH #545: `simctl openurl` for a custom scheme raises a SpringBoard
// "Open in <app>?" confirmation on newer iOS runtimes (observed on 26.2).
// Accepting it is the deeplink caller's declared intent, so only "Open" is
// probed. The dialog animates in after openurl returns — when no modal is
// visible yet, one short retry covers the animation window.
const OPEN_CONFIRMATION_LABELS = ['Open'];
const OPEN_CONFIRMATION_RETRY_DELAY_MS = 750;

export async function acceptDeeplinkOpenConfirmation(): Promise<RunnerDialogOutcome | null> {
  // Without an open iOS session the runner cannot reach a SpringBoard dialog
  // at all — bail before the retry timer so a session-less deeplink (the common
  // CLI path) never eats a dead 750ms wait for a probe that must return null.
  if (!iosSessionActiveFn()) return null;
  const first = await tapSystemDialogViaRunner(OPEN_CONFIRMATION_LABELS);
  if (first) return first;
  await sleepFn(OPEN_CONFIRMATION_RETRY_DELAY_MS);
  return tapSystemDialogViaRunner(OPEN_CONFIRMATION_LABELS);
}

// Keep the no-dialog fallback bounded while allowing longer explicit waits.
const DEFAULT_DIALOG_TIMEOUT_MS = 15_000;

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tapSystemDialog(
  labels: string[],
  platform: 'ios' | 'android',
  totalTimeoutMs: number,
  slug: string,
  qaContext?: QaDispatchContext,
): Promise<ToolResult> {
  const session = getActiveSession();
  if (qaContext && (session?.platform !== platform || !session.deviceId || !session.appId)) {
    qaContext.invalidate();
  }
  // One non-optional regex selector keeps correctness (a miss exits non-zero)
  // without paying a fresh iOS WDA cold start for every candidate label.
  const selector = `^(?:${labels.map(regexEscape).join('|')})$`;
  const yaml = `- tapOn:\n    text: "${yamlEscape(selector)}"`;
  const result = await runMaestroInlineFn(yaml, {
    qaContext,
    ...(qaContext ? { deviceId: session!.deviceId, appId: session!.appId } : {}),
    platform,
    timeoutMs: totalTimeoutMs,
    slug,
  });
  qaContext?.assertComplete();
  if (result.passed) {
    return okResult({ tapped: true, platform, triedLabels: labels, selector });
  }
  if (qaContext) {
    if (qaContext.authorizations > 0) qaContext.refuse('ACTION_OUTCOME_UNCERTAIN');
    qaContext.invalidate();
  }
  if (result.deviceAuthority && shouldRejectMaestroDeviceAuthority(result.deviceAuthority)) {
    return failResult(
      result.error ?? 'Maestro device authority refused during system dialog probe.',
      'DEVICE_AUTHORITY_MISMATCH',
      { platform, triedLabels: labels, deviceAuthority: result.deviceAuthority },
    );
  }
  const refusal = maestroRefusalResult(result, 'Maestro system dialog fallback was refused.', {
    platform,
    triedLabels: labels,
  });
  if (refusal) return refusal;
  const attempts = [
    {
      selector,
      error: result.error,
      output: result.output ? result.output.slice(0, 200) : undefined,
    },
  ];

  // GH #545: on iOS a Maestro miss can also mean the dialog is SpringBoard-owned
  // and simply invisible to Maestro — point at the runner path and the
  // last-resort SpringBoard restart instead of implying the dialog isn't there.
  const iosHint =
    platform === 'ios'
      ? ' If the dialog is visible on screen, it is likely SpringBoard-owned and invisible to Maestro — open a device session (device_snapshot action="open") and retry so the native runner path can reach it. Last resort for a stuck dialog: xcrun simctl spawn <udid> launchctl kickstart -k system/com.apple.SpringBoard (app install survives; relaunch the app afterwards).'
      : '';
  return warnResult(
    { tapped: false, platform, triedLabels: labels, attempts },
    `No matching system dialog button found. The dialog may not be visible yet, or the button label differs from known variants. Call device_screenshot to verify the dialog is up, or pass a specific label.${iosHint}`,
    { code: 'DIALOG_NOT_FOUND' },
  );
}

function pickLabels(userLabel: string | undefined, defaults: string[]): string[] {
  if (!userLabel) return defaults;
  // Put user label first, then defaults as fallback. Dedupe while preserving order.
  const seen = new Set<string>();
  return [userLabel, ...defaults].filter((l) => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
}

async function handleSystemDialog(
  args: SystemDialogArgs,
  iosDefaults: string[],
  androidDefaults: string[],
  slug: string,
): Promise<ToolResult> {
  args.qaContext?.check();
  const platform = args.platform ?? (await detectPlatform());
  if (!platform) {
    return failResult('No device detected. Pass platform or boot a device first.', {
      code: 'NO_DEVICE',
    });
  }
  const defaults = platform === 'ios' ? iosDefaults : androidDefaults;
  const labels = pickLabels(args.label, defaults);
  if (platform === 'ios') {
    const runner = await tapSystemDialogViaRunner(labels, args.qaContext);
    if (runner?.tapped) {
      return okResult(
        {
          tapped: true,
          platform,
          matchedLabel: runner.matchedLabel,
          tappedLabel: runner.matchedLabel,
          tappedRect: runner.tappedRect,
          dialogTitle: runner.dialogTitle,
          via: 'rn-fast-runner',
        },
        { meta: { verify: 'exact' } },
      );
    }
    if (runner?.refusal) {
      return failResult(runner.refusal.message, runner.refusal.code, {
        mutation: runner.refusal.mutation,
        platform,
        dialogTitle: runner.dialogTitle,
      });
    }
    if (runner) {
      // A SpringBoard dialog IS up but none of the probed labels matched its
      // buttons. Maestro cannot see this dialog at all — surface the real
      // buttons instead of burning N×4s on probes that can never match.
      return warnResult(
        {
          tapped: false,
          platform,
          dialogTitle: runner.dialogTitle,
          availableButtons: runner.availableButtons,
          triedLabels: labels,
        },
        `A system dialog${runner.dialogTitle ? ` ("${runner.dialogTitle}")` : ''} is on screen but none of the probed labels matched its buttons. Retry with label set to one of availableButtons.`,
        { code: 'DIALOG_BUTTON_NOT_FOUND' },
      );
    }
  }
  return tapSystemDialog(
    labels,
    platform,
    args.timeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS,
    slug,
    args.qaContext,
  );
}

export function createDeviceAcceptSystemDialogHandler(): (
  args: SystemDialogArgs,
) => Promise<ToolResult> {
  return async (args) =>
    handleSystemDialog(args, ACCEPT_LABELS_IOS, ACCEPT_LABELS_ANDROID, 'sys-accept');
}

export function createDeviceDismissSystemDialogHandler(): (
  args: SystemDialogArgs,
) => Promise<ToolResult> {
  return async (args) =>
    handleSystemDialog(args, DISMISS_LABELS_IOS, DISMISS_LABELS_ANDROID, 'sys-dismiss');
}
