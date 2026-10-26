import type { Target } from './plan.js';
import { ancestorsOf, hostAssociationIdentity, type Element, type Screen } from './screen.js';
import type { HostAssociationDiagnostic } from './host-association.js';
import { literalEvidence } from './evidence.js';
import type { Reason } from './untrusted.js';
import type { ActResult } from './walker.js';

export interface LoginMarker {
  id?: string;
  text?: string;
}

export interface RecoveryTarget extends Target {
  declared?: Target;
  // A target from a later block keeps its own control but never vetoes recovery by mere presence.
  laterBlock?: boolean;
}

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
  | { handled: 'dialog' | 'dev-menu' | 'dev-fab' | 'login' | 'interruption'; label?: string }
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
      if (dismissed === 'pass') return { handled: 'interruption', label: candidate.label };
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
]);
const DECLINE_LOWER = new Set([...DECLINE_LABELS].map((label) => label.toLowerCase()));

export const INTERRUPTION_VETOES = [
  'front',
  'coverage',
  'current-target',
  'later-target',
  'no-candidate',
] as const;

export interface InterruptionDiagnostic {
  veto: (typeof INTERRUPTION_VETOES)[number];
  targetIndex?: number;
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
): { label: string } | { refuse: { code: string; message: string } } | undefined {
  const rejected = (
    veto: InterruptionDiagnostic['veto'],
    targetIndex?: number,
    elements: InterruptionDiagnostic['elements'] = [],
  ) => {
    try {
      diagnostic?.({
        veto,
        ...(targetIndex === undefined ? {} : { targetIndex }),
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
  if (
    (screen.captureCoverage?.native ?? screen.coverage?.native) !== 'complete' ||
    screen.coverage?.react !== 'complete'
  )
    return rejected('coverage');
  if (!planTargets.length) return rejected('current-target', 0);
  const targetIndex = planTargets.findIndex(
    (target, index) =>
      !(index > 0 && target.laterBlock) &&
      !(
        index > 0 &&
        (target.declared ?? target).exact !== 'id' &&
        DECLINE_LOWER.has((target.declared ?? target).quoted?.toLowerCase() ?? '')
      ) &&
      (target.quoted === undefined ||
        (target.exact !== 'id' &&
          literalEvidence(screen, target.quoted, 'contains').verdict !== 'fail') ||
        screen.elements.some(
          (e) => !e.offscreen && target.exact !== 'text' && e.testID === target.quoted,
        )),
  );
  if (targetIndex !== -1)
    return rejected(targetIndex === 0 ? 'current-target' : 'later-target', targetIndex);
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
      ancestorsOf(e).some((ancestor) =>
        planTargets.some((target) => matchesTarget(ancestor, target)),
      )
    )
      return 'target-ancestor';
    return undefined;
  };
  const candidates = screen.elements.filter(
    (e) => e.label !== undefined && DECLINE_LABELS.has(e.label) && failedPredicate(e) === undefined,
  );
  if (candidates.length > 1)
    return {
      refuse: {
        code: 'INTERRUPTION_AMBIGUOUS',
        message: 'several decline controls are visible; nothing was tapped',
      },
    };
  if (candidates.length === 1) {
    const label = candidates[0].label!.toLowerCase();
    const plannedIndex = planTargets.findIndex(
      (target, index) =>
        index > 0 &&
        (matchesTarget(candidates[0], target) ||
          (target.exact !== 'id' && target.quoted?.toLowerCase() === label)),
    );
    if (plannedIndex !== -1) return rejected('later-target', plannedIndex);
    return { label: candidates[0].label! };
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

function matchesTarget(element: Element, target: Target): boolean {
  return (
    target.quoted !== undefined &&
    ((target.exact !== 'text' && element.testID === target.quoted) ||
      (target.exact !== 'id' && element.label === target.quoted))
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
