import { labelProvenanceFromWire, type LabelProvenance } from '../qa/label-provenance.js';
import { currentInputs } from '../qa/inputs.js';
/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
import { QaDispatchError, type QaDispatchContext } from '../domain/qa-dispatch.js';
import { QA_READ_ONLY_CAPABILITY, checkQaNativeOutcome } from './qa-native-policy.js';
import { DEVICE_LEASE_REQUIRED, leaseFromEnvironment } from './lease-env.js';
import {
  spawn,
  execFile,
  cancellableFetch,
  sleep,
  cancellationSignal,
  throwIfCancelled,
  isAbort,
  withCancellation,
} from '../domain/cancellation.js';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import { okResult, failResult } from '../utils.js';
import {
  updateRefMapFromFlat,
  buildSnapshotVerdict,
  getCachedMetadata,
  getFreshRefTarget,
  type FlatNode,
} from '../fast-runner-ref-map.js';
import { findFreePort } from './free-port.js';
import { withAndroidRunnerApkLock } from './android-runner-apk-lock.js';
import { join } from 'node:path';
import { withKeyboardGuard } from './keyboard-guard.js';
import {
  runnerStatePath,
  readJsonStateFile,
  writeJsonStateFileAtomic,
  deleteStateFile,
  readLegacyTmpState,
  cleanupLegacyTmpState,
} from '../util/secure-state-file.js';
import {
  RUNNER_PROTOCOL_VERSION,
  MIN_SUPPORTED_RUNNER_PROTOCOL,
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  getPluginVersion,
  classifyRunnerCompatibility,
} from './protocol.js';
import { artifactProvenanceToState, resolveAndroidRunnerArtifacts } from './runner-artifacts.js';
import { resolveNativeRunnerDir } from './runtime-paths.js';
import {
  decideRecovery,
  generateCommandId,
  isAmbiguousTransportFailure,
  isMutatingCommand,
  parseStatusProbeReply,
} from './transport-recovery.js';
import { readProcessBirth } from '../lifecycle/process-birth.js';
import { openAuthorityStore } from '../util/sqlite-store.js';
import {
  resolveAndroidInstallAction,
  type AndroidRunnerBuildIdentity,
} from '../domain/android-runner-build.js';
export { resolveAndroidInstallAction } from '../domain/android-runner-build.js';
export type { AndroidInstallAction } from '../domain/android-runner-build.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 22089;
const READY_TIMEOUT_MS = 30_000;
const INSTRUMENTATION =
  'dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner';
const MAIN_LOOP_CLASS =
  'dev.lykhoyda.rndevagent.androidrunner.RnAndroidRunnerInstrumentedTest#mainLoop';
const HEALTH_POLL_INTERVAL_MS = 150;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

// The in-tree runner ships as a Gradle project. Provisioning refreshes its
// expected APKs before comparing installed bytes, then installs only if needed.
const RN_ANDROID_RUNNER_DIR = resolveNativeRunnerDir('rn-android-runner');
const GRADLEW = join(RN_ANDROID_RUNNER_DIR, 'gradlew');
const APK_APP = join(
  RN_ANDROID_RUNNER_DIR,
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);
const APK_TEST = join(
  RN_ANDROID_RUNNER_DIR,
  'app',
  'build',
  'outputs',
  'apk',
  'androidTest',
  'debug',
  'app-debug-androidTest.apk',
);
const ANDROID_REBUILD_ROOT = join(RN_ANDROID_RUNNER_DIR, 'app', 'build');
const ANDROID_APK_LOCK = join(ANDROID_REBUILD_ROOT, '.qaren-apk-lock');
const ANDROID_REBUILD_LOCK_DATABASE = join(
  ANDROID_REBUILD_ROOT,
  '.authority-rebuild',
  'lock.sqlite',
);
const ANDROID_REBUILD_LOCK_STALE_MS = 15 * 60_000;
const ANDROID_REBUILD_HEARTBEAT_MS = 60_000;
const ANDROID_REBUILD_COMPLETION_RETRY_MS = 1_000;
const ANDROID_REBUILD_COMPLETION_ATTEMPTS = 5;
const ANDROID_REBUILD_CLEANUP_TIMEOUT_MS = 30_000;
const ADB_CLEANUP_TIMEOUT_MS = 5_000;
const GRADLE_BUILD_TIMEOUT_MS = 600_000; // cold assembleDebug can take minutes on a fresh machine
const ADB_INSTALL_TIMEOUT_MS = 120_000;

interface AndroidRunnerState {
  schemaVersion: 1;
  hostPort: number; // 127.0.0.1 port the TS client connects to (probed; globally contended)
  devicePort: number; // NanoHTTPD listener inside the emulator (fixed; emulator-namespaced)
  pid: number;
  deviceId?: string;
  bundleId?: string;
  startedAt: string;
  protocolVersion: number;
  runnerVersion?: string;
  // GH #382: prebuilt (cache/download) vs local Gradle build. Surfaced by doctor.
  provenance?: 'prebuilt' | 'local';
  instanceId?: string;
  sessionId?: string;
  claimEpoch?: number;
  capability?: string;
  processBirth?: string;
}

export function getAndroidRunnerState(): AndroidRunnerState | null {
  return runnerState;
}

export interface RunAndroidArgs {
  qaContext?: QaDispatchContext;
  qaReadOnly?: boolean;
  command:
    | 'snapshot'
    | 'tap'
    | 'press'
    | 'drag'
    | 'swipe'
    | 'longPress'
    | 'pinch'
    | 'findText'
    | 'type'
    | 'fill'
    | 'verifyInput'
    | 'dismissKeyboard'
    | 'screenshot'
    | 'back'
    | 'status'
    | 'isWindowUpdating'
    | 'systemAlertTap';
  bundleId?: string;
  deviceId?: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  text?: string;
  /** systemAlertTap: the runner taps the one dialog button whose text equals one of these. */
  labels?: string[];
  /** Exact-fill descriptor resolved afresh by the runner within one command. */
  exactIdentifier?: string;
  exactType?: string;
  exact?: boolean;
  includeSystemUi?: boolean;
  durationMs?: number;
  /** Story 04 (#385): window-gate probe timeout for isWindowUpdating (Kotlin clamps to 0..2000ms). */
  timeoutMs?: number;
  scale?: number;
  interactiveOnly?: boolean;
  /** A QA snapshot that also runs the runner's presence pass within this budget. */
  platformPresence?: boolean;
  labelProvenance?: number[];
  presenceBudgetMs?: number;
  outPath?: string;
  /** GH #581: exact input identity + declared focus point for type/verifyInput. */
  snapshotGeneration?: number;
  snapshotNodeIndex?: number;
  snapshotIdentifier?: string;
  snapshotElementType?: string;
  targetBounds?: { x: number; y: number; width: number; height: number };
  focusX?: number;
  focusY?: number;
  focusWaitMs?: number;
  /** An exact tap on an editable field waits this long for its keyboard: the tap's post-act settle budget. */
  keyboardWaitMs?: number;
  secureInput?: boolean;
  operationToken?: string;
  _staleRef?: string;
}

interface RunnerResponse {
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string; mutation?: string; reason?: string };
  v?: number;
}

interface RunnerSnapshotNode {
  index?: number;
  depth?: number;
  parentIndex?: number;
  presence?: unknown;
  type?: string;
  label?: string;
  identifier?: string;
  packageName?: string;
  checked?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  hittable?: boolean;
  selected?: boolean;
  visibleToUser?: boolean;
  heading?: boolean;
  secure?: boolean;
}

let runnerProcess: ChildProcess | null = null;
let runnerState: AndroidRunnerState | null = null;
let fetchImpl: typeof fetch = globalThis.fetch;
let testAuthorityState = false;

export function _setFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

export function _setAndroidRunnerStateForTest(state: AndroidRunnerState | null): void {
  testAuthorityState = state !== null;
  runnerState = state
    ? {
        ...state,
        instanceId: state.instanceId ?? 'test-runner-instance',
        sessionId: state.sessionId ?? 'test-session',
        claimEpoch: state.claimEpoch ?? 1,
        capability: state.capability ?? 'test-capability'.repeat(3),
      }
    : null;
}

export function androidStatePath(serial: string): string {
  return runnerStatePath(`android-${serial}`);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parsePersistedAndroidState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): AndroidRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AndroidRunnerState>;
  if (s.schemaVersion !== 1) return null;
  if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number') return null;
  if (typeof s.pid !== 'number') return null;
  if (!pidAlive(s.pid)) return null;
  return s as AndroidRunnerState;
}

// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state — mirrors parseLegacyRunnerState on iOS. protocolVersion 0 makes
// the reuse-time health gate classify the live runner 'legacy' → reap.
export function parseLegacyAndroidState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): AndroidRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as {
    hostPort?: unknown;
    devicePort?: unknown;
    pid?: unknown;
    deviceId?: unknown;
    bundleId?: unknown;
  };
  if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number') return null;
  if (typeof s.pid !== 'number') return null;
  if (!pidAlive(s.pid)) return null;
  return {
    schemaVersion: 1,
    hostPort: s.hostPort,
    devicePort: s.devicePort,
    pid: s.pid,
    ...(typeof s.deviceId === 'string' ? { deviceId: s.deviceId } : {}),
    ...(typeof s.bundleId === 'string' ? { bundleId: s.bundleId } : {}),
    startedAt: '',
    protocolVersion: 0,
  };
}

// Serial-scoped adoption (review amendment: NO 'default' key — an unknown
// serial means no persistence, so two projects driving two different
// unspecified devices can never share a state file).
export function adoptPersistedAndroidState(serial?: string): void {
  if (runnerState) return;
  if (serial) {
    const path = androidStatePath(serial);
    const raw = readJsonStateFile(path);
    if (raw !== null) {
      const parsed = parsePersistedAndroidState(raw);
      if (!parsed) {
        deleteStateFile(path);
        return;
      }
      runnerState = parsed;
      return;
    }
  }
  const legacy = readLegacyTmpState('android');
  if (legacy === null) return;
  const parsedLegacy = parseLegacyAndroidState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (!serial || !parsedLegacy.deviceId || parsedLegacy.deviceId === serial) {
    runnerState = parsedLegacy;
  }
}

function clearAndroidStateFile(): void {
  const path = runnerState?.deviceId ? androidStatePath(runnerState.deviceId) : null;
  runnerState = null;
  runnerProcess = null;
  if (path) deleteStateFile(path);
}

export function parseAdbDevicesSerials(stdout: string): string[] {
  return stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .map((l) => /^(\S+)\s+device\b/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

export async function resolveAndroidSerial(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const serials = parseAdbDevicesSerials(stdout);
    return serials.length === 1 ? serials[0] : undefined;
  } catch {
    throwIfCancelled();
    return undefined;
  }
}

function adbSerialArgs(deviceId?: string): string[] {
  if (deviceId) return ['-s', deviceId];
  if (process.env.ANDROID_SERIAL) return ['-s', process.env.ANDROID_SERIAL];
  return [];
}

export function buildAdbForwardArgs(
  deviceId: string | undefined,
  hostPort: number,
  devicePort: number,
): string[] {
  return [...adbSerialArgs(deviceId), 'forward', `tcp:${hostPort}`, `tcp:${devicePort}`];
}

export function buildAdbForwardRemoveArgs(
  deviceId: string | undefined,
  hostPort: number,
): string[] {
  return [...adbSerialArgs(deviceId), 'forward', '--remove', `tcp:${hostPort}`];
}

export function buildInstrumentPortArgs(devicePort: number): string[] {
  return ['-e', 'RN_ANDROID_RUNNER_PORT', String(devicePort)];
}

export function buildInstrumentVersionArgs(pluginVersion: string | null): string[] {
  return pluginVersion ? ['-e', 'RN_PLUGIN_VERSION', pluginVersion] : [];
}

interface AndroidRunnerAuthority {
  instanceId: string;
  sessionId: string;
  claimEpoch: number;
  capability: string;
  deviceId: string;
  appId: string;
}

function androidRunnerAuthority(deviceId: string, appId: string): AndroidRunnerAuthority {
  const lease = leaseFromEnvironment();
  const sessionId = (testAuthorityState ? runnerState?.sessionId : undefined) ?? lease?.sessionId;
  const claimEpoch =
    (testAuthorityState ? runnerState?.claimEpoch : undefined) ?? lease?.claimEpoch;
  if (
    !sessionId ||
    typeof claimEpoch !== 'number' ||
    !Number.isSafeInteger(claimEpoch) ||
    claimEpoch < 1
  ) {
    throw new Error(DEVICE_LEASE_REQUIRED);
  }
  return {
    instanceId: randomUUID(),
    sessionId,
    claimEpoch,
    capability: randomBytes(32).toString('base64url'),
    deviceId,
    appId,
  };
}

export function buildInstrumentAuthorityArgs(authority: AndroidRunnerAuthority): string[] {
  return Object.entries({
    RN_RUNNER_INSTANCE_ID: authority.instanceId,
    RN_RUNNER_SESSION_ID: authority.sessionId,
    RN_RUNNER_CLAIM_EPOCH: String(authority.claimEpoch),
    RN_RUNNER_CAPABILITY: authority.capability,
    RN_RUNNER_DEVICE_ID: authority.deviceId,
    RN_RUNNER_APP_ID: authority.appId,
  }).flatMap(([key, value]) => ['-e', key, value]);
}

export function buildAdbInstallArgs(deviceId: string | undefined, apkPath: string): string[] {
  return [...adbSerialArgs(deviceId), 'install', '-r', apkPath];
}

export function buildGradleAssembleArgs(): string[] {
  return [
    ':app:assembleDebug',
    ':app:assembleDebugAndroidTest',
    '--no-daemon',
    '-Pkotlin.compiler.execution.strategy=in-process',
  ];
}

/**
 * True when `adb shell pm list instrumentation` names our exact `<pkg>/<runner>` id.
 * Anchored to the full id (not the bare package) so a superstring package
 * (`…androidrunner.testfoo`) or a `(target=…)` mention can't false-positive.
 */
export function isInstrumentationRegistered(
  pmListStdout: string,
  instrumentation: string,
): boolean {
  const escaped = instrumentation.replace(/[.$*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|:)${escaped}(\\s|$)`, 'm').test(pmListStdout);
}

const PROCESSES_HEADER = 'ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)';

/**
 * Whether `dumpsys activity processes <runner>` lists the runner, whose process
 * hosts its instrumentation. Undefined unless the output is a recognised
 * processes dump, so an unsupported or failed dump never reads as absence.
 */
export function androidRunnerProcessListed(stdout: string): boolean | undefined {
  const first = stdout.split('\n').find((line) => line.trim() !== '');
  if (first?.trim() !== PROCESSES_HEADER) return undefined;
  return stdout.includes('dev.lykhoyda.rndevagent.androidrunner');
}

async function installedAndroidApkHash(
  packageName: string,
  deviceId: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const options = { timeout: ADB_CLEANUP_TIMEOUT_MS, signal };
    const { stdout: paths } = await execFileAsync(
      'adb',
      [...adbSerialArgs(deviceId), 'shell', 'pm', 'path', packageName],
      options,
    );
    // Only a single ordinary installed APK is comparable to our build output.
    // adb shell joins its arguments remotely: admit no shell metacharacters.
    const path = /^package:(\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk)$/.exec(paths.trim())?.[1];
    if (!path || path.split('/').includes('..')) return undefined;
    const { stdout } = await execFileAsync(
      'adb',
      [...adbSerialArgs(deviceId), 'shell', 'sha256sum', path],
      options,
    );
    const parts = stdout.trim().split(/\s+/);
    return parts.length === 2 && parts[1] === path && /^[a-f0-9]{64}$/.test(parts[0])
      ? parts[0]
      : undefined;
  } catch (error) {
    throwIfCancelled(signal);
    if (isAbort(error)) throw error;
    // Unreadable installed bytes never authorize reuse; install the expected pair.
    return undefined;
  }
}

async function ensureAndroidRunnerInstalled(
  deviceId?: string,
  opts: { forceReinstall?: boolean; signal?: AbortSignal } = {},
): Promise<'prebuilt' | 'local'> {
  throwIfCancelled(opts.signal);
  try {
    const { stdout } = await execFileAsync('adb', [...adbSerialArgs(deviceId), 'get-state'], {
      timeout: 5_000,
      signal: opts.signal,
    });
    if (stdout.trim() !== 'device') throw new Error(`adb state is "${stdout.trim()}"`);
  } catch (err) {
    throwIfCancelled(opts.signal);
    if (isAbort(err)) throw err;
    throw new Error(
      `rn-android-runner: target device not online (adb get-state) — boot the emulator / connect the device. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let pmOut = '';
  try {
    pmOut = (
      await execFileAsync(
        'adb',
        [...adbSerialArgs(deviceId), 'shell', 'pm', 'list', 'instrumentation'],
        {
          timeout: ADB_CLEANUP_TIMEOUT_MS,
          signal: opts.signal,
        },
      )
    ).stdout;
  } catch (error) {
    throwIfCancelled(opts.signal);
    if (isAbort(error)) throw error;
    // adb/pm unavailable → treat as not registered; the install/adb step below surfaces the real error.
  }
  return withAndroidRunnerApkLock(
    ANDROID_APK_LOCK,
    async () => {
      const artifacts = resolveAndroidRunnerArtifacts({ appApk: APK_APP, testApk: APK_TEST });
      const provenance = artifactProvenanceToState(artifacts.provenance);
      if (artifacts.note) pendingUpgradeNote = artifacts.note;

      // Gradle's incremental build establishes the expected bytes for the current
      // shipped source, even when APKs from an earlier checkout still exist.
      if (
        artifacts.provenance === 'build-local' ||
        !existsSync(artifacts.appApk) ||
        !existsSync(artifacts.testApk)
      ) {
        try {
          await execFileAsync(GRADLEW, buildGradleAssembleArgs(), {
            cwd: RN_ANDROID_RUNNER_DIR,
            timeout: GRADLE_BUILD_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            signal: opts.signal,
          });
        } catch (err) {
          throwIfCancelled(opts.signal);
          if (isAbort(err)) throw err;
          throw new Error(
            `rn-android-runner source build failed (gradlew assembleDebug assembleDebugAndroidTest in ${RN_ANDROID_RUNNER_DIR}). ` +
              `Ensure the Android SDK + a JDK are installed and on PATH. ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }

      throwIfCancelled(opts.signal);
      const expectedBuild: AndroidRunnerBuildIdentity = {
        appSha256: createHash('sha256').update(readFileSync(artifacts.appApk)).digest('hex'),
        testSha256: createHash('sha256').update(readFileSync(artifacts.testApk)).digest('hex'),
      };
      const instrumentationRegistered =
        !opts.forceReinstall && isInstrumentationRegistered(pmOut, INSTRUMENTATION);
      let installedBuild: AndroidRunnerBuildIdentity | undefined;
      if (instrumentationRegistered) {
        const [appSha256, testSha256] = await Promise.all([
          installedAndroidApkHash('dev.lykhoyda.rndevagent.androidrunner', deviceId, opts.signal),
          installedAndroidApkHash(
            'dev.lykhoyda.rndevagent.androidrunner.test',
            deviceId,
            opts.signal,
          ),
        ]);
        if (appSha256 && testSha256) installedBuild = { appSha256, testSha256 };
      }
      const action = resolveAndroidInstallAction({
        instrumentationRegistered,
        apksExist: true,
        expectedBuild,
        installedBuild,
      });
      if (action === 'reuse') return provenance;

      try {
        await execFileAsync('adb', buildAdbInstallArgs(deviceId, artifacts.appApk), {
          timeout: ADB_INSTALL_TIMEOUT_MS,
          signal: opts.signal,
        });
        throwIfCancelled(opts.signal);
        await execFileAsync('adb', buildAdbInstallArgs(deviceId, artifacts.testApk), {
          timeout: ADB_INSTALL_TIMEOUT_MS,
          signal: opts.signal,
        });
      } catch (err) {
        throwIfCancelled(opts.signal);
        if (isAbort(err)) throw err;
        throw new Error(
          `rn-android-runner APK install failed (adb install -r). Is the emulator/device online? ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      return provenance;
    },
    { signal: opts.signal },
  );
}

export function isAndroidRunnerAvailable(): boolean {
  if (!runnerState) return false;
  try {
    process.kill(runnerState.pid, 0);
    return true;
  } catch {
    clearAndroidStateFile();
    return false;
  }
}

/**
 * GH#202 parity with iOS shouldReuseRunner: only adopt a live runner when it is
 * bound to the SAME emulator. The state file path is a fixed constant shared
 * across projects/sessions, so a runner bound to emulator-A must never be reused
 * to drive emulator-B (its adb forward + port still point at A — every command
 * would silently hit the wrong device). When no specific deviceId is requested
 * (single-device flow), any live runner is acceptable.
 */
export function shouldReuseAndroidRunner(
  state: AndroidRunnerState | null,
  deviceId?: string,
): boolean {
  if (state === null) return false;
  const lease = leaseFromEnvironment();
  const sessionId = (testAuthorityState ? state.sessionId : undefined) ?? lease?.sessionId;
  const claimEpoch = (testAuthorityState ? state.claimEpoch : undefined) ?? lease?.claimEpoch;
  if (
    !sessionId ||
    !Number.isSafeInteger(claimEpoch) ||
    state.sessionId !== sessionId ||
    state.claimEpoch !== claimEpoch ||
    typeof state.capability !== 'string' ||
    state.capability.length < 32
  ) {
    return false;
  }
  return typeof deviceId === 'string' && state.deviceId === deviceId;
}

export function shouldReapAndroidRunnerBeforeStart(
  state: AndroidRunnerState | null,
  deviceId: string,
  isAvailable: boolean,
): boolean {
  return isAvailable && !shouldReuseAndroidRunner(state, deviceId);
}

/**
 * GH#243: HTTP-truthful readiness. The runner logs RN_ANDROID_RUNNER_LISTENER_READY,
 * but `adb logcat` replays the ring buffer — a prior runner's ready line (same tag +
 * fixed port) fired readiness before the new ServerSocket bound, so the first
 * post-flow POST /command hit a dead port ("fetch failed"). Poll the runner's own
 * GET /health, which is true only once the socket is accepting. Bounded by timeoutMs
 * (defaults to the cold-start ready budget); returns false on timeout.
 */
export async function waitForAndroidRunnerHealth(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; capability?: string } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HEALTH_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      const capability =
        opts.capability ?? (runnerState?.hostPort === port ? runnerState.capability : undefined);
      const resp = await cancellableFetch(fetchImpl, `http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
        headers: capability ? { authorization: `Bearer ${capability}` } : {},
      });
      if (resp.ok) {
        const body = (await resp.json()) as { ok?: boolean };
        if (body?.ok === true) return true;
      }
    } catch (error) {
      cancellationSignal();
      if (isAbort(error) && !controller.signal.aborted) throw error;
      // server not accepting yet — keep polling
    } finally {
      clearTimeout(timer);
    }
    await sleep(intervalMs);
  }
  return false;
}

export interface AndroidHealthInfo {
  reachable: boolean;
  ok?: boolean;
  protocolVersion?: number;
  runnerVersion?: string;
  capabilities?: string[];
  commands?: string[];
  instanceId?: string;
  sessionId?: string;
  claimEpoch?: number;
  deviceId?: string;
  appId?: string;
}

export function androidHealthMatchesAuthority(
  info: AndroidHealthInfo,
  expected: Pick<
    AndroidHealthInfo,
    'instanceId' | 'sessionId' | 'claimEpoch' | 'deviceId' | 'appId'
  >,
): boolean {
  return (
    info.instanceId === expected.instanceId &&
    info.sessionId === expected.sessionId &&
    info.claimEpoch === expected.claimEpoch &&
    info.deviceId === expected.deviceId &&
    info.appId === expected.appId
  );
}

// Story 04 (#385): capabilities from the last successful /health probe. Warm
// before any mutating verb — startAndroidRunner probes /health on the reuse
// and readiness paths. Consumed by the settle engine.
let lastKnownCapabilities: string[] = [];

export function getAndroidRunnerCapabilities(): string[] {
  return lastKnownCapabilities;
}

export function _resetCapabilitiesForTest(): void {
  lastKnownCapabilities = [];
}

export async function probeAndroidRunnerHealthInfo(
  port: number,
  capabilityOverride?: string,
): Promise<AndroidHealthInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const capability =
      capabilityOverride ?? (runnerState?.hostPort === port ? runnerState.capability : undefined);
    const resp = await cancellableFetch(fetchImpl, `http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      headers: capability ? { authorization: `Bearer ${capability}` } : {},
    });
    if (!resp.ok) return { reachable: false };
    const body = (await resp.json()) as {
      ok?: boolean;
      protocolVersion?: number;
      runnerVersion?: string;
      capabilities?: unknown;
      commands?: unknown;
      instanceId?: string;
      sessionId?: string;
      claimEpoch?: number;
      deviceId?: string;
      appId?: string;
    };
    const capabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined;
    // Cache scope: a healthy reply refreshes; an unhealthy reply only clears
    // when it came from the LIVE runner's port — probing a stale/foreign port
    // must not erase capabilities learned from the live runner.
    if (body.ok === true) {
      lastKnownCapabilities = capabilities ?? [];
    } else if (runnerState?.hostPort === port) {
      lastKnownCapabilities = [];
    }
    const testIdentity = testAuthorityState && runnerState?.hostPort === port ? runnerState : null;
    return {
      reachable: true,
      ok: body.ok === true,
      ...(typeof body.protocolVersion === 'number'
        ? { protocolVersion: body.protocolVersion }
        : {}),
      ...(typeof body.runnerVersion === 'string' ? { runnerVersion: body.runnerVersion } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(Array.isArray(body.commands)
        ? { commands: body.commands.filter((c): c is string => typeof c === 'string') }
        : {}),
      ...(typeof body.instanceId === 'string'
        ? { instanceId: body.instanceId }
        : testIdentity?.instanceId
          ? { instanceId: testIdentity.instanceId }
          : {}),
      ...(typeof body.sessionId === 'string'
        ? { sessionId: body.sessionId }
        : testIdentity?.sessionId
          ? { sessionId: testIdentity.sessionId }
          : {}),
      ...(typeof body.claimEpoch === 'number'
        ? { claimEpoch: body.claimEpoch }
        : typeof testIdentity?.claimEpoch === 'number'
          ? { claimEpoch: testIdentity.claimEpoch }
          : {}),
      ...(typeof body.deviceId === 'string'
        ? { deviceId: body.deviceId }
        : testIdentity?.deviceId
          ? { deviceId: testIdentity.deviceId }
          : {}),
      ...(typeof body.appId === 'string'
        ? { appId: body.appId }
        : testIdentity?.bundleId
          ? { appId: testIdentity.bundleId }
          : {}),
    };
  } catch {
    throwIfCancelled();
    if (runnerState?.hostPort === port) lastKnownCapabilities = [];
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

// GH #383: set when a mismatched runner was transparently reaped; consumed by
// runNative so the triggering tool result carries meta.note. MUST be cleared
// on the mismatch-reject path too (review amendment) or a later successful
// call would attach a stale "runner upgraded" note.
let pendingUpgradeNote: string | undefined;

export function consumePendingAndroidUpgradeNote(): string | undefined {
  const note = pendingUpgradeNote;
  pendingUpgradeNote = undefined;
  return note;
}

// Review amendment (BLOCKER): a single `am force-stop` of the app package does
// NOT reliably free the device-side UiAutomation slot (#237 — system_server
// keeps it; see release-android-slot.ts:115-128). Reuse the battle-tested
// helper, which stops our runner then force-stops BOTH owned packages.
// Dynamic import because release-android-slot.ts statically imports this
// module — a static back-import would be a cycle.
export async function reapMismatchedAndroidRunner(
  state: { deviceId?: string; hostPort?: number; devicePort?: number } | null,
  release?: (opts: { deviceId: string; includeLegacy?: boolean }) => Promise<{
    stoppedOwnRunner: boolean;
    forceStoppedPackages: string[];
  }>,
  verify?: (
    state: { deviceId: string; hostPort?: number; devicePort?: number },
    signal?: AbortSignal,
  ) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  const deviceId = state?.deviceId;
  if (!deviceId) {
    throw new Error(
      'RUNNER_CLEANUP_UNCONFIRMED: stale Android runner has no recorded device identity',
    );
  }
  const releaseSlot =
    release ??
    (async (opts: { deviceId: string }) => {
      const { releaseAndroidInteractionSlot } = await import('./release-android-slot.js');
      return releaseAndroidInteractionSlot({ ...opts, signal });
    });
  const receipt = await releaseSlot({ deviceId, includeLegacy: false });
  throwIfCancelled(signal);
  const requiredPackages = [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ];
  const missingPackages = requiredPackages.filter(
    (pkg) => !receipt.forceStoppedPackages.includes(pkg),
  );
  if (!receipt.stoppedOwnRunner || missingPackages.length > 0) {
    throw new Error(
      `RUNNER_CLEANUP_UNCONFIRMED: stale Android runner cleanup failed for ${deviceId}`,
    );
  }
  const verifyReleased =
    verify ??
    (release
      ? async () => {}
      : async (expected: { deviceId: string; hostPort?: number; devicePort?: number }) => {
          const forwards = String(
            (
              await execFileAsync('adb', ['forward', '--list'], {
                timeout: ADB_CLEANUP_TIMEOUT_MS,
                signal,
              })
            ).stdout,
          );
          const processes = String(
            (
              await execFileAsync(
                'adb',
                [
                  '-s',
                  expected.deviceId,
                  'shell',
                  'dumpsys',
                  'activity',
                  'processes',
                  'dev.lykhoyda.rndevagent.androidrunner',
                ],
                {
                  timeout: ADB_CLEANUP_TIMEOUT_MS,
                  signal,
                },
              )
            ).stdout,
          );
          const forwardRemains = forwards
            .split('\n')
            .filter((line) => line.startsWith(`${expected.deviceId} `))
            .some((line) => {
              if (expected.hostPort !== undefined && line.includes(`tcp:${expected.hostPort}`)) {
                return true;
              }
              return line.includes(`tcp:${expected.devicePort ?? DEFAULT_PORT}`);
            });
          if (forwardRemains || androidRunnerProcessListed(processes) !== false) {
            throw new Error(
              `RUNNER_CLEANUP_UNCONFIRMED: Android runner resources remain for ${expected.deviceId}`,
            );
          }
        });
  await verifyReleased(
    {
      deviceId,
      ...(state?.hostPort !== undefined ? { hostPort: state.hostPort } : {}),
      ...(state?.devicePort !== undefined ? { devicePort: state.devicePort } : {}),
    },
    signal,
  );
  throwIfCancelled(signal);
}

export async function reapActiveAndroidRunner(deviceId?: string): Promise<void> {
  adoptPersistedAndroidState(deviceId);
  await reapMismatchedAndroidRunner(runnerState ?? (deviceId ? { deviceId } : null));
}

export function classifyAndroidHealth(info: AndroidHealthInfo) {
  return classifyRunnerCompatibility(
    {
      ...(info.protocolVersion !== undefined ? { protocolVersion: info.protocolVersion } : {}),
      ...(info.runnerVersion !== undefined ? { runnerVersion: info.runnerVersion } : {}),
      ...(info.commands !== undefined ? { commands: info.commands } : {}),
      ...(info.capabilities !== undefined ? { capabilities: info.capabilities } : {}),
    },
    getPluginVersion(),
    REQUIRED_ANDROID_COMMANDS,
    REQUIRED_ANDROID_FEATURES,
  );
}

// GH #418: mid-flow refusal + retry-once signal. The message prefix is the
// wire contract — device-session.ts and agent-device-wrapper.ts map it to the
// RUNNER_COMMANDS_STALE ToolErrorCode by startsWith, mirroring
// RUNNER_PROTOCOL_MISMATCH.
export class AndroidCommandsStaleError extends Error {
  constructor(
    readonly missing: string[],
    readonly bundleId?: string,
    readonly deviceId?: string,
    detail?: string,
  ) {
    super(
      `RUNNER_COMMANDS_STALE: ${
        detail ??
        `installed rn-android-runner lacks required commands ` +
          `(missing: ${missing.join(', ') || 'unknown'}). Re-open the device session ` +
          `(device_snapshot action=open appId=${bundleId ?? '<your.app.id>'} platform=android) to rebuild it.`
      }`,
    );
  }
}

export class AndroidAuthorityStaleError extends Error {
  constructor(
    readonly deviceId?: string,
    detail?: string,
  ) {
    super(
      `RUNNER_OWNERSHIP_MISMATCH: ${
        detail ?? 'installed Android runner lacks current authority identity'
      }`,
    );
  }
}

export interface AndroidRunnerRebuildLock {
  ownerNonce: string;
  pluginVersion: string;
}

export type AndroidRunnerRebuildClaim =
  | { status: 'acquired'; lock: AndroidRunnerRebuildLock }
  | { status: 'busy' | 'exhausted' };

function initializeAndroidRunnerRebuildState(databasePath: string) {
  const store = openAuthorityStore(databasePath);
  try {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS android_runner_rebuild_attempt (
        lock_name TEXT PRIMARY KEY,
        plugin_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'failed')),
        owner_nonce TEXT,
        lease_ms INTEGER NOT NULL,
        cleanup_unverified INTEGER NOT NULL DEFAULT 0
      )
    `);
    const columns = store.database
      .prepare(`PRAGMA table_info(android_runner_rebuild_attempt)`)
      .all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === 'cleanup_unverified')) {
      store.database.exec(
        `ALTER TABLE android_runner_rebuild_attempt
         ADD COLUMN cleanup_unverified INTEGER NOT NULL DEFAULT 0`,
      );
    }
    return store;
  } catch (cause) {
    try {
      store.close();
    } catch {}
    throw cause;
  }
}

export function acquireAndroidRunnerRebuildLock(
  pluginVersion: string,
  now = Date.now(),
  ownerNonce = randomUUID(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): AndroidRunnerRebuildClaim {
  try {
    const store = initializeAndroidRunnerRebuildState(databasePath);
    try {
      const claimed = store.database
        .prepare(
          `INSERT INTO android_runner_rebuild_attempt(
             lock_name, plugin_version, status, owner_nonce, lease_ms, cleanup_unverified
           )
           VALUES ('artifact', ?, 'in_progress', ?, ?, 0)
           ON CONFLICT(lock_name) DO UPDATE SET
             plugin_version = excluded.plugin_version,
             status = 'in_progress',
             owner_nonce = excluded.owner_nonce,
             lease_ms = excluded.lease_ms,
             cleanup_unverified = 0
           WHERE
             (
               android_runner_rebuild_attempt.status != 'in_progress'
               AND android_runner_rebuild_attempt.plugin_version != excluded.plugin_version
               AND android_runner_rebuild_attempt.cleanup_unverified = 0
             )
             OR (
               android_runner_rebuild_attempt.status = 'in_progress'
               AND android_runner_rebuild_attempt.lease_ms <= ?
               AND android_runner_rebuild_attempt.cleanup_unverified = 0
             )
           RETURNING owner_nonce, plugin_version`,
        )
        .get(pluginVersion, ownerNonce, now, now - ANDROID_REBUILD_LOCK_STALE_MS);
      store.secureFiles();
      if (claimed?.owner_nonce === ownerNonce && claimed.plugin_version === pluginVersion) {
        return { status: 'acquired', lock: { ownerNonce, pluginVersion } };
      }
      const current = store.database
        .prepare(
          `SELECT plugin_version, status
           FROM android_runner_rebuild_attempt
           WHERE lock_name = 'artifact'`,
        )
        .get();
      return current?.plugin_version === pluginVersion && current.status !== 'in_progress'
        ? { status: 'exhausted' }
        : { status: 'busy' };
    } finally {
      store.close();
    }
  } catch {
    return { status: 'busy' };
  }
}

export function heartbeatAndroidRunnerRebuildLock(
  lock: AndroidRunnerRebuildLock,
  now = Date.now(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): boolean {
  try {
    const store = initializeAndroidRunnerRebuildState(databasePath);
    try {
      const refreshed = store.database
        .prepare(
          `UPDATE android_runner_rebuild_attempt
           SET lease_ms = ?
           WHERE lock_name = 'artifact'
             AND plugin_version = ?
             AND status = 'in_progress'
             AND owner_nonce = ?`,
        )
        .run(now, lock.pluginVersion, lock.ownerNonce) as { changes: number };
      store.secureFiles();
      return refreshed.changes === 1;
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

function finishAndroidRunnerRebuildLock(
  lock: AndroidRunnerRebuildLock,
  status: 'completed' | 'failed',
  cleanupUnverified: boolean,
  now = Date.now(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): boolean {
  try {
    const store = initializeAndroidRunnerRebuildState(databasePath);
    try {
      const finished = store.database
        .prepare(
          `UPDATE android_runner_rebuild_attempt
           SET status = ?, owner_nonce = NULL, lease_ms = ?, cleanup_unverified = ?
           WHERE lock_name = 'artifact'
             AND plugin_version = ?
             AND status = 'in_progress'
             AND (cleanup_unverified = 0 OR ? = 1)
             AND owner_nonce = ?`,
        )
        .run(
          status,
          now,
          cleanupUnverified ? 1 : 0,
          lock.pluginVersion,
          status === 'failed' ? 1 : 0,
          lock.ownerNonce,
        ) as { changes: number };
      store.secureFiles();
      return finished.changes === 1;
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

export function completeAndroidRunnerRebuildLock(
  lock: AndroidRunnerRebuildLock,
  now = Date.now(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): boolean {
  return finishAndroidRunnerRebuildLock(lock, 'completed', false, now, databasePath);
}

export function releaseAndroidRunnerRebuildLock(
  lock: AndroidRunnerRebuildLock,
  now = Date.now(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): boolean {
  return finishAndroidRunnerRebuildLock(lock, 'failed', false, now, databasePath);
}

export function beginAndroidRunnerRebuildCleanup(
  lock: AndroidRunnerRebuildLock,
  now = Date.now(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): boolean {
  try {
    const store = initializeAndroidRunnerRebuildState(databasePath);
    try {
      const fenced = store.database
        .prepare(
          `UPDATE android_runner_rebuild_attempt
           SET cleanup_unverified = 1, lease_ms = ?
           WHERE lock_name = 'artifact'
             AND plugin_version = ?
             AND status = 'in_progress'
             AND cleanup_unverified = 0
             AND owner_nonce = ?`,
        )
        .run(now, lock.pluginVersion, lock.ownerNonce) as { changes: number };
      store.secureFiles();
      return fenced.changes === 1;
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

export function markAndroidRunnerRebuildCleanupUnverified(
  lock: AndroidRunnerRebuildLock,
  now = Date.now(),
  databasePath = ANDROID_REBUILD_LOCK_DATABASE,
): boolean {
  return finishAndroidRunnerRebuildLock(lock, 'failed', true, now, databasePath);
}

interface AndroidRunnerRebuildDependencies {
  acquire?: (pluginVersion: string) => AndroidRunnerRebuildClaim;
  heartbeat?: (lock: AndroidRunnerRebuildLock) => boolean;
  complete?: (lock: AndroidRunnerRebuildLock) => boolean;
  beginCleanup?: (lock: AndroidRunnerRebuildLock) => boolean;
  release?: (lock: AndroidRunnerRebuildLock) => boolean;
  markCleanupUnverified?: (lock: AndroidRunnerRebuildLock) => boolean;
  heartbeatIntervalMs?: number;
  completionRetryIntervalMs?: number;
  completionAttempts?: number;
  cleanupTimeoutMs?: number;
}

function androidRebuildRefusal(
  error: AndroidAuthorityStaleError | AndroidCommandsStaleError,
  detail: string,
): AndroidAuthorityStaleError | AndroidCommandsStaleError {
  return error instanceof AndroidAuthorityStaleError
    ? new AndroidAuthorityStaleError(error.deviceId, detail)
    : new AndroidCommandsStaleError(error.missing, error.bundleId, error.deviceId, detail);
}

export async function runBoundedAndroidRunnerRebuild<T>(
  error: AndroidAuthorityStaleError | AndroidCommandsStaleError,
  rebuild: (signal: AbortSignal) => Promise<T>,
  cleanup: (signal: AbortSignal) => Promise<void>,
  dependencies: AndroidRunnerRebuildDependencies = {},
): Promise<T> {
  throwIfCancelled();
  const pluginVersion = getPluginVersion() ?? 'unknown';
  const acquire = dependencies.acquire ?? acquireAndroidRunnerRebuildLock;
  const claim = acquire(pluginVersion);
  if (claim.status !== 'acquired') {
    throw androidRebuildRefusal(
      error,
      claim.status === 'exhausted'
        ? `runner artifact was already rebuilt once for plugin v${pluginVersion}`
        : 'another session is rebuilding the shared runner artifact',
    );
  }
  const { lock } = claim;
  const heartbeat = dependencies.heartbeat ?? heartbeatAndroidRunnerRebuildLock;
  const complete = dependencies.complete ?? completeAndroidRunnerRebuildLock;
  const beginCleanup = dependencies.beginCleanup ?? beginAndroidRunnerRebuildCleanup;
  const release = dependencies.release ?? releaseAndroidRunnerRebuildLock;
  const markCleanupUnverified =
    dependencies.markCleanupUnverified ?? markAndroidRunnerRebuildCleanupUnverified;
  const controller = new AbortController();
  let cleanupController: AbortController | undefined;
  let leaseAuthorityLost = false;
  const authorityLost = () => {
    if (leaseAuthorityLost) return;
    leaseAuthorityLost = true;
    const refusal = androidRebuildRefusal(error, 'runner artifact rebuild authority was lost');
    if (!controller.signal.aborted) controller.abort(refusal);
    if (cleanupController && !cleanupController.signal.aborted) cleanupController.abort(refusal);
  };
  const refreshAuthority = () => {
    try {
      if (heartbeat(lock)) return true;
    } catch {}
    authorityLost();
    return false;
  };
  const heartbeatTimer = setInterval(() => {
    try {
      if (!heartbeat(lock)) authorityLost();
    } catch {
      authorityLost();
    }
  }, dependencies.heartbeatIntervalMs ?? ANDROID_REBUILD_HEARTBEAT_MS);
  const transitionAttempts = Math.max(
    1,
    dependencies.completionAttempts ?? ANDROID_REBUILD_COMPLETION_ATTEMPTS,
  );
  const persistTransition = async (transition: (lock: AndroidRunnerRebuildLock) => boolean) => {
    for (let attempt = 0; attempt < transitionAttempts; attempt += 1) {
      if (leaseAuthorityLost) return false;
      try {
        if (transition(lock)) return true;
      } catch {}
      if (!refreshAuthority()) return false;
      if (attempt + 1 < transitionAttempts) {
        await new Promise<void>((resolve) => {
          setTimeout(
            resolve,
            dependencies.completionRetryIntervalMs ?? ANDROID_REBUILD_COMPLETION_RETRY_MS,
          );
        });
      }
    }
    return false;
  };
  try {
    const result = await rebuild(controller.signal);
    throwIfCancelled(controller.signal);
    for (let attempt = 0; attempt < transitionAttempts; attempt += 1) {
      throwIfCancelled(controller.signal);
      try {
        if (complete(lock)) {
          throwIfCancelled(controller.signal);
          clearInterval(heartbeatTimer);
          return result;
        }
      } catch {
        throwIfCancelled(controller.signal);
      }
      if (attempt + 1 < transitionAttempts) {
        await sleep(
          dependencies.completionRetryIntervalMs ?? ANDROID_REBUILD_COMPLETION_RETRY_MS,
          controller.signal,
        );
      }
    }
    if (!controller.signal.aborted) {
      controller.abort(
        androidRebuildRefusal(error, 'runner artifact rebuild completion was not durable'),
      );
    }
    throwIfCancelled(controller.signal);
    throw androidRebuildRefusal(error, 'runner artifact rebuild completion was not durable');
  } catch (cause) {
    if (leaseAuthorityLost) {
      clearInterval(heartbeatTimer);
      throw controller.signal.reason;
    }
    if (!(await persistTransition(beginCleanup))) {
      clearInterval(heartbeatTimer);
      throw leaseAuthorityLost
        ? controller.signal.reason
        : androidRebuildRefusal(error, 'runner artifact cleanup fence was not durable');
    }
    cleanupController = new AbortController();
    const cleanupTimer = setTimeout(
      () =>
        cleanupController?.abort(
          androidRebuildRefusal(error, 'runner artifact cleanup exceeded its time limit'),
        ),
      dependencies.cleanupTimeoutMs ?? ANDROID_REBUILD_CLEANUP_TIMEOUT_MS,
    );
    let cleanupVerified = false;
    try {
      await withCancellation(undefined, () => cleanup(cleanupController!.signal));
      cleanupController.signal.throwIfAborted();
      cleanupVerified = true;
    } catch {}
    clearTimeout(cleanupTimer);
    cleanupController = undefined;
    const terminalPersisted = await persistTransition(
      cleanupVerified ? release : markCleanupUnverified,
    );
    clearInterval(heartbeatTimer);
    if (!terminalPersisted) {
      throw leaseAuthorityLost
        ? controller.signal.reason
        : androidRebuildRefusal(error, 'runner artifact failure state was not durable');
    }
    if (!cleanupVerified) {
      throw androidRebuildRefusal(error, 'runner artifact cleanup could not be verified');
    }
    throw controller.signal.aborted ? controller.signal.reason : cause;
  }
}

export function androidRetryCleanupContext(
  state: { deviceId?: string } | null,
  error: AndroidAuthorityStaleError | AndroidCommandsStaleError,
): { deviceId?: string } | null {
  return state ?? (error.deviceId ? { deviceId: error.deviceId } : null);
}

// GH #418: deleting the APKs invalidates Gradle's outputs. Provisioning refreshes
// these same files before installed-byte selection, so the retry cannot choose
// the invalidated build.
const RUNNER_APK_PATHS = [APK_APP, APK_TEST] as const;

export function androidRunnerApksExist(): boolean {
  return RUNNER_APK_PATHS.every((p) => existsSync(p));
}

export function _androidRunnerApkPathsForTest(): readonly string[] {
  return RUNNER_APK_PATHS;
}

export async function invalidateAndroidRunnerApks(
  rm: (path: string) => void = (p) => rmSync(p, { force: true }),
  signal?: AbortSignal,
): Promise<void> {
  await withAndroidRunnerApkLock(
    ANDROID_APK_LOCK,
    async () => {
      for (const apk of RUNNER_APK_PATHS) {
        throwIfCancelled(signal);
        try {
          rm(apk);
        } catch {
          /* best-effort; the install action check re-reads existsSync */
        }
      }
    },
    { signal },
  );
}

export interface StartAndroidRunnerOpts {
  /** GH #418: open-path only — permits APK invalidation + Gradle rebuild. */
  allowArtifactRebuild?: boolean;
  /** Internal: set by the rebuild retry so the install action can't 'reuse'. */
  _forceReinstall?: boolean;
  _rebuildSignal?: AbortSignal;
}

// GH #418: retry-once wrapper for the fresh-open case — the attempt spawns the
// stale installed APK, the post-install verify throws the typed error, and (at
// open only) we invalidate the APKs so the retry Gradle-rebuilds from source.
export async function startAndroidRunner(
  deviceId?: string,
  bundleId?: string,
  devicePort = DEFAULT_PORT,
  opts: StartAndroidRunnerOpts = {},
): Promise<AndroidRunnerState> {
  try {
    return await startAndroidRunnerAttempt(deviceId, bundleId, devicePort, opts);
  } catch (err) {
    throwIfCancelled(opts._rebuildSignal);
    if (isAbort(err)) throw err;
    if (opts.allowArtifactRebuild && err instanceof AndroidAuthorityStaleError) {
      const state = await runBoundedAndroidRunnerRebuild(
        err,
        async (signal) => {
          await reapMismatchedAndroidRunner(
            androidRetryCleanupContext(runnerState, err),
            undefined,
            undefined,
            signal,
          );
          signal.throwIfAborted();
          await invalidateAndroidRunnerApks(undefined, signal);
          return startAndroidRunnerAttempt(deviceId, bundleId, devicePort, {
            _forceReinstall: true,
            _rebuildSignal: signal,
          });
        },
        async (signal) => {
          await reapMismatchedAndroidRunner(
            androidRetryCleanupContext(runnerState, err),
            undefined,
            undefined,
            signal,
          );
        },
      );
      throwIfCancelled();
      pendingUpgradeNote = 'runner artifact rebuilt (authority identity mismatch)';
      return state;
    }
    if (opts.allowArtifactRebuild && err instanceof AndroidCommandsStaleError) {
      // Killing the local adb child does NOT free the device-side
      // UiAutomation slot (#237) — reap through the slot-release path so the
      // rebuilt instrumentation can bind.
      const state = await runBoundedAndroidRunnerRebuild(
        err,
        async (signal) => {
          await reapMismatchedAndroidRunner(
            androidRetryCleanupContext(runnerState, err),
            undefined,
            undefined,
            signal,
          );
          signal.throwIfAborted();
          await invalidateAndroidRunnerApks(undefined, signal);
          return startAndroidRunnerAttempt(deviceId, bundleId, devicePort, {
            _forceReinstall: true,
            _rebuildSignal: signal,
          });
        },
        async (signal) => {
          await reapMismatchedAndroidRunner(
            androidRetryCleanupContext(runnerState, err),
            undefined,
            undefined,
            signal,
          );
        },
      );
      throwIfCancelled();
      pendingUpgradeNote = `runner artifact rebuilt (missing commands: ${err.missing.join(', ') || 'unknown'})`;
      return state;
    }
    throw err;
  }
}

async function startAndroidRunnerAttempt(
  deviceId?: string,
  bundleId?: string,
  devicePort = DEFAULT_PORT,
  opts: StartAndroidRunnerOpts = {},
): Promise<AndroidRunnerState> {
  throwIfCancelled(opts._rebuildSignal);
  const serial =
    deviceId ??
    (testAuthorityState ? runnerState?.deviceId : undefined) ??
    (await resolveAndroidSerial());
  if (!serial) {
    throw new Error(
      'DEVICE_AUTHORITY_MISMATCH: Android native runner requires an exact claimed device',
    );
  }
  const authority = androidRunnerAuthority(serial, bundleId ?? '');
  adoptPersistedAndroidState(serial);
  let forceReinstall = opts._forceReinstall === true;
  if (shouldReapAndroidRunnerBeforeStart(runnerState, serial, isAndroidRunnerAvailable())) {
    await reapMismatchedAndroidRunner(runnerState);
    forceReinstall = true;
  }
  if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, serial)) {
    const reusableState = runnerState!;
    const info = await probeAndroidRunnerHealthInfo(runnerState!.hostPort);
    if (info.reachable && info.ok) {
      if (
        !androidHealthMatchesAuthority(info, {
          instanceId: runnerState!.instanceId,
          sessionId: runnerState!.sessionId,
          claimEpoch: runnerState!.claimEpoch,
          deviceId: runnerState!.deviceId,
          appId: runnerState!.bundleId,
        })
      ) {
        await reapMismatchedAndroidRunner(reusableState);
        forceReinstall = true;
      } else {
        const compat = classifyAndroidHealth(info);
        if (compat.compatible) return runnerState!;
        if (compat.reason === 'missing-commands' || compat.reason === 'missing-features') {
          throw new AndroidCommandsStaleError(
            compat.missing ?? [],
            bundleId,
            reusableState.deviceId,
          );
        }
        // GH #383: a reachable-but-incompatible runner is reaped (force-stop +
        // state clear) and force-reinstalled so the fresh APK supersedes it.
        throwIfCancelled();
        pendingUpgradeNote = 'runner upgraded (protocol/version mismatch)';
        forceReinstall = true;
        await reapMismatchedAndroidRunner(reusableState);
      }
    } else {
      await reapMismatchedAndroidRunner(reusableState);
      forceReinstall = true;
    }
  }

  throwIfCancelled(opts._rebuildSignal);
  // Refresh the shipped-source build and select the installed pair by its bytes.
  const provenance = await ensureAndroidRunnerInstalled(deviceId, {
    forceReinstall,
    signal: opts._rebuildSignal,
  });

  let hostPort = await withCancellation(cancellationSignal(opts._rebuildSignal), () =>
    findFreePort(devicePort),
  );
  throwIfCancelled(opts._rebuildSignal);
  try {
    await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort), {
      signal: opts._rebuildSignal,
    });
  } catch (error) {
    throwIfCancelled(opts._rebuildSignal);
    if (isAbort(error)) throw error;
    // host port raced between probe and forward → re-probe once with any free port
    hostPort = await withCancellation(cancellationSignal(opts._rebuildSignal), () =>
      findFreePort(0),
    );
    await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort), {
      signal: opts._rebuildSignal,
    });
  }

  const signal = cancellationSignal(opts._rebuildSignal);
  return new Promise((resolve, reject) => {
    let resolved = false;
    let forwardRemoved = false;
    const removeForward = () => {
      if (forwardRemoved) return;
      forwardRemoved = true;
      void withCancellation(undefined, () =>
        execFileAsync('adb', buildAdbForwardRemoveArgs(serial, hostPort)),
      ).catch(() => {});
    };

    const child = spawn(
      'adb',
      [
        ...adbSerialArgs(deviceId),
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        ...buildInstrumentPortArgs(devicePort),
        ...buildInstrumentVersionArgs(getPluginVersion()),
        ...buildInstrumentAuthorityArgs(authority),
        '-e',
        'class',
        MAIN_LOOP_CLASS,
        INSTRUMENTATION,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: opts._rebuildSignal,
      },
    );

    runnerProcess = child;

    // GH#243: drain + tail the instrument's own output so a cold-start failure stays
    // debuggable now that logcat is gone, and so an unconsumed stdio:'pipe' can't fill
    // its ~64KB buffer and wedge the child.
    let diag = '';
    const capture = (chunk: Buffer) => {
      diag = currentInputs()?.hasInputs
        ? '[private output withheld]'
        : (diag + chunk.toString('utf-8')).slice(-4_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const finishReady = () => {
      if (resolved) return;
      if (signal?.aborted) {
        resolved = true;
        reject(signal.reason);
        return;
      }
      resolved = true;
      const state: AndroidRunnerState = {
        schemaVersion: 1,
        hostPort,
        devicePort,
        pid: child.pid!,
        ...(serial ? { deviceId: serial } : {}),
        ...(bundleId ? { bundleId } : {}),
        startedAt: new Date().toISOString(),
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion()! } : {}),
        provenance,
        ...authority,
      };
      const processBirth = readProcessBirth(child.pid!);
      if (!processBirth) {
        child.kill('SIGTERM');
        reject(
          new Error(
            'PROCESS_BIRTH_UNAVAILABLE: native runner process identity could not be proven',
          ),
        );
        return;
      }
      state.processBirth = processBirth.token;
      runnerState = state;
      if (serial) {
        try {
          writeJsonStateFileAtomic(androidStatePath(serial), state);
        } catch {
          /* non-fatal */
        }
      }
      cleanupLegacyTmpState();
      resolve(state);
    };

    child.on('error', (err) => {
      removeForward();
      if (resolved) return;
      resolved = true;
      reject(
        isAbort(err)
          ? err
          : new Error(`Failed to spawn Android runner instrumentation: ${err.message}`),
      );
    });

    child.on('exit', (code) => {
      if (runnerProcess === child) {
        clearAndroidStateFile();
      }
      removeForward();
      if (!resolved) {
        resolved = true;
        reject(
          new Error(
            `Android runner instrumentation exited before readiness (code ${code})${diag ? `\n${diag.trim()}` : ''}`,
          ),
        );
      }
    });

    // GH#243: readiness is the runner's own /health, not the (stale-prone) logcat
    // ring buffer. /health is true only once the ServerSocket is actually accepting.
    void withCancellation(signal, async () => {
      const healthy = await waitForAndroidRunnerHealth(hostPort, {
        capability: authority.capability,
      });
      if (resolved) return;
      throwIfCancelled(signal);
      if (healthy) {
        const info = await probeAndroidRunnerHealthInfo(hostPort, authority.capability);
        if (resolved) return;
        throwIfCancelled(signal);
        if (
          !androidHealthMatchesAuthority(info, {
            instanceId: authority.instanceId,
            sessionId: authority.sessionId,
            claimEpoch: authority.claimEpoch,
            deviceId: authority.deviceId,
            appId: authority.appId,
          })
        ) {
          resolved = true;
          child.kill('SIGTERM');
          reject(new AndroidAuthorityStaleError(serial));
          return;
        }
        const compat = classifyAndroidHealth(info);
        if (!compat.compatible) {
          resolved = true;
          pendingUpgradeNote = undefined; // review amendment: never report an upgrade that failed
          child.kill('SIGTERM');
          if (compat.reason === 'missing-commands' || compat.reason === 'missing-features') {
            reject(new AndroidCommandsStaleError(compat.missing ?? [], bundleId, serial));
            return;
          }
          reject(
            new Error(
              `RUNNER_PROTOCOL_MISMATCH: installed rn-android-runner speaks protocol ` +
                `${info.protocolVersion ?? 'none'} (bridge expects ${RUNNER_PROTOCOL_VERSION}). ` +
                `Rebuild + reinstall the runner APKs: cd ${RN_ANDROID_RUNNER_DIR} && ` +
                `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest, then adb install -r both APKs.`,
            ),
          );
          return;
        }
        finishReady();
        return;
      }
      resolved = true;
      child.kill('SIGTERM');
      reject(
        new Error(
          `Android runner did not become ready within ${READY_TIMEOUT_MS / 1000}s (no /health on port ${hostPort})${diag ? `\n${diag.trim()}` : ''}`,
        ),
      );
    }).catch((error: unknown) => {
      removeForward();
      if (resolved) return;
      resolved = true;
      if (!signal?.aborted && !isAbort(error)) child.kill('SIGTERM');
      reject(error);
    });
  });
}

export async function stopAndroidRunner(deviceId?: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  // GH #383 (review amendment): adopt first so a post-respawn stop finds the
  // persisted runner (empty in-memory state would otherwise leak the forward).
  adoptPersistedAndroidState(deviceId ?? undefined);
  const stoppedState = runnerState;
  runnerProcess?.kill('SIGTERM');
  clearAndroidStateFile();
  if (typeof stoppedState?.hostPort === 'number') {
    const resolvedDeviceId = deviceId ?? stoppedState.deviceId;
    try {
      await execFileAsync(
        'adb',
        buildAdbForwardRemoveArgs(resolvedDeviceId, stoppedState.hostPort),
        { timeout: ADB_CLEANUP_TIMEOUT_MS, signal },
      );
    } catch {
      /* non-fatal */
    }
  }
}

// type/snapshot/screenshot run long; everything else is fast. Hoisted out of the
// old inline postCommand so the recovery wrapper reuses the exact same budget for
// both the original send and the resend (mirrors the iOS commandTimeoutMs helper).
// A tap that may wait for its keyboard gets that wait on top, so the wait never reads as a timeout.
function commandTimeoutMs(body: { command?: unknown; keyboardWaitMs?: unknown }): number {
  const { command, keyboardWaitMs } = body;
  const base =
    command === 'type' || command === 'snapshot' || command === 'screenshot' ? 35_000 : 10_000;
  return command === 'tap' && typeof keyboardWaitMs === 'number' ? base + keyboardWaitMs : base;
}

// One /command round-trip with no recovery. Bounds the request so a wedged
// UIAutomator instrument can't hang the tool indefinitely. The AbortError→
// RUNNER_TIMEOUT map, the non-JSON-body error (AMBIGUOUS — a reply arrived but
// was garbled, so the command may have executed), and the /command v-stamp check
// all live here so postCommandWithRecovery's catch wraps them.
async function sendCommandOnce(
  hostPort: number,
  body: { command?: unknown; commandId?: string },
  timeoutMs: number,
  qaContext?: QaDispatchContext,
): Promise<RunnerResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    const capability = runnerState?.hostPort === hostPort ? runnerState.capability : undefined;
    if (!capability) {
      throw new Error('RUNNER_OWNERSHIP_MISMATCH: runner capability is unavailable');
    }
    const serialized = JSON.stringify(body);
    if (isMutatingCommand(body.command)) qaContext?.authorize();
    resp = await cancellableFetch(fetchImpl, `http://127.0.0.1:${hostPort}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        authorization: `Bearer ${capability}`,
      },
      body: serialized,
      signal: controller.signal,
    });
  } catch (err) {
    throwIfCancelled();
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      throw new Error(
        `RUNNER_TIMEOUT: rn-android-runner did not respond to "${String(body.command)}" within ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let parsed: RunnerResponse;
  try {
    parsed = (await resp.json()) as RunnerResponse;
  } catch {
    throwIfCancelled();
    throw new Error('rn-android-runner returned a non-JSON response body');
  }
  // GH #383: mirror the iOS /command v-stamp check — a runner hot-swapped to an
  // incompatible wire protocol mid-session is caught here (the reuse gate only
  // runs at start). runAndroid's catch maps this BEFORE isAndroidConnectionFailure.
  if (
    typeof parsed.v === 'number' &&
    (parsed.v < MIN_SUPPORTED_RUNNER_PROTOCOL || parsed.v > RUNNER_PROTOCOL_VERSION)
  ) {
    throw new Error(
      `RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v${parsed.v}, bridge supports v${MIN_SUPPORTED_RUNNER_PROTOCOL}..${RUNNER_PROTOCOL_VERSION}`,
    );
  }
  return parsed;
}

export interface TransportRecovery {
  commandId: string;
  outcome: 'recovered' | 'recovered-error' | 'resent';
}

const STATUS_PROBE_TIMEOUT_MS = 2000;

async function probeCommandStatus(
  hostPort: number,
  commandId: string,
): Promise<ReturnType<typeof parseStatusProbeReply>> {
  try {
    const resp = await sendCommandOnce(
      hostPort,
      { command: 'status', commandId },
      STATUS_PROBE_TIMEOUT_MS,
    );
    return parseStatusProbeReply(resp, commandId);
  } catch {
    throwIfCancelled();
    return null;
  }
}

// Story 14 (#407): a response lost after send is ambiguous — "never executed"
// vs "executed, response lost". One short status probe against the runner's
// outcome journal resolves it; mutating verbs are NEVER resent, and an
// unresolvable probe falls through to the existing invalidation path (the error
// rethrows and runAndroid's catch maps it to RN_ANDROID_RUNNER_DOWN). Recovery
// info travels in the return value so callers that don't surface meta (the
// settle probes) discard it with the response.
async function postCommandWithRecovery(
  body: {
    command?: unknown;
    keyboardWaitMs?: unknown;
  },
  qaContext?: QaDispatchContext,
): Promise<{ resp: RunnerResponse; recovery?: TransportRecovery }> {
  const state = runnerState;
  if (!state) throw new Error('rn-android-runner not started');
  const commandId = generateCommandId();
  const timeoutMs = commandTimeoutMs(body);
  try {
    return {
      resp: await sendCommandOnce(state.hostPort, { ...body, commandId }, timeoutMs, qaContext),
    };
  } catch (err) {
    throwIfCancelled();
    if (err instanceof QaDispatchError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!isAmbiguousTransportFailure(message)) throw err;
    const decision = decideRecovery(
      await probeCommandStatus(state.hostPort, commandId),
      body.command,
    );
    if (decision.action === 'return-recovered') {
      return {
        resp: decision.response as RunnerResponse,
        recovery: { commandId, outcome: decision.outcome },
      };
    }
    if (decision.action === 'resend-once') {
      const resent = await sendCommandOnce(
        state.hostPort,
        { ...body, commandId: generateCommandId() },
        timeoutMs,
        qaContext,
      );
      return { resp: resent, recovery: { commandId, outcome: 'resent' } };
    }
    throw err;
  }
}

async function postCommand(body: { command?: unknown }): Promise<RunnerResponse> {
  return (await postCommandWithRecovery(body)).resp;
}

export function getAndroidRunnerHostPort(): number | null {
  return runnerState?.hostPort ?? null;
}

// Story 04 (#385): thin settle probes. They deliberately skip startAndroidRunner's
// ensure path (runAndroid runs it on EVERY dispatch — a 10-poll snapshot-eq tier
// must not pay 10 ensure round-trips) and pin the forwarded host port captured
// right after the mutating dispatch. If the live runner state has since changed
// (device switch, restart), the probe degrades to null instead of posting to the
// wrong port — the endpoint assumption is CHECKED, not hidden.
export async function androidIsWindowUpdatingProbe(
  timeoutMs: number,
  bundleId: string | undefined,
  pinnedHostPort: number | undefined,
): Promise<boolean | null> {
  if (pinnedHostPort !== undefined && runnerState?.hostPort !== pinnedHostPort) return null;
  try {
    const body: Record<string, unknown> = { command: 'isWindowUpdating', timeoutMs };
    if (bundleId) body.appBundleId = bundleId;
    const resp = await postCommand(body);
    const updating = (resp.data as { updating?: unknown } | undefined)?.updating;
    return resp.ok && typeof updating === 'boolean' ? updating : null;
  } catch {
    throwIfCancelled();
    return null;
  }
}

export async function androidSnapshotNodesViaProbe(
  bundleId: string | undefined,
  pinnedHostPort: number | undefined,
): Promise<FlatNode[] | null> {
  if (pinnedHostPort !== undefined && runnerState?.hostPort !== pinnedHostPort) return null;
  try {
    const body: Record<string, unknown> = { command: 'snapshot', interactiveOnly: true };
    if (bundleId) body.appBundleId = bundleId;
    const resp = await postCommand(body);
    if (!resp.ok || !resp.data || typeof resp.data !== 'object') return null;
    const data = resp.data as { nodes?: RunnerSnapshotNode[] };
    if (!Array.isArray(data.nodes)) return null;
    const flat = mapRunnerNodesToFlat(data.nodes);
    updateRefMapFromFlat(flat);
    return flat;
  } catch {
    throwIfCancelled();
    return null;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// QA reads carry the live-traversal hierarchy. A node whose index, depth or parent
// cannot be trusted is dropped (and so counted) rather than stripped of ancestry.
function qaHierarchy(
  n: RunnerSnapshotNode,
  depths: Map<number, number>,
): Pick<FlatNode, 'index' | 'depth' | 'parentIndex'> | undefined {
  if (
    !isNonNegativeSafeInteger(n.index) ||
    depths.has(n.index) ||
    !isNonNegativeSafeInteger(n.depth)
  )
    return undefined;
  if (n.parentIndex === undefined)
    return n.depth === 0 ? { index: n.index, depth: n.depth } : undefined;
  if (
    !isNonNegativeSafeInteger(n.parentIndex) ||
    n.parentIndex >= n.index ||
    depths.get(n.parentIndex) !== n.depth - 1
  )
    return undefined;
  return { index: n.index, depth: n.depth, parentIndex: n.parentIndex };
}

function mapRunnerNodesToFlat(nodes: RunnerSnapshotNode[], qa = false): FlatNode[] {
  const out: FlatNode[] = [];
  const depths = new Map<number, number>();
  let synthCounter = 0;
  for (const n of nodes) {
    if (
      !n ||
      !n.rect ||
      ![n.rect.x, n.rect.y, n.rect.width, n.rect.height].every(Number.isFinite) ||
      n.rect.width < 0 ||
      n.rect.height < 0
    )
      continue;
    const hierarchy = qa ? qaHierarchy(n, depths) : undefined;
    if (qa && !hierarchy) continue;
    const ref = `@e${n.index ?? synthCounter++}`;
    const flat: FlatNode = { ref, type: n.type ?? '', rect: n.rect, ...hierarchy };
    if (hierarchy) depths.set(hierarchy.index!, hierarchy.depth!);
    if (qa && Object.hasOwn(n, 'presence')) flat.presence = n.presence;
    if (qa && n.selected === true) flat.selected = true;
    if (qa && typeof n.visibleToUser === 'boolean') flat.visibleToUser = n.visibleToUser;
    if (qa && n.heading === true) flat.heading = true;
    if (n.label !== undefined) flat.label = n.label;
    if (n.identifier !== undefined) flat.identifier = n.identifier;
    if (n.packageName !== undefined) flat.packageName = n.packageName;
    if (n.checked !== undefined) flat.checked = n.checked;
    if (n.enabled !== undefined) flat.enabled = n.enabled;
    if (n.hittable !== undefined) flat.hittable = n.hittable;
    if (n.secure !== undefined) flat.secure = n.secure;
    out.push(flat);
  }
  return out;
}

const ANDROID_PRESENCE_CAPABILITY = 'A11Y_PRESENCE_V2';

function presenceCaptureUnavailable(reason: string, code: ToolErrorCode): ToolResult {
  return failResult(
    `Platform presence capture unavailable: ${reason}; no recovery attempted.`,
    code,
    { capture: 'unknown', mutation: 'none', dispatched: false },
  );
}

export function shouldRecoverAndroidAccessibility(
  command: string,
  response: Pick<RunnerResponse, 'ok' | 'error'>,
): boolean {
  return (
    command === 'snapshot' && !response.ok && response.error?.code === 'ACCESSIBILITY_UNAVAILABLE'
  );
}

export async function runAndroid(args: RunAndroidArgs): Promise<ToolResult> {
  const qaReadOnly =
    (args.qaContext !== undefined || args.qaReadOnly === true) && !isMutatingCommand(args.command);
  if (args.qaReadOnly && isMutatingCommand(args.command)) {
    if (args.qaContext) args.qaContext.invalidate();
    throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
  }
  if (args.qaContext || args.qaReadOnly) {
    args.qaContext?.assertComplete();
    const before = runnerState;
    const info = before ? await probeAndroidRunnerHealthInfo(before.hostPort) : null;
    if (
      !before ||
      runnerState !== before ||
      !info?.reachable ||
      !info.ok ||
      !classifyAndroidHealth(info).compatible ||
      (qaReadOnly && !info.capabilities?.includes(QA_READ_ONLY_CAPABILITY)) ||
      (args.deviceId !== undefined && before.deviceId !== args.deviceId) ||
      (args.bundleId !== undefined && before.bundleId !== args.bundleId) ||
      !androidHealthMatchesAuthority(info, {
        instanceId: before.instanceId,
        sessionId: before.sessionId,
        claimEpoch: before.claimEpoch,
        deviceId: before.deviceId,
        appId: before.bundleId,
      })
    ) {
      if (args.qaContext) args.qaContext.invalidate();
      throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
    }
  }
  if (args._staleRef) {
    args.qaContext?.invalidate();
    return failResult(
      `Element at ref ${args._staleRef} no longer hittable - UI re-rendered since snapshot`,
      'STALE_REF',
      {
        cachedMetadata: getCachedMetadata(args._staleRef),
        reResolution: 'self-heal-disabled',
        candidates: [],
        mutation: 'none',
        hint: 'Call device_snapshot action=snapshot to refresh refs, then retry the action with the new ref.',
      },
    );
  }

  // An older runner has no proven system dialog tap.
  if (args.command === 'systemAlertTap' && !lastKnownCapabilities.includes('SYSTEM_ALERT_TAP_V1')) {
    return failResult(
      'RUNNER_COMMANDS_STALE: the active Android runner cannot tap a system dialog button by its label; reopen the device session to rebuild before retrying.',
      'RUNNER_COMMANDS_STALE',
      { missingFeatures: ['SYSTEM_ALERT_TAP_V1'], dispatched: false, mutation: 'none' },
    );
  }

  const presenceRequested = args.command === 'snapshot' && args.platformPresence === true;
  if (presenceRequested) {
    if (!Number.isSafeInteger(args.presenceBudgetMs) || (args.presenceBudgetMs ?? 0) <= 0)
      return presenceCaptureUnavailable(
        'presenceBudgetMs must be an explicit positive integer',
        'INVALID_ARGUMENT',
      );
    // A runner without its presence pass cannot vouch for a phrase target.
    if (!lastKnownCapabilities.includes(ANDROID_PRESENCE_CAPABILITY))
      return presenceCaptureUnavailable(
        `the runner lacks ${ANDROID_PRESENCE_CAPABILITY}`,
        'RUNNER_COMMANDS_STALE',
      );
  }

  const body: Record<string, unknown> = { command: args.command };
  if (qaReadOnly) body.qaReadOnly = true;
  if (presenceRequested) {
    body.platformPresence = true;
    body.presenceBudgetMs = args.presenceBudgetMs;
    if (args.labelProvenance) body.labelProvenance = args.labelProvenance;
  }
  if (args.bundleId) body.appBundleId = args.bundleId;
  if (args.x !== undefined) body.x = args.x;
  if (args.y !== undefined) body.y = args.y;
  if (args.x1 !== undefined) body.x1 = args.x1;
  if (args.y1 !== undefined) body.y1 = args.y1;
  if (args.x2 !== undefined) body.x2 = args.x2;
  if (args.y2 !== undefined) body.y2 = args.y2;
  if (args.text !== undefined) body.text = args.text;
  if (args.labels !== undefined) body.labels = args.labels;
  if (args.exactIdentifier !== undefined) body.exactIdentifier = args.exactIdentifier;
  if (args.exactType !== undefined) body.exactType = args.exactType;
  if (args.exact !== undefined) body.exact = args.exact;
  if (args.includeSystemUi !== undefined) body.includeSystemUi = args.includeSystemUi;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.timeoutMs !== undefined) body.timeoutMs = args.timeoutMs;
  if (args.scale !== undefined) body.scale = args.scale;
  if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;
  if (args.snapshotGeneration !== undefined) body.snapshotGeneration = args.snapshotGeneration;
  if (args.snapshotNodeIndex !== undefined) body.snapshotNodeIndex = args.snapshotNodeIndex;
  if (args.snapshotIdentifier !== undefined) body.snapshotIdentifier = args.snapshotIdentifier;
  if (args.snapshotElementType !== undefined) body.snapshotElementType = args.snapshotElementType;
  if (args.targetBounds !== undefined) body.targetBounds = args.targetBounds;
  if (args.focusX !== undefined) body.focusX = args.focusX;
  if (args.focusY !== undefined) body.focusY = args.focusY;
  if (args.focusWaitMs !== undefined) body.focusWaitMs = args.focusWaitMs;
  if (args.keyboardWaitMs !== undefined) body.keyboardWaitMs = args.keyboardWaitMs;
  if (args.secureInput !== undefined) body.secureInput = args.secureInput;
  if (args.operationToken !== undefined) body.operationToken = args.operationToken;

  let resp: RunnerResponse;
  let recovery: TransportRecovery | undefined;
  try {
    if (!args.qaContext && !args.qaReadOnly) await startAndroidRunner(args.deviceId, args.bundleId);
    ({ resp, recovery } = await postCommandWithRecovery(
      withKeyboardGuard(body, args.command, process.env) as Record<string, unknown>,
      args.qaContext,
    ));
  } catch (err) {
    throwIfCancelled();
    if (args.qaContext) args.qaContext.refuse('ACTION_OUTCOME_UNCERTAIN');
    const m = errMessage(err);
    // GH #383: a protocol mismatch (reuse-gate reject, post-start verify, or the
    // /command v-stamp) is a distinct, actionable failure — surface it before the
    // generic connection-failure mapping so it is never mislabeled RN_ANDROID_RUNNER_DOWN.
    if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
      return failResult(m, 'RUNNER_PROTOCOL_MISMATCH', {
        hint: 'The installed runner APK predates this plugin version. Rebuild + reinstall (command in the error), then retry.',
      });
    }
    // GH#243: a connection failure (runner just restarted after a flow, or can't bind
    // its port) must surface as a structured, retryable error — never a bare
    // "fetch failed". RUNNER_TIMEOUT (a wedged-but-bound instrument) is NOT a connection
    // failure and is rethrown unchanged.
    if (isAndroidConnectionFailure(m)) {
      return failResult(`rn-android-runner is not reachable: ${m}`, 'RN_ANDROID_RUNNER_DOWN', {
        hint: 'The runner could not start or bind its port (e.g. just restarted after a Maestro flow). Retry the command; if it persists, ensure the emulator is booted and the app is installed.',
      });
    }
    throw err;
  }
  // A foreground app can survive an inline stop/relaunch while UiAutomation's
  // accessibility connection does not. One instrumentation restart is the
  // smallest recovery: it preserves app state, rebinds accessibility, and
  // retries the read exactly once. A second failure remains explicit.
  let accessibilityRecovery: 'runner-restarted' | undefined;
  if (shouldRecoverAndroidAccessibility(args.command, resp)) {
    if (args.qaContext) args.qaContext.invalidate();
    if (args.qaReadOnly) throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
    await stopAndroidRunner(args.deviceId);
    await startAndroidRunner(args.deviceId, args.bundleId);
    ({ resp, recovery } = await postCommandWithRecovery(
      withKeyboardGuard(body, args.command, process.env) as Record<string, unknown>,
    ));
    if (resp.ok) accessibilityRecovery = 'runner-restarted';
  }

  // Story 14 (#407): recovery happened INSIDE postCommandWithRecovery (before the
  // catch above), so an unrecovered ambiguous failure still maps to
  // RN_ANDROID_RUNNER_DOWN — only a resolved recovery reaches here, folded into
  // every result the tool builds.
  const recoveryMeta = {
    ...(recovery ? { transportRecovery: recovery } : {}),
    ...(accessibilityRecovery ? { accessibilityRecovery } : {}),
  };
  checkQaNativeOutcome(
    args.qaContext,
    resp.error?.code,
    resp.data,
    resp.error?.reason,
    resp.error?.mutation,
  );
  if (!resp.ok) {
    const message = resp.error?.message ?? 'Android runner returned !ok with no error';
    const code = resp.error?.code;
    // Mirror the iOS `.type` runner-timeout shim (rn-fast-runner-client.ts:553-562).
    // UIAutomator's `typeText` waits for window-content idle internally even with
    // `Configurator.setWaitForIdleTimeout(0)`. RN apps with Reanimated/RAF active
    // never report idle, so the call resolves with an `InvocationTargetException`
    // wrapping "Could not detect idle state" AFTER the text has already been
    // appended to the field. Live trials (Task 10) confirm the side-effect
    // always succeeds — but that is attempt evidence, not field truth, so this
    // shape fails as TYPE_IDLE_TIMEOUT with mutation:'possible' (GH #581).
    if (
      args.command === 'type' &&
      args.exactIdentifier === undefined &&
      typeof message === 'string' &&
      (message.includes('Could not detect idle state') ||
        message.includes('window-content-idle') ||
        message.includes('Idle timeout exceeded'))
    ) {
      // GH #581: UIAutomator's idle-detection failure fires AFTER the text
      // landed (Task 10 live trials), but that is attempt evidence, not field
      // truth — fail with mutation:'possible' so only the arbiter's exact
      // read-back can promote it. Never echoes the requested text.
      return failResult(
        'rn-android-runner type hit the window-idle timeout after dispatching the mutation; the field value is unverified',
        'TYPE_IDLE_TIMEOUT',
        { mutation: 'possible', runnerTimeoutShim: true, ...recoveryMeta },
      );
    }
    // GH #581: mutating-command failures always carry a valid disposition;
    // absent/invalid ones conservatively become 'possible'.
    const VALID_MUTATIONS = new Set(['none', 'observed', 'possible']);
    const rawMutation = resp.error?.mutation;
    const mutation =
      rawMutation !== undefined && VALID_MUTATIONS.has(rawMutation)
        ? rawMutation
        : args.command === 'type' || args.command === 'fill'
          ? 'possible'
          : undefined;
    const reason = resp.error?.reason;
    const failExtras = {
      ...(recovery ? { transportRecovery: recovery } : {}),
      ...(mutation !== undefined ? { mutation } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    if (code) {
      return failResult(
        message,
        code as Parameters<typeof failResult>[1],
        Object.keys(failExtras).length > 0 ? failExtras : undefined,
      );
    }
    return Object.keys(failExtras).length > 0
      ? failResult(message, failExtras)
      : failResult(message);
  }

  if (args.command === 'tap') {
    const data = resp.data as { tapped?: unknown; keyboardShown?: unknown } | undefined;
    // Meta, so an unverified-effect refusal built from this result still names the keyboard.
    if (data?.tapped === true && typeof data.keyboardShown === 'boolean')
      return okResult(data, { meta: { ...recoveryMeta, keyboardShown: data.keyboardShown } });
    if (data?.tapped !== true) {
      // NOTE: ACTION_CLICK is atomic, but a false coordinate click can mean the
      // touch-up failed after the app already received the touch-down.
      const exactTarget = args.exactIdentifier !== undefined && args.exactType !== undefined;
      if (exactTarget) {
        return failResult(
          'Android runner could not prove that the requested interaction was actuated.',
          'INTERACTION_NOT_ACTUATED',
          { mutation: 'none', reason: 'runner-rejected-tap', ...recoveryMeta },
        );
      }
      return failResult(
        'The Android coordinate tap did not complete, and part of the gesture may have reached the app.',
        'INTERACTION_EFFECT_UNVERIFIED',
        {
          mutation: 'possible',
          reason: 'coordinate-tap-incomplete',
          attempts: 1,
          ...recoveryMeta,
        },
      );
    }
  }

  if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
    if (args.labelProvenance) {
      const metadata = resp.data as { labelProvenance?: unknown };
      return okResult({
        labelProvenance: labelProvenanceFromWire(metadata.labelProvenance, args.labelProvenance),
      });
    }
    const data = resp.data as {
      nodes?: RunnerSnapshotNode[];
      truncated?: unknown;
      normalizationDroppedNodes?: unknown;
      snapshotGeneration?: unknown;
      keyboardVisible?: unknown;
      presenceCapture?: unknown;
      pointScale?: unknown;
    };
    if (Array.isArray(data.nodes)) {
      const flat = mapRunnerNodesToFlat(data.nodes, qaReadOnly);
      const freshness = {
        ...(isNonNegativeSafeInteger(data.snapshotGeneration)
          ? { snapshotGeneration: data.snapshotGeneration }
          : {}),
        ...(typeof data.keyboardVisible === 'boolean'
          ? { keyboardVisible: data.keyboardVisible }
          : {}),
      };
      const presence = data.presenceCapture;
      const presencePointScale =
        presence && typeof presence === 'object' && 'pointScale' in presence
          ? presence.pointScale
          : undefined;
      const outcome = updateRefMapFromFlat(flat, {
        ...freshness,
        pointScale: data.pointScale ?? presencePointScale,
      });
      const snapshotVerdict = buildSnapshotVerdict('rn-android-runner', flat.length, outcome);
      const producerDropped = data.normalizationDroppedNodes;
      const dropped =
        typeof producerDropped === 'number' &&
        Number.isSafeInteger(producerDropped) &&
        producerDropped >= 0
          ? producerDropped + (data.nodes.length - flat.length)
          : undefined;
      return okResult(
        {
          nodes: flat,
          ...(typeof data.truncated === 'boolean' ? { truncated: data.truncated } : {}),
          ...(Number.isSafeInteger(dropped) ? { normalizationDroppedNodes: dropped } : {}),
          ...freshness,
          ...(qaReadOnly && Object.hasOwn(data, 'presenceCapture')
            ? { presenceCapture: data.presenceCapture }
            : {}),
        },
        { meta: { snapshotVerdict, ...recoveryMeta } },
      );
    }
  }

  if (args.command === 'screenshot') {
    const data = resp.data as { pngBase64?: string } | undefined;
    if (!data?.pngBase64)
      return failResult(
        'Android runner screenshot response did not include pngBase64',
        'SCREENSHOT_FAILED',
        recovery ? { transportRecovery: recovery } : undefined,
      );
    const outPath = args.outPath ?? join(tmpdir(), `rn-android-screenshot-${Date.now()}.png`);
    writeFileSync(outPath, Buffer.from(data.pngBase64, 'base64'));
    return okResult(
      { path: outPath },
      Object.keys(recoveryMeta).length ? { meta: recoveryMeta } : undefined,
    );
  }

  return okResult(
    resp.data ?? {},
    Object.keys(recoveryMeta).length ? { meta: recoveryMeta } : undefined,
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAndroidConnectionFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|rn-android-runner not started|did not become ready|Android runner instrumentation exited before readiness|Failed to spawn Android runner instrumentation/i.test(
    message,
  );
}

export async function readAndroidLabelProvenance(
  refs: string[],
  budgetMs: number,
  bundleId: string,
  deviceId: string,
): Promise<LabelProvenance[] | undefined> {
  const targets = refs.map((ref) => getFreshRefTarget(ref));
  const generation = targets[0]?.snapshotGeneration;
  if (
    refs.length < 1 ||
    refs.length > 64 ||
    targets.some((target) => !target || target.snapshotGeneration !== generation)
  )
    return undefined;
  const result = await runAndroid({
    command: 'snapshot',
    bundleId,
    deviceId,
    qaReadOnly: true,
    platformPresence: true,
    presenceBudgetMs: budgetMs,
    snapshotGeneration: generation,
    labelProvenance: targets.map((target) => target!.snapshotNodeIndex),
  });
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '');
    return envelope.ok === true ? envelope.data?.labelProvenance : undefined;
  } catch {
    return undefined;
  }
}
