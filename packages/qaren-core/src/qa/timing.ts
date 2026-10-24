import {
  WITHHOLD_CAUSES,
  MEDIA_KINDS,
  MEDIA_SOURCES,
  type MediaLatch,
  type WithholdCause,
} from './privacy.js';
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
  'type-call',
  'type-readback',
  'relayout-retap',
  'settle',
  'keyboard',
  'relaunch',
  'admission',
  'runner-post-mortem',
  'dispatch-bind',
  'dispatch-native',
  'dispatch-settle',
  'dispatch-health',
  'dispatch-readback',
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
export const ADMISSION_DECISIONS = ['retry', 'cancelled', 'refused'] as const;
export const ADMISSION_BOUNDARIES = [
  'attach',
  'bundle_ready',
  'foreign_driver',
  'open',
  'prove',
  'relaunch',
  'retry_wait',
] as const;
export const ADMISSION_ATTACH_STAGES = ['wait_targets', 'connect_exact'] as const;
export const ADMISSION_INNER_CLASSES = [
  'target_selection_platform_not_found',
  'target_selection_platform_conflict',
  'target_selection_device_not_found',
  'target_selection_device_ambiguous',
  'target_selection_bundle_not_found',
  'target_list_attempt_timeout',
  'target_readiness_timeout',
  'target_list_empty',
  'target_other_device',
  'bundle_readiness_timeout',
  'cdp_probe_timeout',
  'cdp_handshake_timeout',
  'cdp_target_closed',
  'cdp_request_timeout',
  'untyped',
  'none',
] as const;
export const ADMISSION_LIVENESS = ['not_probed', 'alive', 'dead', 'probe_failed'] as const;
export const ADMISSION_BUNDLE_REQUESTS = [
  'received',
  'not_received',
  'unknown',
  'probe_failed',
] as const;
const ADMISSION_WORDS = {
  admission: ADMISSION_DECISIONS,
  lastStarted: ADMISSION_BOUNDARIES,
  lastCompleted: [...ADMISSION_BOUNDARIES, 'none'],
  attachStage: ADMISSION_ATTACH_STAGES,
  inner: ADMISSION_INNER_CLASSES,
  liveness: ADMISSION_LIVENESS,
  bundleRequest: ADMISSION_BUNDLE_REQUESTS,
} as const;
const ADMISSION_NUMBERS = ['attempt', 'relaunches', 'elapsedMs', 'remainingMs'] as const;
const HEALTH_DETAILS = [
  'refused',
  'reset',
  'abort',
  'http-4xx',
  'http-5xx',
  'body-not-ok',
  'wedged',
  'transport-timeout',
  'http-protocol',
  'other',
] as const;
export type HealthDetail = (typeof HEALTH_DETAILS)[number];
export const RUNNER_SIGNALS = [
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGABRT',
  'SIGTRAP',
  'SIGSEGV',
  'SIGBUS',
  'SIGPIPE',
  'other',
] as const;
export const RUNNER_MARKERS = {
  markerReady: 'RN_FAST_RUNNER_LISTENER_READY',
  markerWaiting: 'RN_FAST_RUNNER_WAITING',
  markerWaitResult: 'RN_FAST_RUNNER_WAIT_RESULT',
  markerListenerFailed: 'RN_FAST_RUNNER_LISTENER_FAILED',
  markerSendFailed: 'RN_FAST_RUNNER_SEND_FAILED',
  markerIssueContained: 'RN_FAST_RUNNER_ISSUE_CONTAINED',
  markerTestIssue: ': error: -[RnFastRunnerUITests.RnFastRunnerTests testCommand]',
  markerTestFailed: "-[RnFastRunnerUITests.RnFastRunnerTests testCommand]' failed",
} as const;
export type RunnerMarkerCounts = Record<keyof typeof RUNNER_MARKERS, number>;
const POST_MORTEM_WORDS = {
  hostChild: ['alive', 'exited', 'unknown'],
  exitSignal: RUNNER_SIGNALS,
  appProcess: ['same', 'changed', 'absent', 'unknown'],
} as const;
const POST_MORTEM_NUMBERS = ['exitCode', ...Object.keys(RUNNER_MARKERS)] as (
  | 'exitCode'
  | keyof RunnerMarkerCounts
)[];
const POST_MORTEM_KEYS = [...Object.keys(POST_MORTEM_WORDS), ...POST_MORTEM_NUMBERS];
export type DispatchPhase =
  | 'dispatch-bind'
  | 'dispatch-native'
  | 'dispatch-settle'
  | 'dispatch-health'
  | 'dispatch-readback';
export interface TimingEvent {
  stage: TimingStage;
  edge: 'start' | 'end' | 'point';
  outcome: 'ok' | 'failed' | 'unknown' | 'withheld' | 'unavailable';
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
  method?: 'window-gate' | 'screen-static' | 'snapshot-eq' | 'timeout' | 'unknown';
  settled?: boolean | 'unknown';
  hierarchyChanged?: boolean | 'unknown';
  event?: 'shown' | 'hidden' | 'relayout';
  proof?: 'focused' | 'not-proven';
  keyboard?: boolean;
  relaunch?: 'attempted' | 'ready' | 'failed' | 'timeout';
  reapDisposition?: 'reaped' | 'already-absent' | 'replacement-preserved';
  withheld?: WithholdCause;
  kind?: MediaLatch['kind'];
  source?: MediaLatch['source'];
  readinessReason?: NativeReadinessReason;
  admission?: (typeof ADMISSION_DECISIONS)[number];
  attempt?: number;
  lastStarted?: (typeof ADMISSION_BOUNDARIES)[number];
  lastCompleted?: (typeof ADMISSION_BOUNDARIES)[number] | 'none';
  attachStage?: (typeof ADMISSION_ATTACH_STAGES)[number];
  inner?: (typeof ADMISSION_INNER_CLASSES)[number];
  relaunches?: number;
  relaunchFailed?: boolean;
  liveness?: (typeof ADMISSION_LIVENESS)[number];
  bundleRequest?: (typeof ADMISSION_BUNDLE_REQUESTS)[number];
  elapsedMs?: number;
  remainingMs?: number;
  healthDetail?: HealthDetail;
  hostChild?: 'alive' | 'exited' | 'unknown';
  exitCode?: number;
  exitSignal?: (typeof RUNNER_SIGNALS)[number];
  appProcess?: 'same' | 'changed' | 'absent' | 'unknown';
  markerReady?: number;
  markerWaiting?: number;
  markerWaitResult?: number;
  markerListenerFailed?: number;
  markerSendFailed?: number;
  markerIssueContained?: number;
  markerTestIssue?: number;
  markerTestFailed?: number;
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
    !['ok', 'failed', 'unknown', 'withheld', 'unavailable'].includes(input.outcome as string)
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
  for (const [key, words] of [
    ['withheld', WITHHOLD_CAUSES],
    ['kind', MEDIA_KINDS],
    ['source', MEDIA_SOURCES],
  ] as const) {
    if (input[key] === undefined) continue;
    if (key === 'kind' && input.kind === 'metric') continue;
    const word = (words as readonly string[]).find((word) => word === input[key]);
    if (input.stage !== 'screenshot' || input.outcome !== 'withheld' || !word) return undefined;
    Object.assign(event, { [key]: word });
  }
  const admission = input.stage === 'admission' && input.edge === 'point';
  for (const [key, values] of Object.entries(ADMISSION_WORDS)) {
    if (input[key] === undefined) continue;
    const value = (values as readonly string[]).find((word) => word === input[key]);
    if (!admission || !value) return undefined;
    Object.assign(event, { [key]: value });
  }
  if (input.relaunchFailed !== undefined) {
    if (!admission || typeof input.relaunchFailed !== 'boolean') return undefined;
    event.relaunchFailed = input.relaunchFailed;
  }
  if (!admission && ADMISSION_NUMBERS.some((key) => input[key] !== undefined)) return undefined;
  if (input.healthDetail !== undefined) {
    if (
      event.stage !== 'native-readiness' ||
      event.edge !== 'end' ||
      event.readinessReason !== 'health' ||
      !HEALTH_DETAILS.includes(input.healthDetail as HealthDetail)
    )
      return undefined;
    event.healthDetail = input.healthDetail as HealthDetail;
  }
  if (
    event.stage !== 'runner-post-mortem' &&
    POST_MORTEM_KEYS.some((key) => input[key] !== undefined)
  )
    return undefined;
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
    ...ADMISSION_NUMBERS,
    ...POST_MORTEM_NUMBERS,
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
  if (
    ['window-gate', 'screen-static', 'snapshot-eq', 'timeout', 'unknown'].includes(
      input.method as string,
    )
  )
    event.method = input.method as TimingEvent['method'];
  for (const key of ['settled', 'hierarchyChanged'] as const) {
    if (typeof input[key] === 'boolean' || input[key] === 'unknown') event[key] = input[key];
  }
  if (['shown', 'hidden', 'relayout'].includes(input.event as string))
    event.event = input.event as TimingEvent['event'];
  if (['focused', 'not-proven'].includes(input.proof as string))
    event.proof = input.proof as TimingEvent['proof'];
  if (typeof input.keyboard === 'boolean') event.keyboard = input.keyboard;
  for (const [key, values] of [
    ['relaunch', ['attempted', 'ready', 'failed', 'timeout']],
    ['reapDisposition', ['reaped', 'already-absent', 'replacement-preserved']],
    ...Object.entries(POST_MORTEM_WORDS),
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

let dispatchTiming: TimingContext | undefined;

export function observeDispatchPhases(timing: TimingContext | undefined): void {
  dispatchTiming = timing;
}

export function measureDispatchPhase<T>(
  phase: DispatchPhase,
  line: number | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const observe = dispatchTiming?.observe;
  return measureTiming(
    observe && line !== undefined ? (event) => observe({ ...event, line }) : observe,
    dispatchTiming?.now ?? (() => 0),
    phase,
    work,
  );
}

export async function measureTiming<T>(
  observer: TimingObserver | undefined,
  now: () => number,
  stage: TimingStage,
  work: () => Promise<T>,
  outcomeOf: (result: T) => TimingEvent['outcome'] = () => 'ok',
): Promise<T> {
  if (!observer) return work();
  const started = now();
  observeTiming(observer, { stage, edge: 'start', outcome: 'ok', at: started });
  let outcome: TimingEvent['outcome'] = 'failed';
  try {
    const result = await work();
    outcome = outcomeOf(result);
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
