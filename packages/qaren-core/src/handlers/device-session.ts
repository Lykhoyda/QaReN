import {
  isAbort,
  execFile as execFileCb,
  interruptible,
  cancellationSignal,
  withCancellation,
} from '../domain/cancellation.js';
import { QaDispatchError, type QaDispatchContext } from '../domain/qa-dispatch.js';
import type { TimingContext } from '../qa/timing.js';
import { promisify } from 'node:util';
import {
  runNative,
  setActiveSession,
  clearActiveSession,
  getActiveSession,
  ensureFastRunner,
  ensureRunnerForCommand,
  attachMetaNote,
  cacheSnapshot,
  markSnapshotDirty,
  getAdbSerial,
} from '../agent-device-wrapper.js';
import {
  consumePendingFastRunnerArtifactNote,
  resetRunnerRebuildBudgetForCurrentPlugin,
  stopFastRunner,
  terminateRunnerHost,
} from '../runners/qaren-ios-runner-client.js';
import {
  stopAndroidRunner,
  reapActiveAndroidRunner,
  startAndroidRunner,
  runAndroid,
  consumePendingAndroidUpgradeNote,
} from '../runners/qaren-android-runner-client.js';
import { launchApp } from './app-lifecycle.js';
import { markCdpStale } from '../cdp/recovery.js';
import {
  detectAndroidExternalRunner,
  detectIosExternalRunner,
  foreignRunnerNotice,
} from '../runners/external-runner-detect.js';
import { ensureSingleRunner } from '../runners/ensure-single-runner.js';
import { foreignGateEnabled } from '../lifecycle/foreign-flow-gate.js';
import { suppressIOSAutocorrect } from '../runners/suppress-ios-autocorrect.js';
import { resetWedgeRecoveryCounter } from '../cdp/recover-wedge.js';
import { resetDetachedRecoveryCounter } from '../cdp/recover-detached.js';
import type { ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { resolveBundleId } from '../project-config.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import { logger } from '../logger.js';
import {
  isAgentDeviceRunnerSentinel,
  recoverFromRunnerLeak,
  type RunnerLeakNode,
} from './runner-leak-recovery.js';
import { closeDeviceSession } from './device-session-close.js';
import { recommendForegroundSurfaceRemedy } from '../domain/foreground-surface-remedy.js';
import { foregroundSurfaceFromSnapshot } from './expo-dev-menu.js';

const execFile = promisify(execFileCb);

type SnapshotAction = 'open' | 'close' | 'snapshot';

interface SnapshotArgs {
  qaTiming?: TimingContext;
  qaContext?: QaDispatchContext;
  qaReadOnly?: boolean;
  action: SnapshotAction;
  appId?: string;
  /** Exact authority-bound iOS UDID or Android serial. */
  deviceId?: string;
  platform?: string;
  sessionName?: string;
  /** Attach to the exact already-running app process without relaunching it. */
  attachOnly?: boolean;
  platformPresence?: boolean;
  presenceBudgetMs?: number;
}

/**
 * Check app liveness on the exact selected device; never use an ambiguous
 * simulator or adb target.
 */
export async function isAppRunning(
  platform: string | undefined,
  bundleId: string,
  probes?: {
    ios?: (bundleId: string, deviceId: string) => Promise<boolean>;
    android?: (bundleId: string, deviceId?: string) => Promise<boolean>;
  },
  deviceId?: string,
): Promise<boolean> {
  const p = (platform ?? 'ios').toLowerCase();
  if (p === 'android') {
    return (probes?.android ?? defaultAndroidProbe)(bundleId, deviceId);
  }
  const exactDeviceId = deviceId?.trim();
  if (!exactDeviceId) return false;
  return (probes?.ios ?? defaultIOSProbe)(bundleId, exactDeviceId);
}

export function buildIosAppRunningArgs(deviceId: string): string[] {
  return ['simctl', 'spawn', deviceId, 'launchctl', 'list'];
}

// launchctl list rows are "PID Status Label"; a loaded-but-dead job shows "-" as PID.
export function iosAppJobPid(launchctlList: string, bundleId: string): number | undefined {
  const label = `UIKitApplication:${bundleId}[`;
  for (const line of launchctlList.split('\n')) {
    const [pid, , job] = line.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && job?.startsWith(label) === true) return Number(pid);
  }
  return undefined;
}

export function iosAppJobRunning(launchctlList: string, bundleId: string): boolean {
  return iosAppJobPid(launchctlList, bundleId) !== undefined;
}

export async function iosAppProcessId(
  bundleId: string,
  deviceId: string,
): Promise<number | undefined> {
  const { stdout } = await execFile('xcrun', buildIosAppRunningArgs(deviceId), {
    timeout: 5000,
    encoding: 'utf8',
  });
  return iosAppJobPid(stdout, bundleId);
}

// A failed or timed-out probe rejects: an unanswered launchctl is not evidence that the app is gone.
async function defaultIOSProbe(bundleId: string, deviceId: string): Promise<boolean> {
  return (await iosAppProcessId(bundleId, deviceId)) !== undefined;
}

export function buildAndroidPidofArgs(bundleId: string, deviceId?: string): string[] {
  return [...(deviceId ? ['-s', deviceId] : []), 'shell', 'pidof', bundleId];
}

async function defaultAndroidProbe(bundleId: string, deviceId?: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('adb', buildAndroidPidofArgs(bundleId, deviceId), {
      timeout: 3000,
      encoding: 'utf8',
    });
    return stdout.trim().length > 0;
  } catch (error) {
    if (isAbort(error)) throw error;
    return false;
  }
}

export function buildAndroidAppLaunchArgs(deviceId: string, appId: string): string[] {
  // Keyless AVDs abort monkey with exit 251 when its default SYS_KEYS bucket is
  // non-empty. This invocation injects only the launcher event, so disabling
  // that unavailable random-event bucket changes no intended behavior.
  return [
    '-s',
    deviceId,
    'shell',
    'monkey',
    '--pct-syskeys',
    '0',
    '-p',
    appId,
    '-c',
    'android.intent.category.LAUNCHER',
    '1',
  ];
}

class AndroidAppLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AndroidAppLaunchError';
  }
}

interface DeviceSnapshotDependencies {
  probeAndroidUi?: (deviceId: string, appId: string) => Promise<ToolResult>;
  probeReactNativeUi?: (
    platform: 'ios' | 'android',
    deviceId: string,
    appId: string,
  ) => Promise<boolean>;
  isAppRunning?: (platform: string, appId: string, deviceId: string) => Promise<boolean>;
  startAndroidRunner?: (deviceId: string, appId: string) => Promise<unknown>;
  launchIosApp?: (deviceId: string, appId: string) => Promise<unknown>;
  launchAndroidApp?: (deviceId: string, appId: string) => Promise<void>;
  bindRunner?: (
    platform: 'ios' | 'android',
    deviceId: string,
    appId: string,
  ) => Promise<void> | void;
  unbindRunner?: (beforeRelease?: (platform: 'ios' | 'android') => void) => Promise<void> | void;
  resetIosRunnerRebuildBudget?: () => void;
  ensureIosRunner?: typeof ensureRunnerForCommand;
  stopIosRunner?: typeof stopFastRunner;
  terminateIosRunnerHost?: typeof terminateRunnerHost;
  reapAndroidRunner?: typeof reapActiveAndroidRunner;
  remedyAuthorityAvailable?: () => boolean | Promise<boolean>;
}

export function createDeviceSnapshotHandler(
  deps: DeviceSnapshotDependencies = {},
): (args: SnapshotArgs) => Promise<ToolResult> {
  const probeAndroidUi =
    deps.probeAndroidUi ??
    ((deviceId: string, appId: string) =>
      runAndroid({ command: 'snapshot', deviceId, bundleId: appId, interactiveOnly: false }));
  const isAppRunningFn =
    deps.isAppRunning ??
    ((platform: string, appId: string, deviceId: string) =>
      isAppRunning(platform, appId, undefined, deviceId).catch((error: unknown) => {
        if (isAbort(error)) throw error;
        return false;
      }));
  const startAndroidRunnerFn =
    deps.startAndroidRunner ??
    ((deviceId: string, appId: string) =>
      interruptible(() =>
        startAndroidRunner(deviceId, appId, undefined, { allowArtifactRebuild: true }),
      ));
  const launchAndroidApp =
    deps.launchAndroidApp ??
    (async (deviceId: string, appId: string) => {
      await execFile('adb', buildAndroidAppLaunchArgs(deviceId, appId), {
        timeout: 10_000,
        encoding: 'utf8',
      });
    });
  const ensureIosRunner = deps.ensureIosRunner ?? ensureRunnerForCommand;
  const stopIosRunner = deps.stopIosRunner ?? stopFastRunner;
  const reapAndroidRunner = deps.reapAndroidRunner ?? reapActiveAndroidRunner;
  return async (args) => {
    const action = args.action ?? 'snapshot';
    if ((args.qaContext || args.qaReadOnly) && action !== 'snapshot') {
      if (args.qaContext) args.qaContext.invalidate();
      throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
    }

    if (action === 'open') {
      let appId = args.appId;
      let autoDetected = false;
      let reactNativeUiReady: boolean | null = null;

      if (!appId) {
        const platform = args.platform ?? 'ios';
        appId = resolveBundleId(platform) ?? undefined;
        if (!appId) {
          return failResult(
            'appId is required for action=open (e.g. "com.example.app"). ' +
              'Could not auto-detect from app.json — provide appId explicitly.',
          );
        }
        autoDetected = true;
      }

      // Phase 134.2 (deepsec HIGH): when attachOnly=true on Android,
      // `appId` reaches `adb shell pidof <appId>`, where the remote shell
      // re-interprets argv. Validate against the strict bundle-ID regex
      // before any adb invocation. Expo Go bundles (`host.exp.Exponent`)
      // satisfy the regex so the EXPO_GO_BUNDLES check below still fires
      // correctly.
      if (!isValidBundleId(appId)) {
        return failResult(
          `Invalid appId "${String(appId).slice(0, 80)}" — must be reverse-DNS bundle identifier (e.g. com.example.app)`,
          'INVALID_APPID',
        );
      }

      // Refuse Expo Go — the in-tree device runner needs a Dev Client or
      // standalone build and cannot drive Expo Go.
      const EXPO_GO_BUNDLES = ['host.exp.Exponent', 'host.exp.exponent'];
      if (EXPO_GO_BUNDLES.includes(appId)) {
        return failResult(
          'Expo Go is not supported — the in-tree device runner needs a Dev Client or standalone build. ' +
            'Use CDP tools (cdp_component_tree, cdp_store_state, cdp_evaluate) + device_screenshot instead.',
          {
            hint: 'Use cdp_evaluate for JS-level interactions. device_screenshot works without a session.',
          },
        );
      }

      const sessionName = args.sessionName ?? `qaren-${Date.now()}`;

      // A device_snapshot action=open with `platform` OMITTED still opens an iOS session.
      const platform = (args.platform ?? 'ios').toLowerCase();
      const lockPlatform: 'ios' | 'android' = platform === 'android' ? 'android' : 'ios';

      // GH#202 Phase 2 Task 4: resolve device id NATIVELY (no agent-device).
      const deviceId = args.deviceId?.trim();
      if (!deviceId) {
        return failResult(
          `Exact ${platform} deviceId is required; ambient booted/first-device selection is diagnostic only.`,
          'DEVICE_AUTHORITY_MISMATCH',
        );
      }

      // B112 (D641): attachOnly mode — skip the app launch when the user knows
      // the app is already running. Avoids the unconditional relaunch that
      // invalidates CDP sessions and can race Metro bundle loading.
      if (args.attachOnly) {
        const running = await interruptible(() => isAppRunningFn(platform, appId, deviceId));
        if (!running) {
          return failResult(
            `attachOnly=true but ${appId} is not running on ${platform}. Launch it manually or drop attachOnly.`,
            'NOT_CONNECTED',
          );
        }
      }

      // Ensure runner + launch.
      // GH #383: the transparent-upgrade note must surface on EVERY entry path,
      // not just runNative — capture it here and attach to the open result.
      let upgradeNote: string | undefined;
      try {
        if (lockPlatform === 'ios') {
          // ensureRunnerForCommand re-probes liveness and returns a clean
          // {ok:false,message} when the XCUITest rig can't come up (ensureFastRunner
          // swallows its own start error), so `open` surfaces RN_FAST_RUNNER_DOWN
          // here instead of falsely reporting success against an un-prebuilt rig.
          // GH #383: propagate its typed code (RUNNER_PROTOCOL_MISMATCH) when set.
          // GH #418: open is the only entry allowed to invalidate a stale
          // runner artifact and pay the cold rebuild (mid-flow refuses fast).
          const ready = await interruptible(() =>
            ensureIosRunner(deviceId, appId, {
              allowArtifactRebuild: true,
              attachOnly: args.attachOnly === true,
            }),
          );
          if (!ready.ok) {
            await withCancellation(undefined, () => stopIosRunner(deviceId));
            // GH #382: a failed start may have left a pending artifact note —
            // discard it so it never leaks onto a later successful result.
            consumePendingFastRunnerArtifactNote();
            return failResult(ready.message, ready.code ?? 'RN_FAST_RUNNER_DOWN');
          }
          // GH #382: an upgrade note wins; otherwise surface the artifact note
          // (e.g. "downloaded prebuilt runner (~4 MB)").
          upgradeNote = ready.note ?? consumePendingFastRunnerArtifactNote();
          // Full-open foregrounding may be best-effort; attach-only activation
          // is performed by XCTest under target process-identity checks.
          if (!args.attachOnly) {
            await interruptible(() =>
              deps.launchIosApp
                ? deps.launchIosApp(deviceId, appId)
                : execFile('xcrun', ['simctl', 'launch', deviceId, appId], {
                    timeout: 10_000,
                    encoding: 'utf8',
                  }),
            ).catch((error) => {
              if (isAbort(error)) throw error;
            });
          }
        } else {
          // GH #418: open may invalidate stale runner APKs + Gradle-rebuild.
          await startAndroidRunnerFn(deviceId, appId);
          upgradeNote = consumePendingAndroidUpgradeNote();
          if (!args.attachOnly) {
            try {
              await interruptible(() => launchAndroidApp(deviceId, appId));
            } catch (err) {
              if (isAbort(err)) throw err;
              throw new AndroidAppLaunchError(
                `Failed to launch ${appId} on ${deviceId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          const readiness = await interruptible(() => probeAndroidUi(deviceId, appId));
          if (readiness.isError) {
            const envelope = JSON.parse(readiness.content[0]?.text ?? '{}') as {
              error?: string;
              code?: string;
            };
            throw new Error(
              `${envelope.code ?? 'ANDROID_UI_NOT_READY'}: ${envelope.error ?? 'the app did not expose its UI through accessibility after launch'}`,
            );
          }
          reactNativeUiReady = deps.probeReactNativeUi
            ? await interruptible(() => deps.probeReactNativeUi!('android', deviceId, appId)).catch(
                (error) => {
                  if (isAbort(error)) throw error;
                  cancellationSignal();
                  return false;
                },
              )
            : null;
        }
      } catch (err) {
        let cleanupFailure: string | undefined;
        try {
          if (lockPlatform === 'ios')
            await withCancellation(undefined, () => stopIosRunner(deviceId));
          else await withCancellation(undefined, () => reapAndroidRunner(deviceId));
        } catch (cleanupErr) {
          if (isAbort(cleanupErr)) throw cleanupErr;
          cleanupFailure = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        }
        // GH #383: startAndroidRunner may have set a pending upgrade note (reap
        // on protocol mismatch) before throwing for an unrelated reason (adb
        // forward race, exit-before-ready, spawn error). Discard it here so it
        // doesn't leak onto the next successful Android result.
        consumePendingAndroidUpgradeNote();
        if (isAbort(err)) throw err;
        cancellationSignal();
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = cleanupFailure
          ? `${rawMsg}; runner cleanup also failed: ${cleanupFailure}`
          : rawMsg;
        if (err instanceof AndroidAppLaunchError) {
          return failResult(msg, 'APP_LAUNCH_FAILED');
        }
        // GH #418: even the open-path rebuild couldn't produce a runner with
        // the required commands — the checkout itself is suspect.
        if (msg.startsWith('RUNNER_COMMANDS_STALE')) {
          return failResult(msg, 'RUNNER_COMMANDS_STALE');
        }
        // GH #383: a protocol mismatch that survived the reap+reinstall is a
        // distinct, actionable failure — surface it, not the generic runner-down.
        if (msg.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
          return failResult(msg, 'RUNNER_PROTOCOL_MISMATCH');
        }
        if (msg.startsWith('RUNNER_OWNERSHIP_MISMATCH')) {
          return failResult(msg, 'RUNNER_OWNERSHIP_MISMATCH');
        }
        const code = lockPlatform === 'ios' ? 'RN_FAST_RUNNER_DOWN' : 'RN_ANDROID_RUNNER_DOWN';
        return failResult(`Failed to start device runner: ${msg}`, code);
      }

      // Set session LAST — only after runner + launch both succeeded.
      cancellationSignal();
      setActiveSession({
        name: sessionName,
        platform,
        deviceId,
        openedAt: new Date().toISOString(),
        appId,
      });
      try {
        await interruptible(async () => {
          await deps.bindRunner?.(lockPlatform, deviceId, appId);
        });
      } catch (error) {
        let cleanupFailure: string | undefined;
        try {
          if (lockPlatform === 'ios')
            await withCancellation(undefined, () => stopIosRunner(deviceId));
          else await withCancellation(undefined, () => reapAndroidRunner(deviceId));
        } catch (cleanupErr) {
          if (isAbort(cleanupErr)) throw cleanupErr;
          cleanupFailure = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        } finally {
          clearActiveSession();
        }
        if (isAbort(error)) throw error;
        cancellationSignal();
        const rawMessage = error instanceof Error ? error.message : String(error);
        const code = /^([A-Z][A-Z0-9_]+):/.exec(rawMessage)?.[1] ?? 'RUNNER_OWNERSHIP_MISMATCH';
        const message = cleanupFailure
          ? `${rawMessage}; runner cleanup also failed: ${cleanupFailure}`
          : rawMessage;
        return failResult(message, code as ToolErrorCode);
      }

      // GH#202 Phase 2b: a genuinely-succeeded open is a fresh session — clear
      // the wedge-recovery budget.
      resetWedgeRecoveryCounter();
      resetDetachedRecoveryCounter(); // GH #208 (RC3): fresh session clears the auto-relaunch budget too

      // GH#202 Phase 1: enforce a single iOS interaction runner. The UDID is
      // known here (device-open), so scope-kill any stale AgentDeviceRunner
      // targeting THIS simulator and clear orphaned daemon lock files.
      // Default-on; opt out with RN_DEVICE_KILL_LEGACY=0.
      if (process.env.RN_DEVICE_KILL_LEGACY !== '0' && platform === 'ios' && deviceId) {
        try {
          const r = await ensureSingleRunner({ udid: deviceId });
          if (r.killedPids.length) {
            logger.info(
              'rn-device',
              `ensureSingleRunner: killed stale runner PID(s) ${r.killedPids.join(', ')} on ${deviceId}`,
            );
          }
          if (r.removedFiles.length) {
            logger.info('rn-device', `ensureSingleRunner: removed ${r.removedFiles.join(', ')}`);
          }
          if (r.removedApps.length) {
            logger.info(
              'rn-device',
              `ensureSingleRunner: uninstalled legacy runner app(s) ${r.removedApps.join(', ')} from ${deviceId}`,
            );
          }
          for (const w of r.warnings) logger.warn('rn-device', w);
        } catch (err) {
          if (isAbort(err)) throw err;
          logger.warn(
            'rn-device',
            `ensureSingleRunner failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Task 9 of Android-MVP: warn on competing Android UIAutomator /
      // agent-device processes that would contend for input + focus with
      // our qaren-android-runner. Fires by default (Task 11 flipped the
      // runner default-on); opt-out via RN_ANDROID_RUNNER=0.
      if (platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0') {
        await detectAndroidExternalRunner(undefined, getAdbSerial())
          .then((warning) => {
            if (!warning) return;
            logger.warn('rn-device', warning.message);
            for (const line of warning.processLines) {
              logger.warn('rn-device', `  ${line.trim()}`);
            }
          })
          .catch((error) => {
            if (isAbort(error)) throw error;
          });
      }

      if (platform === 'ios') {
        // #191 prong 3 — best-effort predictive-keyboard suppression. Gated on
        // iOS+udid only (NOT the kill-legacy opt-out — orthogonal concern).
        await suppressIOSAutocorrect(deviceId)
          .then((sup) => {
            if (sup.warnings.length)
              logger.info('rn-device', `suppressIOSAutocorrect: ${sup.warnings.join('; ')}`);
          })
          .catch((error) => {
            if (isAbort(error)) throw error;
          });
      }

      // GH#202 Phase 3: proactive foreign-runner heads-up (informational only).
      // UDID-scoped + best-effort: the detector never throws (can't fail the
      // open); its ≤2s latency is surfaced in meta.timings_ms.
      let foreign: ReturnType<typeof foreignRunnerNotice> = null;
      let foreignDetectMs: number | undefined;
      if (platform === 'ios' && foreignGateEnabled()) {
        const t0 = Date.now();
        const detection = await detectIosExternalRunner(undefined, deviceId);
        foreignDetectMs = Date.now() - t0;
        foreign = foreignRunnerNotice(detection, false);
        if (foreign) {
          logger.warn('rn-device', foreign.warning);
          for (const line of foreign.meta.foreignRunner.processLines) {
            logger.warn('rn-device', `  ${line}`);
          }
        }
      }

      const data = {
        ok: true,
        sessionName,
        platform,
        deviceId,
        appId,
        readiness:
          platform === 'android'
            ? {
                appForeground: true,
                accessibilityUi: true,
                reactNativeUi: reactNativeUiReady === true ? 'ready' : ('unverified' as const),
              }
            : { appForeground: true },
      };
      const readinessWarning =
        platform === 'android' && reactNativeUiReady !== true
          ? 'Android app accessibility is ready, but the React Native helper boundary is unverified; run cdp_status and require capabilities.fiberTree=true before treating launch as RN-ready'
          : null;
      let result: ToolResult;
      if (autoDetected || foreign || readinessWarning) {
        const warning = [
          autoDetected ? `appId auto-detected from app.json: ${appId}` : null,
          foreign ? foreign.warning : null,
          readinessWarning,
        ]
          .filter(Boolean)
          .join('; ');
        const meta: Record<string, unknown> = { ...(foreign ? foreign.meta : {}) };
        if (foreignDetectMs !== undefined) meta.timings_ms = { foreignDetect: foreignDetectMs };
        result = warnResult(data, warning, meta);
      } else {
        result = okResult(data);
      }
      return upgradeNote ? attachMetaNote(result, upgradeNote) : result;
    }

    if (action === 'close') {
      const closingPlatform = getActiveSession()?.platform ?? args.platform;
      const result = await closeDeviceSession({
        hasActiveSession: () => getActiveSession() !== null,
        closeUnderlyingSession: async () => okResult({ closed: true }),
        clearActiveSession,
        stopFastRunner,
        terminateRunnerHost: deps.terminateIosRunnerHost ?? terminateRunnerHost,
        stopAndroidRunner: async (deviceId) => {
          if (getActiveSession()?.platform === 'android') {
            await reapActiveAndroidRunner(deviceId);
          }
        },
        finalizeSuccessfulClose: async () => {
          await deps.unbindRunner?.();
          if (closingPlatform === 'ios') {
            (deps.resetIosRunnerRebuildBudget ?? resetRunnerRebuildBudgetForCurrentPlugin)();
          }
        },
        getDeviceId: () => getActiveSession()?.deviceId,
      });
      return result;
    }

    // action === 'snapshot'
    if (!getActiveSession()) {
      if (args.qaContext) args.qaContext.invalidate();
      if (args.qaReadOnly) throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
      if (args.platformPresence === true) {
        return failResult(
          'Platform presence requires an existing device session.',
          'RN_FAST_RUNNER_DOWN',
          {
            capture: 'unknown',
            mutation: 'none',
            dispatched: false,
          },
        );
      }
      return failResult('No device session open. Call device_snapshot with action="open" first.', {
        hint: 'Provide appId and platform to start a session.',
      });
    }

    const result = await rawSnapshot(
      args.platformPresence,
      args.qaContext,
      args.qaReadOnly,
      args.presenceBudgetMs,
      args.qaTiming,
    );
    const nodes = parseSnapshotNodes(result);

    if (!result.isError && nodes && isAgentDeviceRunnerSentinel(nodes)) {
      if (args.qaContext) args.qaContext.invalidate();
      if (args.qaReadOnly) throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
      const session = getActiveSession();
      if (args.platformPresence === true && presencePlatform(session?.platform)) {
        return failResult(
          'Platform presence observed the runner UI; no recovery attempted.',
          'RN_FAST_RUNNER_DOWN',
          {
            capture: 'unknown',
            mutation: 'none',
            dispatched: true,
          },
        );
      }
      markSnapshotDirty(session?.platform);
      const recovery = await recoverFromRunnerLeak(
        {
          platform: session?.platform,
          appId: session?.appId,
          deviceId: session?.deviceId,
          sessionName: session?.name,
        },
        {
          // B130 (D659): the recovery close must also clear the local session
          // state (activeSession → null, ref-map → empty, fast-runner stopped)
          // so the post-recovery re-snapshot goes through the daemon/CLI path
          // that populates ref refs, NOT the fast-runner path which returns
          // a tree-shaped result lacking @eN refs. Without this, `device_fill`
          // after recovery fails with "No snapshot in session" because the
          // ref-map is stale (from pre-recovery) OR non-existent (after fresh
          // session open), and fast-runner serves the (ref-less) snapshot.
          closeSession: async () => {
            await stopFastRunner(session?.deviceId);
            await stopAndroidRunner(session?.deviceId);
            await deps.unbindRunner?.();
            clearActiveSession();
            return okResult({ closed: true });
          },
          openSession: ({ appId, platform, deviceId, attachOnly }) =>
            reopenSessionForRecovery(appId, platform, attachOnly, deviceId, deps),
          resnapshot: () =>
            rawSnapshot(
              args.platformPresence,
              args.qaContext,
              args.qaReadOnly,
              args.presenceBudgetMs,
              args.qaTiming,
            ),
          parseNodes: parseSnapshotNodes,
          reacquire:
            session?.platform === 'ios' &&
            session?.appId &&
            session?.deviceId &&
            deps.bindRunner &&
            deps.unbindRunner
              ? () =>
                  reacquireIosTargetApp(session.appId!, session.deviceId!, {
                    bindRunner: deps.bindRunner!,
                    ensureFastRunner,
                    launchApp,
                    stopFastRunner,
                    unbindRunner: deps.unbindRunner!,
                  })
              : undefined,
        },
      );

      if (recovery.recovered) {
        cacheSnapshotIfPossible(recovery.result);
        // GH #186: the recovery re-foregrounded/relaunched the app, which can
        // leave the CDP target pinned to a now-stale context. Flag it so the
        // next cdp_* call re-pins proactively (fast) instead of hitting the
        // ~47s STALE_TARGET timeout that prompted this issue.
        markCdpStale();
        return attachForegroundSurfaceDiscovery(
          wrapWithMeta(recovery.result, {
            recovered: 'agent-device-runner-leak',
            recoveryTier: recovery.tier,
          }),
          getActiveSession()?.appId,
          deps.remedyAuthorityAvailable,
        );
      }

      return failResult(runnerLeakFailureMessage(recovery.reason, session), {
        code: 'RUNNER_LEAK',
        recoveryReason: recovery.reason,
        hint: runnerLeakFailureHint(recovery.reason, session),
      });
    }

    if (!args.qaContext && !args.qaReadOnly)
      cacheSnapshotIfPossible(result, args.platformPresence === true);
    return attachForegroundSurfaceDiscovery(
      result,
      getActiveSession()?.appId,
      deps.remedyAuthorityAvailable,
    );
  };
}

export async function attachForegroundSurfaceDiscovery(
  result: ToolResult,
  boundAppId: string | undefined,
  remedyAuthorityAvailable?: () => boolean | Promise<boolean>,
): Promise<ToolResult> {
  if (result.isError) return result;
  const foregroundSurface = foregroundSurfaceFromSnapshot(result, boundAppId);
  const authorityAvailable =
    foregroundSurface === 'expo_dev_menu' && (await remedyAuthorityAvailable?.()) === true;
  const recommendation = recommendForegroundSurfaceRemedy({
    condition: foregroundSurface,
    authority: authorityAvailable ? 'available' : 'unavailable',
  });
  return wrapWithMeta(result, {
    foregroundSurface,
    recommendation: recommendation ?? undefined,
  });
}

export function runnerLeakFailureMessage(
  reason: string | undefined,
  session: { appId?: string } | null,
): string {
  if (reason === 'no-session-context' && session && !session.appId) {
    return "device_snapshot returned AgentDeviceRunner's own UI tree, but auto-recovery cannot run because the active session has no stored appId. This usually means the session was opened by a plugin version from before B119 / GH #35 landed.";
  }
  return "device_snapshot returned AgentDeviceRunner's own UI tree instead of the target app (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.";
}

export function runnerLeakFailureHint(
  reason: string | undefined,
  session: { appId?: string } | null,
): string {
  if (reason === 'no-session-context' && session && !session.appId) {
    return 'Run device_snapshot action=close, then action=open appId=<your.bundle.id> platform=ios to start a session that supports auto-recovery.';
  }
  return 'Manually close + reopen the session with action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). Upstream: Callstack/agent-device, see B119/GH#35.';
}

export async function reacquireIosTargetApp(
  appId: string,
  deviceId: string,
  dependencies: {
    bindRunner: NonNullable<DeviceSnapshotDependencies['bindRunner']>;
    ensureFastRunner: typeof ensureFastRunner;
    launchApp: typeof launchApp;
    stopFastRunner: typeof stopFastRunner;
    unbindRunner: NonNullable<DeviceSnapshotDependencies['unbindRunner']>;
  },
): Promise<ToolResult> {
  try {
    await dependencies.stopFastRunner(deviceId);
    await dependencies.unbindRunner();
    await dependencies.launchApp(appId, 'ios', deviceId);
    await dependencies.ensureFastRunner(deviceId, appId);
    await dependencies.bindRunner('ios', deviceId, appId);
    return okResult({ reacquired: true, appId });
  } catch (error) {
    if (isAbort(error)) throw error;
    return failResult(
      `Runner authority reacquire failed: ${error instanceof Error ? error.message : String(error)}`,
      'RUNNER_OWNERSHIP_MISMATCH',
    );
  }
}

// Both native runners capture platform presence for QA reads.
function presencePlatform(platform: string | undefined): boolean {
  return platform === 'ios' || platform === 'android';
}

async function rawSnapshot(
  platformPresence?: boolean,
  qaContext?: QaDispatchContext,
  qaReadOnly?: boolean,
  presenceBudgetMs?: number,
  qaTiming?: TimingContext,
): Promise<ToolResult> {
  return runNative(
    platformPresence === true && presencePlatform(getActiveSession()?.platform)
      ? ['snapshot', '--platform-presence']
      : ['snapshot', '-i'],
    { qaContext, qaReadOnly, presenceBudgetMs, qaTiming },
  );
}

function parseSnapshotNodes(result: ToolResult): RunnerLeakNode[] | null {
  if (result.isError) return null;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: RunnerLeakNode[] };
    };
    if (!envelope.ok || !envelope.data?.nodes) return null;
    return envelope.data.nodes;
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

function cacheSnapshotIfPossible(result: ToolResult, platformPresence = false): void {
  if (result.isError) return;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      meta?: { snapshotVerdict?: { state?: unknown; refMapUpdated?: unknown } };
      data?: {
        nodes?: {
          ref: string;
          label?: string;
          identifier?: string;
          type?: string;
          hittable?: boolean;
        }[];
      };
    };
    const platform = getActiveSession()?.platform;
    if (
      platformPresence &&
      presencePlatform(platform) &&
      (envelope.meta?.snapshotVerdict?.state !== 'ok' ||
        envelope.meta.snapshotVerdict.refMapUpdated !== true)
    ) {
      markSnapshotDirty(platform);
      return;
    }
    if (platform && envelope.ok && envelope.data?.nodes) {
      cacheSnapshot(platform, envelope.data.nodes);
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    /* best-effort cache */
  }
}

function wrapWithMeta(result: ToolResult, meta: Record<string, unknown>): ToolResult {
  if (result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: unknown;
      meta?: Record<string, unknown>;
    };
    envelope.meta = { ...envelope.meta, ...meta };
    return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
  } catch (error) {
    if (isAbort(error)) throw error;
    return result;
  }
}

export async function reopenSessionForRecovery(
  appId: string,
  platform: string,
  attachOnly: boolean,
  deviceId?: string,
  dependencies: DeviceSnapshotDependencies = {},
): Promise<ToolResult> {
  // Always mint a fresh recovery name (Gemini G3): reusing the original
  // session name risks silently re-attaching to the corrupted session.
  const recoveryName = `qaren-recovery-${Date.now()}`;

  // Delegate to the native open path: resolve device → ensure runner → launch → set session.
  return createDeviceSnapshotHandler(dependencies)({
    action: 'open',
    appId,
    deviceId,
    platform: platform as SnapshotArgs['platform'],
    attachOnly,
    sessionName: recoveryName,
  });
}
