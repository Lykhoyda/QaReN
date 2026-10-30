export type DevOverlayReadError =
  | 'timeout'
  | 'transport'
  | 'coverage_incomplete'
  | 'coverage_unknown'
  | 'other';

export type DevOverlayObservation =
  | { state: 'clear'; front: 'app' | 'dialog' | 'picker' }
  | { state: 'shown'; front: 'dev-menu' | 'dev-fab' }
  | { state: 'unknown'; error: DevOverlayReadError };

export function devOverlayDeadline(
  startedAt: number,
  budgetMs: number,
  walkDeadline: number,
): number {
  return Math.min(startedAt + budgetMs, walkDeadline);
}
