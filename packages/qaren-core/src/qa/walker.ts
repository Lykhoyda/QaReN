import {
  fillText,
  InputPrivacyRefusal,
  currentInputs,
  declareEcho,
  throwIfInputPrivacyRefused,
  withEchoScope,
} from './inputs.js';
import { isAbort, cancellationSignal } from '../domain/cancellation.js';
import type { Block, Item, Target } from './plan.js';
import {
  type Element,
  type Screen,
  type NativeNode,
  type VisibilityBlockerDiagnostic,
  screenSignature,
  alertPressEffect,
  insideAlert,
  elementFrame,
  isNativeInput,
  describe,
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
  clearanceBand,
  clearanceScroll,
  keyboardClearance,
  keyboardFallbackTarget,
  bindFillIdentity,
  bindDispatchIdentity,
  stepTarget,
  scrollUntilBand,
  scrollUntilDirection,
  targetEvidence,
  presenceMiss,
  visibleSelector,
} from './resolve.js';
import { literalEvidence, type LiteralNearMiss } from './evidence.js';
import { exactIdentities, focusIdentityOf } from './identity.js';
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
import { type LoginMarker, dismissCandidate, recover } from './recover.js';
import type { BlockOutcome, BlockOutcomeDiagnostic } from './diagnostics.js';
import { targetMissDiagnostic, type TargetMissDiagnostic } from './target-miss.js';
import {
  concealsScreen,
  isPrivateInput,
  MASK,
  SCREEN_TEXT_WITHHELD,
  ObservedPrivacy,
  matchPrivate,
  projectPlanLine,
} from './privacy.js';
import { renderReason, segments, type Reason } from './untrusted.js';
import { NativeSnapshotIncomplete, PrivateInputCaptureError } from './private-input.js';
import {
  AppProcessGoneError,
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
  observationDeadline,
  observationUsable,
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
  type WalkResult,
  type LedgerFailure,
  type LedgerPath,
  type LedgerRow,
  type Selector,
  type StepStart,
  REACT_GAPS,
  buildLedger,
  screenshotName,
} from './ledger.js';

export interface ActResult {
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
  // The system dialog button the runner proved it tapped, with its frame; value-free.
  dialog?: { label: string; rect: { x: number; y: number; width: number; height: number } };
  // Android exact tap on an editable field: whether its keyboard was shown within the tap's settle budget.
  keyboardShown?: boolean;
}

export interface WalkerDeps {
  privacy?: ObservedPrivacy;
  judge?: Judge;
  interruptionVeto?: boolean;
  // Android has no platform presence capture yet.
  presenceUnavailable?: boolean;
  publicationInterrupted?(): boolean;
  captureScreen(options?: {
    observation?: number;
    platformPresence?: boolean;
    timing?: TimingObserver;
  }): Promise<Screen>;
  press(ref: string, context: QaDispatchContext): Promise<ActResult>;
  fill(ref: string, text: string, context: QaDispatchContext): Promise<ActResult>;
  // iOS only: type, proven only by a matching React read-back; testID identifies the pre-dispatch focus veto.
  typeFocused?(
    ref: string,
    text: string,
    testID: string | undefined,
    context: QaDispatchContext,
    requireFocused?: boolean,
    privateValue?: boolean,
  ): Promise<ActResult>;
  // iOS only: positive React proof that the input with this testID is focused.
  reactFocused?(testID: string): Promise<boolean>;
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
  now(): number;
  sleep(ms: number): Promise<void>;
  row(row: LedgerRow): void;
  start?(start: StepStart): void;
  cancelled?(): boolean;
  diagnostic?(event: WalkerTimingDiagnostic): void;
  targetMiss?(event: TargetMissDiagnostic): void;
  blockOutcome?(event: BlockOutcomeDiagnostic): void;
  loginOutcome?(outcome: BlockOutcome): void;
  timing?: TimingObserver;
  rowTiming?(t: number): RowTiming;
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
  };
}

interface Observation {
  id: number;
  screen: Screen;
  timing: ObservationTiming;
}

const ITEM_DEADLINE_EXCEEDED = 'VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED';

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

export const WAIT_BUDGET_MS = 15_000;
export const WAIT_POLL_MS = 500;
export const SCROLL_ATTEMPTS = 6;
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
  laterTargets?: readonly Target[];
}

const recoveryTarget = (item: Item): Target | undefined =>
  item.kind === 'check'
    ? item.literal
      ? { quoted: item.text, phrase: item.text }
      : undefined
    : stepTarget(item);

export interface WalkSequence {
  observation: number;
  operation?: number;
  publicationInterrupted?: boolean;
  momentum?: boolean;
  planPassed?: boolean;
  window?: { fromMs: number; typed: number };
  // System prompts recovery declined in this run; a repeat ask is the plan author's to answer.
  declinedPrompts?: Set<string>;
}

// Title and button labels of a system prompt, held in memory only.
const promptSignature = (screen: Screen): string =>
  JSON.stringify([
    screen.elements.find((e) => e.kind !== 'button' && e.label !== undefined)?.label,
    screen.elements.flatMap((e) => (e.kind === 'button' && e.label !== undefined ? [e.label] : [])),
  ]);

// Capture and process refusals, ambiguity and the replay-miss path are never recovered.
const UNRECOVERABLE = new Set([
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
  const rows: WalkRow[] = [];
  const reactGaps = new Map<number, NonNullable<LedgerRow['reactCoverage']>>();
  let reactConnections: NonNullable<LedgerRow['reactConnections']> = [];
  const privateFills: number[] = [];
  for (const item of block.items)
    if (item.kind === 'fill' && !typed.includes(fillText(item))) typed.push(fillText(item));
  const judge = deps.judge ?? unavailableJudge;
  let resolvedBy: LedgerRow['resolvedBy'] = 'exact';
  let cached: { item: Item; observation: Observation; decision: ScreenDecision } | undefined;
  let latest: Screen = { elements: [], visibleText: [], front: 'app' };
  let line = 0;
  let mutationStarted = false;
  let latestObservation = 0;
  let recoveries = 0;
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
  const capture = async (
    step?: Exclude<Item, { kind: 'check' }>,
    assertion = false,
    recovery = false,
  ): Promise<Observation> => {
    assertActive();
    cached = undefined;
    const target =
      step && ('target' in step ? step.target : step.kind === 'scroll' ? step.until : undefined);
    const requirePresence = assertion || (!!target && target.quoted === undefined);
    const platformPresence =
      requirePresence || (!!target && step?.kind === 'press' && target.exact !== 'id');
    const startedAt = deps.now();
    const id = ++sequence.observation;
    latestObservation = id;
    const captureLine = line;
    const timingObserver: TimingObserver | undefined = deps.timing
      ? (event) => observeTiming(deps.timing, { ...event, line: captureLine, observation: id })
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
        latest = await captureScreen({
          observation: id,
          ...(platformPresence ? { platformPresence: true } : {}),
          ...(timingObserver ? { timing: timingObserver } : {}),
        });
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof AppProcessGoneError) throw processChanged();
        throw error;
      }
      if (latest.front === 'picker' || latest.front === 'dev-fab' || latest.front === 'dev-menu')
        sequence.publicationInterrupted = true;
      const privacyStarted = deps.timing ? deps.now() : 0;
      privacy.observe(latest);
      guardAppProcess(deps.appProcess, latest.appProcessIdentifier);
      if (latest.renderError) throw new RenderError();
      if (deps.timing)
        observeTiming(timingObserver, {
          stage: 'privacy-history',
          edge: 'point',
          outcome: 'ok',
          at: deps.now(),
          ms: deps.now() - privacyStarted,
        });
      assertActive();
      const timing = admitObservation(startedAt, deps.now());
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
      if (requirePresence && latest.front !== 'dialog' && latest.coverage?.native !== 'complete')
        throw new ResolutionError({
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason: 'NATIVE_PRESENCE_UNUSABLE',
        });
      admitted = true;
      emitCaptureDiagnostics(latest);
      return { screen: latest, timing, id };
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof ResolutionError && error.code === 'APP_PROCESS_CHANGED')
        sequence.publicationInterrupted = true;
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
  const frameKey = (e: Element): string | undefined => {
    const rect = elementFrame(e);
    return rect ? [rect.x, rect.y, rect.width, rect.height].join(',') : undefined;
  };
  const identityText = (target: Element): string =>
    `${target.kind} ${target.label === undefined ? 'unlabelled' : `"${target.label}"`}, ${target.testID === undefined ? 'no testID' : `testID "${target.testID}"`}`;
  // After a moved refusal, the target re-identified by the step's own exact-identity rules
  // (one identity, same kind, label and testID) must hold one native frame across two captures.
  const settledTarget = async (
    item: Exclude<Item, { kind: 'check' }>,
    target: Element,
  ): Promise<{ observation: Observation; frame: string } | { frames: string[] }> => {
    const quoted = target.testID ?? target.label;
    const frameOf = (screen: Screen): string | undefined => {
      // Without a testID or label there is no exact identity, so the target cannot be proven the same element.
      if (quoted === undefined || (item.kind !== 'press' && item.kind !== 'fill')) return undefined;
      const matches = exactIdentities(
        screen,
        { quoted, phrase: quoted, exact: target.testID !== undefined ? 'id' : 'text' },
        item.kind,
      ).filter(({ element }) => sameIdentity(element, target));
      return matches.length === 1 ? frameKey(matches[0].element) : undefined;
    };
    let observation = await capture(item);
    let previous = frameOf(observation.screen);
    const frames = [previous ?? 'unresolved'];
    for (let readback = 0; readback < SCROLL_SETTLE_READBACKS; readback += 1) {
      usable(observation, item);
      const next = await capture(item);
      const current = frameOf(next.screen);
      frames.push(current ?? 'unresolved');
      if (current !== undefined && current === previous)
        return { observation: next, frame: current };
      observation = next;
      previous = current;
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
  const mutate = async (
    item: Item,
    observation: Observation,
    send: (context: QaDispatchContext) => Promise<ActResult>,
    deadline = Infinity,
  ): Promise<ActResult> => {
    const preparedAt = deps.timing ? deps.now() : 0;
    dispatchStarted = deps.timing ? preparedAt : undefined;
    metric('mutation', observation, { edge: 'start' });
    let completed = false;
    const context = new (class extends QaDispatchContext {
      override authorize(): void {
        super.authorize();
        mutationStarted = true;
        diagnostic(item, observation, 'dispatch', 'ACCEPTED', this.authorizations);
        if (deps.timing)
          metric('authorization', observation, {
            count: this.authorizations,
            ms: deps.now() - preparedAt,
          });
        super.check();
      }
    })(observationDeadline(observation.timing, deadline), deps.now, deps.cancelled, item.line);
    try {
      context.check();
      if (item.kind === 'fill') privacy.didFill(fillText(item));
      // A scroll step's momentum outlives the step and its block; the next targeted dispatch settles first.
      if (item.kind === 'scroll') sequence.momentum = true;
      const result = await send(context);
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
  const emit = (row: WalkRow): void => {
    const reactCoverage = reactGaps.get(row.line);
    row = {
      ...row,
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
    if (row.outcome === 'pass' && !opts.login) sequence.planPassed = true;
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
  const targetSelector = (target: Target, screen: Screen) =>
    stored(visibleSelector(target, screen));
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
  ): WalkOutcome => {
    const quoted = item.kind === 'check' ? undefined : stepTarget(item)?.quoted;
    if (quoted !== undefined) emitQuotedTargetDiagnostic(screen, quoted, item.line);
    if ((item.kind === 'wait' || item.kind === 'scroll') && stepTarget(item)) {
      try {
        const diagnostic = targetMissDiagnostic(
          stepTarget(item)!,
          screen,
          item.line,
          item.kind === 'scroll',
          privacy,
        );
        if (
          !miss &&
          !(item.kind === 'wait' && item.precondition) &&
          diagnostic.reason !== 'evidence-incomplete'
        ) {
          const detail = `; target visibility: ${diagnostic.reason}`;
          reason = typeof reason === 'string' ? reason + detail : [...segments(reason), detail];
        }
        deps.targetMiss?.(diagnostic);
      } catch {
        // Diagnostics cannot change the failed step's outcome.
      }
    }
    emit({
      ...base(item, attempt),
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
          '; historical context, previously on screen: ',
          {
            app: privacy.screenText(screen).slice(0, 40).join(' | '),
            ...(concealsScreen(screen) ? { withheld: SCREEN_TEXT_WITHHELD } : {}),
          },
        ],
        ...(screenshot ? { screenshot } : {}),
      },
    };
  };
  // The judged screen and any post-recovery capture must both show the app.
  const judged = (outcome: WalkOutcome, screen: Screen): WalkOutcome =>
    outcome.failure && screen.front === 'app' && latest.front === 'app'
      ? { ...outcome, failure: { ...outcome.failure, kind: 'step' } }
      : outcome;
  const shoot = async (item: Item): Promise<string | undefined> => {
    assertActive();
    if (!privacy.canScreenshot()) {
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
  const visibilityProbe = (item: Item & { kind: 'wait' | 'scroll' }, deadline = Infinity) => {
    let reasks = 0;
    return async (
      observation: Observation,
      initial?: ScreenDecision,
    ): Promise<{ observation: Observation; found: boolean; unsure?: boolean }> => {
      let decision = initial;
      while (deps.now() < deadline) {
        try {
          decision = await decide(observation, undefined, item, deadline, decision);
        } catch (error) {
          if (isAbort(error)) throw error;
          if (!(error instanceof EvidenceExpired)) throw error;
          if (error.itemExpired) throw error;
          metric('refresh', observation);
          await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
          if (deps.now() >= deadline) throw new EvidenceExpired(true);
          observation = await capture(item);
          decision = undefined;
          continue;
        }
        const target = item.kind === 'wait' ? item.target : item.until!;
        if (target.quoted !== undefined) {
          const evidence = targetEvidence(target, observation.screen);
          return { observation, found: evidence === 'pass', unsure: evidence === 'unsure' };
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
        observation = await capture(item);
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
    entry.proven || currentInputs()?.hasInputs
      ? {}
      : entry.kept
        ? { kept: { typed: entry.kept.typed, observed: [...entry.kept.observed] } }
        : entry.caseNormalized
          ? { caseNormalized: { chars: entry.caseNormalized.chars } }
          : {};
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
    const nothingTyped = (reason: string, screen: Screen): WalkOutcome =>
      failed(item, attempt, `${reason}; nothing was typed`, screen, undefined);
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
    if (item.input === undefined && !privateFills.includes(item.line)) privateFills.push(item.line);
    let tap: ActResult | undefined;
    if (!centreCovered(target.element, before.screen))
      try {
        tap = await mutate(item, before, (context) => deps.press(target.element.ref, context));
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof EvidenceExpired)
          return nothingTyped(`the evidence expired before tapping "${quoted}"`, before.screen);
        throw error;
      }
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
      );
    const readyBy = deps.now() + KEYBOARD_READY_MS;
    let after = await settledCapture(item);
    const bound = () => bindFillIdentity(item, after.screen, target.oracleTestID);
    for (
      let captures = 1;
      !proofMode &&
      after.screen.keyboardVisible !== true &&
      bound()?.kind !== 'strict' &&
      captures < KEYBOARD_READY_CAPTURES &&
      deps.now() < readyBy;
      captures += 1
    ) {
      await pause(Math.min(WAIT_POLL_MS, Math.max(0, readyBy - deps.now())));
      after = await settledCapture(item);
    }
    const binding = bound();
    if (binding?.kind === 'strict')
      return { ...binding.strict, observation: after, identity: target.oracleTestID, scrolled };
    if (after.screen.keyboardVisible !== true)
      return nothingTyped(`tapping "${quoted}" raised no keyboard`, after.screen);
    const again = binding?.kind === 'fallback' ? binding.fallback : undefined;
    if (!again) return nothingTyped(`the tap on "${quoted}" changed the screen`, after.screen);
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
          isPrivateInput(again.element),
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
    if (!entry.ok)
      return failed(
        item,
        attempt,
        `${entry.error ?? 'typing was not dispatched'}; typing after tapping "${quoted}" was not retried`,
        after.screen,
        undefined,
      );
    await capture(item);
    emit({
      ...base(item, attempt),
      ref: again.element.ref,
      ...stored({ id: again.oracleTestID }),
      outcome: 'pass',
      ...keptCounts(entry),
      ...(entry.proven
        ? {}
        : {
            reason: redact(
              (proofMode
                ? focusedReason(quoted)
                : `UNVERIFIED_FILL: typed with the keyboard after tapping "${quoted}"; the field is not an observable native input, so its final value was not validated`) +
                keptNote(entry),
            ),
          }),
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
    privacy.concealFallback(fillText(item), false, quoted);
    if (item.input === undefined) privateFills.push(item.line);
    let entry: ActResult;
    currentInputs()?.expectEcho(quoted, item.input);
    try {
      entry = await mutate(item, before, (context) =>
        deps.typeFocused!(quoted, fillText(item), quoted, context, true),
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
    if (!entry.ok)
      return failed(
        item,
        attempt,
        `${entry.error ?? 'typing was not dispatched'}; typing into "${quoted}" was not retried`,
        before.screen,
        undefined,
      );
    await capture(item);
    emit({
      ...base(item, attempt),
      ...stored({ id: quoted }),
      outcome: 'pass',
      ...keptCounts(entry),
      ...(entry.proven ? {} : { reason: redact(focusedReason(quoted) + keptNote(entry)) }),
    });
    return 'typed';
  };
  // The login block walks with this walk's privacy, so its typed values stay masked.
  let loginReplayed = false;
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
      sequence.window = { fromMs: deps.now(), typed: typed.length };
    }
    return 'pass' as const;
  };
  // At most two recoveries per item, the second only declining a different interruption; 'retry' re-runs the item from a fresh capture.
  const recovery = async (
    item: Item,
    attempt: number,
    reason: string,
  ): Promise<'retry' | WalkOutcome | undefined> => {
    const first = recovered.get(item);
    if (opts.recover === false || !deps.hideDevMenu) return undefined;
    recovered.set(item, null);
    loginReplayed = false;
    let fresh: Observation;
    try {
      fresh = await capture(undefined, true, true);
    } catch (error) {
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
      return undefined;
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
    if (first === null) return undefined;
    if (first !== undefined) {
      if (fresh.screen.front !== 'dialog' && fresh.screen.front !== 'app') return undefined;
      if (
        fresh.screen.front === 'app' &&
        fresh.screen.elements.some((e) => !e.offscreen && `app ${e.label}` === first)
      )
        return failed(
          item,
          attempt,
          'the app interruption did not disappear',
          fresh.screen,
          await shoot(item),
        );
    }
    const planTargets = [
      recoveryTarget(item) ?? { phrase: '' },
      ...block.items.slice(block.items.indexOf(item) + 1).flatMap((remaining) => {
        const target = recoveryTarget(remaining);
        return target?.quoted !== undefined ? [target] : [];
      }),
      ...(opts.laterTargets ?? []),
    ];
    let interruptionShot: string | undefined;
    let dialogAct: ActResult | undefined;
    let declineAttempted = false;
    const result = await recover(
      fresh.screen,
      {
        hideDevMenu: deps.hideDevMenu,
        interruptionDiagnostic: (record) => {
          try {
            deps.note?.(
              `interruption-rejected=${JSON.stringify({ line: item.line, observation: fresh.id, ...record })}`,
            );
          } catch {
            /* Diagnostics cannot change recovery. */
          }
        },
        dialog: async () => {
          declineAttempted = true;
          recoveries += 1;
          return (dialogAct = await mutate(item, fresh, (context) =>
            deps.dialog(item.kind === 'dialog' ? item.action : 'dismiss', context),
          ));
        },
        ...(deps.login && first === undefined ? { replayLogin } : {}),
        dismiss: async (label) => {
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
          const nested = await walkBlock(
            support,
            {
              ...deps,
              captureScreen: async (options) => {
                const screen = await captureScreen({ ...options, platformPresence: true });
                if (!dispatched) {
                  const candidate = dismissCandidate(screen, planTargets, (record) => {
                    try {
                      deps.note?.(
                        `interruption-rejected=${JSON.stringify({ line: item.line, ...record })}`,
                      );
                    } catch {
                      /* Diagnostics cannot change recovery. */
                    }
                  });
                  if (!candidate || 'refuse' in candidate || candidate.label !== label)
                    throw new ResolutionError({
                      refuse: 'INTERRUPTION_CHANGED',
                      reason:
                        'the interruption or plan targets changed before dispatch; nothing was tapped',
                    });
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
                const result = await deps.press(ref, context);
                if (!result.ok || result.executed === false)
                  throw new ResolutionError({
                    refuse: 'INTERRUPTION_NOT_DISPATCHED',
                    reason:
                      'the decline control was not dispatched successfully; it was not retried',
                  });
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
          return literalEvidence(after, label, 'equals').verdict === 'fail' &&
            !after.elements.some((e) => !e.offscreen && e.label === label)
            ? 'pass'
            : 'fail';
        },
      },
      deps.login?.marker,
      planTargets,
    );
    if (!result) return undefined;
    if ('handled' in result && !declineAttempted) recoveries += 1;
    if ('handled' in result) {
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
      // The recovery acted on the device, so a later selector miss is not a pre-mutation re-walk.
      mutationStarted = true;
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
          `${reason}; recovered: ${result.label ? `dismissed an app screen with ${result.label}` : result.handled}; retrying the step once`,
        ),
      });
      return 'retry';
    }
    const shown = loginReplayed ? (await capture()).screen : fresh.screen;
    const shot = await shoot(item);
    return 'fail' in result
      ? failed(item, attempt, result.fail, shown, shot)
      : {
          ...failed(item, attempt, result.refuse.message, fresh.screen, shot),
          refusal: result.refuse,
        };
  };

  items: for (const item of block.items) {
    if (opts.fromLine !== undefined && item.line < opts.fromLine) {
      if (item.kind === 'echo') declareEcho(item.input);
      continue;
    }
    mutationStarted = false;
    attempts: for (;;) {
      line = item.line;
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
            const recovering = await recovery(item, 1, reason);
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
          }
          const checkFailure = failed(item, 1, reason, before.screen, shot);
          return decision.check === 'fail' ? judged(checkFailure, before.screen) : checkFailure;
        }

        if (item.kind === 'wait') {
          resolvedBy = item.target.quoted === undefined ? 'jev' : resolvedBy;
          const budget = item.target.quoted === undefined ? PHRASE_WAIT_BUDGET_MS : WAIT_BUDGET_MS;
          const deadline = deps.now() + budget;
          const held = cached?.item === item ? cached : undefined;
          let observation = held?.observation ?? (await capture(item));
          cached = undefined;
          const probe = visibilityProbe(item, deadline);
          let replayMiss: ResolutionError | undefined;
          let unsure = false;
          let absent = 0;
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
            if (!observed.found && !unsure && item.target.quoted !== undefined) {
              absent += 1;
              absentScreens.add(screenSignature(observation.screen));
            }
            return observed.found;
          };
          let found = await visible(observation, held?.decision);
          while (!found && deps.now() < deadline) {
            await pause(Math.min(WAIT_POLL_MS, deadline - deps.now()));
            if (deps.now() >= deadline) break;
            try {
              found = await visible(await capture(item));
            } catch (error) {
              // A capture finishing past the deadline is not evidence; judge the ones already made.
              if (!(error instanceof EvidenceExpired) || !error.itemExpired) throw error;
              break;
            }
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
                ),
                refusal,
              };
            }
            if (replayMiss) throw replayMiss;
            // Repeated literal absence on one unchanged screen is an observed result, not uncertainty.
            const unchanged = absent >= 2 && absentScreens.size === 1;
            const reason = unchanged
              ? `"${item.target.quoted}" did not appear within ${budget / 1000}s; the screen did not change across ${absent} observations`
              : ITEM_DEADLINE_EXCEEDED;
            const recovering = await recovery(item, 1, reason);
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
            if (unchanged) {
              const miss = presenceMiss(item.target, observation.screen);
              return judged(
                failed(
                  item,
                  1,
                  miss ? `${reason}; ${miss}` : reason,
                  observation.screen,
                  await shoot(item),
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
            ...targetSelector(item.target, observation.screen),
            outcome: 'pass',
          });
          continue items;
        }

        if (item.kind === 'scroll' && item.until) {
          resolvedBy = item.until.quoted === undefined ? 'jev' : resolvedBy;
          const deadline = deps.now() + PHRASE_WAIT_BUDGET_MS;
          const held = cached?.item === item ? cached : undefined;
          let observation = held?.observation ?? (await capture(item));
          cached = undefined;
          const probe = visibilityProbe(item, deadline);
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
            return observed.found;
          };
          let found = await visible(observation, held?.decision);
          let attempts = 0;
          while (!found && attempts < SCROLL_ATTEMPTS && deps.now() < deadline) {
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
                    scrollUntilBand(item.until!, observation.screen),
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
              observation = await capture(item);
              found = await visible(observation);
              continue;
            }
            attempts += 1;
            await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
            if (deps.now() >= deadline) throw replayMiss ?? new EvidenceExpired(true);
            observation = await capture(item);
            found = await visible(observation);
            const moved = screenSignature(observation.screen) !== beforeSignature;
            if (!act.ok && !moved)
              return failed(
                item,
                attempts,
                act.error ?? 'scroll was not dispatched',
                observation.screen,
                await shoot(item),
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
              ...targetSelector(item.until, observation.screen),
              outcome: 'pass',
            });
            continue items;
          }
          const reason = `"${item.until.phrase}" did not come into view after ${SCROLL_ATTEMPTS} scrolls`;
          return judged(
            failed(item, Math.max(attempts, 1), reason, observation.screen, shot),
            observation.screen,
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
        let settledFrame: string | undefined;
        const captureBeforeDispatch = (): Promise<Observation> =>
          (item.kind === 'press' || item.kind === 'fill') &&
          (scrolled || sequence.momentum || fillIdentity !== undefined)
            ? settledCapture(item)
            : capture(item);
        const maxAttempts = recovered.has(item) || opts.singleAttempt ? 1 : 2;
        for (let attempt = 1; attempt <= maxAttempts && !outcome; attempt += 1) {
          currentAttempt = attempt;
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
          let clearance: number | undefined;
          let within: NativeNode['rect'];
          let scrollNeedsReadback = false;
          let scrollError: string | undefined;
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
                const decided =
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
                  if (!fallback || item.kind !== 'fill') throw new ResolutionError(decided);
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
                  if (
                    scrolled &&
                    (resolution.origin !== 'named-offscreen' ||
                      scrollOrigin !== 'offscreen-resolution' ||
                      scrolled >= SCROLL_ATTEMPTS)
                  ) {
                    outcome = failed(
                      item,
                      attempt,
                      `${scrollError ? `${scrollError}; ` : ''}"${item.target.phrase}" stayed off screen after ${scrolled === 1 ? 'one scroll' : `${scrolled} scrolls`}`,
                      before.screen,
                      await shoot(item),
                    );
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
                  if (
                    (resolution.origin === 'named-offscreen' || (!result.ok && !result.proven)) &&
                    screenSignature(before.screen) === signature
                  ) {
                    outcome = failed(
                      item,
                      attempt,
                      `${scrollError ? `${scrollError}; ` : ''}"${item.target.phrase}" stayed off screen after ${scrolled === 1 ? 'one scroll' : `${scrolled} scrolls`}`,
                      before.screen,
                      await shoot(item),
                    );
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
              let centreDiagnostic: Readonly<CentreCoverageDiagnostic> | null = null;
              if (
                (item.kind === 'press' || item.kind === 'fill') &&
                element !== undefined &&
                centreCovered(element, before.screen, (facts) => {
                  centreDiagnostic = facts;
                })
              ) {
                if (scrolled) {
                  outcome = failed(
                    item,
                    attempt,
                    `"${item.target.phrase}" stayed off screen after one scroll: its centre is past the visible area or under the keyboard`,
                    before.screen,
                    await shoot(item),
                    ref,
                  );
                  const originalFrame = refusedIdentity && elementFrame(refusedIdentity);
                  const currentFrame = elementFrame(element);
                  const centres =
                    originalFrame && currentFrame
                      ? [
                          originalFrame.x + originalFrame.width / 2,
                          originalFrame.y + originalFrame.height / 2,
                          currentFrame.x + currentFrame.width / 2,
                          currentFrame.y + currentFrame.height / 2,
                        ]
                      : undefined;
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
                      targetCentreChanged: centres?.every(Number.isFinite)
                        ? centres[0] !== centres[2] || centres[1] !== centres[3]
                        : null,
                    },
                  );
                  break;
                }
                refusedIdentity = element;
                occluded = clearanceScroll(element, before.screen);
                scrollOrigin = 'centre-covered';
                clearance = keyboardClearance(element, before.screen);
                within = clearanceBand(element, before.screen);
                continue;
              }
              if (item.kind === 'fill' && element && isPrivateInput(element)) {
                privacy.concealFallback(
                  fillText(item),
                  element.secure,
                  element.testID ?? element.label,
                );
                if (item.input === undefined && !privateFills.includes(item.line))
                  privateFills.push(item.line);
              }
              if (item.kind === 'fill') currentInputs()?.expectEcho(element?.testID, item.input);
              if (
                (item.kind === 'scroll' || item.kind === 'back') &&
                before.screen.front === 'dialog'
              )
                throw dialogInFront();
              act = await mutate(item, before, (context) =>
                item.kind === 'press'
                  ? deps.press(ref!, context)
                  : item.kind === 'fill'
                    ? deps.fill(ref!, fillText(item), context)
                    : item.kind === 'scroll'
                      ? deps.scroll(item.direction, context)
                      : item.kind === 'back'
                        ? deps.back(context)
                        : deps.dialog(item.action, context),
              );
              if (!act.ok && act.ambiguous) {
                outcome = failed(
                  item,
                  attempt,
                  act.error ?? 'TARGET_AMBIGUOUS',
                  before.screen,
                  undefined,
                  ref,
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
                    `${act.error}; "${item.target.phrase}" stayed off screen after one scroll`,
                    before.screen,
                    await shoot(item),
                    ref,
                  );
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
          if (outcome || typedUnverified) break;
          const after = await capture(item);
          // NOTE: a not-ok result is not a verdict; an act that timed out may still have landed.
          const changed = screenSignature(after.screen) !== screenSignature(before.screen);
          usable(after, item);
          diagnostic(item, after, 'decision', 'ACCEPTED');
          metric('readback', after);
          const shot = await shoot(item);
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
          if (
            !noMutationRefusal &&
            !dialogRefused &&
            (item.kind === 'fill' ? (act!.ok && act!.proven) || unverified : act!.proven || changed)
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
              ...(unverified && recased
                ? {
                    reason: redact(
                      'UNVERIFIED_FILL: the field changed only the letter case, so the fill was not verified',
                    ),
                    ...(!currentInputs()?.hasInputs
                      ? { caseNormalized: { chars: [...fillText(item)].length } }
                      : {}),
                  }
                : unverified
                  ? {
                      reason: redact(
                        `UNVERIFIED_FILL: the field's final value ${act!.evidence === 'masked' ? 'reads back masked' : 'could not be read back'}, so the fill was not verified`,
                      ),
                    }
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
                `${act!.error ? `${act!.error}; ` : ''}${noKeyboard}the screen did not change; retrying once`,
              ),
            });
            continue;
          }
          const unchangedScreen =
            maxAttempts === 1
              ? 'the screen did not change after recovery'
              : 'the screen did not change after two attempts';
          const stillness = settledFrame
            ? `; the target's frame held still at ${settledFrame} before this dispatch`
            : '';
          const afterTarget = element && after.screen.elements.find((e) => e.ref === element!.ref);
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
          if (recovering === 'retry') {
            again = true;
            break;
          }
          outcome =
            recovering ??
            (act!.ok && !act!.error
              ? judged(failed(item, attempt, unchanged, after.screen, shot, ref), after.screen)
              : failed(item, attempt, unchanged, after.screen, shot, ref));
        }
        if (again) continue attempts;
        if (outcome) return outcome;
        continue items;
      } catch (caught) {
        if (isAbort(caught)) throw caught;
        let error = caught;
        if (
          error instanceof ResolutionError &&
          !UNRECOVERABLE.has(error.code) &&
          !deps.cancelled?.()
        ) {
          try {
            const recovering = await recovery(item, currentAttempt, error.message);
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
          } catch (recoveryError) {
            if (isAbort(recoveryError)) throw recoveryError;
            error = recoveryError;
          }
        }
        if (error instanceof RenderError)
          return failed(item, currentAttempt, error.message, latest, undefined);
        if (error instanceof PrivateInputCaptureError || error instanceof NativeCaptureError) {
          const nativeFailure = error instanceof NativeCaptureError;
          const safe = nativeFailure
            ? new NativeCaptureError()
            : error instanceof NativeSnapshotIncomplete
              ? new NativeSnapshotIncomplete(error.nodes, error.causes)
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
        const shot =
          error instanceof QaDispatchError ||
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
        const unknownProcess =
          error instanceof ResolutionError && error.code === 'APP_PROCESS_UNKNOWN'
            ? { code: error.code, message: error.message }
            : undefined;
        const caughtOutcome = failed(
          item,
          currentAttempt,
          error.message,
          latest,
          shot,
          undefined,
          miss,
        );
        return {
          ...(error instanceof ResolutionError && error.missing
            ? judged(caughtOutcome, latest)
            : caughtOutcome),
          ...(refusal || unknownProcess ? { refusal: refusal ?? unknownProcess } : {}),
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
        return { ...item, target: exact(step.selector!) };
      if (item.kind === 'scroll' && item.until) return { ...item, until: exact(step.until!) };
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
    const calls = (): JevCall[] => [...preflightCalls, ...(deps.judge?.calls ?? [])];
    const sequence: WalkSequence = {
      observation: 0,
      publicationInterrupted: false,
      planPassed: false,
    };
    const walk = async (block: Block, opts?: WalkOptions, operations?: Map<number, number>) => {
      const outcome = await walkBlock(
        block,
        walking,
        steps.length,
        typed,
        privacy,
        sequence,
        {
          ...opts,
          laterTargets: blocks
            .slice(blocks.findIndex((planned) => planned.slug === block.slug) + 1)
            .flatMap((later) =>
              later.items.flatMap((item) => {
                const target = recoveryTarget(item);
                return target?.quoted !== undefined ? [target] : [];
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
    const finish = (outcome?: WalkOutcome): WalkResult => {
      throwIfInputPrivacyRefused();
      if (!deps.cancelled?.()) {
        cancellationSignal();
        for (const { index, write } of pending.splice(0)) results[index] = write();
      }
      const ledger: WalkResult = {
        ...buildLedger(
          results.map((result) => ({ ...result, key: display(result.key) })),
          steps.map(({ selector, reason, ...row }) => ({
            ...row,
            block: display(row.block),
            text: projectPlanLine(row.text, privacy.privateSet()).text,
            ...(reason !== undefined
              ? { reason: renderReason(reason, (text) => privacy.redact(text)) }
              : {}),
            ...(selector && unprotected(selector.id ?? selector.text ?? '') ? { selector } : {}),
          })),
          outcome?.failure
            ? {
                ...outcome.failure,
                seen: renderReason(outcome.failure.seen, (text) => privacy.redact(text)),
              }
            : undefined,
          calls(),
          path(),
          recoveries,
        ),
        videoPublication: videoPublication(),
        ...(sequence.window ? { publishFromMs: sequence.window.fromMs } : {}),
        publicationInterrupted:
          sequence.publicationInterrupted || deps.publicationInterrupted?.() === true,
      };
      if (store) ledger.blocksWritten = written;
      if (ledger.verdict === 'PASS' && !outcome?.refusal && !deps.cancelled?.())
        ledger.recipe = privateFills.length
          ? { unsavable: `line ${Math.min(...privateFills)}: fills a private input` }
          : recipeMarkdown(title, blocks, privacy.privateSet('persisted'));
      const refusal = outcome?.refusal ?? (ledger.verdict === 'REFUSED' ? ledger : undefined);
      return refusal
        ? {
            ...ledger,
            code: refusal.code,
            message: refusal.message,
            verdict: 'REFUSED',
            videoPublication:
              ledger.videoPublication === 'eligible' ? 'unknown' : ledger.videoPublication,
          }
        : ledger;
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
