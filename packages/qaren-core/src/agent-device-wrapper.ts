import { unlinkSync, rmSync } from 'node:fs';
import { QaDispatchError, type QaDispatchContext } from './domain/qa-dispatch.js';
import type { TimingContext } from './qa/timing.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolResult } from './utils.js';
import type { SessionState } from './types.js';
import { failResult } from './utils.js';
import {
  startFastRunner,
  probeFastRunnerLiveness,
  probeFastRunnerLivenessDetailed,
  adoptPersistedFastRunnerState,
  awaitSpawnedRunnerExit,
  getRunnerLaunchCount,
  reapStaleFastRunner,
  hasBuiltTestProduct,
  derivedDataPathForRunner,
  acquireRunnerRebuildLock,
  releaseRunnerRebuildLock,
  runnerRebuildBudget,
  consumePendingFastRunnerArtifactNote,
  getRunnerPostMortem,
} from './runners/rn-fast-runner-client.js';
import { getPluginVersion } from './runners/protocol.js';
import type {
  FastRunnerLiveness,
  FastRunnerLivenessDetail,
} from './runners/rn-fast-runner-client.js';
import type { ToolErrorCode } from './types.js';
import type { SettleProbes, SettleOutcome, waitForSettle } from './lifecycle/settle.js';
import { resolveBootedIosUdid } from './handlers/device-screenshot-raw.js';
import {
  refCenter,
  getScreenRect,
  clearRefMap,
  isRefMapFresh,
  MAX_REF_MAP_AGE_MS,
  getCachedSignature,
  getCachedMetadata,
  getCachedPackageName,
  getFreshRefTarget,
  refreshRef,
  getLastSnapshotHash,
  getLastSnapshotHashForPackage,
  invalidateLastSnapshotHash,
  pinnedElementRef,
  type FlatNode,
  type RefreshOutcome,
} from './fast-runner-ref-map.js';
import {
  recordNoUiChange,
  recordUiChange,
  WEDGED_DISTINCT_TARGETS,
  WEDGED_RUNTIME_HINT,
} from './lifecycle/no-change-tracker.js';
import { resolveBundleId } from './project-config.js';
import { dirtySnapshotPlatforms } from './snapshot-invalidation.js';
import {
  getStateDir,
  readJsonStateFile,
  writeJsonStateFileAtomic,
} from './util/secure-state-file.js';

// Per user and per project: sha256(cwd) keeps two checkouts of one repo apart.
function getSessionFilePath(): string {
  const projectId = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  return join(getStateDir(), `session-${projectId}.json`);
}

const SESSION_FILE = getSessionFilePath();

let activeSession: SessionState | null = readJsonStateFile<SessionState>(SESSION_FILE);

export function getActiveSession(): SessionState | null {
  return activeSession;
}

// Story 04 (#385): deterministic session seam for wiring tests — without it,
// runNative falls back to resolveBootedIosUdid(), which shells `xcrun simctl`
// (flaky on CI, machine-dependent locally).
export function _setActiveSessionForTest(session: SessionState | null): void {
  activeSession = session;
}

export function setActiveSession(info: SessionState): void {
  activeSession = info;
  // CDP-015: atomic write via tmp + rename, restrictive perms (0600 — only
  // the user can read).
  try {
    writeJsonStateFileAtomic(SESSION_FILE, info);
  } catch {
    /* ignore — in-memory session is still valid */
  }
}

export function clearActiveSession(): void {
  activeSession = null;
  clearRefMap();
  recordUiChange();
  try {
    unlinkSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
}

// Exported for tests + diagnostics.
export function getSessionFilePathForTest(): string {
  return SESSION_FILE;
}

// Test-only: reset the in-memory session pointer without touching the on-disk
// file. Tests that exercise paths gated on hasActiveSession() (e.g. the
// HELPERS_NOT_INJECTED → handleDevClientPicker fallback) need this so they
// don't trip over a real session left behind by the developer's live MCP run.
// clearActiveSession() unlinks the file too, which would break that live run.
export function resetActiveSessionInMemoryForTest(): void {
  activeSession = null;
}

// Test-only: set the in-memory session pointer WITHOUT the on-disk write that
// setActiveSession() performs. Tests that exercise platform-gated paths (e.g.
// the GH #321 cached-find reuse) must not clobber a developer's live MCP
// session file, which is a shared, uid-keyed path.
export function setActiveSessionInMemoryForTest(info: SessionState): void {
  activeSession = info;
}

export function hasActiveSession(): boolean {
  return activeSession !== null;
}

// Per-platform snapshot cache for cross-platform verification (P4-3).
// Updated by fetchSnapshotNodes() in device-interact.ts whenever a snapshot succeeds.
interface CachedSnapshot {
  platform: string;
  authorityReceipt: SnapshotAuthorityReceipt;
  // Lossless: the full runner nodes are stored (rect/enabled included) so a
  // cache-served device_find ranks and dedups identically to a fresh snapshot.
  nodes: {
    ref: string;
    label?: string;
    identifier?: string;
    type?: string;
    packageName?: string;
    checked?: boolean;
    hittable?: boolean;
    enabled?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  }[];
  capturedAt: string;
  capturedAtMs: number;
  captureSequence: number;
}

const snapshotCache = new Map<string, CachedSnapshot>();
let snapshotCaptureSequence = 0;
let snapshotAuthorityProvider: {
  current: () => Record<string, unknown> | null;
  record: (receipt: SnapshotAuthorityReceipt) => void;
  validate: (receipt: SnapshotAuthorityReceipt) => boolean;
  validateEvidence?: (receipt: SnapshotAuthorityReceipt) => boolean;
  validateLive?: (receipt: SnapshotAuthorityReceipt) => Promise<boolean>;
  validateOrigin?: (receipt: SnapshotAuthorityReceipt) => Promise<boolean>;
} | null = null;

export interface SnapshotAuthorityReceipt {
  sessionId: unknown;
  claimEpoch: unknown;
  sourceKey: unknown;
  worktreeKey: unknown;
  appRootKey: unknown;
  platform: unknown;
  deviceId: unknown;
  buildGeneration: unknown;
  installGeneration: unknown;
  runnerInstanceId: unknown;
  runnerClaim: unknown;
  deviceClaim: unknown;
  appId: unknown;
  artifactDigest: unknown;
  runnerPid: unknown;
  runnerProcessBirth: unknown;
  runnerCapabilityHash: unknown;
  runnerPort: unknown;
  originAuthority: 'proven' | 'not-proven';
}

export function setSnapshotAuthorityProvider(
  provider: {
    current: () => Record<string, unknown> | null;
    record: (receipt: SnapshotAuthorityReceipt) => void;
    validate: (receipt: SnapshotAuthorityReceipt) => boolean;
    validateEvidence?: (receipt: SnapshotAuthorityReceipt) => boolean;
    validateLive?: (receipt: SnapshotAuthorityReceipt) => Promise<boolean>;
    validateOrigin?: (receipt: SnapshotAuthorityReceipt) => Promise<boolean>;
  } | null,
): void {
  snapshotAuthorityProvider = provider;
  snapshotCache.clear();
  dirtySnapshotPlatforms.clear();
}

function currentSnapshotAuthority(platform: string): SnapshotAuthorityReceipt {
  const authority = snapshotAuthorityProvider?.current();
  const session = getActiveSession();
  return {
    sessionId: authority?.sessionId ?? null,
    claimEpoch: authority?.claimEpoch ?? null,
    sourceKey: authority?.sourceKey ?? null,
    worktreeKey: authority?.worktreeKey ?? null,
    appRootKey: authority?.appRootKey ?? null,
    platform: authority?.platform ?? platform,
    deviceId: authority?.deviceId ?? session?.deviceId ?? null,
    buildGeneration: authority?.buildGeneration ?? null,
    installGeneration: authority?.installGeneration ?? null,
    runnerInstanceId: authority?.runnerInstanceId ?? null,
    runnerClaim: authority?.runnerClaim ?? null,
    deviceClaim: authority?.deviceClaim ?? null,
    appId: authority?.appId ?? session?.appId ?? null,
    artifactDigest: authority?.artifactDigest ?? null,
    runnerPid: authority?.runnerPid ?? null,
    runnerProcessBirth: authority?.runnerProcessBirth ?? null,
    runnerCapabilityHash: authority?.runnerCapabilityHash ?? null,
    runnerPort: authority?.runnerPort ?? null,
    // The outer gate upgrades only captures whose M+A authority survives postflight.
    originAuthority: 'not-proven',
  };
}

function snapshotAuthorityIsValid(receipt: SnapshotAuthorityReceipt, platform: string): boolean {
  const current = currentSnapshotAuthority(platform);
  if (receipt.sessionId === null) {
    return (
      current.sessionId === null &&
      receipt.platform === platform &&
      receipt.deviceId === current.deviceId
    );
  }
  return Boolean(
    receipt.platform === platform &&
    receipt.sessionId === current.sessionId &&
    receipt.claimEpoch === current.claimEpoch &&
    receipt.sourceKey === current.sourceKey &&
    receipt.worktreeKey === current.worktreeKey &&
    receipt.appRootKey === current.appRootKey &&
    receipt.deviceId !== null &&
    receipt.installGeneration !== null &&
    receipt.runnerInstanceId !== null &&
    receipt.runnerClaim !== null &&
    receipt.deviceClaim !== null &&
    receipt.appId !== null &&
    receipt.artifactDigest !== null &&
    receipt.runnerPid !== null &&
    receipt.runnerProcessBirth !== null &&
    receipt.runnerCapabilityHash !== null &&
    receipt.runnerPort !== null &&
    snapshotAuthorityProvider?.validate(receipt),
  );
}

function snapshotEvidenceAuthorityIsValid(
  receipt: SnapshotAuthorityReceipt,
  platform: string,
): boolean {
  if (receipt.sessionId === null) return snapshotAuthorityIsValid(receipt, platform);
  return Boolean(
    receipt.originAuthority === 'proven' &&
    receipt.platform === platform &&
    receipt.sessionId !== null &&
    receipt.claimEpoch !== null &&
    receipt.sourceKey !== null &&
    receipt.worktreeKey !== null &&
    receipt.appRootKey !== null &&
    receipt.deviceId !== null &&
    receipt.installGeneration !== null &&
    receipt.appId !== null &&
    receipt.artifactDigest !== null &&
    snapshotAuthorityProvider?.validateEvidence?.(receipt),
  );
}

export async function validateCachedSnapshotAuthority(platform: string): Promise<boolean> {
  const snapshot = snapshotCache.get(platform);
  if (!snapshot || !snapshotAuthorityIsValid(snapshot.authorityReceipt, platform)) return false;
  if (snapshot.authorityReceipt.sessionId === null) return true;
  return (await snapshotAuthorityProvider?.validateLive?.(snapshot.authorityReceipt)) === true;
}

export async function validateCachedSnapshotEvidenceAuthority(platform: string): Promise<boolean> {
  const snapshot = snapshotCache.get(platform);
  if (
    !snapshot ||
    dirtySnapshotPlatforms.has(platform) ||
    !snapshotEvidenceAuthorityIsValid(snapshot.authorityReceipt, platform)
  ) {
    return false;
  }
  if (snapshot.authorityReceipt.sessionId === null) return true;
  const [hasLiveRunner, hasLiveOrigin] = await Promise.all([
    snapshotAuthorityProvider?.validateLive?.(snapshot.authorityReceipt),
    snapshotAuthorityProvider?.validateOrigin?.(snapshot.authorityReceipt),
  ]);
  return hasLiveRunner === true && hasLiveOrigin === true;
}

export function getCachedSnapshotEvidence(platform: string): CachedSnapshot | undefined {
  const snapshot = snapshotCache.get(platform);
  return snapshot &&
    !dirtySnapshotPlatforms.has(platform) &&
    snapshotEvidenceAuthorityIsValid(snapshot.authorityReceipt, platform)
    ? snapshot
    : undefined;
}

// Live-sim speedup (GH #321): device_find reuses the snapshot it already
// captured instead of re-snapshotting every call — but only while that snapshot
// still faithfully describes the screen. A tap/navigation changes the screen, so
// reuse is gated on TWO conditions: not dirtied by a mutating verb since capture,
// AND within the TTL (coordinate-drift guard, mirrors MAX_REF_MAP_AGE_MS). The
// dirty flag is the load-bearing correctness piece: a fresh-by-time but
// stale-by-content cache would drive a wrong-element tap.
export function cacheSnapshot(platform: string, nodes: CachedSnapshot['nodes']): void {
  const authorityReceipt = currentSnapshotAuthority(platform);
  if (authorityReceipt.sessionId !== null) snapshotAuthorityProvider?.record(authorityReceipt);
  snapshotCache.set(platform, {
    platform,
    authorityReceipt,
    nodes,
    capturedAt: new Date().toISOString(),
    capturedAtMs: Date.now(),
    captureSequence: ++snapshotCaptureSequence,
  });
  dirtySnapshotPlatforms.delete(platform);
}

/** Returns the snapshot-cache boundary used by the outer authority gate. */
export function getSnapshotCaptureCheckpoint(): number {
  return snapshotCaptureSequence;
}

/** Promotes only snapshots captured after the current operation's checkpoint. */
export function promoteSnapshotOriginSince(checkpoint: number): void {
  for (const snapshot of snapshotCache.values()) {
    if (
      snapshot.captureSequence <= checkpoint ||
      snapshot.authorityReceipt.originAuthority === 'proven'
    ) {
      continue;
    }
    const promoted: SnapshotAuthorityReceipt = {
      ...snapshot.authorityReceipt,
      originAuthority: 'proven',
    };
    if (promoted.sessionId !== null) snapshotAuthorityProvider?.record(promoted);
    snapshot.authorityReceipt = promoted;
  }
}

export function getCachedSnapshot(platform: string): CachedSnapshot | undefined {
  const snapshot = snapshotCache.get(platform);
  return snapshot &&
    !dirtySnapshotPlatforms.has(platform) &&
    snapshotAuthorityIsValid(snapshot.authorityReceipt, platform)
    ? snapshot
    : undefined;
}

// Called at the runNative dispatch choke point on any screen-mutating verb
// (tap/press/fill/type/swipe/scroll/back/longpress/pinch/keyboard/drag).
export function markSnapshotDirty(platform?: string): void {
  const authorityPlatform = snapshotAuthorityProvider?.current()?.platform;
  const currentPlatform =
    platform ??
    (typeof authorityPlatform === 'string' ? authorityPlatform : activeSession?.platform);
  if (currentPlatform) {
    dirtySnapshotPlatforms.add(currentPlatform);
    return;
  }
  for (const cachedPlatform of snapshotCache.keys()) {
    dirtySnapshotPlatforms.add(cachedPlatform);
  }
}

// True only when the cached snapshot is safe to reuse for targeting: present,
// not invalidated by a mutating verb, and within the freshness budget.
export function isSnapshotCacheValid(
  platform: string,
  maxAgeMs: number = MAX_REF_MAP_AGE_MS,
): boolean {
  if (dirtySnapshotPlatforms.has(platform)) return false;
  const entry = snapshotCache.get(platform);
  if (!entry) return false;
  if (!snapshotAuthorityIsValid(entry.authorityReceipt, platform)) return false;
  return Date.now() - entry.capturedAtMs <= maxAgeMs;
}

export function listCachedSnapshots(): string[] {
  return [...snapshotCache.keys()];
}

// Returns the `-s <serial>` args for adb when a specific device/emulator is
// targeted. Prefers the active session's deviceId IFF that session is Android,
// then ANDROID_SERIAL env. Returns an empty array when no target is set (adb
// will pick the only connected device, or fail with "more than one device" if
// multiple exist).
//
// GH #60: prior to this gate, an active iOS session would leak its UDID into
// adb commands (e.g. `device_deeplink platform:"android"` → `adb -s <iOS-UDID>
// not found`) when both iOS and Android were booted simultaneously.
export function getAdbSerial(): string[] {
  const session = getActiveSession();
  if (session?.platform === 'android' && session.deviceId) return ['-s', session.deviceId];
  if (process.env.ANDROID_SERIAL) return ['-s', process.env.ANDROID_SERIAL];
  return [];
}

// --- iOS short-circuit: route every supported command through rn-fast-runner ---
//
// GH #105 / rn-device iOS-MVP §3.1: iOS commands no longer touch agent-device
// (neither the daemon nor the CLI). They go through our own HTTP runner via
// runIOS(). The buildRunIOSArgs() helper translates the legacy CLI argv shape
// (e.g. `['press', '@e3', '--hold-ms', '500']`) into the structured RunIOSArgs
// the new client expects. The legacy daemon + CLI tiers below remain — they
// now serve Android exclusively.
//
// GH #105 iOS-MVP follow-up (post-validation): the original short-circuit
// list left `swipe` / `scroll` / `longpress` / `pinch` / `find` on the
// legacy daemon/CLI path. Live validation showed the daemon respawns the
// upstream AgentDeviceRunner on every such call, which then fights our
// RnFastRunner for focus. Each of these now routes through the runner's
// `/command` endpoint (the Swift `.drag` / `.longPress` / `.pinch` / `.findText`
// handlers). Coordinate-based gestures: the Swift `.swipe` case is tvOS-only;
// iOS coordinate-form swipes/scrolls use `.drag`.

const RN_FAST_RUNNER_COMMANDS = new Set<string>([
  'snapshot',
  'tap',
  'press',
  'fill',
  'type',
  'verify-input',
  'back',
  'screenshot',
  'keyboard',
  'swipe',
  'scroll',
  'longpress',
  'pinch',
  'system-alert-tap',
]);

// GH #321: verbs that can change what's on screen, so a cached snapshot can no
// longer be trusted for targeting after one runs. snapshot/screenshot are reads
// and are deliberately absent.
const SNAPSHOT_MUTATING_VERBS = new Set<string>([
  'tap',
  'press',
  'fill',
  'type',
  'back',
  'keyboard',
  'swipe',
  'scroll',
  'drag',
  'longpress',
  'pinch',
  'system-alert-tap',
]);

export function getCachedScreenRect(): { width: number; height: number } | null {
  return getScreenRect();
}

export function buildRunIOSArgs(
  cliArgs: string[],
  bundleId?: string,
): import('./runners/rn-fast-runner-client.js').RunIOSArgs {
  const cmd = cliArgs[0];
  const positionals = positionalArgs(cliArgs);
  switch (cmd) {
    case 'press':
    case 'tap': {
      const ref = positionals[0] && pinnedElementRef(positionals[0]);
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) {
          return { command: 'tap', _staleRef: ref, ...(bundleId ? { bundleId } : {}) };
        }
        const target = getFreshRefTarget(ref);
        const built: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
          command: 'tap',
          x: center.x,
          y: center.y,
          ...(target
            ? {
                targetBounds: target.rect,
                snapshotGeneration: target.snapshotGeneration,
                snapshotNodeIndex: target.snapshotNodeIndex,
                snapshotElementType: target.snapshotElementType,
                ...(target.snapshotLabel !== undefined
                  ? { snapshotLabel: target.snapshotLabel }
                  : {}),
                ...(target.snapshotIdentifier !== undefined
                  ? { snapshotIdentifier: target.snapshotIdentifier }
                  : {}),
                keyboardStateAtSnapshot: target.keyboardStateAtSnapshot!,
              }
            : {}),
          ...(bundleId ? { bundleId } : {}),
        };
        // Client-only identity must not leak onto the JSON wire or perturb the
        // legacy argv-adapter shape inspected by callers.
        Object.defineProperty(built, '_targetRef', { value: ref, enumerable: false });
        return built;
      }
      const [xS, yS] = positionals;
      const x = Number(xS),
        y = Number(yS);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error(`buildRunIOSArgs: tap requires a @ref or numeric x, y`);
      }
      return { command: 'tap', x, y, ...(bundleId ? { bundleId } : {}) };
    }
    case 'system-alert-tap':
      return {
        command: 'systemAlertTap',
        text: cliArgs[1] ?? '',
        ...(bundleId ? { bundleId } : {}),
      };
    case 'verify-input': {
      // GH #581: secret-safe exact read-back; the input descriptor is attached
      // by runNative's exact-target decoration. Text is a RAW fixed slot —
      // never flag-parsed, so values like "-1" survive verbatim.
      const text = cliArgs[2] ?? '';
      return { command: 'verifyInput', text, ...(bundleId ? { bundleId } : {}) };
    }
    case 'fill':
    case 'type': {
      // GH #581: the Swift runner's `.type` binds the exact input (descriptor
      // attached by runNative's exact-target decoration), proves focus, and
      // types in one native operation. Shape: [verb, ref, rawText, ...flags] —
      // text is a raw slot so leading '-' values are never eaten as flags.
      const ref = cliArgs[1] && pinnedElementRef(cliArgs[1]);
      const text = cliArgs[2] ?? '';
      const flagArgs = cliArgs.slice(3);
      const delayRaw = optionValue(flagArgs, '--delay-ms');
      const delayMs =
        delayRaw !== undefined && !Number.isNaN(Number(delayRaw)) ? Number(delayRaw) : undefined;
      const extra: { delayMs?: number; clearFirst?: boolean } = {};
      if (delayMs !== undefined) extra.delayMs = delayMs;
      if (flagArgs.includes('--clear-first')) extra.clearFirst = true;
      // Story 04 (#385) M2 guard: an explicit --at-x/--at-y pin bypasses @ref
      // re-resolution entirely so a settle's ref-map refresh can't retarget.
      const atX = optionValue(flagArgs, '--at-x');
      const atY = optionValue(flagArgs, '--at-y');
      if (atX !== undefined && atY !== undefined) {
        const px = Number(atX),
          py = Number(atY);
        if (Number.isFinite(px) && Number.isFinite(py)) {
          return {
            command: 'type',
            x: px,
            y: py,
            text,
            ...extra,
            ...(bundleId ? { bundleId } : {}),
          };
        }
      }
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) {
          return {
            command: 'type',
            _staleRef: ref,
            text,
            ...extra,
            ...(bundleId ? { bundleId } : {}),
          };
        }
        return {
          command: 'type',
          x: center.x,
          y: center.y,
          text,
          ...extra,
          ...(bundleId ? { bundleId } : {}),
        };
      }
      // Legacy no-ref shape: ['type', text] — a single argument is the text.
      if (cliArgs.length === 2) {
        return { command: 'type', text: ref ?? '', ...(bundleId ? { bundleId } : {}) };
      }
      return { command: 'type', text, ...extra, ...(bundleId ? { bundleId } : {}) };
    }
    case 'snapshot':
      return {
        command: 'snapshot',
        ...(cliArgs.includes('--platform-presence')
          ? { platformPresence: true }
          : { interactiveOnly: !cliArgs.includes('--full') }),
        ...(bundleId ? { bundleId } : {}),
      };
    case 'back':
      return { command: 'back', ...(bundleId ? { bundleId } : {}) };
    case 'screenshot':
      return { command: 'screenshot', ...(bundleId ? { bundleId } : {}) };
    case 'keyboard':
      // B235/#418: the Swift enum case is keyboardDismiss; 'dismissKeyboard'
      // (the Android wire verb) never decoded on iOS.
      return { command: 'keyboardDismiss', ...(bundleId ? { bundleId } : {}) };
    case 'swipe':
    case 'scroll': {
      // Coordinate-based gesture. The Swift `.swipe` is tvOS-only; iOS
      // coord-form gestures use `.drag`. CLI shapes seen:
      //   ['swipe',  x1, y1, x2, y2, durationMs?]
      //   ['scroll', x1, y1, x2, y2, durationMs?]
      // Direction-form (`['scroll', 'down', amount?]`) cannot reach this
      // path: device-interact converts direction→coords up-front and
      // dispatches the coord shape.
      const [x1S, y1S, x2S, y2S, durationS] = positionals;
      const x1 = Number(x1S),
        y1 = Number(y1S),
        x2 = Number(x2S),
        y2 = Number(y2S);
      if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
        throw new Error(`buildRunIOSArgs: ${cmd} requires four numeric coordinates`);
      }
      const args: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
        command: 'drag',
        x: x1,
        y: y1,
        x2,
        y2,
        ...(bundleId ? { bundleId } : {}),
      };
      if (durationS !== undefined) {
        const n = Number(durationS);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }
    case 'longpress': {
      // CLI shape: ['longpress', x, y, durationMs?]
      const [xS, yS, durationS] = positionals;
      const x = Number(xS),
        y = Number(yS);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error(`buildRunIOSArgs: longpress requires numeric x, y`);
      }
      const args: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
        command: 'longPress',
        x,
        y,
        ...(bundleId ? { bundleId } : {}),
      };
      if (durationS !== undefined) {
        const n = Number(durationS);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }
    case 'pinch': {
      // CLI shape: ['pinch', scale, x?, y?]
      const [scaleS, xS, yS] = positionals;
      const scale = Number(scaleS);
      if (Number.isNaN(scale)) {
        throw new Error(`buildRunIOSArgs: pinch requires numeric scale`);
      }
      const args: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
        command: 'pinch',
        scale,
        ...(bundleId ? { bundleId } : {}),
      };
      if (xS !== undefined && yS !== undefined) {
        const x = Number(xS),
          y = Number(yS);
        if (!Number.isNaN(x)) args.x = x;
        if (!Number.isNaN(y)) args.y = y;
      }
      return args;
    }
    default:
      throw new Error(`buildRunIOSArgs: unsupported command "${cmd ?? '<empty>'}"`);
  }
}

// GH #581: attach the bound input's current-generation identity (and the
// declared focus point) to a type/verifyInput dispatch. Fail-closed: if the
// ref cannot be rebound in the current generation, nothing is dispatched.
function exactTargetRebindFailure(inputRef: string): ToolResult {
  return failResult(
    `Exact input ${inputRef} could not be rebound in the current snapshot generation — nothing was dispatched. Refresh the snapshot and rebind the input.`,
    'NO_TEXT_INPUT_TARGET',
    { mutation: 'none' },
  );
}

function decorateExactTargetIOS(
  ios: import('./runners/rn-fast-runner-client.js').RunIOSArgs,
  exact: ExactTargetOpts,
): ToolResult | null {
  if (ios.command === 'verifyInput' && exact.operationToken) {
    ios.operationToken = exact.operationToken;
    return null;
  }
  const target = getFreshRefTarget(exact.inputRef, { allowUnknownKeyboardState: true });
  if (!target) return exactTargetRebindFailure(exact.inputRef);
  delete ios._staleRef;
  ios.x = Math.round(target.rect.x + target.rect.width / 2);
  ios.y = Math.round(target.rect.y + target.rect.height / 2);
  ios.targetBounds = target.rect;
  ios.snapshotGeneration = target.snapshotGeneration;
  ios.snapshotNodeIndex = target.snapshotNodeIndex;
  ios.snapshotElementType = target.snapshotElementType;
  if (target.snapshotLabel !== undefined) ios.snapshotLabel = target.snapshotLabel;
  if (target.snapshotIdentifier !== undefined) ios.snapshotIdentifier = target.snapshotIdentifier;
  if (target.keyboardStateAtSnapshot !== null) {
    ios.keyboardStateAtSnapshot = target.keyboardStateAtSnapshot;
  }
  if (exact.focusX !== undefined) ios.focusX = exact.focusX;
  if (exact.focusY !== undefined) ios.focusY = exact.focusY;
  if (exact.focusWaitMs !== undefined) ios.focusWaitMs = exact.focusWaitMs;
  if (exact.operationToken !== undefined) ios.operationToken = exact.operationToken;
  return null;
}

function decorateExactTargetAndroid(
  android: import('./runners/rn-android-runner-client.js').RunAndroidArgs,
  exact: ExactTargetOpts,
): ToolResult | null {
  if (android.command === 'verifyInput' && exact.operationToken) {
    android.operationToken = exact.operationToken;
    if (exact.secure !== undefined) android.secureInput = exact.secure;
    return null;
  }
  const target = getFreshRefTarget(exact.inputRef, { allowUnknownKeyboardState: true });
  if (!target) return exactTargetRebindFailure(exact.inputRef);
  delete android._staleRef;
  android.x = Math.round(target.rect.x + target.rect.width / 2);
  android.y = Math.round(target.rect.y + target.rect.height / 2);
  android.targetBounds = target.rect;
  android.snapshotGeneration = target.snapshotGeneration;
  android.snapshotNodeIndex = target.snapshotNodeIndex;
  android.snapshotElementType = target.snapshotElementType;
  if (target.snapshotIdentifier !== undefined) {
    android.snapshotIdentifier = target.snapshotIdentifier;
  }
  if (exact.focusX !== undefined) android.focusX = exact.focusX;
  if (exact.focusY !== undefined) android.focusY = exact.focusY;
  if (exact.focusWaitMs !== undefined) android.focusWaitMs = exact.focusWaitMs;
  if (exact.secure !== undefined) android.secureInput = exact.secure;
  if (exact.operationToken !== undefined) android.operationToken = exact.operationToken;
  return null;
}

function optionValue(cliArgs: string[], flag: string): string | undefined {
  const i = cliArgs.indexOf(flag);
  if (i === -1) return undefined;
  const value = cliArgs[i + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

// Extract positional args, dropping flag tokens AND their values (`--count 3`,
// `--pattern xy`). A naive `filter(a => !a.startsWith('--'))` strips the flag
// token but keeps its value, which then mis-parses as a trailing positional
// (e.g. count's `3` landing in the swipe duration slot → a 3ms flick).
function positionalArgs(cliArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a.startsWith('-')) {
      const value = cliArgs[i + 1];
      if (value && !value.startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function buildRunAndroidArgs(
  cliArgs: string[],
  bundleId?: string,
): import('./runners/rn-android-runner-client.js').RunAndroidArgs {
  type RunAndroidArgs = import('./runners/rn-android-runner-client.js').RunAndroidArgs;
  const cmd = cliArgs[0];
  const positionals = positionalArgs(cliArgs);
  const withBundle = bundleId ? { bundleId } : {};

  switch (cmd) {
    case 'press':
    case 'tap': {
      const ref = positionals[0] && pinnedElementRef(positionals[0]);
      if (ref && ref.startsWith('@')) {
        const includeSystemUi = cliArgs.includes('--include-system-ui');
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) {
          return {
            command: 'tap',
            _staleRef: ref,
            ...(includeSystemUi ? { includeSystemUi: true } : {}),
            ...withBundle,
          };
        }
        const metadata = getCachedMetadata(ref);
        return {
          command: 'tap',
          x: center.x,
          y: center.y,
          ...(metadata?.identifier
            ? { exactIdentifier: metadata.identifier, exactType: metadata.type }
            : {}),
          ...(includeSystemUi ? { includeSystemUi: true } : {}),
          ...withBundle,
        };
      }
      const [xS, yS] = positionals;
      const x = Number(xS),
        y = Number(yS);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error(`buildRunAndroidArgs: tap requires a @ref or numeric x, y`);
      }
      return { command: 'tap', x, y, ...withBundle };
    }

    case 'verify-input': {
      const text = cliArgs[2] ?? '';
      return { command: 'verifyInput', text, ...withBundle };
    }
    case 'fill':
    case 'type': {
      const ref = cliArgs[1] && pinnedElementRef(cliArgs[1]);
      const text = cliArgs[2] ?? '';
      // Story 04 (#385) M2 guard — mirrors buildRunIOSArgs: a --at-x/--at-y pin
      // bypasses @ref re-resolution so a settle-refreshed map can't retarget.
      const atX = optionValue(cliArgs, '--at-x');
      const atY = optionValue(cliArgs, '--at-y');
      if (atX !== undefined && atY !== undefined) {
        const px = Number(atX),
          py = Number(atY);
        if (Number.isFinite(px) && Number.isFinite(py)) {
          return { command: 'type', x: px, y: py, text, ...withBundle };
        }
      }
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) return { command: 'type', _staleRef: ref, text, ...withBundle };
        return { command: 'type', x: center.x, y: center.y, text, ...withBundle };
      }
      return { command: 'type', text: positionals.join(' '), ...withBundle };
    }

    case 'snapshot':
      return { command: 'snapshot', interactiveOnly: !cliArgs.includes('--full'), ...withBundle };

    case 'back':
      return { command: 'back', ...withBundle };

    case 'screenshot':
      return { command: 'screenshot', outPath: optionValue(cliArgs, '--out'), ...withBundle };

    case 'keyboard':
    case 'dismissKeyboard':
      return { command: 'dismissKeyboard', ...withBundle };

    // `find` is intentionally NOT handled here — `device_find` is a TS orchestrator
    // on Android (mirrors iOS), built on top of runAndroid('snapshot') + findInLatestSnapshot.

    case 'swipe':
    case 'scroll':
    case 'drag': {
      const [x1S, y1S, x2S, y2S, durationS] = positionals;
      const x1 = Number(x1S),
        y1 = Number(y1S),
        x2 = Number(x2S),
        y2 = Number(y2S);
      if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
        throw new Error(`buildRunAndroidArgs: ${cmd} requires four numeric coordinates`);
      }
      const args: RunAndroidArgs = { command: 'drag', x1, y1, x2, y2, ...withBundle };
      if (durationS !== undefined) {
        const n = Number(durationS);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }

    case 'longpress': {
      const [rawTarget, yOrDuration, durationMaybe] = positionals;
      const target = rawTarget && pinnedElementRef(rawTarget);
      if (target?.startsWith('@')) {
        const duration = Number(yOrDuration);
        // Final-review fix (#386): mirrors the tap/type cases in this same
        // function (and the iOS builder) — an over-age ref map must be
        // treated as stale so it heals via _staleRef instead of serving a
        // wrong-element long-press from coordinates captured on a screen that
        // may no longer be on-screen.
        const center = isRefMapFresh() ? refCenter(target) : null;
        if (!center) {
          return {
            command: 'longPress',
            _staleRef: target,
            ...(Number.isNaN(duration) ? {} : { durationMs: duration }),
            ...withBundle,
          };
        }
        return {
          command: 'longPress',
          x: center.x,
          y: center.y,
          ...(Number.isNaN(duration) ? {} : { durationMs: duration }),
          ...withBundle,
        };
      }
      const x = Number(target),
        y = Number(yOrDuration);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error('buildRunAndroidArgs: longpress requires numeric x, y or a @ref');
      }
      const args: RunAndroidArgs = { command: 'longPress', x, y, ...withBundle };
      if (durationMaybe !== undefined) {
        const n = Number(durationMaybe);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }

    case 'pinch': {
      const [scaleS, xS, yS] = positionals;
      const scale = Number(scaleS);
      if (Number.isNaN(scale)) {
        throw new Error('buildRunAndroidArgs: pinch requires numeric scale');
      }
      const args: RunAndroidArgs = { command: 'pinch', scale, ...withBundle };
      if (xS !== undefined && yS !== undefined) {
        const x = Number(xS),
          y = Number(yS);
        if (!Number.isNaN(x)) args.x = x;
        if (!Number.isNaN(y)) args.y = y;
      }
      return args;
    }

    default:
      throw new Error(`buildRunAndroidArgs: unsupported command "${cmd ?? '<empty>'}"`);
  }
}

// GH #736: Android mutating verbs are scoped to the owned app window, but
// device_snapshot still returns system-chrome nodes. A @ref minted from one of
// those nodes would otherwise reach the runner and come back as a generic
// "resolved no matching target" refusal that names neither the cause nor the
// one supported way to touch system UI.
const APP_SCOPED_ANDROID_REF_VERBS = new Set(['press', 'tap', 'fill', 'type', 'longpress']);

export interface OutsideAppWindowRefusal {
  ref: string;
  packageName: string;
  appId: string;
}

export function androidOutsideAppWindowRefusal(
  cliArgs: string[],
  appId: string | undefined,
  ref?: string,
): OutsideAppWindowRefusal | null {
  const cmd = cliArgs[0];
  if (!cmd || !APP_SCOPED_ANDROID_REF_VERBS.has(cmd)) return null;
  if (!appId) return null;
  const target =
    ref !== undefined ? (ref.startsWith('@') ? ref : `@${ref}`) : positionalArgs(cliArgs)[0];
  if (!target || !target.startsWith('@')) return null;
  if (cliArgs.includes('--include-system-ui')) return null;
  const packageName = getCachedPackageName(target);
  if (!packageName || packageName === appId) return null;
  return { ref: target, packageName, appId };
}

export function outsideAppWindowFailResult(refusal: OutsideAppWindowRefusal): ToolResult {
  return failResult(
    `Ref ${refusal.ref} belongs to "${refusal.packageName}", outside the owned app window (${refusal.appId}) — Android interactions are app-scoped and will not actuate system UI.`,
    'OUTSIDE_APP_WINDOW',
    {
      mutation: 'none',
      ref: refusal.ref,
      packageName: refusal.packageName,
      appId: refusal.appId,
      hint: 'To act on system UI explicitly, call device_find with includeSystemUi=true and action="click".',
    },
  );
}

export function rebuildHealedAndroidArgs(
  cliArgs: string[],
  healedRef: string,
  bundleId: string | undefined,
  includeSystemUi: boolean,
): import('./runners/rn-android-runner-client.js').RunAndroidArgs {
  const reboundArgs = [...cliArgs];
  reboundArgs[1] = healedRef.startsWith('@') ? healedRef : `@${healedRef}`;
  if (includeSystemUi && !reboundArgs.includes('--include-system-ui')) {
    reboundArgs.push('--include-system-ui');
  }
  return buildRunAndroidArgs(reboundArgs, bundleId);
}

export type RunnerSpawnDecision =
  | { action: 'proceed' }
  | { action: 'spawn'; deviceId: string }
  | { action: 'error'; message: string };

// #210: pure decision for the iOS device_* auto-spawn. Cold-build-safe — only auto-starts
// when a prebuilt .xctestrun exists; a missing rig or no device returns an actionable error
// instead of a silent multi-minute xcodebuild.
export function decideRunnerSpawn(input: {
  liveness: FastRunnerLiveness;
  prebuilt: boolean;
  deviceId: string | null;
}): RunnerSpawnDecision {
  if (input.liveness === 'alive') return { action: 'proceed' };
  if (!input.deviceId) {
    return {
      action: 'error',
      message:
        'rn-fast-runner not started and no booted iOS simulator found. Boot a simulator and run `device_snapshot action=open appId=<your.app.id> platform=ios` first.',
    };
  }
  if (!input.prebuilt) {
    return {
      action: 'error',
      message:
        'rn-fast-runner not started and not prebuilt. Run `device_snapshot action=open appId=<your.app.id> platform=ios` first (one-time cold build, ~minutes), then retry — or pre-build once with `xcodebuild build-for-testing` (see plugin Prerequisites).',
    };
  }
  return { action: 'spawn', deviceId: input.deviceId };
}

export interface EnsureRunnerDeps {
  probe?: () => Promise<FastRunnerLivenessDetail>;
  ensure?: (
    deviceId: string,
    bundleId: string,
    opts?: { forceLocalBuild?: boolean; attachOnly?: boolean },
  ) => Promise<void>;
  prebuilt?: () => boolean;
  adopt?: (deviceId: string | undefined) => void;
  /** GH #418: open-path only — permits DerivedData invalidation + cold rebuild. */
  allowArtifactRebuild?: boolean;
  attachOnly?: boolean;
  /** GH #418: test seams for the rebuild tier. */
  invalidateArtifact?: () => void;
  reap?: () => Promise<void>;
  acquireBuildLock?: () => boolean;
  /** GH #629: bounded wait for the failed first spawn to exit before the retry;
   * resolves false (retry refused) when the process survives escalation. */
  awaitSpawnExit?: () => Promise<boolean>;
  /** GH #629: monotonic launch-child count; the retry needs it to advance. */
  launchCount?: () => number;
  releaseBuildLock?: () => void;
  rebuildBudget?: { alreadyRebuiltFor(v: string): boolean; recordRebuild(v: string): void };
  pluginVersion?: string | null;
}

export type EnsureRunnerResult =
  | { ok: true; note?: string }
  | { ok: false; message: string; code?: ToolErrorCode };

const PROTOCOL_STALE_REASONS = new Set([
  'legacy',
  'protocol-older',
  'protocol-newer',
  'version-skew',
  // GH #418: a respawn can fix a runner PROCESS older than the on-disk
  // artifact; artifact staleness surviving the respawn is handled separately.
  'missing-commands',
  'missing-features',
]);

function isArtifactStaleReason(reason: string | undefined): boolean {
  return reason === 'missing-commands' || reason === 'missing-features';
}

// GH #418: the open-path rebuild tier. A respawn reuses the same build
// artifact, so 'missing-commands' can only be fixed by invalidating
// DerivedData and paying the cold rebuild — allowed at device_snapshot
// action=open only, reap-first, serialized behind the checkout-scoped build
// lock, at most once per plugin version (a broken checkout must not loop
// multi-minute builds).
async function rebuildStaleRunnerArtifact(
  first: FastRunnerLivenessDetail,
  deviceId: string,
  bundleId: string,
  deps: EnsureRunnerDeps,
): Promise<EnsureRunnerResult> {
  const authorityMismatch = first.staleReason === 'authority-mismatch';
  const missing = (first.missingCommands ?? first.missingFeatures ?? []).join(', ') || 'unknown';
  const missingKind = first.staleReason === 'missing-features' ? 'features' : 'commands';
  const code = authorityMismatch
    ? 'RUNNER_OWNERSHIP_MISMATCH'
    : first.staleReason === 'missing-features'
      ? 'RN_FAST_RUNNER_STALE'
      : 'RUNNER_COMMANDS_STALE';
  const plugin = deps.pluginVersion !== undefined ? deps.pluginVersion : getPluginVersion();
  const budget = deps.rebuildBudget ?? runnerRebuildBudget;
  if (plugin !== null && budget.alreadyRebuiltFor(plugin)) {
    return {
      ok: false,
      code,
      message: authorityMismatch
        ? `rn-fast-runner was already cold-rebuilt once for plugin v${plugin} and still reports an authority identity mismatch. ` +
          `If that rebuild failed transiently, delete the runner build/commands-rebuild.json marker and re-open to retry; ` +
          `otherwise update or reinstall the plugin.`
        : `rn-fast-runner was already cold-rebuilt once for plugin v${plugin} and still lacks ` +
          `required ${missingKind} (missing: ${missing}). If that rebuild failed transiently (sim ` +
          `not booted, xcodebuild flake), delete the runner build/commands-rebuild.json marker ` +
          `and re-open to retry; otherwise update or reinstall the plugin.`,
    };
  }
  const acquire = deps.acquireBuildLock ?? acquireRunnerRebuildLock;
  if (!acquire()) {
    return {
      ok: false,
      code,
      message:
        'another session is rebuilding the shared runner artifact — retry this open in a few minutes.',
    };
  }
  const release = deps.releaseBuildLock ?? releaseRunnerRebuildLock;
  try {
    const reap = deps.reap ?? reapStaleFastRunner;
    await reap();
    const invalidate =
      deps.invalidateArtifact ??
      (() => rmSync(derivedDataPathForRunner(), { recursive: true, force: true }));
    invalidate();
    if (plugin !== null) budget.recordRebuild(plugin);
    const ensure = deps.ensure ?? ensureFastRunner;
    // GH #382 (Codex P1): force a source rebuild — a stale prebuilt artifact must
    // not be re-selected here, or the cold rebuild that heals the command surface
    // never runs.
    await ensure(deviceId, bundleId, {
      forceLocalBuild: true,
      ...(deps.attachOnly === true ? { attachOnly: true } : {}),
    });
  } finally {
    release();
  }
  const probe = deps.probe ?? probeFastRunnerLivenessDetailed;
  const rebuilt = await probe();
  if (rebuilt.liveness === 'alive') {
    return {
      ok: true,
      note: authorityMismatch
        ? 'runner artifact rebuilt (authority identity mismatch)'
        : `runner artifact rebuilt (missing ${missingKind}: ${missing})`,
    };
  }
  return {
    ok: false,
    code,
    message: authorityMismatch
      ? 'rn-fast-runner still reports an authority identity mismatch after a cold rebuild.'
      : `rn-fast-runner still lacks required ${missingKind} after a cold rebuild ` +
        `(missing: ${(rebuilt.missingCommands ?? rebuilt.missingFeatures ?? first.missingCommands ?? first.missingFeatures ?? []).join(', ') || 'unknown'}). ` +
        `The plugin checkout itself may be outdated — update the plugin, then re-open the device session.`,
  };
}

// #210: orchestrate probe → gate → spawn → RE-VERIFY → structured result. ensureFastRunner
// swallows start errors, so the re-probe is what turns a failed spawn into a clean message
// rather than the unstructured postCommand throw downstream (A6, multi-review).
// GH #383: the probe now returns detailed liveness — a protocol/version-stale
// runner is reaped-and-reinstalled transparently (ok + note); a mismatch that
// survives the reinstall surfaces RUNNER_PROTOCOL_MISMATCH (stale prebuilt).
export async function ensureRunnerForCommand(
  deviceId: string | null,
  bundleId: string,
  deps: EnsureRunnerDeps = {},
): Promise<EnsureRunnerResult> {
  const probe = deps.probe ?? probeFastRunnerLivenessDetailed;
  const ensure = deps.ensure ?? ensureFastRunner;
  const prebuilt = deps.prebuilt ?? (() => hasBuiltTestProduct(derivedDataPathForRunner()));
  const adopt = deps.adopt ?? adoptPersistedFastRunnerState;

  adopt(deviceId ?? undefined);
  const first = await probe();
  // GH #418: artifact staleness at open — a respawn launches the same stale
  // .xctestrun, so skip it and invalidate up front (multi-LLM review amendment).
  if (isArtifactStaleReason(first.staleReason) && deps.allowArtifactRebuild && deviceId) {
    return rebuildStaleRunnerArtifact(first, deviceId, bundleId, deps);
  }
  const decision = decideRunnerSpawn({ liveness: first.liveness, prebuilt: prebuilt(), deviceId });
  if (decision.action === 'proceed') return { ok: true };
  // GH #418 (device-verify finding): open IS the sanctioned cold-build entry —
  // the not-prebuilt refusal exists for mid-flow auto-spawn (#210), and its
  // message directs users to open. With a device present, open must fall
  // through to ensure(), which cold-builds. Without this, any runner death
  // after a cold `xcodebuild test` (which leaves no .xctestrun) bricks opens.
  if (decision.action === 'error' && !(deps.allowArtifactRebuild && deviceId)) {
    // GH #418 (multi-review): a stale runner missing commands surfaces the
    // typed refusal even when nothing is prebuilt — not the generic
    // not-prebuilt message, whose code would be RN_FAST_RUNNER_DOWN.
    if (isArtifactStaleReason(first.staleReason)) {
      const missing =
        (first.missingCommands ?? first.missingFeatures ?? []).join(', ') || 'unknown';
      const kind = first.staleReason === 'missing-features' ? 'features' : 'commands';
      return {
        ok: false,
        code:
          first.staleReason === 'missing-features'
            ? 'RN_FAST_RUNNER_STALE'
            : 'RUNNER_COMMANDS_STALE',
        message:
          `rn-fast-runner artifact lacks required ${kind} (missing: ${missing}). ` +
          `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) ` +
          `to rebuild it (cold build, several minutes).`,
      };
    }
    if (first.staleReason === 'authority-mismatch') {
      return {
        ok: false,
        code: 'RUNNER_OWNERSHIP_MISMATCH',
        message:
          `rn-fast-runner authority identity does not match this session. ` +
          `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) to rebuild it.`,
      };
    }
    return { ok: false, message: decision.message };
  }

  const spawnDeviceId = decision.action === 'spawn' ? decision.deviceId : deviceId!;
  const spawnOpts = deps.attachOnly === true ? { attachOnly: true } : {};
  const launchCount = deps.launchCount ?? getRunnerLaunchCount;
  const launchesBefore = launchCount();
  await ensure(spawnDeviceId, bundleId, spawnOpts);
  let after = await probe();
  // GH #629: a fresh simulator's first XCTest bootstrap predictably overruns
  // the warm READY window and primes the next spawn — absorb it with exactly
  // one retry, gated on the first attempt having actually reached the launch
  // step (ensureFastRunner swallows artifact/cold-build failures, and re-paying
  // a multi-minute build that failed deterministically helps nobody) and on
  // that launch child having provably exited.
  let firstStartRetried = false;
  const launchesAfter = launchCount();
  if (after.liveness === 'dead' && !after.staleReason && launchesAfter > launchesBefore) {
    const firstSpawnGone = await (
      deps.awaitSpawnExit ?? (() => awaitSpawnedRunnerExit(undefined, launchesAfter))
    )();
    if (firstSpawnGone) {
      firstStartRetried = true;
      await ensure(spawnDeviceId, bundleId, spawnOpts);
      after = await probe();
    }
  }
  if (after.liveness === 'alive') {
    if (
      first.staleReason &&
      (PROTOCOL_STALE_REASONS.has(first.staleReason) || first.staleReason === 'authority-mismatch')
    ) {
      return {
        ok: true,
        note:
          first.staleReason === 'missing-commands'
            ? 'runner upgraded (stale command surface)'
            : first.staleReason === 'missing-features'
              ? 'runner upgraded (stale feature surface)'
              : first.staleReason === 'authority-mismatch'
                ? 'runner upgraded (authority identity mismatch)'
                : 'runner upgraded (protocol/version mismatch)',
      };
    }
    if (firstStartRetried) {
      return {
        ok: true,
        note: 'runner ready after one first-start retry (fresh-simulator XCTest bootstrap)',
      };
    }
    return { ok: true };
  }
  // GH #418: 'missing-commands' surviving a respawn means the ARTIFACT is
  // stale — mid-flow callers refuse fast (never a silent multi-minute build).
  if (
    after.staleReason &&
    (isArtifactStaleReason(after.staleReason) || after.staleReason === 'authority-mismatch')
  ) {
    // Open path, dead-runner-spawned-from-stale-prebuilt case: the first
    // probe said 'dead', so the up-front short-circuit couldn't fire — the
    // rebuild tier must still run here or the first open after an upgrade
    // errors and only the SECOND open heals (device-verify finding).
    if (deps.allowArtifactRebuild && deviceId) {
      return rebuildStaleRunnerArtifact(after, deviceId, bundleId, deps);
    }
    if (after.staleReason === 'authority-mismatch') {
      return {
        ok: false,
        code: 'RUNNER_OWNERSHIP_MISMATCH',
        message:
          `rn-fast-runner authority identity does not match this session. ` +
          `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) to rebuild it.`,
      };
    }
    const missing = (after.missingCommands ?? after.missingFeatures ?? []).join(', ') || 'unknown';
    const kind = after.staleReason === 'missing-features' ? 'features' : 'commands';
    return {
      ok: false,
      code:
        after.staleReason === 'missing-features' ? 'RN_FAST_RUNNER_STALE' : 'RUNNER_COMMANDS_STALE',
      message:
        `rn-fast-runner artifact lacks required ${kind} (missing: ${missing}). ` +
        `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) ` +
        `to rebuild it (cold build, several minutes).`,
    };
  }
  if (after.staleReason && PROTOCOL_STALE_REASONS.has(after.staleReason)) {
    return {
      ok: false,
      code: 'RUNNER_PROTOCOL_MISMATCH',
      message:
        `rn-fast-runner still speaks an incompatible wire protocol after reinstall ` +
        `(runner protocol ${after.runnerProtocolVersion ?? 'none'}, runnerVersion ${after.runnerVersion ?? 'unknown'}). ` +
        `The prebuilt XCUITest artifact is stale — rebuild it: delete the runner build/DerivedData directory ` +
        `and re-open the device session (cold build), or run xcodebuild build-for-testing (see plugin Prerequisites).`,
    };
  }
  return {
    ok: false,
    message:
      `rn-fast-runner did not become ready after auto-spawn${firstStartRetried ? ' (one internal retry included)' : ''}. ` +
      'Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.',
  };
}

export async function ensureFastRunner(
  deviceId: string,
  bundleId: string,
  // GH #382 (Codex P1): recovery forces a source rebuild by bypassing prebuilt.
  opts: { forceLocalBuild?: boolean; attachOnly?: boolean } = {},
): Promise<void> {
  // M7/Phase-109: probe tri-state liveness instead of the PID-only
  // isFastRunnerAvailable(). A runner whose PID is alive but whose HTTP server
  // has wedged ('stale') must be reaped before a fresh start — otherwise it is
  // reused and every subsequent device_* command burns the full HTTP timeout
  // before failing. /health responds in ms when healthy, so the happy path is
  // cheap; only a wedged runner pays the 2s probe timeout (vs. 10s per command).
  const liveness = await probeFastRunnerLiveness();
  if (liveness === 'alive') return;
  if (liveness === 'stale') {
    await reapStaleFastRunner();
  }
  try {
    await startFastRunner(deviceId, bundleId, undefined, opts);
  } catch (err) {
    console.error(
      `Fast runner auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Issue #103 — test-only override hook. Tests that exercise handlers
// orchestrating agent-device snapshots (e.g. cdp_repair_action) can
// inject a fake CLI response without booting a device. Production code
// path is untouched when the override is null.
type RunAgentDeviceFn = (
  cliArgs: string[],
  opts?: {
    skipSession?: boolean;
    platform?: 'ios' | 'android' | null;
    settle?: SettlePerCallOpts;
    retryIfNoChange?: boolean;
  },
) => Promise<ToolResult>;
let _runAgentDeviceOverrideForTest: RunAgentDeviceFn | null = null;

// GH #110: test-seam fuse. Once any production runAgentDevice call has
// dispatched in this process, refuse to install a new override —
// makes test-pollution-into-prod impossible by construction. The fuse
// is intentionally one-way: tests that need both production and override
// paths in the same suite should use `node --test --test-isolation=process`
// (Node 22 LTS supports this) to get a fresh worker per file. A reset
// seam here would defeat the entire guarantee — any code that could call
// the reset is the same code that could leak the override (Codex review
// conf 90).
let _testSeamFused = false;
let _testSeamFuseBlownBy: string | null = null;

export function _setRunAgentDeviceForTest(fn: RunAgentDeviceFn | null): void {
  if (_testSeamFused) {
    throw new Error(
      `_setRunAgentDeviceForTest: blown fuse — a production runNative ` +
        `call (cliArgs[0]=${JSON.stringify(_testSeamFuseBlownBy)}) already ` +
        `dispatched in this process. The test seam cannot be re-armed at runtime ` +
        `(GH #110 hardening). The most likely cause is a prior test forgot to ` +
        `clear its override in afterEach. Spawn a fresh Node process — e.g. ` +
        `\`node --test --test-isolation=process\` — if you genuinely need to ` +
        `mix production and override paths.`,
    );
  }
  _runAgentDeviceOverrideForTest = fn;
}

// GH #383: tool results are MCP envelopes (JSON text in content[0]) — attach
// meta by re-encoding, defensively. timings_ms is deep-merged so a settle
// timing never clobbers a dispatcher timing (or vice versa).
export function attachMeta(result: ToolResult, patch: Record<string, unknown>): ToolResult {
  try {
    const first = result.content?.[0];
    if (!first || first.type !== 'text') return result;
    const envelope = JSON.parse(first.text) as { meta?: Record<string, unknown> };
    const prevTimings = (envelope.meta?.timings_ms ?? {}) as Record<string, unknown>;
    const patchTimings = (patch.timings_ms ?? {}) as Record<string, unknown>;
    envelope.meta = {
      ...envelope.meta,
      ...patch,
      ...(Object.keys(prevTimings).length + Object.keys(patchTimings).length > 0
        ? { timings_ms: { ...prevTimings, ...patchTimings } }
        : {}),
    };
    return {
      ...result,
      content: [
        { type: 'text' as const, text: JSON.stringify(envelope) },
        ...result.content.slice(1),
      ],
    };
  } catch {
    return result;
  }
}

export function attachMetaNote(result: ToolResult, note: string): ToolResult {
  return attachMeta(result, { note });
}

export interface SettlePerCallOpts {
  enabled?: boolean;
  timeoutMs?: number;
}

export interface SettleContext {
  qaContext?: QaDispatchContext;
  platform: 'ios' | 'android';
  verb: string;
  appId?: string;
  settle?: SettlePerCallOpts;
  initialSnapshotHash?: string;
}

export interface SettleAfterMutationDeps {
  enabled?: (env: NodeJS.ProcessEnv) => boolean;
  capabilities?: (platform: 'ios' | 'android') => string[];
  probes?: (platform: 'ios' | 'android', appId?: string) => SettleProbes;
  wait?: typeof waitForSettle;
}

// Story 04 (#385): post-mutation settle at the dispatch choke point. Advisory
// by contract — a settle failure or timeout NEVER turns a succeeded action
// into an error; every path out of here returns the original result (with
// meta.settle attached when the engine ran). Dynamic import keeps the
// wrapper↔settle↔client module graph acyclic at load time.
//
// Story 05 (#386): also returns the raw SettleOutcome (null when settle never
// ran) so callers can inspect hierarchyChanged. A mutating verb that exits
// without a hash observation invalidates the ref-map's last snapshot hash —
// the screen may have changed unobserved, and a later tap comparing against
// the stale baseline would get a WRONG change verdict.
function resultMutation(result: ToolResult): unknown {
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
      meta?: { mutation?: unknown };
    };
    return envelope.meta?.mutation;
  } catch {
    return undefined;
  }
}

export async function settleAfterMutationWithOutcome(
  result: ToolResult,
  ctx: SettleContext,
  deps: SettleAfterMutationDeps = {},
): Promise<{ result: ToolResult; outcome: SettleOutcome | null }> {
  if (result.isError) {
    // mutation:'possible' means the gesture may have landed unobserved.
    if (resultMutation(result) === 'possible') invalidateLastSnapshotHash();
    return { result, outcome: null };
  }
  if (!SNAPSHOT_MUTATING_VERBS.has(ctx.verb)) return { result, outcome: null };
  if (ctx.settle?.enabled === false) {
    invalidateLastSnapshotHash(); // mutated + settled blind
    return { result, outcome: null };
  }
  try {
    const settle = await import('./lifecycle/settle.js');
    const enabled = deps.enabled ?? settle.settleEnabled;
    if (!enabled(process.env)) {
      invalidateLastSnapshotHash();
      return { result, outcome: null };
    }
    const capabilities = deps.capabilities
      ? deps.capabilities(ctx.platform)
      : ctx.platform === 'ios'
        ? (await import('./runners/rn-fast-runner-client.js')).getFastRunnerCapabilities()
        : (await import('./runners/rn-android-runner-client.js')).getAndroidRunnerCapabilities();
    const probes = deps.probes
      ? deps.probes(ctx.platform, ctx.appId)
      : ctx.platform === 'ios'
        ? settle.buildIosProbes(ctx.appId, ctx.qaContext)
        : settle.buildAndroidProbes(ctx.appId, ctx.qaContext);
    const wait = deps.wait ?? settle.waitForSettle;
    const outcome = await wait({
      platform: ctx.platform,
      capabilities,
      probes,
      ...(ctx.settle?.timeoutMs !== undefined ? { budgetMs: ctx.settle.timeoutMs } : {}),
      ...(ctx.initialSnapshotHash !== undefined
        ? { initialSnapshotHash: ctx.initialSnapshotHash }
        : {}),
    });
    if (outcome.hierarchyChanged === undefined) invalidateLastSnapshotHash();
    return {
      result: attachMeta(result, {
        settle: {
          method: outcome.method,
          settled: outcome.settled,
          ...(outcome.hierarchyChanged !== undefined
            ? { hierarchyChanged: outcome.hierarchyChanged }
            : {}),
        },
        timings_ms: { settle: outcome.ms },
      }),
      outcome,
    };
  } catch {
    invalidateLastSnapshotHash();
    return { result, outcome: null };
  }
}

export async function settleAfterMutation(
  result: ToolResult,
  ctx: SettleContext,
  deps: SettleAfterMutationDeps = {},
): Promise<ToolResult> {
  return (await settleAfterMutationWithOutcome(result, ctx, deps)).result;
}

export function selfHealEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.RN_SELF_HEAL?.trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

const RETRYABLE_TAP_COMMANDS = new Set<string>(['tap', 'longPress']);

export const IME_KEY_FLAG = '--ime-key';

export interface TapRetryPolicy {
  eligible: boolean;
  verificationRequired: boolean;
  targetKey: string;
}

// A runner acknowledgement proves dispatch, not effect. Effect observation may
// still classify the result, but it must never re-dispatch a command whose first
// actuation may already have happened. `eligible` remains in the internal shape
// for compatibility with callers while permanently disabling the old retry.
export function tapRetryPolicy(
  cliArgs: string[],
  builtCommand: string,
  x: number | undefined,
  y: number | undefined,
  _opts: { retryIfNoChange?: boolean },
): TapRetryPolicy {
  const ref = cliArgs[1] && pinnedElementRef(cliArgs[1]);
  const exactTarget = ref?.startsWith('@') ? getFreshRefTarget(ref) : null;
  // 'Key'/'Keyboard' are iOS XCUIElement type names; an Android IME key carries
  // a Java class name instead, so device_focus_next marks its verified
  // IME-owned press explicitly. Either way the effect lands in a window the
  // app-scoped probe cannot see, so re-dispatching would actuate the key twice.
  const keyboardTarget =
    exactTarget?.snapshotElementType === 'Key' ||
    exactTarget?.snapshotElementType === 'Keyboard' ||
    cliArgs.includes(IME_KEY_FLAG);
  const verificationRequired =
    !keyboardTarget &&
    RETRYABLE_TAP_COMMANDS.has(builtCommand) &&
    !cliArgs.includes('--double-tap') &&
    !cliArgs.includes('--count') &&
    !cliArgs.includes('--hold-ms') &&
    x !== undefined &&
    y !== undefined;
  return { eligible: false, verificationRequired, targetKey: `${builtCommand}@${x},${y}` };
}

function flagNoUiChange(result: ToolResult, targetKey: string): ToolResult {
  const distinct = recordNoUiChange(targetKey);
  return attachMeta(result, {
    noUiChange: true,
    ...(distinct >= WEDGED_DISTINCT_TARGETS ? { hint: WEDGED_RUNTIME_HINT } : {}),
  });
}

// Disabling settle (RN_SETTLE=0, or a per-call settle:{enabled:false} such as
// device_batch's settle:false step) opts out of every post-mutation probe, so
// effect verification cannot run and must not claim the effect is unprovable.
async function effectVerificationEnabled(
  settleOpts: SettlePerCallOpts | undefined,
  deps: SettleAfterMutationDeps,
): Promise<boolean> {
  if (settleOpts?.enabled === false) return false;
  if (deps.enabled) return deps.enabled(process.env);
  try {
    const settle = await import('./lifecycle/settle.js');
    return settle.settleEnabled(process.env);
  } catch {
    return true;
  }
}

// The effect probe compares a pre-interaction hierarchy hash against the
// post-settle one, so a missing baseline is not evidence of a swallowed tap.
// Any preceding mutating verb invalidates the baseline, so re-establish it
// before dispatch instead of failing the next tap as unverifiable.
export async function establishInteractionBaseline(
  ctx: {
    platform: 'ios' | 'android';
    appId?: string;
    settle?: SettlePerCallOpts;
    qaContext?: QaDispatchContext;
  },
  policy: TapRetryPolicy,
  deps: SettleAfterMutationDeps = {},
): Promise<string | undefined> {
  if (!policy.verificationRequired) return undefined;
  if (!(await effectVerificationEnabled(ctx.settle, deps))) return undefined;
  const cached =
    ctx.platform === 'android' && ctx.appId
      ? getLastSnapshotHashForPackage(ctx.appId)
      : getLastSnapshotHash();
  if (cached !== null) return cached;
  try {
    const settle = await import('./lifecycle/settle.js');
    const probes = deps.probes
      ? deps.probes(ctx.platform, ctx.appId)
      : ctx.platform === 'ios'
        ? settle.buildIosProbes(ctx.appId, ctx.qaContext)
        : settle.buildAndroidProbes(ctx.appId, ctx.qaContext);
    return (await probes.snapshotHash()) ?? undefined;
  } catch {
    return undefined;
  }
}

function unverifiedInteractionResult(
  observedResult: ToolResult,
  targetKey: string,
  reason: 'no-ui-change' | 'effect-probe-unavailable',
): ToolResult {
  const distinct = recordNoUiChange(targetKey);
  let observedMeta: Record<string, unknown> = {};
  try {
    const envelope = JSON.parse(observedResult.content[0].text) as {
      meta?: Record<string, unknown>;
    };
    observedMeta = envelope.meta ?? {};
  } catch {
    // The typed uncertainty below remains authoritative without optional detail.
  }
  return failResult(
    reason === 'no-ui-change'
      ? 'The tap was dispatched but produced no observable UI change.'
      : 'The tap was dispatched, but its UI effect could not be observed.',
    'INTERACTION_EFFECT_UNVERIFIED',
    {
      ...observedMeta,
      mutation: 'possible',
      reason,
      attempts: 1,
      ...(distinct >= WEDGED_DISTINCT_TARGETS ? { hint: WEDGED_RUNTIME_HINT } : {}),
    },
  );
}

// Observe the first dispatch exactly once. A runner acknowledgement proves
// dispatch, not app effect, so Android unchanged or unobservable outcomes fail
// with typed uncertainty while iOS keeps advisory meta.noUiChange. Observation
// uncertainty never authorizes replaying a possibly completed interaction.
export async function settleWithRetryIfNoChange(
  firstResult: ToolResult,
  _dispatch: () => Promise<ToolResult>,
  ctx: SettleContext,
  policy: TapRetryPolicy,
  deps: SettleAfterMutationDeps = {},
): Promise<ToolResult> {
  const verify = policy.verificationRequired && (await effectVerificationEnabled(ctx.settle, deps));
  const failClosed = verify && ctx.platform === 'android';
  const cachedHash =
    ctx.platform === 'android' && ctx.appId
      ? getLastSnapshotHashForPackage(ctx.appId)
      : getLastSnapshotHash();
  const preHash = verify ? (ctx.initialSnapshotHash ?? cachedHash ?? undefined) : undefined;
  const first = await settleAfterMutationWithOutcome(
    firstResult,
    { ...ctx, ...(preHash !== undefined ? { initialSnapshotHash: preHash } : {}) },
    deps,
  );
  if (first.result.isError || !verify) return first.result;
  if (preHash === undefined || first.outcome?.hierarchyChanged === undefined) {
    return failClosed
      ? unverifiedInteractionResult(first.result, policy.targetKey, 'effect-probe-unavailable')
      : first.result;
  }
  if (first.outcome.hierarchyChanged === true) {
    recordUiChange();
    return first.result;
  }
  return failClosed
    ? unverifiedInteractionResult(first.result, policy.targetKey, 'no-ui-change')
    : flagNoUiChange(first.result, policy.targetKey);
}

const MAX_STALE_CANDIDATES = 5;

type StaleReason = 'absent' | 'ambiguous' | 'no-signature' | 'snapshot-failed';

function staleRefFail(
  ref: string,
  reason: StaleReason,
  cachedMetadata: ReturnType<typeof getCachedMetadata>,
  candidates: FlatNode[] = [],
): ToolResult {
  const pinned = pinnedElementRef(ref);
  const message =
    reason === 'ambiguous'
      ? `Element at ref ${pinned} is stale and re-resolution matched ${candidates.length} elements — refusing to guess-tap`
      : `Element at ref ${pinned} no longer hittable — UI re-rendered since snapshot`;
  const hint =
    reason === 'ambiguous'
      ? 'Multiple elements share the cached identity. Use a unique target before retrying.'
      : reason === 'snapshot-failed'
        ? 'Snapshot infrastructure failed during re-resolution. Check cdp_status / reopen the device session, then retry.'
        : 'Element not re-resolvable by identity (it changed or unmounted). Call device_snapshot action=snapshot and re-find the target.';
  return failResult(message, reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'STALE_REF', {
    cachedMetadata,
    reResolution: reason,
    candidates: candidates.slice(0, MAX_STALE_CANDIDATES),
    hint,
  });
}

export type HealOutcome =
  | { kind: 'healed'; x: number; y: number; newRef: string; ms: number }
  | { kind: 'failed'; result: ToolResult };

function extractSnapshotNodes(result: ToolResult): FlatNode[] | null {
  if (result.isError) return null;
  try {
    const env = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: FlatNode[] };
    };
    if (env.ok === false) return null;
    return Array.isArray(env.data?.nodes) ? env.data.nodes : null;
  } catch {
    return null;
  }
}

// Story 05 (#386): re-resolve a stale @ref by identity instead of refusing.
// The snapshot closure must be the platform's real snapshot (it also refreshes
// the ref-map as a side effect). Signature + metadata are captured BEFORE the
// snapshot replaces the map.
export async function healStaleRef(
  staleRef: string,
  snapshot: () => Promise<ToolResult>,
): Promise<HealOutcome> {
  const t0 = Date.now();
  const cachedMetadata = getCachedMetadata(staleRef);
  const sig = getCachedSignature(staleRef);
  if (!sig)
    return { kind: 'failed', result: staleRefFail(staleRef, 'no-signature', cachedMetadata) };
  let nodes: FlatNode[] | null;
  try {
    nodes = extractSnapshotNodes(await snapshot());
  } catch {
    nodes = null;
  }
  if (!nodes)
    return { kind: 'failed', result: staleRefFail(staleRef, 'snapshot-failed', cachedMetadata) };
  const outcome: RefreshOutcome = refreshRef(sig, nodes);
  if (outcome.kind === 'unique') {
    const r = outcome.node.rect;
    return {
      kind: 'healed',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      newRef: outcome.node.ref,
      ms: Date.now() - t0,
    };
  }
  if (outcome.kind === 'ambiguous') {
    return {
      kind: 'failed',
      result: staleRefFail(staleRef, 'ambiguous', cachedMetadata, outcome.candidates),
    };
  }
  return { kind: 'failed', result: staleRefFail(staleRef, 'absent', cachedMetadata) };
}

export interface ExactTargetOpts {
  /** @ref of the bound input node (current generation). */
  inputRef: string;
  /** Declared focus-tap point — the wrapper center for Pressable-wrapped inputs. */
  focusX?: number;
  focusY?: number;
  focusWaitMs?: number;
  /** Secure input (from the binding snapshot) — Android's verify classifier needs it. */
  secure?: boolean;
  operationToken?: string;
}

export async function runNative(
  cliArgs: string[],
  opts: {
    qaTiming?: TimingContext;
    qaContext?: QaDispatchContext;
    qaReadOnly?: boolean;
    presenceBudgetMs?: number;
    skipSession?: boolean;
    platform?: 'ios' | 'android' | null;
    settle?: SettlePerCallOpts;
    retryIfNoChange?: boolean;
    verifyTypeReadback?: (
      expected: string,
    ) => Promise<{ matches: boolean; actual?: string | null }>;
    /** GH #581: exact input identity attached to type/verifyInput dispatches. */
    exactTarget?: ExactTargetOpts;
    /** Type into the already focused field; skip exact-target decoration. */
    focusedType?: boolean;
    focusedProof?: () => Promise<boolean>;
  } = {},
): Promise<ToolResult> {
  const qa = opts.qaContext !== undefined || opts.qaReadOnly === true;
  if (qa) {
    opts.qaContext?.assertComplete();
    if (!activeSession?.deviceId || !activeSession.appId) {
      if (opts.qaContext) opts.qaContext.invalidate();
      throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
    }
  }
  if (_runAgentDeviceOverrideForTest) {
    if (opts.focusedType && opts.focusedProof && !(await opts.focusedProof()))
      return failResult(
        'The intended input is not focused; no text was entered.',
        'NO_TEXT_INPUT_TARGET',
        { mutation: 'none' },
      );
    return _runAgentDeviceOverrideForTest(cliArgs, opts);
  }
  // GH #110: production dispatch reached. Lock the fuse BEFORE any tier
  // selection so a production call that throws downstream still seals
  // the seam (Codex review conf 90).
  if (!_testSeamFused) {
    _testSeamFused = true;
    _testSeamFuseBlownBy = cliArgs[0] ?? '<empty>';
  }

  // GH #321 (live-sim speedup): a screen-mutating verb invalidates the snapshot
  // cache so a subsequent device_find re-snapshots instead of targeting against
  // a now-stale picture of the screen. Marked here, at the single dispatch choke
  // point, so it covers iOS and Android uniformly. snapshot/screenshot don't
  // change the screen and are intentionally excluded.
  if (SNAPSHOT_MUTATING_VERBS.has(cliArgs[0])) {
    markSnapshotDirty();
  }

  // GH #105 iOS-MVP §3.1: iOS short-circuit. Every supported command goes
  // through our rn-fast-runner HTTP client (no daemon, no CLI). The runner
  // is started lazily — if no session has cold-launched it yet, we surface
  // a clear failure so the agent can call device_snapshot action=open.
  const targetPlatform = opts.platform ?? activeSession?.platform;
  if (targetPlatform === 'ios' && !opts.skipSession && RN_FAST_RUNNER_COMMANDS.has(cliArgs[0])) {
    const appId = activeSession?.appId ?? resolveBundleId('ios') ?? undefined;
    if (cliArgs[0] === 'snapshot' && cliArgs.includes('--platform-presence')) {
      const { runIOS } = await import('./runners/rn-fast-runner-client.js');
      return runIOS({
        ...buildRunIOSArgs(cliArgs, appId),
        presenceBudgetMs: opts.presenceBudgetMs,
        qaContext: opts.qaContext,
        qaReadOnly: opts.qaReadOnly,
        qaTiming: opts.qaTiming,
        deviceId: activeSession?.deviceId,
      });
    }
    // A2/#210: device_screenshot has its own simctl fallback (device-list.ts) — never block
    // it here; the gate is only for verbs that genuinely require the XCUITest runner.
    let upgradeNote: string | undefined;
    if (cliArgs[0] !== 'screenshot' && !qa) {
      const deviceId = activeSession?.deviceId ?? (await resolveBootedIosUdid());
      const ready = await ensureRunnerForCommand(deviceId ?? null, appId ?? '');
      if (!ready.ok) {
        // GH #382: discard any pending artifact note from a failed start.
        consumePendingFastRunnerArtifactNote();
        return failResult(ready.message, ready.code ?? 'RN_FAST_RUNNER_DOWN', {
          runnerPostMortem: getRunnerPostMortem(),
        });
      }
      upgradeNote = ready.note ?? consumePendingFastRunnerArtifactNote();
    }
    const { runIOS, captureFastRunnerCommandAuthority, verifyTypeResultAfterSettle } =
      await import('./runners/rn-fast-runner-client.js');
    let ios = buildRunIOSArgs(cliArgs, appId);
    ios.qaContext = opts.qaContext;
    ios.qaReadOnly = opts.qaReadOnly;
    ios.qaTiming = opts.qaTiming;
    ios.deviceId = activeSession?.deviceId;
    if (ios.command === 'type' && opts.verifyTypeReadback) {
      ios._verifyExactReadback = opts.verifyTypeReadback;
    }
    if (ios.command === 'type' && opts.focusedType) {
      ios.focused = true;
      ios._focusedProof = opts.focusedProof;
      delete ios._staleRef;
    } else if ((ios.command === 'type' || ios.command === 'verifyInput') && opts.exactTarget) {
      const decorated = decorateExactTargetIOS(ios, opts.exactTarget);
      if (decorated) {
        opts.qaContext?.invalidate();
        return decorated;
      }
    }
    if (ios.command === 'verifyInput' && !opts.exactTarget) {
      return failResult(
        'verify-input requires an exact bound input (internal dispatch without exactTarget)',
        'NO_TEXT_INPUT_TARGET',
        { mutation: 'none' },
      );
    }
    let healMeta: Record<string, unknown> | null = null;
    if (ios._staleRef) {
      const cachedTarget = getCachedMetadata(ios._staleRef);
      if (cachedTarget?.type === 'Key' || cachedTarget?.type === 'Keyboard') {
        opts.qaContext?.invalidate();
        return failResult(
          'KEYBOARD_TARGET_STALE: the latest-snapshot keyboard target is stale; no gesture was performed. Refresh the snapshot and retry.',
          'KEYBOARD_TARGET_STALE',
          { mutation: 'none' },
        );
      }
    }
    if (ios._staleRef && selfHealEnabled(process.env) && !qa) {
      const healed = await healStaleRef(ios._staleRef, () =>
        runIOS({
          command: 'snapshot',
          interactiveOnly: false,
          ...(appId ? { bundleId: appId } : {}),
        }),
      );
      if (healed.kind === 'failed') return healed.result;
      const reboundArgs = [...cliArgs];
      reboundArgs[1] = healed.newRef.startsWith('@') ? healed.newRef : `@${healed.newRef}`;
      ios = buildRunIOSArgs(reboundArgs, appId);
      if (ios.command === 'type' && opts.verifyTypeReadback) {
        ios._verifyExactReadback = opts.verifyTypeReadback;
      }
      if (ios._staleRef) {
        return staleRefFail(ios._staleRef, 'absent', getCachedMetadata(ios._staleRef));
      }
      healMeta = {
        reResolved: true,
        reResolvedRef: healed.newRef,
        timings_ms: { reResolve: healed.ms },
      };
    }
    const runnerAuthorityBefore = captureFastRunnerCommandAuthority();
    let result = await runIOS(ios);
    const iosPolicy = tapRetryPolicy(
      cliArgs,
      ios.command,
      ios.x,
      ios.y,
      opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {},
    );
    result = await settleWithRetryIfNoChange(
      result,
      () => runIOS(ios),
      {
        platform: 'ios',
        qaContext: opts.qaContext,
        verb: cliArgs[0],
        ...(appId ? { appId } : {}),
        ...(opts.settle ? { settle: opts.settle } : {}),
      },
      iosPolicy,
    );
    opts.qaContext?.assertComplete();
    result = await verifyTypeResultAfterSettle(ios, result, runnerAuthorityBefore);
    if (healMeta) result = attachMeta(result, healMeta);
    return upgradeNote ? attachMetaNote(result, upgradeNote) : result;
  }

  // `find` is intentionally NOT in this Set — Android, like iOS, treats `device_find`
  // as a pure-TS orchestrator (snapshot → match → tap) for cross-platform symmetry.
  // UIAutomator's `By.text()` returns regex-match semantics while findInLatestSnapshot
  // returns exact-or-substring; routing through the runner would diverge from iOS (D1217).
  const RN_ANDROID_RUNNER_COMMANDS = new Set<string>([
    'snapshot',
    'tap',
    'press',
    'fill',
    'type',
    'verify-input',
    'back',
    'screenshot',
    'keyboard',
    'swipe',
    'scroll',
    'drag',
    'longpress',
    'pinch',
  ]);

  // eradicate-agent-device Phase 2 Task 9: when the operator explicitly disables the
  // Android runner (RN_ANDROID_RUNNER=0), return an actionable error instead of
  // silently falling through to NO_NATIVE_ROUTE. There is no agent-device fallback.
  if (
    targetPlatform === 'android' &&
    process.env.RN_ANDROID_RUNNER === '0' &&
    !opts.skipSession &&
    RN_ANDROID_RUNNER_COMMANDS.has(cliArgs[0])
  ) {
    return failResult(
      'In-tree Android runner is the only device backend; the agent-device fallback was removed (eradicate-agent-device). Unset RN_ANDROID_RUNNER (or set it to anything but "0") to use it.',
      'RUNNER_DISABLED',
    );
  }

  if (
    targetPlatform === 'android' &&
    process.env.RN_ANDROID_RUNNER !== '0' &&
    !opts.skipSession &&
    RN_ANDROID_RUNNER_COMMANDS.has(cliArgs[0])
  ) {
    const appId = activeSession?.appId ?? resolveBundleId('android') ?? undefined;
    // Parity with the iOS short-circuit: ensure the runner is up before dispatch so
    // a cold device_* gets a clear RN_ANDROID_RUNNER_DOWN rather than a buried
    // "fetch failed" from runAndroid's internal catch. screenshot has its own adb
    // fallback (like iOS simctl) — don't gate it on the runner.
    if (cliArgs[0] !== 'screenshot' && !qa) {
      const { resolveAndroidSerial, startAndroidRunner, consumePendingAndroidUpgradeNote } =
        await import('./runners/rn-android-runner-client.js');
      const serial = activeSession?.deviceId ?? (await resolveAndroidSerial());
      if (!serial) {
        return failResult(
          'No Android device resolved (none booted, or multiple — pass deviceId / set ANDROID_SERIAL).',
          'RN_ANDROID_RUNNER_DOWN',
        );
      }
      try {
        await startAndroidRunner(serial, appId);
      } catch (err) {
        // GH #383: discard any note the failed start left pending — a stale
        // note must never attach to a LATER unrelated result.
        consumePendingAndroidUpgradeNote();
        const msg = err instanceof Error ? err.message : String(err);
        // GH #418: a stale command surface mid-flow is a fast refusal — the
        // open path (device_snapshot action=open) is the rebuild entry.
        if (msg.startsWith('RUNNER_COMMANDS_STALE')) {
          return failResult(msg, 'RUNNER_COMMANDS_STALE');
        }
        // GH #383: a protocol mismatch surviving the reap+reinstall is a distinct,
        // actionable failure — surface it rather than the generic runner-down.
        if (msg.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
          return failResult(msg, 'RUNNER_PROTOCOL_MISMATCH');
        }
        if (msg.startsWith('RUNNER_OWNERSHIP_MISMATCH')) {
          return failResult(msg, 'RUNNER_OWNERSHIP_MISMATCH');
        }
        return failResult(`rn-android-runner did not start: ${msg}`, 'RN_ANDROID_RUNNER_DOWN');
      }
    }
    const { runAndroid, consumePendingAndroidUpgradeNote } =
      await import('./runners/rn-android-runner-client.js');
    const outsideApp = androidOutsideAppWindowRefusal(cliArgs, appId);
    if (outsideApp) {
      opts.qaContext?.invalidate();
      return outsideAppWindowFailResult(outsideApp);
    }
    let android = buildRunAndroidArgs(cliArgs, appId);
    android.qaContext = opts.qaContext;
    android.qaReadOnly = opts.qaReadOnly;
    if ((android.command === 'type' || android.command === 'verifyInput') && opts.exactTarget) {
      const decorated = decorateExactTargetAndroid(android, opts.exactTarget);
      if (decorated) {
        opts.qaContext?.invalidate();
        return decorated;
      }
    }
    if (android.command === 'verifyInput' && !opts.exactTarget) {
      return failResult(
        'verify-input requires an exact bound input (internal dispatch without exactTarget)',
        'NO_TEXT_INPUT_TARGET',
        { mutation: 'none' },
      );
    }
    let healMeta: Record<string, unknown> | null = null;
    if (android._staleRef && selfHealEnabled(process.env) && !qa) {
      const healed = await healStaleRef(android._staleRef, () =>
        runAndroid({
          command: 'snapshot',
          interactiveOnly: false,
          deviceId: activeSession?.deviceId,
          ...(appId ? { bundleId: appId } : {}),
        }),
      );
      if (healed.kind === 'failed') return healed.result;
      const healedOutsideApp =
        android.includeSystemUi === true
          ? null
          : androidOutsideAppWindowRefusal(cliArgs, appId, healed.newRef);
      if (healedOutsideApp) return outsideAppWindowFailResult(healedOutsideApp);
      android = rebuildHealedAndroidArgs(
        cliArgs,
        healed.newRef,
        appId,
        android.includeSystemUi === true,
      );
      if (android._staleRef) {
        return staleRefFail(android._staleRef, 'absent', getCachedMetadata(android._staleRef));
      }
      healMeta = {
        reResolved: true,
        reResolvedRef: healed.newRef,
        timings_ms: { reResolve: healed.ms },
      };
    }
    const androidPolicy = tapRetryPolicy(
      cliArgs,
      android.command,
      android.x,
      android.y,
      opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {},
    );
    const androidBaseline = await establishInteractionBaseline(
      {
        platform: 'android',
        qaContext: opts.qaContext,
        ...(appId ? { appId } : {}),
        ...(opts.settle ? { settle: opts.settle } : {}),
      },
      androidPolicy,
    );
    let result = await runAndroid({ ...android, deviceId: activeSession?.deviceId });
    result = await settleWithRetryIfNoChange(
      result,
      () => runAndroid({ ...android, deviceId: activeSession?.deviceId }),
      {
        platform: 'android',
        qaContext: opts.qaContext,
        verb: cliArgs[0],
        ...(appId ? { appId } : {}),
        ...(opts.settle ? { settle: opts.settle } : {}),
        ...(androidBaseline !== undefined ? { initialSnapshotHash: androidBaseline } : {}),
      },
      androidPolicy,
    );
    if (healMeta) result = attachMeta(result, healMeta);
    const note = consumePendingAndroidUpgradeNote();
    opts.qaContext?.assertComplete();
    return note ? attachMetaNote(result, note) : result;
  }

  // No native route for this verb (open/close/devices/find are handled by their
  // own native tools; interaction verbs route via the iOS/Android short-circuits
  // above). The agent-device daemon + CLI tiers were removed (eradicate-agent-device).
  return failResult(
    `No native route for "${cliArgs[0]}". Open a device session (device_snapshot action=open) first, or use the dedicated tool for this verb.`,
    'NO_NATIVE_ROUTE',
  );
}
