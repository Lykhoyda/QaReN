export type DevelopmentState = 'true' | 'false' | 'undefined' | 'unknown';

export interface DevelopmentTargetCounts {
  targetsTotal: number;
  devTrue: number;
  devFalse: number;
  devUndefined: number;
  devUnknown: number;
}

export function allTargetsNonDev(counts: DevelopmentTargetCounts): boolean {
  return (
    counts.targetsTotal > 0 &&
    counts.devFalse === counts.targetsTotal &&
    counts.devTrue === 0 &&
    counts.devUndefined === 0 &&
    counts.devUnknown === 0
  );
}

export class DevTargetUnavailableError extends Error {
  constructor(readonly counts: DevelopmentTargetCounts) {
    super('No scoped target proved development mode');
    this.name = 'DevTargetUnavailableError';
  }
}
