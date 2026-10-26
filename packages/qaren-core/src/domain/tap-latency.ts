// src/domain/tap-latency.ts
// GH #263: detect a wedged simulator test-runtime from maestro-runner output.
// Pure, no I/O. Fail-open: unparseable output yields no samples → no hint.

import { parseSteps } from './maestro-step-parser.js';
import type { TrailingVerificationQualifier } from './maestro-run-ledger.js';

export const DEFAULT_FLOOR_MS = 1500;

/**
 * Latencies (ms) of SUCCESSFUL tapOn steps. Derived from parseSteps (GH #211):
 * a ✗ tap's duration is the step TIMEOUT (~12.7s) and would false-positive an
 * ordinary element-not-found failure, so only pass tapOn steps count.
 */
export function parseTapLatencies(output: string): number[] {
  return parseSteps(output)
    .filter((s) => s.verb === 'tapOn' && s.status === 'pass')
    .map((s) => s.durationMs);
}

export function median(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

export function resolveFloorMs(envVal?: string): number {
  if (envVal === undefined) return DEFAULT_FLOOR_MS;
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_MS;
}

export interface RuntimeDegradation {
  degraded: boolean;
  medianMs: number | null;
  floorMs: number;
  sampleCount: number;
}

export interface RuntimeDegradationMetadata {
  medianTapMs: number;
  floorMs: number;
  sampleCount: number;
}

export function runtimeDegradationFromMetadata(candidate: unknown): RuntimeDegradation | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const metadata = candidate as Partial<RuntimeDegradationMetadata>;
  if (
    typeof metadata.medianTapMs !== 'number' ||
    !Number.isFinite(metadata.medianTapMs) ||
    typeof metadata.floorMs !== 'number' ||
    !Number.isFinite(metadata.floorMs) ||
    typeof metadata.sampleCount !== 'number' ||
    !Number.isSafeInteger(metadata.sampleCount) ||
    metadata.medianTapMs < 0 ||
    metadata.floorMs <= 0 ||
    metadata.sampleCount < 0
  ) {
    return null;
  }
  return {
    degraded: true,
    medianMs: metadata.medianTapMs,
    floorMs: metadata.floorMs,
    sampleCount: metadata.sampleCount,
  };
}

export function runtimeDegradationMetadata(
  degradation: RuntimeDegradation,
): RuntimeDegradationMetadata {
  return {
    medianTapMs: degradation.medianMs!,
    floorMs: degradation.floorMs,
    sampleCount: degradation.sampleCount,
  };
}

// Require at least this many successful-tap samples before attributing slowness
// to a wedge. A single slow tap (e.g. a cold-start navigation tap) is normal
// variance — flagging it would mis-hint "reboot" on an ordinary element-not-found
// failure, the exact misdirection this feature fights (review finding #1).
const MIN_SAMPLES_FOR_DEGRADED = 2;

export function classifyRuntimeDegradation(output: string, floorMs: number): RuntimeDegradation {
  const samples = parseTapLatencies(output);
  const medianMs = median(samples);
  return {
    degraded: medianMs != null && samples.length >= MIN_SAMPLES_FOR_DEGRADED && medianMs >= floorMs,
    medianMs,
    floorMs,
    sampleCount: samples.length,
  };
}

export function formatRuntimeDegradedHint(d: RuntimeDegradation): string {
  return (
    `RUNTIME_DEGRADED: median tapOn latency ${d.medianMs}ms (>= ${d.floorMs}ms) — ` +
    `the simulator test runtime is likely wedged; reboot it ` +
    `(xcrun simctl shutdown <udid> && xcrun simctl boot <udid>), relaunch the app, and retry.`
  );
}

// GH #623 (ledger amendment): the latency DETECTOR is unchanged; only the
// destructive advice is gated. On a ledger-proven trailing-verification-only
// failure the runner demonstrably terminated on its own, so the reboot command
// is withheld in favor of the approved verify-first caveat.
export function formatRuntimeSlowCaveat(d: RuntimeDegradation): string {
  return (
    `RUNTIME_DEGRADED: median tapOn latency ${d.medianMs}ms (>= ${d.floorMs}ms) — ` +
    `runtime is slow; the goal state may have appeared after the wait — verify before rebooting.`
  );
}

/**
 * Integration helper: given the runner output and an already-built failure
 * (message + meta), append the RUNTIME_DEGRADED hint + meta.runtimeDegraded
 * IFF degraded. Returns the base unchanged otherwise. Call ONLY on a failure
 * path — never on a passing flow (a passing-but-slow run must not be hinted).
 * The advice clause is selected by the ledger classifier's own product: a
 * present TrailingVerificationQualifier (GH #623) swaps in the approved
 * verify-first caveat; genuine wedges keep the reboot wording verbatim.
 */
export function augmentFailureWithDegradation(
  output: string,
  floorMs: number,
  baseMessage: string,
  baseMeta: Record<string, unknown>,
  opts: { trailingVerification?: TrailingVerificationQualifier | null } = {},
): { message: string; meta: Record<string, unknown> } {
  const d = classifyRuntimeDegradation(output, floorMs);
  if (!d.degraded) return { message: baseMessage, meta: baseMeta };
  const hint = opts.trailingVerification?.trailingVerificationOnly
    ? formatRuntimeSlowCaveat(d)
    : formatRuntimeDegradedHint(d);
  return {
    message: `${baseMessage} — ${hint}`,
    meta: {
      ...baseMeta,
      runtimeDegraded: runtimeDegradationMetadata(d),
    },
  };
}
