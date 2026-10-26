import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// GH #383: one hardened implementation for every bridge state file (session
// file, runner state, future state) — CDP-015 guarantees: symlink-refusing
// reads, atomic tmp+rename writes with 0600, per-user app-support location.

export function getStateDir(): string {
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, 'qaren');
  }
  return join(homedir(), '.qaren', 'state');
}

export function runnerStatePath(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._:-]/g, '_');
  return join(getStateDir(), 'runner-state', `${safe}.json`);
}

export function readJsonStateFile<T>(path: string): T | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonStateFileAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, path);
}

export function deleteStateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

// GH #383: the pre-relocation fixed shared paths. Read ONCE (leniently) so a
// live pre-upgrade runner can be discovered → classified legacy → reaped;
// deleted only after a successful relaunch persists the new per-device file.
const LEGACY_TMP_STATE_FILES: Record<'ios' | 'android', string> = {
  ios: '/tmp/rn-fast-runner-state.json',
  android: '/tmp/rn-android-runner-state.json',
};

export function readLegacyTmpState<T>(kind: 'ios' | 'android'): T | null {
  return readJsonStateFile<T>(LEGACY_TMP_STATE_FILES[kind]);
}

export function cleanupLegacyTmpState(): void {
  for (const p of Object.values(LEGACY_TMP_STATE_FILES)) deleteStateFile(p);
}
