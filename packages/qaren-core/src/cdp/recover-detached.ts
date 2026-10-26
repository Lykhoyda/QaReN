import { sleep as cancellableSleep } from '../domain/cancellation.js';
import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';
import type { CDPClient } from '../cdp-client.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { probeFreshness } from './recovery.js';
import { probeAppInstalled } from './app-installed-probe.js';
import type { SnapshotHint } from './app-installed-probe.js';
import { isValidBundleId } from '../domain/maestro-validator.js';

const execFile = promisify(execFileCb);
const DEFAULT_MAX_PER_SESSION = 3;
const RELAUNCH_SETTLE_MS = 1200;

/** Strict iOS simulator UDID shape (matches `xcrun simctl list` output). */
const SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export type DetachedReason =
  | 'recovered'
  | 'still-detached'
  | 'app-not-installed'
  | 'no-session'
  | 'flow-active'
  | 'opted-out'
  | 'unsupported-platform'
  | 'budget-exhausted';

export interface DetachedRecoveryResult {
  recovered: boolean;
  reason: DetachedReason;
  attempt: number;
  /** GH #208 review (Codex F3): a `simctl launch` failure message, surfaced instead of hidden. */
  error?: string;
  /** GH #262: set on 'app-not-installed' so the caller can build install advice. */
  udid?: string;
  appId?: string;
  snapshotHint?: SnapshotHint;
}

let attempts = 0;
/** GH #262: a CONFIRMED missing bundle, cached so follow-up recoveries
 * short-circuit (no pointless terminate/launch, no budget burn) until a
 * cheap re-probe sees it reinstalled. */
let confirmedNotInstalled: { udid: string; appId: string } | null = null;
/** GH #262: serialize concurrent recoveries — agent workflows fire cdp_status
 * in bursts; followers share the leader's verdict instead of racing their own
 * simctl terminate/launch and burning the consecutive-attempt budget. */
let inflight: Promise<DetachedRecoveryResult> | null = null;

/** Reset the per-session recovery budget (on device_snapshot open AND on a successful recovery). */
export function resetDetachedRecoveryCounter(): void {
  attempts = 0;
  confirmedNotInstalled = null;
}

type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * GH #208 (RC3): cold-restart the target app on the booted simulator — terminate
 * THEN launch. Unlike recover-wedge's bare `simctl launch` (which re-foregrounds
 * a still-running backgrounded app with the same pid, preserving JS state), a
 * DETACHED app isn't running at all (dev launcher / crashed), so we force a clean
 * cold start. The terminate is best-effort: it errors with "found no matching
 * processes" when the app isn't running — the normal detached case — so swallow it.
 *
 * `exec` is injectable so the terminate-then-launch sequence is unit-testable
 * without spawning simctl.
 */
export async function defaultRelaunchApp(
  udid: string,
  appId: string,
  exec: Exec = execFile as unknown as Exec,
): Promise<void> {
  try {
    await exec('xcrun', ['simctl', 'terminate', udid, appId], { timeout: 10_000 });
  } catch {
    // App wasn't running (the detached case) — terminate is a no-op; proceed to launch.
  }
  await exec('xcrun', ['simctl', 'launch', udid, appId], { timeout: 10_000 });
}

export interface RecoverDetachedDeps {
  getSession?: () => { deviceId?: string; appId?: string; platform?: string } | null;
  isFlowActive?: () => boolean;
  isOptedOut?: () => boolean;
  relaunchApp?: (udid: string, appId: string) => Promise<void>;
  stopFastRunner?: (deviceId?: string) => void | Promise<void>;
  reconnect?: () => Promise<void>;
  probeAlive?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxPerSession?: number;
  /** GH #262: tri-state install probe (true/false/null=unknown). */
  isAppInstalled?: (udid: string, appId: string) => Promise<boolean | null>;
  /**
   * GH #262: best-effort reinstallable-snapshot hint. NO default — the
   * implementation lives in the tools layer (resolve-ios-app-file.ts) and
   * cdp/ must not import from tools/; status.ts/restart.ts inject it.
   */
  snapshotHint?: (appId: string) => SnapshotHint | null;
}

/**
 * GH #208 (RC3): bounded recovery for the DETACHED-app wedge — Metro is up but
 * advertises 0 Hermes targets (AppDetachedError), so there's no target to connect
 * to. Cold-restart the app (terminate+launch) → reconnect → confirm via a REAL CDP
 * liveness probe. Bounded to maxPerSession CONSECUTIVE failures (default 3; resets
 * on success and on device_snapshot action=open). SKIPS when a Maestro flow holds
 * the arbiter flow lease (don't yank the app from a flow) and when opted out via
 * RN_AUTO_RELAUNCH_ON_DETACH=0.
 *
 * Reverse-risk note: a cold restart destroys in-progress JS state. That's
 * acceptable ONLY because this fires when the app is ALREADY detached (the session
 * is already broken) — never against a working app. The opt-out exists for users
 * who'd rather recover manually.
 */
export async function recoverDetached(
  client: CDPClient,
  deps: RecoverDetachedDeps = {},
): Promise<DetachedRecoveryResult> {
  // Followers inherit the leader's deps and verdict by design — all real
  // callers pass equivalent deps, and a shared verdict is the point.
  if (inflight) return inflight;
  inflight = recoverDetachedInner(client, deps);
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function recoverDetachedInner(
  client: CDPClient,
  deps: RecoverDetachedDeps = {},
): Promise<DetachedRecoveryResult> {
  const max = deps.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const isFlowActive = deps.isFlowActive ?? (() => false);
  const isOptedOut = deps.isOptedOut ?? (() => process.env.RN_AUTO_RELAUNCH_ON_DETACH === '0');

  // No-op early returns — these must NOT consume the budget.
  if (isOptedOut()) {
    return { recovered: false, reason: 'opted-out', attempt: attempts };
  }
  if (isFlowActive()) {
    return { recovered: false, reason: 'flow-active', attempt: attempts };
  }
  const session = (deps.getSession ?? getActiveSession)();
  if (!session?.deviceId || !session?.appId) {
    return { recovered: false, reason: 'no-session', attempt: attempts };
  }
  if ((session.platform ?? 'ios') !== 'ios') {
    return { recovered: false, reason: 'unsupported-platform', attempt: attempts };
  }

  const udid = session.deviceId;
  const appId = session.appId;

  // GH #262 (codex-pair): session values come from a file on disk — validate
  // before they reach simctl argv. An unusable session is the same as none.
  if (!SIMULATOR_UDID_RE.test(udid) || !isValidBundleId(appId)) {
    return { recovered: false, reason: 'no-session', attempt: attempts };
  }

  const isAppInstalled = deps.isAppInstalled ?? probeAppInstalled;
  const buildHint = (): SnapshotHint | undefined => {
    if (!deps.snapshotHint) return undefined;
    try {
      return deps.snapshotHint(appId) ?? undefined;
    } catch {
      return undefined;
    }
  };

  // GH #262: a previously CONFIRMED missing bundle short-circuits the whole
  // attempt — but a cheap re-probe first, so a user reinstall self-heals.
  if (
    confirmedNotInstalled &&
    confirmedNotInstalled.udid === udid &&
    confirmedNotInstalled.appId === appId
  ) {
    const verdict = await isAppInstalled(udid, appId);
    if (verdict === false) {
      const snapshotHint = buildHint();
      return {
        recovered: false,
        reason: 'app-not-installed',
        attempt: attempts,
        udid,
        appId,
        ...(snapshotHint ? { snapshotHint } : {}),
      };
    }
    if (verdict === true) {
      // GH #262 (PR #280 review): a confirmed reinstall invalidates the
      // consecutive-failure budget along with the cached diagnosis —
      // otherwise recovery stays budget-exhausted against a healthy app.
      attempts = 0;
    }
    confirmedNotInstalled = null;
  }

  if (attempts >= max) {
    // GH #262 (PR #280 review): an exhausted budget must not mask a freshly
    // missing bundle — probe (side-effect-free) before reporting exhaustion.
    if ((await isAppInstalled(udid, appId)) === false) {
      confirmedNotInstalled = { udid, appId };
      const snapshotHint = buildHint();
      return {
        recovered: false,
        reason: 'app-not-installed',
        attempt: attempts,
        udid,
        appId,
        ...(snapshotHint ? { snapshotHint } : {}),
      };
    }
    return { recovered: false, reason: 'budget-exhausted', attempt: attempts };
  }

  // A real, side-effecting attempt.
  attempts += 1;
  const attempt = attempts;

  const stopFastRunner = deps.stopFastRunner ?? defaultStopFastRunner;
  const relaunchApp = deps.relaunchApp ?? defaultRelaunchApp;
  const reconnect = deps.reconnect ?? (() => client.softReconnect());
  const probeAlive = deps.probeAlive ?? (async () => (await probeFreshness(client)).fresh);
  const sleep = deps.sleep ?? cancellableSleep;

  await stopFastRunner(udid);
  let relaunchError: string | undefined;
  try {
    await relaunchApp(udid, appId);
  } catch (e) {
    // The terminate step is already swallowed inside defaultRelaunchApp, so a throw
    // here is a real `simctl launch` failure (bad UDID/bundleId, sim unavailable).
    // Capture it (Codex F3) so the verdict is actionable, not a bare "still-detached".
    relaunchError = e instanceof Error ? e.message : String(e);
    // GH #262: a failed launch is ambiguous — a transient hiccup and a missing
    // bundle look identical here, but the second makes every retry (and the
    // "relaunch manually" advice) pointless. Ask simctl for ground truth; on a
    // CONFIRMED missing bundle, short-circuit — settle/reconnect/liveness below
    // cannot succeed. Probe verdict null = unknown → fall through (fail open).
    if ((await isAppInstalled(udid, appId)) === false) {
      confirmedNotInstalled = { udid, appId };
      const snapshotHint = buildHint();
      return {
        recovered: false,
        reason: 'app-not-installed',
        attempt,
        error: relaunchError,
        udid,
        appId,
        ...(snapshotHint ? { snapshotHint } : {}),
      };
    }
  }
  await sleep(RELAUNCH_SETTLE_MS);
  try {
    await reconnect();
  } catch {
    /* best-effort; the liveness probe is the verdict */
  }

  if (await probeAlive()) {
    attempts = 0; // success bounds CONSECUTIVE detaches, not lifetime
    return { recovered: true, reason: 'recovered', attempt };
  }
  return {
    recovered: false,
    reason: 'still-detached',
    attempt,
    ...(relaunchError ? { error: relaunchError } : {}),
  };
}
