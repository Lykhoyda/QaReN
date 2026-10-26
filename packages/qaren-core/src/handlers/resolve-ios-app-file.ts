import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import yaml from 'yaml';
import type { SnapshotHint } from '../cdp/app-installed-probe.js';
import { containsClearState } from '../domain/maestro-validator.js';

/**
 * GH#201: true when the flow clears app state and so needs `--app-file` to
 * reinstall on maestro-runner. Every caller passes validator-canonical YAML, so
 * this decides on the parsed command structure via the shared predicate rather
 * than on the flow text — the `- clearState: <appId>` argument form counts, and
 * `clearState: false` or a selector value spelled `clearState` does not.
 */
export function flowUsesClearState(flowText: string): boolean {
  return yaml.parseAllDocuments(flowText).some((doc) => {
    if (doc.errors.length > 0) throw doc.errors[0];
    return containsClearState(doc.toJS());
  });
}

export interface ResolveAppFileDeps {
  /** GH #705: exact simulator UDID to read the container from; `booted` otherwise. */
  deviceId?: string;
  /** Returns the installed `.app` container path for a bundle id, or null. */
  getAppContainer?: (bundleId: string, deviceId?: string) => string | null;
  /** Returns the newest built `.app` under DerivedData, or null. */
  newestDerivedDataApp?: () => string | null;
  /** Existence check (injectable for tests). */
  exists?: (path: string) => boolean;
  /** Copies an installed .app OUT of the device container; returns the copy's path or null. */
  snapshotApp?: (appPath: string) => string | null;
}

/** GH#186 live-gate finding: clearState UNINSTALLS the app, deleting the very
 * container `--app-file` pointed into — the reinstall then read a deleted
 * path. Snapshot the bundle outside the container (APFS clonefile via cp -c
 * fallback to plain copy) so it survives the uninstall. */
function defaultSnapshotApp(appPath: string): string | null {
  try {
    // Fixed per-app destination, replaced each resolve — an mkdtemp per
    // clearState flow would accumulate full .app copies in $TMPDIR until OS
    // reaping (PR #276 review). Concurrent same-app flows can't race: the
    // arbiter makes the flow plane exclusive.
    const destDir = join(tmpdir(), 'rn-appfile-snapshots');
    const dest = join(destDir, basename(appPath));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    try {
      execFileSync('cp', ['-Rc', appPath, dest], { timeout: 30_000, stdio: 'ignore' });
    } catch {
      cpSync(appPath, dest, { recursive: true });
    }
    return dest;
  } catch {
    return null;
  }
}

/**
 * GH#201: locate a built `.app` to pass to `maestro-runner --app-file` so an
 * iOS `clearState` flow can reinstall after uninstall. The installed container
 * is the most current source, but its path dies with the uninstall — so it is
 * snapshotted out first. Falls back to the newest DerivedData product.
 */
export function resolveIosAppFile(bundleId: string, deps: ResolveAppFileDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  const getAppContainer = deps.getAppContainer ?? defaultGetAppContainer;
  const snapshotApp = deps.snapshotApp ?? defaultSnapshotApp;
  const fromContainer = getAppContainer(bundleId, deps.deviceId);
  if (fromContainer && exists(fromContainer)) {
    const snapshot = snapshotApp(fromContainer);
    if (snapshot) return snapshot;
  }
  const fromDerived = (deps.newestDerivedDataApp ?? (() => null))();
  if (fromDerived && exists(fromDerived)) return fromDerived;
  return null;
}

export type AppFileResolution = { ok: true; appFile?: string } | { ok: false; error: string };

/**
 * GH#201: decide the `--app-file` value for a single flow. Returns the explicit
 * override untouched; otherwise only an iOS `clearState` flow needs one (so it
 * can reinstall after uninstall). Shared by maestro_run, maestro_test_all, and
 * runMaestroInline so all three reinstall on clearState — previously only
 * maestro_run resolved the app file, leaving the other two to hit the exact
 * uninstall-without-reinstall failure #201 fixed.
 */
export function resolveAppFileForClearState(
  platform: 'ios' | 'android',
  flowText: string,
  headerAppId: string | undefined,
  explicitAppFile?: string,
  deps?: ResolveAppFileDeps,
): AppFileResolution {
  if (explicitAppFile) return { ok: true, appFile: explicitAppFile };
  if (platform !== 'ios' || !flowUsesClearState(flowText)) return { ok: true };
  if (!headerAppId) {
    return {
      ok: false,
      error:
        'Flow uses clearState on iOS but no appId is known to locate the .app. ' +
        'Add `appId:` to the flow header or pass appFile=<path-to-.app>.',
    };
  }
  const appFile = resolveIosAppFile(headerAppId, deps) ?? undefined;
  if (!appFile) {
    return {
      ok: false,
      error:
        `Flow uses clearState on iOS but no built .app could be located for ${headerAppId}. ` +
        'Pass appFile=<path-to-.app> (e.g. <DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app).',
    };
  }
  return { ok: true, appFile };
}

function defaultGetAppContainer(bundleId: string, deviceId?: string): string | null {
  try {
    const target = deviceId && !/\s/.test(deviceId) ? deviceId : 'booted';
    const out = execFileSync('xcrun', ['simctl', 'get_app_container', target, bundleId, 'app'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** GH #262: injectable deps for the snapshot-hint lookup. */
export interface FindSnapshotDeps {
  /** Absolute paths of candidate .app dirs in the snapshot dir. */
  listSnapshots?: () => string[];
  /** CFBundleIdentifier of a candidate (within timeoutMs), or null if unreadable. */
  readBundleId?: (appPath: string, timeoutMs: number) => string | null;
  /** mtime (ms) of a candidate, or null. */
  mtimeMs?: (appPath: string) => number | null;
  now?: () => number;
}

// Insurance caps: the lookup rides on an already-failed recovery path and
// must stay bounded — per-read timeouts are clamped to the remaining
// deadline so one slow plutil cannot blow the total budget.
const SNAPSHOT_SCAN_CAP = 10;
const SNAPSHOT_SCAN_BUDGET_MS = 3000;
const PLUTIL_TIMEOUT_MS = 2000;

function defaultListSnapshots(): string[] {
  const dir = join(tmpdir(), 'rn-appfile-snapshots');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function defaultReadBundleId(appPath: string, timeoutMs: number): string | null {
  try {
    const out = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Info.plist')],
      { timeout: timeoutMs, encoding: 'utf8' },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

function defaultMtimeMs(appPath: string): number | null {
  try {
    return statSync(appPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * GH #262: find a reinstallable .app snapshot for a bundle id in the GH #201
 * snapshot dir. Stat pass → newest-first sort → cap (readdir order is
 * arbitrary; capping first could drop the newest match), so plutil only runs
 * on the newest candidates and the first match is the newest. Bounded and
 * best-effort: any error or budget overrun returns null — the hint never
 * fails the report it rides on.
 */
export function findSnapshotForBundleId(
  bundleId: string,
  deps: FindSnapshotDeps = {},
): { path: string; mtimeMs: number } | null {
  const listSnapshots = deps.listSnapshots ?? defaultListSnapshots;
  const readBundleId = deps.readBundleId ?? defaultReadBundleId;
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
  const now = deps.now ?? Date.now;
  try {
    const deadline = now() + SNAPSHOT_SCAN_BUDGET_MS;
    const candidates = listSnapshots()
      .map((path) => ({ path, m: mtimeMs(path) }))
      .filter((c): c is { path: string; m: number } => c.m !== null)
      .sort((a, b) => b.m - a.m)
      .slice(0, SNAPSHOT_SCAN_CAP);
    for (const { path, m } of candidates) {
      const remaining = deadline - now();
      if (remaining <= 0) return null;
      if (readBundleId(path, Math.min(PLUTIL_TIMEOUT_MS, remaining)) === bundleId) {
        return { path, mtimeMs: m };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** GH #262: `findSnapshotForBundleId` formatted as advice input. */
export function snapshotHintForBundleId(
  bundleId: string,
  deps: FindSnapshotDeps = {},
): SnapshotHint | null {
  try {
    const now = deps.now ?? Date.now;
    const snap = findSnapshotForBundleId(bundleId, deps);
    if (!snap) return null;
    return {
      path: snap.path,
      ageMinutes: Math.max(0, Math.round((now() - snap.mtimeMs) / 60_000)),
    };
  } catch {
    return null;
  }
}
