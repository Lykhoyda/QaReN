import type { Item, Target } from './plan.js';
import { ancestorsOf, hostAssociationIdentity, type Element, type Screen } from './screen.js';
import { hostPath, MODAL_HOST_TYPES, type HostAssociationDiagnostic } from './host-association.js';
import { targetOnScreen } from './resolve.js';
import type { Reason } from './untrusted.js';
import type { ActResult } from './walker.js';

export interface LoginMarker {
  id?: string;
  text?: string;
}

export interface RecoveryTarget extends Target {
  declared?: Target;
  // The plan step this target comes from; a placeholder current target has neither.
  line?: number;
  kind?: Item['kind'];
  // A target from a later block keeps its own control but never vetoes recovery by mere presence.
  laterBlock?: boolean;
  // The current target follows a passed planned press, so the screen in front is the plan's own.
  afterPlannedPress?: boolean;
  // Modal containers in the capture that passed that press; absent when it was incomplete.
  pressBaseline?: ReadonlyArray<string | undefined>;
  pressOptIn?: boolean;
  // A remaining step's target has no quoted text, so its presence on screen cannot be ruled out.
  unquotedLater?: boolean;
}

// Why a screen after a planned press is independent of it, so its decline may be taken.
export type InterruptionScreenClass = 'permission-opt-in' | 'presented-layer';

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
    const candidate = dismissCandidate(screen, planTargets, deps.interruptionDiagnostic);
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
const DECLINE_LOWER = new Set([...DECLINE_LABELS].map((label) => label.toLowerCase()));
// Declines that leave a permission or opt-in unanswered rather than closing a screen.
const SOFT_DECLINES = new Set(
  [...DECLINE_LABELS].filter((label) => !['Close', 'Dismiss', 'Cancel'].includes(label)),
);
// QaReN's own permission-accept vocabulary, extended by evidence; affirmative only, so a
// destination such as notification settings is never an accept.
const PERMISSION_ACCEPT = /^(?:(?:allow|enable|turn on)\b|yes\b.*\bnotif|notify me\b)/iu;
const NEGATION = /\b(?:not|no|off|stop|never|don['’]t|disable)\b/iu;
// Control labels that are QaReN's fixed words, so naming one discloses nothing from the app.
export const FIXED_CONTROL_WORDS: ReadonlySet<string> = new Set([
  ...DECLINE_LABELS,
  'Allow',
  'Enable',
  'Turn on',
]);

export const INTERRUPTION_VETOES = [
  'front',
  'coverage',
  'current-target',
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
}

export function dismissCandidate(
  screen: Screen,
  planTargets: readonly RecoveryTarget[],
  diagnostic?: (record: InterruptionDiagnostic) => void,
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
      diagnostic?.({
        veto,
        ...(targetIndex === undefined ? {} : { targetIndex }),
        ...(provenance ? { provenance } : {}),
        soleDecline: sole,
        exactDeclineCount: screen.elements.filter(
          (e) => e.label !== undefined && DECLINE_LABELS.has(e.label),
        ).length,
        elements,
      });
    } catch {
      /* Diagnostics cannot change recovery. */
    }
    return undefined;
  };
  if (screen.front !== 'app') return rejected('front');
  if (!completeCapture(screen)) return rejected('coverage');
  if (!planTargets.length) return rejected('current-target', 0);
  const targetIndex = planTargets.findIndex(
    (target, index) =>
      !(index > 0 && target.laterBlock) &&
      !(
        index > 0 &&
        (target.declared ?? target).exact !== 'id' &&
        DECLINE_LOWER.has((target.declared ?? target).quoted?.toLowerCase() ?? '')
      ) &&
      // findIndex reaches a later target only once the current one is absent; with nothing but
      // the decline to act on, a later press or fill matching this screen is a coincidence.
      !(index > 0 && sole && (target.kind === 'press' || target.kind === 'fill')) &&
      targetOnScreen(screen, target),
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
    (e) => !e.offscreen && e.semantic?.press === 'supported' && /\ball\b/iu.test(e.label ?? ''),
  );
  const candidates = screen.elements.filter(
    (e) => e.label !== undefined && DECLINE_LABELS.has(e.label) && failedPredicate(e) === undefined,
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const screenClass: InterruptionScreenClass | undefined =
    !only || (only.label === 'Skip' && acceptAll) || !planTargetsAbsent(screen, planTargets)
      ? undefined
      : (!planTargets[0].afterPlannedPress || planTargets[0].pressOptIn === false) &&
          optInShaped(screen) === only
        ? 'permission-opt-in'
        : planTargets[0].afterPlannedPress &&
            presentedLayer(screen, planTargets[0].pressBaseline, only)
          ? 'presented-layer'
          : undefined;
  // Only a dismissal that would otherwise happen is withheld, so an ordinary miss keeps its own cause.
  if (candidates.length && planTargets[0].afterPlannedPress && !screenClass)
    return rejected('previous-plan-press', 0);
  if (candidates.length > 1)
    return {
      refuse: {
        code: 'INTERRUPTION_AMBIGUOUS',
        message: 'several decline controls are visible; nothing was tapped',
      },
    };
  if (only?.label === 'Skip' && acceptAll) return rejected('no-candidate');
  if (candidates.length === 1) {
    const label = candidates[0].label!.toLowerCase();
    const plannedIndex = planTargets.findIndex(
      (target, index) =>
        index > 0 &&
        (matchesTarget(candidates[0], target) ||
          (target.exact !== 'id' && target.quoted?.toLowerCase() === label)),
    );
    if (plannedIndex !== -1) return rejected('later-target', plannedIndex, [], 'ownership');
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

// On-screen controls in any state; undefined when press or fill evidence cannot prove the count.
function provenControls(screen: Screen): Element[] | undefined {
  if (
    screen.pressEvidenceGap !== undefined ||
    (screen.pressGapCount ?? 0) > 0 ||
    (screen.fillGapCount ?? 0) > 0 ||
    screen.elements.some(
      (e) =>
        !e.offscreen &&
        !e.semantic?.nativePresence?.structural &&
        (e.semantic?.press === 'unknown' || e.semantic?.fill === 'unknown'),
    )
  )
    return undefined;
  return screen.elements.filter(
    (e) =>
      !e.offscreen &&
      !e.semantic?.nativePresence?.structural &&
      (CONTROL_KINDS.has(e.kind) ||
        e.semantic?.press === 'supported' ||
        e.semantic?.fill === 'supported'),
  );
}

// Exactly one on-screen control, in any state, and it carries a decline label.
export function soleDecline(screen: Screen): boolean {
  const controls = provenControls(screen);
  return (
    controls?.length === 1 &&
    controls[0].label !== undefined &&
    DECLINE_LABELS.has(controls[0].label)
  );
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
    !/\ball\b/iu.test(accept.label ?? '')
    ? decline
    : undefined;
}

// A classified screen is independent of the plan only if no plan target could be on it.
function planTargetsAbsent(screen: Screen, planTargets: readonly RecoveryTarget[]): boolean {
  return (
    // Unresolved control evidence could hide a planned control.
    provenControls(screen) !== undefined &&
    !screen.semanticUnassociatedReact &&
    !planTargets[0]?.unquotedLater &&
    // Unlike the absence guard, no target is exempt: a later-block or decline-named one counts too.
    !planTargets.some((target) =>
      [target, target.declared].some((t) => t !== undefined && targetOnScreen(screen, t)),
    )
  );
}

// A new, identified modal container presented on top of the press's screen, holding the candidate.
function presentedLayer(
  screen: Screen,
  baseline: ReadonlyArray<string | undefined> | undefined,
  candidate: Element,
): boolean {
  const evidence = screen.reactHostEvidence;
  const typography = evidence?.typography;
  const hosts = modalHosts(screen);
  if (!baseline?.length || !hosts || !evidence || !typography || !candidate.testID) return false;
  const ids = hosts.map((host) => host.key);
  // Anonymous or duplicate identities never prove absence.
  if (
    [...baseline, ...ids].includes(undefined) ||
    new Set(ids).size < ids.length ||
    new Set(baseline).size < baseline.length
  )
    return false;
  // A replaced modal may be the plan's next screen, so every press-time container must remain.
  if (!baseline.every((key) => ids.includes(key))) return false;
  const fresh = hosts.filter((host) => !baseline.includes(host.key));
  const owners = evidence.hosts.flatMap((host, index) =>
    host.testID === candidate.testID ? [index] : [],
  );
  return (
    fresh.length === 1 &&
    owners.length === 1 &&
    (hostPath(typography, owners[0])?.slice(1).includes(fresh[0].index) ?? false)
  );
}

const completeCapture = (screen: Screen): boolean =>
  (screen.captureCoverage?.native ?? screen.coverage?.native) === 'complete' &&
  screen.coverage?.react === 'complete';

export interface PlannedSurface {
  container?: string;
  optIn?: boolean;
  // Every modal container in the capture that passed the press, for later novelty checks.
  baseline?: Array<string | undefined>;
}

function modalHosts(screen: Screen): Array<{ key?: string; index: number }> | undefined {
  const evidence = screen.reactHostEvidence;
  const typography = evidence?.typography;
  if (!evidence?.complete || !typography?.complete) return undefined;
  return typography.nodes.flatMap((node, index) => {
    if (!MODAL_HOST_TYPES.has(node.hostType ?? '')) return [];
    const host = evidence.hosts[index];
    const id = host?.testID || host?.nativeID;
    return [{ ...(id ? { key: JSON.stringify([node.hostType, id]) } : {}), index }];
  });
}

const modalContainers = (screen: Screen): Array<string | undefined> | undefined =>
  modalHosts(screen)?.map((host) => host.key);

export function plannedSurface(after: Screen, before?: Screen): PlannedSurface {
  const baseline =
    after.front === 'app' && completeCapture(after) ? modalContainers(after) : undefined;
  const surface: PlannedSurface = {
    ...(baseline ? { baseline } : {}),
    ...(after.front === 'app' &&
    completeCapture(after) &&
    provenControls(after) !== undefined &&
    !after.semanticUnassociatedReact
      ? { optIn: optInShaped(after) !== undefined }
      : {}),
  };
  if (!before || before.front !== 'app' || !completeCapture(before) || !baseline) return surface;
  const previous = modalContainers(before);
  if (previous && baseline.length === 1 && baseline[0] && !previous.includes(baseline[0]))
    return { ...surface, container: baseline[0] };
  return surface;
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
