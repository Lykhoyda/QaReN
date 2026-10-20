export const NATIVE_PRESENCE_BUDGET_MS = 20_000;
export const CAPTURE_BUDGET_MS = 22_000;
export const EVIDENCE_USE_MS = 10_000;
export const MAX_EVIDENCE_AGE_MS = 32_000;
export const PHRASE_WAIT_BUDGET_MS = 65_000;

export const TIMING_STAGES = [
  'walk',
  'capture',
  'native-total',
  'native-production',
  'native-initial-eligibility',
  'native-preparation',
  'native-enumeration',
  'native-observation',
  'native-final-eligibility',
  'native-revalidation',
  'native-readiness',
  'native-transport',
  'native-decode',
  'native-presence-v2',
  'native-read-only-v1',
  'react-private',
  'join-private',
  'privacy-history',
  'decision',
  'jev-attempt',
  'jev-validation',
  'jev-backoff',
  'screenshot',
  'cache-reuse',
  'mutation',
  'authorization',
  'refresh',
  'reask',
  'replay',
  'expiry',
  'readback',
  'settle-readback',
  'relaunch',
  'overflow',
] as const;
export type TimingStage = (typeof TIMING_STAGES)[number];
const NATIVE_READINESS_REASONS = [
  'alive',
  'dead',
  'health',
  'authority-mismatch',
  'legacy',
  'protocol-older',
  'protocol-newer',
  'version-skew',
  'missing-commands',
  'missing-features',
  'unknown',
] as const;
export type NativeReadinessReason = (typeof NATIVE_READINESS_REASONS)[number];
export interface TimingEvent {
  stage: TimingStage;
  edge: 'start' | 'end' | 'point';
  outcome: 'ok' | 'failed' | 'unknown' | 'withheld';
  at: number;
  line?: number;
  observation?: number;
  ms?: number;
  useMs?: number;
  ageMs?: number;
  count?: number;
  nextLine?: number;
  presence?: number;
  budgetMs?: number;
  appliedBudgetMs?: number;
  moved?: number;
  maxDelta?: number;
  relaunch?: 'attempted' | 'ready' | 'failed' | 'timeout';
  reapDisposition?: 'reaped' | 'already-absent' | 'replacement-preserved';
  readinessReason?: NativeReadinessReason;
}
export type TimingObserver = (event: TimingEvent) => void;
export interface TimingContext {
  readonly now: () => number;
  readonly observe: TimingObserver;
}
export type RecordedTimingEvent = TimingEvent & { v: 1; seq: number };
export const TIMING_EVENT_LIMIT = 20_000;
export const TIMING_PREFIX = 'qaren-core: metric ';
export const formatTimingEvent = (event: RecordedTimingEvent): string =>
  `${TIMING_PREFIX}${JSON.stringify(event)}\n`;

export function cleanTimingEvent(value: unknown): TimingEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (
    !TIMING_STAGES.includes(input.stage as TimingStage) ||
    !['start', 'end', 'point'].includes(input.edge as string) ||
    !['ok', 'failed', 'unknown', 'withheld'].includes(input.outcome as string)
  )
    return undefined;
  const event = { stage: input.stage, edge: input.edge, outcome: input.outcome } as TimingEvent;
  if (input.readinessReason !== undefined) {
    if (
      input.stage !== 'native-readiness' ||
      input.edge !== 'end' ||
      !NATIVE_READINESS_REASONS.includes(input.readinessReason as NativeReadinessReason)
    )
      return undefined;
    event.readinessReason = input.readinessReason as NativeReadinessReason;
  }
  for (const key of [
    'at',
    'line',
    'observation',
    'ms',
    'useMs',
    'ageMs',
    'count',
    'nextLine',
    'presence',
    'budgetMs',
    'appliedBudgetMs',
    'moved',
    'maxDelta',
  ] as const) {
    const number = input[key];
    if (number === undefined && key !== 'at') continue;
    if (
      typeof number !== 'number' ||
      !Number.isFinite(number) ||
      number < 0 ||
      number > Number.MAX_SAFE_INTEGER
    )
      return undefined;
    event[key] = number;
  }
  for (const [key, values] of [
    ['relaunch', ['attempted', 'ready', 'failed', 'timeout']],
    ['reapDisposition', ['reaped', 'already-absent', 'replacement-preserved']],
  ] as const) {
    if (input[key] === undefined) continue;
    const value = values.find((word) => word === input[key]);
    if (!value) return undefined;
    Object.assign(event, { [key]: value });
  }
  return event;
}

export function observeTiming(observer: TimingObserver | undefined, event: TimingEvent): void {
  if (!observer) return;
  try {
    const clean = cleanTimingEvent(event);
    if (clean) observer(clean);
  } catch {
    // Diagnostics cannot change an operation's outcome.
  }
}

export function createTimingObserver(write: (event: RecordedTimingEvent) => void): TimingObserver {
  let seq = 0;
  return (event) => {
    if (seq > TIMING_EVENT_LIMIT) return;
    observeTiming((clean) => {
      seq += 1;
      write(
        seq > TIMING_EVENT_LIMIT
          ? { v: 1, seq, at: clean.at, stage: 'overflow', edge: 'point', outcome: 'failed' }
          : { ...clean, v: 1, seq },
      );
    }, event);
  };
}

export async function measureTiming<T>(
  observer: TimingObserver | undefined,
  now: () => number,
  stage: TimingStage,
  work: () => Promise<T>,
): Promise<T> {
  if (!observer) return work();
  const started = now();
  observeTiming(observer, { stage, edge: 'start', outcome: 'ok', at: started });
  let outcome: TimingEvent['outcome'] = 'failed';
  try {
    const result = await work();
    outcome = 'ok';
    return result;
  } finally {
    const at = now();
    observeTiming(observer, { stage, edge: 'end', outcome, at, ms: at - started });
  }
}

export interface ObservationTiming {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly expiresAt: number;
}

export function admitObservation(
  startedAt: number,
  completedAt: number,
): ObservationTiming | undefined {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    startedAt < 0 ||
    completedAt < startedAt ||
    completedAt - startedAt >= CAPTURE_BUDGET_MS
  ) {
    return undefined;
  }
  return {
    startedAt,
    completedAt,
    expiresAt: Math.min(completedAt + EVIDENCE_USE_MS, startedAt + MAX_EVIDENCE_AGE_MS),
  };
}

export function observationDeadline(timing: ObservationTiming, itemDeadline = Infinity): number {
  return Math.min(timing.expiresAt, itemDeadline);
}

export function observationUsable(
  timing: ObservationTiming,
  now: number,
  itemDeadline = Infinity,
): boolean {
  return (
    Number.isFinite(now) &&
    now >= timing.completedAt &&
    now < observationDeadline(timing, itemDeadline)
  );
}
