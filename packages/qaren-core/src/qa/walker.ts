import {
  hitProbeNote,
  OverlayHits,
  type HitProbeIdentity,
  type HitProbeResult,
  type OverlayHitReceipt,
} from './live-hit.js';
import {
  selectionPressCandidate,
  outsideTargetChange,
  PRESS_NOT_REGISTERED_REASON,
  PRESS_OUTSIDE_CHANGE_REASON,
  selectionPressGuidance,
  type PressEvidence,
} from './selection-press.js';
import { cropPng, stablePixelChange, type PixelCrop, type PixelScale } from './tap-pixels.js';
import {
  applyLabelProvenance,
  type LabelProvenance,
  cleanProvenanceReadDiagnostic,
  unavailableProvenance,
  type ProvenanceReporter,
  type LabelProvenanceDiagnostic,
} from './label-provenance.js';
import {
  fillText,
  InputPrivacyRefusal,
  currentInputs,
  declareEcho,
  throwIfInputPrivacyRefused,
  withEchoScope,
} from './inputs.js';
import { isAbort, cancellationSignal, withDeadline } from '../domain/cancellation.js';
import { fillLabels, type Block, type Item, type Target } from './plan.js';
import {
  type Element,
  type Screen,
  type NativeNode,
  type VisibilityBlockerDiagnostic,
  screenSignature,
  alertPressEffect,
  insideAlert,
  elementFrame,
  applicationFrame,
  isNativeInput,
  describe,
  reactOnlyFactsOf,
} from './screen.js';
import {
  type Resolution,
  type CentreCoverageDiagnostic,
  type ScreenDecision,
  CHECK,
  ResolutionError,
  decideScreen,
  elementSelector,
  centreCovered,
  inferredOverlayCoverage,
  overlayProbeCoverage,
  overlayProbeCandidates,
  clearanceBand,
  clearanceScroll,
  keyboardClearance,
  keyboardFallbackTarget,
  fillHostInside,
  bindFillIdentity,
  bindDispatchIdentity,
  stepTarget,
  scrollUntilBand,
  plainScrollBand,
  type PlainScrollBand,
  scrollUntilEvidence,
  scrollTargetCovered,
  scrollUntilContainer,
  scrollUntilDirection,
  targetEvidence,
  aggregateTargetVisible,
  targetNeedsPresence,
  presenceMiss,
  reactOnlyMiss,
  reactOnlyTarget,
  reactOnlyTimeout,
  reactOnlyViewport,
  visibleSelector,
  contend,
  coverOwner,
  type CoverGap,
  excludedCandidate,
  nestedCandidate,
  probeIdentifiable,
  MAX_HIT_PROBES,
  type CandidateExclusion,
} from './resolve.js';
import { literalEvidence, type LiteralNearMiss } from './evidence.js';
import { scrollMotion } from './scroll-motion.js';
import { scrollNavigationChange } from './scroll-navigation.js';
import { applyContainmentFallback, exactIdentities, focusIdentityOf } from './identity.js';
import {
  type BlockPlatform,
  type StoredBlock,
  loadBlock,
  readBlock,
  recipeMarkdown,
  serializeBlock,
  storedFits,
  writeBlock,
} from './blocks.js';
import {
  type Judge,
  type JevCall,
  JevError,
  unavailableJudge,
  INTERRUPTION_QUESTION,
  checkVerdict,
} from './questions.js';
import {
  type InterruptionDiagnostic,
  type OptInWithheld,
  type InterruptionProof,
  type InterruptionScreenClass,
  type LoginMarker,
  type OptInDecision,
  type PlannedSurface,
  type PressRecord,
  type RecoveryTarget,
  FIXED_CONTROL_WORDS,
  OPT_IN_ASKED_AGAIN,
  completeCapture,
  dismissCandidate,
  isDeclineLabel,
  plannedSurface,
  optInDecision,
  optInShaped,
  normaliseLabel,
  pressRecord,
  recover,
  returnedOptIn,
  protectionLapses,
  soleDecline,
  surfaceGone,
  targetBehindInterruption,
} from './recover.js';
import type {
  BlockOutcome,
  BlockOutcomeDiagnostic,
  InterruptionRejectedDiagnostic,
  MediaWithheldDiagnostic,
  FillPrivacyDiagnostic,
} from './diagnostics.js';
import {
  launchMissSuggestion,
  missSuggestion,
  screenNow,
  targetMissDiagnostic,
  placeholderPairingGap,
  type TargetMissDiagnostic,
} from './target-miss.js';
import {
  type MediaLatch,
  concealsScreen,
  INPUT_SCREEN_TEXT_WITHHELD,
  isPrivateInput,
  privateInputCause,
  MASK,
  ObservedPrivacy,
  matchPrivate,
  projectPlanLine,
} from './privacy.js';
import { renderReason, segments, type Reason } from './untrusted.js';
import { NativeSnapshotIncomplete, PrivateInputCaptureError } from './private-input.js';
import {
  AppProcessGoneError,
  CaptureDeadline,
  emitCaptureDiagnostics,
  emitQuotedTargetDiagnostic,
  NativeCaptureError,
} from './capture.js';
import {
  QaDispatchContext,
  QaDispatchError,
  type QaDispatchDiagnostic,
} from '../domain/qa-dispatch.js';
import {
  admitObservation,
  CAPTURE_BUDGET_MS,
  observationDeadline,
  observationUsable,
  NATIVE_PRESENCE_BUDGET_MS,
  PHRASE_WAIT_BUDGET_MS,
  type ObservationTiming,
  observeTiming,
  measureTiming,
  type TimingObserver,
  type TimingEvent,
} from './timing.js';
import { createRowTimer, separateRowOperations, type RowTiming } from './row-timing.js';
import {
  type BlockResult,
  type ContinuityEvent,
  appendContinuityEvent,
  type WalkResult,
  type LedgerFailure,
  type LedgerPath,
  type LedgerRow,
  type FillMethod,
  type EntryMismatch,
  type Selector,
  type StepStart,
  REACT_GAPS,
  buildLedger,
  screenshotName,
} from './ledger.js';
import type { InterruptionReceipt } from './ledger.js';

export interface ActResult {
  settle?: Pick<TimingEvent, 'method' | 'ms'>;
  executed?: boolean;
  ok: boolean;
  proven: boolean;
  error?: string;
  mutation?: 'none' | 'observed' | 'possible';
  // What a refused fill still proved; masked and unavailable pass unverified, mismatch fails.
  evidence?: 'masked' | 'unavailable' | 'mismatch' | 'case-normalized';
  // An unverified fill whose field changed only letter case; the count of characters typed.
  caseNormalized?: { chars: number };
  // The handler found more than one element for the target at dispatch: terminal, never retried.
  ambiguous?: boolean;
  // An unverified fill whose field held the same shorter value on every attempt, one length per attempt.
  kept?: { typed: number; observed: number[] };
  // A refused private fill's value-free difference from the requested text.
  entryMismatch?: EntryMismatch;
  // The system dialog button the runner proved it tapped, with its frame; value-free.
  dialog?: { label: string; rect: { x: number; y: number; width: number; height: number } };
  // Android exact tap on an editable field: whether its keyboard was shown within the tap's settle budget.
  keyboardShown?: boolean;
  // The Fill ladder rung that produced this result.
  method?: FillMethod;
}

export interface WalkerDeps {
  hitProbe?(
    ref: string,
    context: QaDispatchContext,
    generation: number,
    identity: HitProbeIdentity,
  ): Promise<HitProbeResult>;
  platform?: BlockPlatform;
  pressReadback?(evidence: PressEvidence | undefined): void;
  readLabelProvenance?(
    refs: string[],
    deadline: number,
    report: ProvenanceReporter,
  ): Promise<LabelProvenance[] | undefined>;
  privacy?: ObservedPrivacy;
  videoPolicy?: 'strict' | 'non-strict' | 'undeclared';
  mediaWithheld?(event: MediaWithheldDiagnostic): void;
  judge?: Judge;
  interruptionVeto?: boolean;
  // Android has no platform presence capture yet.
  presenceUnavailable?: boolean;
  publicationInterrupted?(): boolean;
  continuityEvents?(): ContinuityEvent[];
  continuityEventsDropped?(): number;
  captureScreen(options?: {
    observation?: number;
    platformPresence?: boolean;
    timing?: TimingObserver;
    // A wait's remaining time: the capture rejects with CaptureDeadline once it is spent.
    budgetMs?: number;
  }): Promise<Screen>;
  // requireLiveHit: the runner taps only when its live hit read proves the target hittable.
  press(
    ref: string,
    context: QaDispatchContext,
    options?: { requireLiveHit: true },
  ): Promise<ActResult>;
  fill(
    ref: string,
    text: string,
    context: QaDispatchContext,
    privateValue?: boolean,
    onPrivateInput?: () => void,
    alwaysRetype?: boolean,
    options?: { requireLiveHit?: true; placeholder?: string },
  ): Promise<ActResult>;
  // iOS only: type, proven only by a matching React read-back; testID identifies the pre-dispatch focus veto.
  typeFocused?(
    ref: string,
    text: string,
    testID: string | undefined,
    context: QaDispatchContext,
    requireFocused?: boolean,
    privateValue?: boolean,
    onPrivateInput?: () => void,
    alwaysRetype?: boolean,
  ): Promise<ActResult>;
  // iOS only: two exact enabled React reads before a focus tap; no dispatch context.
  fillAlreadySet?(
    testID: string,
    text: string,
    privateValue: boolean,
    onPrivateInput?: () => void,
  ): Promise<boolean>;
  // iOS only: positive React proof that the input with this testID is focused.
  reactFocused?(testID: string): Promise<boolean>;
  // iOS only: hides a visible keyboard, native tier then JS tier; none when neither proved it hidden.
  dismissKeyboard?(context: QaDispatchContext): Promise<'native-control' | 'js' | 'none'>;
  // iOS only: blur the focused input even when the native keyboard is hidden.
  blurFocusedInput?(context: QaDispatchContext): Promise<boolean>;
  // iOS only: Fill ladder rung 3, the input's change handler receives the whole value, then it is verified.
  setByHandler?(
    testID: string,
    text: string,
    context: QaDispatchContext,
    privateValue?: boolean,
    onPrivateInput?: () => void,
  ): Promise<ActResult>;
  // A value-free diagnostic line for the run log.
  note?(line: string): void;
  // clearance: pixels a keyboard-covered target's centre must travel; an adapter may size the swipe from it.
  // within: the visible part of the target's clip; an adapter starts the drag inside it.
  scroll(
    direction: 'down' | 'up',
    context: QaDispatchContext,
    clearance?: number,
    within?: NativeNode['rect'],
  ): Promise<ActResult>;
  back(context: QaDispatchContext): Promise<ActResult>;
  dialog(action: 'accept' | 'dismiss', context: QaDispatchContext): Promise<ActResult>;
  screenshot(name: string): Promise<string | undefined>;
  comparisonScreenshot?(): Promise<Uint8Array | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  row(row: LedgerRow): void;
  start?(start: StepStart): void;
  cancelled?(): boolean;
  diagnostic?(event: WalkerTimingDiagnostic): void;
  targetMiss?(event: TargetMissDiagnostic): void;
  labelProvenanceDiagnostic?(event: LabelProvenanceDiagnostic): void;
  fillPrivacy?(event: FillPrivacyDiagnostic): void;
  blockOutcome?(event: BlockOutcomeDiagnostic): void;
  interruptionRejected?(event: InterruptionRejectedDiagnostic): void;
  loginOutcome?(outcome: BlockOutcome): void;
  timing?: TimingObserver;
  rowTiming?(t: number): RowTiming;
  rowSettle?: TimingObserver;
  // iOS only: the app process every capture must still belong to, set by the first capture.
  appProcess?: { expected?: number };
  hideDevMenu?(): Promise<ActResult>;
  // A configured login wall; an absent block means it was missing or unreadable.
  login?: { marker: LoginMarker; block?: Block };
}

export interface WalkerTimingDiagnostic {
  line: number;
  stage: 'decision' | 'dispatch';
  code:
    | 'ACCEPTED'
    | 'COMPLETED'
    | 'EVIDENCE_EXPIRED'
    | 'ITEM_DEADLINE_EXCEEDED'
    | 'ACTION_INTERRUPTED'
    | 'ACTION_CONTEXT_CHANGED'
    | 'RUN_CANCELLED'
    | 'ACTION_OUTCOME_UNCERTAIN'
    | 'TARGET_MOVED_BEFORE_DISPATCH'
    | 'CENTRE_COVERED'
    | 'SCREEN_EVIDENCE_INCOMPLETE';
  at: number;
  acquisitionMs: number;
  observationAgeMs: number;
  authorizations?: number;
  observation?: number;
  visibilityBlocker?: VisibilityBlockerDiagnostic;
  refusalDiagnostic?: QaDispatchDiagnostic;
  clearanceDiagnostic?: {
    predicate: Readonly<CentreCoverageDiagnostic> | null;
    scrollOrigin: 'offscreen-resolution' | 'centre-covered' | 'native-occlusion' | null;
    requestedDirection: 'up' | 'down' | null;
    targetCentreChanged: boolean | null;
    // Why the observation named no cover; null when it named one or never looked.
    coverGap?: WalkerCoverGap | null;
  };
}

// A cover gap, or why the one presence recapture could not settle a no-native-presence gap.
export type WalkerCoverGap = CoverGap | 'presence-recapture-incomplete' | 'target-not-recaptured';

interface Observation {
  overlayHits?: OverlayHits;
  id: number;
  screen: Screen;
  timing: ObservationTiming;
  platformPresence: boolean;
}

// The Fill ladder steps to rung 3 only inside this budget from the item's start.
const FILL_LADDER_BUDGET_MS = 120_000;
const ITEM_DEADLINE_EXCEEDED = 'VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED';
const KEYBOARD_DISMISSED = '; the keyboard was dismissed before this tap';
const OFF_SCREEN_AFTER_SCROLL =
  'stayed off screen after one scroll: its centre is past the visible area or under the keyboard';
const INFERRED_FILL_UNAVAILABLE =
  'has no proven hit point under the inferred overlay; no clearance scroll was attempted';

// An overlay inferred from capture order alone: centre inside its clip, no keyboard in play.
const inferredOverlay = (facts: Readonly<CentreCoverageDiagnostic> | null) =>
  facts?.branch === 'overlay' && facts.viewportOutside === false && facts.keyboardVisible === false
    ? facts
    : undefined;

// Strict focus and an unnamed input's placeholder identity travel together; nothing when neither applies.
const fillOptions = (strict: boolean, placeholder: string | undefined) =>
  strict || placeholder
    ? {
        ...(strict ? { requireLiveHit: true as const } : {}),
        ...(placeholder ? { placeholder } : {}),
      }
    : undefined;

// The runner's fixed reason word, or the bare code; never the rest of a native message.
const liveHitRefusal = (error: string | undefined): string =>
  error?.match(/LIVE_HIT_UNPROVEN: ([a-z-]+)/)?.[1] ??
  error?.match(/^[A-Z_]+/)?.[0] ??
  'unavailable';

// Why no live hit read decided an inferred overlay; empty for other covers.
const unaskedLiveHit = (
  kind: Item['kind'],
  platform: BlockPlatform | undefined,
  facts: Readonly<CentreCoverageDiagnostic> | null,
): string => {
  if (facts?.branch !== 'overlay') return '';
  const why =
    kind !== 'press' && kind !== 'fill'
      ? `a ${kind} keeps the inferred rule`
      : platform !== 'ios'
        ? 'this platform keeps the inferred rule'
        : facts.keyboardVisible !== false
          ? 'the keyboard is not proven hidden'
          : facts.viewportOutside !== false
            ? 'its centre is not inside its clip'
            : kind === 'fill'
              ? 'this cover is ineligible for a read-only hit probe'
              : undefined;
  return why ? `; no live hit read was asked: ${why}` : '';
};

// Capture-local geometry of the inferred cutter; labels, identifiers and values stay withheld.
const cutterText = (facts: Readonly<CentreCoverageDiagnostic> | null): string => {
  const cut = facts?.cutter;
  if (!cut) return '';
  const { x, y, width, height } = cut.frame;
  return `; inferred band cutter ${cut.ref} (${cut.kind}) at ${x},${y},${width},${height} moved the band ${cut.edge} from ${cut.before[cut.edge]} to ${cut.after[cut.edge]}`;
};

class EvidenceExpired extends Error {
  constructor(readonly itemExpired = false) {
    super(itemExpired ? ITEM_DEADLINE_EXCEEDED : 'EVIDENCE_EXPIRED');
  }
}

const unresolvedText = (quoted: string) =>
  new ResolutionError({
    refuse: 'VISIBILITY_UNSURE',
    reason: `"${quoted}" stayed unresolved: matching text has no trusted frame or the native snapshot is incomplete`,
  });

// Under a system dialog nothing of the app can be scrolled, left or reached; a scroll or back there would go to whatever answers it.
const dialogInFront = (phrase?: string) =>
  new ResolutionError({
    refuse: 'TARGET_NOT_FOUND',
    reason:
      phrase === undefined
        ? 'a system dialog is in front of the app; nothing behind it can be scrolled, left or reached until the dialog is answered'
        : `"${phrase}" is behind a system dialog; nothing of the app can be scrolled to or reached until the dialog is answered`,
  });

// Refusals about the step's own target; their failure carries the last observed screen.
export const LAUNCH_MISS = 'TARGET_NOT_FOUND_AFTER_LAUNCH';
const TARGET_CODES: ReadonlySet<string> = new Set([
  'TARGET_NOT_FOUND',
  LAUNCH_MISS,
  'REPLAY_SELECTOR',
  'TARGET_AMBIGUOUS',
]);

export const WAIT_BUDGET_MS = 15_000;
export const WAIT_POLL_MS = 500;
export const SCROLL_ATTEMPTS = 6;
export const SCROLL_NO_VISIBLE_CHANGE =
  'SCROLL_NO_VISIBLE_CHANGE: two scrolls were dispatched and the screen did not change; this is not proof that the end of the content was reached';
export const KEYBOARD_READY_MS = 1_500;
export const KEYBOARD_READY_CAPTURES = 3;
export const SCROLL_SETTLE_READBACKS = 3;

type WalkRow = Omit<LedgerRow, 'reason'> & { reason?: Reason };
type WalkFailure = Omit<LedgerFailure, 'seen'> & { seen: Reason };

export interface WalkOutcome {
  block: BlockResult;
  rows: WalkRow[];
  failure?: WalkFailure;
  refusal?: { code: string; message: string };
  pressEvidence?: PressEvidence;
  // Replay only: the line whose stored selector failed before mutation authorization.
  miss?: number;
  // Fill lines that typed into a private input; their block is never saved.
  privateFills?: number[];
  recoveries?: number;
}

export interface WalkOptions {
  fromLine?: number;
  mode?: 'walk' | 'replay';
  recover?: boolean;
  login?: boolean;
  singleAttempt?: boolean;
  laterTargets?: readonly RecoveryTarget[];
}

const recoveryTarget = (item: Item): RecoveryTarget | undefined => {
  if (item.kind === 'check')
    return {
      ...(item.literal ? { quoted: item.text } : {}),
      phrase: item.text,
      kind: 'check',
      line: item.line,
    };
  const target = stepTarget(item);
  if (!target) return undefined;
  return {
    ...target,
    kind: item.kind,
    line: item.line,
    ...(item.declared ? { declared: item.declared } : {}),
  };
};

function markContinuity(
  sequence: WalkSequence,
  event: Omit<ContinuityEvent, 'atMs' | 'counted'>,
): void {
  sequence.continuityEventsDropped =
    (sequence.continuityEventsDropped ?? 0) +
    appendContinuityEvent((sequence.continuity ??= []), {
      ...event,
      atMs: Date.now(),
      counted: true,
    });
  sequence.publicationInterrupted = true;
}

export interface WalkSequence {
  observation: number;
  captureUnknown?: boolean;
  devOverlayAccepted?: true;
  latch?: {
    line: number;
    windowLine?: number;
    secretWindow?: { cause: MediaLatch; line: number };
  };
  screenshots?: { cause: MediaLatch; line: number; count: number };
  operation?: number;
  stepBudgets?: Map<number, { startedAt: number; deadline?: number; devErrorDismissals: number }>;
  publicationInterrupted?: boolean;
  continuity?: ContinuityEvent[];
  continuityEventsDropped?: number;
  momentum?: boolean;
  planPassed?: boolean;
  window?: { fromMs: number; typed: number };
  // System prompts recovery declined in this run; a repeat ask is the plan author's to answer.
  declinedPrompts?: Set<string>;
  // passedSince: a later planned item passed while a decline control stayed on screen.
  plannedPress?: PlannedSurface & { line: number; passedSince?: boolean; record?: PressRecord };
  // Permission opt-ins recovery declined in this run, by signature; a repeat ask is never tapped again.
  declinedOptIns?: Set<string>;
  // One entry per permission opt-in dismissal in this run.
  optInDeclines?: Array<{ line: number; afterPlannedPress: boolean }>;
  // Armed at launch and after a login replay; the next top-level Tap or Fill spends it.
  launchWait?: boolean;
}

function recordMediaLatch(
  privacy: ObservedPrivacy,
  sequence: WalkSequence,
  deps: WalkerDeps,
  line: number,
): void {
  const latch = privacy.latched();
  if (latch && !sequence.latch) sequence.latch = { line };
  const screenshotLatch = privacy.screenshotLatch(deps.videoPolicy);
  if (screenshotLatch && !sequence.screenshots) {
    sequence.screenshots = { cause: screenshotLatch, line, count: 0 };
    try {
      deps.mediaWithheld?.({
        kind: 'media-withheld',
        scope: 'screenshots',
        cause: screenshotLatch,
        line,
      });
    } catch {
      // Diagnostics cannot change the walk.
    }
  }
  if (privacy.windowLatched() && sequence.latch && sequence.latch.windowLine === undefined)
    sequence.latch.windowLine = line;
  const secret = privacy.secretWindowLatched();
  if (secret && sequence.latch && secret !== sequence.latch.secretWindow?.cause)
    sequence.latch.secretWindow = { cause: secret, line };
}

// Title and button labels of a system prompt, held in memory only.
const promptSignature = (screen: Screen): string =>
  JSON.stringify([
    screen.elements.find((e) => e.kind !== 'button' && e.label !== undefined)?.label,
    screen.elements.flatMap((e) => (e.kind === 'button' && e.label !== undefined ? [e.label] : [])),
  ]);

// A development error overlay is a known cause: its own Dismiss runs at most this often per step.
export const DEV_ERROR_DISMISSALS = 3;

// Closed causes of a DEV_REDBOX refusal; the messages carry no app text.
const DEV_ERROR_REFUSALS = {
  REPEATED: `a development error overlay was still in front after ${DEV_ERROR_DISMISSALS} dismissals in this step; nothing else was tapped`,
  DISMISS_FAILED: "the development error overlay's Dismiss control was not dispatched",
  NO_SAFE_DISMISS:
    'a development error overlay is in front with no single Dismiss control to press; nothing was tapped',
  CLEARANCE_UNPROVEN: 'the development error overlay was not proven gone after Dismiss',
  ACTION_UNCERTAIN:
    "a development error overlay appeared after the step's action was sent; it was not dismissed and the step was not replayed",
} as const;
type DevErrorRefusal = keyof typeof DEV_ERROR_REFUSALS;
const DEV_ERROR_RECURRENCE =
  'a development error overlay appeared again after one was already dismissed in this run; nothing was dismissed or replayed';

// The runner's refusal code only: a value-free token, never the message after it.
const refusalCode = (error: string | undefined): string | undefined =>
  /^([A-Z][A-Z0-9_]{2,63}):/u.exec(error ?? '')?.[1];

const FRAME = String.raw`(-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3})`;
const IDENTITY = String.raw`(?: \((?:[A-Za-z]{1,32}(?:\(\d{1,3}\))?), (?:label \d+ chars|no label), (has id|no id)\))?`;
const MOVED = new RegExp(
  `retained ${FRAME}${IDENTITY}; live ${FRAME}${IDENTITY}(?:; labels (?:match|differ), ids (?:match|differ))?; delta ${FRAME}`,
  'u',
);
function movedGeometry(error: string | undefined) {
  const m = MOVED.exec(error ?? '');
  if (!m) return undefined;
  const frame = (text: string) => text.split(',').map(Number);
  return {
    retained: frame(m[1]),
    live: frame(m[3]),
    delta: frame(m[5]),
    ...(m[2] ? { path: m[2] === 'has id' ? 'identifier' : 'label' } : {}),
  };
}

const PREVIOUS_PLAN_PRESS =
  '; the previous planned press succeeded; the next target was not found; automatic app dismissal was withheld';

const SCREEN_CLASS_NAMES: Record<InterruptionScreenClass | 'app', string> = {
  app: 'an app screen',
  'permission-opt-in': 'a permission opt-in',
};

// Capture and process refusals, ambiguity and the replay-miss path are never recovered.
const UNRECOVERABLE = new Set([
  'DEV_REDBOX_ACTION_UNCERTAIN',
  'SCROLL_NAVIGATED',
  'SCROLL_UNSETTLED',
  'REPLAY_SELECTOR',
  'TARGET_AMBIGUOUS',
  'SCREEN_EVIDENCE_INCOMPLETE',
  'APP_PROCESS_CHANGED',
  'APP_PROCESS_UNKNOWN',
]);

// Fixed text only: a literal failure repeats the plan's own literal and no app text.
const NEAR_MISS: Record<LiteralNearMiss, string> = {
  'not-visible':
    ' (not-visible: a node with this text exists but is reported not visible or is outside the viewport)',
  'not-literal-kind':
    ' (not-literal-kind: a node with this text exists but is not counted as literal text)',
};

// Retry a mutation once only when read-back failed and the screen provably did not move.
// Each block, including a nested login replay, gets its own declared-echo scope.
export function walkBlock(
  ...args: Parameters<typeof walkBlockScoped>
): ReturnType<typeof walkBlockScoped> {
  return withEchoScope(async () => {
    const [block, deps] = args;
    const report = (outcome: BlockOutcome): void => {
      if (!currentInputs()?.hasInputs) return;
      if (block.items.some((item) => item.kind === 'fill' && item.input)) {
        try {
          deps.blockOutcome?.({ kind: 'block-outcome', line: block.items[0].line, outcome });
        } catch {
          // Diagnostics cannot change the block's outcome.
        }
      }
      if (args[6]?.login) {
        try {
          deps.loginOutcome?.(outcome);
        } catch {
          // Diagnostics cannot change login recovery.
        }
      }
    };
    try {
      const outcome = await walkBlockScoped(...args);
      report(outcome.refusal ? 'refused' : outcome.block.outcome);
      return outcome;
    } catch (error) {
      if (error instanceof InputPrivacyRefusal) report('refused');
      throw error;
    }
  });
}

async function walkBlockScoped(
  block: Block,
  deps: WalkerDeps,
  shotIndex = 0,
  typed: string[] = [],
  privacy = new ObservedPrivacy(typed),
  sequence: WalkSequence = { observation: 0 },
  opts: WalkOptions = {},
  operations = new Map<number, number>(),
): Promise<WalkOutcome> {
  const replay = opts.mode === 'replay';
  const secretFill = (
    item: { input?: string; sensitivity?: 'non-secret'; line: number },
    element?: Element,
  ): boolean => {
    if (item.input === undefined) return false;
    const cause = element && privateInputCause(element);
    const privateTarget =
      cause !== undefined && (cause !== 'label-may-be-value' || item.sensitivity !== 'non-secret');
    const privateValue =
      currentInputs()?.protectFill(item.input, privateTarget) ?? item.sensitivity !== 'non-secret';
    if (cause)
      try {
        deps.fillPrivacy?.({ kind: 'fill-privacy', line: item.line, cause, privateValue });
      } catch {
        // Diagnostics cannot change Fill privacy.
      }
    return privateValue;
  };
  const rows: WalkRow[] = [];
  const reactGaps = new Map<number, NonNullable<LedgerRow['reactCoverage']>>();
  let reactConnections: NonNullable<LedgerRow['reactConnections']> = [];
  const privateFills: number[] = [];
  const promoteFill = (item: Item & { kind: 'fill' }, identifier?: string): void => {
    privacy.observePrivateFill(fillText(item));
    recordMediaLatch(privacy, sequence, deps, item.line);
    if (item.input !== undefined) {
      currentInputs()?.protectFill(item.input, true);
      currentInputs()?.expectEcho(identifier, item.input);
    } else if (!privateFills.includes(item.line)) privateFills.push(item.line);
  };
  for (const item of block.items)
    if (item.kind === 'fill' && !typed.includes(fillText(item))) typed.push(fillText(item));
  const judge = deps.judge ?? unavailableJudge;
  let resolvedBy: LedgerRow['resolvedBy'] = 'exact';
  let cached:
    | {
        item: Item;
        observation: Observation;
        decision?: ScreenDecision;
        needsLabelProvenance?: true;
      }
    | undefined;
  let latest: Screen = { elements: [], visibleText: [], front: 'app' };
  let pressBase: Screen | undefined;
  let pressAct: ActResult | undefined;
  let pressSelector: Selector | undefined;
  let pressNeedsReadback = false;
  let activeItem: Item | undefined;
  let postActionTried = false;
  let postActionShot: string | undefined;
  let postActionObservation: Observation | undefined;
  let postActionDevError: LedgerRow['devError'];
  let pressDispatch: PressRecord | undefined;
  let line = 0;
  let mutationStarted = false;
  // The Fill ladder rung of the current item's last fill dispatch, and when the item began.
  let fillMethod: FillMethod | undefined;
  let fillMismatch: EntryMismatch | undefined;
  let keyboardCleared: LedgerRow['keyboardCleared'];
  let fillHandlerAttempted = false;
  let fillHandlerRefused = false;
  let itemStartedAt = 0;
  let itemDeadline: number | undefined;
  let stepDispatched = false;
  // The current item's launch allowance, from when it was spent; its measured poll; preparation resets its captures saw.
  let launchWait: { startedAt: number } | undefined;
  let implicitWaitMs: number | undefined;
  let preparationResets: number | undefined;
  // A quoted wait's one layout read and one scroll, which a recovery retry does not refund.
  let enrichment: { at: number; budget: number; waited?: number } | undefined;
  let waitAttempt: 'scroll' | 'none' = 'none';
  let latestObservation = 0;
  let itemObservationStart = 0;
  // When each screen was captured, and the observation the last device action was dispatched on.
  const captured = new WeakMap<Screen, { at: number; id: number }>();
  // The newest observation that passed admission, recovery's captures included.
  let newest: Screen | undefined;
  let dispatchedOn = 0;
  let recoveries = 0;
  let metadataOnly = false;
  // The capture stage last started, which a capture cut off at a wait deadline was in.
  let captureStage: string | undefined;
  const captureScreen: WalkerDeps['captureScreen'] = async (options) => {
    const screen = await deps.captureScreen(options);
    const react = screen.reactConnection ?? screen.captureCoverage?.react;
    if ((react === 'lost' || react === 'reconnected') && reactConnections.at(-1) !== react)
      reactConnections.push(react);
    if (react && react !== 'complete') {
      const prior = reactGaps.get(line);
      if (!prior || REACT_GAPS.indexOf(react) > REACT_GAPS.indexOf(prior))
        reactGaps.set(line, react);
    }
    return screen;
  };
  // The interruption a step's first decline answered; null once no further recovery is allowed.
  const recovered = new Map<Item, string | null>();
  const stepBudgets = (sequence.stepBudgets ??= new Map());
  const metric = (
    stage: TimingEvent['stage'],
    observation?: Observation,
    extra: Partial<TimingEvent> = {},
  ): void => {
    if (!deps.timing) return;
    const at = deps.now();
    observeTiming(deps.timing, {
      stage,
      edge: 'point',
      outcome: 'ok',
      at,
      line,
      observation: observation?.id ?? latestObservation,
      ...(observation
        ? { useMs: at - observation.timing.completedAt, ageMs: at - observation.timing.startedAt }
        : {}),
      ...extra,
    });
  };
  const assertActive = (): void => {
    cancellationSignal();
    if (deps.cancelled?.()) throw new QaDispatchError('RUN_CANCELLED');
  };
  const pause = async (ms: number): Promise<void> => {
    assertActive();
    await deps.sleep(ms);
    assertActive();
  };
  const captureOnce = async (
    step?: Exclude<Item, { kind: 'check' }>,
    assertion = false,
    recovery = false,
    purpose: 'resolve' | 'provenance' = 'resolve',
    until?: number,
  ): Promise<Observation> => {
    assertActive();
    cached = undefined;
    captureStage = undefined;
    const target =
      step && ('target' in step ? step.target : step.kind === 'scroll' ? step.until : undefined);
    const requirePresence = assertion || (!!target && target.quoted === undefined);
    const platformPresence = requirePresence || purpose === 'provenance';
    const startedAt = deps.now();
    let readStartedAt = startedAt;
    if (until !== undefined && startedAt >= until) throw new CaptureDeadline();
    const id = ++sequence.observation;
    latestObservation = id;
    const captureLine = line;
    const timingObserver: TimingObserver | undefined = deps.timing
      ? (event) => {
          if (event.edge === 'start') captureStage = event.stage;
          if (
            event.stage === 'native-preparation' &&
            event.edge === 'point' &&
            event.resets !== undefined
          )
            preparationResets = (preparationResets ?? 0) + event.resets;
          observeTiming(deps.timing, { ...event, line: captureLine, observation: id });
        }
      : undefined;
    observeTiming(timingObserver, {
      stage: 'capture',
      edge: 'start',
      outcome: 'ok',
      at: startedAt,
      presence: Number(platformPresence),
    });
    let admitted = false;
    try {
      try {
        const deadline = step?.kind === 'wait' ? itemDeadline : undefined;
        let incomplete: NativeSnapshotIncomplete | undefined;
        let reads = 0;
        while (true) {
          assertActive();
          if (incomplete && deadline !== undefined && deps.now() >= deadline)
            throw incomplete.withReads(reads, deps.now() - startedAt);
          try {
            if (reads++ > 0) readStartedAt = deps.now();
            latest = await captureScreen({
              observation: id,
              ...(platformPresence ? { platformPresence: true } : {}),
              ...(timingObserver ? { timing: timingObserver } : {}),
              ...(until === undefined ? {} : { budgetMs: Math.max(0, until - readStartedAt) }),
            });
            break;
          } catch (error) {
            if (error instanceof CaptureDeadline && incomplete)
              throw incomplete.withReads(reads, deps.now() - startedAt);
            if (!(error instanceof NativeSnapshotIncomplete) || deadline === undefined) throw error;
            incomplete = new NativeSnapshotIncomplete(error.nodes, error.causes);
            sequence.captureUnknown = true;
            await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
          }
        }
        // Stamped at the capture's start until admission records its completion.
        captured.set(latest, { at: readStartedAt, id });
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof AppProcessGoneError) throw processChanged();
        throw error;
      }
      if (
        latest.front === 'picker' ||
        latest.front === 'dev-fab' ||
        latest.front === 'dev-menu' ||
        latest.front === 'dev-redbox'
      )
        markContinuity(sequence, { signal: 'dev-overlay', line, detail: { front: latest.front } });
      const privacyStarted = deps.timing ? deps.now() : 0;
      privacy.observe(latest);
      recordMediaLatch(privacy, sequence, deps, line);
      guardAppProcess(deps.appProcess, latest.appProcessIdentifier);
      // A natively identified overlay gets its bounded dismissal; React's error flag alone still fails.
      if (latest.renderError && latest.front !== 'dev-redbox') throw new RenderError();
      // The overlay is never read as the app: recovery dismisses it, or the step refuses.
      if (latest.front === 'dev-redbox' && !recovery) {
        const cause: DevErrorRefusal =
          mutationStarted || sequence.devOverlayAccepted ? 'ACTION_UNCERTAIN' : 'NO_SAFE_DISMISS';
        if (!mutationStarted || !postActionEligible(activeItem, latest))
          throw new ResolutionError({
            refuse: `DEV_REDBOX_${cause}`,
            reason: sequence.devOverlayAccepted ? DEV_ERROR_RECURRENCE : DEV_ERROR_REFUSALS[cause],
          });
      }
      if (deps.timing)
        observeTiming(timingObserver, {
          stage: 'privacy-history',
          edge: 'point',
          outcome: 'ok',
          at: deps.now(),
          ms: deps.now() - privacyStarted,
        });
      assertActive();
      if (until !== undefined && deps.now() >= until) throw new CaptureDeadline();
      const timing = admitObservation(readStartedAt, deps.now());
      if (timing) captured.set(latest, { at: timing.completedAt, id });
      if (!timing)
        throw new ResolutionError({
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason: 'ACQUISITION_EXPIRED',
        });
      // Raw acquisition and semantic projection have different completeness requirements.
      if (
        (step || assertion) &&
        (latest.captureCoverage?.native ?? latest.coverage?.native) !== 'complete'
      )
        throw new ResolutionError({
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason: 'NATIVE_ACQUISITION_UNUSABLE',
        });
      if (requirePresence && latest.front === 'dialog' && !recovery)
        throw new ResolutionError({
          refuse: 'SYSTEM_DIALOG_INTERRUPTED',
          reason: 'a system dialog is in front of the step target',
        });
      if (platformPresence && latest.front !== 'dialog' && latest.coverage?.native !== 'complete')
        throw new ResolutionError({
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason: 'NATIVE_PRESENCE_UNUSABLE',
        });
      admitted = true;
      newest = latest;
      metadataOnly = false;
      emitCaptureDiagnostics(latest);
      const observation = { screen: latest, timing, id, platformPresence };
      return latest.front === 'dev-redbox' && !recovery
        ? await postActionOverlay(activeItem!, observation, until)
        : observation;
    } catch (error) {
      if (isAbort(error)) throw error;
      if (
        latest.front === 'dev-redbox' &&
        !recovery &&
        mutationStarted &&
        !postActionTried &&
        (error instanceof CaptureDeadline ||
          (error instanceof ResolutionError && error.code === 'SCREEN_EVIDENCE_INCOMPLETE'))
      )
        throw new ResolutionError({
          refuse: 'DEV_REDBOX_ACTION_UNCERTAIN',
          reason: DEV_ERROR_REFUSALS.ACTION_UNCERTAIN,
        });
      if (error instanceof ResolutionError && error.code === 'APP_PROCESS_CHANGED')
        markContinuity(sequence, { signal: 'app-process-changed', line });
      throw error;
    } finally {
      if (deps.timing) {
        const at = deps.now();
        observeTiming(timingObserver, {
          stage: 'capture',
          edge: 'end',
          outcome: admitted ? 'ok' : 'failed',
          at,
          ms: at - startedAt,
          presence: Number(platformPresence),
        });
      }
    }
  };
  // The one bounded platform-presence recapture for cover evidence an ordinary capture cannot carry;
  // a late or incomplete read returns nothing, so the cover stays unproven rather than refusing.
  const presenceRecapture = async (
    item: Exclude<Item, { kind: 'check' }>,
    until?: number,
  ): Promise<Observation | undefined> => {
    try {
      return await captureOnce(item, false, false, 'provenance', until);
    } catch (error) {
      if (
        error instanceof CaptureDeadline ||
        (error instanceof ResolutionError && error.code === 'SCREEN_EVIDENCE_INCOMPLETE')
      )
        return undefined;
      throw error;
    }
  };
  const enrichLabelProvenance = async (
    observation: Observation,
    step?: Exclude<Item, { kind: 'check' }>,
    until = Infinity,
  ): Promise<Observation> => {
    if (!step || step.kind !== 'press' || !targetNeedsPresence(step, observation.screen))
      return observation;
    const refs = exactIdentities(observation.screen, step.target, 'press')
      .map(({ element }) => element.ref)
      .filter((ref) => !ref.startsWith('react:'));
    const deadline = observationDeadline(observation.timing, until);
    if (deps.now() >= deadline) throw new CaptureDeadline();
    metadataOnly = true;
    let provenance: LabelProvenance[] | undefined;
    let provenanceDiagnostic = {
      ...unavailableProvenance('adapter-unavailable'),
      requested: false,
    };
    const report: ProvenanceReporter = (event) => {
      const clean = cleanProvenanceReadDiagnostic(event);
      if (clean) provenanceDiagnostic = clean;
    };
    const provenanceTimeout = new Error('candidate-provenance-deadline');
    try {
      provenance = await withDeadline(
        performance.now() + Math.max(0, deadline - deps.now()),
        provenanceTimeout,
        async () => {
          if (!deps.readLabelProvenance) return undefined;
          provenanceDiagnostic = unavailableProvenance();
          // Leave time for the native timeout diagnostic to reach the walker.
          return deps.readLabelProvenance(refs, deadline - 1_500, report);
        },
      );
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof AppProcessGoneError) throw processChanged();
      if (provenanceDiagnostic.outcome === 'unavailable')
        provenanceDiagnostic.outcome = error === provenanceTimeout ? 'deadline' : 'read-failed';
      if (error === provenanceTimeout) provenanceDiagnostic.deadlineExpired = true;
    }
    assertActive();
    if (deps.now() >= deadline) {
      provenanceDiagnostic.deadlineExpired = true;
      if (['available', 'unavailable'].includes(provenanceDiagnostic.outcome))
        provenanceDiagnostic.outcome = 'deadline';
    }
    const provenanceAdmitted =
      deps.now() < deadline && applyLabelProvenance(observation.screen, refs, provenance);
    if (provenanceAdmitted) provenanceDiagnostic.outcome = 'available';
    const containment =
      !provenanceAdmitted &&
      provenance === undefined &&
      deps.now() < deadline &&
      provenanceDiagnostic.outcome === 'deadline-clean' &&
      provenanceDiagnostic.deadlineExpired === true &&
      provenanceDiagnostic.differedFields.length === 0 &&
      provenanceDiagnostic.directLabelIndices !== undefined &&
      applyContainmentFallback(
        observation.screen,
        step.target,
        provenanceDiagnostic.directLabelIndices,
      );
    try {
      deps.labelProvenanceDiagnostic?.({
        kind: 'label-provenance',
        line: step.line,
        ...provenanceDiagnostic,
        ...(containment ? { resolvedBy: 'containment' as const } : {}),
      });
    } catch {
      /* Diagnostics cannot change admission. */
    }
    if (!provenanceAdmitted && !containment)
      throw new ResolutionError({
        refuse: 'TARGET_AMBIGUOUS',
        reason: 'candidate label provenance was unavailable within the observation budget',
      });
    return observation;
  };
  const capture = async (
    step?: Exclude<Item, { kind: 'check' }>,
    assertion = false,
    recovery = false,
  ): Promise<Observation> =>
    enrichLabelProvenance(await captureOnce(step, assertion, recovery), step);
  const diagnostic = (
    item: Item,
    observation: Observation,
    stage: WalkerTimingDiagnostic['stage'],
    code: WalkerTimingDiagnostic['code'],
    authorizations?: number,
    visibilityBlocker?: VisibilityBlockerDiagnostic,
    refusalDiagnostic?: QaDispatchDiagnostic,
    clearanceDiagnostic?: WalkerTimingDiagnostic['clearanceDiagnostic'],
  ): void => {
    try {
      const at = deps.now();
      deps.diagnostic?.({
        line: item.line,
        stage,
        code,
        at,
        acquisitionMs: observation.timing.completedAt - observation.timing.startedAt,
        observationAgeMs: at - observation.timing.startedAt,
        ...(authorizations === undefined ? {} : { authorizations }),
        ...(visibilityBlocker || clearanceDiagnostic ? { observation: observation.id } : {}),
        ...(visibilityBlocker ? { visibilityBlocker } : {}),
        ...(refusalDiagnostic ? { refusalDiagnostic } : {}),
        ...(clearanceDiagnostic ? { clearanceDiagnostic } : {}),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      // Diagnostics cannot change a decision or dispatch outcome.
    }
  };
  // Native frames prove rest before dispatching on a scrolled target's centre.
  const settledCapture = async (item: Exclude<Item, { kind: 'check' }>): Promise<Observation> => {
    const geometry = (screen: Screen): number[][] =>
      screen.elements.flatMap((e) => {
        const frame = elementFrame(e);
        return frame ? [[frame.x, frame.y, frame.width, frame.height]] : [];
      });
    let observation = await capture(item);
    for (let readback = 0; readback < SCROLL_SETTLE_READBACKS; readback += 1) {
      usable(observation, item);
      const next = await capture(item);
      const before = geometry(observation.screen);
      const after = geometry(next.screen);
      if (deps.timing) {
        const previousFrames = new Set(before.map((frame) => frame.join(',')));
        const currentFrames = new Set(after.map((frame) => frame.join(',')));
        const moved =
          [...previousFrames].filter((frame) => !currentFrames.has(frame)).length +
          [...currentFrames].filter((frame) => !previousFrames.has(frame)).length;
        const maxDelta = observation.screen.elements.reduce((max, element) => {
          const previousMatches = observation.screen.elements.filter((candidate) =>
            sameIdentity(candidate, element),
          );
          if (previousMatches.length !== 1) return max;
          const previous = elementFrame(element);
          const matches = next.screen.elements.filter((candidate) =>
            sameIdentity(candidate, element),
          );
          const current = matches.length === 1 ? elementFrame(matches[0]) : undefined;
          return previous && current ? Math.max(max, Math.abs(current.y - previous.y)) : max;
        }, 0);
        metric('settle-readback', next, { moved, maxDelta });
      }
      if (JSON.stringify(after) === JSON.stringify(before)) {
        sequence.momentum = false;
        return next;
      }
      observation = next;
    }
    throw new ResolutionError({
      refuse: 'SCROLL_UNSETTLED',
      reason: 'the target stayed off screen after one scroll: its frame did not settle',
    });
  };
  // Identity mirrors the runner's live check: testID, else kind and label.
  const sameIdentity = (e: Element, target: Element): boolean =>
    target.testID !== undefined
      ? e.testID === target.testID && e.kind === target.kind
      : e.testID === undefined && e.kind === target.kind && e.label === target.label;
  const pixelTarget = (screen: Screen, target: Element) => {
    const matches = screen.elements.filter((element) => sameIdentity(element, target));
    const root = applicationFrame(screen);
    const scale: PixelScale | undefined =
      screen.pointScale !== undefined
        ? Number.isFinite(screen.pointScale) && screen.pointScale > 0
          ? screen.pointScale
          : undefined
        : root && root.width > 0 && root.height > 0
          ? { width: root.width, height: root.height }
          : undefined;
    if (screen.front !== 'app' || matches.length !== 1 || scale === undefined) return undefined;
    const element = matches[0];
    const frame = elementFrame(element);
    if (!frame || !element.hittable || insideAlert(element) || centreCovered(element, screen))
      return undefined;
    return { target: element, frame: { ...frame }, scale };
  };
  const samePixelTarget = (
    current: ReturnType<typeof pixelTarget>,
    target: NonNullable<ReturnType<typeof pixelTarget>>,
  ): boolean =>
    !!current &&
    sameIdentity(current.target, target.target) &&
    JSON.stringify(current.scale) === JSON.stringify(target.scale) &&
    current.frame.x === target.frame.x &&
    current.frame.y === target.frame.y &&
    current.frame.width === target.frame.width &&
    current.frame.height === target.frame.height;
  const pixelShot = async (
    item: Exclude<Item, { kind: 'check' }>,
    target: NonNullable<ReturnType<typeof pixelTarget>>,
  ): Promise<{ stable: boolean; crop?: PixelCrop; observation?: Observation }> => {
    assertActive();
    const allowed = () =>
      !sequence.captureUnknown &&
      !privacy.screenshotLatch(deps.videoPolicy) &&
      !metadataOnly &&
      !(deps.videoPolicy === 'non-strict'
        ? currentInputs()?.hasStrictInputs
        : currentInputs()?.hasInputs);
    if (!allowed() || !deps.comparisonScreenshot) return { stable: true };
    try {
      const before = await captureOnce(item);
      if (!samePixelTarget(pixelTarget(before.screen, target.target), target))
        return { stable: false };
      let bytes: Uint8Array | undefined;
      if (allowed()) {
        try {
          bytes = await deps.comparisonScreenshot();
        } catch (error) {
          if (isAbort(error)) throw error;
        }
      }
      assertActive();
      const observation = await captureOnce(item);
      if (!samePixelTarget(pixelTarget(observation.screen, target.target), target))
        return { stable: false };
      return {
        stable: true,
        observation,
        crop: bytes && allowed() ? cropPng(bytes, target.frame, target.scale) : undefined,
      };
    } catch (error) {
      if (
        isAbort(error) ||
        postActionTried ||
        (error instanceof ResolutionError && error.code.startsWith('DEV_REDBOX_'))
      )
        throw error;
      return { stable: false };
    }
  };
  const frameKey = (e: Element): string | undefined => {
    const rect = elementFrame(e);
    return rect ? [rect.x, rect.y, rect.width, rect.height].join(',') : undefined;
  };
  const identityText = (target: Element): string =>
    `${target.kind} ${target.label === undefined ? 'unlabelled' : `"${target.label}"`}, ${target.testID === undefined ? 'no testID' : `testID "${target.testID}"`}`;
  // Re-prove one exact identity at the same frame across two captures.
  const settledTarget = async (
    item: Exclude<Item, { kind: 'check' }>,
    target: Element,
    options: { nativeOnly?: true } = {},
  ): Promise<{ observation: Observation; frame: string } | { frames: string[] }> => {
    const quoted = target.testID ?? target.label;
    const frameOf = (screen: Screen): { frame?: string; reason: string } => {
      if (quoted === undefined || (item.kind !== 'press' && item.kind !== 'fill'))
        return { reason: 'absent' };
      const matches = exactIdentities(
        screen,
        { quoted, phrase: quoted, exact: target.testID !== undefined ? 'id' : 'text' },
        item.kind,
      ).filter(
        ({ element }) =>
          sameIdentity(element, target) &&
          (!options.nativeOnly || !element.ref.startsWith('react:')),
      );
      if (matches.length === 0) return { reason: 'absent' };
      if (matches.length > 1) return { reason: `ambiguous:${matches.length}` };
      const frame = frameKey(matches[0].element);
      return { frame, reason: frame ?? 'no-frame' };
    };
    let observation = await capture(item);
    const first = frameOf(observation.screen);
    let previous = first.frame;
    const frames = [first.reason];
    for (let readback = 0; readback < SCROLL_SETTLE_READBACKS; readback += 1) {
      usable(observation, item);
      const next = await capture(item);
      const current = frameOf(next.screen);
      frames.push(current.reason);
      if (current.frame !== undefined && current.frame === previous)
        return { observation: next, frame: current.frame };
      observation = next;
      previous = current.frame;
    }
    return { frames };
  };
  const usable = (observation: Observation, item: Item, deadline = Infinity): void => {
    assertActive();
    const now = deps.now();
    if (!observationUsable(observation.timing, now, deadline)) {
      metric('expiry', observation, { outcome: 'failed' });
      const itemExpired = now >= deadline;
      diagnostic(
        item,
        observation,
        'decision',
        itemExpired ? 'ITEM_DEADLINE_EXCEEDED' : 'EVIDENCE_EXPIRED',
      );
      throw new EvidenceExpired(itemExpired);
    }
  };
  const decide = async (
    observation: Observation,
    check?: Item & { kind: 'check' },
    step?: Exclude<Item, { kind: 'check' }>,
    deadline = Infinity,
    initial?: ScreenDecision,
  ): Promise<ScreenDecision> => {
    const item = (check ?? step)!;
    usable(observation, item, deadline);
    const started = deps.timing ? deps.now() : 0;
    metric('decision', observation, {
      edge: 'start',
      line: item.line,
      ...(check && step ? { nextLine: step.line } : {}),
    });
    if (initial) metric('cache-reuse', observation, { line: item.line });
    let decision: ScreenDecision;
    let accepted = false;
    try {
      try {
        decision =
          initial ??
          (await decideScreen(
            observation.screen,
            judge,
            check,
            step,
            privacy.modelValues(),
            privacy,
            observationDeadline(observation.timing, deadline),
            deps.diagnostic !== undefined,
          ));
      } catch (error) {
        if (isAbort(error)) throw error;
        assertActive();
        if (error instanceof JevError && error.code === 'JEV_DEADLINE_EXCEEDED') {
          metric('expiry', observation, { outcome: 'failed' });
          const itemExpired = deps.now() >= deadline;
          diagnostic(
            item,
            observation,
            'decision',
            itemExpired ? 'ITEM_DEADLINE_EXCEEDED' : 'EVIDENCE_EXPIRED',
          );
          throw new EvidenceExpired(itemExpired);
        }
        throw error;
      }
      if (typeof decision.check === 'object') {
        assertActive();
        if (decision.check.diagnostic)
          diagnostic(
            item,
            observation,
            'decision',
            'SCREEN_EVIDENCE_INCOMPLETE',
            undefined,
            decision.check.diagnostic,
          );
        throw new ResolutionError(decision.check);
      }
      if (decision.target && 'refuse' in decision.target && decision.target.diagnostic)
        diagnostic(
          item,
          observation,
          'decision',
          'SCREEN_EVIDENCE_INCOMPLETE',
          undefined,
          decision.target.diagnostic,
        );
      usable(observation, item, deadline);
      diagnostic(item, observation, 'decision', 'ACCEPTED');
      accepted = true;
      return decision;
    } finally {
      if (deps.timing)
        metric('decision', observation, {
          edge: 'end',
          line: item.line,
          outcome: accepted ? 'ok' : 'failed',
          ms: deps.now() - started,
        });
    }
  };
  let dispatchStarted: number | undefined;
  const observeRowSettle = (result: ActResult): void => {
    if (deps.rowSettle && result.settle)
      observeTiming(deps.rowSettle, {
        ...result.settle,
        stage: 'settle',
        edge: 'end',
        outcome: 'ok',
        at: deps.now(),
      });
  };
  const mutate = async (
    item: Item,
    observation: Observation,
    send: (context: QaDispatchContext) => Promise<ActResult>,
    deadline = Infinity,
    owner: 'step' | 'recovery' = 'step',
  ): Promise<ActResult> => {
    const preparedAt = deps.timing ? deps.now() : 0;
    dispatchStarted = deps.timing ? preparedAt : undefined;
    metric('mutation', observation, { edge: 'start' });
    let completed = false;
    const context = new (class extends QaDispatchContext {
      override authorize(): void {
        super.authorize();
        mutationStarted = true;
        if (owner === 'step') stepDispatched = true;
        diagnostic(item, observation, 'dispatch', 'ACCEPTED', this.authorizations);
        if (deps.timing)
          metric('authorization', observation, {
            count: this.authorizations,
            ms: deps.now() - preparedAt,
          });
        super.check();
        dispatchedOn = observation.id;
      }
    })(observationDeadline(observation.timing, deadline), deps.now, deps.cancelled, item.line);
    try {
      context.check();
      if (item.kind === 'fill') privacy.didFill(fillText(item));
      // A scroll step's momentum outlives the step and its block; the next targeted dispatch settles first.
      if (item.kind === 'scroll') sequence.momentum = true;
      const result = await send(context);
      observeRowSettle(result);
      if (result.entryMismatch) fillMismatch = result.entryMismatch;
      context.assertComplete();
      diagnostic(item, observation, 'dispatch', 'COMPLETED', context.authorizations);
      completed = true;
      return result;
    } catch (error) {
      if (isAbort(error)) throw error;
      if (context.refusal || error instanceof QaDispatchError) {
        const refusal = context.refusal ?? (error as QaDispatchError);
        if (refusal.code === 'EVIDENCE_EXPIRED')
          metric('expiry', observation, { outcome: 'failed' });
        const itemExpired = deps.now() >= deadline;
        diagnostic(
          item,
          observation,
          'dispatch',
          context.authorizations
            ? 'ACTION_INTERRUPTED'
            : refusal.code === 'EVIDENCE_EXPIRED' && itemExpired
              ? 'ITEM_DEADLINE_EXCEEDED'
              : refusal.code,
          context.authorizations,
          undefined,
          context.refusalDiagnostic,
        );
        if (refusal.code === 'EVIDENCE_EXPIRED' && context.authorizations === 0)
          throw new EvidenceExpired(itemExpired);
        throw new QaDispatchError(
          !context.authorizations || refusal.code === 'RUN_CANCELLED'
            ? refusal.code
            : context.refusedBeforeMutation
              ? 'TARGET_MOVED_BEFORE_DISPATCH'
              : 'ACTION_OUTCOME_UNCERTAIN',
        );
      }
      throw error;
    } finally {
      if (deps.timing)
        metric('mutation', observation, {
          edge: 'end',
          outcome: completed ? 'ok' : 'failed',
          count: context.authorizations,
          ms: deps.now() - preparedAt,
        });
    }
  };
  let shots = shotIndex;
  const operationFor = (line: number): number => {
    let operationId = operations.get(line);
    if (operationId === undefined) {
      operationId = sequence.operation = (sequence.operation ?? 0) + 1;
      operations.set(line, operationId);
    }
    return operationId;
  };
  const scrollBands = new Map<number, LedgerRow['scrollBand']>();
  const bandFor = (item: Item, target: Target, screen: Screen) =>
    scrollUntilBand(target, screen, (receipt) => scrollBands.set(item.line, receipt));
  const overlayRows = new Map<number, { observation: number; checks: OverlayHitReceipt[] }>();
  const targetRows = new Map<
    number,
    Pick<LedgerRow, 'collapsed' | 'candidateExclusions' | 'coveredBy'>
  >();
  // Why the latest observation of a line named no cover.
  const coverGaps = new Map<number, WalkerCoverGap>();
  // The target whose cover the ordinary capture could not prove; one presence recapture may prove it.
  const coverTargets = new Map<number, Element>();
  const recordCover = (
    line: number,
    cover: ReturnType<typeof coverOwner> | { gap: WalkerCoverGap } | undefined,
  ): void => {
    // Each observation states its own cover, or why none is named.
    const { coveredBy: _previous, ...facts } = targetRows.get(line) ?? {};
    coverGaps.delete(line);
    if (cover && 'gap' in cover) coverGaps.set(line, cover.gap);
    targetRows.set(line, {
      ...facts,
      ...(cover && 'owner' in cover
        ? {
            coveredBy: {
              ref: cover.owner.ref,
              kind: cover.owner.kind,
              frame: cover.frame,
              ...(isDeclineLabel(cover.owner.label) ? { label: cover.owner.label } : {}),
            },
          }
        : {}),
    });
  };
  // A covered iOS refusal whose ordinary capture could not tie React hosts to native nodes takes the
  // one presence recapture; whatever it fails to prove stays unproven and never adds a refusal.
  const proveCover = async (item: Exclude<Item, { kind: 'check' }>): Promise<void> => {
    const target = coverTargets.get(item.line);
    coverTargets.delete(item.line);
    if (deps.platform !== 'ios' || !target || coverGaps.get(item.line) !== 'no-native-presence')
      return;
    let proven: Observation | undefined;
    try {
      proven = await presenceRecapture(item);
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    if (!proven) {
      coverGaps.set(item.line, 'presence-recapture-incomplete');
      return;
    }
    const matches = proven.screen.elements.filter((e) => sameIdentity(e, target));
    recordCover(
      item.line,
      matches.length === 1
        ? coverOwner(matches[0], proven.screen)
        : { gap: 'target-not-recaptured' },
    );
  };
  // A covered refusal that emits no other decision diagnostic still says why its cover was or was not
  // named; a line whose cover was never looked up emits nothing.
  const coverDecision = (
    item: Item,
    observation: Observation,
    facts: Omit<NonNullable<WalkerTimingDiagnostic['clearanceDiagnostic']>, 'coverGap'>,
  ): void => {
    if (!coverGaps.has(item.line) && !targetRows.get(item.line)?.coveredBy) return;
    diagnostic(item, observation, 'decision', 'CENTRE_COVERED', undefined, undefined, undefined, {
      ...facts,
      coverGap: coverGaps.get(item.line) ?? null,
    });
  };
  // The proven cover for a refusal, as kind and frame, or the evidence gap that withheld it.
  const coverText = async (item: Exclude<Item, { kind: 'check' }>): Promise<string> => {
    await proveCover(item);
    const line = item.line;
    const cover = targetRows.get(line)?.coveredBy;
    if (cover)
      return `; covered by ${cover.kind} at ${[cover.frame.x, cover.frame.y, cover.frame.width, cover.frame.height].join(',')}`;
    const gap = coverGaps.get(line);
    return gap ? `; no cover named (${gap})` : '';
  };
  const withheldRows = new Map<number, NonNullable<LedgerRow['screenshotWithheld']>>();
  // Per line, what interruption recovery last decided; a dismissal stays on this line's later rows.
  const interruptions = new Map<number, InterruptionReceipt>();
  const emit = (row: WalkRow): void => {
    if (row.line === activeItem?.line && postActionDevError)
      row = {
        ...row,
        devError: postActionDevError,
        ...(row.outcome === 'pass' && postActionDevError.afterAction
          ? {
              reason:
                'development overlay warning: dismissed once; the next native test ID appeared',
            }
          : {}),
      };
    const scrollBand = scrollBands.get(row.line);
    if (scrollBand) row = { ...row, scrollBand };
    const interruption = interruptions.get(row.line);
    // A veto on an earlier attempt says nothing about a pass; a dismissal explains it.
    if (interruption && (row.outcome !== 'pass' || interruption.outcome === 'dismissed'))
      row = { ...row, interruption };
    row = { ...row, ...targetRows.get(row.line) };
    const overlayChecks = overlayRows.get(row.line)?.checks;
    if (overlayChecks?.length) row = { ...row, overlayChecks };
    if (fillHandlerRefused)
      row = {
        ...row,
        reason: [
          ...(row.reason ? [...segments(row.reason), '; '] : []),
          'FILL_HANDLER_REFUSED: rung 3 was attempted and refused without mutation',
        ],
      };
    const withheld = withheldRows.get(row.line);
    withheldRows.delete(row.line);
    if (withheld) row = { ...row, screenshotWithheld: withheld };
    const reactCoverage = reactGaps.get(row.line);
    row = {
      ...row,
      ...(fillMethod ? { method: fillMethod } : {}),
      ...(keyboardCleared ? { keyboardCleared } : {}),
      ...(implicitWaitMs !== undefined ? { implicitWaitMs } : {}),
      ...(fillMismatch && row.outcome !== 'pass' ? { entryMismatch: fillMismatch } : {}),
      operationId: operationFor(row.line),
      ...(reactCoverage ? { reactCoverage } : {}),
      ...(reactCoverage || reactConnections.length ? { reactConnections } : {}),
    };
    reactConnections = [];
    let timing: RowTiming | undefined;
    try {
      timing = deps.rowTiming?.(row.t);
    } catch (error) {
      if (isAbort(error)) throw error;
      // Row timing is passive; the row is recorded without it.
    }
    const timed = timing ? { ...row, timing } : row;
    if (row.outcome === 'pass' && !opts.login) {
      sequence.planPassed = true;
      const press = sequence.plannedPress;
      if (
        opts.recover !== false &&
        press &&
        press.line !== row.line &&
        (captured.get(latest)?.id ?? 0) > itemObservationStart
      ) {
        if (protectionLapses(latest)) sequence.plannedPress = undefined;
        else press.passedSince = true;
      }
      if (
        opts.recover !== false &&
        block.items.some((item) => item.line === row.line && item.kind === 'press')
      )
        sequence.plannedPress = {
          ...plannedSurface(latest, pressBase),
          line: row.line,
          ...(pressDispatch ? { record: pressDispatch } : {}),
        };
    }
    rows.push(timed);
    deps.row(valueFree(timed));
  };
  const redact = (text: string): string => privacy.redact(text);
  // A stored selector is written to the action file, so it must not carry a protected value.
  const stored = (selector: Selector | undefined): { selector?: Selector } => {
    const value = selector?.id ?? selector?.text;
    return selector &&
      value !== undefined &&
      !matchPrivate(value, privacy.privateSet('persisted'), 'persisted').hit
      ? { selector }
      : {};
  };
  const exactSelector = (target: Target): Selector | undefined =>
    target.exact === 'id'
      ? { id: target.quoted }
      : target.exact === 'text'
        ? { text: target.quoted }
        : undefined;
  const targetSelector = (target: Target, observation: Observation) =>
    stored(visibleSelector(target, observation.screen, observation.overlayHits));
  const base = (item: Item, attempt: number): Omit<LedgerRow, 'outcome'> => ({
    block: block.slug,
    line: item.line,
    text: projectPlanLine(item.raw, privacy.privateSet()).text,
    attempt,
    kind: item.kind === 'check' ? 'check' : 'step',
    resolvedBy,
    t: deps.now(),
  });
  const failed = (
    item: Item,
    attempt: number,
    reason: Reason,
    screen: Screen,
    screenshot: string | undefined,
    ref?: string,
    miss = false,
    // The refusal code when a step failed on its target; false when the walk ended for another cause.
    targetCode?: string | false,
    devError?: LedgerRow['devError'],
  ): WalkOutcome => {
    const notes = [
      ...new Set(
        (overlayRows.get(item.line)?.checks ?? []).map(({ liveHit }) => hitProbeNote(liveHit)),
      ),
    ].join('');
    if (notes) reason = [...segments(reason), notes];
    const target = item.kind === 'check' ? undefined : stepTarget(item);
    if (target?.quoted !== undefined) emitQuotedTargetDiagnostic(screen, target.quoted, item.line);
    const row = base(item, attempt);
    const rejectedCheck = item.kind === 'check' && interruptions.has(item.line);
    const last = targetCode || rejectedCheck ? (newest ?? screen) : screen;
    const waitOrScroll = item.kind === 'wait' || item.kind === 'scroll';
    let lastScreen: Pick<LedgerFailure, 'screen' | 'suggestion' | 'subreason'> = {};
    if (item.kind !== 'check' && target && (waitOrScroll || targetCode)) {
      try {
        const diagnostic = targetMissDiagnostic(
          target,
          screen,
          item.line,
          item.kind === 'scroll',
          privacy,
          item.kind,
        );
        if (waitOrScroll) {
          if (
            !miss &&
            !(item.kind === 'wait' && item.precondition) &&
            diagnostic.reason !== 'evidence-incomplete'
          ) {
            const detail = `; target visibility: ${diagnostic.reason}`;
            reason = typeof reason === 'string' ? reason + detail : [...segments(reason), detail];
          }
          deps.targetMiss?.(diagnostic);
        }
        const pairingGap = placeholderPairingGap(target, last, item.kind);
        if (pairingGap) {
          const detail = `; placeholder pairing was unavailable because React coverage on this screen is ${pairingGap}; target the field by test id`;
          reason = typeof reason === 'string' ? reason + detail : [...segments(reason), detail];
        }
        const seen = captured.get(last);
        if (seen && targetCode) {
          const lastReason =
            last === screen
              ? diagnostic.reason
              : targetMissDiagnostic(
                  target,
                  last,
                  item.line,
                  item.kind === 'scroll',
                  privacy,
                  item.kind,
                ).reason;
          const now = screenNow(
            last,
            target,
            row.t - seen.at,
            dispatchedOn === seen.id,
            privacy,
            item.kind,
          );
          const ambiguous =
            targetCode === 'TARGET_AMBIGUOUS' &&
            exactIdentities(last, target, item.kind).filter(
              ({ element }) => !element.offscreen && !element.ref.startsWith('react:'),
            ).length > 1;
          const subreason = ambiguous ? 'ambiguous' : lastReason;
          lastScreen = {
            screen: now,
            suggestion:
              // A more specific diagnosis, such as a placeholder coverage gap, keeps its own advice.
              targetCode === LAUNCH_MISS && subreason === 'absent' && target.quoted !== undefined
                ? launchMissSuggestion(
                    privacy.redact(target.quoted),
                    item.line,
                    block.items
                      .slice(0, block.items.indexOf(item))
                      .reverse()
                      .find((earlier) => earlier.kind === 'wait')?.line,
                  )
                : missSuggestion(subreason, target, last, now, item.line, item.kind),
            subreason,
          };
        }
      } catch {
        // Diagnostics cannot change the failed step's outcome.
      }
    }
    if (rejectedCheck) {
      try {
        const seen = captured.get(last);
        if (seen)
          lastScreen.screen = screenNow(
            last,
            recoveryTarget(item) ?? { phrase: '' },
            row.t - seen.at,
            dispatchedOn === seen.id,
            privacy,
            'wait',
          );
      } catch {}
    }
    if (pressVetoed === item && ((target && targetCode) || item.kind === 'check')) {
      // A check has no target diagnostics, so it keeps the note but no subreason.
      if (target)
        lastScreen = {
          ...(lastScreen.screen ? { screen: lastScreen.screen } : {}),
          subreason: 'previous-plan-press',
        };
      const press = sequence.plannedPress;
      reason = [
        ...segments(reason),
        press?.passedSince
          ? `; the planned press at line ${press.line} succeeded and later steps passed while a decline control stayed on screen; the next target was not found; automatic app dismissal was withheld`
          : PREVIOUS_PLAN_PRESS,
      ];
      const optIn = optInShaped(last);
      const decline =
        optIn ??
        (soleDecline(last)
          ? last.elements.find(
              (e) =>
                !e.offscreen &&
                !e.semantic?.nativePresence?.structural &&
                e.semantic?.press === 'supported',
            )
          : undefined);
      if (decline?.label && sequence.plannedPress?.line !== undefined) {
        const shape = optIn
          ? 'a permission opt-in with a decline and an accept control'
          : 'an app screen with only a decline control';
        reason = [
          ...segments(reason),
          `; ${shape} is in front; ${sequence.plannedPress.passedSince ? `the planned tap at line ${sequence.plannedPress.line}` : 'the previous planned tap'} may have opened it, so it was not dismissed`,
        ];
        const label = privacy.redactElementLabel(decline);
        lastScreen.suggestion =
          label === decline.label
            ? redact(`Add a step after line ${sequence.plannedPress.line}: Tap "${label}".`)
            : `Add a step after line ${sequence.plannedPress.line} that taps the decline control.`;
      }
    }
    const interruption = interruptions.get(item.line);
    if (interruption?.veto === 'later-target' && interruption.targetLine !== undefined)
      reason = [
        ...segments(reason),
        `; an app screen is in front; automatic app dismissal was withheld because the later planned item at line ${interruption.targetLine} may target it`,
      ];
    // A later step that names the decline owns it: suggest the plan edit that frees this step.
    if (interruption?.provenance === 'ownership' && interruption.targetLine !== undefined)
      lastScreen = {
        ...lastScreen,
        suggestion: `line ${interruption.targetLine} targets this control; if the interruption is optional, move that step before line ${item.line} or remove it`,
      };
    if (interruptionWithheld?.item === item)
      reason = [...segments(reason), interruptionWithheld.clause];
    const withheld = privacy.textWithheld(last);
    emit({
      ...row,
      ...(devError ? { devError } : {}),
      ...(ref ? { ref } : {}),
      ...(screenshot ? { screenshot } : {}),
      outcome: miss ? 'retry' : 'fail',
      reason: miss ? [...segments(reason), '; re-walking from this line'] : reason,
    });
    return {
      block: { key: block.slug, outcome: 'fail', source: 'discovered' },
      rows,
      ...(miss ? { miss: item.line } : {}),
      ...(privateFills.length ? { privateFills } : {}),
      ...(recoveries ? { recoveries } : {}),
      failure: {
        step: item.line,
        seen: [
          ...segments(reason),
          '; last observed on screen: ',
          {
            app: privacy.screenText(last).slice(0, 40).join(' | '),
            ...(withheld ? { withheld } : {}),
          },
        ],
        ...(screenshot ? { screenshot } : {}),
        ...lastScreen,
      },
    };
  };
  const withCause = (
    outcome: WalkOutcome,
    cause: NonNullable<LedgerFailure['cause']>,
  ): WalkOutcome =>
    outcome.failure ? { ...outcome, failure: { ...outcome.failure, cause } } : outcome;
  // The judged screen and any post-recovery capture must both show the app.
  const judged = (outcome: WalkOutcome, screen: Screen): WalkOutcome =>
    outcome.failure && screen.front === 'app' && latest.front === 'app'
      ? { ...outcome, failure: { ...outcome.failure, kind: 'step' } }
      : outcome;
  const shoot = async (item: Item): Promise<string | undefined> => {
    assertActive();
    const latch = privacy.screenshotLatch(deps.videoPolicy);
    if (latch) {
      recordMediaLatch(privacy, sequence, deps, line);
      metric('screenshot', undefined, {
        outcome: 'withheld',
        withheld: latch.reason,
        ...(latch.kind ? { kind: latch.kind } : {}),
        ...(latch.source ? { source: latch.source } : {}),
      });
      sequence.screenshots!.count += 1;
      withheldRows.set(item.line, latch.reason);
      return undefined;
    }
    if (sequence.captureUnknown || metadataOnly || latest.devError) {
      metric('screenshot', undefined, { outcome: 'withheld' });
      return undefined;
    }
    shots += 1;
    const started = deps.timing ? deps.now() : 0;
    metric('screenshot', undefined, { edge: 'start' });
    let shot: string | undefined;
    try {
      shot = await deps.screenshot(screenshotName(shots, item.line));
    } finally {
      if (deps.timing)
        metric('screenshot', undefined, {
          edge: 'end',
          outcome: shot ? 'ok' : 'failed',
          ms: deps.now() - started,
        });
    }
    assertActive();
    return shot;
  };
  // One read-only iOS live hit read inside the observation's expiry; a late or failed read is 'unavailable'.
  const readHit = async (
    item: Item,
    observation: Observation,
    element: Element,
    deadline = Infinity,
  ): Promise<HitProbeResult> => {
    const generation = observation.screen.nativeGeneration;
    const rect = elementFrame(element);
    if (deps.platform !== 'ios' || !deps.hitProbe || generation === undefined || !rect)
      return 'unavailable';
    const context = new QaDispatchContext(
      observationDeadline(observation.timing, deadline),
      deps.now,
      () => cancellationSignal()?.aborted === true,
      item.line,
    );
    const timedOut = new Error('hit-probe-deadline');
    try {
      const read = await withDeadline(
        performance.now() + Math.max(0, context.deadline - deps.now()),
        timedOut,
        () =>
          deps.hitProbe!(element.ref, context, generation, {
            identifier: element.testID,
            label: element.label,
            rect,
          }),
      );
      if (!context.expired) return read;
    } catch (error) {
      if (isAbort(error) || (error instanceof QaDispatchError && error.code === 'RUN_CANCELLED'))
        throw error;
    }
    return 'unavailable';
  };
  // Same-label duplicates left after proof: up to four the runner can identify get a live hit read.
  const probeDuplicates = async (
    item: Item & { kind: 'press' | 'fill' },
    observation: Observation,
    decided: Resolution,
  ): Promise<Resolution> => {
    if (!('refuse' in decided) || !decided.contenders) return decided;
    const screen = observation.screen;
    if (deps.platform !== 'ios' || !deps.hitProbe || screen.nativeGeneration === undefined)
      return decided;
    const contenders = decided.contenders.flatMap((ref) =>
      screen.elements.filter((element) => element.ref === ref),
    );
    if (contenders.some((element) => !probeIdentifiable(element, screen) || !elementFrame(element)))
      return {
        ...decided,
        reason: `${decided.reason}; cannot probe: the runner cannot identify each candidate uniquely`,
      };
    const exclusions: CandidateExclusion[] = [...(decided.candidateExclusions ?? [])];
    for (const element of contenders.slice(0, MAX_HIT_PROBES)) {
      // A read that would outlive the observation never runs.
      if (deps.now() >= observationDeadline(observation.timing)) break;
      if (nestedCandidate(element, contenders)) continue;
      if ((await readHit(item, observation, element)) === 'not-hittable')
        exclusions.push(excludedCandidate(element, 'not-hittable'));
    }
    if (exclusions.length === (decided.candidateExclusions?.length ?? 0)) return decided;
    return contend(
      item,
      screen,
      contenders.filter((element) => !exclusions.some((x) => x.ref === element.ref)),
      exclusions,
      decided.collapsed,
    );
  };
  const probeOverlay = async (
    item: Item,
    observation: Observation,
    element: Element,
    deadline = Infinity,
  ): Promise<HitProbeResult> => {
    const facts = inferredOverlayCoverage(element, observation.screen);
    if (!facts) return 'unavailable';
    const hits = (observation.overlayHits ??= new OverlayHits(observation.screen));
    const cached = hits.get(element, observation.screen);
    if (cached) return cached;
    const result = overlayProbeCoverage(element, observation.screen)
      ? await readHit(item, observation, element, deadline)
      : 'unavailable';
    hits.set(element, result);
    let row = overlayRows.get(item.line);
    if (row?.observation !== observation.id) {
      row = { observation: observation.id, checks: [] };
      overlayRows.set(item.line, row);
    }
    row.checks.push({ observation: observation.id, liveHit: result, predicate: facts });
    return result;
  };
  const visibilityProbe = (
    item: Item & { kind: 'wait' | 'scroll' },
    deadline = Infinity,
    checkObservation?: (screen: Screen) => void,
  ) => {
    let reasks = 0;
    return async (
      observation: Observation,
      initial?: ScreenDecision,
    ): Promise<{ observation: Observation; found: boolean; unsure?: boolean }> => {
      let decision = initial;
      while (deps.now() < deadline) {
        checkObservation?.(observation.screen);
        if (overlayRows.get(item.line)?.observation !== observation.id)
          overlayRows.delete(item.line);
        try {
          if (deps.platform === 'ios') {
            const target = item.kind === 'wait' ? item.target : item.until!;
            for (const element of overlayProbeCandidates(target, observation.screen))
              await probeOverlay(item, observation, element, deadline);
          }
          decision = await decide(observation, undefined, item, deadline, decision);
          if (
            item.kind === 'scroll' &&
            decision.visibility &&
            'verdict' in decision.visibility &&
            decision.visibility.verdict === 'present'
          ) {
            const elements = observation.screen.elements.filter(
              (element) =>
                !scrollTargetCovered(element, observation.screen, observation.overlayHits),
            );
            if (elements.length !== observation.screen.elements.length)
              decision = await decide(
                { ...observation, screen: { ...observation.screen, elements } },
                undefined,
                item,
                deadline,
              );
          }
        } catch (error) {
          if (isAbort(error)) throw error;
          if (!(error instanceof EvidenceExpired)) throw error;
          if (error.itemExpired) throw error;
          metric('refresh', observation);
          await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
          if (deps.now() >= deadline) throw new EvidenceExpired(true);
          observation = await captureOnce(item, false, false, 'resolve', deadline);
          decision = undefined;
          continue;
        }
        const target = item.kind === 'wait' ? item.target : item.until!;
        if (target.quoted !== undefined) {
          const evidence = targetEvidence(target, observation.screen, observation.overlayHits);
          if (
            evidence !== 'pass' &&
            aggregateTargetVisible(target, observation.screen, observation.overlayHits)
          ) {
            try {
              deps.labelProvenanceDiagnostic?.({
                kind: 'label-provenance',
                line: item.line,
                ...unavailableProvenance(),
                requested: false,
                resolvedBy: 'aggregate-visibility',
              });
            } catch {}
            return { observation, found: true };
          }
          const scrollEvidence =
            item.kind === 'scroll'
              ? scrollUntilEvidence(target, observation.screen, observation.overlayHits)
              : evidence;
          return {
            observation,
            found: scrollEvidence === 'pass',
            unsure: scrollEvidence === 'unsure',
          };
        }
        const visibility = decision.visibility;
        if (!visibility)
          throw new ResolutionError({
            refuse: 'VISIBILITY_MISSING',
            reason: 'the screen decision contains no visibility judgment',
          });
        if ('refuse' in visibility) {
          if (visibility.diagnostic)
            diagnostic(
              item,
              observation,
              'decision',
              'SCREEN_EVIDENCE_INCOMPLETE',
              undefined,
              visibility.diagnostic,
            );
          throw new ResolutionError(visibility);
        }
        if (visibility.verdict === 'present') return { observation, found: true };
        if (visibility.verdict === 'absent') return { observation, found: false };
        if (visibility.verdict === 'pending' && item.kind === 'wait')
          return { observation, found: false };
        const remaining = deadline - deps.now();
        if (reasks >= CHECK.reasks || remaining <= 0) break;
        reasks += 1;
        metric('reask', observation);
        await pause(Math.min(WAIT_POLL_MS, remaining));
        if (deps.now() >= deadline) break;
        observation = await captureOnce(item, false, false, 'resolve', deadline);
        decision = undefined;
      }
      usable(observation, item, deadline);
      throw new ResolutionError({
        refuse: 'VISIBILITY_UNSURE',
        reason: 'visibility remained uncertain within the available re-ask budget',
      });
    };
  };
  const focusProven = async (path: 'tap' | 'none', testID: string): Promise<boolean> => {
    let focused = false;
    try {
      focused = (await deps.reactFocused!(testID)) === true;
    } catch (error) {
      if (isAbort(error)) throw error;
      focused = false;
    }
    const at = deps.now();
    observeTiming(deps.timing, {
      stage: 'keyboard',
      edge: 'point',
      outcome: focused ? 'ok' : 'failed',
      at,
      ...(path === 'tap' && dispatchStarted !== undefined ? { ms: at - dispatchStarted } : {}),
      keyboard: true,
      proof: focused ? 'focused' : 'not-proven',
    });
    deps.note?.(
      `fallback-focus ${JSON.stringify({ v: 1, path, keyboard: true, proof: focused ? 'focused' : 'not-proven' })}`,
    );
    return focused;
  };
  const focusedReason = (quoted: string) =>
    `UNVERIFIED_FILL: typed with the keyboard into the field React reports focused ("${quoted}"); its final value was not validated`;
  // Counts travel as numbers beside the reason: masking a private value may mask any digit in the text.
  const keptNote = (entry: ActResult) =>
    entry.kept
      ? '; the field kept the same shorter value on every attempt'
      : entry.caseNormalized
        ? '; the field changed only the letter case'
        : '';
  const keptCounts = (entry: ActResult) =>
    entry.proven || currentInputs()?.hasStrictInputs
      ? {}
      : entry.kept
        ? { kept: { typed: entry.kept.typed, observed: [...entry.kept.observed] } }
        : entry.caseNormalized
          ? { caseNormalized: { chars: entry.caseNormalized.chars } }
          : {};
  // Fill ladder: one automatic step to rung 3 after a typing refusal that left the field in a known state.
  const stepUpFill = async (
    item: Item & { kind: 'fill' },
    failure: ActResult,
    testID: string | undefined,
    present: (screen: Screen) => boolean,
  ): Promise<ActResult | undefined> => {
    const deadline = itemStartedAt + FILL_LADDER_BUDGET_MS;
    if (
      fillHandlerAttempted ||
      !deps.setByHandler ||
      !testID ||
      failure.ok ||
      failure.ambiguous ||
      !failure.error?.startsWith('TEXT_ENTRY_UNVERIFIED') ||
      (failure.mutation !== 'none' && failure.mutation !== 'observed') ||
      deps.now() >= deadline
    )
      return undefined;
    const fresh = await settledCapture(item);
    usable(fresh, item);
    if (!present(fresh.screen)) return undefined;
    secretFill(
      item,
      fresh.screen.elements.find((element) => element.testID === testID),
    );
    try {
      const result = await mutate(
        item,
        fresh,
        (context) => {
          fillHandlerAttempted = true;
          return deps.setByHandler!(testID, fillText(item), context, secretFill(item), () =>
            promoteFill(item, testID),
          );
        },
        deadline,
      );
      deps.note?.(
        `fill-ladder ${JSON.stringify({ v: 1, line: item.line, from: failure.method ?? 'keyboard', to: 'set-handler', ok: result.ok, mutation: result.mutation ?? null })}`,
      );
      if (!result.ok && result.mutation === 'none') {
        fillHandlerRefused = true;
        return undefined;
      }
      fillMethod = 'set-handler';
      return { ...result, method: 'set-handler' };
    } catch (error) {
      if (error instanceof EvidenceExpired) return undefined;
      throw error;
    }
  };
  const methodQualifier = (item: Item & { kind: 'fill' }): string | undefined =>
    fillMethod === 'set-handler' && !item.anyMethod
      ? "FILL_SET_BY_HANDLER: the value was set through the input's change handler, not typed; label the step (any method) to count it as proof"
      : undefined;
  const handlerReason = (item: Item & { kind: 'fill' }, entry: ActResult): string | undefined => {
    if (fillMethod !== 'set-handler') return undefined;
    const qualifier = methodQualifier(item);
    if (entry.proven) return qualifier;
    const unverified =
      'UNVERIFIED_FILL: set through the change handler; its final value could not be validated';
    return qualifier ? `${unverified}; ${qualifier}` : unverified;
  };
  // Best effort: the field is not an observable native input, so only the tap and the keyboard prove anything.
  const keyboardFallback = async (
    item: Item & { kind: 'fill' },
    attempt: number,
    before: Observation,
    target: { element: Element; oracleTestID: string },
    scrolled = false,
  ): Promise<
    | WalkOutcome
    | {
        ref: string;
        element: Element;
        observation: Observation;
        identity: string;
        scrolled: boolean;
      }
    | 'typed'
  > => {
    const quoted = item.target.quoted!;
    secretFill(item, target.element);
    const nothingTyped = (reason: string, screen: Screen, targetCode?: string): WalkOutcome =>
      failed(
        item,
        attempt,
        `${reason}; nothing was typed`,
        screen,
        undefined,
        undefined,
        false,
        targetCode,
      );
    const proofMode = before.screen.keyboardVisible === true && deps.reactFocused !== undefined;
    if (before.screen.keyboardVisible !== false && !proofMode)
      return nothingTyped(
        before.screen.keyboardVisible
          ? `the keyboard is already up before tapping "${quoted}"`
          : `the keyboard state before tapping "${quoted}" is unknown`,
        before.screen,
      );
    privacy.concealFallback(
      fillText(item),
      false,
      quoted,
      target.element.testID ?? target.element.label,
    );
    recordMediaLatch(privacy, sequence, deps, line);
    if (item.input === undefined && !privateFills.includes(item.line)) privateFills.push(item.line);
    let tap: ActResult | undefined;
    const overlay =
      deps.platform === 'ios' && inferredOverlayCoverage(target.element, before.screen);
    if (overlay && (await probeOverlay(item, before, target.element)) !== 'hittable')
      return nothingTyped(
        `"${quoted}" ${INFERRED_FILL_UNAVAILABLE}${cutterText(overlay)}`,
        before.screen,
        'TARGET_NOT_FOUND',
      );
    if (overlay || !centreCovered(target.element, before.screen))
      try {
        const hosts = before.screen.reactHostEvidence;
        const inputs = hosts?.hosts.filter(
          (host) =>
            host.capabilities.fill &&
            (host.testID === target.oracleTestID || host.nativeID === target.oracleTestID),
        );
        if (
          !item.alwaysRetype &&
          deps.fillAlreadySet &&
          target.oracleTestID === item.target.quoted &&
          hosts?.complete &&
          inputs?.length === 1 &&
          !inputs[0].hidden &&
          !inputs[0].disabled &&
          !inputs[0].readOnly &&
          fillHostInside(before.screen, target.oracleTestID, target.element.testID)
        ) {
          let alreadySet = false;
          try {
            alreadySet = await deps.fillAlreadySet(
              target.oracleTestID,
              fillText(item),
              secretFill(item, target.element),
              () => promoteFill(item, target.element.testID ?? target.oracleTestID),
            );
          } catch (error) {
            if (isAbort(error)) throw error;
          }
          if (alreadySet) {
            currentInputs()?.expectEcho(target.element.testID ?? target.oracleTestID, item.input);
            fillMethod = 'already-set';
            emit({
              ...base(item, attempt),
              ref: target.element.ref,
              ...stored({ id: target.oracleTestID }),
              outcome: 'pass',
            });
            return 'typed';
          }
        }
        tap = await mutate(item, before, (context) =>
          overlay
            ? deps.press(target.element.ref, context, { requireLiveHit: true })
            : deps.press(target.element.ref, context),
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof EvidenceExpired)
          return nothingTyped(`the evidence expired before tapping "${quoted}"`, before.screen);
        throw error;
      }
    if (overlay && tap && !tap.ok)
      return nothingTyped(
        `${tap.error ?? 'LIVE_HIT_UNPROVEN'}${cutterText(overlay)}`,
        before.screen,
        'TARGET_NOT_FOUND',
      );
    if (
      !tap ||
      (!tap.ok && tap.mutation === 'none' && tap.error?.startsWith('FOCUS_TARGET_OCCLUDED:'))
    ) {
      if (scrolled)
        return nothingTyped(
          tap
            ? `${tap.error}; "${quoted}" stayed off screen after one scroll`
            : `"${quoted}" stayed off screen after one scroll: its centre is past the visible area or under the keyboard`,
          before.screen,
          'TARGET_NOT_FOUND',
        );
      const scroll = await mutate(item, before, (context) =>
        deps.scroll(
          clearanceScroll(target.element, before.screen),
          context,
          keyboardClearance(target.element, before.screen),
          clearanceBand(target.element, before.screen),
        ),
      );
      const afterScroll = await settledCapture(item);
      usable(afterScroll, item);
      const rebound = bindDispatchIdentity(
        { ...item, kind: 'press' },
        afterScroll.screen,
        target.element,
      );
      if (!scroll.ok || !('ref' in rebound))
        return nothingTyped(
          'TARGET_NOT_FOUND: the refused wrapper stayed off screen after one scroll',
          afterScroll.screen,
          'TARGET_NOT_FOUND',
        );
      return keyboardFallback(
        item,
        attempt,
        afterScroll,
        { ...target, element: rebound.element },
        true,
      );
    }
    if (!tap.ok)
      return nothingTyped(
        `${tap.error ?? 'the tap was not dispatched'}; tapping "${quoted}" failed`,
        before.screen,
        tap.ambiguous ? 'TARGET_AMBIGUOUS' : undefined,
      );
    const readyBy = deps.now() + KEYBOARD_READY_MS;
    let after = await settledCapture(item);
    const bound = () => bindFillIdentity(item, after.screen, target.oracleTestID);
    const waitForKeyboard = async (skipWait: boolean, deadline: number) => {
      for (
        let captures = 1;
        !skipWait &&
        after.screen.keyboardVisible !== true &&
        bound()?.kind !== 'strict' &&
        captures < KEYBOARD_READY_CAPTURES &&
        deps.now() < deadline;
        captures += 1
      ) {
        await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
        after = await settledCapture(item);
      }
    };
    await waitForKeyboard(proofMode, readyBy);
    let binding = bound();
    if (binding?.kind === 'strict')
      return { ...binding.strict, observation: after, identity: target.oracleTestID, scrolled };
    let refocused = false;
    if (
      after.screen.keyboardVisible !== true &&
      deps.platform !== 'android' &&
      deps.reactFocused &&
      deps.blurFocusedInput
    ) {
      let focused = false;
      try {
        focused = (await deps.reactFocused(target.oracleTestID)) === true;
      } catch (error) {
        if (isAbort(error)) throw error;
      }
      if (focused) {
        let blurred = false;
        try {
          try {
            await mutate(item, after, async (context) => {
              blurred = await deps.blurFocusedInput!(context);
              return { ok: true, proven: false };
            });
          } catch (error) {
            if (
              isAbort(error) ||
              error instanceof EvidenceExpired ||
              error instanceof QaDispatchError
            )
              throw error;
            return nothingTyped(`tapping "${quoted}" raised no keyboard`, after.screen);
          }
          if (!blurred)
            return nothingTyped(
              `tapping "${quoted}" raised no keyboard; the focused field could not be blurred`,
              after.screen,
            );
          after = await settledCapture(item);
          usable(after, item);
          const rebound = bindDispatchIdentity(
            { ...item, kind: 'press' },
            after.screen,
            target.element,
          );
          if (!('ref' in rebound))
            return nothingTyped(
              'TARGET_NOT_FOUND: the focused field no longer resolves uniquely after blur',
              after.screen,
              'TARGET_NOT_FOUND',
            );
          const retryOverlay =
            deps.platform === 'ios' && inferredOverlayCoverage(rebound.element, after.screen);
          if (retryOverlay && (await probeOverlay(item, after, rebound.element)) !== 'hittable')
            return nothingTyped(
              `"${quoted}" ${INFERRED_FILL_UNAVAILABLE}${cutterText(retryOverlay)}`,
              after.screen,
              'TARGET_NOT_FOUND',
            );
          const retap = await mutate(item, after, (context) =>
            retryOverlay
              ? deps.press(rebound.ref, context, { requireLiveHit: true })
              : deps.press(rebound.ref, context),
          );
          if (!retap.ok)
            return nothingTyped(
              `${retap.error ?? 'the tap was not dispatched'}; tapping "${quoted}" failed`,
              after.screen,
              retap.ambiguous ? 'TARGET_AMBIGUOUS' : undefined,
            );
          refocused = true;
          const retryReadyBy = deps.now() + KEYBOARD_READY_MS;
          after = await settledCapture(item);
          await waitForKeyboard(false, retryReadyBy);
          binding = bound();
        } finally {
          deps.note?.(
            `keyboard-refocus ${JSON.stringify({ v: 1, line: item.line, focused: true, blurred, raised: refocused && after.screen.keyboardVisible === true })}`,
          );
        }
      }
    }
    if (binding?.kind === 'strict')
      return { ...binding.strict, observation: after, identity: target.oracleTestID, scrolled };
    if (after.screen.keyboardVisible !== true)
      return nothingTyped(
        refocused
          ? 'focus was reported after the first tap and the keyboard stayed hidden after a blur and a second tap'
          : `tapping "${quoted}" raised no keyboard`,
        after.screen,
      );
    const again = binding?.kind === 'fallback' ? binding.fallback : undefined;
    if (!again)
      return nothingTyped(
        `the tap on "${quoted}" changed the screen`,
        after.screen,
        'TARGET_NOT_FOUND',
      );
    if (proofMode && !(await focusProven('tap', again.oracleTestID)))
      return nothingTyped(
        `the keyboard was already up and focus on "${quoted}" is not proven`,
        after.screen,
      );
    let entry: ActResult;
    currentInputs()?.expectEcho(again.element.testID ?? again.oracleTestID, item.input);
    try {
      entry = await mutate(item, after, (context) =>
        deps.typeFocused!(
          again.element.ref,
          fillText(item),
          again.oracleTestID,
          context,
          proofMode,
          secretFill(item, again.element),
          () => promoteFill(item, again.element.testID ?? again.oracleTestID),
          item.alwaysRetype,
        ),
      );
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof EvidenceExpired)
        return nothingTyped(
          `the evidence expired before typing after tapping "${quoted}"`,
          after.screen,
        );
      throw error;
    }
    fillMethod = entry.method ?? 'keyboard';
    entry =
      (await stepUpFill(
        item,
        entry,
        again.oracleTestID,
        (screen) => bindFillIdentity(item, screen, again.oracleTestID) !== undefined,
      )) ?? entry;
    if (!entry.ok)
      return failed(
        item,
        attempt,
        `${entry.error ?? 'typing was not dispatched'}; typing after tapping "${quoted}" was not retried`,
        after.screen,
        undefined,
      );
    await capture(item);
    const reason =
      handlerReason(item, entry) ??
      (entry.proven
        ? undefined
        : (proofMode
            ? focusedReason(quoted)
            : `UNVERIFIED_FILL: typed with the keyboard after tapping "${quoted}"; the field is not an observable native input, so its final value was not validated`) +
          keptNote(entry));
    emit({
      ...base(item, attempt),
      ref: again.element.ref,
      ...stored({ id: again.oracleTestID }),
      outcome: 'pass',
      ...keptCounts(entry),
      ...(reason ? { reason: redact(reason) } : {}),
    });
    return 'typed';
  };
  // Keyboard already up and no tappable target: type only into the field React reports focused.
  const typeIntoProvenFocus = async (
    item: Item & { kind: 'fill' },
    attempt: number,
    before: Observation,
  ): Promise<WalkOutcome | 'typed' | undefined> => {
    const quoted = item.target.quoted!;
    if (!quoted || /^@|^e\d+$/.test(quoted)) return;
    if (
      before.screen.elements.some(
        (e) => e.testID === quoted && (e.secure || e.semantic?.disabled === true),
      )
    )
      return;
    if (!(await focusProven('none', quoted))) return;
    secretFill(
      item,
      before.screen.elements.find((element) => element.testID === quoted),
    );
    privacy.concealFallback(fillText(item), false, quoted);
    recordMediaLatch(privacy, sequence, deps, line);
    if (item.input === undefined) privateFills.push(item.line);
    let entry: ActResult;
    currentInputs()?.expectEcho(quoted, item.input);
    try {
      entry = await mutate(item, before, (context) =>
        deps.typeFocused!(
          quoted,
          fillText(item),
          quoted,
          context,
          true,
          secretFill(item),
          () => promoteFill(item, quoted),
          item.alwaysRetype,
        ),
      );
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof EvidenceExpired)
        return failed(
          item,
          attempt,
          `the evidence expired before typing into "${quoted}"; nothing was typed`,
          before.screen,
          undefined,
        );
      throw error;
    }
    fillMethod = entry.method ?? 'keyboard';
    entry =
      (await stepUpFill(
        item,
        entry,
        quoted,
        (screen) =>
          !screen.elements.some(
            (e) => e.testID === quoted && (e.secure || e.semantic?.disabled === true),
          ),
      )) ?? entry;
    if (!entry.ok)
      return failed(
        item,
        attempt,
        `${entry.error ?? 'typing was not dispatched'}; typing into "${quoted}" was not retried`,
        before.screen,
        undefined,
      );
    await capture(item);
    const reason =
      handlerReason(item, entry) ??
      (entry.proven ? undefined : focusedReason(quoted) + keptNote(entry));
    emit({
      ...base(item, attempt),
      ...stored({ id: quoted }),
      outcome: 'pass',
      ...keptCounts(entry),
      ...(reason ? { reason: redact(reason) } : {}),
    });
    return 'typed';
  };
  // The login block walks with this walk's privacy, so its typed values stay masked.
  let loginReplayed = false;
  // The item whose recovery withheld an app dismissal because a planned press opened the screen.
  let pressVetoed: Item | undefined;
  // Explanations are local to this attempt, never part of the receipt or structured event.
  let interruptionWithheld: { item: Item; clause: string } | undefined;
  const optInWithheldClauses: Record<OptInWithheld, string> = {
    'private-or-unreadable-text':
      '; the opt-in text is private or unreadable, so nothing was dismissed',
    'consent-wording': '; the screen contains consent wording, so nothing was dismissed',
    'plan-names-control': '; the plan names a control on this screen, so nothing was dismissed',
    'react-control-in-front':
      '; a React control is not proven behind the presented modal, so nothing was dismissed',
    'tap-record-unknown': '; the previous tap record is unknown, so nothing was dismissed',
    'tap-was-answer': '; the previous tap was an opt-in answer, so nothing was dismissed',
    'same-control-before-tap':
      '; an opt-in control was present before the previous tap, so nothing was dismissed',
    'controls-unproven':
      '; the control evidence is incomplete or unknown, so nothing was dismissed',
    'not-an-opt-in': '; the screen is not a strict permission opt-in, so nothing was dismissed',
  };
  const replayLogin = async () => {
    const login = deps.login?.block;
    if (!login) {
      if (currentInputs()?.hasInputs) {
        try {
          deps.loginOutcome?.('fail');
        } catch {
          // Diagnostics cannot change login recovery.
        }
      }
      return 'fail' as const;
    }
    loginReplayed = true;
    sequence.window = undefined;
    sequence.plannedPress = undefined;
    pressVetoed = undefined;
    let taken = 0;
    const counted: WalkerDeps = {
      ...deps,
      captureScreen,
      screenshot: (name) => {
        taken += 1;
        return deps.screenshot(name);
      },
    };
    // Walk mode: a stale stored selector fails the login instead of asking for a re-walk.
    const nested = await walkBlock(login, counted, shots, typed, privacy, sequence, {
      recover: false,
      login: true,
    });
    shots += taken;
    separateRowOperations(nested.rows);
    rows.push(...nested.rows);
    if (nested.refusal) return { refuse: nested.refusal };
    if (nested.failure)
      return { fail: ['the login block did not pass: ', ...segments(nested.failure.seen)] };
    if (!sequence.planPassed) {
      privacy.startWindow();
      if (deps.videoPolicy === 'non-strict') {
        const cause = privacy.screenshotLatch(deps.videoPolicy);
        sequence.screenshots = cause ? { cause, line, count: 0 } : undefined;
      }
      if (sequence.latch) {
        sequence.latch.windowLine = privacy.windowLatched() ? line : undefined;
        const cause = privacy.secretWindowLatched();
        sequence.latch.secretWindow = cause ? { cause, line } : undefined;
      }
      sequence.window = { fromMs: deps.now(), typed: typed.length };
    }
    // The app's next screen is loading again, as after launch.
    sequence.launchWait = true;
    stepDispatched = false;
    return 'pass' as const;
  };
  // The first Tap or Fill after launch may outrun the first screen: poll for its exact target, before any dispatch.
  const launchTarget = async (
    item: Item & { kind: 'press' | 'fill' },
    deadline: number,
  ): Promise<Observation | undefined> => {
    const startedAt = deps.now();
    try {
      // The poll count bounds the wait too, so a clock that does not advance cannot hold it open.
      for (let polls = 0; polls <= WAIT_BUDGET_MS / WAIT_POLL_MS; polls += 1) {
        // captureOnce refuses to start at or after the deadline.
        const observation = await captureOnce(item, false, false, 'resolve', deadline);
        if (
          exactIdentities(observation.screen, item.target, item.kind).some(
            ({ element }) =>
              item.kind === 'fill' ||
              (item.target.exact !== 'text' && element.testID === item.target.quoted) ||
              (item.target.exact !== 'id' && element.label === item.target.quoted),
          )
        )
          return await enrichLabelProvenance(observation, item, deadline);
        const left = deadline - deps.now();
        if (left <= 0) return undefined;
        await pause(Math.min(WAIT_POLL_MS, left));
      }
      return undefined;
    } catch (error) {
      if (error instanceof CaptureDeadline) return undefined;
      throw error;
    } finally {
      implicitWaitMs = deps.now() - startedAt;
    }
  };
  // At most two interruption recoveries per item, for distinct interruptions; overlay dismissals have a separate bound.
  const recovery = async (
    item: Item,
    attempt: number,
    reason: string,
    until?: number,
    proof?: InterruptionProof,
  ): Promise<'retry' | 'accepted' | WalkOutcome | undefined> => {
    const first = recovered.get(item);
    if (opts.recover === false || !deps.hideDevMenu) return undefined;
    recovered.set(item, null);
    loginReplayed = false;
    let fresh: Observation;
    const captureDeadline = latest.front === 'dev-redbox' ? itemDeadline : until;
    try {
      fresh =
        captureDeadline === undefined
          ? await capture(undefined, true, true)
          : await captureOnce(undefined, true, true, 'resolve', captureDeadline);
    } catch (error) {
      if (item.kind === 'wait' && error instanceof NativeSnapshotIncomplete) {
        sequence.captureUnknown = true;
        return undefined;
      }
      if (error instanceof CaptureDeadline) return undefined;
      if (
        !deps.presenceUnavailable ||
        !(error instanceof ResolutionError) ||
        error.code !== 'SCREEN_EVIDENCE_INCOMPLETE'
      )
        throw error;
      try {
        deps.note?.('recovery-skipped=presence-unavailable');
      } catch {
        /* Diagnostics cannot change recovery. */
      }
      interruptionWithheld = {
        item,
        clause:
          "; recovery could not read the screen's presence evidence, so nothing was dismissed",
      };
      return undefined;
    }
    if (fresh.screen.front === 'dev-redbox') {
      // An overlay dismissal never spends the step's interruption recovery.
      if (first === undefined) recovered.delete(item);
      else recovered.set(item, first);
      return devErrorRecovery(item, attempt, fresh, itemDeadline);
    }
    // A system alert the plan's next step answers is the author's, not recovery's.
    const next = block.items[block.items.indexOf(item) + 1];
    if (fresh.screen.front === 'dialog' && next?.kind === 'dialog') return undefined;
    const declinedPrompts = (sequence.declinedPrompts ??= new Set());
    // A dialog step answers with its own action, so only other steps decline by default.
    const prompt =
      fresh.screen.front === 'dialog' && item.kind !== 'dialog'
        ? promptSignature(fresh.screen)
        : undefined;
    if (prompt !== undefined && declinedPrompts.has(prompt))
      return failed(
        item,
        attempt,
        redact(
          `${reason}; the app asked again after recovery declined it; answer it with a dialog step`,
        ),
        fresh.screen,
        await shoot(item),
      );
    const askedAgain = (outcome: WalkOutcome, decline: string): WalkOutcome => {
      if (outcome.failure) {
        const after = sequence.plannedPress?.line;
        outcome.failure.suggestion = redact(
          after !== undefined
            ? `Add a step after line ${after}: Tap "${decline}".`
            : `Add a step before line ${item.line}: Tap "${decline}".`,
        );
      }
      return outcome;
    };
    if (first === null) return undefined;
    if (first !== undefined) {
      if (fresh.screen.front !== 'dialog' && fresh.screen.front !== 'app') return undefined;
      if (
        fresh.screen.front === 'app' &&
        fresh.screen.elements.some(
          (e) =>
            !e.offscreen &&
            (`app ${e.label}` === first ||
              (interruptions.get(item.line)?.afterPlannedPress === true &&
                first.startsWith('app ') &&
                e.label !== undefined &&
                normaliseLabel(e.label) === normaliseLabel(first.slice(4)))),
        )
      ) {
        const repeated = returnedOptIn(fresh.screen, sequence.declinedOptIns);
        if (repeated !== undefined)
          return askedAgain(
            failed(item, attempt, OPT_IN_ASKED_AGAIN, fresh.screen, await shoot(item)),
            repeated,
          );
        return failed(
          item,
          attempt,
          'the app interruption did not disappear',
          fresh.screen,
          await shoot(item),
        );
      }
    }
    const remainingItems = block.items.slice(block.items.indexOf(item) + 1);
    const laterTargets = [
      ...remainingItems.flatMap((remaining) => {
        const target = recoveryTarget(remaining);
        return target ? [target] : [];
      }),
      ...(opts.laterTargets ?? []),
    ];
    // Protection and the current target's metadata are re-read on every screen they are judged on.
    const targetsFor = (screen: Screen): RecoveryTarget[] => {
      const surface = sequence.plannedPress;
      if (surface && surfaceGone(screen, surface)) sequence.plannedPress = undefined;
      const press = sequence.plannedPress;
      return [
        {
          ...(recoveryTarget(item) ?? { phrase: '' }),
          ...(press
            ? { afterPlannedPress: true, ...(press.record ? { pressRecord: press.record } : {}) }
            : {}),
          ...(sequence.declinedOptIns ? { declinedOptIns: sequence.declinedOptIns } : {}),
        },
        ...laterTargets,
      ];
    };
    let planTargets = targetsFor(fresh.screen);
    if (interruptions.get(item.line)?.outcome !== 'dismissed') interruptions.delete(item.line);
    const interruptionRejected = (record: InterruptionDiagnostic, observation?: number) => {
      if (record.veto === 'previous-plan-press') pressVetoed = item;
      if (record.veto === 'previous-plan-press' && record.optInWithheld)
        interruptionWithheld = { item, clause: optInWithheldClauses[record.optInWithheld] };
      else if (
        record.veto === 'no-candidate' &&
        sequence.plannedPress &&
        record.elements.some(
          ({ failed }) => failed === 'not-visible' || failed === 'press-not-supported',
        )
      )
        interruptionWithheld = {
          item,
          clause:
            '; a decline control is in front, but its visibility or press evidence could not be proven, so nothing was dismissed',
        };
      const behind = record.targetIndex === undefined ? undefined : planTargets[record.targetIndex];
      if (interruptions.get(item.line)?.outcome !== 'dismissed')
        interruptions.set(item.line, {
          considered: true,
          outcome: 'vetoed',
          veto: record.veto,
          ...(record.provenance ? { provenance: record.provenance } : {}),
          ...(behind?.line !== undefined ? { targetLine: behind.line } : {}),
          ...(behind?.kind ? { targetKind: behind.kind } : {}),
          soleDecline: record.soleDecline,
        });
      try {
        deps.note?.(
          `interruption-rejected=${JSON.stringify({ line: item.line, ...(observation === undefined ? {} : { observation }), ...record })}`,
        );
        deps.interruptionRejected?.({
          kind: 'interruption-rejected',
          line: item.line,
          veto: record.veto,
          ...(record.targetIndex === undefined ? {} : { targetIndex: record.targetIndex }),
          exactDeclineCount: record.exactDeclineCount,
        });
      } catch {
        /* Diagnostics cannot change recovery. */
      }
    };
    let interruptionShot: string | undefined;
    let dialogAct: ActResult | undefined;
    let declineAttempted = false;
    let dismissStarted = false;
    let declineDispatched = false;
    // The read-back after a dispatched decline: what is on screen once the press has run.
    let afterDecline: Screen | undefined;
    let declineCentreY: number | undefined;
    let optInDecided: OptInDecision | undefined;
    const result = await recover(
      fresh.screen,
      {
        hideDevMenu: deps.hideDevMenu,
        interruptionDiagnostic: (record) => interruptionRejected(record, fresh.id),
        dialog: async () => {
          declineAttempted = true;
          recoveries += 1;
          return (dialogAct = await mutate(
            item,
            fresh,
            (context) => deps.dialog(item.kind === 'dialog' ? item.action : 'dismiss', context),
            Infinity,
            'recovery',
          ));
        },
        ...(deps.login && first === undefined ? { replayLogin } : {}),
        dismiss: async (label, optIn) => {
          optInDecided = optIn;
          if (deps.interruptionVeto) {
            const mask = privacy.maskForModel(privacy.modelValues(), [
              item.raw,
              ...fresh.screen.visibleText,
            ]);
            const answers = await judge.ask(
              {
                step: mask.apply(item.raw),
                elements: fresh.screen.elements.map((e) => mask.describeElement(e, describe)),
              },
              { interruption: INTERRUPTION_QUESTION },
              'walk',
              observationDeadline(fresh.timing),
            );
            if (checkVerdict(INTERRUPTION_QUESTION, answers.interruption) !== 'pass')
              return {
                refuse: {
                  code: 'INTERRUPTION_VETOED',
                  message: 'the app interruption dismissal was vetoed; nothing was tapped',
                },
              };
          }
          dismissStarted = true;
          interruptionShot = await shoot(item);
          declineAttempted = true;
          recoveries += 1;
          const support: Block = {
            slug: '@interruption',
            title: 'Dismiss interruption',
            planHash: '',
            items: [
              {
                kind: 'press',
                target: { quoted: label, phrase: label, exact: 'text' },
                line: item.line,
                raw: `Tap "${label}"`,
                source: 'grammar',
              },
            ],
          };
          let taken = 0;
          let dispatched = false;
          let observed: Screen | undefined;
          const nested = await walkBlock(
            support,
            {
              ...deps,
              captureScreen: async (options) => {
                const screen = await captureScreen({ ...options, platformPresence: true });
                if (!dispatched) {
                  observed = screen;
                  planTargets = targetsFor(screen);
                  const candidate = dismissCandidate(
                    screen,
                    planTargets,
                    (record) => interruptionRejected(record),
                    proof,
                  );
                  if (
                    !candidate ||
                    'refuse' in candidate ||
                    'repeated' in candidate ||
                    candidate.label !== label
                  )
                    throw new ResolutionError({
                      refuse: 'INTERRUPTION_CHANGED',
                      reason:
                        'the interruption or plan targets changed before dispatch; nothing was tapped',
                    });
                  optInDecided = optInDecision(screen, candidate);
                }
                return screen;
              },
              press: async (ref, context) => {
                if (dispatched)
                  throw new ResolutionError({
                    refuse: 'INTERRUPTION_NOT_DISPATCHED',
                    reason: 'the decline control was already attempted; it was not retried',
                  });
                dispatched = true;
                const control = observed?.elements.find((e) => e.ref === ref);
                const frame = control && elementFrame(control);
                // Android frames are pixels; the receipt is in points like iOS.
                declineCentreY = frame
                  ? (frame.y + frame.height / 2) / (observed?.pointScale ?? 1)
                  : undefined;
                const result = await deps.press(ref, context);
                declineDispatched = result.executed !== false && result.mutation !== 'none';
                if (!result.ok || result.executed === false) {
                  observeRowSettle(result);
                  throw new ResolutionError({
                    refuse: 'INTERRUPTION_NOT_DISPATCHED',
                    reason:
                      'the decline control was not dispatched successfully; it was not retried',
                  });
                }
                return result;
              },
              screenshot: (name) => {
                taken += 1;
                return deps.screenshot(name);
              },
            },
            shots,
            typed,
            privacy,
            sequence,
            { recover: false, singleAttempt: true },
          );
          shots += taken;
          separateRowOperations(nested.rows);
          rows.push(...nested.rows);
          if (nested.refusal) return { refuse: nested.refusal };
          if (nested.failure) return { fail: nested.failure.seen };
          const after = (await capture()).screen;
          afterDecline = after;
          const gone = (text: string): boolean =>
            literalEvidence(after, text, 'equals').verdict === 'fail' &&
            !after.elements.some((e) => !e.offscreen && e.label === text);
          if (!optInDecided?.afterPlannedPress) return gone(label) ? 'pass' : 'fail';
          const normalizedText = new Set(
            [
              ...after.visibleText,
              ...(after.labelText ?? []),
              ...(after.unresolvedText ?? []),
              ...after.elements.flatMap((e) => (!e.offscreen && e.label ? [e.label] : [])),
            ].map(normaliseLabel),
          );
          const optInGone = (text: string): boolean =>
            gone(text) && !normalizedText.has(normaliseLabel(text));
          // Both controls must be gone on a complete capture; a surviving accept is never retried.
          return completeCapture(after) && optInGone(label) && optInGone(optInDecided.accept)
            ? 'pass'
            : {
                fail: 'the permission opt-in was still in front after its decline; it was not retried',
              };
        },
      },
      deps.login?.marker,
      planTargets,
      proof,
    ).catch((error: unknown) => {
      if (error instanceof AppProcessGoneError) {
        markContinuity(sequence, { signal: 'app-process-gone', line });
        throw processChanged();
      }
      throw error;
    });
    // The dismissal reached its dispatch phase, or Jev vetoed it just before.
    const dismissing =
      dismissStarted ||
      (result && 'refuse' in result && result.refuse.code === 'INTERRUPTION_VETOED');
    const declined: InterruptionReceipt['outcome'] | undefined = !result
      ? undefined
      : 'handled' in result
        ? result.handled === 'interruption'
          ? 'dismissed'
          : undefined
        : 'refuse' in result && result.refuse.code === 'INTERRUPTION_AMBIGUOUS'
          ? 'ambiguous'
          : dismissing
            ? // A dispatched decline whose effect or disappearance was not proven, or none was sent.
              declineDispatched
              ? 'did-not-disappear'
              : 'not-dispatched'
            : undefined;
    if (declined)
      interruptions.set(item.line, {
        considered: true,
        soleDecline: soleDecline(fresh.screen),
        // A pre-dispatch recheck's veto, target line and screen facts explain why nothing was sent.
        ...(declined === 'not-dispatched' ? interruptions.get(item.line) : {}),
        outcome: declined,
        ...(declined === 'did-not-disappear' && declineCentreY !== undefined
          ? { pressCentreY: declineCentreY }
          : {}),
        ...(result && 'handled' in result && result.screenClass
          ? { screenClass: result.screenClass }
          : {}),
        ...(optInDecided?.afterPlannedPress
          ? { screenClass: 'permission-opt-in', afterPlannedPress: true }
          : {}),
      });
    if (optInDecided?.afterPlannedPress && declineDispatched)
      (sequence.declinedOptIns ??= new Set()).add(optInDecided.signature);
    if (!result) return undefined;
    if ('handled' in result && !declineAttempted) recoveries += 1;
    if ('handled' in result) {
      interruptionWithheld = undefined;
      if (prompt !== undefined && result.handled === 'dialog') declinedPrompts.add(prompt);
      // A dialog step answers with its own action, so it never gets a second, decline-only recovery.
      if (
        first === undefined &&
        item.kind !== 'dialog' &&
        (result.handled === 'dialog' || result.handled === 'interruption')
      )
        recovered.set(
          item,
          result.handled === 'dialog'
            ? `dialog ${promptSignature(fresh.screen)}`
            : `app ${result.label}`,
        );
      // Counted from the decision taken at dispatch, which the re-check refreshes.
      if (result.handled === 'interruption' && optInDecided)
        (sequence.optInDeclines ??= []).push({
          line: item.line,
          afterPlannedPress: optInDecided?.afterPlannedPress === true,
        });
      // The recovery acted on the device, so a later selector miss is not a pre-mutation re-walk.
      mutationStarted = true;
      dispatchedOn = fresh.id;
      const proof = result.handled === 'dialog' ? dialogAct?.dialog : undefined;
      if (proof)
        deps.note?.(
          `dialog-tap ${JSON.stringify({ v: 1, line: item.line, label: proof.label, rect: proof.rect })}`,
        );
      emit({
        ...base(item, attempt),
        outcome: 'retry',
        ...(interruptionShot ? { screenshot: interruptionShot } : {}),
        ...(proof ? { dialog: proof } : {}),
        reason: redact(
          `${reason}; recovered: ${
            optInDecided?.afterPlannedPress && result.label
              ? `declined a permission opt-in that followed the plan's own tap (${FIXED_CONTROL_WORDS.has(result.label) ? result.label : 'the decline control'})`
              : result.label
                ? `dismissed ${SCREEN_CLASS_NAMES[result.screenClass ?? 'app']} with ${result.label}`
                : result.handled
          }; retrying the step once`,
        ),
      });
      const budget = stepBudgets.get(operationFor(item.line))!;
      if (budget.deadline !== undefined) {
        const startedAt = deps.now();
        budget.deadline += startedAt - budget.startedAt;
        budget.startedAt = startedAt;
        itemStartedAt = startedAt;
        itemDeadline = budget.deadline;
      }
      return 'retry';
    }
    const shown = loginReplayed ? (await capture()).screen : (afterDecline ?? fresh.screen);
    const shot = await shoot(item);
    if ('fail' in result) {
      const outcome = failed(item, attempt, result.fail, shown, shot);
      return result.repeatedOptIn ? askedAgain(outcome, result.repeatedOptIn) : outcome;
    }
    return {
      ...failed(item, attempt, result.refuse.message, fresh.screen, shot),
      refusal: result.refuse,
    };
  };

  const dismissDevError = async (
    item: Item,
    observation: Observation,
    ref: string,
    until?: number,
  ): Promise<ActResult> => {
    const state = { mutationStarted, dispatchedOn, stepDispatched, dispatchStarted };
    try {
      return await mutate(
        item,
        observation,
        (context) => deps.press(ref, context),
        until,
        'recovery',
      );
    } catch (error) {
      if (isAbort(error)) throw error;
      return {
        ok: false,
        proven: false,
        executed: false,
        ...(error instanceof QaDispatchError ? { error: `${error.code}: ` } : {}),
        ...(error instanceof QaDispatchError && error.code === 'TARGET_MOVED_BEFORE_DISPATCH'
          ? { mutation: 'none' as const }
          : {}),
      };
    } finally {
      ({ mutationStarted, dispatchedOn, stepDispatched, dispatchStarted } = state);
    }
  };
  const postActionEligible = (item: Item | undefined, screen: Screen): boolean =>
    deps.platform === 'ios' &&
    screen.devError?.variant === 'redbox' &&
    screen.devError.dismissRef !== undefined &&
    item?.kind === 'press' &&
    pressAct?.ok === true &&
    pressAct.executed !== false &&
    pressAct.mutation !== 'none' &&
    !pressNeedsReadback &&
    opts.recover !== false &&
    !sequence.devOverlayAccepted &&
    !postActionTried;

  const postActionOverlay = async (
    item: Item,
    observation: Observation,
    until?: number,
  ): Promise<Observation> => {
    const refuse = (cause: DevErrorRefusal, reason: string = DEV_ERROR_REFUSALS[cause]): never => {
      throw new ResolutionError({ refuse: `DEV_REDBOX_${cause}`, reason });
    };
    if (!postActionEligible(item, observation.screen)) return refuse('ACTION_UNCERTAIN');
    postActionTried = true;
    postActionShot = await shoot(item);
    postActionDevError = { variant: 'redbox', dismissal: 1 };
    recoveries += 1;
    const acted = await dismissDevError(
      item,
      observation,
      observation.screen.devError!.dismissRef!,
      until,
    );
    if (!acted.ok || acted.executed === false) {
      const code = refusalCode(acted.error);
      try {
        deps.note?.(`dev-error-dismiss-failed=${code ?? 'unknown'}`);
      } catch {
        // Diagnostics cannot change recovery.
      }
      return refuse(
        'DISMISS_FAILED',
        `${DEV_ERROR_REFUSALS.DISMISS_FAILED}${code ? `; runner refused: ${code}` : ''}`,
      );
    }
    const completionUncertain =
      "a development error overlay appeared after the step's action was sent; it was dismissed once to check the next screen, which did not prove the step completed and the step was not replayed";
    let after: Observation;
    try {
      after = await captureOnce(
        item.kind === 'check' ? undefined : item,
        false,
        true,
        'resolve',
        until,
      );
    } catch (error) {
      if (
        error instanceof CaptureDeadline ||
        error instanceof NativeCaptureError ||
        error instanceof NativeSnapshotIncomplete ||
        error instanceof PrivateInputCaptureError ||
        (error instanceof ResolutionError && error.code === 'SCREEN_EVIDENCE_INCOMPLETE')
      )
        return refuse('ACTION_UNCERTAIN', completionUncertain);
      throw error;
    }
    if (after.screen.front === 'dev-redbox')
      return refuse(
        'REPEATED',
        'a development error overlay was still in front after one dismissal; nothing else was tapped',
      );
    const next = block.items[block.items.indexOf(item) + 1];
    const target =
      next && (next.kind === 'press' || next.kind === 'fill' || next.kind === 'wait')
        ? next.target.quoted
        : undefined;
    if (
      after.screen.front !== 'app' ||
      after.screen.devError ||
      target === undefined ||
      !pressBase ||
      pressBase.elements.some((element) => element.testID === target) ||
      !after.screen.elements.some(
        (element) => element.testID === target && !element.ref.startsWith('react:'),
      )
    )
      return refuse('ACTION_UNCERTAIN', completionUncertain);
    postActionDevError = {
      ...postActionDevError,
      afterAction: true,
      proof: 'next-test-id-appeared',
    };
    sequence.devOverlayAccepted = true;
    postActionObservation = after;
    cached = {
      item: next,
      observation: after,
      ...(next.kind === 'press' ? { needsLabelProvenance: true as const } : {}),
    };
    return after;
  };

  // Dismisses the overlay with its own control, never replaying a step whose action may have run.
  const devErrorRecovery = async (
    item: Item,
    attempt: number,
    fresh: Observation,
    until?: number,
  ): Promise<'retry' | 'accepted' | WalkOutcome> => {
    let observation = fresh;
    const budget = stepBudgets.get(operationFor(item.line))!;
    const previousDismissal = budget.devErrorDismissals;
    let devError: LedgerRow['devError'] =
      fresh.screen.devError && previousDismissal
        ? { variant: fresh.screen.devError.variant, dismissal: previousDismissal }
        : undefined;
    const refuse = (
      cause: DevErrorRefusal,
      runnerCode?: string,
      reason: string = DEV_ERROR_REFUSALS[cause],
    ): WalkOutcome => {
      const message = `${reason}${runnerCode ? `; runner refused: ${runnerCode}` : ''}`;
      return {
        ...failed(
          item,
          attempt,
          message,
          observation.screen,
          undefined,
          undefined,
          false,
          false,
          devError,
        ),
        refusal: { code: `DEV_REDBOX_${cause}`, message },
      };
    };
    const reobserve = async (): Promise<boolean> => {
      try {
        observation =
          until === undefined
            ? await capture(undefined, true, true)
            : await captureOnce(undefined, true, true, 'resolve', until);
        return true;
      } catch (error) {
        if (
          error instanceof CaptureDeadline ||
          (error instanceof ResolutionError && error.code === 'SCREEN_EVIDENCE_INCOMPLETE')
        )
          return false;
        throw error;
      }
    };
    if (sequence.devOverlayAccepted)
      return refuse('ACTION_UNCERTAIN', undefined, DEV_ERROR_RECURRENCE);
    if (mutationStarted) {
      if (!postActionEligible(item, fresh.screen)) return refuse('ACTION_UNCERTAIN');
      await postActionOverlay(item, fresh, until);
      emit({
        ...base(item, attempt),
        ...stored(pressSelector),
        outcome: 'pass',
        ...(postActionShot ? { screenshot: postActionShot } : {}),
      });
      return 'accepted';
    }
    while (observation.screen.front === 'dev-redbox') {
      const dismissal = budget.devErrorDismissals + 1;
      if (dismissal > DEV_ERROR_DISMISSALS) return refuse('REPEATED');
      const overlay = observation.screen.devError;
      const ref = overlay?.dismissRef;
      if (!overlay || !ref) return refuse('NO_SAFE_DISMISS');
      devError = { variant: overlay.variant, dismissal };
      budget.devErrorDismissals = dismissal;
      recoveries += 1;
      const acted = await dismissDevError(item, observation, ref, until);
      if (!acted.ok || acted.executed === false) {
        const code = refusalCode(acted.error);
        const moved =
          code === 'TARGET_MOVED_BEFORE_DISPATCH' ? movedGeometry(acted.error) : undefined;
        try {
          deps.note?.(
            `dev-error-dismiss-failed=${code ?? 'unknown'}${moved ? ` moved=${JSON.stringify(moved)}` : ''}`,
          );
        } catch {
          /* Diagnostics cannot change recovery. */
        }
        // LogBox's label-only Dismiss is refused at once until its moved-target path is fixed.
        if (
          acted.mutation !== 'none' ||
          dismissal >= DEV_ERROR_DISMISSALS ||
          (overlay.variant === 'logbox' && code === 'TARGET_MOVED_BEFORE_DISPATCH')
        )
          return refuse('DISMISS_FAILED', code);
        emit({
          ...base(item, attempt),
          outcome: 'retry',
          retryCause: 'DEV_REDBOX',
          devError,
          reason: `a development error overlay was in front; its Dismiss control was refused before any gesture${code ? ` (${code})` : ''} (${dismissal} of ${DEV_ERROR_DISMISSALS}); observing it again`,
        });
        if (!(await reobserve())) return refuse('CLEARANCE_UNPROVEN');
        continue;
      }
      emit({
        ...base(item, attempt),
        outcome: 'retry',
        retryCause: 'DEV_REDBOX',
        devError,
        reason: `a development error overlay was in front; dismissed it with its own Dismiss control (${dismissal} of ${DEV_ERROR_DISMISSALS}); retrying the step`,
      });
      if (!(await reobserve())) return refuse('CLEARANCE_UNPROVEN');
    }
    return 'retry';
  };

  items: for (const item of block.items) {
    if (opts.fromLine !== undefined && item.line < opts.fromLine) {
      if (item.kind === 'echo') declareEcho(item.input);
      continue;
    }
    itemObservationStart = sequence.observation;
    activeItem = item;
    pressVetoed = undefined;
    pressBase = undefined;
    pressAct = undefined;
    pressSelector = undefined;
    pressNeedsReadback = false;
    postActionTried = false;
    postActionShot = undefined;
    postActionObservation = undefined;
    postActionDevError = undefined;
    pressDispatch = undefined;
    mutationStarted = false;
    stepDispatched = false;
    fillMethod = undefined;
    fillMismatch = undefined;
    keyboardCleared = undefined;
    fillHandlerAttempted = false;
    fillHandlerRefused = false;
    enrichment = undefined;
    waitAttempt = 'none';
    launchWait = undefined;
    implicitWaitMs = undefined;
    preparationResets = undefined;
    const operationId = operationFor(item.line);
    let budget = stepBudgets.get(operationId);
    if (!budget || budget.devErrorDismissals === 0) {
      const startedAt = deps.now();
      budget = {
        startedAt,
        deadline:
          item.kind === 'wait'
            ? startedAt +
              (item.target.quoted === undefined ? PHRASE_WAIT_BUDGET_MS : WAIT_BUDGET_MS)
            : item.kind === 'scroll' && item.until
              ? startedAt + PHRASE_WAIT_BUDGET_MS
              : undefined,
        devErrorDismissals: 0,
      };
      stepBudgets.set(operationId, budget);
    }
    itemStartedAt = budget.startedAt;
    itemDeadline = budget.deadline;
    let pixelBaselineTaken = false;
    let pixelBaseline:
      | { target: NonNullable<ReturnType<typeof pixelTarget>>; crop: PixelCrop }
      | undefined;
    attempts: for (;;) {
      interruptionWithheld = undefined;
      overlayRows.delete(item.line);
      scrollBands.delete(item.line);
      targetRows.delete(item.line);
      line = item.line;
      // Support blocks walk without recovery and never spend it; a login replay re-arms it for this retry.
      if (
        sequence.launchWait &&
        opts.recover !== false &&
        (item.kind === 'press' || item.kind === 'fill')
      ) {
        sequence.launchWait = false;
        launchWait = { startedAt: deps.now() };
      }
      deps.start?.({
        operationId: operationFor(item.line),
        line: item.line,
        kind: item.kind === 'check' ? 'check' : 'step',
        t: deps.now(),
      });
      if (item.kind === 'echo') {
        declareEcho(item.input);
        emit({ ...base(item, 1), outcome: 'pass' });
        continue items;
      }
      let currentAttempt = 1;
      let targetPending = false;
      resolvedBy = item.source === 'jev' && !replay ? 'jev' : 'exact';
      if (item.kind === 'fill' && !typed.includes(fillText(item))) typed.push(fillText(item));
      try {
        if (item.kind === 'check') {
          const next = block.items[block.items.indexOf(item) + 1];
          const nextStep =
            !item.literal && next && next.kind !== 'check' && stepTarget(next)?.quoted === undefined
              ? next
              : undefined;
          let before = await capture(nextStep, !item.literal);
          resolvedBy = item.literal ? 'exact' : 'jev';
          let decision: ScreenDecision;
          let freshness = 1;
          let reasks = CHECK.reasks;
          for (;;) {
            try {
              decision = await decide(before, item, nextStep);
            } catch (error) {
              if (isAbort(error)) throw error;
              if (!(error instanceof EvidenceExpired) || freshness-- <= 0) throw error;
              metric('refresh', before);
              before = await capture(nextStep, !item.literal);
              continue;
            }
            if (decision.check !== 'unsure' || reasks-- <= 0) break;
            metric('reask', before);
            await pause(WAIT_POLL_MS);
            before = await capture(nextStep, !item.literal);
          }
          const shot = await shoot(item);
          if (decision.check === 'pass') {
            if (nextStep) cached = { item: nextStep, observation: before, decision };
            const labelled =
              item.literal && literalEvidence(before.screen, item.text, 'contains').label;
            emit({
              ...base(item, 1),
              ...(shot ? { screenshot: shot } : {}),
              ...(labelled ? { reason: 'matched an accessibility label' } : {}),
              outcome: 'pass',
            });
            continue items;
          }
          const nearMiss =
            item.literal && decision.check === 'fail'
              ? literalEvidence(before.screen, item.text, 'contains').nearMiss
              : undefined;
          const reason =
            decision.check === 'unsure'
              ? 'CHECK_UNSURE: the expectation remained uncertain after a fresh-screen re-ask'
              : `"${item.text}" is not satisfied on screen${nearMiss ? NEAR_MISS[nearMiss] : ''}`;
          if (decision.check === 'unsure' || decision.check === 'fail') {
            const recovering = await recovery(item, 1, reason, undefined, 'absent-surface');
            if (recovering === 'accepted') continue items;
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
          }
          const checkFailure = failed(item, 1, reason, before.screen, shot);
          return decision.check === 'fail' ? judged(checkFailure, before.screen) : checkFailure;
        }

        if (item.kind === 'wait') {
          resolvedBy = item.target.quoted === undefined ? 'jev' : resolvedBy;
          const budget = item.target.quoted === undefined ? PHRASE_WAIT_BUDGET_MS : WAIT_BUDGET_MS;
          const waitStarted = itemStartedAt;
          const deadline = itemDeadline!;
          const held = cached?.item === item ? cached : undefined;
          let observation: Observation;
          try {
            observation =
              held?.observation ?? (await captureOnce(item, false, false, 'resolve', deadline));
          } catch (error) {
            if (!(error instanceof CaptureDeadline)) throw error;
            return failed(
              item,
              1,
              `TARGET_WAIT_TIMEOUT: target was not observed within ${budget}ms; no capture completed before the wait deadline; cause=capture-deadline; elapsed_ms=${Math.round(deps.now() - waitStarted)}; next_action=inspect_capture_health`,
              { elements: [], visibleText: [], front: 'app' },
              undefined,
            );
          }
          cached = undefined;
          const probe = visibilityProbe(item, deadline);
          let replayMiss: ResolutionError | undefined;
          let unsure = false;
          let absent = 0;
          let observations = 0;
          let reactOnlyObservations = 0;
          const absentScreens = new Set<string>();
          const visible = async (s: Observation, initial?: ScreenDecision): Promise<boolean> => {
            let observed;
            try {
              observed = await probe(s, initial);
            } catch (error) {
              if (
                !(error instanceof ResolutionError) ||
                error.code !== 'REPLAY_SELECTOR' ||
                item.target.exact !== 'id' ||
                deps.now() >= deadline
              )
                throw error;
              replayMiss = error;
              observation = s;
              return false;
            }
            observation = observed.observation;
            unsure = observed.unsure === true;
            targetPending = !observed.found && item.target.quoted !== undefined;
            observations += 1;
            if (!observed.found && reactOnlyTarget(item.target, observation.screen))
              reactOnlyObservations += 1;
            // A presence capture can join the same screen differently: only cheap ones build the history.
            if (
              !observed.found &&
              !unsure &&
              item.target.quoted !== undefined &&
              !observation.platformPresence
            ) {
              absent += 1;
              absentScreens.add(screenSignature(observation.screen));
            }
            return observed.found;
          };
          // The one presence capture that reads React's layout, once a lone React-only identity holds still.
          let facts: Observation | undefined;
          let expired = false;
          let fresh = false;
          let scrolled:
            | { before: Screen; signature: string; container: Element; act: ActResult }
            | undefined;
          let found = false;
          try {
            found = await visible(observation, held?.decision);
          } catch (error) {
            // The first check's evidence refresh is bounded like every poll; judge what was observed.
            if (!(error instanceof CaptureDeadline)) throw error;
            expired = true;
          }
          while (!found && deps.now() < deadline) {
            const lone = fresh ? reactOnlyTarget(item.target, observation.screen) : undefined;
            fresh = false;
            const proven =
              lone &&
              item.target.exact !== 'id' &&
              !item.precondition &&
              observation.screen.front === 'app' &&
              (observation.screen.captureCoverage?.native ??
                observation.screen.coverage?.native) === 'complete' &&
              absent >= 2 &&
              absentScreens.size === 1;
            const view = proven ? reactOnlyViewport(lone) : undefined;
            if (view?.where === 'inside' && reactOnlyFactsOf(lone!)?.accessibleAncestor) {
              const reason = reactOnlyMiss(item.target, observation.screen, absent, waitAttempt)!;
              // A React-only target may sit behind an interruption; recovery gets its own bounded capture.
              const recovering = await recovery(
                item,
                1,
                reason,
                deps.now() + CAPTURE_BUDGET_MS,
                'covered-target',
              );
              if (recovering === 'accepted') continue items;
              if (recovering === 'retry') continue attempts;
              if (recovering) return recovering;
              return judged(
                failed(
                  item,
                  1,
                  reason,
                  observation.screen,
                  await shoot(item),
                  undefined,
                  false,
                  'TARGET_NOT_FOUND',
                ),
                observation.screen,
              );
            }
            if (
              waitAttempt === 'none' &&
              view?.container &&
              (view.where === 'below' || view.where === 'above') &&
              // The swipe band must lie in the field's own scroll container.
              scrollUntilContainer(item.target, observation.screen) === view.container
            ) {
              const before = observation.screen;
              let act: ActResult | undefined;
              try {
                act = await mutate(
                  item,
                  observation,
                  (context) =>
                    deps.scroll(
                      view.where === 'below' ? 'down' : 'up',
                      context,
                      undefined,
                      bandFor(item, item.target, before),
                    ),
                  deadline,
                );
              } catch (error) {
                // Stale evidence dispatched nothing; the next poll re-evaluates on a fresh capture.
                if (isAbort(error) || !(error instanceof EvidenceExpired)) throw error;
                if (error.itemExpired) break;
              }
              if (act) {
                waitAttempt = 'scroll';
                sequence.momentum = true;
                // Movement is judged cheap capture against cheap capture, never against the layout read.
                scrolled = {
                  before,
                  signature: [...absentScreens][0],
                  container: view.container,
                  act,
                };
                // The screen this scroll moves is expected to change; count observations afresh.
                absent = 0;
                absentScreens.clear();
              }
            }
            const enrich =
              !enrichment &&
              !observation.platformPresence &&
              !!reactOnlyTarget(item.target, observation.screen) &&
              absent >= 2 &&
              absentScreens.size === 1;
            await pause(Math.min(WAIT_POLL_MS, deadline - deps.now()));
            if (deps.now() >= deadline) break;
            if (enrich)
              enrichment = {
                at: deps.now(),
                budget: Math.max(
                  1,
                  Math.min(NATIVE_PRESENCE_BUDGET_MS, Math.floor(deadline - deps.now())),
                ),
              };
            try {
              const next = await captureOnce(
                item,
                false,
                false,
                enrich ? 'provenance' : 'resolve',
                deadline,
              );
              const navigation =
                scrolled &&
                scrollNavigationChange(scrolled.before, next.screen, scrolled.container);
              if (navigation)
                throw new ResolutionError({ refuse: 'SCROLL_NAVIGATED', reason: navigation });
              found = await visible(next);
              if (enrich && observation.platformPresence) facts = observation;
              fresh = facts === observation;
            } catch (error) {
              if (enrich) enrichment!.waited = deps.now() - enrichment!.at;
              // A capture cut off or finishing past the deadline is not evidence; judge the ones already made.
              const late =
                error instanceof CaptureDeadline ||
                (error instanceof EvidenceExpired && error.itemExpired);
              // A refused layout read leaves only missing facts: the cheap polls go on.
              const refused =
                enrich &&
                error instanceof ResolutionError &&
                error.code === 'SCREEN_EVIDENCE_INCOMPLETE';
              if (!late && !refused) throw error;
              if (refused && deps.now() < deadline) continue;
              expired = enrich || error instanceof CaptureDeadline;
              break;
            }
            if (enrich) enrichment!.waited = deps.now() - enrichment!.at;
            if (
              !found &&
              scrolled &&
              !scrolled.act.ok &&
              screenSignature(observation.screen) === scrolled.signature
            )
              return failed(
                item,
                1,
                scrolled.act.error ?? 'scroll was not dispatched',
                observation.screen,
                await shoot(item),
              );
            scrolled = undefined;
          }
          if (!found) {
            if (unsure) throw unresolvedText(item.target.quoted!);
            if (item.precondition) {
              const refusal = {
                code: 'BLOCK_START_MISSING',
                message: redact(
                  `the block starts on "${item.target.quoted}", which is not on screen; reach that screen before this block or re-record it`,
                ),
              };
              return {
                ...failed(
                  item,
                  1,
                  `${refusal.code}: ${refusal.message}`,
                  observation.screen,
                  await shoot(item),
                  undefined,
                  false,
                  'TARGET_NOT_FOUND',
                ),
                refusal,
              };
            }
            if (replayMiss) throw replayMiss;
            // Repeated literal absence on one unchanged screen is an observed result, not uncertainty.
            const unchanged = absent >= 2 && absentScreens.size === 1;
            const reactOnly =
              unchanged && facts && reactOnlyMiss(item.target, facts.screen, absent, waitAttempt);
            // Seen React-only but never classified: report what was observed, with no further capture or media.
            if (!reactOnly && reactOnlyObservations > 0)
              return failed(
                item,
                1,
                reactOnlyTimeout({
                  budgetMs: budget,
                  expired,
                  lastStage:
                    captureStage === 'native-readiness'
                      ? 'readiness'
                      : captureStage?.startsWith('native')
                        ? 'native'
                        : captureStage === 'react-private'
                          ? 'react'
                          : captureStage === 'join-private'
                            ? 'join'
                            : 'unknown',
                  observations,
                  reactOnlyObservations,
                  presenceAttempts: enrichment ? 1 : 0,
                  elapsedMs: deps.now() - waitStarted,
                  enrichmentWaitMs: enrichment?.waited ?? 0,
                  requestedPresenceBudgetMs: enrichment?.budget ?? 0,
                  attempt: waitAttempt,
                }),
                observation.screen,
                undefined,
                undefined,
                false,
                'TARGET_NOT_FOUND',
              );
            const reason =
              reactOnly ||
              (unchanged
                ? `"${item.target.quoted}" did not appear within ${budget / 1000}s; the screen did not change across ${absent} observations`
                : ITEM_DEADLINE_EXCEEDED);
            // The wait's deadline has passed; a React-only miss still gets one bounded recovery capture.
            const recovering = await recovery(
              item,
              1,
              reason,
              reactOnly ? deps.now() + CAPTURE_BUDGET_MS : undefined,
              reactOnly ? 'covered-target' : 'absent-surface',
            );
            if (recovering === 'accepted') continue items;
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
            if (unchanged) {
              const miss =
                !reactOnly &&
                presenceMiss(item.target, observation.screen, observation.overlayHits);
              return judged(
                failed(
                  item,
                  1,
                  miss ? `${reason}; ${miss}` : reason,
                  observation.screen,
                  await shoot(item),
                  undefined,
                  false,
                  'TARGET_NOT_FOUND',
                ),
                observation.screen,
              );
            }
            usable(observation, item, deadline);
            throw new EvidenceExpired(true);
          }
          const shot = await shoot(item);
          emit({
            ...base(item, 1),
            ...(shot ? { screenshot: shot } : {}),
            ...targetSelector(item.target, observation),
            outcome: 'pass',
          });
          continue items;
        }

        if (item.kind === 'scroll' && item.until) {
          resolvedBy = item.until.quoted === undefined ? 'jev' : resolvedBy;
          const deadline = itemDeadline!;
          const held = cached?.item === item ? cached : undefined;
          let observation =
            held?.observation ?? (await captureOnce(item, false, false, 'resolve', deadline));
          cached = undefined;
          let beforeScroll = {
            screen: observation.screen,
            container: scrollUntilContainer(item.until, observation.screen),
          };
          const probe = visibilityProbe(item, deadline, (screen) => {
            const navigation = scrollNavigationChange(
              beforeScroll.screen,
              screen,
              beforeScroll.container,
            );
            if (navigation)
              throw new ResolutionError({ refuse: 'SCROLL_NAVIGATED', reason: navigation });
          });
          let replayMiss: ResolutionError | undefined;
          let unsure = false;
          const visible = async (s: Observation, initial?: ScreenDecision): Promise<boolean> => {
            let observed;
            try {
              observed = await probe(s, initial);
            } catch (error) {
              if (
                !(error instanceof ResolutionError) ||
                error.code !== 'REPLAY_SELECTOR' ||
                item.until!.exact !== 'id' ||
                deps.now() >= deadline
              )
                throw error instanceof EvidenceExpired && error.itemExpired && replayMiss
                  ? replayMiss
                  : error;
              replayMiss = error;
              observation = s;
              return false;
            }
            observation = observed.observation;
            unsure = observed.unsure === true;
            targetPending = !observed.found;
            return observed.found;
          };
          let found = await visible(observation, held?.decision);
          let attempts = 0;
          const container = scrollUntilContainer(item.until, observation.screen);
          while (!found && attempts < SCROLL_ATTEMPTS && deps.now() < deadline) {
            beforeScroll = { screen: observation.screen, container };
            const beforeSignature = screenSignature(observation.screen);
            let act: ActResult;
            if (observation.screen.front === 'dialog') throw dialogInFront(item.until.phrase);
            try {
              act = await mutate(
                item,
                observation,
                (context) =>
                  deps.scroll(
                    scrollUntilDirection(item.until!, observation.screen, item.direction),
                    context,
                    undefined,
                    bandFor(item, item.until!, observation.screen),
                  ),
                deadline,
              );
            } catch (error) {
              if (isAbort(error)) throw error;
              if (!(error instanceof EvidenceExpired) || error.itemExpired)
                throw error instanceof EvidenceExpired && error.itemExpired && replayMiss
                  ? replayMiss
                  : error;
              metric('refresh', observation);
              await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
              if (deps.now() >= deadline) throw replayMiss ?? new EvidenceExpired(true);
              observation = await captureOnce(item, false, false, 'resolve', deadline);
              found = await visible(observation);
              continue;
            }
            attempts += 1;
            await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
            if (deps.now() >= deadline) throw replayMiss ?? new EvidenceExpired(true);
            observation = await captureOnce(item, false, false, 'resolve', deadline);
            found = await visible(observation);
            const moved = screenSignature(observation.screen) !== beforeSignature;
            if (!act.ok && !moved)
              return failed(
                item,
                attempts,
                act.error ?? 'scroll was not dispatched',
                observation.screen,
                await shoot(item),
                undefined,
                false,
                false,
              );
          }
          if (!found && replayMiss) throw replayMiss;
          if (!found && unsure) throw unresolvedText(item.until.quoted!);
          if (!found) usable(observation, item, deadline);
          const shot = await shoot(item);
          if (found) {
            emit({
              ...base(item, Math.max(attempts, 1)),
              ...(shot ? { screenshot: shot } : {}),
              ...targetSelector(item.until, observation),
              outcome: 'pass',
            });
            continue items;
          }
          const reason = `"${item.until.phrase}" did not come into view after ${SCROLL_ATTEMPTS} scrolls`;
          return withCause(
            judged(
              failed(
                item,
                Math.max(attempts, 1),
                reason,
                observation.screen,
                shot,
                undefined,
                false,
                'TARGET_NOT_FOUND',
              ),
              observation.screen,
            ),
            'scroll_target_absent',
          );
        }

        // press · fill · back · dialog: snapshot → resolve → act → read-back → snapshot → diff rule
        let outcome: WalkOutcome | undefined;
        let fellBack = false;
        let fillIdentity: string | undefined;
        let typedUnverified = false;
        let again = false;
        let scrolled = 0;
        let scrollOrigin: NonNullable<
          WalkerTimingDiagnostic['clearanceDiagnostic']
        >['scrollOrigin'] = null;
        let scrollDirection: 'up' | 'down' | null = null;
        let refusedIdentity: Element | undefined;
        let moved: { target: Element; error: string } | undefined;
        // Plain-scroll attempts that dispatched cleanly onto complete, unchanged app captures.
        let stillScrolls = 0;
        let overflowScrolls = 0;
        let scrollRefused = false;
        let settledFrame: string | undefined;
        let keyboardAttempted = false;
        const centreChanged = (current: Element | undefined): boolean | null => {
          const originalFrame = refusedIdentity && elementFrame(refusedIdentity);
          const currentFrame = current && elementFrame(current);
          const centres =
            originalFrame && currentFrame
              ? [
                  originalFrame.x + originalFrame.width / 2,
                  originalFrame.y + originalFrame.height / 2,
                  currentFrame.x + currentFrame.width / 2,
                  currentFrame.y + currentFrame.height / 2,
                ]
              : undefined;
          return centres?.every(Number.isFinite)
            ? centres[0] !== centres[2] || centres[1] !== centres[3]
            : null;
        };
        const captureBeforeDispatch = (): Promise<Observation> =>
          (item.kind === 'press' || item.kind === 'fill') &&
          (scrolled || sequence.momentum || fillIdentity !== undefined)
            ? settledCapture(item)
            : capture(item);
        const maxAttempts = recovered.has(item) || opts.singleAttempt ? 1 : 2;
        for (let attempt = 1; attempt <= maxAttempts && !outcome; attempt += 1) {
          interruptionWithheld = undefined;
          currentAttempt = attempt;
          pressAct = undefined;
          pressSelector = undefined;
          pressNeedsReadback = false;
          overlayRows.delete(item.line);
          scrollBands.delete(item.line);
          let plainBand: PlainScrollBand | undefined;
          const { coveredBy: _previousCover, ...selectionFacts } = targetRows.get(item.line) ?? {};
          targetRows.set(item.line, selectionFacts);
          coverGaps.delete(item.line);
          coverTargets.delete(item.line);
          let selectionTarget: Element | undefined;
          let selectionDeadline = Infinity;
          let selectionStartedAt = 0;
          const settling = (item.kind === 'press' || item.kind === 'fill') && sequence.momentum;
          const held = cached?.item === item && !settling ? cached : undefined;
          let before: Observation;
          if (moved && item.kind !== 'scroll' && item.kind !== 'back' && item.kind !== 'dialog') {
            const settled = await settledTarget(item, moved.target);
            if ('frames' in settled) {
              outcome = failed(
                item,
                attempt,
                [
                  `${moved.error}; the target (`,
                  {
                    app: identityText(moved.target),
                    ...(concealsScreen(latest) ? { withheld: MASK } : {}),
                  },
                  `) did not settle across ${settled.frames.length} captures (${settled.frames.join(' | ')}); it was not dispatched again`,
                ],
                latest,
                await shoot(item),
              );
              break;
            }
            before = settled.observation;
            settledFrame = settled.frame;
          } else {
            before = held?.observation ?? (await captureBeforeDispatch());
            if (held?.needsLabelProvenance) before = await enrichLabelProvenance(before, item);
          }
          cached = undefined;
          const next = block.items[block.items.indexOf(item) + 1];
          if (
            attempt > 1 &&
            item.kind !== 'dialog' &&
            before.screen.front === 'dialog' &&
            next?.kind === 'dialog'
          ) {
            const shot = await shoot(item);
            emit({
              ...base(item, attempt),
              ...(shot ? { screenshot: shot } : {}),
              outcome: 'pass',
              reason: redact(
                'the previous attempt took effect after its readback: a system dialog is in front, and the next step owns it',
              ),
            });
            continue items;
          }
          let ref: string | undefined;
          let element: Element | undefined;
          let initial = held?.decision;
          let freshness = attempt === 1 ? 1 : 0;
          let occluded: 'up' | 'down' | undefined;
          // Set once a clearance scroll left an inferred overlay: the press goes out live-hit-strict.
          let liveHit: Readonly<CentreCoverageDiagnostic> | undefined;
          // The centre verdict that asked for the clearance scroll.
          let clearanceCoverage: Readonly<CentreCoverageDiagnostic> | null = null;
          let clearance: number | undefined;
          let within: NativeNode['rect'];
          let scrollNeedsReadback = false;
          let scrollError: string | undefined;
          let scrollPresenceRead = false;
          // The target that settled after this attempt's keyboard dismissal; the tap goes to it or nowhere.
          let keyboardBound: { target: Element; frame: string; scrolled: number } | undefined;
          let act: ActResult;
          for (;;) {
            try {
              usable(before, item);
              if (item.kind === 'press' || item.kind === 'fill') {
                if (item.target.quoted === undefined) resolvedBy = 'jev';
                const decision = refusedIdentity
                  ? {
                      resolvedBy,
                      target: bindDispatchIdentity(item, before.screen, refusedIdentity),
                    }
                  : await decide(before, undefined, item, Infinity, initial);
                initial = undefined;
                resolvedBy = decision.resolvedBy === 'jev' ? 'jev' : resolvedBy;
                const binding =
                  item.kind === 'fill' &&
                  fillIdentity !== undefined &&
                  refusedIdentity === undefined
                    ? bindFillIdentity(item, before.screen, fillIdentity)
                    : undefined;
                const prepared: Resolution =
                  occluded !== undefined
                    ? { scroll: occluded }
                    : refusedIdentity !== undefined
                      ? decision.target!
                      : fillIdentity !== undefined
                        ? binding?.kind === 'strict'
                          ? binding.strict
                          : {
                              refuse: 'TARGET_NOT_FOUND',
                              reason: 'the original input identity no longer resolves uniquely',
                            }
                        : decision.target!;
                const decided = await probeDuplicates(item, before, prepared);
                targetRows.set(item.line, {
                  ...targetRows.get(item.line),
                  ...('collapsed' in decided && decided.collapsed
                    ? { collapsed: decided.collapsed }
                    : {}),
                  ...('candidateExclusions' in decided && decided.candidateExclusions
                    ? { candidateExclusions: decided.candidateExclusions }
                    : {}),
                });
                occluded = undefined;
                let resolution: Exclude<Resolution, { refuse: string }>;
                if ('refuse' in decided) {
                  // A stored testID can name a field only React lists, or none: both reach the walk's fallbacks.
                  const unresolved =
                    decided.refuse === 'TARGET_NOT_FOUND' || decided.refuse === 'REPLAY_SELECTOR';
                  const fallback =
                    unresolved &&
                    item.kind === 'fill' &&
                    deps.typeFocused &&
                    !fellBack &&
                    refusedIdentity === undefined
                      ? keyboardFallbackTarget(item, before.screen)
                      : undefined;
                  if (
                    !fallback &&
                    item.kind === 'fill' &&
                    unresolved &&
                    item.target.quoted !== undefined &&
                    item.target.exact !== 'text' &&
                    before.screen.keyboardVisible === true &&
                    deps.typeFocused &&
                    deps.reactFocused &&
                    !fellBack &&
                    refusedIdentity === undefined
                  ) {
                    fellBack = true;
                    const proven = await typeIntoProvenFocus(item, attempt, before);
                    if (proven === 'typed') {
                      typedUnverified = true;
                      break;
                    }
                    if (proven) {
                      outcome = proven;
                      break;
                    }
                  }
                  if (!fallback || item.kind !== 'fill')
                    throw new ResolutionError(
                      keyboardBound
                        ? { ...decided, reason: `${decided.reason}${KEYBOARD_DISMISSED}` }
                        : decided,
                    );
                  fellBack = true;
                  fillIdentity = fallback.oracleTestID;
                  const result = await keyboardFallback(
                    item,
                    attempt,
                    before,
                    fallback,
                    !!scrolled,
                  );
                  if (result === 'typed') {
                    typedUnverified = true;
                    break;
                  }
                  if ('block' in result) {
                    outcome = result;
                    break;
                  }
                  scrolled ||= Number(result.scrolled);
                  before = result.observation;
                  fillIdentity = result.identity;
                  resolution = result;
                } else resolution = decided;
                if ('scroll' in resolution) {
                  // Only a visible decline hints at an interruption worth one presence read before scrolling.
                  if (
                    !scrollPresenceRead &&
                    !before.platformPresence &&
                    before.screen.elements.some((e) => !e.offscreen && isDeclineLabel(e.label)) &&
                    reactOnlyTarget(item.target, before.screen)
                  ) {
                    scrollPresenceRead = true;
                    const proven = await presenceRecapture(
                      item,
                      Math.min(itemDeadline ?? Infinity, deps.now() + NATIVE_PRESENCE_BUDGET_MS),
                    );
                    if (proven) {
                      before = proven;
                      continue;
                    }
                    interruptionWithheld = {
                      item,
                      clause:
                        '; a decline control was visible, but the presence read for it was late or incomplete',
                    };
                    if (!observationUsable(before.timing, deps.now())) {
                      before = await captureBeforeDispatch();
                      continue;
                    }
                  }
                  // Scrolling would move the interruption, not the target behind it.
                  if (
                    (item.kind === 'press' || item.kind === 'fill') &&
                    targetBehindInterruption(before.screen, item.target)
                  ) {
                    const covered = `"${item.target.phrase}" is mounted behind a presented modal; it was not scrolled`;
                    const recovering = await recovery(
                      item,
                      attempt,
                      covered,
                      undefined,
                      'covered-target',
                    );
                    if (recovering === 'accepted') continue items;
                    if (recovering === 'retry') again = true;
                    else
                      outcome =
                        recovering ??
                        failed(
                          item,
                          attempt,
                          covered,
                          before.screen,
                          await shoot(item),
                          undefined,
                          false,
                          'TARGET_NOT_FOUND',
                        );
                    break;
                  }
                  if (
                    scrolled &&
                    (resolution.origin !== 'named-offscreen' ||
                      scrollOrigin !== 'offscreen-resolution' ||
                      scrolled >= SCROLL_ATTEMPTS)
                  ) {
                    outcome = failed(
                      item,
                      attempt,
                      `${scrollError ? `${scrollError}; ` : ''}"${item.target.phrase}" stayed off screen after ${scrolled === 1 ? 'one scroll' : `${scrolled} scrolls`}${await coverText(item)}`,
                      before.screen,
                      await shoot(item),
                      undefined,
                      false,
                      'TARGET_NOT_FOUND',
                    );
                    coverDecision(item, before, {
                      predicate: null,
                      scrollOrigin,
                      requestedDirection: scrollDirection,
                      targetCentreChanged: null,
                    });
                    break;
                  }
                  const distance =
                    clearance ??
                    (resolution.element && keyboardClearance(resolution.element, before.screen));
                  const band =
                    within ??
                    (resolution.element && clearanceBand(resolution.element, before.screen));
                  clearance = undefined;
                  within = undefined;
                  scrollOrigin ??= 'offscreen-resolution';
                  scrollDirection = resolution.scroll;
                  if (before.screen.front === 'dialog') throw dialogInFront(item.target.phrase);
                  const preScroll = before;
                  const gaps = (screen: Screen) =>
                    (item.kind === 'fill' ? screen.fillGapCount : screen.pressGapCount) ?? 0;
                  const result = await mutate(item, before, (context) =>
                    deps.scroll(resolution.scroll, context, distance, band),
                  );
                  scrolled += 1;
                  scrollNeedsReadback = !result.ok && !result.proven;
                  scrollError = result.ok
                    ? undefined
                    : (result.error ?? 'scroll was not dispatched');
                  const signature = screenSignature(before.screen);
                  before = await settledCapture(item);
                  usable(before, item);
                  const landed = resolution.element
                    ? before.screen.elements.find((e) => sameIdentity(e, resolution.element!))
                    : undefined;
                  if (
                    landed?.semantic?.visibility === 'unknown' ||
                    gaps(before.screen) > gaps(preScroll.screen) ||
                    (before.screen.semanticUnassociatedReact ?? 0) >
                      (preScroll.screen.semanticUnassociatedReact ?? 0)
                  )
                    throw new EvidenceExpired(false);
                  const clearing = scrollOrigin === 'centre-covered' ? clearanceCoverage : null;
                  // A refused clearance drag moved nothing; an inferred iOS overlay still goes to the live hit read.
                  if (
                    !result.ok &&
                    result.mutation === 'none' &&
                    item.kind === 'press' &&
                    deps.platform === 'ios' &&
                    inferredOverlay(clearing)
                  ) {
                    scrollNeedsReadback = false;
                    continue;
                  }
                  if (
                    (resolution.origin === 'named-offscreen' || (!result.ok && !result.proven)) &&
                    screenSignature(before.screen) === signature
                  ) {
                    outcome = failed(
                      item,
                      attempt,
                      `${scrollError ? `${scrollError}; ` : ''}"${item.target.phrase}" stayed off screen after ${scrolled === 1 ? 'one scroll' : `${scrolled} scrolls`}${await coverText(item)}${cutterText(clearing)}${unaskedLiveHit(item.kind, deps.platform, clearing)}`,
                      before.screen,
                      await shoot(item),
                      undefined,
                      false,
                      'TARGET_NOT_FOUND',
                    );
                    if (clearing)
                      diagnostic(
                        item,
                        before,
                        'decision',
                        'CENTRE_COVERED',
                        undefined,
                        undefined,
                        undefined,
                        {
                          predicate: clearing,
                          scrollOrigin,
                          requestedDirection: scrollDirection,
                          targetCentreChanged: null,
                          // The unchanged screen keeps the pre-scroll observation's cover fact.
                          coverGap: coverGaps.get(item.line) ?? null,
                        },
                      );
                    else
                      coverDecision(item, before, {
                        predicate: null,
                        scrollOrigin,
                        requestedDirection: scrollDirection,
                        targetCentreChanged: null,
                      });
                    break;
                  }
                  scrollNeedsReadback = false;
                  continue;
                }
                ref = resolution.ref;
                element = resolution.element;
              }
              // A clearance scroll moves the settled target; its identity and settling are then re-proven by refusedIdentity and settledCapture.
              if (
                moved !== undefined &&
                settledFrame !== undefined &&
                !scrolled &&
                (element === undefined ||
                  !sameIdentity(element, moved.target) ||
                  frameKey(element) !== settledFrame)
              ) {
                outcome = failed(
                  item,
                  attempt,
                  [
                    `${moved.error}; the retry resolved `,
                    ...(element
                      ? [
                          {
                            app: identityText(element),
                            ...(concealsScreen(before.screen) ? { withheld: MASK } : {}),
                          },
                          ` at ${frameKey(element) ?? 'no frame'}`,
                        ]
                      : ['no element']),
                    ', not the target that settled (',
                    {
                      app: identityText(moved.target),
                      ...(concealsScreen(before.screen) ? { withheld: MASK } : {}),
                    },
                    ` at ${settledFrame}); it was not dispatched`,
                  ],
                  before.screen,
                  await shoot(item),
                  ref,
                );
                break;
              }
              if (
                keyboardBound &&
                (element === undefined ||
                  !sameIdentity(element, keyboardBound.target) ||
                  (scrolled === keyboardBound.scrolled &&
                    frameKey(element) !== keyboardBound.frame))
              ) {
                outcome = failed(
                  item,
                  attempt,
                  [
                    'the step resolved ',
                    ...(element
                      ? [
                          {
                            app: identityText(element),
                            ...(concealsScreen(before.screen) ? { withheld: MASK } : {}),
                          },
                          ` at ${frameKey(element) ?? 'no frame'}`,
                        ]
                      : ['no element']),
                    ', not the target that settled (',
                    {
                      app: identityText(keyboardBound.target),
                      ...(concealsScreen(before.screen) ? { withheld: MASK } : {}),
                    },
                    ` at ${keyboardBound.frame}); it was not dispatched${KEYBOARD_DISMISSED}`,
                  ],
                  before.screen,
                  await shoot(item),
                  ref,
                );
                break;
              }
              if (
                item.kind === 'press' &&
                deps.platform === 'ios' &&
                deps.dismissKeyboard &&
                !keyboardAttempted &&
                before.screen.keyboardVisible === true &&
                element !== undefined &&
                selectionPressCandidate(element, before.screen)
              ) {
                keyboardAttempted = true;
                const target = element;
                const dismissal: { via: 'native-control' | 'js' | 'none' } = { via: 'none' };
                await mutate(item, before, async (context) => {
                  dismissal.via = await deps.dismissKeyboard!(context);
                  return { ok: true, proven: false };
                });
                const settled = await settledTarget(item, target, { nativeOnly: true });
                if ('frames' in settled) {
                  outcome = failed(
                    item,
                    attempt,
                    [
                      'the target (',
                      {
                        app: identityText(target),
                        ...(concealsScreen(latest) ? { withheld: MASK } : {}),
                      },
                      `) did not settle across ${settled.frames.length} captures (${settled.frames.join(' | ')}); it was not dispatched; keyboard after dismissal: ${latest.keyboardVisible === true ? 'visible' : latest.keyboardVisible === false ? 'hidden' : 'unknown'}${KEYBOARD_DISMISSED}`,
                    ],
                    latest,
                    await shoot(item),
                  );
                  break;
                }
                before = settled.observation;
                if (dismissal.via !== 'none' && before.screen.keyboardVisible !== true)
                  keyboardCleared = dismissal.via;
                deps.note?.(
                  `keyboard-clearance ${JSON.stringify({ line: item.line, via: dismissal.via, hidden: before.screen.keyboardVisible === false })}`,
                );
                keyboardBound = { target, frame: settled.frame, scrolled };
                initial = undefined;
                continue;
              }
              let strictFillFocus = false;
              let centreDiagnostic: Readonly<CentreCoverageDiagnostic> | null = null;
              const centreIsCovered =
                (item.kind === 'press' || item.kind === 'fill') &&
                element !== undefined &&
                centreCovered(element, before.screen, (facts) => {
                  centreDiagnostic = facts;
                });
              const overlay = centreIsCovered ? inferredOverlay(centreDiagnostic) : undefined;
              // Name the view that takes the target's touch before any tap; never the inferred band cutter.
              const cover =
                (item.kind === 'press' || item.kind === 'fill') && element
                  ? coverOwner(element, before.screen)
                  : undefined;
              recordCover(item.line, cover);
              if (cover && element) coverTargets.set(item.line, element);
              else coverTargets.delete(item.line);
              // List order is not paint order: an inferred overlay alone never refuses an iOS press.
              if (
                item.kind === 'fill' &&
                element &&
                deps.platform === 'ios' &&
                inferredOverlayCoverage(element, before.screen)
              ) {
                if ((await probeOverlay(item, before, element)) !== 'hittable') {
                  outcome = failed(
                    item,
                    attempt,
                    `"${item.target.phrase}" ${INFERRED_FILL_UNAVAILABLE}${await coverText(item)}${cutterText(centreDiagnostic)}`,
                    before.screen,
                    await shoot(item),
                    ref,
                    false,
                    'TARGET_NOT_FOUND',
                  );
                  coverDecision(item, before, {
                    predicate: centreDiagnostic,
                    scrollOrigin,
                    requestedDirection: scrollDirection,
                    targetCentreChanged: centreChanged(element),
                  });
                  break;
                }
                strictFillFocus = true;
              } else if (scrolled && overlay && item.kind === 'press' && deps.platform === 'ios')
                liveHit = overlay;
              else if (centreIsCovered && element !== undefined) {
                if (scrolled) {
                  outcome = failed(
                    item,
                    attempt,
                    `"${item.target.phrase}" ${OFF_SCREEN_AFTER_SCROLL}${await coverText(item)}${cutterText(centreDiagnostic)}${unaskedLiveHit(item.kind, deps.platform, centreDiagnostic)}`,
                    before.screen,
                    await shoot(item),
                    ref,
                    false,
                    'TARGET_NOT_FOUND',
                  );
                  diagnostic(
                    item,
                    before,
                    'decision',
                    'CENTRE_COVERED',
                    undefined,
                    undefined,
                    undefined,
                    {
                      predicate: centreDiagnostic,
                      scrollOrigin,
                      requestedDirection: scrollDirection,
                      targetCentreChanged: centreChanged(element),
                      coverGap: coverGaps.get(item.line) ?? null,
                    },
                  );
                  break;
                }
                refusedIdentity = element;
                clearanceCoverage = centreDiagnostic;
                occluded = clearanceScroll(element, before.screen);
                scrollOrigin = 'centre-covered';
                clearance = keyboardClearance(element, before.screen);
                within = clearanceBand(element, before.screen);
                continue;
              }
              const privateValue = item.kind === 'fill' && secretFill(item, element);
              if (item.kind === 'fill' && element && isPrivateInput(element)) {
                privacy.concealFallback(
                  fillText(item),
                  {
                    secure: element.secure,
                    protectedValue: !(
                      (item.input === undefined || item.sensitivity === 'non-secret') &&
                      !privateValue &&
                      privateInputCause(element) === 'label-may-be-value'
                    ),
                  },
                  element.testID ?? element.label,
                );
                recordMediaLatch(privacy, sequence, deps, line);
                if (item.input === undefined && !privateFills.includes(item.line))
                  privateFills.push(item.line);
              }
              if (item.kind === 'fill') currentInputs()?.expectEcho(element?.testID, item.input);
              if (
                (item.kind === 'scroll' || item.kind === 'back') &&
                before.screen.front === 'dialog'
              )
                throw dialogInFront();
              if (item.kind === 'press' && !pixelBaselineTaken) {
                const target = element && pixelTarget(before.screen, element);
                if (target) {
                  const shot = await pixelShot(item, target);
                  if (!shot.stable) throw new QaDispatchError('TARGET_MOVED_BEFORE_DISPATCH');
                  if (shot.observation) {
                    before = shot.observation;
                    element = pixelTarget(before.screen, target.target)!.target;
                    ref = element.ref;
                  }
                  if (shot.crop) pixelBaseline = { target, crop: shot.crop };
                }
                pixelBaselineTaken = true;
              }
              selectionTarget =
                item.kind === 'press' &&
                deps.platform === 'ios' &&
                element &&
                selectionPressCandidate(element, before.screen)
                  ? element
                  : undefined;
              if (selectionTarget) {
                selectionDeadline = observationDeadline(before.timing);
                selectionStartedAt = deps.now();
              }
              if (item.kind === 'scroll') {
                plainBand = plainScrollBand(before.screen, item.direction, deps.platform);
                if (plainBand.unproven) {
                  const proven = await presenceRecapture(item);
                  if (proven) {
                    plainBand = plainScrollBand(proven.screen, item.direction, deps.platform);
                    before = proven;
                    if (before.screen.front === 'dialog') throw dialogInFront();
                  }
                }
                const {
                  container: _container,
                  distance: _distance,
                  unproven: _unproven,
                  ...receipt
                } = plainBand;
                scrollBands.set(item.line, receipt);
                if (plainBand.status === 'unreachable') {
                  outcome = withCause(
                    failed(
                      item,
                      attempt,
                      'SCROLL_CONTAINER_UNREACHABLE: the scroll view on screen is covered by a fixed element, so a drag cannot reach it',
                      before.screen,
                      await shoot(item),
                    ),
                    'scroll_container_unreachable',
                  );
                  if (outcome.failure)
                    outcome.failure.suggestion =
                      'the scroll view is hidden behind a fixed element at this text size or state; use `Scroll down until <target>` so the walk reports the covering element, or remove the step';
                  break;
                }
              }
              act = await mutate(item, before, async (context) => {
                if (item.kind === 'press') {
                  pressBase = before.screen;
                  pressSelector =
                    exactSelector(item.target) ?? (element ? elementSelector(element) : undefined);
                  pressDispatch = pressRecord(before.screen, element);
                  return liveHit
                    ? deps.press(ref!, context, { requireLiveHit: true })
                    : deps.press(ref!, context);
                }
                return item.kind === 'fill'
                  ? deps.fill(
                      ref!,
                      fillText(item),
                      context,
                      secretFill(item),
                      () => promoteFill(item, element?.testID),
                      item.alwaysRetype,
                      fillOptions(
                        strictFillFocus,
                        element && !element.testID && !element.label
                          ? element.placeholder
                          : undefined,
                      ),
                    )
                  : item.kind === 'scroll'
                    ? deps.scroll(
                        item.direction,
                        context,
                        plainBand?.distance,
                        plainBand?.container ? plainBand.band : undefined,
                      )
                    : item.kind === 'back'
                      ? deps.back(context)
                      : deps.dialog(item.action, context);
              });
              if (item.kind === 'press') {
                pressAct = act;
                pressNeedsReadback =
                  !!selectionTarget || (!!element && insideAlert(element) && !act.proven);
              }
              if (item.kind === 'fill') fillMethod = act.method ?? 'keyboard';
              if (
                strictFillFocus &&
                !act.ok &&
                act.mutation === 'none' &&
                /^(LIVE_HIT_UNPROVEN|RN_FAST_RUNNER_STALE|FOCUS_TARGET_OCCLUDED):/.test(
                  act.error ?? '',
                )
              ) {
                outcome = failed(
                  item,
                  attempt,
                  `${act.error ?? 'LIVE_HIT_UNPROVEN'}${await coverText(item)}${cutterText(centreDiagnostic)}; no focus or typing was performed`,
                  before.screen,
                  await shoot(item),
                  ref,
                  false,
                  'TARGET_NOT_FOUND',
                );
                coverDecision(item, before, {
                  predicate: centreDiagnostic,
                  scrollOrigin,
                  requestedDirection: scrollDirection,
                  targetCentreChanged: centreChanged(element),
                });
                break;
              }
              // Not hittable, unavailable, ambiguous, expired or moved: the inferred overlay refuses.
              if (liveHit && item.kind === 'press' && !act.ok && act.mutation === 'none') {
                outcome = failed(
                  item,
                  attempt,
                  `${scrollError ? `${scrollError}; ` : ''}"${item.target.phrase}" ${OFF_SCREEN_AFTER_SCROLL}${await coverText(item)}${cutterText(liveHit)}; the live hit read refused the press (${liveHitRefusal(act.error)}); no tap was performed`,
                  before.screen,
                  await shoot(item),
                  ref,
                  false,
                  'TARGET_NOT_FOUND',
                );
                diagnostic(
                  item,
                  before,
                  'decision',
                  'CENTRE_COVERED',
                  undefined,
                  undefined,
                  undefined,
                  {
                    predicate: liveHit,
                    scrollOrigin,
                    requestedDirection: scrollDirection,
                    targetCentreChanged: centreChanged(element),
                    coverGap: coverGaps.get(item.line) ?? null,
                  },
                );
                break;
              }
              if (!act.ok && act.ambiguous) {
                outcome = failed(
                  item,
                  attempt,
                  act.error ?? 'TARGET_AMBIGUOUS',
                  before.screen,
                  undefined,
                  ref,
                  false,
                  'TARGET_AMBIGUOUS',
                );
                break;
              }
              if (
                !act.ok &&
                act.mutation === 'none' &&
                act.error?.startsWith('OUTSIDE_APP_WINDOW:')
              ) {
                outcome = failed(
                  item,
                  attempt,
                  `${act.error}; a system dialog button is tapped only by a dialog step`,
                  before.screen,
                  await shoot(item),
                  ref,
                );
                break;
              }
              if (
                (item.kind === 'press' || item.kind === 'fill') &&
                element !== undefined &&
                !act.ok &&
                act.mutation === 'none' &&
                act.error?.startsWith('FOCUS_TARGET_OCCLUDED:')
              ) {
                if (scrolled) {
                  outcome = failed(
                    item,
                    attempt,
                    `${act.error}; "${item.target.phrase}" stayed off screen after one scroll${await coverText(item)}`,
                    before.screen,
                    await shoot(item),
                    ref,
                    false,
                    'TARGET_NOT_FOUND',
                  );
                  coverDecision(item, before, {
                    predicate: null,
                    scrollOrigin,
                    requestedDirection: scrollDirection,
                    targetCentreChanged: centreChanged(element),
                  });
                  break;
                }
                refusedIdentity = element;
                occluded = clearanceScroll(element, before.screen);
                within = clearanceBand(element, before.screen);
                scrollOrigin = 'native-occlusion';
                continue;
              }
              if (
                item.kind === 'fill' &&
                item.target.quoted !== undefined &&
                !item.target.exact &&
                element !== undefined &&
                !isNativeInput(element) &&
                !act.ok &&
                act.mutation === 'none' &&
                act.error?.startsWith('NO_TEXT_INPUT_TARGET:') &&
                deps.typeFocused &&
                !fellBack
              ) {
                fellBack = true;
                const targetID = element?.testID;
                const identity = focusIdentityOf(before.screen, element);
                if (
                  !targetID ||
                  !identity ||
                  before.screen.elements.filter((e) => e.testID === targetID).length !== 1
                ) {
                  outcome = failed(item, attempt, act.error, before.screen, undefined);
                  break;
                }
                before = await captureBeforeDispatch();
                const binding = bindFillIdentity(item, before.screen, identity);
                const fallback = binding?.kind === 'fallback' ? binding.fallback : undefined;
                if (!fallback) {
                  outcome = failed(
                    item,
                    attempt,
                    `${act.error}; no unique eligible keyboard fallback target after the strict refusal; nothing was typed`,
                    before.screen,
                    undefined,
                    undefined,
                    false,
                    'TARGET_NOT_FOUND',
                  );
                  break;
                }
                fillIdentity = fallback.oracleTestID;
                const result = await keyboardFallback(item, attempt, before, fallback, !!scrolled);
                if (result === 'typed') {
                  typedUnverified = true;
                  break;
                }
                if ('block' in result) {
                  outcome = result;
                  break;
                }
                scrolled ||= Number(result.scrolled);
                before = result.observation;
                fillIdentity = result.identity;
                continue;
              }
              break;
            } catch (error) {
              if (isAbort(error)) throw error;
              if (error instanceof EvidenceExpired && scrollNeedsReadback)
                throw new QaDispatchError('ACTION_OUTCOME_UNCERTAIN');
              if (!(error instanceof EvidenceExpired) || freshness-- <= 0) throw error;
              metric('refresh', before);
              before = await captureBeforeDispatch();
              initial = undefined;
            }
          }
          if (outcome || typedUnverified || again) break;
          const readback = () =>
            captureOnce(item, false, false, before.platformPresence ? 'provenance' : 'resolve');
          let after: Observation;
          let selectionProven = false;
          let selectionExited = false;
          if (selectionTarget && !(!act!.ok && act!.mutation === 'none')) {
            const targetPresent = (screen: Screen): boolean =>
              screen.elements.some((candidate) => sameIdentity(candidate, selectionTarget!));
            // After a clean dispatch a testID binds its one native control whatever its positional ref;
            // React-only leftovers are not that control. An unclean press keeps the strict same-ref rule.
            const clean = act!.ok && !act!.error;
            const boundTarget = (screen: Screen): Element | undefined => {
              const matches = screen.elements.filter(
                (candidate) =>
                  sameIdentity(candidate, selectionTarget!) &&
                  !(clean && candidate.ref.startsWith('react:')),
              );
              return matches.length === 1 &&
                (matches[0].ref === selectionTarget!.ref ||
                  (clean && selectionTarget!.testID !== undefined))
                ? matches[0]
                : undefined;
            };
            let observed: Observation | undefined;
            let current: Element | undefined;
            let captures: 1 | 2 = 1;
            const evidence = (): PressEvidence => ({
              subreason: current ? 'selection_unverified' : 'target_identity_unavailable',
              heldPress: 'not_tried_unsafe',
              outsideTargetChange:
                observed !== undefined &&
                outsideTargetChange(before.screen, observed.screen, selectionTarget!, current),
              captures,
            });
            const refusePress = (code: string, message: string): WalkOutcome => {
              const pressEvidence = evidence();
              deps.pressReadback?.(pressEvidence);
              emit({
                ...base(item, attempt),
                outcome: 'fail',
                reason: message,
              });
              return {
                block: { key: block.slug, outcome: 'fail', source: 'discovered' },
                rows,
                ...(privateFills.length ? { privateFills } : {}),
                ...(recoveries ? { recoveries } : {}),
                failure: { step: item.line, seen: message },
                refusal: { code, message },
                pressEvidence,
              };
            };
            try {
              deps.pressReadback?.(evidence());
              observed = await withDeadline(
                performance.now() + Math.max(0, selectionDeadline - deps.now()),
                new EvidenceExpired(true),
                readback,
              );
              usable(observed, item, selectionDeadline);
              current = boundTarget(observed.screen);
              if (!act!.proven && targetPresent(observed.screen) && current?.selected !== true) {
                deps.pressReadback?.(evidence());
                observed = await withDeadline(
                  performance.now() + Math.max(0, selectionDeadline - deps.now()),
                  new EvidenceExpired(true),
                  () => {
                    captures = 2;
                    deps.pressReadback?.(evidence());
                    return readback();
                  },
                );
                usable(observed, item, selectionDeadline);
                current = boundTarget(observed.screen);
              }
            } catch (error) {
              if (isAbort(error)) throw error;
              if (error instanceof NativeCaptureError)
                return refusePress(error.code, new NativeCaptureError().message);
              if (error instanceof NativeSnapshotIncomplete) {
                const safe = new NativeSnapshotIncomplete(error.nodes, error.causes);
                return refusePress(safe.code, safe.message);
              }
              if (error instanceof PrivateInputCaptureError)
                return refusePress(error.code, new PrivateInputCaptureError().message);
              if (error instanceof ResolutionError) return refusePress(error.code, error.message);
              if (error instanceof EvidenceExpired)
                return refusePress(
                  error.itemExpired ? 'ITEM_DEADLINE_EXCEEDED' : 'EVIDENCE_EXPIRED',
                  error.message,
                );
              if (error instanceof QaDispatchError) return refusePress(error.code, error.message);
              throw error;
            }
            selectionExited = !targetPresent(observed.screen);
            if (!selectionExited && !act!.proven && current?.selected !== true) {
              return refusePress(
                'PRESS_NOT_REGISTERED',
                `${evidence().outsideTargetChange ? PRESS_OUTSIDE_CHANGE_REASON : PRESS_NOT_REGISTERED_REASON} ${selectionPressGuidance(captures, observed.timing.completedAt - selectionStartedAt, current !== undefined)}`,
              );
            }
            deps.pressReadback?.(undefined);
            after = observed;
            selectionProven = current?.selected === true;
          } else {
            after = await readback();
            usable(after, item);
          }
          // A capture delta cannot stand in for bound selection on these controls.
          let changed =
            selectionTarget && !selectionExited && !(!act!.ok && act!.mutation === 'none')
              ? selectionProven
              : screenSignature(after.screen) !== screenSignature(before.screen);
          const afterTarget = element && after.screen.elements.find((e) => e.ref === element!.ref);
          // shortcut: single-choice and multi-select are indistinguishable from capture evidence; revisit if a role fact lands
          const alreadySelected =
            item.kind === 'press' &&
            !changed &&
            act!.ok &&
            !act!.error &&
            element?.selected === true &&
            afterTarget?.selected === true;
          if (
            !alreadySelected &&
            !changed &&
            item.kind === 'press' &&
            act!.proven === false &&
            pixelBaseline &&
            element
          ) {
            const baseline = pixelBaseline.target;
            const previous = pixelTarget(before.screen, baseline.target);
            const current = pixelTarget(after.screen, baseline.target);
            if (
              sameIdentity(element, baseline.target) &&
              samePixelTarget(previous, baseline) &&
              samePixelTarget(current, baseline)
            ) {
              const first = await pixelShot(item, current!);
              if (first.crop) {
                await deps.sleep(200);
                const second = await pixelShot(item, current!);
                if (second.crop) {
                  const verified = await captureOnce(
                    item,
                    false,
                    false,
                    after.platformPresence ? 'provenance' : 'resolve',
                  );
                  usable(verified, item);
                  if (samePixelTarget(pixelTarget(verified.screen, baseline.target), baseline))
                    changed = stablePixelChange(pixelBaseline.crop, first.crop, second.crop);
                }
              }
            }
          }
          if (postActionObservation) {
            after = postActionObservation;
            changed = true;
          }
          diagnostic(item, after, 'decision', 'ACCEPTED');
          metric('readback', after);
          if (item.kind === 'fill') {
            const target = element;
            act =
              (await stepUpFill(
                item,
                act!,
                target?.testID,
                (screen) =>
                  target !== undefined && screen.elements.some((e) => sameIdentity(e, target)),
              )) ?? act!;
          }
          const shot = postActionTried ? postActionShot : await shoot(item);
          const unverified =
            item.kind === 'fill' &&
            !(act!.ok && act!.proven) &&
            (act!.evidence === 'masked' ||
              act!.evidence === 'unavailable' ||
              act!.evidence === 'case-normalized');
          const recased = item.kind === 'fill' && act!.evidence === 'case-normalized';
          const noMutationRefusal = !act!.ok && act!.mutation === 'none';
          // A refused dialog tap may have pressed something else, so a changed screen never stands in for its proof.
          const dialogRefused = item.kind === 'dialog' && !act!.ok;
          const alertEffect =
            item.kind === 'press' && element && insideAlert(element) && !act!.proven
              ? alertPressEffect(before.screen, after.screen)
              : undefined;
          const alertOnly = alertEffect !== undefined && alertEffect !== 'changed';
          const fillReason = item.kind === 'fill' ? handlerReason(item, act!) : undefined;
          // A changed capture proves a plain scroll only when it dispatched cleanly; proven alone never does.
          const scrollDispatched = act!.ok && !act!.error && act!.executed !== false;
          if (item.kind === 'scroll') {
            const error = act!.error ? `${act!.error}; ` : '';
            if (after.screen.front !== before.screen.front) {
              outcome = withCause(
                failed(
                  item,
                  attempt,
                  `${error}the front changed from ${before.screen.front} to ${after.screen.front} during the scroll; not retrying`,
                  after.screen,
                  shot,
                ),
                'scroll_context_changed',
              );
              break;
            }
            if (!scrollDispatched && act!.mutation !== 'none') {
              outcome = withCause(
                failed(
                  item,
                  attempt,
                  `${act!.error ?? 'the scroll was not proven dispatched'}; the scroll may have moved the screen; not retrying`,
                  after.screen,
                  shot,
                ),
                'scroll_dispatch_failed',
              );
              break;
            }
            const complete = (screen: Screen) =>
              screen.front === 'app' &&
              (screen.captureCoverage?.native ?? screen.coverage?.native) === 'complete';
            if (!scrollDispatched) scrollRefused = true;
            else if (complete(before.screen) && complete(after.screen)) {
              const motion = plainBand?.container
                ? scrollMotion(plainBand.container, before.screen, after.screen, item.direction)
                : 'unknown';
              if (motion === 'moved') changed = true;
              if (!changed) {
                stillScrolls += 1;
                if (motion === 'still-overflow') overflowScrolls += 1;
              }
            }
          }
          if (
            !noMutationRefusal &&
            !dialogRefused &&
            (item.kind === 'fill'
              ? (act!.ok && act!.proven) || unverified
              : item.kind === 'scroll'
                ? scrollDispatched && changed
                : act!.proven || changed || alreadySelected)
          ) {
            const target = stepTarget(item);
            if (act!.dialog)
              deps.note?.(
                `dialog-tap ${JSON.stringify({ v: 1, line: item.line, label: act!.dialog.label, rect: act!.dialog.rect })}`,
              );
            emit({
              ...base(item, attempt),
              ...(ref ? { ref } : {}),
              ...(shot ? { screenshot: shot } : {}),
              ...stored(
                (target && exactSelector(target)) ??
                  (element ? elementSelector(element) : undefined),
              ),
              outcome: 'pass',
              ...(act!.dialog ? { dialog: act!.dialog } : {}),
              ...(fillReason
                ? { reason: redact(fillReason) }
                : unverified && recased
                  ? {
                      reason: redact(
                        'UNVERIFIED_FILL: the field changed only the letter case, so the fill was not verified',
                      ),
                      ...(!currentInputs()?.hasStrictInputs
                        ? { caseNormalized: { chars: [...fillText(item)].length } }
                        : {}),
                    }
                  : unverified
                    ? {
                        reason: redact(
                          `UNVERIFIED_FILL: the field's final value ${act!.evidence === 'masked' ? 'reads back masked' : 'could not be read back'}, so the fill was not verified`,
                        ),
                      }
                    : alreadySelected
                      ? { reason: redact('already selected, no change') }
                      : alertOnly
                        ? {
                            unverifiedPress: true,
                            reason: redact(
                              alertEffect === 'uncaptured'
                                ? 'UNVERIFIED_PRESS: nothing behind the alert or sheet was captured while it was open; any of its buttons closes it, so the press was not verified'
                                : 'UNVERIFIED_PRESS: the alert or sheet closed and nothing behind it changed; any of its buttons closes it, so the press was not verified',
                            ),
                          }
                        : {}),
            });
            break;
          }
          if (dialogRefused && act!.mutation !== 'none') {
            outcome = failed(
              item,
              attempt,
              `${act!.error ?? 'DIALOG_TAP_UNPROVEN: the dialog tap was not proven'}; not retrying`,
              after.screen,
              shot,
              ref,
            );
            break;
          }
          if (item.kind === 'fill' && act!.mutation !== 'none') {
            outcome = failed(
              item,
              attempt,
              `${act!.error ?? 'TEXT_ENTRY_UNVERIFIED: the fill was not verified'}; the fill may have mutated the field; not retrying`,
              after.screen,
              shot,
              ref,
            );
            break;
          }
          // Named, never decisive: a shown keyboard is no pass and a missing one no refusal by itself.
          const noKeyboard = act!.keyboardShown === false ? 'the keyboard did not open; ' : '';
          if (attempt < maxAttempts) {
            if (
              (item.kind === 'press' || item.kind === 'fill') &&
              element !== undefined &&
              act!.mutation === 'none' &&
              act!.error?.startsWith('TARGET_MOVED_BEFORE_DISPATCH')
            )
              moved = { target: element, error: act!.error };
            metric('replay', after);
            emit({
              ...base(item, attempt),
              ...(ref ? { ref } : {}),
              ...(shot ? { screenshot: shot } : {}),
              outcome: 'retry',
              reason: redact(
                `${act!.error ? `${act!.error}; ` : ''}${noKeyboard}${item.kind === 'scroll' && changed ? 'the scroll was not dispatched' : 'the screen did not change'}; retrying once`,
              ),
            });
            continue;
          }
          if (item.kind === 'scroll' && stillScrolls === 2) {
            // No end-of-content detector exists, so this records stillness, never a list boundary.
            emit({
              ...base(item, attempt),
              ...(shot ? { screenshot: shot } : {}),
              outcome: 'pass',
              reason: redact(
                overflowScrolls === 2
                  ? 'two scrolls were dispatched inside the scroll view and nothing moved although content extends beyond it'
                  : SCROLL_NO_VISIBLE_CHANGE,
              ),
              scrollDetail: {
                status:
                  overflowScrolls === 2 ? 'no_visible_change_content_remains' : 'no_visible_change',
                attempts: 2,
              },
            });
            break;
          }
          const unchangedScreen =
            maxAttempts === 1
              ? 'the screen did not change after recovery'
              : 'the screen did not change after two attempts';
          const stillness = settledFrame
            ? `; the target's frame held still at ${settledFrame} before this dispatch`
            : '';
          // Selection evidence only when a capture reports the target selected; the runner never reports "unselected".
          const reported = (e: Element) =>
            e.selected === true ? 'selected' : 'not reported selected';
          const selection =
            item.kind === 'press' &&
            element &&
            afterTarget &&
            (element.selected === true || afterTarget.selected === true)
              ? element.selected === true && afterTarget.selected === true
                ? '; the target stayed selected'
                : `; the target was ${reported(element)} before and ${reported(afterTarget)} after`
              : '';
          const unchanged = act!.error
            ? `${act!.error}; ${noKeyboard}${unchangedScreen}${stillness}${selection}`
            : `${noKeyboard}${unchangedScreen}${stillness}${selection}`;
          const recovering = await recovery(item, attempt, unchanged);
          if (recovering === 'accepted') continue items;
          if (recovering === 'retry') {
            again = true;
            break;
          }
          outcome =
            recovering ??
            (act!.ok && !act!.error
              ? judged(failed(item, attempt, unchanged, after.screen, shot, ref), after.screen)
              : failed(item, attempt, unchanged, after.screen, shot, ref));
          if (item.kind === 'scroll' && scrollRefused && !recovering)
            outcome = withCause(outcome, 'scroll_dispatch_failed');
        }
        if (again) continue attempts;
        if (outcome) return outcome;
        continue items;
      } catch (caught) {
        if (isAbort(caught)) throw caught;
        let error = caught instanceof CaptureDeadline ? new EvidenceExpired(true) : caught;
        // A recovery probe that acts on nothing must not cost a polled step its retry budget.
        const priorRecovery = recovered.has(item) ? { state: recovered.get(item)! } : undefined;
        if (
          error instanceof ResolutionError &&
          !UNRECOVERABLE.has(error.code) &&
          !postActionTried &&
          !deps.cancelled?.()
        ) {
          try {
            // A missing target dismisses only a proven separate surface, never a screen's own Cancel.
            const recovering = await recovery(
              item,
              currentAttempt,
              error.message,
              undefined,
              error.code === 'TARGET_NOT_FOUND' ? 'surface' : undefined,
            );
            if (recovering === 'accepted') continue items;
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
          } catch (recoveryError) {
            if (isAbort(recoveryError)) throw recoveryError;
            error = recoveryError;
          }
        }
        // Only an absent quoted target qualifies; disabled, ambiguous, stored and offscreen misses keep their class.
        const allowance = launchWait;
        if (
          allowance &&
          !stepDispatched &&
          (item.kind === 'press' || item.kind === 'fill') &&
          item.target.quoted !== undefined &&
          error instanceof ResolutionError &&
          error.code === 'TARGET_NOT_FOUND' &&
          error.missing &&
          !deps.cancelled?.()
        ) {
          launchWait = undefined;
          try {
            const observation = await launchTarget(item, allowance.startedAt + WAIT_BUDGET_MS);
            if (observation) {
              // Recovery returned without acting to reach this poll, so restore its state from before the probe.
              if (priorRecovery) recovered.set(item, priorRecovery.state);
              else recovered.delete(item);
              cached = { item, observation };
              continue attempts;
            }
            error = new ResolutionError({
              refuse: LAUNCH_MISS,
              reason: `the first step after launch found its target absent for ${WAIT_BUDGET_MS / 1000} s${preparationResets ? `, the screen changed ${preparationResets} times during the presence read` : ''}`,
              missing: true,
            });
          } catch (pollError) {
            if (isAbort(pollError)) throw pollError;
            error = pollError;
          }
        }
        if (error instanceof RenderError)
          return failed(
            item,
            currentAttempt,
            error.message,
            latest,
            undefined,
            undefined,
            false,
            false,
          );
        if (
          error instanceof NativeSnapshotIncomplete ||
          error instanceof PrivateInputCaptureError ||
          error instanceof NativeCaptureError
        ) {
          const nativeFailure = error instanceof NativeCaptureError;
          const safe = nativeFailure
            ? new NativeCaptureError()
            : error instanceof NativeSnapshotIncomplete
              ? new NativeSnapshotIncomplete(error.nodes, error.causes).withReads(
                  error.reads,
                  error.elapsedMs,
                )
              : new PrivateInputCaptureError();
          const key = nativeFailure ? 'native-capture' : 'private-input-capture';
          emit({
            block: key,
            line: item.line,
            text: safe.message,
            attempt: currentAttempt,
            kind: item.kind === 'check' ? 'check' : 'step',
            resolvedBy,
            t: deps.now(),
            outcome: 'fail',
            reason: safe.code,
          });
          return {
            block: { key, outcome: 'fail', source: 'discovered' },
            rows,
            ...(privateFills.length ? { privateFills } : {}),
            ...(recoveries ? { recoveries } : {}),
            failure: { step: item.line, seen: safe.message },
            refusal: { code: safe.code, message: safe.message },
          };
        }
        if (
          !(error instanceof JevError) &&
          !(error instanceof ResolutionError) &&
          !(error instanceof EvidenceExpired) &&
          !(error instanceof QaDispatchError)
        )
          throw error;
        if (error instanceof JevError) resolvedBy = 'jev';
        const refusal =
          error instanceof JevError && error.isRefusal
            ? { code: error.code, message: error.message }
            : undefined;
        const shot = postActionTried
          ? postActionShot
          : error instanceof QaDispatchError ||
              error instanceof EvidenceExpired ||
              (error instanceof ResolutionError &&
                (error.code === 'APP_PROCESS_CHANGED' ||
                  error.code === 'APP_PROCESS_UNKNOWN' ||
                  (item.kind === 'check' && !item.literal))) ||
              deps.cancelled?.()
            ? undefined
            : refusal
              ? await shoot(item).catch((error) => {
                  if (isAbort(error)) throw error;
                  return undefined;
                })
              : await shoot(item);
        const miss =
          replay &&
          !mutationStarted &&
          item.kind !== 'check' &&
          error instanceof ResolutionError &&
          error.code === 'REPLAY_SELECTOR';
        const resolutionRefusal =
          error instanceof ResolutionError &&
          (error.code === 'APP_PROCESS_UNKNOWN' ||
            error.code === 'SCROLL_NAVIGATED' ||
            error.code.startsWith('DEV_REDBOX_'))
            ? {
                code: error.code,
                // The receipt adds the code itself; an overlay refusal's message must not repeat it.
                message: error.code.startsWith('DEV_REDBOX_')
                  ? error.message.slice(error.code.length + 2)
                  : error.message,
              }
            : undefined;
        const caughtOutcome = failed(
          item,
          currentAttempt,
          error.message,
          latest,
          shot,
          undefined,
          miss,
          error instanceof ResolutionError && TARGET_CODES.has(error.code)
            ? error.code
            : error instanceof EvidenceExpired && error.itemExpired && targetPending
              ? 'TARGET_NOT_FOUND'
              : false,
        );
        return {
          ...(error instanceof ResolutionError && error.missing
            ? judged(caughtOutcome, latest)
            : caughtOutcome),
          ...(refusal || resolutionRefusal ? { refusal: refusal ?? resolutionRefusal } : {}),
        };
      }
    }
  }
  return {
    block: { key: block.slug, outcome: 'pass', source: 'discovered' },
    rows,
    ...(privateFills.length ? { privateFills } : {}),
    ...(recoveries ? { recoveries } : {}),
  };
}

class RenderError extends Error {
  constructor() {
    super('the app is showing a React Native error screen');
  }
}

// The streamed row channel cannot be retracted, so it carries no text, reason, selector or app identifier.
function valueFree(row: Omit<LedgerRow, 'reason'>): LedgerRow {
  const {
    operationId,
    line,
    attempt,
    kind,
    resolvedBy,
    t,
    outcome,
    screenshot,
    timing,
    reactCoverage,
    reactConnections,
  } = row;
  return {
    block: '',
    operationId,
    line,
    text: '',
    attempt,
    kind,
    resolvedBy,
    t,
    outcome,
    ...(row.unverifiedPress ? { unverifiedPress: true } : {}),
    ...(row.method ? { method: row.method } : {}),
    ...(row.keyboardCleared ? { keyboardCleared: row.keyboardCleared } : {}),
    ...(row.implicitWaitMs !== undefined ? { implicitWaitMs: row.implicitWaitMs } : {}),
    ...(row.retryCause ? { retryCause: row.retryCause } : {}),
    ...(row.devError ? { devError: row.devError } : {}),
    ...(row.scrollDetail ? { scrollDetail: row.scrollDetail } : {}),
    ...(row.scrollBand ? { scrollBand: row.scrollBand } : {}),
    ...(row.interruption ? { interruption: row.interruption } : {}),
    ...(row.overlayChecks ? { overlayChecks: row.overlayChecks } : {}),
    ...(row.collapsed ? { collapsed: row.collapsed } : {}),
    ...(row.candidateExclusions ? { candidateExclusions: row.candidateExclusions } : {}),
    ...(row.coveredBy ? { coveredBy: row.coveredBy } : {}),
    ...(row.entryMismatch ? { entryMismatch: row.entryMismatch } : {}),
    ...(row.screenshotWithheld ? { screenshotWithheld: row.screenshotWithheld } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(timing ? { timing } : {}),
    ...(reactCoverage ? { reactCoverage } : {}),
    ...(reactConnections ? { reactConnections } : {}),
  };
}

const processChanged = (): ResolutionError =>
  new ResolutionError({
    refuse: 'APP_PROCESS_CHANGED',
    reason: 'the app restarted or crashed during the run',
  });

function guardAppProcess(guard: WalkerDeps['appProcess'], observed: number | undefined): void {
  if (!guard) return;
  if (guard.expected === undefined) {
    if (observed === undefined)
      throw new ResolutionError({
        refuse: 'APP_PROCESS_UNKNOWN',
        reason:
          'the iOS runner does not report the app process; rebuild it from this checkout (RN_RUNNER_BUILD=local)',
      });
    guard.expected = observed;
    return;
  }
  if (observed !== guard.expected) throw processChanged();
}

export interface BlockStore {
  appRoot: string;
  platform: BlockPlatform;
  appId: string;
}

function storedFor(block: Block, store: BlockStore): StoredBlock | undefined {
  let text: string | null;
  try {
    text = loadBlock(store.appRoot, block.slug);
  } catch (error) {
    if (isAbort(error)) throw error;
    return undefined;
  }
  const stored = text === null ? undefined : readBlock(text);
  return stored && !('invalid' in stored) && storedFits(block, stored, text!, store)
    ? stored
    : undefined;
}

const exact = (selector: Selector): Target =>
  selector.id !== undefined
    ? { quoted: selector.id, phrase: selector.id, exact: 'id' }
    : { quoted: selector.text!, phrase: selector.text!, exact: 'text' };

export function replayBlock(block: Block, stored: StoredBlock): Block {
  return {
    ...block,
    items: block.items.map((item, i): Item => {
      const step = stored.steps[i];
      if (item.kind === 'wait' && item.precondition) return item;
      if (item.kind === 'press' || item.kind === 'fill' || item.kind === 'wait')
        return { ...item, target: exact(step.selector!), declared: item.target };
      if (item.kind === 'scroll' && item.until)
        return { ...item, until: exact(step.until!), declared: item.until };
      return item;
    }),
  };
}

// A saved block replayed on its own, as the login recovery does: every target is its stored identity.
export function loginBlock(slug: string, stored: StoredBlock): Block {
  const items = stored.steps.map((step, i): Item => {
    const at = { line: i + 1, raw: step.raw, source: 'grammar' as const };
    switch (step.kind) {
      case 'press':
      case 'wait':
        return { kind: step.kind, target: exact(step.selector!), ...at };
      case 'fill':
        return {
          kind: 'fill',
          target: exact(step.selector!),
          ...(step.input !== undefined
            ? { input: step.input, ...(step.sensitivity ? { sensitivity: step.sensitivity } : {}) }
            : { text: step.text! }),
          ...(fillLabels(step.raw).flags.anyMethod ? { anyMethod: true as const } : {}),
          ...(step.alwaysRetype ? { alwaysRetype: true as const } : {}),
          ...at,
        };
      case 'scroll':
        return {
          kind: 'scroll',
          direction: step.direction!,
          ...(step.until ? { until: exact(step.until) } : {}),
          ...at,
        };
      case 'back':
        return { kind: 'back', ...at };
      case 'dialog':
        return { kind: 'dialog', action: step.action!, ...at };
      case 'echo':
        return { kind: 'echo', input: step.input!, ...at };
      case 'check':
        return {
          kind: 'check',
          text: step.text ?? step.raw.replace(/^(?:[-*]\s*)?[✓✔]\s*/, ''),
          literal: step.text !== undefined,
          ...at,
        };
    }
  });
  return { slug, title: stored.header.plan, items, planHash: stored.header.planHash };
}

export async function runPlan(
  blocks: Block[],
  deps: WalkerDeps,
  preflightCalls: readonly JevCall[] = [],
  store?: BlockStore,
  title?: string,
): Promise<WalkResult> {
  return measureTiming(deps.timing, deps.now, 'walk', async () => {
    const walking = withRowTiming(deps);
    const results: BlockResult[] = [];
    const steps: WalkRow[] = [];
    const written: string[] = [];
    let patchedAt: number | undefined;
    const typed = blocks.flatMap((b) =>
      b.items.flatMap((i) => (i.kind === 'fill' ? [fillText(i)] : [])),
    );
    const planTyped = typed.length;
    const privacy = deps.privacy ?? new ObservedPrivacy(typed);
    privacy.classify(typed);
    privacy.classify(
      deps.login?.block?.items.flatMap((i) => (i.kind === 'fill' ? [fillText(i)] : [])) ?? [],
    );
    let recoveries = 0;
    const privateFills: number[] = [];
    // A login replay before any plan pass opens the publishable window.
    const videoPublication = (): NonNullable<WalkResult['videoPublication']> =>
      currentInputs()?.hasInputs ||
      blocks.some((block) => block.items.some((item) => item.kind === 'fill')) ||
      typed.length > (sequence.window?.typed ?? planTyped)
        ? 'withheld-fill'
        : (sequence.window ? privacy.windowClean() : privacy.canScreenshot())
          ? 'eligible'
          : 'withheld-privacy';
    const videoPolicy = deps.videoPolicy ?? 'undeclared';
    const secretGate = (): boolean =>
      currentInputs()?.hasStrictInputs === true ||
      blocks.some((block) =>
        block.items.some(
          (item) =>
            item.kind === 'fill' && item.input !== undefined && item.sensitivity !== 'non-secret',
        ),
      );
    const nonStrictPublication = (): 'eligible' | 'withheld-secret' =>
      secretGate() || privacy.secretWindowLatched() ? 'withheld-secret' : 'eligible';
    const videoCause = () =>
      videoPolicy === 'non-strict'
        ? privacy.secretWindowLatched()
          ? { ...privacy.secretWindowLatched()!, line: sequence.latch?.secretWindow?.line ?? 0 }
          : secretGate()
            ? { reason: 'runtime-input' as const, line: 0 }
            : undefined
        : videoPublication() === 'withheld-privacy'
          ? {
              ...(sequence.window ? privacy.windowLatched()! : privacy.latched()!),
              line: sequence.window
                ? (sequence.latch?.windowLine ?? sequence.latch?.line ?? 0)
                : (sequence.latch?.line ?? 0),
            }
          : undefined;
    const calls = (): JevCall[] => [...preflightCalls, ...(deps.judge?.calls ?? [])];
    const sequence: WalkSequence = {
      observation: 0,
      publicationInterrupted: false,
      continuity: [],
      planPassed: false,
      launchWait: true,
    };
    recordMediaLatch(privacy, sequence, deps, 0);
    const walk = async (block: Block, opts?: WalkOptions, operations?: Map<number, number>) => {
      const laterBlocks = blocks.slice(
        blocks.findIndex((planned) => planned.slug === block.slug) + 1,
      );
      const outcome = await walkBlock(
        block,
        walking,
        steps.length,
        typed,
        privacy,
        sequence,
        {
          ...opts,
          laterTargets: laterBlocks.flatMap((later) =>
            later.items.flatMap((item) => {
              const target = recoveryTarget(item);
              return target ? [{ ...target, laterBlock: true }] : [];
            }),
          ),
        },
        operations,
      );
      recoveries += outcome.recoveries ?? 0;
      privateFills.push(...(outcome.privateFills ?? []));
      return outcome;
    };
    const path = (): LedgerPath =>
      patchedAt !== undefined
        ? `replay→walk@${patchedAt}`
        : results.length > 0 && results.every((r) => r.source === 'replayed')
          ? 'replay'
          : 'walk';
    // Saved after the last block, so an earlier block cannot keep a value a later fill made private.
    const pending: { index: number; write: () => BlockResult }[] = [];
    // The slug stays the operational file name (blocksWritten); a display copy that hits is withheld whole.
    const display = (slug: string): string => {
      const values = privacy.privateSet('persisted');
      const origins = deps.login?.block ? [...blocks, deps.login.block] : blocks;
      const privateTitle = origins.some(
        (block) => block.slug === slug && matchPrivate(block.title, values, 'identifier').hit,
      );
      return privateTitle || matchPrivate(slug, values, 'identifier').hit ? MASK : slug;
    };
    const unprotected = (value: string): boolean =>
      !matchPrivate(value, privacy.privateSet('persisted'), 'persisted').hit;
    const render = (reason: Reason): string =>
      renderReason(
        reason,
        (text) => privacy.redact(text),
        currentInputs()?.hasStrictInputs ? INPUT_SCREEN_TEXT_WITHHELD : undefined,
      );
    const finish = (outcome?: WalkOutcome): WalkResult => {
      throwIfInputPrivacyRefused();
      if (!deps.cancelled?.()) {
        cancellationSignal();
        for (const { index, write } of pending.splice(0)) results[index] = write();
      }
      const snapshotInterrupted = deps.publicationInterrupted?.() === true;
      const continuityEvents: ContinuityEvent[] = [];
      let continuityEventsDropped =
        (sequence.continuityEventsDropped ?? 0) + (deps.continuityEventsDropped?.() ?? 0);
      for (const event of [
        ...(sequence.continuity ?? []),
        ...(deps.continuityEvents?.() ?? []),
      ].sort((a, b) => a.atMs - b.atMs))
        continuityEventsDropped += appendContinuityEvent(continuityEvents, event);
      const ledger: WalkResult = {
        ...buildLedger(
          results.map((result) => ({ ...result, key: display(result.key) })),
          steps.map(({ selector, reason, ...row }) => ({
            ...row,
            block: display(row.block),
            text: projectPlanLine(row.text, privacy.privateSet()).text,
            ...(reason !== undefined ? { reason: render(reason) } : {}),
            ...(selector && unprotected(selector.id ?? selector.text ?? '') ? { selector } : {}),
          })),
          outcome?.failure
            ? {
                ...outcome.failure,
                seen: render(outcome.failure.seen),
              }
            : undefined,
          calls(),
          path(),
          recoveries,
        ),
        ...(sequence.optInDeclines?.length ? { declinedOptIns: sequence.optInDeclines } : {}),
        videoPublication: videoPublication(),
        videoPolicy,
        nonStrictPublication: nonStrictPublication(),
        ...(sequence.screenshots || videoCause()
          ? {
              mediaWithheld: {
                ...(sequence.screenshots
                  ? {
                      screenshots: {
                        ...sequence.screenshots.cause,
                        line: sequence.screenshots.line,
                        count: sequence.screenshots.count,
                      },
                    }
                  : {}),
                ...(videoCause() ? { video: videoCause()! } : {}),
              },
            }
          : {}),
        ...(sequence.window ? { publishFromMs: sequence.window.fromMs } : {}),
        publicationInterrupted: sequence.publicationInterrupted || snapshotInterrupted,
        continuityEvents,
        continuityEventsDropped,
      };
      if (ledger.mediaWithheld?.video) {
        try {
          const { line, ...cause } = ledger.mediaWithheld.video;
          deps.mediaWithheld?.({ kind: 'media-withheld', scope: 'video', cause, line });
        } catch {
          // Diagnostics cannot change the walk.
        }
      }
      if (store) ledger.blocksWritten = written;
      if (ledger.verdict === 'PASS' && !outcome?.refusal && !deps.cancelled?.())
        ledger.recipe = privateFills.length
          ? { unsavable: `line ${Math.min(...privateFills)}: fills a private input` }
          : recipeMarkdown(title, blocks, privacy.privateSet('persisted'));
      const refusal = outcome?.refusal ?? (ledger.verdict === 'REFUSED' ? ledger : undefined);
      const captureUnknown =
        sequence.captureUnknown ||
        refusal?.code === 'PRIVATE_INPUT_CAPTURE_UNKNOWN' ||
        refusal?.code === 'NATIVE_SNAPSHOT_INCOMPLETE';
      const { nonStrictPublication: _nonStrict, ...withoutNonStrict } = ledger;
      const publication = captureUnknown
        ? { ...withoutNonStrict, videoPublication: 'unknown' as const }
        : ledger;
      return refusal
        ? {
            ...publication,
            code: refusal.code,
            message: refusal.message,
            ...(outcome?.pressEvidence ? { pressEvidence: outcome.pressEvidence } : {}),
            verdict: 'REFUSED',
          }
        : publication;
    };
    const withPrivateFills = (result: BlockResult, lines: number[] = []): BlockResult =>
      lines.length
        ? {
            ...result,
            saved: false,
            unsavable: `line ${Math.min(...lines)}: fills a private input`,
          }
        : result;
    const save = (
      block: Block,
      rows: WalkRow[],
      source: BlockResult['source'],
      store: BlockStore,
      privateFills: number[] = [],
    ): BlockResult => {
      pending.push({
        index: results.length,
        write: () => write(block, rows, source, store, privateFills),
      });
      return { key: block.slug, outcome: 'pass', source };
    };
    const write = (
      block: Block,
      rows: WalkRow[],
      source: BlockResult['source'],
      store: BlockStore,
      privateFills: number[],
    ): BlockResult => {
      const result = withPrivateFills({ key: block.slug, outcome: 'pass', source }, privateFills);
      if (result.saved === false) return result;
      if (steps.some((row) => row.reactCoverage === 'lost'))
        return { ...result, saved: false, unsavable: 'React coverage was lost during the walk' };
      const serialized = serializeBlock(block, rows, store, privacy.privateSet('persisted'));
      if ('unsavable' in serialized)
        return { ...result, saved: false, unsavable: serialized.unsavable };
      try {
        cancellationSignal();
        if (deps.cancelled?.()) throw new QaDispatchError('RUN_CANCELLED');
        if (writeBlock(store.appRoot, block.slug, serialized.yaml) === 'written')
          written.push(block.slug);
      } catch (error) {
        if (isAbort(error)) throw error;
        return {
          ...result,
          saved: false,
          unsavable: privacy.redact(error instanceof Error ? error.message : String(error)),
        };
      }
      return result;
    };
    for (const block of blocks) {
      const stored = store && storedFor(block, store);
      if (store && stored) {
        const operations = new Map<number, number>();
        const replayed = await walk(replayBlock(block, stored), { mode: 'replay' }, operations);
        steps.push(...replayed.rows);
        if (!replayed.failure) {
          results.push(
            withPrivateFills(
              { key: block.slug, outcome: 'pass', source: 'replayed' },
              replayed.privateFills,
            ),
          );
          continue;
        }
        if (replayed.miss === undefined) {
          results.push({ ...replayed.block, source: 'replayed' });
          return finish(replayed);
        }
        const k = replayed.miss;
        patchedAt ??= k;
        // A re-walk after a replay miss is not a launch.
        sequence.launchWait = false;
        const rewalked = await walk(block, { fromLine: k }, operations);
        steps.push(...rewalked.rows);
        if (rewalked.failure) {
          results.push({ ...rewalked.block, source: 'patched' });
          return finish(rewalked);
        }
        results.push(
          save(block, [...replayed.rows, ...rewalked.rows], 'patched', store, [
            ...(replayed.privateFills ?? []).filter((line) => line < k),
            ...(rewalked.privateFills ?? []),
          ]),
        );
        continue;
      }
      const outcome = await walk(block);
      steps.push(...outcome.rows);
      if (outcome.failure) {
        results.push(outcome.block);
        return finish(outcome);
      }
      results.push(
        store
          ? save(block, outcome.rows, 'discovered', store, outcome.privateFills)
          : outcome.block,
      );
    }
    return finish();
  });
}

function withRowTiming(deps: WalkerDeps): WalkerDeps {
  const observe = deps.timing;
  if (!observe) return deps;
  const timer = createRowTimer(deps.now());
  let jevCalls = deps.judge?.calls.length ?? 0;
  let jevElapsed = deps.judge?.elapsedMs ?? 0;
  return {
    ...deps,
    timing: (event) => {
      try {
        timer.observe(event);
      } catch (error) {
        if (isAbort(error)) throw error;
        // Row timing is passive and cannot change an operation's outcome.
      }
      observe(event);
    },
    // Action adapters use the session observer; returned settle facts enter the row only here.
    rowSettle: (event) => timer.observe(event),
    rowTiming: (t) => {
      const calls = deps.judge?.calls ?? [];
      const elapsed = deps.judge?.elapsedMs;
      const jevMs =
        elapsed === undefined
          ? calls.slice(jevCalls).reduce((sum, call) => sum + call.ms, 0)
          : elapsed - jevElapsed;
      jevCalls = calls.length;
      jevElapsed = elapsed ?? 0;
      return timer.take(t, jevMs);
    },
  };
}
