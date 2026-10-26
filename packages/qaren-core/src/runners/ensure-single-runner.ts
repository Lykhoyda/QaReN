import { readProcessBirth } from '../lifecycle/process-birth.js';
import {
  isAbort,
  cancellationSignal,
  interruptible,
  sleep as cancellableSleep,
} from '../domain/cancellation.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSimctlListapps } from '../cdp/discovery.js';

const DAEMON_JSON = join(homedir(), '.agent-device', 'daemon.json');
const DAEMON_LOCK = join(homedir(), '.agent-device', 'daemon.lock');
const DAEMON_FILES = [DAEMON_JSON, DAEMON_LOCK];
const SIGKILL_GRACE_MS = 500;

// GH#202 Phase 4: the legacy upstream runner ships as two installed apps.
export const LEGACY_BUNDLE_IDS = [
  'com.callstack.agentdevice.runner',
  'com.callstack.agentdevice.runner.uitests.xctrunner',
] as const;

export function selectInstalledLegacyApps(installed: Set<string>): string[] {
  return LEGACY_BUNDLE_IDS.filter((id) => installed.has(id));
}

export interface EradicateLegacyAppsResult {
  removedApps: string[];
  warnings: string[];
}

// GH#202 Phase 4: error-safe by contract — every failure becomes a warning;
// a device-open is never blocked on eradication. Runs on EVERY device-open
// (no memo): the scan is one simctl listapps (~tens of ms), and a memo would
// go stale whenever another bridge/agent-device session reinstalls the legacy
// app on the same UDID — the device lock's degraded fail-open path cannot
// rule that out. async only for call-site uniformity with ensureSingleRunner
// (body is sync execFileSync).
export async function eradicateLegacyRunnerApps(
  udid: string,
  deps: Pick<EnsureSingleRunnerDeps, 'listApps' | 'uninstallApp'>,
): Promise<EradicateLegacyAppsResult> {
  const removedApps: string[] = [];
  const warnings: string[] = [];
  let installed: Set<string>;
  try {
    cancellationSignal();
    installed = parseSimctlListapps(deps.listApps(udid));
  } catch (err) {
    if (isAbort(err)) throw err;
    return { removedApps, warnings: [`listapps failed: ${msg(err)}`] };
  }
  // A booted simulator always carries built-in system apps; zero parsed ids
  // means the listapps format changed (parse failure), not a clean device.
  if (installed.size === 0) {
    return {
      removedApps,
      warnings: [`listapps parsed 0 apps — treating as parse failure, not a clean device`],
    };
  }
  for (const id of selectInstalledLegacyApps(installed)) {
    try {
      cancellationSignal();
      deps.uninstallApp(udid, id);
      removedApps.push(id);
    } catch (err) {
      if (isAbort(err)) throw err;
      warnings.push(
        `uninstall ${id} failed: ${msg(err)} — remove manually: xcrun simctl uninstall ${udid} ${id}`,
      );
    }
  }
  return { removedApps, warnings };
}

export function selectLegacyRunnerPids(psOutput: string, udid: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    if (!line.includes('AgentDeviceRunner')) continue;
    if (line.includes('RnFastRunner')) continue;
    if (!udid || !line.includes(udid)) continue;
    const m = line.trim().match(/^(\d+)\b/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

export function shouldRemoveDaemonFiles(
  daemonPid: number | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (daemonPid === null) return true;
  return !isAlive(daemonPid);
}

export interface EnsureSingleRunnerResult {
  killedPids: number[];
  removedFiles: string[];
  removedApps: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface EnsureSingleRunnerDeps {
  listProcesses: () => string;
  readBirth: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  readDaemonPid: () => number | null;
  fileExists: (path: string) => boolean;
  removeFile: (path: string) => void;
  delay: (ms: number) => Promise<void>;
  listApps: (udid: string) => string;
  uninstallApp: (udid: string, bundleId: string) => void;
}

function defaultDeps(): EnsureSingleRunnerDeps {
  return {
    // Let a `ps` failure (timeout / EAGAIN under load) PROPAGATE to the
    // caller's try/catch, which records a warning. Swallowing it here and
    // returning '' made single-runner enforcement degrade to a silent no-op
    // with no operator signal — exactly when the machine is busy.
    listProcesses: () =>
      execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 3_000 }),
    readBirth: (pid) => readProcessBirth(pid)?.token ?? null,
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (isAbort(error)) throw error;
        return false;
      }
    },
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')) as { pid?: unknown };
        return typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch (error) {
        if (isAbort(error)) throw error;
        return null;
      }
    },
    fileExists: (path) => existsSync(path),
    removeFile: (path) => unlinkSync(path),
    delay: cancellableSleep,
    listApps: (udid) =>
      execFileSync('xcrun', ['simctl', 'listapps', udid], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    uninstallApp: (udid, bundleId) => {
      execFileSync('xcrun', ['simctl', 'uninstall', udid, bundleId], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    },
  };
}

export async function ensureSingleRunner(
  opts: { udid?: string } = {},
  deps: EnsureSingleRunnerDeps = defaultDeps(),
): Promise<EnsureSingleRunnerResult> {
  const timings: Record<string, number> = {};
  const killedPids: number[] = [];
  const removedFiles: string[] = [];
  const removedApps: string[] = [];
  const warnings: string[] = [];

  if (opts.udid) {
    const t = Date.now();
    let psOut = '';
    try {
      cancellationSignal();
      psOut = deps.listProcesses();
    } catch (err) {
      if (isAbort(err)) throw err;
      warnings.push(`ps failed: ${msg(err)}`);
    }
    for (const pid of selectLegacyRunnerPids(psOut, opts.udid)) {
      try {
        const birth = deps.readBirth(pid);
        const signal = (kind: NodeJS.Signals): void => {
          cancellationSignal();
          if (
            !birth ||
            !selectLegacyRunnerPids(deps.listProcesses(), opts.udid!).includes(pid) ||
            deps.readBirth(pid) !== birth
          ) {
            throw new Error(
              'PROCESS_OWNERSHIP_UNPROVEN: legacy runner identity changed or is unavailable',
            );
          }
          cancellationSignal();
          deps.kill(pid, kind);
        };
        signal('SIGTERM');
        await interruptible(() => deps.delay(SIGKILL_GRACE_MS));
        cancellationSignal();
        if (deps.isAlive(pid)) signal('SIGKILL');
        killedPids.push(pid);
      } catch (err) {
        if (isAbort(err)) throw err;
        warnings.push(`kill ${pid} failed: ${msg(err)}`);
      }
    }
    timings.scopedKill = Date.now() - t;

    // Runs on every device-open (no memo — see eradicateLegacyRunnerApps).
    // Stays on the awaited path on purpose: an installed legacy runner must
    // be GONE before the first maestro/WDA flow of the session, or iOS can
    // relaunch it into the foreground mid-flow (#202 comment 2026-06-08).
    const tApps = Date.now();
    const apps = await eradicateLegacyRunnerApps(opts.udid, deps);
    removedApps.push(...apps.removedApps);
    warnings.push(...apps.warnings);
    timings.appEradication = Date.now() - tApps;
  }

  const tFiles = Date.now();
  if (DAEMON_FILES.some((f) => deps.fileExists(f))) {
    let daemonPid: number | null = null;
    try {
      daemonPid = deps.readDaemonPid();
    } catch (error) {
      if (isAbort(error)) throw error;
      daemonPid = null;
    }
    if (shouldRemoveDaemonFiles(daemonPid, deps.isAlive)) {
      for (const f of DAEMON_FILES) {
        if (!deps.fileExists(f)) continue;
        try {
          cancellationSignal();
          deps.removeFile(f);
          removedFiles.push(f);
        } catch (err) {
          if (isAbort(err)) throw err;
          warnings.push(`rm ${f} failed: ${msg(err)}`);
        }
      }
    } else {
      warnings.push(
        `Left ${DAEMON_JSON} in place — daemon PID ${daemonPid} is alive (may belong to another project).`,
      );
    }
  }
  timings.fileCleanup = Date.now() - tFiles;

  return { killedPids, removedFiles, removedApps, warnings, meta: { timings_ms: timings } };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
