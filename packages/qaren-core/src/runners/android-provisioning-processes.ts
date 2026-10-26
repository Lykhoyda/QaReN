import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { probeProcessBirth } from '../lifecycle/process-birth.js';
import type { ProcessBirth } from '../lifecycle/process-birth.js';

export interface AndroidProvisioningProcess {
  pid: number;
  pgid: number;
  state: string;
}

// The CLI gives its core a dedicated process group. Gradle and adb inherit it;
// provisioning disables persistent build daemons so writers cannot outlive it.
export function readAndroidProvisioningProcesses(): AndroidProvisioningProcess[] | undefined {
  try {
    if (process.platform === 'linux') {
      const processes: AndroidProvisioningProcess[] = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try {
          stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return undefined;
        }
        const end = stat.lastIndexOf(')');
        if (end < 0) return undefined;
        const fields = stat
          .slice(end + 1)
          .trim()
          .split(/\s+/);
        const pgid = Number(fields[2]);
        if (!Number.isSafeInteger(pgid) || pgid < 0 || !fields[0]) return undefined;
        processes.push({ pid: Number(name), pgid, state: fields[0] });
      }
      return processes;
    }
    if (process.platform === 'darwin') {
      const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,state='], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return output
        .trim()
        .split('\n')
        .map((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
          if (!match) throw new Error('unreadable process group');
          return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3] };
        });
    }
  } catch {}
  return undefined;
}

export function androidProvisioningProcessGroup(pid: number): number | undefined {
  try {
    const raw =
      process.platform === 'linux'
        ? readFileSync(`/proc/${pid}/stat`, 'utf8')
        : execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
            encoding: 'utf8',
            timeout: 2_000,
          });
    const value =
      process.platform === 'linux'
        ? raw
            .slice(raw.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/)[2]
        : raw.trim();
    const pgid = Number(value);
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

export function androidProvisioningGroupPresence(pgid: number): 'live' | 'absent' | 'unknown' {
  const processes = readAndroidProvisioningProcesses();
  if (!processes) return 'unknown';
  return processes.some((entry) => entry.pgid === pgid && !entry.state.startsWith('Z'))
    ? 'live'
    : 'absent';
}

export async function stopAndroidProvisioningChildren(
  owner: ProcessBirth,
  pgid: number,
): Promise<boolean> {
  // Never signal peers in an inherited/shared group. The production core is
  // its group leader; an unscoped library caller must recover explicitly.
  if (owner.pid !== process.pid || pgid !== owner.pid) return false;
  const deadline = performance.now() + 30_000; // existing Android rebuild cleanup bound
  for (;;) {
    const birth = probeProcessBirth(owner.pid);
    if (birth.status !== 'present' || birth.birth.token !== owner.token) return false;
    const processes = readAndroidProvisioningProcesses();
    if (!processes || !processes.some((entry) => entry.pid === owner.pid && entry.pgid === pgid))
      return false;
    const children = processes.filter(
      (entry) => entry.pgid === pgid && entry.pid !== owner.pid && !entry.state.startsWith('Z'),
    );
    if (!children.length) return true;
    for (const child of children) {
      // A pid can be reused between inventory and signaling. Bind both birth
      // and current group membership before stopping an owned writer.
      const before = probeProcessBirth(child.pid);
      if (before.status === 'absent') continue;
      if (before.status !== 'present') return false;
      const current = readAndroidProvisioningProcesses()?.find((entry) => entry.pid === child.pid);
      const after = probeProcessBirth(child.pid);
      if (after.status === 'absent') continue;
      if (
        !current ||
        current.pgid !== pgid ||
        after.status !== 'present' ||
        after.birth.token !== before.birth.token
      )
        return false;
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
    }
    if (performance.now() >= deadline) return false;
    // Cleanup must finish even after the caller's cancellation scope aborts.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
