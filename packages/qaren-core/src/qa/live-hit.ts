import { QaDispatchError, type QaDispatchContext } from '../domain/qa-dispatch.js';
import type { Element, Screen } from './screen.js';
import type { CentreCoverageDiagnostic } from './resolve.js';

export const HIT_PROBE_RESULTS = ['hittable', 'not-hittable', 'moved', 'unavailable'] as const;
export type HitProbeResult = (typeof HIT_PROBE_RESULTS)[number];

export interface HitProbeIdentity {
  identifier?: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
}

export class OverlayHits {
  private readonly generation: number | undefined;
  private readonly results = new Map<Element, HitProbeResult>();

  constructor(private readonly screen: Screen) {
    this.generation = screen.nativeGeneration;
  }

  get(element: Element, screen: Screen): HitProbeResult | undefined {
    return screen === this.screen && screen.nativeGeneration === this.generation
      ? this.results.get(element)
      : undefined;
  }

  set(element: Element, result: HitProbeResult): void {
    if (this.screen.elements.includes(element))
      this.results.set(
        element,
        result === 'hittable' && !Number.isSafeInteger(this.generation) ? 'unavailable' : result,
      );
  }
}

export interface OverlayHitReceipt {
  observation: number;
  liveHit: HitProbeResult;
  predicate: Readonly<CentreCoverageDiagnostic>;
  // Why an unavailable read gave no answer; one fixed word, never app text.
  liveCheckReason?: LiveHitUnavailable;
}

export function hitProbeNote(result: HitProbeResult): string {
  return result === 'hittable'
    ? ''
    : result === 'not-hittable'
      ? '; the live hit read found no hit point'
      : '; no live hit read was available';
}

export const RUNNER_LIVE_CHECK_REASONS = [
  'expired',
  'no-identity',
  'absent',
  'ambiguous',
  'exception',
  'deadline',
  'read-failed',
] as const;
export type LiveCheckReason = (typeof RUNNER_LIVE_CHECK_REASONS)[number] | 'unreported';

// Why a read-only hit probe answered unavailable. The core and the iOS client name their own words;
// a runner reply may only carry one of RUNNER_LIVE_CHECK_REASONS, and anything else is `unreported`.
export const CLIENT_UNAVAILABLE = [
  'late',
  'threw',
  'stale-ref',
  'identity-changed',
  'runner-refused',
  'generation-changed',
] as const;
export const LIVE_HIT_UNAVAILABLE = [
  'not-identifiable',
  'no-reader',
  'no-generation',
  'no-frame',
  ...CLIENT_UNAVAILABLE,
  ...RUNNER_LIVE_CHECK_REASONS,
  'unreported',
] as const;
export type LiveHitUnavailable = (typeof LIVE_HIT_UNAVAILABLE)[number];

export function expiredHitProbeReason(context: QaDispatchContext): 'runner-refused' | 'late' {
  return context.refusal?.code === 'ACTION_CONTEXT_CHANGED' ? 'runner-refused' : 'late';
}

export function hitProbeErrorReason(error: unknown): 'runner-refused' | 'late' | 'threw' {
  if (error instanceof QaDispatchError) {
    if (error.code === 'ACTION_CONTEXT_CHANGED') return 'runner-refused';
    if (error.code === 'EVIDENCE_EXPIRED') return 'late';
  }
  return 'threw';
}

export interface HitProbeRead {
  result: HitProbeResult;
  reason?: LiveHitUnavailable;
}

// A bare result from an older adapter passes through unchanged and carries no reason; an unlisted word is dropped.
export function hitProbeRead(value: HitProbeResult | HitProbeRead): HitProbeRead {
  if (typeof value !== 'object' || value === null) return { result: value };
  const result = HIT_PROBE_RESULTS.includes(value.result) ? value.result : 'unavailable';
  if (result !== 'unavailable') return { result };
  const reason = LIVE_HIT_UNAVAILABLE.find((word) => word === value.reason);
  return reason ? { result, reason } : { result };
}

// A tap reply that was sent after an unavailable live check; an absent or unlisted word is `unreported`.
export function sentAfterUnavailableRead(
  data: unknown,
): { reason: LiveCheckReason; reported: 'word' | 'none' | 'unlisted' } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const reply = data as { occlusionCheck?: unknown; liveCheckReason?: unknown };
  if (reply.occlusionCheck !== 'unavailable') return undefined;
  const word = reply.liveCheckReason;
  if (typeof word !== 'string') return { reason: 'unreported', reported: 'none' };
  const reason = RUNNER_LIVE_CHECK_REASONS.find((listed) => listed === word);
  return reason ? { reason, reported: 'word' } : { reason: 'unreported', reported: 'unlisted' };
}
