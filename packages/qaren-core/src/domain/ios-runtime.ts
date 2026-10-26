import { execFile as execFileCb } from './cancellation.js';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const runtimeCache = new Map<string, number | null>();

export function parseIosRuntimeMajorForUdid(simctlJson: unknown, udid: string): number | null {
  if (!simctlJson || typeof simctlJson !== 'object') return null;
  const devices = (simctlJson as { devices?: unknown }).devices;
  if (!devices || typeof devices !== 'object') return null;
  for (const [runtimeKey, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    if (!list.some((device) => device?.udid === udid)) continue;
    const match = runtimeKey.match(/SimRuntime\.iOS-(\d+)/);
    return match ? Number(match[1]) : null;
  }
  return null;
}

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export async function getIosRuntimeMajorForUdid(
  udid: string,
  execFn: ExecFn = (cmd, args) => execFile(cmd, args, { timeout: 5000, encoding: 'utf8' }),
): Promise<number | null> {
  if (runtimeCache.has(udid)) return runtimeCache.get(udid) ?? null;
  try {
    const { stdout } = await execFn('xcrun', ['simctl', 'list', 'devices', '--json']);
    const major = parseIosRuntimeMajorForUdid(JSON.parse(stdout), udid);
    runtimeCache.set(udid, major);
    return major;
  } catch {
    return null;
  }
}

export function _resetIosRuntimeCacheForTest(): void {
  runtimeCache.clear();
}
