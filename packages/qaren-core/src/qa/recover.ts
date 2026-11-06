import type { Item, Target } from './plan.js';
import {
  ancestorsOf,
  behindPresentedModal,
  elementFrame,
  hostAssociationIdentity,
  isWindow,
  modalCoverDiagnostic,
  type ModalCoverDiagnostic,
  type Element,
  type Screen,
} from './screen.js';
import { hostPath, MODAL_HOST_TYPES, type HostAssociationDiagnostic } from './host-association.js';
import { reactOnlyTarget, targetOnScreen } from './resolve.js';
import type { Reason } from './untrusted.js';
import type { ActResult } from './walker.js';

export interface LoginMarker {
  id?: string;
  text?: string;
}

export interface RecoveryTarget extends Target {
  // The plan step this target comes from; a placeholder current target has neither.
  line?: number;
  kind?: Item['kind'];
  // From a later block: it always vetoes by presence, even on a sole-decline screen.
  laterBlock?: boolean;
  // The current target follows a passed planned press, so the screen in front is the plan's own.
  afterPlannedPress?: boolean;
}

export type InterruptionScreenClass = 'permission-opt-in';

export type LoginReplay =
  | 'pass'
  | 'fail'
  | { fail: Reason }
  | { refuse: { code: string; message: string } };

export interface RecoverDeps {
  dialog(): Promise<ActResult>;
  hideDevMenu(): Promise<ActResult>;
  replayLogin?(): Promise<LoginReplay>;
  dismiss?(label: string): Promise<LoginReplay>;
  interruptionDiagnostic?(record: InterruptionDiagnostic): void;
}

export type Recovery =
  | {
      handled: 'dialog' | 'dev-menu' | 'dev-fab' | 'login' | 'interruption';
      label?: string;
      screenClass?: InterruptionScreenClass;
    }
  | { fail: Reason }
  | { refuse: { code: string; message: string } };

// Deterministic, in this order; undefined means nothing applies and the original failure stands.
export async function recover(
  screen: Screen,
  deps: RecoverDeps,
  marker?: LoginMarker,
  planTargets: readonly RecoveryTarget[] = [],
  proof?: InterruptionProof,
): Promise<Recovery | undefined> {
  if (screen.front === 'dialog') {
    const acted = await deps.dialog();
    return acted.ok && acted.proven && acted.executed !== false
      ? { handled: 'dialog' }
      : {
          fail: `the system dialog in front could not be handled: ${acted.error ?? 'not proven'}`,
        };
  }
  if (screen.front === 'dev-menu' || screen.front === 'dev-fab') {
    const hidden = await deps.hideDevMenu();
    return hidden.ok && hidden.executed !== false
      ? { handled: screen.front }
      : { fail: `the dev menu in front could not be hidden: ${hidden.error ?? 'not dispatched'}` };
  }
  if (screen.front === 'app' && deps.dismiss) {
    const candidate = dismissCandidate(screen, planTargets, deps.interruptionDiagnostic, proof);
    if (candidate && 'refuse' in candidate) return candidate;
    if (candidate) {
      const dismissed = await deps.dismiss(candidate.label);
      if (dismissed === 'pass')
        return {
          handled: 'interruption',
          label: candidate.label,
          ...(candidate.screenClass ? { screenClass: candidate.screenClass } : {}),
        };
      return dismissed === 'fail' ? { fail: 'the app interruption did not disappear' } : dismissed;
    }
  }
  if (!deps.replayLogin || !marker || !loginWall(screen, marker)) return undefined;
  const replayed = await deps.replayLogin();
  if (replayed === 'pass') return { handled: 'login' };
  return replayed === 'fail' ? { fail: 'the login block did not pass' } : replayed;
}

const DECLINE_LABELS = new Set([
  'Close',
  'Not now',
  'Not Now',
  'Maybe later',
  'Later',
  'Skip',
  'No thanks',
  'Dismiss',
  'Cancel',
  "Don't allow",
  'Don’t allow',
  "Don't Allow",
  'Don’t Allow',
]);
// Declines that leave a permission or opt-in unanswered rather than closing a screen.
const SOFT_DECLINES = new Set(
  [...DECLINE_LABELS].filter((label) => !['Close', 'Dismiss', 'Cancel'].includes(label)),
);
const PERMISSION_ACCEPT = /^(?:(?:allow|enable|turn on)\b|yes\b.*\bnotif|notify me\b)/iu;
const ACCEPT_ALL = new Set(['allow all', 'accept all', 'agree to all', 'enable all']);
const NEGATION = /\b(?:not|no|off|stop|never|don['’]t|disable)\b/iu;
// Control labels that are QaReN's fixed words, so naming one discloses nothing from the app.
export const FIXED_CONTROL_WORDS: ReadonlySet<string> = new Set([
  ...DECLINE_LABELS,
  'Allow',
  'Enable',
  'Turn on',
]);

export function isDeclineLabel(label: string | undefined): label is string {
  return label !== undefined && DECLINE_LABELS.has(label);
}

// What a recovery must prove before it may dismiss: that its target sits behind the presented
// modal, or, for a missing target, that a separate surface interrupts (a proven presented-modal
// cover, or a decline that is the screen's only control) rather than a screen's own Cancel.
export type InterruptionProof = 'covered-target' | 'surface';

export const INTERRUPTION_VETOES = [
  'front',
  'coverage',
  'current-target',
  'uncovered-target',
  'later-target',
  'previous-plan-press',
  'no-candidate',
] as const;

export interface InterruptionDiagnostic {
  veto: (typeof INTERRUPTION_VETOES)[number];
  targetIndex?: number;
  // Which later-target check vetoed: the target is on screen, or it names the decline control itself.
  provenance?: 'presence' | 'ownership';
  soleDecline: boolean;
  exactDeclineCount: number;
  // Why the control count was or was not proven, for the sole-decline and opt-in classes.
  controls: ControlEvidence;
  elements: Array<{
    index: number;
    failed:
      | 'offscreen'
      | 'not-hittable'
      | 'disabled'
      | 'press-not-supported'
      | 'not-visible'
      | 'secure'
      | 'target-ancestor';
    association?: HostAssociationDiagnostic['identity'];
  }>;
  // Why the capture did or did not prove a presented modal over the target, with counts.
  cover?: ModalCoverDiagnostic;
}

export function dismissCandidate(
  screen: Screen,
  planTargets: readonly RecoveryTarget[],
  diagnostic?: (record: InterruptionDiagnostic) => void,
  proof?: InterruptionProof,
):
  | { label: string; screenClass?: InterruptionScreenClass }
  | { refuse: { code: string; message: string } }
  | undefined {
  const sole = soleDecline(screen);
  const rejected = (
    veto: InterruptionDiagnostic['veto'],
    targetIndex?: number,
    elements: InterruptionDiagnostic['elements'] = [],
    provenance?: InterruptionDiagnostic['provenance'],
  ) => {
    try {
      const cover = modalCoverDiagnostic(screen);
      diagnostic?.({
        veto,
        ...(targetIndex === undefined ? {} : { targetIndex }),
        ...(provenance ? { provenance } : {}),
        soleDecline: sole,
        exactDeclineCount: screen.elements.filter(
          (e) => e.label !== undefined && DECLINE_LABELS.has(e.label),
        ).length,
        controls: controlEvidence(screen).evidence,
        elements,
        ...(cover ? { cover } : {}),
      });
    } catch {
      /* Diagnostics cannot change recovery. */
    }
    return undefined;
  };
  if (screen.front !== 'app') return rejected('front');
  if (!completeCapture(screen)) return rejected('coverage');
  if (!planTargets.length) return rejected('current-target', 0);
  if (proof === 'covered-target' && !targetBehindInterruption(screen, planTargets[0]))
    return rejected('uncovered-target', 0);
  const targetIndex = planTargets.findIndex(
    (target, index) =>
      // findIndex reaches a later target only once the current one is absent; with nothing but
      // the decline to act on, a later same-block press or fill matching this screen is a coincidence.
      !(
        index > 0 &&
        sole &&
        !target.laterBlock &&
        target.quoted !== undefined &&
        (target.kind === 'press' || target.kind === 'fill')
      ) && targetOnScreen(screen, target),
  );
  if (targetIndex !== -1) {
    if (targetIndex === 0) return rejected('current-target', 0);
    const target = planTargets[targetIndex];
    const ownsDecline = screen.elements.some(
      (e) =>
        !e.offscreen &&
        e.semantic?.press === 'supported' &&
        e.label !== undefined &&
        DECLINE_LABELS.has(e.label) &&
        (matchesTarget(e, target) ||
          (target.exact !== 'id' && target.quoted?.toLowerCase() === e.label.toLowerCase())),
    );
    return rejected('later-target', targetIndex, [], ownsDecline ? 'ownership' : 'presence');
  }
  const failedPredicate = (
    e: Element,
  ): InterruptionDiagnostic['elements'][number]['failed'] | undefined => {
    if (e.offscreen) return 'offscreen';
    if (!e.hittable) return 'not-hittable';
    if (e.disabled || e.semantic?.disabled === true) return 'disabled';
    if (e.semantic?.press !== 'supported') return 'press-not-supported';
    if (e.semantic.visibility !== 'visible') return 'not-visible';
    if (e.secure) return 'secure';
    if (
      matchesTarget(e, planTargets[0]) ||
      ancestorsOf(e).some((ancestor) =>
        planTargets.some((target) => matchesTarget(ancestor, target)),
      ) ||
      hasPlannedReactAncestor(screen, e, planTargets)
    )
      return 'target-ancestor';
    return undefined;
  };
  const acceptAll = screen.elements.some(
    (e) =>
      !e.offscreen &&
      e.semantic?.press === 'supported' &&
      ACCEPT_ALL.has(e.label?.toLowerCase() ?? ''),
  );
  const candidates = screen.elements.filter(
    (e) => e.label !== undefined && DECLINE_LABELS.has(e.label) && failedPredicate(e) === undefined,
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (candidates.length && planTargets[0].afterPlannedPress)
    return rejected('previous-plan-press', 0);
  const screenClass = only && optInShaped(screen) === only ? 'permission-opt-in' : undefined;
  if (acceptAll) return rejected('no-candidate');
  if (candidates.length > 1)
    return {
      refuse: {
        code: 'INTERRUPTION_AMBIGUOUS',
        message: 'several decline controls are visible; nothing was tapped',
      },
    };
  if (candidates.length === 1) {
    const label = candidates[0].label!.toLowerCase();
    // A later step naming the decline keeps it for that step, even when presence was exempt.
    const plannedIndex = planTargets.findIndex(
      (target, index) =>
        index > 0 &&
        (matchesTarget(candidates[0], target) ||
          (target.exact !== 'id' && target.quoted?.toLowerCase() === label)),
    );
    if (plannedIndex !== -1) return rejected('later-target', plannedIndex, [], 'ownership');
    // A missing target dismisses only a proven separate surface, never a screen's own Cancel:
    // a presented modal, a decline that is the screen's only control, or a recognised opt-in.
    if (proof === 'surface' && !sole && !screenClass && !modalCoverProven(screen))
      return rejected('uncovered-target', 0);
    return { label: candidates[0].label!, ...(screenClass ? { screenClass } : {}) };
  }
  return rejected(
    'no-candidate',
    undefined,
    screen.elements.flatMap((e, index) => {
      if (e.label === undefined || !DECLINE_LABELS.has(e.label)) return [];
      const failed = failedPredicate(e)!;
      const association = failed === 'press-not-supported' ? hostAssociationIdentity(e) : undefined;
      return [{ index, failed, ...(association ? { association } : {}) }];
    }),
  );
}

const CONTROL_KINDS = new Set<Element['kind']>(['button', 'input', 'switch', 'link', 'cell']);

// Value-free facts behind the control count, so a refused classification names its cause.
export interface ControlEvidence {
  evidenceGap: boolean;
  pressGaps: number;
  fillGaps: number;
  unknownPress: number;
  unknownFill: number;
  // Present only when the count is proven.
  controls?: number;
}

const windowOf = (e: Element): Element | undefined => ancestorsOf(e).find(isWindow);
const disabledState = (e: Element): boolean => Boolean(e.disabled) || e.semantic?.disabled === true;

// A window behind the front one can repeat the front window's controls in the same place.
const backCopy = (e: Element, controls: readonly Element[]): boolean => {
  if (e.semantic?.visibility === 'visible' || e.label === undefined) return false;
  const frame = elementFrame(e);
  return controls.some((twin) => {
    const twinFrame = elementFrame(twin);
    return (
      twin !== e &&
      twin.semantic?.visibility === 'visible' &&
      twin.kind === e.kind &&
      twin.label === e.label &&
      // A different test ID or enabled state is a different control, never a copy.
      (e.testID === undefined || e.testID === twin.testID) &&
      disabledState(e) === disabledState(twin) &&
      windowOf(twin) !== windowOf(e) &&
      frame !== undefined &&
      twinFrame !== undefined &&
      frame.x === twinFrame.x &&
      frame.y === twinFrame.y &&
      frame.width === twinFrame.width &&
      frame.height === twinFrame.height
    );
  });
};

export function controlEvidence(screen: Screen): {
  controls?: Element[];
  evidence: ControlEvidence;
} {
  const live = screen.elements.filter(
    (e) => !e.offscreen && !e.semantic?.nativePresence?.structural,
  );
  const evidence: ControlEvidence = {
    evidenceGap: screen.pressEvidenceGap !== undefined,
    pressGaps: screen.pressGapCount ?? 0,
    fillGaps: screen.fillGapCount ?? 0,
    unknownPress: live.filter((e) => e.semantic?.press === 'unknown').length,
    unknownFill: live.filter((e) => e.semantic?.fill === 'unknown').length,
  };
  if (
    evidence.evidenceGap ||
    evidence.pressGaps > 0 ||
    evidence.fillGaps > 0 ||
    evidence.unknownPress > 0 ||
    evidence.unknownFill > 0
  )
    return { evidence };
  const all = live.filter(
    (e) =>
      CONTROL_KINDS.has(e.kind) ||
      e.semantic?.press === 'supported' ||
      e.semantic?.fill === 'supported',
  );
  const controls = all.filter((e) => !backCopy(e, all));
  return { controls, evidence: { ...evidence, controls: controls.length } };
}

// On-screen controls in any state; undefined when press or fill evidence cannot prove the count.
const provenControls = (screen: Screen): Element[] | undefined => controlEvidence(screen).controls;

// Exactly one on-screen control, in any state, and it carries a decline label.
export function soleDecline(screen: Screen): boolean {
  const controls = provenControls(screen);
  return (
    controls?.length === 1 &&
    controls[0].label !== undefined &&
    DECLINE_LABELS.has(controls[0].label)
  );
}

// The capture proves one presented modal covering everything native does not show.
const modalCoverProven = (screen: Screen): boolean => {
  const cover = modalCoverDiagnostic(screen);
  return cover !== undefined && cover.refused === undefined;
};

// A covered step may seek recovery only when its target is proven behind the presented modal,
// never when it is merely absent, so a screen's own Cancel is not pressed for a missing target.
export function targetBehindInterruption(screen: Screen, target: Target): boolean {
  const element = reactOnlyTarget(target, screen);
  return element !== undefined && behindPresentedModal(screen, element);
}

// Exactly two proven controls and no input: a soft decline, returned, and a permission accept.
export function optInShaped(screen: Screen): Element | undefined {
  const controls = provenControls(screen);
  if (controls?.length !== 2) return undefined;
  const decline = controls.find((e) => e.label !== undefined && SOFT_DECLINES.has(e.label));
  const accept = controls.find((e) => e !== decline);
  return decline &&
    accept &&
    controls.every((e) => e.kind !== 'input' && e.semantic?.fill !== 'supported') &&
    // The accept is evidence only when it is proven visible and pressable.
    accept.semantic?.press === 'supported' &&
    accept.semantic.visibility === 'visible' &&
    PERMISSION_ACCEPT.test(accept.label ?? '') &&
    !NEGATION.test(accept.label ?? '') &&
    !ACCEPT_ALL.has(accept.label?.toLowerCase() ?? '')
    ? decline
    : undefined;
}

const completeCapture = (screen: Screen): boolean =>
  (screen.captureCoverage?.native ?? screen.coverage?.native) === 'complete' &&
  screen.coverage?.react === 'complete';

export interface PlannedSurface {
  container?: string;
}

function modalContainers(screen: Screen): Array<string | undefined> | undefined {
  const evidence = screen.reactHostEvidence;
  const typography = evidence?.typography;
  if (!evidence?.complete || !typography?.complete) return undefined;
  return typography.nodes.flatMap((node, index) => {
    if (!MODAL_HOST_TYPES.has(node.hostType ?? '')) return [];
    const host = evidence.hosts[index];
    const id = host?.testID || host?.nativeID;
    return [id ? JSON.stringify([node.hostType, id]) : undefined];
  });
}

export function plannedSurface(after: Screen, before?: Screen): PlannedSurface {
  if (
    !before ||
    before.front !== 'app' ||
    after.front !== 'app' ||
    !completeCapture(before) ||
    !completeCapture(after)
  )
    return {};
  const containers = modalContainers(after);
  const previous = modalContainers(before);
  if (previous && containers?.length === 1 && containers[0] && !previous.includes(containers[0]))
    return { container: containers[0] };
  return {};
}

export function protectionLapses(passed: Screen): boolean {
  return (
    passed.front === 'app' &&
    completeCapture(passed) &&
    !passed.elements.some(
      (e) =>
        !e.offscreen &&
        !e.semantic?.nativePresence?.structural &&
        e.label !== undefined &&
        DECLINE_LABELS.has(e.label) &&
        (e.semantic?.press === 'supported' ||
          e.semantic?.press === 'unknown' ||
          ['button', 'link', 'cell', 'switch'].includes(e.kind)),
    )
  );
}

export function surfaceGone(screen: Screen, surface: PlannedSurface): boolean {
  if (screen.front !== 'app' || !completeCapture(screen) || !surface.container) return false;
  const containers = modalContainers(screen);
  return containers !== undefined && !containers.includes(surface.container);
}

function hasPlannedReactAncestor(
  screen: Screen,
  element: Element,
  targets: readonly RecoveryTarget[],
): boolean {
  const evidence = screen.reactHostEvidence;
  const typography = evidence?.typography;
  if (!element.testID || !evidence?.complete || !typography) return false;
  return evidence.hosts.some((host, index) => {
    if (host.testID !== element.testID) return false;
    for (const parent of hostPath(typography, index)?.slice(1) ?? []) {
      const id = evidence.hosts[parent]?.testID;
      if (
        id &&
        targets.some(
          (target) =>
            matchesTarget({ testID: id }, target) ||
            screen.elements.some((e) => e.testID === id && matchesTarget(e, target)),
        )
      )
        return true;
      const type = typography.nodes[parent].hostType;
      // A modal is a separate surface; its React parents do not own the controls inside it.
      if (MODAL_HOST_TYPES.has(type ?? '')) break;
    }
    return false;
  });
}

function matchesTarget(
  element: Pick<Element, 'testID' | 'label' | 'semantic'>,
  target: Target,
): boolean {
  return (
    target.quoted !== undefined &&
    ((target.exact !== 'text' && element.testID === target.quoted) ||
      (target.exact !== 'id' &&
        !element.semantic?.nativePresence?.structural &&
        element.label === target.quoted))
  );
}

function loginWall(screen: Screen, marker: LoginMarker): boolean {
  return screen.elements.some(
    (e) =>
      !e.offscreen &&
      ((marker.id !== undefined && e.testID === marker.id) ||
        (marker.text !== undefined && e.label === marker.text)),
  );
}
