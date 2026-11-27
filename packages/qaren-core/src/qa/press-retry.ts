import {
  PRESS_RETRY_REASONS,
  type PressDisposition,
  type PressRetryReason,
} from '../domain/qa-dispatch.js';
import { literalEvidence, type LiteralVerdict } from './evidence.js';
import { exactIdentities, sameIdentity } from './identity.js';
import type { Item, Step, Target } from './plan.js';
import { elementSelector, prepareTarget, ResolutionError, targetEvidence } from './resolve.js';
import { elementFrame, screenSignature, type Element, type Screen } from './screen.js';

export const PRESS_RETRY_WINDOW_MS = 4_000;
export const PRESS_RETRY_READS = 8;
export const PRESS_RETRY_POLL_MS = 500;
export const LATE_PRESS_PASS = 'The planned transition appeared after the first readback.';
export const LOGIN_BLOCK_FAILED = 'the login block did not pass: ';

const DETAILS: Record<PressRetryReason, string> = {
  'press-retry-screen-changed': 'The screen changed without proving the planned transition.',
  'press-retry-target-changed':
    'The original target changed without proving the planned transition.',
  'press-retry-no-effect': 'No effect was observed within the window.',
  'press-retry-evidence-unavailable': 'The observation window did not provide enough evidence.',
};

export function pressRetryDetail(reason: PressRetryReason, disposition: PressDisposition): string {
  const sent =
    disposition === 'none'
      ? 'The original action was never sent.'
      : 'The original action may have taken effect.';
  return `ACTION_OUTCOME_UNCERTAIN: ${DETAILS[reason]} ${sent}`;
}

const PRESS_DETAILS = PRESS_RETRY_REASONS.flatMap((reason) => [
  pressRetryDetail(reason, 'none'),
  pressRetryDetail(reason, 'possible'),
]);

const FIXED_PRESS_DETAILS = new Set([
  LATE_PRESS_PASS,
  ...PRESS_DETAILS,
  ...PRESS_DETAILS.map((detail) => `${LOGIN_BLOCK_FAILED}${detail}`),
]);

export const isFixedPressRetryDetail = (detail: string): boolean => FIXED_PRESS_DETAILS.has(detail);

const nativeComplete = (screen: Screen): boolean =>
  (screen.captureCoverage?.native ?? screen.coverage?.native) === 'complete';

const appFront = (screen: Screen): boolean =>
  screen.front === 'app' && nativeComplete(screen) && !screen.devError && !screen.renderError;

export function frameKey(element: Element): string | undefined {
  const rect = elementFrame(element);
  return rect ? [rect.x, rect.y, rect.width, rect.height].join(',') : undefined;
}

const visible = (element: Element): boolean =>
  !element.offscreen &&
  (element.visibilityEvidence ?? element.semantic?.visibility ?? 'visible') === 'visible';

const nativeVisible = (element: Element): boolean =>
  !element.ref.startsWith('react:') && visible(element);

function positiveFrame(element: Element): string | undefined {
  const rect = elementFrame(element);
  if (rect && Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    return frameKey(element);
}

type TargetChange = 'unchanged' | 'changed' | 'unavailable';

function targetChange(original: Element | undefined, screen: Screen): TargetChange {
  const selector = original && elementSelector(original);
  const beforeFrame = original && positiveFrame(original);
  if (!original || !selector || !beforeFrame || !nativeVisible(original) || original.disabled)
    return 'unavailable';
  const quoted = selector.id ?? selector.text!;
  const target: Target = {
    quoted,
    phrase: quoted,
    exact: selector.id === undefined ? 'text' : 'id',
  };
  const identities = exactIdentities(screen, target, 'press');
  if (identities.length !== 1) return 'changed';
  const found = identities[0].element;
  if (!sameIdentity(found, original) || !nativeVisible(found) || found.disabled) return 'changed';
  const frame = positiveFrame(found);
  if (frame === undefined || frame !== beforeFrame) return 'changed';
  const resolution = prepareTarget({ kind: 'press', target }, screen);
  if ('ref' in resolution) return resolution.element === found ? 'unchanged' : 'changed';
  return 'refuse' in resolution ? 'changed' : 'unavailable';
}

// Title and ordered button labels of a system prompt, held in memory only.
export const promptSignature = (screen: Screen): string =>
  JSON.stringify([
    screen.elements.find((e) => e.kind !== 'button' && e.label !== undefined)?.label,
    screen.elements.flatMap((e) => (e.kind === 'button' && e.label !== undefined ? [e.label] : [])),
  ]);

function dialogVote(before: Screen, current: Screen): string | undefined {
  const pid = before.appProcessIdentifier;
  if (
    current.front !== 'dialog' ||
    current.devError ||
    current.renderError ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    current.appProcessIdentifier !== pid
  )
    return;
  const elements = current.elements.filter((e) => nativeVisible(e) && e.label?.trim());
  if (elements.some((e) => e.kind !== 'button') && elements.some((e) => e.kind === 'button'))
    return promptSignature({ ...current, elements });
}

function idEvidence(step: Step, target: Target, screen: Screen): LiteralVerdict {
  const identities = exactIdentities(screen, target, step.kind);
  if (identities.length === 0) return 'fail';
  if (identities.length !== 1) return 'unsure';
  if (step.kind === 'wait') return targetEvidence(target, screen);
  const element = identities[0].element;
  if (!nativeVisible(element) || element.disabled) return 'unsure';
  if (step.kind === 'press' || step.kind === 'fill') {
    const resolved = prepareTarget({ ...step, target }, screen);
    return 'ref' in resolved && resolved.element === element ? 'pass' : 'unsure';
  }
  return 'unsure';
}

function appVote(
  next: Item | undefined,
  before: Screen,
  first: Screen,
  current: Screen,
): string | undefined {
  if (!next || !appFront(first) || !appFront(current)) return;
  const screens = [before, first, current];
  if (next.kind === 'check' && next.literal) {
    const [a, b, c] = screens.map(
      (screen) => literalEvidence(screen, next.text, 'contains').verdict,
    );
    if (a === 'fail' && b === 'fail' && c === 'pass') return 'check';
    return;
  }
  if (next.kind !== 'wait' && next.kind !== 'press' && next.kind !== 'fill') return;
  const target = next.target;
  if (target.quoted === undefined || (target.exact === 'text' && next.kind !== 'wait')) return;
  const id = { ...target, exact: 'id' } as const;
  const useId =
    next.kind !== 'wait' ||
    target.exact === 'id' ||
    (target.exact === undefined &&
      screens.some((screen) => exactIdentities(screen, id, 'wait').length > 0));
  const verdict = (screen: Screen): LiteralVerdict => {
    try {
      return useId ? idEvidence(next, id, screen) : targetEvidence(target, screen);
    } catch (error) {
      if (!(error instanceof ResolutionError)) throw error;
      if (!useId && literalEvidence(screen, target.quoted!, 'equals').verdict === 'fail')
        return 'fail';
      return 'unsure';
    }
  };
  const [a, b, c] = screens.map(verdict);
  if (a === 'fail' && b === 'fail' && c === 'pass') return useId ? 'id' : 'text';
}

export class PressRetryEvidence {
  readonly initialUnchanged: boolean;
  readonly initialDialog: boolean;
  private readonly proofEligible: boolean;
  targetChanged = false;
  interrupted = false;
  proofReads = 0;
  private unexpectedFront = false;
  private expectedDialog = false;
  private appSignatureChanged: boolean;
  private lastReadStill = false;
  private readonly signature?: string;
  private previousVote?: string;

  constructor(
    private readonly before: Screen,
    private readonly first: Screen | undefined,
    private readonly next: Item | undefined,
    private readonly original: Element | undefined,
    disposition: PressDisposition,
  ) {
    const beforeApp = appFront(before);
    const firstApp = first !== undefined && appFront(first);
    this.signature = beforeApp ? screenSignature(before) : undefined;
    this.initialUnchanged = firstApp && this.signature === screenSignature(first);
    this.initialDialog = first?.front === 'dialog';
    this.proofEligible = beforeApp && (disposition === 'possible' || disposition === 'observed');
    this.expectedDialog = this.initialDialog && next?.kind === 'dialog';
    this.unexpectedFront =
      (first !== undefined && first.front !== before.front && !this.expectedDialog) ||
      (this.initialDialog && !this.expectedDialog);
    this.appSignatureChanged = beforeApp && firstApp && !this.initialUnchanged;
  }

  get screenChanged(): boolean {
    return this.unexpectedFront || this.expectedDialog || this.appSignatureChanged;
  }

  resetRead(): void {
    this.previousVote = undefined;
    this.proofReads = 0;
    this.lastReadStill = false;
  }

  admit(current: Screen): void {
    let vote: string | undefined;
    this.lastReadStill = false;
    if (appFront(current)) {
      const change = targetChange(this.original, current);
      const signature = screenSignature(current);
      if (this.signature !== undefined && signature !== this.signature)
        this.appSignatureChanged = true;
      if (change === 'changed') this.targetChanged = true;
      this.lastReadStill =
        this.initialUnchanged && signature === this.signature && change === 'unchanged';
      if (this.proofEligible && this.first)
        vote = appVote(this.next, this.before, this.first, current);
    } else if (current.front === 'dialog' && this.next?.kind === 'dialog') {
      this.expectedDialog = true;
      if (this.proofEligible) vote = dialogVote(this.before, current);
    } else if (current.front !== this.before.front) {
      this.unexpectedFront = true;
      this.interrupted = current.front === 'dialog' && !current.devError && !current.renderError;
    }
    this.proofReads = vote === undefined ? 0 : vote === this.previousVote ? 2 : 1;
    this.previousVote = vote;
  }

  failure(): PressRetryReason {
    if (this.unexpectedFront) return 'press-retry-screen-changed';
    if (this.targetChanged) return 'press-retry-target-changed';
    if (this.appSignatureChanged) return 'press-retry-screen-changed';
    return this.lastReadStill && !this.expectedDialog
      ? 'press-retry-no-effect'
      : 'press-retry-evidence-unavailable';
  }
}
