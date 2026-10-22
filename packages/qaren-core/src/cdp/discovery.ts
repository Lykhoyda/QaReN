import {
  cancellationSignal,
  cancellableFetch,
  interruptible,
  sleep,
} from '../domain/cancellation.js';
import { execFileSync } from 'node:child_process';
import { getActiveSession } from '../agent-device-wrapper.js';
import { logger } from '../logger.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import type { HermesTarget, MetroCandidate } from '../types.js';
import { cwdForPort, pathMatchesRoot, resolveBridgeProjectRoot } from './metro-cwd.js';

/**
 * GH #208 (RC2): thrown by `discover()` when Metro IS reachable but advertises
 * zero Hermes debug targets — the app has detached (Expo dev launcher,
 * backgrounded, or crashed). Distinct from the "Metro not found" case so
 * callers (cdp_status) can trigger the bounded auto-relaunch recovery
 * (recover-detached.ts) instead of misreporting Metro as down. Carries the
 * resolved Metro port for the recovery + diagnostics.
 */
export class AppDetachedError extends Error {
  readonly port: number;
  /**
   * GH #303: all Metro ports found running at throw time. `.port` is preserved
   * for back-compat/diagnostics only — recover-detached.ts relaunches by the
   * active session's deviceId/appId and never reads it.
   */
  readonly runningPorts: number[];
  constructor(port: number, runningPorts: number[] = [port]) {
    super(
      `Metro is up on port ${port}` +
        (runningPorts.length > 1 ? ` (also running: ${runningPorts.join(', ')})` : '') +
        ` but advertises 0 Hermes debug targets — the app isn't attached ` +
        `(it may be on the Expo dev launcher, backgrounded, or crashed). Relaunch the app, ` +
        `or call cdp_status to auto-relaunch and reconnect.`,
    );
    this.name = 'AppDetachedError';
    this.port = port;
    this.runningPorts = runningPorts;
  }
}

export const DISCOVERY_TIMEOUT_MS = 1500;

/**
 * GH #629: thrown by `discover()` when NO candidate port is a running Metro.
 * Typed so cdp_status can skip its picker fallback (which auto-spawns the
 * device runner) and surface this truthful result within the discovery budget.
 */
export class MetroNotFoundError extends Error {
  readonly ports: number[];
  constructor(ports: number[]) {
    super(
      'Metro not found on ports ' +
        ports.join(', ') +
        '. Is the dev server running? Try: npx expo start or npx react-native start',
    );
    this.name = 'MetroNotFoundError';
    this.ports = ports;
  }
}

/**
 * GH #629: bounded "is any Metro up at all?" pre-check. One parallel
 * DISCOVERY_TIMEOUT_MS pass over the candidate ports — closed localhost ports
 * refuse in milliseconds, so a dead-Metro answer costs well under 2s.
 */
export async function anyMetroRunning(
  currentPort: number,
  timeout: number = DISCOVERY_TIMEOUT_MS,
): Promise<boolean> {
  const ports = [...new Set([currentPort, ...resolveDefaultPorts()])];
  return (await discoverAllMetroPorts(ports, timeout)).length > 0;
}

/**
 * GH #577: default discovery ports, resolved lazily at call time. When
 * RN_CDP_DISCOVERY_PORTS is set it REPLACES the built-in defaults (including
 * the RN_METRO_PORT entry) — an empty value yields no defaults, so discovery
 * probes only the caller-supplied current/hint port. This lets integration
 * tests own their entire discovery surface; production behavior is unchanged
 * when the variable is unset.
 */
export function resolveDefaultPorts(): number[] {
  const override = process.env.RN_CDP_DISCOVERY_PORTS;
  if (override !== undefined) {
    return (
      override
        .split(',')
        // Whole-value parse — parseInt would accept "9123abc"/"8081.5" as
        // 9123/8081 and silently probe an unintended Metro after a typo.
        .map((entry) => (entry.trim() === '' ? NaN : Number(entry.trim())))
        .filter((port) => Number.isInteger(port) && port > 0)
    );
  }
  const userPort = process.env.RN_METRO_PORT ? parseInt(process.env.RN_METRO_PORT, 10) : NaN;
  return [
    ...(Number.isInteger(userPort) && userPort > 0 ? [userPort] : []),
    8081,
    8082,
    19000,
    19006,
  ];
}

/**
 * GH #303: probe ALL candidate ports in parallel and return every one that is a
 * running Metro. The caller then prefers a port with an attached Hermes target
 * so a detached sibling-worktree Metro can't shadow a healthy one. (Replaces the
 * old first-match `discoverMetroPort`.) Closed localhost ports refuse fast (no
 * per-port timeout cost); only ports that accept but stall hit the timeout.
 */
export async function discoverAllMetroPorts(ports: number[], timeout: number): Promise<number[]> {
  const checks = await Promise.all(
    ports.map(async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const resp = await cancellableFetch(fetch, `http://127.0.0.1:${p}/status`, {
          signal: ctrl.signal,
        });
        const text = await resp.text();
        return text.includes('packager-status:running') ? p : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return checks.filter((p): p is number => p !== null);
}

export class TargetReadinessTimeoutError extends Error {}
export class TargetListAttemptTimeoutError extends TargetReadinessTimeoutError {}
export class BundleReadinessTimeoutError extends TargetReadinessTimeoutError {}

export async function fetchTargets(
  port: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<HermesTarget[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    // Only the run's cancellation preempts the read; the request timeout aborts the fetch itself.
    const cancel = cancellationSignal(signal);
    return await interruptible(async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: cancel ? AbortSignal.any([ctrl.signal, cancel]) : ctrl.signal,
      });
      return (await resp.json()) as HermesTarget[];
    }, cancel);
  } catch (err) {
    cancellationSignal(signal);
    const message = `Failed to list CDP targets on port ${port}: ${err instanceof Error ? err.message : err}`;
    if (ctrl.signal.aborted) throw new TargetListAttemptTimeoutError(message);
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

// Readiness only: exact discovery still owns target selection and authority.
export async function waitForExactPortTargets(
  port: number,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
  // Simulators share host loopback: another device's runtime on this port is not the run's.
  deviceName?: string,
  bundleId?: string,
): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('port must be an integer between 1 and 65535');
  }
  for (const [name, value] of [
    ['timeoutMs', timeoutMs],
    ['pollMs', pollMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new RangeError(`${name} must be an integer between 1 and 2147483647`);
    }
  }

  signal = cancellationSignal(signal);
  const pinnedDevice = deviceName?.trim();
  const deadline = performance.now() + timeoutMs;
  let remaining = deadline - performance.now();
  let otherBundleOnly = false;
  while (remaining > 0) {
    signal?.throwIfAborted();
    let raw: HermesTarget[] = [];
    let fetched = false;
    try {
      raw = await interruptible(
        () => fetchTargets(port, Math.min(DISCOVERY_TIMEOUT_MS * 2, remaining), signal),
        signal,
      );
      fetched = true;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TargetListAttemptTimeoutError)) throw error;
    }
    if (!Array.isArray(raw)) {
      throw new Error(`Invalid CDP target list on port ${port}: expected an array`);
    }
    const onDevice =
      pinnedDevice === undefined
        ? raw
        : raw.filter(
            (target) =>
              typeof target?.deviceName === 'string' && target.deviceName.trim() === pinnedDevice,
          );
    const ready =
      bundleId === undefined
        ? onDevice.length > 0
        : onDevice.some((target) => targetMatchesBundleId(target, bundleId));
    if (fetched) otherBundleOnly = bundleId !== undefined && onDevice.length > 0 && !ready;
    remaining = deadline - performance.now();
    if (remaining <= 0) break;
    if (ready) return;
    await sleep(Math.min(pollMs, remaining), signal);
    remaining = deadline - performance.now();
  }
  const Timeout = otherBundleOnly ? BundleReadinessTimeoutError : TargetReadinessTimeoutError;
  throw new Timeout(
    deviceName === undefined
      ? `Timed out waiting for CDP targets on port ${port} after ${timeoutMs}ms`
      : `Timed out waiting for a CDP target from device ${JSON.stringify(deviceName)} on port ${port} after ${timeoutMs}ms`,
  );
}

export function filterValidTargets(targets: HermesTarget[]): HermesTarget[] {
  return targets
    .filter(
      (t) =>
        !!t.webSocketDebuggerUrl &&
        !t.title?.includes('Experimental') &&
        (t.vm === 'Hermes' ||
          t.title?.includes('React Native') ||
          t.description?.includes('React Native')),
    )
    .map((t) => ({
      ...t,
      webSocketDebuggerUrl: t.webSocketDebuggerUrl
        ?.replace(/\[::1\]/g, '127.0.0.1')
        ?.replace(/\[::\]/g, '127.0.0.1'),
    }));
}

/**
 * B116 (D639): extract top-level bundle IDs from `xcrun simctl listapps booted`.
 * Also used (GH#202 Phase 4) against `simctl listapps <udid>` — same plist shape;
 * live-gated against a real device in Phase 4.
 * Output is NeXTSTEP plist; top-level keys are quoted bundle IDs at exactly
 * 4-space indentation, e.g. `    "com.foo.bar" = {`. We match that pattern
 * explicitly so we don't pick up nested keys like GroupContainers entries.
 */
export function parseSimctlListapps(stdout: string): Set<string> {
  const ids = new Set<string>();
  const TOP_LEVEL = /^    "([A-Za-z0-9._-]+)"\s*=\s*\{/;
  for (const line of stdout.split('\n')) {
    const m = line.match(TOP_LEVEL);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * Return the single, internally consistent bundle identity carried by Metro.
 * Bridgeless targets use a generic description and put the app ID in `appId`
 * or in the canonical `<bundleId> (<device>)` title. Conflicting valid IDs are
 * unproven and therefore fail closed rather than choosing the best-looking one.
 */
export function targetBundleIdentity(target: HermesTarget): string | null {
  if (!target || typeof target !== 'object') return null;
  const identities = new Map<string, string>();
  const add = (candidate: unknown) => {
    if (!isValidBundleId(candidate)) return;
    identities.set(candidate.toLowerCase(), candidate);
  };

  add(target.appId);
  add(target.description);

  const title = typeof target.title === 'string' ? target.title.trim() : '';
  add(title);
  const canonicalTitle = title.match(/^([^\s()]+)\s+\(.+\)$/);
  if (canonicalTitle) add(canonicalTitle[1]);

  return identities.size === 1 ? [...identities.values()][0] : null;
}

export function targetMatchesBundleId(target: HermesTarget, bundleId: string): boolean {
  if (!isValidBundleId(bundleId)) return false;
  return targetBundleIdentity(target)?.toLowerCase() === bundleId.toLowerCase();
}

// inferPlatforms runs on every connect/auto-connect, and each probe is a
// synchronous subprocess (1 + one per booted simulator). Installed-package sets
// change on the scale of installs, not connects, so a short TTL keeps the
// multi-simulator host off the blocking path without going stale in practice.
const PACKAGE_PROBE_TTL_MS = 15_000;
// A failed probe leaves every target 'defaulted', which fail-closes any
// platform-filtered connect. Keep a CHEAP failure barely long enough to absorb
// a burst of connects so a transient adb/simctl blip still self-heals on retry.
const PACKAGE_PROBE_FAILURE_TTL_MS = 1_500;
// A failure that burned this long came from subprocess timeouts, not a fast
// "tool absent" error. Re-paying it on every connect would block the event loop
// far worse than the staleness the short TTL buys.
const PACKAGE_PROBE_SLOW_FAILURE_MS = 1_000;
const packageProbeCache = new Map<string, { at: number; ttl: number; value: Set<string> | null }>();

function packageProbeTtl(value: Set<string> | null, elapsedMs: number): number {
  if (value !== null) return PACKAGE_PROBE_TTL_MS;
  return elapsedMs >= PACKAGE_PROBE_SLOW_FAILURE_MS
    ? PACKAGE_PROBE_TTL_MS
    : PACKAGE_PROBE_FAILURE_TTL_MS;
}

export function cachedPackageProbe(
  key: string,
  probe: () => Set<string> | null,
  clock: () => number = Date.now,
): Set<string> | null {
  const hit = packageProbeCache.get(key);
  const now = clock();
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const startedAt = clock();
  const value = probe();
  const finishedAt = clock();
  packageProbeCache.set(key, {
    at: finishedAt,
    ttl: packageProbeTtl(value, finishedAt - startedAt),
    value,
  });
  return value;
}

export function clearPackageProbeCache(): void {
  packageProbeCache.clear();
}

// GH #777 QA: adb reads are fenced to the device the registry binding authorizes
// — the same authority cdp_connect derives its exact-device proof from. Only that
// serial may be queried; an ambient shared phone is never probed.
export interface SessionDeviceBinding {
  platform?: string;
  deviceId?: string;
}

// Pure producer for the three-state fence. Only SESSION_NOT_INITIALIZED (or an
// unavailable status with no code) maps to null — legacy ambient may apply.
// Any other unavailable code is a present-but-failed authority
// (SESSION_OWNER_LOST, PROCESS_BIRTH_UNAVAILABLE, AUTHORITY_STORE_UNAVAILABLE,
// …) and must return the {} sentinel. An available authority with no device
// binding is also {}. A present device copies only string fields.
export function mapRegistryDeviceBinding(
  status:
    | { available: false; code?: string }
    | { available: true; bindings: Record<string, unknown> },
  runtimeInitialized = false,
): SessionDeviceBinding | null {
  if (!status.available) {
    const neverInitialized =
      !runtimeInitialized &&
      (status.code === undefined || status.code === 'SESSION_NOT_INITIALIZED');
    return neverInitialized ? null : {};
  }
  const device = status.bindings.device as { platform?: unknown; deviceId?: unknown } | undefined;
  if (!device) return {};
  const mapped: SessionDeviceBinding = {};
  if (typeof device.platform === 'string') mapped.platform = device.platform;
  if (typeof device.deviceId === 'string') mapped.deviceId = device.deviceId;
  return mapped;
}

export interface AndroidInventoryDependencies {
  execute?: (file: string, args: string[]) => string;
  getSession?: () => SessionDeviceBinding | null;
  getRegistryBinding?: () => SessionDeviceBinding | null;
}

let registryDeviceBindingProvider: (() => SessionDeviceBinding | null) | null = null;

export function setRegistryDeviceBindingProvider(
  provider: (() => SessionDeviceBinding | null) | null,
): void {
  registryDeviceBindingProvider = provider;
}

// Null means NO authority session exists in this worker (provider uninstalled
// or the runtime reports unavailable) — only then may legacy ambient behavior
// apply. An installed provider reporting an available authority with no device
// binding returns the {} sentinel instead, which fences adb downstream.
function registryDeviceBinding(): SessionDeviceBinding | null {
  if (!registryDeviceBindingProvider) return null;
  return registryDeviceBindingProvider() ?? null;
}

function runAdbSync(file: string, args: string[]): string {
  return execFileSync(file, args, {
    timeout: 3000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

type AndroidAdbScope =
  | { kind: 'ambient' }
  | { kind: 'serial'; serial: string }
  | { kind: 'fenced' };

// The registry binding is the only source that can authorize a serial; the
// device-wrapper session (including its disk-rehydrated state) can only revoke.
// Only a flow with both stores empty keeps the pre-existing single ambient read.
function androidAdbScope(deps: AndroidInventoryDependencies = {}): AndroidAdbScope {
  let registry: SessionDeviceBinding | null;
  try {
    registry = (deps.getRegistryBinding ?? registryDeviceBinding)();
  } catch {
    // A failing authority lookup is an unknown state, never ambient license.
    registry = {};
  }
  const session = (deps.getSession ?? getActiveSession)();
  if (!registry && !session) return { kind: 'ambient' };
  const authorized =
    registry?.platform === 'android' && registry.deviceId ? registry.deviceId : null;
  if (!authorized) return { kind: 'fenced' };
  if (session && (session.platform !== 'android' || session.deviceId !== authorized))
    return { kind: 'fenced' };
  return { kind: 'serial', serial: authorized };
}

export function authorizedAndroidSerial(deps: AndroidInventoryDependencies = {}): string | null {
  const scope = androidAdbScope(deps);
  return scope.kind === 'serial' ? scope.serial : null;
}

function probeAndroidPackagesInScope(
  scope: AndroidAdbScope,
  execute: (file: string, args: string[]) => string = runAdbSync,
): Set<string> | null {
  if (scope.kind === 'fenced') return null;
  try {
    const out =
      scope.kind === 'serial'
        ? execute('adb', ['-s', scope.serial, 'shell', 'pm', 'list', 'packages'])
        : execute('adb', ['shell', 'pm', 'list', 'packages']);
    return new Set(
      out
        .split('\n')
        .map((line) => line.replace('package:', '').trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

export function probeAndroidPackages(deps: AndroidInventoryDependencies = {}): Set<string> | null {
  return probeAndroidPackagesInScope(androidAdbScope(deps), deps.execute);
}

// The UDID and the device-name probe both need `simctl list devices booted`, so
// one cached parse feeds both instead of spawning the same 5s subprocess twice.
function probeBootedSimulatorInventory(): Set<string> | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    const entries = new Set<string>();
    for (const device of Object.values(parsed.devices ?? {}).flat()) {
      const udid = typeof device.udid === 'string' ? device.udid.trim() : '';
      const name = typeof device.name === 'string' ? device.name.trim() : '';
      const state = typeof device.state === 'string' ? device.state.trim() : '';
      if (!udid && !name) continue;
      entries.add(`${udid}\t${name}\t${state}`);
    }
    return entries.size > 0 ? entries : null;
  } catch {
    return null;
  }
}

function readBootedSimulatorInventory(): Set<string> | null {
  return cachedPackageProbe('ios-booted-simulators', probeBootedSimulatorInventory);
}

export function bootedSimulatorUdids(): string[] {
  const inventory = readBootedSimulatorInventory();
  if (!inventory) return [];
  return [...inventory].map((entry) => entry.split('\t')[0] ?? '').filter(Boolean);
}

// `simctl listapps booted` errors out as soon as more than one simulator is
// booted — the exact case this inference must survive. Probe each booted UDID
// exactly and union the results: platform inference asks "is this bundle an iOS
// app", which no single device owns.
function probeIOSPackages(): Set<string> | null {
  const udids = bootedSimulatorUdids();
  if (udids.length === 0) return null;
  const ids = new Set<string>();
  let probed = false;
  for (const udid of udids) {
    try {
      const out = execFileSync('xcrun', ['simctl', 'listapps', udid], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      probed = true;
      for (const id of parseSimctlListapps(out)) ids.add(id);
    } catch {
      // A single unreadable simulator must not blind the others.
    }
  }
  return probed ? ids : null;
}

function readAndroidPackages(): Set<string> | null {
  const scope = androidAdbScope();
  if (scope.kind === 'fenced') return null;
  const key = scope.kind === 'serial' ? `android:${scope.serial}` : 'android';
  return cachedPackageProbe(key, () => probeAndroidPackagesInScope(scope));
}

function readIOSPackages(): Set<string> | null {
  return cachedPackageProbe('ios', probeIOSPackages);
}

// GH #777: custom device names ("rn-qa", "ix-…-iPhone17Pro") carry no platform
// token, so pattern inference misses them and the bundle probe can only say
// "installed on both" — proving the platform requires the live device inventory.
// An empty inventory is an ABSENCE of evidence, never proof that a name is not
// a simulator: return null so the short failure TTL applies and a simulator
// booted moments later is seen on the next connect (mirrors probeIOSPackages).
function readIOSDeviceNames(): Set<string> | null {
  const inventory = readBootedSimulatorInventory();
  if (!inventory) return null;
  const names = new Set<string>();
  for (const entry of inventory) {
    const [, name, state] = entry.split('\t');
    if (state === 'Booted' && name) names.add(name.toLowerCase());
  }
  return names.size > 0 ? names : null;
}

function probeAndroidModelsInScope(
  scope: AndroidAdbScope,
  execute: (file: string, args: string[]) => string = runAdbSync,
): Set<string> | null {
  if (scope.kind !== 'serial') return null;
  try {
    const model = execute('adb', ['-s', scope.serial, 'shell', 'getprop', 'ro.product.model'])
      .trim()
      .toLowerCase();
    return model ? new Set([model]) : null;
  } catch {
    return null;
  }
}

export function probeAndroidDeviceModels(
  deps: AndroidInventoryDependencies = {},
): Set<string> | null {
  return probeAndroidModelsInScope(androidAdbScope(deps), deps.execute);
}

function readAndroidDeviceModels(): Set<string> | null {
  const scope = androidAdbScope();
  if (scope.kind !== 'serial') return null;
  return cachedPackageProbe(`android-device-models:${scope.serial}`, () =>
    probeAndroidModelsInScope(scope),
  );
}

// Metro reports Android deviceName as `<model>` or `<model> - <os> - API <n>`.
function nameMatchesAndroidModel(name: string, models: Set<string> | null): boolean {
  if (!models) return false;
  for (const model of models) {
    if (name === model || name.startsWith(`${model} -`)) return true;
  }
  return false;
}

export interface PlatformInferenceReaders {
  readAndroid?: () => Set<string> | null;
  readIOS?: () => Set<string> | null;
  readIOSDeviceNames?: () => Set<string> | null;
  readAndroidDeviceModels?: () => Set<string> | null;
}

export type ReaderOutcome = 'not_consumed' | 'null' | 'empty' | 'nonempty';

export type TargetInferenceEvidence = {
  token: 'ios' | 'android' | 'none';
  name: 'absent' | 'neither' | 'ios_only' | 'android_only' | 'both' | 'not_reached';
  identity: 'present' | 'missing' | 'not_reached';
  packages: 'neither' | 'ios_only' | 'android_only' | 'both' | 'not_reached';
  confidence: 'probed' | 'defaulted' | 'ambiguous';
  deviceMatch?: boolean;
  bundleMatch?: boolean;
};

export type PlatformInferenceSummary = {
  readers: {
    androidPackages: ReaderOutcome;
    iosPackages: ReaderOutcome;
    iosDeviceNames: ReaderOutcome;
    androidDeviceModels: ReaderOutcome;
  };
  targets: TargetInferenceEvidence[];
};

// shortcut: 'null' merges exec/parse failure, fenced scope and empty inventory; split at the readers only if a captured record needs the origin.
function readerOutcome(set: Set<string> | null | undefined): ReaderOutcome {
  if (set === undefined) return 'not_consumed';
  if (set === null) return 'null';
  return set.size === 0 ? 'empty' : 'nonempty';
}

function sides(ios: boolean, android: boolean): 'neither' | 'ios_only' | 'android_only' | 'both' {
  if (ios && android) return 'both';
  if (ios) return 'ios_only';
  return android ? 'android_only' : 'neither';
}

/**
 * B116 (D639): look up each target's description against BOTH iOS simctl and
 * Android adb installed-package sets. If present in only one, tag that
 * platform. If present in both (same bundleId installed on both devices),
 * we can't disambiguate from bundleId alone — leave the target ambiguous
 * (callers must pass `targetId` or `bundleId` + `platform`).
 * If present in neither (or lookup failed), fall back to iOS (matches prior
 * behavior — iOS-first bias).
 *
 * Readers are injectable for unit testing without spawning subprocesses.
 */
/**
 * B131 (D660): infer platform from Metro's `deviceName` field when present.
 * Metro 0.76+ includes this in /json/list (e.g. `"iPhone 17 Pro"` or
 * `"sdk_gphone16k_arm64 - 17 - API 37"`). Deterministic and survives the
 * ambiguous-bundle case where the same appId is installed on both platforms
 * (which defeats the B116 package-list inference). Returns null if the name
 * doesn't match either platform convention; caller falls back to package-list
 * inference.
 */
export function inferPlatformFromDeviceName(
  deviceName: string | undefined,
): 'ios' | 'android' | null {
  if (!deviceName) return null;
  const name = deviceName.toLowerCase();

  // Check iOS FIRST. Multi-review follow-up (L2): a user-renamed device like
  // "My Android-tester iPad" should be classified as iOS because it contains
  // `\bipad\b`. iOS patterns are narrower than Android patterns, so iOS-first
  // check yields fewer false positives. Android-only signals (sdk_gphone,
  // emulator, Pixel, Galaxy, OnePlus, API N) are unlikely to appear in iOS
  // device names the other direction.
  const iosPatterns = /\biphone\b|\bipad\b|\bipod\b|\bios\b/i;
  if (iosPatterns.test(name)) return 'ios';

  // Android patterns: emulator names (`sdk_gphone`, `emulator`), physical
  // device families (`Pixel`, `Galaxy`, `OnePlus`), the literal `android`, or
  // the `API N` suffix Metro appends on emulators.
  const androidPatterns =
    /sdk_gphone|emulator|\bpixel\b|\bgalaxy\b|\boneplus\b|\bandroid\b|\bapi\s+\d+\b/i;
  if (androidPatterns.test(name)) return 'android';

  return null;
}

export function inferPlatforms(
  targets: HermesTarget[],
  readers: PlatformInferenceReaders = {},
): PlatformInferenceSummary {
  const androidPackages = (readers.readAndroid ?? readAndroidPackages)();
  const iosPackages = (readers.readIOS ?? readIOSPackages)();
  let iosDeviceNames: Set<string> | null | undefined;
  let androidDeviceModels: Set<string> | null | undefined;
  const bootedIOSNames = () =>
    (iosDeviceNames ??= (readers.readIOSDeviceNames ?? readIOSDeviceNames)());
  const liveAndroidModels = () =>
    (androidDeviceModels ??= (readers.readAndroidDeviceModels ?? readAndroidDeviceModels)());
  const evidence: TargetInferenceEvidence[] = [];

  for (const t of targets) {
    // B131 (D660): deviceName is the most reliable signal when present.
    // It's deterministic (doesn't depend on adb/simctl running) and correct
    // even when the same bundleId is installed on both iOS and Android
    // (the exact case B116 marks `ambiguousPlatform`).
    const fromDeviceName = inferPlatformFromDeviceName(t.deviceName);
    if (fromDeviceName) {
      t.platform = fromDeviceName;
      t.platformInference = 'probed';
      evidence.push({
        token: fromDeviceName,
        name: 'not_reached',
        identity: 'not_reached',
        packages: 'not_reached',
        confidence: 'probed',
      });
      continue;
    }

    // GH #777: a token-less deviceName can still be proven against the live
    // device inventory. Only a one-sided match counts — a name in both
    // inventories stays with the fail-closed bundle inference below.
    const inventoryName = t.deviceName?.trim().toLowerCase();
    let name: TargetInferenceEvidence['name'] = 'absent';
    if (inventoryName) {
      const inIOSInventory = bootedIOSNames()?.has(inventoryName) ?? false;
      const inAndroidInventory = nameMatchesAndroidModel(inventoryName, liveAndroidModels());
      name = sides(inIOSInventory, inAndroidInventory);
      if (inIOSInventory !== inAndroidInventory) {
        t.platform = inIOSInventory ? 'ios' : 'android';
        t.platformInference = 'probed';
        evidence.push({
          token: 'none',
          name,
          identity: 'not_reached',
          packages: 'not_reached',
          confidence: 'probed',
        });
        continue;
      }
    }

    const bundleIdentity = targetBundleIdentity(t);
    const inAndroid = bundleIdentity ? (androidPackages?.has(bundleIdentity) ?? false) : false;
    const inIOS = bundleIdentity ? (iosPackages?.has(bundleIdentity) ?? false) : false;

    if (inAndroid && !inIOS) {
      t.platform = 'android';
      t.platformInference = 'probed';
    } else if (inIOS && !inAndroid) {
      t.platform = 'ios';
      t.platformInference = 'probed';
    } else if (inAndroid && inIOS) {
      // Ambiguous — same bundleId installed on both. Default to iOS but mark
      // for downstream so callers can notice and pass targetId/bundleId filter.
      t.platform = 'ios';
      t.ambiguousPlatform = true;
      t.platformInference = 'ambiguous';
    } else {
      // No information (adb/simctl both failed, or target bundle unknown) —
      // default to iOS to preserve prior behavior for iOS-only setups.
      t.platform = 'ios';
      t.platformInference = 'defaulted';
    }
    evidence.push({
      token: 'none',
      name,
      identity: bundleIdentity ? 'present' : 'missing',
      packages: bundleIdentity ? sides(inIOS, inAndroid) : 'not_reached',
      confidence: t.platformInference,
    });
  }
  return {
    readers: {
      androidPackages: readerOutcome(androidPackages),
      iosPackages: readerOutcome(iosPackages),
      iosDeviceNames: readerOutcome(iosDeviceNames),
      androidDeviceModels: readerOutcome(androidDeviceModels),
    },
    targets: evidence,
  };
}

export type TargetSelectionErrorCode =
  | 'PLATFORM_TARGET_NOT_FOUND'
  | 'TARGET_PLATFORM_CONFLICT'
  | 'DEVICE_TARGET_NOT_FOUND'
  | 'DEVICE_TARGET_AMBIGUOUS'
  | 'BUNDLE_TARGET_NOT_FOUND';

export interface SelectTargetResult {
  targets: HermesTarget[];
  warning?: string;
  errorCode?: TargetSelectionErrorCode;
}

export function describeTarget(target: HermesTarget): string {
  const confidence = target.platformInference ?? 'probed';
  return `${target.id} title="${target.title || '?'}" appId="${target.appId ?? '?'}" device="${target.deviceName ?? '?'}" description="${target.description ?? '?'}" platform=${target.platform ?? '?'} confidence=${confidence}`;
}

/** Metro target ids are `<device>-<page>`; the device part may contain hyphens. */
function metroDeviceConnectionId(id: string | undefined): string {
  if (!id) return '';
  const cut = id.lastIndexOf('-');
  return cut > 0 ? id.slice(0, cut) : id;
}

function metroPageNumber(id: string | undefined): number {
  if (!id) return 0;
  const cut = id.lastIndexOf('-');
  const page = cut > 0 ? Number.parseInt(id.slice(cut + 1), 10) : NaN;
  return Number.isNaN(page) ? 0 : page;
}

export class TargetSelectionError extends Error {
  constructor(
    readonly code: TargetSelectionErrorCode,
    message: string,
    readonly candidates: readonly HermesTarget[],
    readonly inference?: PlatformInferenceSummary,
  ) {
    super(message);
    this.name = 'TargetSelectionError';
  }
}

export type AndroidDeviceKind = 'emulator' | 'physical';

export function classifyAndroidDeviceKind(
  deviceName: string | undefined,
): AndroidDeviceKind | 'unknown' {
  if (!deviceName) return 'unknown';
  return /sdk_gphone|emulator|\bapi\s+\d+\b/i.test(deviceName) ? 'emulator' : 'physical';
}

// deviceName classification is best-effort: it can miss an emulator (older
// AVD names, Genymotion) but essentially never labels a physical phone as an
// emulator. So 'physical' enforcement is hard (silent emulator binding is the
// GH #589 bug), while 'emulator' enforcement must stay soft.
export function androidTargetMatchesKind(
  deviceName: string | undefined,
  kind: AndroidDeviceKind,
): boolean {
  const targetKind = classifyAndroidDeviceKind(deviceName);
  return kind === 'physical' ? targetKind === 'physical' : targetKind !== 'physical';
}

export interface SelectTargetFilters {
  platform?: string;
  /** Bind Android discovery to the active session's physical/emulator class. */
  deviceKind?: 'emulator' | 'physical';
  /** Exact match against `target.id` — precise selection from cdp_targets output. */
  targetId?: string;
  /** Exact match against Metro's proven appId/description/canonical title identity. */
  bundleId?: string;
  /** Preferred bundleId (auto-selection hint, non-hard-filter). Used to break ties. */
  preferredBundleId?: string;
  /** GH #625: hard device affinity (exact deviceName). Internal reconnect pin:
   * when set, a missing targetId re-resolves WITHIN this device instead of
   * failing, since page ids churn on reload. Never exposed to tool callers. */
  deviceName?: string;
}

export function selectTarget(
  validTargets: HermesTarget[],
  filtersOrPlatform?: string | SelectTargetFilters,
): SelectTargetResult {
  // Legacy single-string signature kept for back-compat; new callers pass an object.
  const filters: SelectTargetFilters =
    typeof filtersOrPlatform === 'string'
      ? { platform: filtersOrPlatform }
      : (filtersOrPlatform ?? {});

  let filteredTargets = validTargets;
  const warnings: string[] = [];
  let warnNoPlatformFilter = false;

  // GH #625: device affinity outranks the page-scoped targetId. Metro page ids
  // churn on reload and can be reused across devices after a Metro restart, so
  // the pinned deviceName is the only durable identity. Fail closed when it
  // cannot be re-proven — never silently bind a sibling simulator.
  if (filters.deviceName) {
    const pinnedDevice = filters.deviceName.trim();
    const deviceMatched = filteredTargets.filter(
      (target) => target.deviceName?.trim() === pinnedDevice,
    );
    if (deviceMatched.length === 0) {
      return {
        targets: [],
        errorCode: 'DEVICE_TARGET_NOT_FOUND',
        warning:
          `Pinned device "${pinnedDevice}" has no live CDP target on this Metro; refusing to silently bind a different device. ` +
          `Candidates: ${validTargets.map(describeTarget).join('; ')}. ` +
          `Relaunch the app on the pinned device, or re-pin deliberately via cdp_targets + cdp_connect targetId.`,
      };
    }
    // The affinity must land on exactly ONE Metro device connection. Metro ids
    // are `<device>-<page>` (device may itself contain hyphens). Metro opens a
    // device connection per debuggable runtime, so several prefixes under one
    // deviceName can be either one device running several apps — which the
    // proven bundle identity disambiguates — or two same-named devices, which
    // Metro metadata cannot tell apart even on an exact page-id match (ids are
    // recycled across Metro restarts). Fail closed unless the bundle narrows it.
    const devicePrefixes = new Set(deviceMatched.map((t) => metroDeviceConnectionId(t.id)));
    if (devicePrefixes.size > 1) {
      const bundleScoped = filters.bundleId
        ? deviceMatched.filter((target) => targetMatchesBundleId(target, filters.bundleId!))
        : [];
      const bundleConnections = new Set(bundleScoped.map((t) => metroDeviceConnectionId(t.id)));
      if (bundleConnections.size !== 1) {
        return {
          targets: [],
          errorCode: 'DEVICE_TARGET_AMBIGUOUS',
          warning:
            `Pinned device name "${pinnedDevice}" matches ${devicePrefixes.size} live Metro device connections and ` +
            (filters.bundleId
              ? `pinned bundleId "${filters.bundleId}" narrows them to ${bundleConnections.size}`
              : `no proven bundle identity is pinned to narrow them`) +
            `; refusing an ambiguous bind. ` +
            `Candidates: ${deviceMatched.map(describeTarget).join('; ')}. ` +
            `Re-pin deliberately via cdp_targets + cdp_connect targetId.`,
        };
      }
      filteredTargets = bundleScoped;
    } else {
      filteredTargets = deviceMatched;
    }
  }

  // Selection precedence continues with an exact target id. It is exact
  // identity, but it never overrides an explicit/session platform constraint —
  // and with a device affinity pinned it cannot escape that device.
  if (filters.targetId) {
    const idMatched = filteredTargets.filter((t) => t.id === filters.targetId);
    if (idMatched.length > 0) {
      filteredTargets = idMatched;
    } else if (!filters.deviceName) {
      return {
        targets: [],
        warning: `targetId "${filters.targetId}" not found. Available ids: ${validTargets.map((t) => t.id).join(', ')}`,
      };
    } else if (!filters.bundleId) {
      // Device affinity without proven app identity cannot re-resolve a stale
      // pin — a device can run several debuggable apps. Fail closed.
      return {
        targets: [],
        warning:
          `Pinned targetId "${filters.targetId}" is stale and no proven bundle identity is pinned; refusing to re-resolve on device "${filters.deviceName.trim()}" without app identity. ` +
          `Candidates: ${filteredTargets.map(describeTarget).join('; ')}. ` +
          `Re-pin deliberately via cdp_targets + cdp_connect targetId.`,
      };
    } else {
      warnings.push(
        `Pinned targetId "${filters.targetId}" is stale (Metro page ids change on reload); re-resolving on pinned device "${filters.deviceName.trim()}".`,
      );
    }
  }

  if (filters.platform) {
    const platform = filters.platform.toLowerCase();
    const platformMatched = filteredTargets.filter(
      (target) =>
        target.platform === platform &&
        (target.platformInference === undefined || target.platformInference === 'probed'),
    );
    if (platformMatched.length === 0) {
      const code = filters.targetId ? 'TARGET_PLATFORM_CONFLICT' : 'PLATFORM_TARGET_NOT_FOUND';
      return {
        targets: [],
        errorCode: code,
        warning:
          `${code}: requested platform "${filters.platform}" cannot be proven for the live target set. ` +
          `Candidates: ${validTargets.map(describeTarget).join('; ')}. ` +
          `Run cdp_targets, relaunch the requested app, or pass a targetId from a proven target.`,
      };
    }
    filteredTargets = platformMatched;
  } else if (
    validTargets.length > 0 &&
    !filters.targetId &&
    !filters.bundleId &&
    !filters.deviceKind &&
    !filters.preferredBundleId &&
    !filters.deviceName
  ) {
    warnNoPlatformFilter = true;
  }

  if (filters.deviceKind) {
    const kind = filters.deviceKind;
    const deviceMatched = filteredTargets.filter((target) =>
      androidTargetMatchesKind(target.deviceName, kind),
    );
    const availableDevices = filteredTargets
      .map((target) => target.deviceName ?? '<identity unavailable>')
      .join(', ');
    if (deviceMatched.length > 0) {
      filteredTargets = deviceMatched;
    } else if (kind === 'physical') {
      return {
        targets: [],
        warning:
          `No physical CDP target matched the active Android session. ` +
          `Available devices: ${availableDevices}`,
      };
    } else {
      warnings.push(
        `No CDP target was positively identified as an emulator for the active Android session (devices: ${availableDevices}). Connecting to best available target.`,
      );
    }
  }

  // bundleId is hard and platform-scoped whenever a platform authority exists.
  if (filters.bundleId) {
    const bundleMatched = filteredTargets.filter((target) =>
      targetMatchesBundleId(target, filters.bundleId!),
    );
    if (bundleMatched.length === 0) {
      return {
        targets: [],
        errorCode: 'BUNDLE_TARGET_NOT_FOUND',
        warning: `bundleId "${filters.bundleId}" not found in proven live target metadata. Candidates: ${filteredTargets.map(describeTarget).join('; ')}`,
      };
    }
    filteredTargets = bundleMatched;
  }

  // B111 (D643): preferredBundleId is a SOFT filter — auto-selection hint
  // (case-insensitive). Only applied when it narrows without eliminating
  // all candidates. Auto-populated from project-config.ts in connect.ts.
  const prefLower = filters.preferredBundleId?.toLowerCase();
  if (prefLower && filteredTargets.length > 1) {
    const preferred = filteredTargets.filter((target) =>
      targetMatchesBundleId(target, filters.preferredBundleId!),
    );
    if (preferred.length > 0 && preferred.length < filteredTargets.length) {
      logger.info(
        'CDP',
        `Auto-selected target by preferredBundleId "${filters.preferredBundleId}" (${preferred.length} of ${filteredTargets.length})`,
      );
      filteredTargets = preferred;
    }
  }

  // B111 (D643): deterministic sort. Primary: page-id desc (newer first).
  // Tie-break 1: preferredBundleId-matched targets win.
  // Tie-break 2: lexicographic by full id (eliminates JS sort stability dependency).
  const sorted = [...filteredTargets].sort((a, b) => {
    const aPage = metroPageNumber(a.id);
    const bPage = metroPageNumber(b.id);
    if (aPage !== bPage) return bPage - aPage;
    if (prefLower) {
      const aPref = targetMatchesBundleId(a, prefLower) ? 1 : 0;
      const bPref = targetMatchesBundleId(b, prefLower) ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (warnNoPlatformFilter && sorted.length > 0) {
    warnings.push(
      `No platform filter was supplied; connecting to the best available target without cross-platform affinity (${describeTarget(sorted[0])}). Pass platform to fail closed.`,
    );
  }

  return { targets: sorted, warning: warnings.length > 0 ? warnings.join(' | ') : undefined };
}

export interface AttachedPort {
  port: number;
  targets: HermesTarget[];
}

export interface SelectMetroPortCtx {
  currentPort: number;
  projectRoot?: string;
  preferredBundleId?: string;
  cwdForPort: (port: number) => string | null;
}

/**
 * GH #303: pick the right Metro port among those running. Correctness first
 * (only `attached` ports — those with a live Hermes target — are candidates),
 * then worktree disambiguation. Pure + injectable (`cwdForPort`) for testing.
 *
 * Precedence when >1 port is attached:
 *   1. projectRoot cwd-match — the Metro whose serving dir is (or contains / is
 *      contained by) this bridge's project root. Most specific worktree signal.
 *   2. preferredBundleId — exactly one attached port serves the preferred bundle.
 *   3. sticky currentPort if attached, else lowest attached port + a warning.
 */
export function selectMetroPort(
  attached: AttachedPort[],
  runningPorts: number[],
  ctx: SelectMetroPortCtx,
): { port: number; warning?: string } {
  if (attached.length === 0) {
    throw new AppDetachedError(runningPorts[0] ?? ctx.currentPort, runningPorts);
  }
  if (attached.length === 1) {
    return { port: attached[0].port };
  }

  // 1. projectRoot cwd-match (realpath-normalized, containment-aware).
  if (ctx.projectRoot) {
    const matches = attached.filter((a) =>
      pathMatchesRoot(ctx.cwdForPort(a.port), ctx.projectRoot),
    );
    if (matches.length === 1) return { port: matches[0].port };
  }

  // 2. preferredBundleId port-level tie-break (exactly one attached port serves it).
  if (ctx.preferredBundleId) {
    const pref = ctx.preferredBundleId.toLowerCase();
    const prefPorts = attached.filter((a) =>
      a.targets.some((target) => targetMatchesBundleId(target, pref)),
    );
    if (prefPorts.length === 1) return { port: prefPorts[0].port };
  }

  // 3. sticky currentPort if attached, else lowest attached port + disambiguation warning.
  const attachedPortNums = attached.map((a) => a.port).sort((x, y) => x - y);
  const chosen = attachedPortNums.includes(ctx.currentPort) ? ctx.currentPort : attachedPortNums[0];
  const list = attached
    .map((a) => {
      const cwd = ctx.cwdForPort(a.port);
      return `:${a.port}${cwd ? ` (${cwd})` : ''}`;
    })
    .join(', ');
  return {
    port: chosen,
    warning: `Multiple live Metros with an attached app: ${list}. Picked :${chosen}. Pass metroPort explicitly to choose a different worktree.`,
  };
}

export interface DiscoveryResult {
  port: number;
  targets: HermesTarget[];
  warning?: string;
  errorCode?: TargetSelectionErrorCode;
  candidates?: HermesTarget[];
  inference?: PlatformInferenceSummary;
}

export async function discoverExactPort(
  currentPort: number,
  platformFilterOrFilters?: string | SelectTargetFilters,
): Promise<DiscoveryResult> {
  const filters: SelectTargetFilters =
    typeof platformFilterOrFilters === 'string'
      ? { platform: platformFilterOrFilters }
      : (platformFilterOrFilters ?? {});
  const raw = await fetchTargets(currentPort, DISCOVERY_TIMEOUT_MS * 2);
  const validTargets = filterValidTargets(raw).filter((target) => {
    try {
      const { hostname, port } = new URL(target.webSocketDebuggerUrl);
      return (hostname === '127.0.0.1' || hostname === 'localhost') && Number(port) === currentPort;
    } catch {
      return false;
    }
  });
  const inference = inferPlatforms(validTargets);
  const { targets, warning, errorCode } = selectTarget(validTargets, filters);
  if (errorCode) {
    // Value-free: same comparisons selectTarget makes, never read back by selection.
    inference.targets.forEach((entry, index) => {
      const target = validTargets[index]!;
      if (filters.deviceName)
        entry.deviceMatch =
          typeof target.deviceName === 'string' &&
          target.deviceName.trim() === filters.deviceName.trim();
      if (filters.bundleId) entry.bundleMatch = targetMatchesBundleId(target, filters.bundleId);
    });
  }
  return {
    port: currentPort,
    targets,
    ...(warning ? { warning } : {}),
    ...(errorCode ? { errorCode, candidates: validTargets, inference } : {}),
  };
}

export async function listTargetsOnExactPort(
  port: number,
): Promise<{ port: number; targets: HermesTarget[] }> {
  const result = await discoverExactPort(port);
  return { port, targets: result.targets };
}

export async function discover(
  currentPort: number,
  platformFilterOrFilters?: string | SelectTargetFilters,
): Promise<DiscoveryResult> {
  const filters: SelectTargetFilters =
    typeof platformFilterOrFilters === 'string'
      ? { platform: platformFilterOrFilters }
      : (platformFilterOrFilters ?? {});
  const ports = [...new Set([currentPort, ...resolveDefaultPorts()])];
  const hints: string[] = [];
  if (filters.platform) hints.push(`platform=${filters.platform}`);
  if (filters.deviceKind) hints.push(`deviceKind=${filters.deviceKind}`);
  if (filters.targetId) hints.push(`targetId=${filters.targetId}`);
  if (filters.bundleId) hints.push(`bundleId=${filters.bundleId}`);
  if (filters.preferredBundleId) hints.push(`preferredBundleId=${filters.preferredBundleId}`);
  if (filters.deviceName) hints.push(`deviceName=${filters.deviceName}`);
  logger.debug(
    'CDP',
    `Discovering Metro on ports: ${ports.join(', ')}${hints.length ? ` (${hints.join(', ')})` : ''}`,
  );

  // GH #303: probe ALL candidate ports, then prefer one with an attached Hermes
  // target so a detached sibling-worktree Metro can't shadow a healthy one.
  const runningPorts = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
  if (runningPorts.length === 0) {
    throw new MetroNotFoundError(ports);
  }

  const perPort = await Promise.all(
    runningPorts.map(async (p) => {
      try {
        const raw = await fetchTargets(p, DISCOVERY_TIMEOUT_MS * 2);
        const valid = filterValidTargets(raw).filter((t) => {
          try {
            const { hostname } = new URL(t.webSocketDebuggerUrl!);
            return hostname === '127.0.0.1' || hostname === 'localhost';
          } catch {
            return false;
          }
        });
        return { port: p, targets: valid };
      } catch {
        return { port: p, targets: [] as HermesTarget[] };
      }
    }),
  );

  const attached = perPort.filter((pp) => pp.targets.length > 0);
  // selectMetroPort throws AppDetachedError when nothing is attached (preserving
  // the existing catch in status.ts), carrying the full running-port list.
  const { port: metroPort, warning: portWarning } = selectMetroPort(attached, runningPorts, {
    currentPort,
    projectRoot: resolveBridgeProjectRoot() ?? undefined,
    preferredBundleId: filters.preferredBundleId,
    cwdForPort: (p) => cwdForPort(p),
  });
  logger.info('CDP', `Metro selected on port ${metroPort} (running: ${runningPorts.join(', ')})`);

  const validTargets = attached.find((pp) => pp.port === metroPort)!.targets;

  inferPlatforms(validTargets);

  const {
    targets: sorted,
    warning: selectWarning,
    errorCode,
  } = selectTarget(validTargets, filters);
  const warning = [portWarning, selectWarning].filter(Boolean).join(' | ') || undefined;

  logger.debug(
    'CDP',
    `Found ${sorted.length} valid target(s): ${sorted.map((t) => `${t.id} (${t.title}, platform=${t.platform ?? '?'})`).join(', ')}`,
  );

  return {
    port: metroPort,
    targets: sorted,
    warning,
    ...(errorCode ? { errorCode, candidates: validTargets } : {}),
  };
}

export async function discoverForList(
  currentPort: number,
  portHint?: number,
): Promise<{ port: number; targets: HermesTarget[] }> {
  const ports = [...new Set([portHint ?? currentPort, ...resolveDefaultPorts()])];
  // GH #303: prefer a running port that actually has targets over the first
  // running one, so cdp_targets can't inspect a different Metro than discover()
  // selected. No cwd auto-pick needed here — just attached-preference.
  const running = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
  if (running.length === 0) {
    throw new Error('Metro not found on ports ' + ports.join(', '));
  }
  let chosen = running[0];
  let targets: HermesTarget[] = [];
  for (const p of running) {
    try {
      const valid = filterValidTargets(await fetchTargets(p, DISCOVERY_TIMEOUT_MS * 2));
      if (valid.length > 0) {
        chosen = p;
        targets = valid;
        break;
      }
    } catch {
      /* try next running port */
    }
  }
  inferPlatforms(targets);

  return { port: chosen, targets };
}

/**
 * GH #303: best-effort enumeration of live Metros for cdp_status diagnostics —
 * decoupled from discover() so it works even on the already-connected path. Fast
 * path (honors the spec's "single-Metro = one lsof"): when only the connected
 * Metro is up, skip per-port fetchTargets + extra lsof and resolve just the
 * connected port's cwd for the mismatch check, omitting the candidates array.
 */
export async function enumerateMetroCandidates(
  connectedPort: number,
  projectRoot: string | undefined,
): Promise<{
  candidates?: MetroCandidate[];
  servingCwd: string | null;
  timings_ms: { probe: number; cwd: number };
}> {
  const t0 = performance.now();
  const ports = [...new Set([connectedPort, ...resolveDefaultPorts()])];
  const running = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
  const tProbe = performance.now();

  if (running.length <= 1) {
    const servingCwd = cwdForPort(connectedPort);
    return { servingCwd, timings_ms: { probe: tProbe - t0, cwd: performance.now() - tProbe } };
  }

  const candidates: MetroCandidate[] = [];
  let servingCwd: string | null = null;
  for (const p of running) {
    let attached = false;
    try {
      attached = filterValidTargets(await fetchTargets(p, DISCOVERY_TIMEOUT_MS)).length > 0;
    } catch {
      /* treat as detached */
    }
    const cwd = cwdForPort(p);
    if (p === connectedPort) servingCwd = cwd;
    candidates.push({
      port: p,
      attached,
      cwd,
      isConnected: p === connectedPort,
      matchesProjectRoot: pathMatchesRoot(cwd, projectRoot),
    });
  }
  if (servingCwd === null) servingCwd = cwdForPort(connectedPort);
  return {
    candidates,
    servingCwd,
    timings_ms: { probe: tProbe - t0, cwd: performance.now() - tProbe },
  };
}
