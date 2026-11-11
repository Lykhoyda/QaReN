import type {
  CandidateExclusion,
  CollapsedCandidate,
  CoveredBy,
  ScrollBandReceipt,
} from './resolve.js';
import type { OverlayHitReceipt } from './live-hit.js';
import type { PressEvidence } from './selection-press.js';
import type { MediaLatch, WithholdCause } from './privacy.js';
import type { Item } from './plan.js';
import type { InterruptionDiagnostic, InterruptionScreenClass } from './recover.js';
export type RowOutcome = 'pass' | 'fail' | 'retry';

export interface Selector {
  id?: string;
  text?: string;
}

export type LedgerPath = 'walk' | 'replay' | `replay→walk@${number}`;

// Worst coverage is retained for persistence; connection events determine recovery.
export const REACT_GAPS = ['unknown', 'incomplete', 'reconnected', 'lost'] as const;
export type ReactConnectionEvent = 'lost' | 'reconnected';

// The Fill ladder rung a fill row used: keyboard typing, in-app clear then typing, or the change handler.
export type FillMethod = 'already-set' | 'keyboard' | 'clear-type' | 'set-handler';

// Observed and expected lengths, shared prefix and suffix lengths, and whether only letter case differs.
export interface EntryMismatch {
  len: number;
  exp: number;
  prefix: number;
  suffix: number;
  caseEq: boolean;
}

export interface LedgerRow {
  overlayChecks?: OverlayHitReceipt[];
  scrollBand?: ScrollBandReceipt;
  block: string;
  operationId?: number;
  line: number;
  text: string;
  attempt: number;
  kind: 'step' | 'check';
  resolvedBy: 'exact' | 'jev';
  ref?: string;
  screenshot?: string;
  screenshotWithheld?: WithholdCause;
  t: number;
  outcome: RowOutcome;
  reason?: string;
  unverifiedPress?: true;
  reactCoverage?: (typeof REACT_GAPS)[number];
  reactConnections?: ReactConnectionEvent[];
  timing?: RowTiming;
  selector?: Selector;
  // Typed and held character counts of an unverified fill, kept out of the masked reason.
  kept?: { typed: number; observed: number[] };
  // Characters typed into a field that changed only their letter case.
  caseNormalized?: { chars: number };
  // How a refused private fill differed, as counts only.
  entryMismatch?: EntryMismatch;
  // The system dialog button the runner proved it tapped.
  dialog?: { label: string; rect: { x: number; y: number; width: number; height: number } };
  method?: FillMethod;
  // The dismissal tier that hid a visible keyboard before this press.
  keyboardCleared?: 'native-control' | 'js';
  // Why this step was sent again: a swallowed press, or a dismissed development error overlay.
  retryCause?: 'KEYBOARD_SWALLOWED_TAP' | 'DEV_REDBOX';
  // The overlay variant and dismissal attempt number, including failed attempts, never its text.
  devError?: {
    variant: 'redbox' | 'logbox';
    dismissal: number;
    afterAction?: true;
    proof?: 'next-test-id-appeared';
  };
  // A plain scroll that passed although two dispatched attempts left the screen unchanged.
  scrollDetail?: { status: 'no_visible_change' | 'no_visible_change_content_remains'; attempts: 2 };
  // How long the first Tap or Fill after launch polled for its absent target.
  implicitWaitMs?: number;
  // What interruption recovery decided for this step; value-free.
  interruption?: InterruptionReceipt;
  // Same-label wrappers counted as the control they wrap.
  collapsed?: CollapsedCandidate[];
  // Same-label candidates set aside on proof before the target was chosen or refused.
  candidateExclusions?: CandidateExclusion[];
  // What covered the target's centre before the tap.
  coveredBy?: CoveredBy;
}

export interface InterruptionReceipt {
  considered: true;
  outcome: 'vetoed' | 'dismissed' | 'not-dispatched' | 'ambiguous' | 'did-not-disappear';
  veto?: InterruptionDiagnostic['veto'];
  provenance?: InterruptionDiagnostic['provenance'];
  // The plan line and step kind of the target behind a target veto.
  targetLine?: number;
  targetKind?: Item['kind'];
  soleDecline?: boolean;
  // When a dispatched decline stayed: the vertical centre, in points, of the control it aimed at.
  pressCentreY?: number;
  // The fixed class a dismissed screen was recognised as, when one applied.
  screenClass?: InterruptionScreenClass;
  // A permission opt-in declined although it followed the plan's own tap.
  afterPlannedPress?: true;
}

// One permission opt-in dismissal; a line repeats when one step declined two.
export interface DeclinedOptIn {
  line: number;
  afterPlannedPress: boolean;
}

// The value-free announcement that a plan line begins; its row later carries the same operationId.
export interface StepStart {
  operationId: number;
  line: number;
  kind: LedgerRow['kind'];
  t: number;
}

export interface LedgerFailure {
  step: number;
  seen: string;
  screenshot?: string;
  // Set only when a plan step's own judgment failed; no other failure may mark a saved plan broken.
  kind?: 'step';
  // Target-class failures only: the last observed screen, one suggested plan edit and the miss reason.
  screen?: ScreenNow;
  suggestion?: string;
  subreason?: TargetMissDiagnostic['reason'] | 'ambiguous' | 'previous-plan-press';
  // Why a scroll step failed; set only by the walker, never read from reason prose.
  cause?:
    | 'scroll_dispatch_failed'
    | 'scroll_context_changed'
    | 'scroll_target_absent'
    | 'scroll_container_unreachable';
}

export interface BlockResult {
  key: string;
  outcome: 'pass' | 'fail';
  source: 'discovered' | 'replayed' | 'patched';
  saved?: false;
  unsavable?: string;
}

export type ContinuitySignal =
  | 'dev-client-picker'
  | 'first-run-tutorial'
  | 'runner-recovery'
  | 'runner-leak'
  | 'app-not-running'
  | 'app-process-changed'
  | 'dev-overlay'
  | 'app-process-gone'
  | 'app-process-unproven';

export interface ContinuityEvent {
  signal: ContinuitySignal;
  atMs: number;
  line?: number;
  counted: boolean;
  beforeAdmission?: boolean;
  detail?: {
    recoveryTier?: string;
    recoveryReason?: string;
    front?: string;
    fromPid?: number;
    toPid?: number;
    unresolved?: boolean;
  };
}

export function appendContinuityEvent(events: ContinuityEvent[], event: ContinuityEvent): number {
  if (events.length < 16) {
    events.push(event);
    return 0;
  }
  const uncounted = events.findIndex((entry) => !entry.counted);
  if (event.counted && uncounted !== -1) {
    events.splice(uncounted, 1);
    events.push(event);
  }
  return 1;
}

export interface Ledger {
  pressEvidence?: PressEvidence;
  verdict: 'PASS' | 'FAIL';
  videoPublication?: 'eligible' | 'withheld-fill' | 'withheld-privacy' | 'unknown';
  videoPolicy?: 'strict' | 'non-strict' | 'undeclared';
  nonStrictPublication?: 'eligible' | 'withheld-secret';
  mediaWithheld?: {
    screenshots?: MediaLatch & { line: number; count: number };
    video?: MediaLatch & { line: number };
  };
  admittedAtMs?: number;
  publishFromMs?: number;
  publicationInterrupted?: boolean;
  continuityEvents?: ContinuityEvent[];
  continuityEventsDropped?: number;
  path: LedgerPath;
  blocks: BlockResult[];
  blocksWritten?: string[];
  steps: LedgerRow[];
  jev: JevRollup;
  llmTurns: number;
  escapes: number;
  recoveries: number;
  declinedOptIns?: DeclinedOptIn[];
  speed?: LedgerSpeed;
  failure?: LedgerFailure;
  recipe?: { slug: string; markdown: string } | { unsavable: string };
}

export interface RefusedLedger extends Omit<Ledger, 'verdict'> {
  verdict: 'REFUSED';
  code: string;
  message: string;
}

export type WalkResult = Ledger | RefusedLedger;

// The verdict never contradicts the rows: a failed row or block without a failure detail synthesizes one.
export function buildLedger(
  blocks: BlockResult[],
  steps: LedgerRow[],
  failure?: LedgerFailure,
  calls: readonly JevCall[] = [],
  path: LedgerPath = 'walk',
  recoveries = 0,
): WalkResult {
  const failedRow = [...steps].reverse().find((r) => r.outcome === 'fail');
  const failedBlock = blocks.find((b) => b.outcome === 'fail');
  if (!failure && (failedRow || failedBlock)) {
    failure = {
      step: failedRow?.line ?? 0,
      seen: failedRow?.reason ?? `block ${failedBlock?.key ?? ''} failed`,
      ...(failedRow?.screenshot ? { screenshot: failedRow.screenshot } : {}),
    };
  }
  const ledger: Ledger = {
    verdict: failure ? 'FAIL' : 'PASS',
    path,
    blocks,
    steps,
    jev: summarizeJev(calls),
    llmTurns: 0,
    escapes: 0,
    recoveries,
  };
  const speed = summarizeSpeed(steps);
  if (speed) ledger.speed = speed;
  if (failure) ledger.failure = failure;
  const gap = steps.find((row) => row.reactCoverage === 'lost');
  const connection = steps
    .flatMap(
      (row) =>
        row.reactConnections ??
        (row.reactCoverage === 'lost' || row.reactCoverage === 'reconnected'
          ? [row.reactCoverage]
          : []),
    )
    .at(-1);
  if (!failure && gap && connection !== 'reconnected') {
    const message =
      'React coverage was lost during the walk; native evidence alone cannot verify the run.';
    return {
      ...ledger,
      verdict: 'REFUSED',
      code: 'REACT_COVERAGE_LOST',
      message,
      failure: { step: gap.line, seen: message },
    };
  }
  return ledger;
}

export interface JevRollup {
  calls: number;
  medianMs: number;
  inputTokens: number;
  callDetails: JevCall[];
}

export function summarizeJev(calls: readonly JevCall[]): JevRollup {
  const sorted = calls.map((call) => call.ms).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = !sorted.length
    ? 0
    : sorted.length % 2
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return {
    calls: calls.length,
    medianMs,
    inputTokens: calls.reduce((n, call) => n + (call.inputTokens ?? 0), 0),
    callDetails: [...calls],
  };
}

// A walk that ended without a verdict is a FAIL attributed to its in-flight step, else its last row; its rows cannot give a walk time.
export function ledgerWithoutResult(steps: LedgerRow[], seen: string, inFlight?: number): Ledger {
  const last = steps[steps.length - 1];
  const { speed: _speed, ...ledger } = buildLedger([], steps, {
    step: inFlight ?? last?.line ?? 0,
    seen,
    ...(last?.screenshot ? { screenshot: last.screenshot } : {}),
  });
  return { ...ledger, verdict: 'FAIL' };
}

export function screenshotName(index: number, line: number): string {
  return `screenshots/${String(index).padStart(2, '0')}-line${line}.png`;
}
import type { JevCall } from './questions.js';
import type { ScreenNow, TargetMissDiagnostic } from './target-miss.js';
import { summarizeSpeed, type LedgerSpeed, type RowTiming } from './row-timing.js';
