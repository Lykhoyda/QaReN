import type { QaDispatchContext } from '../domain/qa-dispatch.js';

export const QA_READ_ONLY_CAPABILITY = 'QA_READ_ONLY_V1';

const INVALIDATED_TARGET_CODES = new Set([
  'ACTION_CONTEXT_CHANGED',
  'KEYBOARD_TARGET_STALE',
  'STALE_REF',
  'NO_TEXT_INPUT_TARGET',
  'TEXT_TARGET_FOCUS_FAILED',
  'OUTSIDE_APP_WINDOW',
  'RUNNER_OWNERSHIP_MISMATCH',
]);

// A moved or replaced target the runner refused before acting; other invalidations stay uncertain.
const MOVED_TARGET_CODES = new Set(['KEYBOARD_TARGET_STALE', 'STALE_REF', 'NO_TEXT_INPUT_TARGET']);

const INVALIDATED_TARGET_REASONS = new Set([
  'app-window-unavailable',
  'exact-target-unresolved',
  'exact-target-point-unavailable',
  'exact-target-missing',
  'exact-target-ambiguous',
  'exact-target-not-clickable',
  'exact-target-not-hittable',
  'coordinate-out-of-bounds',
]);

export function checkQaNativeOutcome(
  context: QaDispatchContext | undefined,
  code: string | undefined,
  data: unknown,
  reason?: string,
  mutation?: string,
): void {
  const verdict = (data as { verifyVerdict?: unknown } | undefined)?.verifyVerdict;
  if (
    (code && INVALIDATED_TARGET_CODES.has(code)) ||
    (code === 'INTERACTION_NOT_ACTUATED' && reason && INVALIDATED_TARGET_REASONS.has(reason)) ||
    verdict === 'target-lost' ||
    verdict === 'ambiguous'
  ) {
    context?.invalidate(
      mutation === 'none' &&
        ((code !== undefined && MOVED_TARGET_CODES.has(code)) ||
          (code === 'INTERACTION_NOT_ACTUATED' && reason?.startsWith('exact-target-') === true)),
    );
  }
}
