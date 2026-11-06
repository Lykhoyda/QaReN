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
  // Private so it never serializes: the probed page ids, so a replaced page restarts admission's idle clock.
  readonly #candidates: string;

  constructor(
    readonly counts: DevelopmentTargetCounts,
    readonly complete = true,
    candidates = '',
  ) {
    super('No scoped target proved development mode');
    this.name = 'DevTargetUnavailableError';
    this.#candidates = candidates;
  }

  get candidates(): string {
    return this.#candidates;
  }
}
