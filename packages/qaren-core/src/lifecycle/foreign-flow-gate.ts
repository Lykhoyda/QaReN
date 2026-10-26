import { detectIosExternalRunner } from '../runners/external-runner-detect.js';
import type { IosExternalRunnerWarning } from '../runners/external-runner-detect.js';

export interface ForeignCheckResult {
  active: boolean;
  warning: IosExternalRunnerWarning | null;
  fromCache: boolean;
  scanMs: number;
}

interface ForeignFlowGateDeps {
  detect?: (udid: string) => Promise<IosExternalRunnerWarning | null>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * GH#186 / #202 Phase 6: TTL-cached wrapper over detectIosExternalRunner so
 * the per-call arbiter check costs one `ps` scan per window, not per tool
 * call. Fail-open by contract: a detector error reads as "no foreign flow" —
 * the gate must never block a session on infra trouble. `lastActive` is a
 * sync mirror for handlers that route by it (device_screenshot's simctl
 * fallback), same pattern as arbiter.flowActive.
 */
export class ForeignFlowGate {
  private readonly detect: (udid: string) => Promise<IosExternalRunnerWarning | null>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private cachedAt = -Infinity;
  private cachedUdid: string | null = null;
  private cached: IosExternalRunnerWarning | null = null;
  private inFlight: Promise<ForeignCheckResult> | null = null;
  private inFlightUdid: string | null = null;
  private _lastActive = false;

  constructor(deps: ForeignFlowGateDeps = {}) {
    this.detect = deps.detect ?? ((udid) => detectIosExternalRunner(undefined, udid));
    this.ttlMs = deps.ttlMs ?? 5_000;
    this.now = deps.now ?? Date.now;
  }

  get lastActive(): boolean {
    return this._lastActive;
  }

  async check(udid: string): Promise<ForeignCheckResult> {
    const t = this.now();
    if (this.cachedUdid === udid && t - this.cachedAt < this.ttlMs) {
      return { active: this.cached !== null, warning: this.cached, fromCache: true, scanMs: 0 };
    }
    if (this.inFlight && this.inFlightUdid === udid) return this.inFlight;
    this.inFlightUdid = udid;
    const scan = (async (): Promise<ForeignCheckResult> => {
      const started = this.now();
      let warning: IosExternalRunnerWarning | null = null;
      try {
        warning = await this.detect(udid);
      } catch {
        warning = null;
      }
      this.cached = warning;
      this.cachedUdid = udid;
      this.cachedAt = this.now();
      this._lastActive = warning !== null;
      return { active: warning !== null, warning, fromCache: false, scanMs: this.now() - started };
    })();
    this.inFlight = scan;
    try {
      return await scan;
    } finally {
      if (this.inFlight === scan) {
        this.inFlight = null;
        this.inFlightUdid = null;
      }
    }
  }
}

export const foreignFlowGate = new ForeignFlowGate();

/** udid provider, registered from index.ts — a direct getActiveSession import
 * here would create a device-session ↔ arbiter module cycle. Returns the
 * active iOS session's udid, or null when there is no iOS session (the gate
 * is iOS-only; unscoped detection false-positives on idle maestro-mcp). */
let udidProvider: () => string | null = () => null;

export function setForeignGateUdidProvider(fn: () => string | null): void {
  udidProvider = fn;
}

export function foreignGateUdid(): string | null {
  return udidProvider();
}

export function foreignGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RN_IOS_FOREIGN_GUARD !== '0';
}
