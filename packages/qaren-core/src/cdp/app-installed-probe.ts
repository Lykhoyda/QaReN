import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** GH #262: a reinstallable .app snapshot (from the GH #201 bounded dir). */
export interface SnapshotHint {
  path: string;
  ageMinutes: number;
}

type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const DEVICE_ERROR = /Invalid device|No devices/i;

// Allowlist: `false` requires the documented app-missing signal — verified
// live as "(domain=NSPOSIXErrorDomain, code=2)". Case-insensitive and
// distance-independent (Xcode formatting may drift), but `2\b` after an
// optional '='/':'/space separator so `code=-2` / `code=20` never match.
function isAppMissingSignal(stderr: string): boolean {
  return /nsposixerrordomain/i.test(stderr) && /\bcode\s*[=:]?\s*2\b/i.test(stderr);
}

/**
 * GH #262: ground-truth "is this bundle installed?" probe.
 * true = container resolves; false = confirmed missing; null = unknown
 * (device error / unrecognized failure / no stderr / timeout) — callers must
 * treat null exactly like "installed" (fail open).
 *
 * Classifies ONLY simctl's own stderr — never Error.message, which embeds the
 * command argv: a crafted bundleId containing the marker text must not be
 * able to force a false "not installed".
 */
export async function probeAppInstalled(
  udid: string,
  appId: string,
  exec: Exec = execFile as unknown as Exec,
): Promise<boolean | null> {
  try {
    await exec('xcrun', ['simctl', 'get_app_container', udid, appId, 'app'], { timeout: 5000 });
    return true;
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    if (!stderr) return null;
    if (DEVICE_ERROR.test(stderr)) return null;
    if (isAppMissingSignal(stderr)) return false;
    return null;
  }
}

/**
 * POSIX single-quote (same pattern as device-deeplink.ts / device-interact.ts).
 * The advice built below is designed to be copy-pasted into a shell, and .app
 * names can contain spaces/metacharacters.
 */
export function posixSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildNotInstalledAdvice(
  udid: string,
  appId: string,
  hint: SnapshotHint | null,
): string {
  const base =
    `App ${appId} is not installed on simulator ${udid} — rebuild and install ` +
    '(npx expo run:ios / pnpm ios).';
  if (!hint) return base;
  return (
    `${base} Or reinstall the snapshot taken at the last clearState, ` +
    `${hint.ageMinutes} min ago (may be stale): ` +
    `xcrun simctl install ${posixSingleQuote(udid)} ${posixSingleQuote(hint.path)}`
  );
}
