// Story 05 (#386): cheap wedged-runtime detector (spec 2026-06-14-263). Taps
// that produce no hierarchy change on N DISTINCT targets in a row suggest the
// app runtime is swallowing touches (paused JS thread / wedged simulator) —
// one dead button tapped repeatedly does not. In-memory by design: a persisted
// counter would recreate the #202 orphaned-lock class of bugs.
export const WEDGED_DISTINCT_TARGETS = 3;

export const WEDGED_RUNTIME_HINT =
  `${WEDGED_DISTINCT_TARGETS} consecutive taps on distinct targets produced no UI change — ` +
  'the app runtime may be wedged (JS thread paused or touch events swallowed). ' +
  'Run cdp_status (iOS auto-recovers a paused JS thread), then cdp_restart with hardReset=true if it persists.';

const streak: string[] = [];

export function recordNoUiChange(targetKey: string): number {
  streak.push(targetKey);
  return new Set(streak).size;
}

export function recordUiChange(): void {
  streak.length = 0;
}

export function _resetNoChangeStreakForTest(): void {
  streak.length = 0;
}
