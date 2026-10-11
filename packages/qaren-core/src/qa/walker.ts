import { isAbort, cancellationSignal } from '../domain/cancellation.js';
import type { Block, Item, Target } from './plan.js';
import {
  type Element,
  type Screen,
  type VisibilityBlockerDiagnostic,
  screenSignature,
  elementFrame,
  isNativeInput,
} from './screen.js';
import {
  type Resolution,
  type ScreenDecision,
  CHECK,
  ResolutionError,
  decideScreen,
  elementSelector,
  centreCovered,
  clearanceScroll,
  keyboardFallbackTarget,
  bindFillIdentity,
  bindDispatchIdentity,
  stepTarget,
  scrollUntilDirection,
  targetEvidence,
  visibleSelector,
} from './resolve.js';
import { literalEvidence } from './evidence.js';
import { exactIdentities, focusIdentityOf } from './identity.js';
import {
  type BlockPlatform,
  type StoredBlock,
  loadBlock,
  readBlock,
  serializeBlock,
  storedFits,
  writeBlock,
} from './blocks.js';
import { type Judge, type JevCall, JevError, unavailableJudge } from './questions.js';
import { type LoginMarker, recover } from './recover.js';
import { isPrivateInput, MASK, ObservedPrivacy, matchPrivate, projectPlanLine } from './privacy.js';
import { NativeSnapshotIncomplete, PrivateInputCaptureError } from './private-input.js';
import { AppProcessGoneError, emitCaptureDiagnostics, NativeCaptureError } from './capture.js';
import { QaDispatchContext, QaDispatchError } from '../domain/qa-dispatch.js';
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
}

export interface WalkerDeps {
  judge?: Judge;
  publicationInterrupted?(): boolean;
  captureScreen(options?: { platformPresence?: boolean; timing?: TimingObserver }): Promise<Screen>;
  press(ref: string, context: QaDispatchContext): Promise<ActResult>;
  fill(ref: string, text: string, context: QaDispatchContext): Promise<ActResult>;
  // iOS only: type, proven only by a matching React read-back; testID identifies the pre-dispatch focus veto.
  typeFocused?(
    ref: string,
    text: string,
    testID: string | undefined,
    context: QaDispatchContext,
    requireFocused?: boolean,
  ): Promise<ActResult>;
  // iOS only: positive React proof that the input with this testID is focused.
  reactFocused?(testID: string): Promise<boolean>;
  // A value-free diagnostic line for the run log.
  note?(line: string): void;
  scroll(direction: 'down' | 'up', context: QaDispatchContext): Promise<ActResult>;
  back(context: QaDispatchContext): Promise<ActResult>;
  dialog(action: 'accept' | 'dismiss', context: QaDispatchContext): Promise<ActResult>;
  screenshot(name: string): Promise<string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  row(row: LedgerRow): void;
  start?(start: StepStart): void;
  cancelled?(): boolean;
  diagnostic?(event: WalkerTimingDiagnostic): void;
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
    | 'SCREEN_EVIDENCE_INCOMPLETE';
  at: number;
  acquisitionMs: number;
  observationAgeMs: number;
  authorizations?: number;
  observation?: number;
  visibilityBlocker?: VisibilityBlockerDiagnostic;
}

interface Observation {
  id: number;
  screen: Screen;
  timing: ObservationTiming;
}

class EvidenceExpired extends Error {
  constructor(readonly itemExpired = false) {
    super(itemExpired ? 'VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED' : 'EVIDENCE_EXPIRED');
  }
}

const unresolvedText = (quoted: string) =>
  new ResolutionError({
    refuse: 'VISIBILITY_UNSURE',
    reason: `"${quoted}" stayed unresolved: matching text has no trusted frame or the native snapshot is incomplete`,
  });

export const WAIT_BUDGET_MS = 15_000;
export const WAIT_POLL_MS = 500;
export const SCROLL_ATTEMPTS = 6;
export const KEYBOARD_READY_MS = 1_500;
export const KEYBOARD_READY_CAPTURES = 3;
export const SCROLL_SETTLE_READBACKS = 3;

export interface WalkOutcome {
  block: BlockResult;
  rows: LedgerRow[];
  failure?: LedgerFailure;
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
}

// Capture and process refusals, ambiguity and the replay-miss path are never recovered.
const UNRECOVERABLE = new Set([
  'SCROLL_UNSETTLED',
  'REPLAY_SELECTOR',
  'TARGET_AMBIGUOUS',
  'SCREEN_EVIDENCE_INCOMPLETE',
  'APP_PROCESS_CHANGED',
  'APP_PROCESS_UNKNOWN',
]);

// Retry a mutation once only when read-back failed and the screen provably did not move.
export async function walkBlock(
  block: Block,
  deps: WalkerDeps,
  shotIndex = 0,
  typed: string[] = [],
  privacy = new ObservedPrivacy(typed),
  sequence: {
    observation: number;
    operation?: number;
    publicationInterrupted?: boolean;
    momentum?: boolean;
  } = {
    observation: 0,
  },
  opts: WalkOptions = {},
  operations = new Map<number, number>(),
): Promise<WalkOutcome> {
  const replay = opts.mode === 'replay';
  const rows: LedgerRow[] = [];
  const privateFills: number[] = [];
  for (const item of block.items)
    if (item.kind === 'fill' && !typed.includes(item.text)) typed.push(item.text);
  const judge = deps.judge ?? unavailableJudge;
  let resolvedBy: LedgerRow['resolvedBy'] = 'exact';
  let cached: { item: Item; observation: Observation; decision: ScreenDecision } | undefined;
  let latest: Screen = { elements: [], visibleText: [], front: 'app' };
  let line = 0;
  let mutationStarted = false;
  let latestObservation = 0;
  let recoveries = 0;
  const recovered = new Set<Item>();
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
  ): Promise<Observation> => {
    assertActive();
    cached = undefined;
    const target =
      step && ('target' in step ? step.target : step.kind === 'scroll' ? step.until : undefined);
    const platformPresence = assertion || (!!target && target.quoted === undefined);
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
        latest = await deps.captureScreen(
          deps.timing
            ? { ...(platformPresence ? { platformPresence: true } : {}), timing: timingObserver }
            : platformPresence
              ? { platformPresence: true }
              : undefined,
        );
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
      if (platformPresence && latest.coverage?.native !== 'complete')
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
        ...(visibilityBlocker ? { observation: observation.id, visibilityBlocker } : {}),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      // Diagnostics cannot change a decision or dispatch outcome.
    }
  };
  // Scroll momentum outlives the drag; dispatching on a moving frame taps its stale centre.
  // Compare native frame values only: runner key order varies and React-only elements have no frame.
  const settledCapture = async (item: Exclude<Item, { kind: 'check' }>): Promise<Observation> => {
    const geometry = (screen: Screen): string =>
      JSON.stringify(
        screen.elements.flatMap((e) => {
          const frame = elementFrame(e);
          return frame ? [[frame.x, frame.y, frame.width, frame.height]] : [];
        }),
      );
    let observation = await capture(item);
    for (let readback = 0; readback < SCROLL_SETTLE_READBACKS; readback += 1) {
      usable(observation, item);
      const next = await capture(item);
      if (geometry(next.screen) === geometry(observation.screen)) {
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
  const mutate = async (
    item: Item,
    observation: Observation,
    send: (context: QaDispatchContext) => Promise<ActResult>,
    deadline = Infinity,
  ): Promise<ActResult> => {
    const preparedAt = deps.timing ? deps.now() : 0;
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
    })(observationDeadline(observation.timing, deadline), deps.now, deps.cancelled);
    try {
      context.check();
      if (item.kind === 'fill') privacy.didFill(item.text);
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
  const emit = (row: LedgerRow): void => {
    row = { ...row, operationId: operationFor(row.line) };
    let timing: RowTiming | undefined;
    try {
      timing = deps.rowTiming?.(row.t);
    } catch (error) {
      if (isAbort(error)) throw error;
      // Row timing is passive; the row is recorded without it.
    }
    const timed = timing ? { ...row, timing } : row;
    rows.push(timed);
    deps.row(valueFree(timed));
  };
  const redact = (text: string): string => privacy.redact(text);
  // A stored selector is written to the action file, so it must not carry a protected value.
  const stored = (selector: Selector | undefined): { selector?: Selector } => {
    const value = selector?.id ?? selector?.text;
    return selector &&
      value !== undefined &&
      !matchPrivate(value, privacy.privateSet(), 'persisted').hit
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
    reason: string,
    screen: Screen,
    screenshot: string | undefined,
    ref?: string,
    miss = false,
  ): WalkOutcome => {
    emit({
      ...base(item, attempt),
      ...(ref ? { ref } : {}),
      ...(screenshot ? { screenshot } : {}),
      outcome: miss ? 'retry' : 'fail',
      reason: redact(miss ? `${reason}; re-walking from this line` : reason),
    });
    return {
      block: { key: block.slug, outcome: 'fail', source: 'discovered' },
      rows,
      ...(miss ? { miss: item.line } : {}),
      ...(privateFills.length ? { privateFills } : {}),
      ...(recoveries ? { recoveries } : {}),
      failure: {
        step: item.line,
        seen: redact(
          `${reason}; historical context, previously on screen: ${privacy.screenText(screen).slice(0, 40).join(' | ')}`,
        ),
        ...(screenshot ? { screenshot } : {}),
      },
    };
  };
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
    entry.proven
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
    privacy.concealFallback(item.text);
    privateFills.push(item.line);
    let tap: ActResult;
    try {
      tap = await mutate(item, before, (context) => deps.press(target.element.ref, context));
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof EvidenceExpired)
        return nothingTyped(`the evidence expired before tapping "${quoted}"`, before.screen);
      throw error;
    }
    if (!tap.ok && tap.mutation === 'none' && tap.error?.startsWith('FOCUS_TARGET_OCCLUDED:')) {
      if (scrolled)
        return nothingTyped(
          `${tap.error}; "${quoted}" stayed off screen after one scroll`,
          before.screen,
        );
      const scroll = await mutate(item, before, (context) =>
        deps.scroll(clearanceScroll(target.element), context),
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
    try {
      entry = await mutate(item, after, (context) =>
        deps.typeFocused!(again.element.ref, item.text, again.oracleTestID, context, proofMode),
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
    privacy.concealFallback(item.text);
    privateFills.push(item.line);
    let entry: ActResult;
    try {
      entry = await mutate(item, before, (context) =>
        deps.typeFocused!(quoted, item.text, quoted, context, true),
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
    if (!login) return 'fail' as const;
    loginReplayed = true;
    let taken = 0;
    const counted: WalkerDeps = {
      ...deps,
      screenshot: (name) => {
        taken += 1;
        return deps.screenshot(name);
      },
    };
    // Walk mode: a stale stored selector fails the login instead of asking for a re-walk.
    const nested = await walkBlock(login, counted, shots, typed, privacy, sequence, {
      recover: false,
    });
    shots += taken;
    separateRowOperations(nested.rows);
    rows.push(...nested.rows);
    if (nested.refusal) return { refuse: nested.refusal };
    return nested.failure
      ? { fail: `the login block did not pass: ${nested.failure.seen}` }
      : ('pass' as const);
  };
  // At most one recovery per item; 'retry' re-runs the item from a fresh capture.
  const recovery = async (
    item: Item,
    attempt: number,
    reason: string,
  ): Promise<'retry' | WalkOutcome | undefined> => {
    if (opts.recover === false || !deps.hideDevMenu || recovered.has(item)) return undefined;
    recovered.add(item);
    loginReplayed = false;
    const fresh = await capture();
    const result = await recover(
      fresh.screen,
      {
        hideDevMenu: deps.hideDevMenu,
        dialog: () => mutate(item, fresh, (context) => deps.dialog('accept', context)),
        ...(deps.login ? { replayLogin } : {}),
      },
      deps.login?.marker,
    );
    if (!result) return undefined;
    if ('handled' in result) {
      recoveries += 1;
      // The recovery acted on the device, so a later selector miss is not a pre-mutation re-walk.
      mutationStarted = true;
      emit({
        ...base(item, attempt),
        outcome: 'retry',
        reason: redact(`${reason}; recovered: ${result.handled}; retrying the step once`),
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
    if (opts.fromLine !== undefined && item.line < opts.fromLine) continue;
    mutationStarted = false;
    attempts: for (;;) {
      line = item.line;
      deps.start?.({
        operationId: operationFor(item.line),
        line: item.line,
        kind: item.kind === 'check' ? 'check' : 'step',
        t: deps.now(),
      });
      let currentAttempt = 1;
      resolvedBy = item.source === 'jev' && !replay ? 'jev' : 'exact';
      if (item.kind === 'fill' && item.text && !typed.includes(item.text)) typed.push(item.text);
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
          const reason =
            decision.check === 'unsure'
              ? 'CHECK_UNSURE: the expectation remained uncertain after a fresh-screen re-ask'
              : `"${item.text}" is not satisfied on screen`;
          if (decision.check === 'unsure') {
            const recovering = await recovery(item, 1, reason);
            if (recovering === 'retry') continue attempts;
            if (recovering) return recovering;
          }
          return failed(item, 1, reason, before.screen, shot);
        }

        if (item.kind === 'wait') {
          resolvedBy = item.target.quoted === undefined ? 'jev' : resolvedBy;
          const budget = item.target.quoted === undefined ? PHRASE_WAIT_BUDGET_MS : WAIT_BUDGET_MS;
          const deadline = deps.now() + budget;
          const held = cached?.item === item ? cached : undefined;
          let observation = held?.observation ?? (await capture(item));
          cached = undefined;
          const probe = visibilityProbe(item, deadline);
          let unsure = false;
          let absent = 0;
          const absentScreens = new Set<string>();
          const visible = async (s: Observation, initial?: ScreenDecision): Promise<boolean> => {
            const observed = await probe(s, initial);
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
            // Repeated literal absence on one unchanged screen is an observed result, not uncertainty.
            if (absent >= 2 && absentScreens.size === 1)
              return failed(
                item,
                1,
                `"${item.target.quoted}" did not appear within ${budget / 1000}s; the screen did not change across ${absent} observations`,
                observation.screen,
                await shoot(item),
              );
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
          let unsure = false;
          const visible = async (s: Observation, initial?: ScreenDecision): Promise<boolean> => {
            const observed = await probe(s, initial);
            observation = observed.observation;
            unsure = observed.unsure === true;
            return observed.found;
          };
          let found = await visible(observation, held?.decision);
          let attempts = 0;
          while (!found && attempts < SCROLL_ATTEMPTS && deps.now() < deadline) {
            const beforeSignature = screenSignature(observation.screen);
            let act: ActResult;
            try {
              act = await mutate(
                item,
                observation,
                (context) =>
                  deps.scroll(
                    scrollUntilDirection(item.until!, observation.screen, item.direction),
                    context,
                  ),
                deadline,
              );
            } catch (error) {
              if (isAbort(error)) throw error;
              if (!(error instanceof EvidenceExpired) || error.itemExpired) throw error;
              metric('refresh', observation);
              await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
              if (deps.now() >= deadline) throw new EvidenceExpired(true);
              observation = await capture(item);
              found = await visible(observation);
              continue;
            }
            attempts += 1;
            await pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - deps.now())));
            if (deps.now() >= deadline) throw new EvidenceExpired(true);
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
          return failed(item, Math.max(attempts, 1), reason, observation.screen, shot);
        }

        // press · fill · back · dialog: snapshot → resolve → act → read-back → snapshot → diff rule
        let outcome: WalkOutcome | undefined;
        let fellBack = false;
        let fillIdentity: string | undefined;
        let typedUnverified = false;
        let again = false;
        let scrolled = false;
        let refusedIdentity: Element | undefined;
        let moved: { target: Element; error: string } | undefined;
        let settledFrame: string | undefined;
        const captureBeforeDispatch = (): Promise<Observation> =>
          (item.kind === 'press' || item.kind === 'fill') &&
          (scrolled || sequence.momentum || fillIdentity !== undefined)
            ? settledCapture(item)
            : capture(item);
        const maxAttempts = recovered.has(item) ? 1 : 2;
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
                `${moved.error}; the target (${identityText(moved.target)}) did not settle across ${settled.frames.length} captures (${settled.frames.join(' | ')}); it was not dispatched again`,
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
          let ref: string | undefined;
          let element: Element | undefined;
          let initial = held?.decision;
          let freshness = attempt === 1 ? 1 : 0;
          let occluded: 'up' | 'down' | undefined;
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
                  const fallback =
                    decided.refuse === 'TARGET_NOT_FOUND' &&
                    item.kind === 'fill' &&
                    deps.typeFocused &&
                    !fellBack &&
                    refusedIdentity === undefined
                      ? keyboardFallbackTarget(item, before.screen)
                      : undefined;
                  if (
                    !fallback &&
                    item.kind === 'fill' &&
                    decided.refuse === 'TARGET_NOT_FOUND' &&
                    item.target.quoted !== undefined &&
                    !item.target.exact &&
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
                  const result = await keyboardFallback(item, attempt, before, fallback, scrolled);
                  if (result === 'typed') {
                    typedUnverified = true;
                    break;
                  }
                  if ('block' in result) {
                    outcome = result;
                    break;
                  }
                  scrolled ||= result.scrolled;
                  before = result.observation;
                  fillIdentity = result.identity;
                  resolution = result;
                } else resolution = decided;
                if ('scroll' in resolution) {
                  if (scrolled) {
                    outcome = failed(
                      item,
                      attempt,
                      `${scrollError ? `${scrollError}; ` : ''}"${item.target.phrase}" stayed off screen after one scroll`,
                      before.screen,
                      await shoot(item),
                    );
                    break;
                  }
                  const result = await mutate(item, before, (context) =>
                    deps.scroll(resolution.scroll, context),
                  );
                  scrolled = true;
                  scrollNeedsReadback = !result.ok && !result.proven;
                  scrollError = result.ok
                    ? undefined
                    : (result.error ?? 'scroll was not dispatched');
                  const signature = screenSignature(before.screen);
                  before = await settledCapture(item);
                  usable(before, item);
                  if (
                    !result.ok &&
                    !result.proven &&
                    screenSignature(before.screen) === signature
                  ) {
                    outcome = failed(
                      item,
                      attempt,
                      `${scrollError}; "${item.target.phrase}" stayed off screen after one scroll`,
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
                  `${moved.error}; the retry resolved ${element ? `${identityText(element)} at ${frameKey(element) ?? 'no frame'}` : 'no element'}, not the target that settled (${identityText(moved.target)} at ${settledFrame}); it was not dispatched`,
                  before.screen,
                  await shoot(item),
                  ref,
                );
                break;
              }
              if (
                (item.kind === 'press' || item.kind === 'fill') &&
                element !== undefined &&
                centreCovered(element, before.screen)
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
                  break;
                }
                refusedIdentity = element;
                occluded = clearanceScroll(element);
                continue;
              }
              if (item.kind === 'fill' && element && isPrivateInput(element)) {
                privacy.concealFallback(item.text, element.secure);
                if (!privateFills.includes(item.line)) privateFills.push(item.line);
              }
              act = await mutate(item, before, (context) =>
                item.kind === 'press'
                  ? deps.press(ref!, context)
                  : item.kind === 'fill'
                    ? deps.fill(ref!, item.text, context)
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
                occluded = clearanceScroll(element);
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
                const result = await keyboardFallback(item, attempt, before, fallback, scrolled);
                if (result === 'typed') {
                  typedUnverified = true;
                  break;
                }
                if ('block' in result) {
                  outcome = result;
                  break;
                }
                scrolled ||= result.scrolled;
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
                    caseNormalized: { chars: [...item.text].length },
                  }
                : unverified
                  ? {
                      reason: redact(
                        `UNVERIFIED_FILL: the field's final value ${act!.evidence === 'masked' ? 'reads back masked' : 'could not be read back'}, so the fill was not verified`,
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
                act!.error
                  ? `${act!.error}; the screen did not change; retrying once`
                  : 'the screen did not change; retrying once',
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
            ? `${act!.error}; ${unchangedScreen}${stillness}${selection}`
            : `${unchangedScreen}${stillness}${selection}`;
          const recovering = await recovery(item, attempt, unchanged);
          if (recovering === 'retry') {
            again = true;
            break;
          }
          outcome = recovering ?? failed(item, attempt, unchanged, after.screen, shot, ref);
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
        return {
          ...failed(item, currentAttempt, error.message, latest, shot, undefined, miss),
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
function valueFree(row: LedgerRow): LedgerRow {
  const { operationId, line, attempt, kind, resolvedBy, t, outcome, screenshot, timing } = row;
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
    ...(screenshot ? { screenshot } : {}),
    ...(timing ? { timing } : {}),
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

// Replay is the same walk over the stored identities, so a literal line never reaches Jev.
export function replayBlock(block: Block, stored: StoredBlock): Block {
  return {
    ...block,
    items: block.items.map((item, i): Item => {
      const step = stored.steps[i];
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
        return { kind: 'fill', target: exact(step.selector!), text: step.text!, ...at };
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
): Promise<WalkResult> {
  return measureTiming(deps.timing, deps.now, 'walk', async () => {
    const walking = withRowTiming(deps);
    const results: BlockResult[] = [];
    const steps: LedgerRow[] = [];
    const written: string[] = [];
    let patchedAt: number | undefined;
    const typed = blocks.flatMap((b) =>
      b.items.flatMap((i) => (i.kind === 'fill' ? [i.text] : [])),
    );
    const planTyped = typed.length;
    const privacy = new ObservedPrivacy(typed);
    privacy.classify(
      deps.login?.block?.items.flatMap((i) => (i.kind === 'fill' ? [i.text] : [])) ?? [],
    );
    let recoveries = 0;
    // A login replay adds its own fills to `typed`.
    const videoPublication = (): NonNullable<WalkResult['videoPublication']> =>
      blocks.some((block) => block.items.some((item) => item.kind === 'fill')) ||
      typed.length > planTyped
        ? 'withheld-fill'
        : privacy.canScreenshot()
          ? 'eligible'
          : 'withheld-privacy';
    const calls = (): JevCall[] => [...preflightCalls, ...(deps.judge?.calls ?? [])];
    const sequence = { observation: 0, publicationInterrupted: false };
    const walk = async (block: Block, opts?: WalkOptions, operations?: Map<number, number>) => {
      const outcome = await walkBlock(
        block,
        walking,
        steps.length,
        typed,
        privacy,
        sequence,
        opts,
        operations,
      );
      recoveries += outcome.recoveries ?? 0;
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
      const values = privacy.privateSet();
      const origins = deps.login?.block ? [...blocks, deps.login.block] : blocks;
      const privateTitle = origins.some(
        (block) => block.slug === slug && matchPrivate(block.title, values, 'identifier').hit,
      );
      return privateTitle || matchPrivate(slug, values, 'identifier').hit ? MASK : slug;
    };
    const unprotected = (value: string): boolean =>
      !matchPrivate(value, privacy.privateSet(), 'persisted').hit;
    const finish = (outcome?: WalkOutcome): WalkResult => {
      if (!deps.cancelled?.()) {
        cancellationSignal();
        for (const { index, write } of pending.splice(0)) results[index] = write();
      }
      const ledger: WalkResult = {
        ...buildLedger(
          results.map((result) => ({ ...result, key: display(result.key) })),
          steps.map(({ selector, ...row }) => ({
            ...row,
            block: display(row.block),
            text: projectPlanLine(row.text, privacy.privateSet()).text,
            ...(row.reason !== undefined ? { reason: privacy.redact(row.reason) } : {}),
            ...(selector && unprotected(selector.id ?? selector.text ?? '') ? { selector } : {}),
          })),
          outcome?.failure
            ? { ...outcome.failure, seen: privacy.redact(outcome.failure.seen) }
            : undefined,
          calls(),
          path(),
          recoveries,
        ),
        videoPublication: videoPublication(),
        publicationInterrupted:
          sequence.publicationInterrupted || deps.publicationInterrupted?.() === true,
      };
      if (store) ledger.blocksWritten = written;
      return outcome?.refusal
        ? {
            ...ledger,
            ...outcome.refusal,
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
      rows: LedgerRow[],
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
      rows: LedgerRow[],
      source: BlockResult['source'],
      store: BlockStore,
      privateFills: number[],
    ): BlockResult => {
      const result = withPrivateFills({ key: block.slug, outcome: 'pass', source }, privateFills);
      if (result.saved === false) return result;
      const serialized = serializeBlock(block, rows, store, privacy.privateSet());
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
        const kept = replayed.rows.filter((row) => row.line < k && row.outcome === 'pass');
        results.push(
          save(block, [...kept, ...rewalked.rows], 'patched', store, [
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
