import { DEVICE_LEASE_REQUIRED, leaseFromEnvironment } from './lease-env.js';
import { QaDispatchError, type QaDispatchContext } from '../domain/qa-dispatch.js';
import { measureTiming, observeTiming, type TimingContext } from '../qa/timing.js';
import { QA_READ_ONLY_CAPABILITY, checkQaNativeOutcome } from './qa-native-policy.js';
import {
  execFile,
  spawn,
  cancellableFetch,
  sleep as cancellableSleep,
  interruptible,
  cancellationSignal,
  throwIfCancelled,
  isAbort,
} from '../domain/cancellation.js';
import { promisify } from 'node:util';
import { isIosSimulatorUdid } from './external-runner-detect.js';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { dirtySnapshotPlatforms } from '../snapshot-invalidation.js';
import type { FastRunnerState, ToolErrorCode } from '../types.js';
import {
  updateRefMapFromFlat,
  clearRefMap,
  buildSnapshotVerdict,
  getCachedMetadata,
  getCachedSignature,
  refreshRef,
  getFreshRefTarget,
  type FlatNode,
  type RefMapUpdateOutcome,
} from '../fast-runner-ref-map.js';
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
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  getPluginVersion,
  classifyRunnerCompatibility,
} from './protocol.js';
import type { RunnerIncompatibilityReason } from './protocol.js';
import type { QuiescenceStatus } from './quiescence.js';
import { buildRunnerQuiescenceEnv } from './quiescence.js';
import { artifactProvenanceToState, resolveIosRunnerArtifacts } from './runner-artifacts.js';
import { resolveNativeRunnerDir } from './runtime-paths.js';
import {
  decideRecovery,
  generateCommandId,
  isAmbiguousTransportFailure,
  isMutatingCommand,
  parseStatusProbeReply,
} from './transport-recovery.js';
import {
  probeProcessBirth,
  readProcessBirth,
  type ProcessBirthProbe,
} from '../lifecycle/process-birth.js';

// Warm-launch ready gate. Overridable via RN_FAST_RUNNER_READY_TIMEOUT_MS
// because a cold/slow CI simulator can need well over 30s to install + launch
// + attach the XCUITest runner (device-proven on GitHub macos runners).
export function resolveReadyTimeoutMs(): number {
  const raw = Number(process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}
const READY_TIMEOUT_MS = resolveReadyTimeoutMs();
// A cold `xcodebuild test` compiles the runner project before launching it; on a
// fresh machine (no prebuilt .xctestrun) that can take several minutes, so the
// ready-signal timeout is widened for the build path.
const BUILD_READY_TIMEOUT_MS = 360_000;
const HTTP_TIMEOUT_MS = 10_000;
const FAST_RUNNER_PROJECT = resolveNativeRunnerDir('rn-fast-runner');

// --- READY-signal parser (pure, testable without xcodebuild) ---
//
// The imported rn-fast-runner XCTest emits its handshake via two NSLog lines:
//   RN_FAST_RUNNER_LISTENER_READY
//   RN_FAST_RUNNER_PORT=<port>
//
// (Replacing the legacy single-line `FASTXCT_READY {"port":N}` JSON shape.)
//
// Failure markers we must surface:
//   RN_FAST_RUNNER_LISTENER_FAILED — listener crashed during startup
//   RN_FAST_RUNNER_PORT_NOT_SET    — listener ready but env port read failed
//
// xcodebuild streams stdout/stderr in arbitrary-sized chunks, so the parser
// holds a small buffer + a `seenReady` flag and walks complete lines.

export type ReadySignalResult =
  | { ready: true; port: number; quiescence?: QuiescenceStatus }
  | { error: string };

export interface ReadySignalParser {
  /**
   * Feed the next stdout chunk. Returns a resolved/rejected result when
   * the two-line handshake (or a failure marker) is observed, otherwise
   * `null` if more input is needed.
   */
  feed(chunk: string): ReadySignalResult | null;
}

/**
 * Pure function variant: parse an entire stdout buffer in one shot.
 * Exists so unit tests can exercise the parser without juggling
 * stateful chunk feeds. Mirrors what `createReadySignalParser` would
 * produce after one synthetic feed of `buf`.
 */
export function parseReadySignal(buf: string): ReadySignalResult | null {
  const parser = createReadySignalParser();
  return parser.feed(buf);
}

export function createReadySignalParser(): ReadySignalParser {
  let pending = '';
  let seenReady = false;
  let quiescence: QuiescenceStatus | undefined;
  return {
    feed(chunk: string): ReadySignalResult | null {
      pending += chunk;
      // Process complete lines only; keep the trailing partial line buffered.
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        // Failure markers may appear anywhere — check first.
        if (line.includes('RN_FAST_RUNNER_LISTENER_FAILED')) {
          return { error: 'RN_FAST_RUNNER_LISTENER_FAILED' };
        }
        if (line.includes('RN_FAST_RUNNER_PORT_NOT_SET')) {
          return { error: 'RN_FAST_RUNNER_PORT_NOT_SET' };
        }
        // GH #384: quiescence startup marker precedes LISTENER_READY.
        if (line.includes('RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE')) {
          quiescence = 'active';
        } else if (line.includes('RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED')) {
          quiescence = 'disabled';
        } else if (line.includes('RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE')) {
          quiescence = 'unavailable';
        }
        if (!seenReady) {
          if (line.includes('RN_FAST_RUNNER_LISTENER_READY')) {
            seenReady = true;
          }
          continue;
        }
        // After READY, scan for the port. NSLog wraps the marker in a
        // timestamp + process prefix, so match anywhere in the line.
        const portMatch = line.match(/RN_FAST_RUNNER_PORT=(\d+)/);
        if (portMatch) {
          return {
            ready: true,
            port: Number(portMatch[1]),
            ...(quiescence !== undefined ? { quiescence } : {}),
          };
        }
      }
      return null;
    },
  };
}

// --- Singleton state ---

let runnerProcess: ChildProcess | null = null;
let runnerDriverObserver: ((pid: number) => void) | undefined;

// QaReN records each spawned runner driver; the driver leads its own process group.
export function observeRunnerDrivers(observer: ((pid: number) => void) | undefined): void {
  runnerDriverObserver = observer;
}

function signalDriver(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    return;
  } catch {
    // The group is gone or was never formed; the leader alone remains addressable.
  }
  child.kill(signal);
}
// GH #629: monotonic count of launch xcodebuild children actually spawned.
// ensureFastRunner swallows startFastRunner errors, so this is the only way a
// caller can tell a READY-timeout apart from a failure before the launch step.
let runnerLaunchCount = 0;
let runnerState: FastRunnerState | null = null;
let runnerPoisoned = false;
let poisonReap: Promise<void> | null = null;
// Concurrent containments share one poison flag. Clearing it on the first
// completion would reopen mutating commands while a second containment is
// still awaiting its own reap — exactly the window the poison exists to close.
let poisonHolders = 0;
let runnerOutputTail = '';
let lastRunnerCommand: string | null = null;
export interface RunnerPostMortem {
  available: boolean;
  provenance: 'spawned' | 'adopted';
  lastCommand?: string | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  outputTail?: string;
}
let lastRunnerPostMortem: RunnerPostMortem | null = null;

function appendRunnerOutput(stream: 'stdout' | 'stderr', chunk: string): void {
  runnerOutputTail = `${runnerOutputTail}${stream}: ${chunk}`.slice(-8_000);
}

export function getRunnerPostMortem(): RunnerPostMortem {
  return (
    lastRunnerPostMortem ?? {
      available: false,
      provenance: runnerProcess ? 'spawned' : 'adopted',
    }
  );
}

// Story 04 (#385): capabilities from the last successful /health probe. Warm
// before any mutating verb — ensureRunnerForCommand probes /health ahead of
// every non-screenshot iOS command. Consumed by the settle engine.
let lastKnownCapabilities: string[] = [];

export function getFastRunnerCapabilities(): string[] {
  return lastKnownCapabilities;
}

export function _resetCapabilitiesForTest(): void {
  lastKnownCapabilities = [];
}

export function _setCapabilitiesForTest(capabilities: string[]): void {
  lastKnownCapabilities = [...capabilities];
}

export function _setFastRunnerStateForTest(state: FastRunnerState | null): void {
  runnerState = state
    ? {
        ...state,
        capability: state.capability ?? 'test-capability'.repeat(3),
      }
    : null;
  runnerProcess = null;
  lastRunnerPostMortem = null;
}

// GH #384: announce the runner's quiescence-bypass status on the FIRST
// successful /command after a state acquisition (fresh spawn or adoption),
// so sessions are auditable without polling /health. Consumed by every
// success return in runIOS — currently the type-shim return, the snapshot
// return + its defensive fallback, and the final default return; a new
// success return site must also attach it. A shimmed `type` (resp.ok=false
// at the wire level) defers the announcement to the next command by design.
let quiescenceAnnouncementPending = false;

const QUIESCENCE_STATUSES = new Set(['active', 'disabled', 'unavailable']);

export function _resetQuiescenceAnnouncementForTest(pending: boolean): void {
  quiescenceAnnouncementPending = pending;
}

function takeQuiescenceAnnouncement(): Record<string, unknown> | null {
  if (!quiescenceAnnouncementPending) return null;
  quiescenceAnnouncementPending = false;
  // Persisted state is cast, not validated field-by-field — guard against a
  // tampered/corrupt local state file surfacing an arbitrary string.
  if (!runnerState?.quiescence || !QUIESCENCE_STATUSES.has(runnerState.quiescence)) return null;
  return { quiescenceBypass: runnerState.quiescence };
}

export function iosStatePath(deviceId: string): string {
  return runnerStatePath(`ios-${deviceId}`);
}

export function parsePersistedRunnerState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): FastRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<FastRunnerState>;
  if (s.schemaVersion !== 1) return null;
  if (typeof s.pid !== 'number' || typeof s.port !== 'number') return null;
  if (typeof s.deviceId !== 'string' || typeof s.bundleId !== 'string') return null;
  if (!pidAlive(s.pid)) return null;
  return s as FastRunnerState;
}

// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state. protocolVersion is synthesized to 0 ("pre-protocol") — the
// health gate then classifies the live runner 'legacy' → reap → relaunch,
// which is exactly the transparent-upgrade path. Never trusted beyond
// pid/port/deviceId.
export function parseLegacyRunnerState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): FastRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as { pid?: unknown; port?: unknown; deviceId?: unknown; bundleId?: unknown };
  if (typeof s.pid !== 'number' || typeof s.port !== 'number') return null;
  if (typeof s.deviceId !== 'string') return null;
  if (!pidAlive(s.pid)) return null;
  return {
    schemaVersion: 1,
    pid: s.pid,
    port: s.port,
    deviceId: s.deviceId,
    bundleId: typeof s.bundleId === 'string' ? s.bundleId : '',
    startedAt: '',
    protocolVersion: 0,
  };
}

// GH #383: lazy per-device adoption replaces the import-time /tmp load. A
// respawned bridge worker rediscovers a live runner the first time it knows
// which device it is talking to (ensureRunnerForCommand / session health /
// startFastRunner / stopFastRunner). Invalid or dead persisted state is
// deleted on sight. Falls back to the legacy /tmp file ONCE so a live
// pre-upgrade runner is discovered rather than orphaned (review amendment);
// a dead legacy file is garbage and is removed immediately.
export function adoptPersistedFastRunnerState(deviceId: string | undefined): void {
  if (runnerState || !deviceId) return;
  const path = iosStatePath(deviceId);
  const raw = readJsonStateFile(path);
  if (raw !== null) {
    const parsed = parsePersistedRunnerState(raw);
    if (!parsed) {
      deleteStateFile(path);
      return;
    }
    runnerState = parsed;
    quiescenceAnnouncementPending = true;
    return;
  }
  const legacy = readLegacyTmpState('ios');
  if (legacy === null) return;
  const parsedLegacy = parseLegacyRunnerState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (parsedLegacy.deviceId === deviceId) {
    runnerState = parsedLegacy;
    quiescenceAnnouncementPending = true;
  }
}

export function getFastRunnerState(): FastRunnerState | null {
  return runnerState;
}

export interface FastRunnerCommandAuthority {
  pid: number;
  port: number;
  deviceId: string;
  statePath: string;
  provenance: 'spawned' | 'adopted';
}

export function captureFastRunnerCommandAuthority(): FastRunnerCommandAuthority | null {
  if (!runnerState) return null;
  return {
    pid: runnerState.pid,
    port: runnerState.port,
    deviceId: runnerState.deviceId,
    statePath: iosStatePath(runnerState.deviceId),
    provenance: runnerProcess?.pid === runnerState.pid ? 'spawned' : 'adopted',
  };
}

/**
 * Test-only seam: inject a fake runner state so callers (e.g. runIOS)
 * can be unit-tested without spawning xcodebuild. Production code must
 * never call this.
 */
export function _setRunnerStateForTest(state: FastRunnerState | null): void {
  _setFastRunnerStateForTest(state);
}

export function isFastRunnerAvailable(): boolean {
  if (!runnerState) return false;
  try {
    process.kill(runnerState.pid, 0);
    return true;
  } catch {
    /* process dead */
  }
  clearStateFile();
  return false;
}

// --- Build-vs-spawn decision (pure, testable without xcodebuild) ---

interface RunnerXcodebuildArgsOptions {
  projectPath: string;
  scheme: string;
  deviceId: string;
  derivedDataPath: string;
  onlyTesting: string;
  hasBuiltTestProduct: boolean;
}

export interface RunnerStartStep {
  action: 'build-for-testing' | 'test-without-building';
  args: string[];
}

/**
 * Decide the ordered xcodebuild invocations that start the runner.
 *
 * `test-without-building` is the fast steady-state launch, but it requires a
 * prior `build-for-testing` to have produced a .xctestrun. On a fresh machine
 * that artifact is absent (build/ is gitignored), so the cold path builds it
 * first and then launches warm — making the runner self-install on first use
 * (D1219 follow-up). GH #424: a bare `xcodebuild test` never writes a
 * .xctestrun, so the previous single-invocation cold path left the runner
 * permanently "not prebuilt" and every runner death cost another multi-minute
 * cold build. The build step carries no -only-testing so it produces the same
 * artifact as the documented manual prebuild.
 */
export function resolveRunnerStartPlan(opts: RunnerXcodebuildArgsOptions): RunnerStartStep[] {
  const common = [
    '-project',
    opts.projectPath,
    '-scheme',
    opts.scheme,
    '-destination',
    `platform=iOS Simulator,id=${opts.deviceId}`,
    '-derivedDataPath',
    opts.derivedDataPath,
  ];
  const launch: RunnerStartStep = {
    action: 'test-without-building',
    args: ['test-without-building', ...common, `-only-testing:${opts.onlyTesting}`],
  };
  if (opts.hasBuiltTestProduct) return [launch];
  return [{ action: 'build-for-testing', args: ['build-for-testing', ...common] }, launch];
}

/** True when a prior build-for-testing left a .xctestrun under DerivedData. */
export function hasBuiltTestProduct(derivedDataPath: string): boolean {
  try {
    const productsDir = join(derivedDataPath, 'Build', 'Products');
    if (!existsSync(productsDir)) return false;
    return readdirSync(productsDir).some((entry) => entry.endsWith('.xctestrun'));
  } catch {
    return false;
  }
}

/** #210: the DerivedData path the runner builds into — used to check hasBuiltTestProduct before auto-spawn. */
export function derivedDataPathForRunner(): string {
  return join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');
}

// GH #418 (review amendment): DerivedData is plugin-checkout-scoped while the
// device lock is UDID-scoped, so two projects sharing this checkout could race
// invalidate-vs-build. mkdir is atomic — it is the mutex. Fail-open on fs
// errors (never block a legit session); stale takeover after 15 min.
const REBUILD_LOCK_DIR = join(FAST_RUNNER_PROJECT, 'build', '.rebuild-lock');
const REBUILD_LOCK_STALE_MS = 15 * 60_000;

export function acquireRunnerRebuildLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(REBUILD_LOCK_DIR, { recursive: false });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true; // fail-open
      try {
        const age = Date.now() - statSync(REBUILD_LOCK_DIR).mtimeMs;
        if (age < REBUILD_LOCK_STALE_MS) return false;
        rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
      } catch {
        return true; // fail-open
      }
    }
  }
  return false;
}

export function releaseRunnerRebuildLock(): void {
  try {
    rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// GH #418 (review amendment): at most ONE commands-triggered cold rebuild per
// plugin version — a genuinely-broken checkout must not loop multi-minute
// builds on every open. Lives in build/ (sibling of DerivedData) so the
// invalidation itself can't erase it.
const REBUILD_BUDGET_FILE = join(FAST_RUNNER_PROJECT, 'build', 'commands-rebuild.json');

export const runnerRebuildBudget = {
  alreadyRebuiltFor(pluginVersion: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(REBUILD_BUDGET_FILE, 'utf8')) as {
        pluginVersion?: string;
      };
      return parsed.pluginVersion === pluginVersion;
    } catch {
      return false;
    }
  },
  recordRebuild(pluginVersion: string): void {
    try {
      mkdirSync(join(FAST_RUNNER_PROJECT, 'build'), { recursive: true });
      writeFileSync(
        REBUILD_BUDGET_FILE,
        JSON.stringify({ pluginVersion, at: new Date().toISOString() }),
      );
    } catch {
      /* fail-open */
    }
  },
  reset(pluginVersion: string): void {
    try {
      const parsed = JSON.parse(readFileSync(REBUILD_BUDGET_FILE, 'utf8')) as {
        pluginVersion?: string;
      };
      if (parsed.pluginVersion === pluginVersion) {
        rmSync(REBUILD_BUDGET_FILE, { force: true });
      }
    } catch {
      /* already absent or unreadable */
    }
  },
};

export function resetRunnerRebuildBudgetForCurrentPlugin(): void {
  const pluginVersion = getPluginVersion();
  if (pluginVersion !== null) runnerRebuildBudget.reset(pluginVersion);
}

// GH #382: a one-line note ("downloaded prebuilt runner (~4 MB)" / "prebuilt
// runner unavailable ...; building locally") set while startFastRunner resolves
// artifacts. Consumed by the open / mid-flow dispatch paths and attached as a
// meta.note. Mirrors the Android pendingUpgradeNote discipline: the consumer must
// discard it on a failed start so a stale note never leaks onto a later result.
let pendingFastRunnerArtifactNote: string | undefined;

export function consumePendingFastRunnerArtifactNote(): string | undefined {
  const note = pendingFastRunnerArtifactNote;
  pendingFastRunnerArtifactNote = undefined;
  return note;
}

// HONEST_HITTABLE is compiled into the artifact's /health capabilities — its
// absence on a healthy probe is the only artifact-truthful signal that the
// binary predates #395 (protocol/commands are unchanged and runnerVersion is
// env-passed at launch, so every other gate passes). A missing capabilities
// list means the artifact predates capability enumeration entirely and is
// stale for the same reason. Advisory only: a forced rebuild here would break
// the no-silent-multi-minute-xcodebuild contract.
let staleHittableWarned = false;

export function _resetStaleHittableWarnForTest(): void {
  staleHittableWarned = false;
}

function noteStaleHittableArtifact(capabilities: string[] | undefined): void {
  if (staleHittableWarned || (capabilities ?? []).includes('HONEST_HITTABLE')) return;
  if (pendingFastRunnerArtifactNote !== undefined) return;
  staleHittableWarned = true;
  pendingFastRunnerArtifactNote =
    'runner artifact predates honest hittable (#395): snapshot hittable values are stale ' +
    '(always false) — delete packages/rn-fast-runner/build/DerivedData and reopen the ' +
    'device session to rebuild, or upgrade the plugin.';
}

// --- Lifecycle ---

/**
 * GH#202: only adopt an existing runner when it is bound to the SAME
 * simulator. The state file path is a fixed constant shared across projects,
 * so a stale state from another project (different deviceId) must never be
 * reused — that would drive the wrong simulator.
 */
export function shouldReuseRunner(state: FastRunnerState | null, deviceId: string): boolean {
  const authority = runnerAuthorityFromEnvironment(false);
  return (
    state !== null &&
    state.deviceId === deviceId &&
    authority !== null &&
    state.sessionId === authority.sessionId &&
    state.claimEpoch === authority.claimEpoch &&
    typeof state.capability === 'string' &&
    state.capability.length >= 32
  );
}

interface RunnerAuthority {
  instanceId: string;
  sessionId: string;
  claimEpoch: number;
  capability: string;
}

function runnerAuthorityFromEnvironment(required: boolean): RunnerAuthority | null {
  const lease = leaseFromEnvironment();
  if (!lease) {
    if (!required) return null;
    throw new Error(DEVICE_LEASE_REQUIRED);
  }
  return {
    instanceId: randomUUID(),
    sessionId: lease.sessionId,
    claimEpoch: lease.claimEpoch,
    capability: randomBytes(32).toString('base64url'),
  };
}

export function buildRunnerAuthorityEnv(authority: RunnerAuthority): Record<string, string> {
  const values: Record<string, string> = {
    RN_RUNNER_INSTANCE_ID: authority.instanceId,
    RN_RUNNER_SESSION_ID: authority.sessionId,
    RN_RUNNER_CLAIM_EPOCH: String(authority.claimEpoch),
    RN_RUNNER_CAPABILITY: authority.capability,
  };
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => [
      [key, value],
      [`TEST_RUNNER_${key}`, value],
    ]),
  );
}

function buildRunnerTargetEnv(deviceId: string, appId: string): Record<string, string> {
  return {
    RN_RUNNER_DEVICE_ID: deviceId,
    TEST_RUNNER_RN_RUNNER_DEVICE_ID: deviceId,
    RN_RUNNER_APP_ID: appId,
    TEST_RUNNER_RN_RUNNER_APP_ID: appId,
  };
}

// GH #383 (device-caught): xcodebuild only forwards TEST_RUNNER_-prefixed env
// vars to the XCUITest process (prefix stripped), so the plain var alone never
// reaches RunnerEnv.pluginVersion(). Keep both forms — plain for any direct
// launch path, TEST_RUNNER_ for xcodebuild test.
export function buildRunnerVersionEnv(pluginVersion: string | null): Record<string, string> {
  if (pluginVersion === null) return {};
  return {
    RN_PLUGIN_VERSION: pluginVersion,
    TEST_RUNNER_RN_PLUGIN_VERSION: pluginVersion,
  };
}

// xcodebuild only forwards TEST_RUNNER_-prefixed env vars to the XCUITest
// process (prefix stripped). Keep the plain form for any direct launch path.
export function buildRunnerPortEnv(port: number): Record<string, string> {
  const value = String(port);
  return {
    RN_FAST_RUNNER_PORT: value,
    TEST_RUNNER_RN_FAST_RUNNER_PORT: value,
  };
}

export function buildRunnerAttachOnlyEnv(attachOnly: boolean): Record<string, string> {
  const value = attachOnly ? '1' : '0';
  return {
    RN_RUNNER_ATTACH_ONLY: value,
    TEST_RUNNER_RN_RUNNER_ATTACH_ONLY: value,
  };
}

/**
 * xcodebuild strips TEST_RUNNER_ while forwarding values to XCUITest. Mirror
 * the compile-gated deterministic fault onto that launch contract; released
 * runner binaries contain no matching branch.
 */
export function buildRunnerTestFaultEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = env.TEST_RUNNER_RN_FAST_RUNNER_TEST_FAULT ?? env.RN_FAST_RUNNER_TEST_FAULT;
  if (!value) return {};
  return {
    RN_FAST_RUNNER_TEST_FAULT: value,
    TEST_RUNNER_RN_FAST_RUNNER_TEST_FAULT: value,
  };
}

let runnerTestFaultForwarded = false;

/**
 * GH #424: run a build-phase xcodebuild (build-for-testing) to completion.
 * Unlike the launch invocation it exits on its own and emits no READY marker,
 * so success is exit code 0 — the .xctestrun it writes is what makes every
 * later start warm.
 */
function runXcodebuildToExit(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('xcodebuild', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `xcodebuild ${args[0]} did not complete within ${timeoutMs / 1000}s (cold build — first run compiles the runner)`,
        ),
      );
    }, timeoutMs);
    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(isAbort(err) ? err : new Error(`Failed to spawn xcodebuild: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `xcodebuild ${args[0]} failed (code ${code})${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
          ),
        );
    });
  });
}

export function resolveRunnerRequestedPort(explicitPort?: number): number {
  // Simulator listeners bind in the host network namespace and may occupy an
  // IPv6 wildcard while a 127.0.0.1 IPv4 probe still reports the same number
  // free. Defaulting to NWListener's port 0 is the only race- and
  // address-family-safe allocation when multiple simulators have live runners.
  // The READY handshake reports the actual assigned port back to the client.
  return explicitPort ?? 0;
}

export async function startFastRunner(
  deviceId: string,
  bundleId: string,
  port?: number,
  opts: { forceLocalBuild?: boolean; attachOnly?: boolean } = {},
): Promise<FastRunnerState> {
  throwIfCancelled();
  adoptPersistedFastRunnerState(deviceId);
  if (shouldReuseRunner(runnerState, deviceId)) return runnerState!;
  if (runnerState) await stopFastRunner(deviceId);
  const authority = runnerAuthorityFromEnvironment(true)!;

  const desired = resolveRunnerRequestedPort(port);

  const projectPath = join(FAST_RUNNER_PROJECT, 'RnFastRunner', 'RnFastRunner.xcodeproj');
  if (!existsSync(projectPath)) {
    throw new Error(`RnFastRunner.xcodeproj not found at ${projectPath}.`);
  }

  const artifacts = await resolveIosRunnerArtifacts(
    getPluginVersion(),
    derivedDataPathForRunner(),
    undefined,
    opts.forceLocalBuild,
  );
  throwIfCancelled();
  const derivedDataPath = artifacts.derivedDataPath;
  if (artifacts.note) pendingFastRunnerArtifactNote = artifacts.note;
  const plan = resolveRunnerStartPlan({
    projectPath,
    scheme: 'RnFastRunner',
    deviceId,
    derivedDataPath,
    onlyTesting: 'RnFastRunnerUITests/RnFastRunnerTests/testCommand',
    hasBuiltTestProduct: hasBuiltTestProduct(derivedDataPath),
  });

  for (const step of plan.slice(0, -1)) {
    await runXcodebuildToExit(step.args, BUILD_READY_TIMEOUT_MS);
    if (!hasBuiltTestProduct(derivedDataPath)) {
      throw new Error(
        `xcodebuild ${step.action} completed but left no .xctestrun under ${derivedDataPath}/Build/Products — unexpected DerivedData layout`,
      );
    }
  }
  const launch = plan[plan.length - 1];
  const runnerTestFaultEnv = runnerTestFaultForwarded ? {} : buildRunnerTestFaultEnv(process.env);

  const signal = cancellationSignal();
  return new Promise((resolve, reject) => {
    const child = spawn('xcodebuild', launch.args, {
      env: {
        ...process.env,
        ...buildRunnerPortEnv(desired),
        ...buildRunnerVersionEnv(getPluginVersion()),
        ...buildRunnerAttachOnlyEnv(opts.attachOnly === true),
        ...buildRunnerQuiescenceEnv(process.env),
        ...buildRunnerAuthorityEnv(authority),
        ...buildRunnerTargetEnv(deviceId, bundleId),
        ...runnerTestFaultEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    runnerProcess = child;
    if (child.pid !== undefined) runnerDriverObserver?.(child.pid);
    runnerLaunchCount += 1;
    runnerOutputTail = '';
    lastRunnerCommand = null;
    lastRunnerPostMortem = null;
    const parser = createReadySignalParser();
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signalDriver(child, 'SIGTERM');
      reject(new Error(`Fast runner did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);

    const handleChunk = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      appendRunnerOutput(stream, chunk);
      if (resolved) return;
      if (signal?.aborted) {
        resolved = true;
        clearTimeout(timer);
        if (runnerProcess === child) clearStateFile();
        reject(signal.reason);
        return;
      }
      const result = parser.feed(chunk);
      if (!result) return;
      resolved = true;
      clearTimeout(timer);
      if ('error' in result) {
        reject(new Error(`Fast runner failed to start: ${result.error}`));
        return;
      }
      const state: FastRunnerState = {
        schemaVersion: 1,
        port: result.port,
        pid: child.pid!,
        deviceId,
        bundleId,
        startedAt: new Date().toISOString(),
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion()! } : {}),
        provenance: artifactProvenanceToState(artifacts.provenance),
        ...(result.quiescence !== undefined ? { quiescence: result.quiescence } : {}),
        ...authority,
      };
      const processBirth = readProcessBirth(child.pid!);
      if (!processBirth) {
        signalDriver(child, 'SIGTERM');
        reject(
          new Error(
            'PROCESS_BIRTH_UNAVAILABLE: native runner process identity could not be proven',
          ),
        );
        return;
      }
      state.processBirth = processBirth.token;
      runnerState = state;
      if (Object.keys(runnerTestFaultEnv).length > 0) runnerTestFaultForwarded = true;
      quiescenceAnnouncementPending = true;
      try {
        writeJsonStateFileAtomic(iosStatePath(deviceId), state);
      } catch {
        /* ignore */
      }
      cleanupLegacyTmpState();
      resolve(state);
    };

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => handleChunk(chunk, 'stdout'));

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => handleChunk(chunk, 'stderr'));

    child.on('error', (err) => {
      resolved = true;
      clearTimeout(timer);
      if (runnerProcess === child) {
        clearStateFile();
      }
      reject(isAbort(err) ? err : new Error(`Failed to spawn xcodebuild: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      resolved = true;
      lastRunnerPostMortem = {
        available: true,
        provenance: 'spawned',
        lastCommand: lastRunnerCommand,
        exitCode: code,
        signal,
        outputTail: runnerOutputTail,
      };
      if (runnerProcess === child) {
        clearStateFile();
      }
      clearTimeout(timer);
      reject(
        new Error(`xcodebuild exited unexpectedly (code ${code}, signal ${signal ?? 'none'})`),
      );
    });
  });
}

/** GH #629: launches observed so far — sample across a start to prove one ran. */
export function getRunnerLaunchCount(): number {
  return runnerLaunchCount;
}

/**
 * GH #629: bounded settle before the single first-start retry. The READY
 * timeout SIGTERMs the launch xcodebuild, but its teardown is asynchronous —
 * wait for the child to actually exit (escalating to SIGKILL at the grace
 * cap) so a retry can never stack a second launch on a still-dying first one.
 */
export async function awaitSpawnedRunnerExit(
  graceMs = 5000,
  expectedLaunchCount?: number,
): Promise<boolean> {
  // A concurrent dispatch's start replaces the global handle (and a successful
  // one leaves it live), so signalling it blind would SIGKILL a runner this
  // caller never launched. Only the generation the caller observed is ours; a
  // runner that came up meanwhile is someone else's success, never this
  // caller's retry.
  if (runnerState) return false;
  if (expectedLaunchCount !== undefined && runnerLaunchCount !== expectedLaunchCount) return false;
  return awaitChildExit(runnerProcess, graceMs);
}

export async function awaitChildExit(child: ChildProcess | null, graceMs = 5000): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, graceMs);
    // Backstop: an unkillable zombie must not wedge the caller forever —
    // resolve false so the caller refuses the retry instead of stacking a
    // second launch on a process that provably survived SIGKILL.
    const backstop = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, graceMs + 2000);
    const onExit = (): void => {
      clearTimeout(killTimer);
      clearTimeout(backstop);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

// GH #383 (review amendment): adoption-aware teardown. A post-respawn stop
// (session close, restart, maestro park) would otherwise no-op against empty
// in-memory state and leak the persisted runner — so adopt first, then reap.
export async function stopFastRunner(deviceId?: string, signal?: AbortSignal): Promise<void> {
  adoptPersistedFastRunnerState(deviceId);
  await reapStaleFastRunner({ signal });
}

// Mirrors RN_FAST_RUNNER_APP_BUNDLE_ID in RnFastRunner.xcodeproj.
const RUNNER_HOST_BUNDLE_ID = 'dev.lykhoyda.rndevagent.fastrunner';

// The UI-test host app outlives its xcodebuild parent; the next admission would read it as a foreign driver.
export async function terminateRunnerHost(deviceId?: string): Promise<void> {
  if (!deviceId || !isIosSimulatorUdid(deviceId)) return;
  await promisify(execFile)('xcrun', ['simctl', 'terminate', deviceId, RUNNER_HOST_BUNDLE_ID], {
    timeout: 10_000,
  }).catch((error: { stderr?: unknown }) => {
    if (!/found nothing to terminate/.test(String(error?.stderr ?? ''))) throw error;
  });
}

const RUNNER_TEST_BUNDLE_ID = `${RUNNER_HOST_BUNDLE_ID}.uitests.xctrunner`;
const runnerDataContainers = new Map<string, string>();

export async function captureRunnerScreenshot(
  deviceId: string,
  appId: string,
  destination: string,
): Promise<boolean> {
  if (!isIosSimulatorUdid(deviceId)) return false;
  try {
    const result = await runIOS({
      command: 'screenshot',
      bundleId: appId,
      deviceId,
      qaReadOnly: true,
    });
    if (result.isError) return false;
    const relative = (JSON.parse(result.content[0].text) as { data?: { message?: unknown } }).data
      ?.message;
    if (typeof relative !== 'string' || !/^tmp\/screenshot-\d+\.png$/.test(relative)) return false;
    let container = runnerDataContainers.get(deviceId);
    if (!container) {
      const { stdout } = await promisify(execFile)(
        'xcrun',
        ['simctl', 'get_app_container', deviceId, RUNNER_TEST_BUNDLE_ID, 'data'],
        { timeout: 10_000 },
      );
      container = stdout.trim();
      runnerDataContainers.set(deviceId, container);
    }
    const source = join(container, relative);
    try {
      copyFileSync(source, destination);
    } finally {
      rmSync(source, { force: true });
    }
    return statSync(destination).size > 0;
  } catch {
    runnerDataContainers.delete(deviceId);
    return false;
  }
}

export function clearFastRunnerAfterVerifiedStop(binding: Record<string, unknown>): void {
  const expected = {
    pid: Number(binding.pid),
    processBirth: String(binding.processBirth ?? ''),
    instanceId: String(binding.instanceId ?? ''),
    deviceId: String(binding.deviceId ?? ''),
  };
  if (
    !Number.isSafeInteger(expected.pid) ||
    !expected.processBirth ||
    !expected.instanceId ||
    !expected.deviceId
  ) {
    throw new Error('RUNNER_ADOPTION_REQUIRED: verified runner identity is incomplete');
  }
  const path = iosStatePath(expected.deviceId);
  const persisted = readJsonStateFile<Partial<FastRunnerState>>(path);
  const identityMatches = (observed: Partial<FastRunnerState>): boolean =>
    observed.pid === expected.pid &&
    observed.processBirth === expected.processBirth &&
    observed.instanceId === expected.instanceId &&
    observed.deviceId === expected.deviceId;
  if (
    (runnerState && !identityMatches(runnerState)) ||
    (persisted && !identityMatches(persisted))
  ) {
    throw new Error('RUNNER_ADOPTION_REQUIRED: local runner identity changed before cleanup');
  }
  if (runnerProcess?.pid !== undefined && runnerProcess.pid !== expected.pid) {
    throw new Error('RUNNER_ADOPTION_REQUIRED: local runner process changed before cleanup');
  }
  runnerState = null;
  runnerProcess = null;
  lastKnownCapabilities = [];
  if (persisted !== null) deleteStateFile(path);
}

// --- Legacy helper kept for device-interact.ts swipe path ---
//
// GH #105 iOS-MVP follow-up: the upstream agent-device runner exposed
// per-verb HTTP endpoints (/tap, /swipe, /snapshot, /screenshot, …).
// Our in-tree RnFastRunner only exposes a single POST /command with
// {command: '...', ...payload}. The unused fastTap/fastType/fastSnapshot/
// fastScreenshot/fastDismissKeyboard helpers were dead code post-Task 8 —
// dropped. fastSwipe still has callers in device-interact.ts so it stays,
// but now composes the right /command shape: a coordinate-based gesture
// uses the runner's `.drag` case (`.swipe` is tvOS-only per the Swift handler).

interface FastRunnerResponse {
  ok: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

export async function fastSwipe(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs?: number,
  bundleId?: string,
  qaContext?: QaDispatchContext,
  deviceId?: string,
): Promise<FastRunnerResponse> {
  if (qaContext) await requireQaFastRunner(qaContext, bundleId, deviceId);
  const body: Record<string, unknown> = { command: 'drag', x: x1, y: y1, x2, y2 };
  if (durationMs != null) body.durationMs = durationMs;
  // Without appBundleId the runner's executeOnMain clears its target and
  // activates the RnFastRunner HOST app — the drag then lands on the host's
  // blank screen (ok:true, zero movement) and steals foreground from the
  // target (#387 Phase B device-proven).
  if (bundleId) body.appBundleId = bundleId;
  const authority = captureFastRunnerCommandAuthority();
  try {
    const resp = await postCommand(body, qaContext);
    checkQaNativeOutcome(
      qaContext,
      resp.error?.code,
      resp.data,
      resp.error?.reason,
      resp.error?.mutation,
    );
    if (qaContext && !resp.ok && resp.error?.code === 'RUNNER_TIMEOUT') {
      await containRunnerTimeout('drag', resp.error.message ?? 'RUNNER_TIMEOUT', authority);
      qaContext.refuse('ACTION_OUTCOME_UNCERTAIN');
    }
    return resp as unknown as FastRunnerResponse;
  } catch (error) {
    throwIfCancelled();
    if (error instanceof QaDispatchError) throw error;
    if (qaContext) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('RUNNER_TIMEOUT'))
        await containRunnerTimeout('drag', message, authority);
      qaContext.refuse('ACTION_OUTCOME_UNCERTAIN');
    }
    throw error;
  }
}

// --- Health check ---

export async function fastHealthCheck(): Promise<boolean> {
  if (!runnerState) return false;
  try {
    const result = await defaultHttpProbe(runnerState.port, 2000);
    return result.ok && result.status === 200 && result.bodyOk === true;
  } catch {
    throwIfCancelled();
    return false;
  }
}

// ─── M7 / Phase 109: tri-state liveness probe ──────────────────────────
//
// Prior art: isFastRunnerAvailable() above only checks PID via
// process.kill(pid, 0). A process whose PID is alive but whose HTTP
// server has hung (crashed listener, wedged XCTest thread) would be
// reported as available, and every device_press then stalled on a
// 10s fetch timeout before falling back to the daemon.
//
// The tri-state distinction:
//   'alive' — PID lives AND /health returns {ok:true}. Happy path.
//   'stale' — PID lives but /health times out / 500s / ok:false.
//             Must be reaped before a fresh startFastRunner.
//   'dead'  — PID doesn't exist (or no state file). Cold-launch OK.
//
// Separation of concerns: the probe is read-only (clears state only
// on 'dead' discovery, never mutates a living process). The reap
// helper is the explicit action — SIGTERM, wait 500ms, SIGKILL if
// still alive. Callers compose: probe → (stale ? reap : …) → act.

export type FastRunnerLiveness = 'alive' | 'stale' | 'dead';

export interface StateSnapshot {
  pid: number;
  port: number;
  deviceId: string;
  bundleId: string;
  /** Learned from /health; the spawn-time stamp is only the bridge's own version. */
  protocolVersion?: number;
  instanceId?: string;
  sessionId?: string;
  claimEpoch?: number;
  processBirth?: string;
}

export interface HttpProbeResult {
  ok: boolean;
  status: number;
  bodyOk?: boolean;
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

export interface LivenessProbeDeps {
  /** Defaults to the module singleton. Tests inject a fake snapshot. */
  getState?: () => StateSnapshot | null;
  /** Defaults to `process.kill(pid, 0)` guard. */
  processAlive?: (pid: number) => boolean;
  /** Defaults to GET /health over IPv6 loopback with the timeout. */
  httpProbe?: (port: number, timeoutMs: number) => Promise<HttpProbeResult>;
  /** Called when probe discovers 'dead' state. Defaults to the real teardown. */
  clearState?: () => void;
  /** HTTP probe timeout in ms. Default 2000 (matches existing fastHealthCheck). */
  timeoutMs?: number;
  /** GH #383: injected plugin version for hermetic tests; undefined → getPluginVersion(). */
  pluginVersion?: string | null;
}

export interface ReapDeps {
  getState?: () => StateSnapshot | null;
  processAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, sig: NodeJS.Signals) => void;
  matchesProcessBirth?: (expected: { pid: number; token: string }) => boolean;
  probeProcessBirth?: (pid: number) => ProcessBirthProbe;
  sleep?: (ms: number) => Promise<void>;
  clearState?: (expected: StateSnapshot) => void;
  /** Time to wait between SIGTERM and SIGKILL escalation. Default 500ms. */
  graceMs?: number;
  signal?: AbortSignal;
}

async function reapDelay(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    sleep(ms).then(finish, (error: unknown) => {
      signal.removeEventListener('abort', finish);
      reject(error);
    });
  });
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultHttpProbe(
  port: number,
  timeoutMs: number,
  capabilityOverride?: string,
): Promise<HttpProbeResult> {
  // Use the same IPv4 loopback as the /command client (postCommand). The prior
  // [::1] here meant the health probe and the command channel could resolve to
  // different stacks, so a healthy IPv4 listener looked dead over IPv6.
  const url = `http://127.0.0.1:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // fetchImpl (not bare fetch) so the _setFetchForTest seam covers the health
    // probe like every other client call — production default is globalThis.fetch.
    const capability =
      capabilityOverride ?? (runnerState?.port === port ? runnerState.capability : undefined);
    const res = await cancellableFetch(fetchImpl, url, {
      signal: controller.signal,
      headers: capability ? { authorization: `Bearer ${capability}` } : {},
    });
    if (!res.ok) return { ok: false, status: res.status };
    let bodyOk: boolean | undefined;
    let protocolVersion: number | undefined;
    let runnerVersion: string | undefined;
    let capabilities: string[] | undefined;
    let commands: string[] | undefined;
    let instanceId: string | undefined;
    let sessionId: string | undefined;
    let claimEpoch: number | undefined;
    let deviceId: string | undefined;
    let appId: string | undefined;
    try {
      const body = (await res.json()) as {
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
      bodyOk = body.ok === true;
      if (typeof body.protocolVersion === 'number') protocolVersion = body.protocolVersion;
      if (typeof body.runnerVersion === 'string') runnerVersion = body.runnerVersion;
      if (Array.isArray(body.capabilities)) {
        capabilities = body.capabilities.filter((c): c is string => typeof c === 'string');
      }
      if (Array.isArray(body.commands)) {
        commands = body.commands.filter((c): c is string => typeof c === 'string');
      }
      if (typeof body.instanceId === 'string') instanceId = body.instanceId;
      if (typeof body.sessionId === 'string') sessionId = body.sessionId;
      if (typeof body.claimEpoch === 'number') claimEpoch = body.claimEpoch;
      if (typeof body.deviceId === 'string') deviceId = body.deviceId;
      if (typeof body.appId === 'string') appId = body.appId;
    } catch {
      throwIfCancelled();
      bodyOk = false;
    }
    return {
      ok: true,
      status: res.status,
      bodyOk,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(runnerVersion !== undefined ? { runnerVersion } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(commands !== undefined ? { commands } : {}),
      ...(instanceId !== undefined ? { instanceId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(claimEpoch !== undefined ? { claimEpoch } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(appId !== undefined ? { appId } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeFastRunnerAuthority(input: {
  port: number;
  capability: string;
  instanceId: string;
  sessionId: string;
  claimEpoch: number;
  deviceId: string;
  appId: string;
}): Promise<boolean> {
  try {
    const result = await defaultHttpProbe(input.port, 2_000, input.capability);
    return (
      result.ok &&
      result.status === 200 &&
      result.bodyOk === true &&
      result.instanceId === input.instanceId &&
      result.sessionId === input.sessionId &&
      result.claimEpoch === input.claimEpoch &&
      result.deviceId === input.deviceId &&
      result.appId === input.appId
    );
  } catch {
    return false;
  }
}

function clearStateFile(): void {
  // GH #383: capture the per-device path before nulling so the right hardened
  // state file is removed (the /tmp singleton is gone).
  const path = runnerState ? iosStatePath(runnerState.deviceId) : null;
  runnerState = null;
  lastKnownCapabilities = [];
  // M7 review (Gemini): null the child-process handle too. Previously a reap
  // left `runnerProcess` pointing at a dead PID; the on('exit') handler would
  // eventually self-heal, but during the window a concurrent stopFastRunner
  // could signal an already-dead process. Clearing here is defensive.
  runnerProcess = null;
  if (path) deleteStateFile(path);
}

function clearStateFileIfMatches(expected: StateSnapshot): void {
  const identityMatches = (observed: Partial<FastRunnerState>): boolean =>
    observed.pid === expected.pid &&
    observed.deviceId === expected.deviceId &&
    observed.processBirth === expected.processBirth;
  const path = iosStatePath(expected.deviceId);
  const persisted = readJsonStateFile<Partial<FastRunnerState>>(path);
  let clearedCurrent = false;
  if (runnerState && identityMatches(runnerState)) {
    runnerState = null;
    clearedCurrent = true;
  }
  if (runnerProcess?.pid === expected.pid) {
    runnerProcess = null;
    clearedCurrent = true;
  }
  if (persisted && identityMatches(persisted)) deleteStateFile(path);
  if (clearedCurrent) lastKnownCapabilities = [];
}

export type FastRunnerStaleReason = 'health' | 'authority-mismatch' | RunnerIncompatibilityReason;

export interface FastRunnerLivenessDetail {
  liveness: FastRunnerLiveness;
  staleReason?: FastRunnerStaleReason;
  runnerProtocolVersion?: number;
  runnerVersion?: string;
  capabilities?: string[];
  /** GH #418: set only when staleReason === 'missing-commands'. */
  missingCommands?: string[];
  /** GH #656: set only when staleReason === 'missing-features'. */
  missingFeatures?: string[];
}

export async function probeFastRunnerLivenessDetailed(
  deps: LivenessProbeDeps = {},
): Promise<FastRunnerLivenessDetail> {
  const getState = deps.getState ?? (() => runnerState);
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const httpProbe = deps.httpProbe ?? defaultHttpProbe;
  const clearState = deps.clearState ?? clearStateFile;
  const timeoutMs = deps.timeoutMs ?? 2000;

  const state = getState();
  if (!state) return { liveness: 'dead' };

  if (!processAlive(state.pid)) {
    clearState();
    return { liveness: 'dead' };
  }

  try {
    const res = await httpProbe(state.port, timeoutMs);
    if (!(res.ok && res.status === 200 && res.bodyOk === true)) {
      lastKnownCapabilities = [];
      return { liveness: 'stale', staleReason: 'health' };
    }
    if (
      state.sessionId !== undefined &&
      (res.instanceId !== state.instanceId ||
        res.sessionId !== state.sessionId ||
        res.claimEpoch !== state.claimEpoch ||
        res.deviceId !== state.deviceId ||
        res.appId !== state.bundleId)
    ) {
      lastKnownCapabilities = [];
      return { liveness: 'stale', staleReason: 'authority-mismatch' };
    }
    const plugin = deps.pluginVersion !== undefined ? deps.pluginVersion : getPluginVersion();
    const compat = classifyRunnerCompatibility(
      {
        ...(res.protocolVersion !== undefined ? { protocolVersion: res.protocolVersion } : {}),
        ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
        ...(res.commands !== undefined ? { commands: res.commands } : {}),
        ...(res.capabilities !== undefined ? { capabilities: res.capabilities } : {}),
      },
      plugin,
      REQUIRED_IOS_COMMANDS,
      REQUIRED_IOS_FEATURES,
    );
    if (!compat.compatible) {
      lastKnownCapabilities = [];
      return {
        liveness: 'stale',
        staleReason: compat.reason,
        ...(compat.missing !== undefined && compat.reason === 'missing-commands'
          ? { missingCommands: compat.missing }
          : {}),
        ...(compat.missing !== undefined && compat.reason === 'missing-features'
          ? { missingFeatures: compat.missing }
          : {}),
        ...(res.protocolVersion !== undefined
          ? { runnerProtocolVersion: res.protocolVersion }
          : {}),
        ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
      };
    }
    lastKnownCapabilities = res.capabilities ?? [];
    noteStaleHittableArtifact(res.capabilities);
    // startFastRunner stamps the bridge's own RUNNER_PROTOCOL_VERSION optimistically;
    // /health is the only place the artifact's real wire version is learned. Without
    // writing it back, a compatible v1 runner reads as v2 and the client-side
    // dismiss-first fallback that v1 requires is silently skipped.
    if (typeof res.protocolVersion === 'number') {
      state.protocolVersion = res.protocolVersion;
    }
    return {
      liveness: 'alive',
      ...(res.protocolVersion !== undefined ? { runnerProtocolVersion: res.protocolVersion } : {}),
      ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
      ...(res.capabilities !== undefined ? { capabilities: res.capabilities } : {}),
    };
  } catch {
    throwIfCancelled();
    lastKnownCapabilities = [];
    return { liveness: 'stale', staleReason: 'health' };
  }
}

export async function probeFastRunnerLiveness(
  deps: LivenessProbeDeps = {},
): Promise<FastRunnerLiveness> {
  return (await probeFastRunnerLivenessDetailed(deps)).liveness;
}

export async function reapStaleFastRunner(deps: ReapDeps = {}): Promise<void> {
  const getState = deps.getState ?? (() => runnerState);
  const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = deps.sleep ?? cancellableSleep;
  const clearState = deps.clearState ?? clearStateFileIfMatches;
  const graceMs = deps.graceMs ?? 500;

  const state = getState();
  if (!state) return;
  const expectedBirth =
    typeof state.processBirth === 'string' ? { pid: state.pid, token: state.processBirth } : null;
  if (!expectedBirth) {
    const observed = deps.probeProcessBirth
      ? deps.probeProcessBirth(state.pid)
      : deps.processAlive
        ? deps.processAlive(state.pid)
          ? { status: 'present' as const }
          : { status: 'absent' as const }
        : probeProcessBirth(state.pid);
    if (observed.status === 'absent') {
      clearState(state);
      return;
    }
    throw new Error(
      'RUNNER_ADOPTION_REQUIRED: live persisted iOS runner lacks process-birth authority',
    );
  }
  const probeExpected = (): 'match' | 'gone' | 'unknown' => {
    if (deps.probeProcessBirth) {
      const observed = deps.probeProcessBirth(expectedBirth.pid);
      if (observed.status === 'unknown') return 'unknown';
      if (observed.status === 'absent') return 'gone';
      return observed.birth.token === expectedBirth.token ? 'match' : 'gone';
    }
    if (deps.matchesProcessBirth) {
      return deps.matchesProcessBirth(expectedBirth) ? 'match' : 'gone';
    }
    const observed = probeProcessBirth(expectedBirth.pid);
    if (observed.status === 'unknown') return 'unknown';
    if (observed.status === 'absent') return 'gone';
    return observed.birth.token === expectedBirth.token ? 'match' : 'gone';
  };
  const initial = probeExpected();
  if (initial === 'unknown') {
    throw new Error('RUNNER_ADOPTION_REQUIRED: iOS runner process identity is unproven');
  }
  if (initial === 'gone') {
    clearState(state);
    return;
  }
  const spawnedChild = runnerProcess?.pid === state.pid ? runnerProcess : null;
  const spawnedExit = spawnedChild
    ? new Promise<void>((resolve) => spawnedChild.once('exit', () => resolve()))
    : null;

  // This core's own driver leads its group, so its helpers go with it.
  const signalRunner = (signal: NodeJS.Signals): void => {
    if (spawnedChild) {
      try {
        sendSignal(-state.pid, signal);
        return;
      } catch {
        // No such group: fall back to the leader alone.
      }
    }
    sendSignal(state.pid, signal);
  };
  try {
    signalRunner('SIGTERM');
  } catch {
    /* already dead */
  }
  await interruptible(() => reapDelay(sleep, graceMs, deps.signal));
  const afterTerm = probeExpected();
  if (afterTerm === 'unknown') {
    throw new Error('RUNNER_ADOPTION_REQUIRED: iOS runner termination is unproven');
  }
  if (afterTerm === 'gone') {
    clearState(state);
    return;
  }
  try {
    signalRunner('SIGKILL');
  } catch {
    /* race: died between checks */
  }
  if (spawnedExit) {
    await Promise.race([spawnedExit, sleep(250)]);
  } else {
    await sleep(50);
  }
  const afterKill = probeExpected();
  if (afterKill !== 'gone') {
    throw new Error('RUNNER_ADOPTION_REQUIRED: iOS runner termination is unproven');
  }
  clearState(state);
}

// ─── /command HTTP client + runIOS() — used by the iOS short-circuit ────
//
// The imported rn-fast-runner accepts a single endpoint, POST /command,
// with JSON body `{ command: <CommandType>, appBundleId?, x?, y?, text?, ... }`.
// Snapshots return `data: { nodes: [...] }` (flat — already includes
// parentIndex/depth), NOT a nested tree. So the snapshot path here maps
// runner SnapshotNodes → FlatNode and calls updateRefMapFromFlat() so
// subsequent press/fill via runAgentDevice('press @e3') can resolve refs.

export interface RunIOSArgs {
  qaTiming?: TimingContext;
  qaContext?: QaDispatchContext;
  qaReadOnly?: boolean;
  deviceId?: string;
  command:
    | 'snapshot'
    | 'tap'
    | 'swipe'
    | 'drag'
    | 'longPress'
    | 'pinch'
    | 'findText'
    | 'type'
    | 'verifyInput'
    | 'systemAlertTap'
    | 'keyboardDismiss'
    | 'isScreenStatic'
    | 'screenshot'
    | 'back'
    | 'scroll'
    | 'pressHome'
    | 'appState'
    | 'activate'
    | 'status'
    | 'terminate';
  bundleId?: string;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  /** Exact-fill descriptor resolved afresh by the runner within one command. */
  exactIdentifier?: string;
  exactType?: string;
  durationMs?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  scale?: number;
  platformPresence?: boolean;
  presenceBudgetMs?: number;
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  scope?: string;
  /** Optional per-character delay for explicit native type commands. */
  delayMs?: number;
  /** Clear before an explicit native type command. */
  clearFirst?: boolean;
  /**
   * Internal sentinel: when buildRunIOSArgs() in agent-device-wrapper resolves
   * a @ref via refCenter() and gets back null (snapshot stale), it injects
   * the ref here so runIOS() returns a STALE_REF failResult with cached
   * metadata + a hint to refresh. Production callers should never set this
   * directly.
   */
  _staleRef?: string;
  /** Ref identity retained client-side for post-keyboard relayout resolution. */
  _targetRef?: string;
  targetBounds?: { x: number; y: number; width: number; height: number };
  snapshotGeneration?: number;
  snapshotNodeIndex?: number;
  snapshotElementType?: string;
  snapshotLabel?: string;
  snapshotIdentifier?: string;
  keyboardStateAtSnapshot?: boolean;
  /** GH #581: declared focus-tap point for exact `type` (wrapper center for Pressable-wrapped inputs). */
  focusX?: number;
  focusY?: number;
  focusWaitMs?: number;
  /** Type into the first responder instead of binding an input. */
  focused?: boolean;
  _focusedProof?: () => Promise<boolean>;
  operationToken?: string;
  /** Independent CDP/helper readback; never serialized onto the runner wire. */
  _verifyExactReadback?: (
    expected: string,
  ) => Promise<{ matches: boolean; actual?: string | null }>;
}

interface RunnerResponse {
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string; mutation?: string; reason?: string };
  v?: number;
}

interface RunnerSnapshotNode {
  presence?: unknown;
  index?: number;
  parentIndex?: number;
  depth?: number;
  type?: string;
  label?: string;
  value?: string;
  identifier?: string;
  rect?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  hittable?: boolean;
  selected?: boolean;
}

let fetchImpl: typeof fetch = globalThis.fetch;

export function _setFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

// Test seam: override the per-command timeout so the abort path can be
// exercised without waiting the full production window.
let httpTimeoutOverrideMs: number | null = null;
export function _setHttpTimeoutForTest(ms: number | null): void {
  httpTimeoutOverrideMs = ms;
}

// `type` and `snapshot` legitimately run long (the runner's typeText
// quiescence shim can sit up to its own 30s main-thread timeout before
// returning the success-shaped message we depend on, and large trees take a
// while to serialize), so they get a window wider than that internal cap.
// Everything else is a fast interaction and must not hang past HTTP_TIMEOUT_MS.
const SLOW_RUNNER_COMMANDS = new Set(['type', 'verifyInput', 'snapshot', 'screenshot']);
function commandTimeoutMs(command: unknown): number {
  if (httpTimeoutOverrideMs !== null) return httpTimeoutOverrideMs;
  return SLOW_RUNNER_COMMANDS.has(command as string) ? 35_000 : HTTP_TIMEOUT_MS;
}

async function sendCommandOnce(
  port: number,
  body: { command?: unknown; commandId?: string },
  timeoutMs: number,
  qaContext?: QaDispatchContext,
  qaTiming?: TimingContext,
  focusedProof?: () => Promise<boolean>,
): Promise<RunnerResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const capability = runnerState?.port === port ? runnerState.capability : undefined;
    if (!capability) {
      throw new Error('RUNNER_OWNERSHIP_MISMATCH: runner capability is unavailable');
    }
    const serialized = JSON.stringify(body);
    const now = qaTiming?.now ?? (() => performance.now());
    const resp = await measureTiming(qaTiming?.observe, now, 'native-transport', async () => {
      if (focusedProof && !(await focusedProof())) return undefined;
      if (isMutatingCommand(body.command)) qaContext?.authorize();
      return cancellableFetch(fetchImpl, `http://127.0.0.1:${port}/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${capability}`,
        },
        body: serialized,
        signal: controller.signal,
      });
    });
    if (!resp)
      return {
        ok: false,
        error: {
          code: 'NO_TEXT_INPUT_TARGET',
          message: 'The intended input is not focused; no text was entered.',
          mutation: 'none',
          reason: 'focus-proof-refused',
        },
      };
    const parsed = (await measureTiming(qaTiming?.observe, now, 'native-decode', () =>
      resp.json(),
    )) as RunnerResponse;
    // GH #383: defense-in-depth — the liveness gate already reaps a
    // protocol-mismatched runner, but a runner that flipped protocol mid-session
    // (hot-swapped binary) is caught here on the /command reply's `v` stamp.
    if (
      typeof parsed.v === 'number' &&
      (parsed.v < MIN_SUPPORTED_RUNNER_PROTOCOL || parsed.v > RUNNER_PROTOCOL_VERSION)
    ) {
      throw new Error(
        `RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v${parsed.v}, bridge supports v${MIN_SUPPORTED_RUNNER_PROTOCOL}..${RUNNER_PROTOCOL_VERSION}`,
      );
    }
    return parsed;
  } catch (err) {
    throwIfCancelled();
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      throw new Error(
        `RUNNER_TIMEOUT: rn-fast-runner did not respond to "${String(body.command)}" within ${timeoutMs}ms — listener may be wedged`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface TransportRecovery {
  commandId: string;
  outcome: 'recovered' | 'recovered-error' | 'resent';
}

const STATUS_PROBE_TIMEOUT_MS = 2000;

async function probeCommandStatus(
  port: number,
  commandId: string,
  qaTiming?: TimingContext,
): Promise<ReturnType<typeof parseStatusProbeReply>> {
  try {
    const resp = await sendCommandOnce(
      port,
      { command: 'status', commandId },
      STATUS_PROBE_TIMEOUT_MS,
      undefined,
      qaTiming,
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
// unresolvable probe falls through to the existing invalidation path.
// Recovery info travels in the return value so callers that don't surface
// meta (fastSwipe, settle probes) discard it with the response.
async function postCommandWithRecovery(
  body: {
    command?: unknown;
    [key: string]: unknown;
  },
  qaContext?: QaDispatchContext,
  qaTiming?: TimingContext,
  focusedProof?: () => Promise<boolean>,
): Promise<{ resp: RunnerResponse; recovery?: TransportRecovery }> {
  if (runnerPoisoned && body.command !== 'status') {
    throw new Error(
      'RUNNER_TIMEOUT: rn-fast-runner is poisoned after a non-cancellable main-thread timeout; command refused before dispatch while the runner is reaped',
    );
  }
  const state = runnerState;
  if (!state) {
    throw new Error(
      'rn-fast-runner not started — run `device_snapshot action=open appId=<your.app.id> platform=ios` first (auto-spawns the runner).',
    );
  }
  const commandId = generateCommandId();
  lastRunnerCommand = typeof body.command === 'string' ? body.command : String(body.command);
  const timeoutMs = commandTimeoutMs(body.command);
  try {
    return {
      resp: await sendCommandOnce(
        state.port,
        { ...body, commandId },
        timeoutMs,
        qaContext,
        qaTiming,
        focusedProof,
      ),
    };
  } catch (err) {
    throwIfCancelled();
    if (err instanceof QaDispatchError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!isAmbiguousTransportFailure(message)) throw err;
    const decision = decideRecovery(
      await probeCommandStatus(state.port, commandId, qaTiming),
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
        state.port,
        { ...body, commandId: generateCommandId() },
        timeoutMs,
        qaContext,
        qaTiming,
        focusedProof,
      );
      return { resp: resent, recovery: { commandId, outcome: 'resent' } };
    }
    throw err;
  }
}

async function postCommand(
  body: {
    command?: unknown;
    [key: string]: unknown;
  },
  qaContext?: QaDispatchContext,
): Promise<RunnerResponse> {
  return (await postCommandWithRecovery(body, qaContext)).resp;
}

/**
 * Convert a runner SnapshotNode array (flat, already indexed) → FlatNode[]
 * for the ref-map. Each runner node gets a synthetic ref `@e<index>` so
 * downstream press/fill can target it.
 */
async function containTypeTimeout(
  args: RunIOSArgs,
  authorityBefore: FastRunnerCommandAuthority | null = captureFastRunnerCommandAuthority(),
  trigger: 'main-thread-timeout' | 'post-settle-runner-authority-lost' = 'main-thread-timeout',
): Promise<ToolResult> {
  // Poison before any asynchronous readback: concurrently queued mutators are
  // refused at postCommandWithRecovery and cannot reach this XCTest instance.
  const runnerBefore = authorityBefore;
  runnerPoisoned = true;
  poisonHolders++;
  let verification: { matches: boolean; actual?: string | null } = { matches: false };
  try {
    if (args._verifyExactReadback && typeof args.text === 'string') {
      verification = await args._verifyExactReadback(args.text);
    }
  } catch {
    verification = { matches: false };
  }

  let reapDisposition: 'reaped' | 'already-absent' | 'replacement-preserved';
  try {
    if (runnerBefore && runnerState?.pid === runnerBefore.pid) {
      poisonReap ??= reapStaleFastRunner();
      await poisonReap;
      reapDisposition = 'reaped';
    } else {
      // A concurrent health gate may already have reaped the triggering runner
      // and even spawned its replacement. Never signal that replacement merely
      // because the prior command's authority was lost.
      reapDisposition = runnerState ? 'replacement-preserved' : 'already-absent';
    }
  } finally {
    poisonHolders--;
    if (poisonHolders <= 0) {
      poisonHolders = 0;
      poisonReap = null;
      runnerPoisoned = false;
    }
  }
  const runnerTimeoutRecovery = {
    trigger,
    poisoned: true,
    reaped: reapDisposition === 'reaped',
    reapDisposition,
    verification: verification.matches ? 'exact-readback' : 'unverified',
    runner: {
      before: runnerBefore,
      afterReapPid: runnerState?.pid ?? null,
      stateCleared: runnerState === null,
      nextMutationRequiresRespawn: runnerState === null,
    },
    runnerPostMortem: getRunnerPostMortem(),
    containmentOrder: ['poison', 'independent-readback', 'reap', 'result'],
    lateMutationContainment:
      reapDisposition === 'reaped'
        ? 'runner-process-reaped-before-next-mutation'
        : reapDisposition === 'replacement-preserved'
          ? 'replacement-preserved-no-signal-dispatched'
          : 'triggering-runner-state-already-absent',
    targetApp: {
      wasRunningBeforeRecovery: 'unverified',
      pidPreserved: 'unverified',
      activateLaunchedApp: 'unverified',
      semantics: 'runner host is lazily relaunched; target activation semantics are unchanged',
    },
    // GH #581: never carry the actual field value — the verdict alone ships.
  };
  if (verification.matches) {
    return okResult(
      {
        typed: true,
        recovered: true,
        verification: 'exact-readback',
      },
      { meta: { runnerTimeoutRecovery } },
    );
  }
  return failResult(
    trigger === 'main-thread-timeout'
      ? 'RUNNER_TIMEOUT: rn-fast-runner main-thread execution timed out and independent exact CDP readback did not prove the requested value. The poisoned runner was contained before any further mutation.'
      : 'RUNNER_TIMEOUT: rn-fast-runner authority was lost after a success-shaped type response, and independent exact CDP readback did not prove the requested value. The triggering runner was contained without signaling any replacement.',
    'RUNNER_TIMEOUT',
    { mutation: 'possible', runnerTimeoutRecovery },
  );
}

async function containRunnerTimeout(
  command: unknown,
  message: string,
  authorityBefore: FastRunnerCommandAuthority | null = captureFastRunnerCommandAuthority(),
): Promise<ToolResult> {
  runnerPoisoned = true;
  poisonHolders++;
  let reapDisposition: 'reaped' | 'already-absent' | 'replacement-preserved';
  try {
    if (authorityBefore && runnerState?.pid === authorityBefore.pid) {
      poisonReap ??= reapStaleFastRunner();
      await poisonReap;
      reapDisposition = 'reaped';
    } else {
      reapDisposition = runnerState ? 'replacement-preserved' : 'already-absent';
    }
  } finally {
    poisonHolders--;
    if (poisonHolders <= 0) {
      poisonHolders = 0;
      poisonReap = null;
      runnerPoisoned = false;
    }
  }
  return failResult(message, 'RUNNER_TIMEOUT', {
    runnerTimeoutRecovery: {
      trigger: 'main-thread-timeout',
      command: String(command),
      poisoned: true,
      reaped: reapDisposition === 'reaped',
      reapDisposition,
      runner: {
        before: authorityBefore,
        afterReapPid: runnerState?.pid ?? null,
        stateCleared: runnerState === null,
        nextMutationRequiresRespawn: runnerState === null,
      },
      containmentOrder: ['poison', 'reap', 'result'],
    },
  });
}

function hasRunnerTimeoutRecovery(result: ToolResult): boolean {
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
      meta?: { runnerTimeoutRecovery?: unknown };
    };
    return envelope.meta?.runnerTimeoutRecovery !== undefined;
  } catch {
    return false;
  }
}

/**
 * A success-shaped native type reply is not authoritative if the XCTest runner
 * wedges, disappears, or is replaced before post-mutation settling finishes.
 * Re-check the exact dispatch authority and /health after settle; only exact
 * independent readback may recover such a result to success.
 */
const POST_SETTLE_HEALTH_ATTEMPTS = 2;
const POST_SETTLE_HEALTH_RETRY_MS = 250;

export async function verifyTypeResultAfterSettle(
  args: RunIOSArgs,
  result: ToolResult,
  authorityBefore: FastRunnerCommandAuthority | null,
): Promise<ToolResult> {
  if (args.command !== 'type' || result.isError || hasRunnerTimeoutRecovery(result)) return result;
  const sameAuthority =
    authorityBefore !== null &&
    runnerState?.pid === authorityBefore.pid &&
    runnerState.port === authorityBefore.port &&
    runnerState.deviceId === authorityBefore.deviceId;
  if (sameAuthority) {
    // A single probe right after a heavy type+settle can time out transiently;
    // only a repeated non-alive verdict is evidence of lost authority.
    for (let attempt = 0; attempt < POST_SETTLE_HEALTH_ATTEMPTS; attempt += 1) {
      const health = await probeFastRunnerLivenessDetailed();
      if (health.liveness === 'alive') return result;
      if (attempt < POST_SETTLE_HEALTH_ATTEMPTS - 1) {
        await cancellableSleep(POST_SETTLE_HEALTH_RETRY_MS);
      }
    }
  }
  const contained = await containTypeTimeout(
    args,
    authorityBefore,
    'post-settle-runner-authority-lost',
  );
  args.qaContext?.invalidate();
  return contained;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function mapRunnerNodesToFlat(
  nodes: RunnerSnapshotNode[],
  privateValues = false,
): (FlatNode & { value?: string })[] {
  const out: (FlatNode & { value?: string })[] = [];
  const nativeIndices = new Set<number>();
  let synthCounter = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    const refId = n.index !== undefined ? `e${n.index}` : `e${synthCounter++}`;
    const flat: FlatNode & { value?: string } = {
      ref: `@${refId}`,
      type: n.type ?? '',
      rect: n.rect,
    };
    if (isNonNegativeSafeInteger(n.index)) flat.index = n.index;
    if (isNonNegativeSafeInteger(n.depth)) flat.depth = n.depth;
    if (
      isNonNegativeSafeInteger(n.parentIndex) &&
      flat.index !== undefined &&
      n.parentIndex < flat.index &&
      nativeIndices.has(n.parentIndex)
    ) {
      flat.parentIndex = n.parentIndex;
    }
    if (flat.index !== undefined) nativeIndices.add(flat.index);
    if (Object.hasOwn(n, 'presence')) flat.presence = n.presence;
    if (n.label !== undefined) flat.label = n.label;
    if (privateValues && typeof n.value === 'string') flat.value = n.value;
    if (n.identifier !== undefined) flat.identifier = n.identifier;
    if (n.enabled !== undefined) flat.enabled = n.enabled;
    if (n.hittable !== undefined) flat.hittable = n.hittable;
    if (n.selected === true) flat.selected = true;
    out.push(flat);
  }
  return out;
}

function staleAfterKeyboardDismissal(ref: string | undefined): ToolResult {
  return failResult(
    `Element at ref ${ref ?? '?'} could not be re-resolved by identity after the keyboard was dismissed — no tap was performed`,
    'STALE_REF',
    {
      keyboardGuard: 'auto_dismissed',
      reResolved: false,
      cachedMetadata: ref ? getCachedMetadata(ref) : null,
      reResolution: 'no-signature',
      candidates: [],
      hint: 'The keyboard was dismissed successfully; the ref no longer identifies the same element. Call device_snapshot action=snapshot and retry with the new ref.',
    },
  );
}

function presenceCaptureUnavailable(
  reason: string,
  code: ToolErrorCode = 'RN_FAST_RUNNER_DOWN',
  dispatched = false,
): ToolResult {
  return failResult(
    `Platform presence capture unavailable: ${reason}; no recovery attempted.`,
    code,
    {
      capture: 'unknown',
      mutation: 'none',
      dispatched,
    },
  );
}

async function probeQaReadiness(
  qaTiming: TimingContext | undefined,
  count: number,
): Promise<FastRunnerLivenessDetail> {
  let alive = false;
  return measureTiming(
    qaTiming &&
      ((event) =>
        observeTiming(qaTiming.observe, {
          ...event,
          count,
          ...(event.edge === 'end' ? { outcome: alive ? 'ok' : 'failed' } : {}),
        })),
    qaTiming?.now ?? (() => performance.now()),
    'native-readiness',
    async () => {
      const readiness = await probeFastRunnerLivenessDetailed({ clearState: () => {} });
      alive = readiness.liveness === 'alive';
      return readiness;
    },
  );
}

function attestQaReadOnly(
  qaTiming: TimingContext | undefined,
  state: FastRunnerState,
  readiness: FastRunnerLivenessDetail,
  count: number,
): void {
  if (!qaTiming) return;
  const attested =
    runnerState === state &&
    !runnerPoisoned &&
    readiness.liveness === 'alive' &&
    readiness.capabilities?.includes(QA_READ_ONLY_CAPABILITY) &&
    !!state.instanceId &&
    !!state.sessionId &&
    Number.isSafeInteger(state.claimEpoch) &&
    !!state.deviceId &&
    !!state.bundleId;
  observeTiming(qaTiming.observe, {
    stage: 'native-read-only-v1',
    edge: 'point',
    outcome: attested ? 'ok' : 'unknown',
    at: qaTiming.now(),
    count,
  });
}

async function requireQaFastRunner(
  qaContext?: QaDispatchContext,
  bundleId?: string,
  deviceId?: string,
  readOnly = false,
  qaTiming?: TimingContext,
): Promise<void> {
  qaContext?.assertComplete();
  const before = runnerState;
  const readiness = await probeQaReadiness(qaTiming, 1);
  if (
    !before ||
    runnerState !== before ||
    runnerPoisoned ||
    readiness.liveness !== 'alive' ||
    (readOnly && !readiness.capabilities?.includes(QA_READ_ONLY_CAPABILITY)) ||
    (bundleId !== undefined && before.bundleId !== bundleId) ||
    (deviceId !== undefined && before.deviceId !== deviceId)
  ) {
    if (qaContext) qaContext.invalidate();
    throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
  }
  if (readOnly) attestQaReadOnly(qaTiming, before, readiness, 1);
}

export async function runIOS(args: RunIOSArgs): Promise<ToolResult> {
  const qaReadOnly =
    (args.qaContext !== undefined || args.qaReadOnly === true) && !isMutatingCommand(args.command);
  if (args.qaReadOnly && isMutatingCommand(args.command)) {
    if (args.qaContext) args.qaContext.invalidate();
    throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
  }
  if (args.qaContext || args.qaReadOnly)
    await requireQaFastRunner(
      args.qaContext,
      args.bundleId,
      args.deviceId,
      qaReadOnly,
      args.qaTiming,
    );
  const presenceRequested = args.command === 'snapshot' && args.platformPresence === true;
  const presenceRunner = presenceRequested ? runnerState : null;
  if (presenceRequested) {
    if (!Number.isSafeInteger(args.presenceBudgetMs) || (args.presenceBudgetMs ?? 0) <= 0) {
      return presenceCaptureUnavailable(
        'presenceBudgetMs must be an explicit positive integer',
        'INVALID_ARGUMENT',
      );
    }
    // Observation may probe readiness, but must not tear down or repair a dead runner.
    const readiness = await probeQaReadiness(args.qaTiming, 2);
    if (
      !presenceRunner ||
      runnerState !== presenceRunner ||
      runnerPoisoned ||
      readiness.liveness !== 'alive'
    ) {
      return presenceCaptureUnavailable(
        readiness.staleReason ?? 'an existing healthy runner is required',
        readiness.staleReason === 'authority-mismatch'
          ? 'RUNNER_OWNERSHIP_MISMATCH'
          : 'RN_FAST_RUNNER_DOWN',
      );
    }
    if (!readiness.capabilities?.includes('PLATFORM_PRESENCE_V2')) {
      return presenceCaptureUnavailable(
        'the runner lacks PLATFORM_PRESENCE_V2',
        'RN_FAST_RUNNER_STALE',
      );
    }
    if (qaReadOnly) attestQaReadOnly(args.qaTiming, presenceRunner, readiness, 2);
  }
  // STALE_REF sentinel from buildRunIOSArgs(): the caller tried to press/type
  // a @ref but refCenter() returned null. Surface cached metadata so the agent
  // knows what it asked for, plus a hint to call device_snapshot.
  if (args._staleRef) {
    args.qaContext?.invalidate();
    return failResult(
      `Element at ref ${args._staleRef} no longer hittable — UI re-rendered since snapshot`,
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

  const body: Record<string, unknown> = { command: args.command };
  if (qaReadOnly) body.qaReadOnly = true;
  if (args.bundleId) body.appBundleId = args.bundleId;
  if (args.x !== undefined) body.x = args.x;
  if (args.y !== undefined) body.y = args.y;
  if (args.x2 !== undefined) body.x2 = args.x2;
  if (args.y2 !== undefined) body.y2 = args.y2;
  if (args.text !== undefined) body.text = args.text;
  if (args.exactIdentifier !== undefined) body.exactIdentifier = args.exactIdentifier;
  if (args.exactType !== undefined) body.exactType = args.exactType;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.delayMs !== undefined) body.delayMs = args.delayMs;
  if (args.clearFirst !== undefined) body.clearFirst = args.clearFirst;
  if (args.direction !== undefined) body.direction = args.direction;
  if (args.scale !== undefined) body.scale = args.scale;
  if (presenceRequested) {
    body.platformPresence = true;
    body.presenceBudgetMs = args.presenceBudgetMs;
  } else {
    if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;
    if (args.compact !== undefined) body.compact = args.compact;
    if (args.depth !== undefined) body.depth = args.depth;
    if (args.scope !== undefined) body.scope = args.scope;
  }
  if (args.targetBounds !== undefined) body.targetBounds = args.targetBounds;
  if (args.snapshotGeneration !== undefined) body.snapshotGeneration = args.snapshotGeneration;
  if (args.snapshotNodeIndex !== undefined) body.snapshotNodeIndex = args.snapshotNodeIndex;
  if (args.snapshotElementType !== undefined) body.snapshotElementType = args.snapshotElementType;
  if (args.snapshotLabel !== undefined) body.snapshotLabel = args.snapshotLabel;
  if (args.snapshotIdentifier !== undefined) body.snapshotIdentifier = args.snapshotIdentifier;
  if (args.keyboardStateAtSnapshot !== undefined)
    body.keyboardStateAtSnapshot = args.keyboardStateAtSnapshot;
  if (args.focusX !== undefined) body.focusX = args.focusX;
  if (args.focusY !== undefined) body.focusY = args.focusY;
  if (args.focusWaitMs !== undefined) body.focusWaitMs = args.focusWaitMs;
  if (args.focused === true) body.focused = true;
  if (args.operationToken !== undefined) body.operationToken = args.operationToken;

  // Transport-level refusals must surface as typed results from every runner
  // round trip, not just the main dispatch — `withSession` does not catch, so a
  // raw throw from the keyboard preamble becomes an MCP-level crash.
  const mapRunnerDispatchError = (err: unknown): ToolResult | null => {
    const m = err instanceof Error ? err.message : String(err);
    if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
      return failResult(m, 'RUNNER_PROTOCOL_MISMATCH');
    }
    if (m.startsWith('RUNNER_TIMEOUT') && runnerPoisoned) {
      return failResult(m, 'RUNNER_TIMEOUT', { poisoned: true, dispatched: false });
    }
    return null;
  };

  const isExactKeyboardTarget =
    args.snapshotElementType === 'Key' || args.snapshotElementType === 'Keyboard';
  if (
    isExactKeyboardTarget &&
    (runnerState?.protocolVersion === 1 ||
      !lastKnownCapabilities.includes('EXACT_KEYBOARD_TARGET_GUARD'))
  ) {
    return failResult(
      'RN_FAST_RUNNER_STALE: the active iOS runner cannot safely validate exact keyboard targets; reopen the device session to rebuild before retrying.',
      'RN_FAST_RUNNER_STALE',
      { missingFeatures: ['EXACT_KEYBOARD_TARGET_GUARD'], dispatched: false },
    );
  }

  // An older runner could only tap a SpringBoard alert by coordinate through the app, which proves nothing.
  if (args.command === 'systemAlertTap' && !lastKnownCapabilities.includes('SYSTEM_ALERT_TAP_V1')) {
    return failResult(
      'RN_FAST_RUNNER_STALE: the active iOS runner cannot tap a system alert button by its label; reopen the device session to rebuild before retrying.',
      'RN_FAST_RUNNER_STALE',
      { missingFeatures: ['SYSTEM_ALERT_TAP_V1'], dispatched: false, mutation: 'none' },
    );
  }

  // A runner without the replace sequence would append to a focused field instead of replacing it.
  if (
    args.command === 'type' &&
    args.focused === true &&
    args.clearFirst === true &&
    !lastKnownCapabilities.includes('FILL_EVIDENCE_V1')
  ) {
    return failResult(
      'RN_FAST_RUNNER_STALE: the active iOS runner cannot replace a focused field; reopen the device session to rebuild before retrying.',
      'RN_FAST_RUNNER_STALE',
      { missingFeatures: ['FILL_EVIDENCE_V1'], dispatched: false, mutation: 'none' },
    );
  }

  let keyboardRelayoutRecovered = false;
  // Protocol-v1 runners ignore fresh-geometry fields. Enforce the corrected
  // policy client-side instead of silently downgrading to point containment.
  if (
    withKeyboardGuard({}, args.command, process.env).guardKeyboard === true &&
    runnerState?.protocolVersion === 1
  ) {
    args.qaContext?.invalidate();
    try {
      const legacyDismiss = await postCommand({
        command: 'keyboardDismiss',
        ...(args.bundleId ? { appBundleId: args.bundleId } : {}),
      });
      const data = (legacyDismiss.data ?? {}) as {
        wasVisible?: boolean;
        dismissed?: boolean;
        visible?: boolean;
      };
      if (data.wasVisible && (!data.dismissed || data.visible)) {
        return failResult(
          'KEYBOARD_DISMISS_FAILED: protocol-v1 runner could not dismiss the visible keyboard; no guarded tap was dispatched.',
          'KEYBOARD_DISMISS_FAILED',
          { attemptedTiers: ['native-control', 'native-swipe'], protocolVersion: 1 },
        );
      }
      if (data.wasVisible && data.dismissed) keyboardRelayoutRecovered = true;
    } catch (err) {
      throwIfCancelled();
      const mapped = mapRunnerDispatchError(err);
      if (mapped) return mapped;
      throw err;
    }
  }

  const refreshFailure: { result: ToolResult | null } = { result: null };
  const refreshTargetAfterKeyboard = async (): Promise<boolean> => {
    if (!args._targetRef) return true; // raw coordinates remain meaningful after dismissal
    const signature = getCachedSignature(args._targetRef);
    let snapshot: RunnerResponse;
    try {
      snapshot = await postCommand({
        command: 'snapshot',
        interactiveOnly: false,
        ...(args.bundleId ? { appBundleId: args.bundleId } : {}),
      });
    } catch (err) {
      throwIfCancelled();
      refreshFailure.result = mapRunnerDispatchError(err);
      if (refreshFailure.result) return false;
      throw err;
    }
    if (!snapshot.ok || !snapshot.data || typeof snapshot.data !== 'object') return false;
    const data = snapshot.data as {
      nodes?: RunnerSnapshotNode[];
      snapshotGeneration?: number;
      keyboardVisible?: boolean;
    };
    if (!Array.isArray(data.nodes)) return false;
    const flat = mapRunnerNodesToFlat(data.nodes);
    updateRefMapFromFlat(flat, {
      ...(typeof data.snapshotGeneration === 'number'
        ? { snapshotGeneration: data.snapshotGeneration }
        : {}),
      ...(typeof data.keyboardVisible === 'boolean'
        ? { keyboardVisible: data.keyboardVisible }
        : {}),
    });
    if (!signature) return false;
    const refreshed = refreshRef(signature, flat);
    if (refreshed.kind === 'ambiguous') {
      refreshFailure.result = failResult(
        'Multiple identities match the keyboard target',
        'TARGET_AMBIGUOUS',
        { mutation: 'none' },
      );
      return false;
    }
    if (refreshed.kind !== 'unique' || refreshed.node.ref !== args._targetRef) return false;
    const target = getFreshRefTarget(args._targetRef, { allowUnknownKeyboardState: true });
    if (!target) return false;
    body.x = Math.round(target.rect.x + target.rect.width / 2);
    body.y = Math.round(target.rect.y + target.rect.height / 2);
    body.targetBounds = target.rect;
    body.snapshotGeneration = target.snapshotGeneration;
    body.snapshotNodeIndex = target.snapshotNodeIndex;
    body.snapshotElementType = target.snapshotElementType;
    if (target.snapshotLabel !== undefined) body.snapshotLabel = target.snapshotLabel;
    else delete body.snapshotLabel;
    if (target.snapshotIdentifier !== undefined)
      body.snapshotIdentifier = target.snapshotIdentifier;
    else delete body.snapshotIdentifier;
    if (target.keyboardStateAtSnapshot !== null)
      body.keyboardStateAtSnapshot = target.keyboardStateAtSnapshot;
    return true;
  };
  if (keyboardRelayoutRecovered && !(await refreshTargetAfterKeyboard())) {
    return refreshFailure.result ?? staleAfterKeyboardDismissal(args._targetRef);
  }

  let resp: RunnerResponse;
  let recovery: TransportRecovery | undefined;
  let commandAuthorityBefore = captureFastRunnerCommandAuthority();
  try {
    if (presenceRunner) {
      resp = await sendCommandOnce(
        presenceRunner.port,
        { ...body, commandId: generateCommandId() },
        commandTimeoutMs(args.command),
        undefined,
        args.qaTiming,
      );
    } else {
      ({ resp, recovery } = await postCommandWithRecovery(
        withKeyboardGuard(body, args.command, process.env) as Record<string, unknown>,
        args.qaContext,
        args.qaTiming,
        args.command === 'type' && args.focused ? args._focusedProof : undefined,
      ));
    }
  } catch (err) {
    throwIfCancelled();
    if (presenceRequested) {
      return presenceCaptureUnavailable(
        err instanceof Error ? err.message : String(err),
        'RN_FAST_RUNNER_DOWN',
        true,
      );
    }
    const mapped = mapRunnerDispatchError(err);
    if (mapped) {
      args.qaContext?.invalidate();
      return mapped;
    }
    const m = err instanceof Error ? err.message : String(err);
    if (m.startsWith('RUNNER_TIMEOUT')) {
      const result = await (args.command === 'type'
        ? containTypeTimeout(args, commandAuthorityBefore)
        : containRunnerTimeout(args.command, m, commandAuthorityBefore));
      args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      return result;
    }
    args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
    throw err;
  }
  if (!presenceRequested && !resp.ok && resp.error?.code === 'KEYBOARD_RELAYOUT_REQUIRED') {
    args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
    if (!(await refreshTargetAfterKeyboard())) {
      return refreshFailure.result ?? staleAfterKeyboardDismissal(args._targetRef);
    }
    commandAuthorityBefore = captureFastRunnerCommandAuthority();
    try {
      ({ resp, recovery } = await postCommandWithRecovery(
        withKeyboardGuard(body, args.command, process.env) as Record<string, unknown>,
        args.qaContext,
        args.qaTiming,
        args.command === 'type' && args.focused ? args._focusedProof : undefined,
      ));
    } catch (err) {
      throwIfCancelled();
      const mapped = mapRunnerDispatchError(err);
      if (mapped) return mapped;
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('RUNNER_TIMEOUT')) {
        return args.command === 'type'
          ? containTypeTimeout(args, commandAuthorityBefore)
          : containRunnerTimeout(args.command, message, commandAuthorityBefore);
      }
      throw err;
    }
    keyboardRelayoutRecovered = true;
  }
  const recoveryMeta = recovery ? { transportRecovery: recovery } : {};
  if (resp.error?.reason !== 'focus-proof-refused')
    checkQaNativeOutcome(
      args.qaContext,
      resp.error?.code,
      resp.data,
      resp.error?.reason,
      resp.error?.mutation,
    );
  const announce = resp.ok ? takeQuiescenceAnnouncement() : null;
  if (!resp.ok) {
    const message = resp.error?.message ?? 'runner returned !ok with no error';
    const code = resp.error?.code;
    if (presenceRequested && resp.error?.reason !== 'app-not-running') {
      return presenceCaptureUnavailable(message, 'RN_FAST_RUNNER_DOWN', true);
    }
    if (code === 'RUNNER_TIMEOUT') {
      const result = await (args.command === 'type'
        ? containTypeTimeout(args, commandAuthorityBefore)
        : containRunnerTimeout(args.command, message, commandAuthorityBefore));
      args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      return result;
    }
    if (
      args.command === 'type' &&
      typeof message === 'string' &&
      message.includes('main thread execution timed out')
    ) {
      const result = await containTypeTimeout(args, commandAuthorityBefore);
      args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      return result;
    }
    const mutation = resp.error?.mutation;
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

  // Snapshot post-processing: feed the ref map so future press/fill calls
  // can resolve @refs without a separate fetch.
  if (
    args.command === 'snapshot' &&
    (presenceRequested || (resp.data && typeof resp.data === 'object'))
  ) {
    const data = (resp.data ?? {}) as {
      nodes?: RunnerSnapshotNode[];
      tree?: unknown;
      presenceCapture?: unknown;
      truncated?: boolean;
      snapshotGeneration?: number;
      keyboardVisible?: boolean;
      appProcessIdentifier?: number;
    };
    const missingRefFreshness =
      presenceRequested &&
      (typeof data.keyboardVisible !== 'boolean' ||
        !isNonNegativeSafeInteger(data.snapshotGeneration) ||
        !Array.isArray(data.nodes));
    if (missingRefFreshness) {
      clearRefMap();
      dirtySnapshotPlatforms.add('ios');
    }
    if (Array.isArray(data.nodes)) {
      const flat = mapRunnerNodesToFlat(data.nodes);
      const outcome: RefMapUpdateOutcome = missingRefFreshness
        ? { applied: false, reason: 'snapshot-ref-freshness-unknown' }
        : updateRefMapFromFlat(flat, {
            ...(typeof data.snapshotGeneration === 'number'
              ? { snapshotGeneration: data.snapshotGeneration }
              : {}),
            ...(typeof data.keyboardVisible === 'boolean'
              ? { keyboardVisible: data.keyboardVisible }
              : {}),
          });
      const snapshotVerdict = buildSnapshotVerdict('rn-fast-runner', flat.length, outcome);
      return okResult(
        {
          nodes: qaReadOnly ? mapRunnerNodesToFlat(data.nodes, true) : flat,
          ...(Object.hasOwn(data, 'presenceCapture')
            ? { presenceCapture: data.presenceCapture }
            : {}),
          normalizationDroppedNodes: data.nodes.length - flat.length,
          ...(typeof data.truncated === 'boolean' ? { truncated: data.truncated } : {}),
          ...(typeof data.keyboardVisible === 'boolean'
            ? { keyboardVisible: data.keyboardVisible }
            : {}),
          ...(typeof data.snapshotGeneration === 'number'
            ? { snapshotGeneration: data.snapshotGeneration }
            : {}),
          ...(typeof data.appProcessIdentifier === 'number'
            ? { appProcessIdentifier: data.appProcessIdentifier }
            : {}),
        },
        { meta: { ...announce, snapshotVerdict, ...recoveryMeta } },
      );
    }
    // Defensive fallback: the test seam mocks `{ tree: ... }`. Don't crash.
    const fallbackMeta = {
      ...announce,
      ...recoveryMeta,
      ...(missingRefFreshness
        ? {
            snapshotVerdict: buildSnapshotVerdict('rn-fast-runner', 0, {
              applied: false,
              reason: 'snapshot-ref-freshness-unknown',
            }),
          }
        : {}),
    };
    return okResult(
      resp.data ?? {},
      Object.keys(fallbackMeta).length ? { meta: fallbackMeta } : undefined,
    );
  }

  const finalMeta = {
    ...announce,
    ...recoveryMeta,
    ...(keyboardRelayoutRecovered ? { keyboardGuard: 'auto_dismissed' } : {}),
  };
  return okResult(resp.data ?? {}, Object.keys(finalMeta).length ? { meta: finalMeta } : undefined);
}
