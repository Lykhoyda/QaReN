import type { Target } from './plan.js';
import { ancestorsOf, type Screen } from './screen.js';
import { literalEvidence } from './evidence.js';
import type { Reason } from './untrusted.js';
import type { ActResult } from './walker.js';

export interface LoginMarker {
  id?: string;
  text?: string;
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
  planTargets: readonly Target[] = [],
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
    const candidate = dismissCandidate(screen, planTargets);
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

export function dismissCandidate(
  screen: Screen,
  planTargets: readonly Target[],
): { label: string } | { refuse: { code: string; message: string } } | undefined {
  if (
    screen.front !== 'app' ||
    (screen.captureCoverage?.native ?? screen.coverage?.native) !== 'complete' ||
    screen.coverage?.react !== 'complete' ||
    !planTargets.length ||
    planTargets.some(
      (target) =>
        target.quoted === undefined ||
        literalEvidence(screen, target.quoted, 'contains').verdict !== 'fail' ||
        screen.elements.some((e) => !e.offscreen && e.testID === target.quoted),
    )
  )
    return;
  const candidates = screen.elements.filter(
    (e) =>
      e.label !== undefined &&
      DECLINE_LABELS.has(e.label) &&
      !e.offscreen &&
      e.hittable &&
      !e.disabled &&
      e.semantic?.disabled !== true &&
      e.semantic?.press === 'supported' &&
      e.semantic.visibility === 'visible' &&
      !e.secure &&
      !ancestorsOf(e).some((ancestor) =>
        planTargets.some(
          (target) => ancestor.testID === target.quoted || ancestor.label === target.quoted,
        ),
      ),
  );
  if (candidates.length > 1)
    return {
      refuse: {
        code: 'INTERRUPTION_AMBIGUOUS',
        message: 'several decline controls are visible; nothing was tapped',
      },
    };
  return candidates.length === 1 ? { label: candidates[0].label! } : undefined;
}

function loginWall(screen: Screen, marker: LoginMarker): boolean {
  return screen.elements.some(
    (e) =>
      !e.offscreen &&
      ((marker.id !== undefined && e.testID === marker.id) ||
        (marker.text !== undefined && e.label === marker.text)),
  );
}
