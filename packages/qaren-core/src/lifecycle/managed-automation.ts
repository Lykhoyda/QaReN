import { spawn } from '../domain/cancellation.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';

const OUTPUT_LIMIT = 10 * 1024 * 1024;
const TERM_GRACE_MS = 500;
const ABSENCE_CONFIRM_MS = 2_000;
const POLL_MS = 25;

export interface AutomationCleanupRefusal {
  processGroup: 'owned-process-group';
  manualCommand: string;
}

export interface ManagedProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cleanupProven: boolean;
  cleanupEscalated: boolean;
  cleanupRefusal?: AutomationCleanupRefusal;
  error?: string;
}

interface ChildTerminalResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

interface SpawnManagedOptions {
  beforeSpawn?: () => void;
  timeoutMs: number;
  platform: 'ios' | 'android';
  deviceId?: string;
  tool: string;
  env?: NodeJS.ProcessEnv;
}

interface ManagedProcessDependencies {
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  signalGroup?: (pgid: number, signal: NodeJS.Signals | 0) => void;
  groupLiveness?: (pgid: number) => 'live' | 'no-live-members' | 'unknown';
}

interface ActiveCleanupRefusal {
  pgid: number;
  public: AutomationCleanupRefusal;
}

const activeCleanupRefusals = new Map<string, ActiveCleanupRefusal>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupKey(platform: 'ios' | 'android', deviceId: string): string {
  return `${platform}:${deviceId}`;
}

function cleanupRefusal(pgid: number): AutomationCleanupRefusal {
  return {
    processGroup: 'owned-process-group',
    manualCommand: `kill -TERM -${pgid}`,
  };
}

function processGroupLiveness(pgid: number): 'live' | 'no-live-members' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown';
  try {
    for (const entry of readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return 'unknown';
      }
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return 'unknown';
      const fields = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/);
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') return 'live';
    }
    return 'no-live-members';
  } catch {
    return 'unknown';
  }
}

function groupPresence(
  pgid: number,
  signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => void,
  groupLiveness: (pgid: number) => 'live' | 'no-live-members' | 'unknown',
): 'present' | 'absent' | 'unknown' {
  try {
    signalGroup(pgid, 0);
    return groupLiveness(pgid) === 'no-live-members' ? 'absent' : 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
  }
}

async function waitForGroupAbsence(
  pgid: number,
  signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => void,
  groupLiveness: (pgid: number) => 'live' | 'no-live-members' | 'unknown',
  delay: (ms: number) => Promise<void>,
  timeoutMs = ABSENCE_CONFIRM_MS,
): Promise<'absent' | 'present' | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const presence = groupPresence(pgid, signalGroup, groupLiveness);
    if (presence !== 'present') return presence;
    if (Date.now() >= deadline) return 'present';
    await delay(POLL_MS);
  }
}

function observeChildTerminal(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): {
  result: Promise<ChildTerminalResult>;
  observedClose: () => ChildTerminalResult | null;
} {
  let closeResult: ChildTerminalResult | null = null;
  const result = new Promise<ChildTerminalResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (value: ChildTerminalResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    child.once('error', (error) =>
      done({ code: null, signal: null, timedOut: false, error: error.message }),
    );
    child.once('close', (code, signal) => {
      closeResult = { code, signal, timedOut: false };
      done(closeResult);
    });
    timer = setTimeout(() => done({ code: null, signal: null, timedOut: true }), timeoutMs);
  });
  return { result, observedClose: () => closeResult };
}

function activeRefusal(
  platform: 'ios' | 'android',
  deviceId: string | undefined,
  signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => void,
  groupLiveness: (pgid: number) => 'live' | 'no-live-members' | 'unknown',
): AutomationCleanupRefusal | null {
  if (!deviceId) return null;
  const key = cleanupKey(platform, deviceId);
  const refusal = activeCleanupRefusals.get(key);
  if (!refusal) return null;
  if (groupPresence(refusal.pgid, signalGroup, groupLiveness) === 'absent') {
    activeCleanupRefusals.delete(key);
    return null;
  }
  return refusal.public;
}

export async function spawnManagedProcessGroup(
  bin: string,
  args: string[],
  options: SpawnManagedOptions,
  dependencies: ManagedProcessDependencies = {},
): Promise<ManagedProcessResult> {
  const spawnProcess = dependencies.spawn ?? spawn;
  const delay = dependencies.sleep ?? sleep;
  const signalGroup =
    dependencies.signalGroup ??
    ((pgid: number, signal: NodeJS.Signals | 0) => {
      if (process.platform === 'win32') process.kill(pgid, signal);
      else process.kill(-pgid, signal);
    });
  const groupLiveness = dependencies.groupLiveness ?? processGroupLiveness;
  const refusal = activeRefusal(options.platform, options.deviceId, signalGroup, groupLiveness);
  if (refusal) {
    return {
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      cleanupProven: false,
      cleanupEscalated: false,
      cleanupRefusal: refusal,
      error: 'AUTOMATION_CLEANUP_UNPROVEN: a prior owned process group remains unproven',
    };
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    options.beforeSpawn?.();
    child = spawnProcess(bin, args, {
      detached: process.platform !== 'win32',
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
  } catch (error) {
    return {
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      cleanupProven: true,
      cleanupEscalated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const terminalObserver = observeChildTerminal(child, options.timeoutMs);
  const pid = child.pid;
  if (!pid) {
    const terminal = await terminalObserver.result;
    return {
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      cleanupProven: true,
      cleanupEscalated: false,
      error: terminal.error ?? 'Managed automation process did not expose a PID',
    };
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let overflow = false;
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (outputBytes >= OUTPUT_LIMIT) {
      overflow = true;
      return;
    }
    const remaining = OUTPUT_LIMIT - outputBytes;
    target.push(chunk.subarray(0, remaining));
    outputBytes += Math.min(chunk.length, remaining);
    if (chunk.length > remaining) overflow = true;
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));

  const terminal = await terminalObserver.result;
  let cleanupEscalated = false;
  let presence = await waitForGroupAbsence(
    pid,
    signalGroup,
    groupLiveness,
    delay,
    terminal.timedOut ? 0 : 250,
  );
  if (terminal.timedOut || overflow || presence === 'present') {
    try {
      signalGroup(pid, 'SIGTERM');
    } catch {}
    presence = await waitForGroupAbsence(pid, signalGroup, groupLiveness, delay, TERM_GRACE_MS);
    if (presence === 'present') {
      cleanupEscalated = true;
      try {
        signalGroup(pid, 'SIGKILL');
      } catch {}
      presence = await waitForGroupAbsence(pid, signalGroup, groupLiveness, delay);
    }
  }

  const cleanupProven = presence === 'absent';
  const unproven = cleanupProven ? undefined : cleanupRefusal(pid);
  if (unproven && options.deviceId) {
    activeCleanupRefusals.set(cleanupKey(options.platform, options.deviceId), {
      pgid: pid,
      public: unproven,
    });
  }

  const observedTerminal = terminal.timedOut
    ? (terminalObserver.observedClose() ?? terminal)
    : terminal;
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    code: observedTerminal.code,
    signal: observedTerminal.signal,
    timedOut: terminal.timedOut,
    cleanupProven,
    cleanupEscalated,
    ...(unproven ? { cleanupRefusal: unproven } : {}),
    ...(overflow
      ? { error: 'Maestro output exceeded 10 MiB' }
      : terminal.error
        ? { error: terminal.error }
        : {}),
  };
}

export function removeTemporaryInlineFlow(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
