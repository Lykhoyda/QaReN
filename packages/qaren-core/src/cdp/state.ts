import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPClientState, HermesTarget } from '../types.js';

const CDP_ACTIVE_FLAG = join(tmpdir(), 'qaren-cdp-active');
const CDP_SESSION_FILE = join(tmpdir(), 'qaren-cdp-session.json');

export interface ResettableState {
  setState(v: CDPClientState): void;
  setHelpersInjected(v: boolean): void;
  setBridgeDetected(v: boolean): void;
  setBridgeVersion(v: number | null): void;
  setConnectedTarget(v: HermesTarget | null): void;
  setConnectedAt(v: number | null): void;
  setLogDomainEnabled(v: boolean): void;
  setProfilerAvailable(v: boolean): void;
  setHeapProfilerAvailable(v: boolean): void;
  clearScripts(): void;
}

export function resetState(s: ResettableState): void {
  s.setState('disconnected');
  s.setHelpersInjected(false);
  s.setBridgeDetected(false);
  s.setBridgeVersion(null);
  s.setConnectedTarget(null);
  s.setConnectedAt(null);
  s.setLogDomainEnabled(false);
  s.setProfilerAvailable(false);
  s.setHeapProfilerAvailable(false);
  s.clearScripts();
}

export function setActiveFlag(port: number, target: HermesTarget | null): void {
  try {
    writeFileSync(CDP_ACTIVE_FLAG, String(process.pid));
  } catch {
    /* best-effort */
  }
  try {
    writeFileSync(
      CDP_SESSION_FILE,
      JSON.stringify({
        port,
        platform: target?.platform ?? null,
        target: target?.title ?? null,
        pid: process.pid,
        connectedAt: new Date().toISOString(),
      }),
    );
  } catch {
    /* best-effort */
  }
}

export function clearActiveFlag(): void {
  try {
    unlinkSync(CDP_ACTIVE_FLAG);
  } catch {
    /* may not exist */
  }
  try {
    unlinkSync(CDP_SESSION_FILE);
  } catch {
    /* may not exist */
  }
}

export { sleep } from '../domain/cancellation.js';
