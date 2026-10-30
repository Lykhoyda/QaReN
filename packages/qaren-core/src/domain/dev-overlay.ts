export type DevOverlayReadError =
  | 'timeout'
  | 'transport'
  | 'coverage_incomplete'
  | 'coverage_unknown'
  | 'unknown_front'
  | 'other';

export type DevOverlayObservation =
  | { state: 'clear'; front: 'app' }
  | { state: 'shown'; front: 'dev-menu' | 'dev-fab' }
  | { state: 'unknown'; error: DevOverlayReadError };
