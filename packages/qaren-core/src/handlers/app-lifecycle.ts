import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';

// Safe by construction: argv arrays only, never shell strings.
// Shared lifecycle ops extracted from startup-replay.ts so device_reset_state
// can report per-step status (terminate vs launch) instead of one combined call.
const execFile = promisify(execFileCb);

const TERMINATE_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 15_000;
// The CLI's own dev-client launch bound; a loaded host can take longer than 15 s to relaunch.
const DEV_CLIENT_LAUNCH_TIMEOUT_MS = 60_000;
const IOS_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ANDROID_SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveIosLifecycleTarget(deviceId?: string): string {
  if (deviceId === undefined) return 'booted';
  if (!IOS_UDID_RE.test(deviceId)) {
    throw new Error('iOS lifecycle deviceId must be an exact simulator UDID');
  }
  return deviceId;
}

// Exported pure helpers so the iOS lifecycle argv shape is regression-testable
// without spawning simctl — same contract buildAndroidLaunchArgv provides.
export function buildIosLaunchArgv(bundleId: string, deviceId?: string): string[] {
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('buildIosLaunchArgv: bundleId is required');
  }
  return ['simctl', 'launch', resolveIosLifecycleTarget(deviceId), bundleId];
}

export function buildIosRelaunchArgv(
  bundleId: string,
  deviceId: string,
  initialUrl: string,
): string[] {
  return [
    'simctl',
    'launch',
    '--terminate-running-process',
    resolveIosLifecycleTarget(deviceId),
    bundleId,
    '--initialUrl',
    initialUrl,
  ];
}

// Terminates and relaunches the dev client on the exact simulator, pointed at its Metro.
export async function relaunchIosDevClient(
  bundleId: string,
  deviceId: string,
  initialUrl: string,
): Promise<void> {
  await execFile('xcrun', buildIosRelaunchArgv(bundleId, deviceId, initialUrl), {
    timeout: DEV_CLIENT_LAUNCH_TIMEOUT_MS,
    encoding: 'utf8',
  });
}

export function buildIosTerminateArgv(bundleId: string, deviceId?: string): string[] {
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('buildIosTerminateArgv: bundleId is required');
  }
  return ['simctl', 'terminate', resolveIosLifecycleTarget(deviceId), bundleId];
}

export function resolveAndroidLifecycleTarget(deviceId?: string): string[] {
  if (deviceId === undefined) return [];
  if (!ANDROID_SERIAL_RE.test(deviceId)) {
    throw new Error('Android lifecycle deviceId must be an exact adb serial');
  }
  return ['-s', deviceId];
}

/**
 * Force-stop the app. Idempotent on both platforms — exits 0 even if the app
 * wasn't running. iOS: `xcrun simctl terminate <exact-udid|booted> <bundleId>`;
 * callers with an active session pass its exact UDID. Android:
 * `adb [-s <serial>] shell am force-stop <bundleId>`. Errors are propagated so callers can
 * decide whether to abort or continue (a hung adb is more interesting than
 * an iOS app that wasn't running).
 */
export async function terminateApp(
  bundleId: string,
  platform: 'ios' | 'android',
  deviceId?: string,
): Promise<void> {
  if (platform === 'ios') {
    await execFile('xcrun', buildIosTerminateArgv(bundleId, deviceId), {
      timeout: TERMINATE_TIMEOUT_MS,
      encoding: 'utf8',
    });
  } else {
    await execFile(
      'adb',
      [...resolveAndroidLifecycleTarget(deviceId), 'shell', 'am', 'force-stop', bundleId],
      {
        timeout: TERMINATE_TIMEOUT_MS,
        encoding: 'utf8',
      },
    );
  }
}

/**
 * CDP-004: build a package-scoped Android launch argv for `adb`.
 *
 * Why `-p` (not a bare trailing bundleId): the bare form was parsed by
 * `am start` as an intent URI, which let unrelated packages match the
 * implicit MAIN/LAUNCHER resolution. `-p <package>` restricts intent
 * resolution to the requested package. `-W` waits for launch so failures
 * surface as non-zero exits instead of being silently lost.
 *
 * Exported as a pure helper so the argv shape can be regression-tested
 * without spawning adb.
 */
export function buildAndroidLaunchArgv(bundleId: string, deviceId?: string): string[] {
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('buildAndroidLaunchArgv: bundleId is required');
  }
  return [
    ...resolveAndroidLifecycleTarget(deviceId),
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-p',
    bundleId,
  ];
}

/**
 * Launch the app. iOS: `xcrun simctl launch <exact-udid|booted> <bundleId>`;
 * active-session callers use the exact UDID. Android: the MAIN/LAUNCHER intent
 * scoped to the package via `-p` (CDP-004).
 * Throws on failure.
 */
export async function launchApp(
  bundleId: string,
  platform: 'ios' | 'android',
  deviceId?: string,
): Promise<void> {
  if (platform === 'ios') {
    await execFile('xcrun', buildIosLaunchArgv(bundleId, deviceId), {
      timeout: LAUNCH_TIMEOUT_MS,
      encoding: 'utf8',
    });
  } else {
    await execFile('adb', buildAndroidLaunchArgv(bundleId, deviceId), {
      timeout: LAUNCH_TIMEOUT_MS,
      encoding: 'utf8',
    });
  }
}
