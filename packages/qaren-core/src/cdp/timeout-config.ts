export type Platform = 'ios' | 'android' | null;

export const CDP_TIMEOUT_FAST = 1500;
export const CDP_TIMEOUT_MS = 5000;
export const CDP_TIMEOUT_SLOW = 30000;

// D637/B118: Android emulator JS thread runs Hermes operations 50-170× slower
// than iOS simulator (Phase 88 benchmark). A single 5s default gave false-negatives
// on typeText / complex store reads — the mutation succeeded but the Runtime.evaluate
// round-trip missed the timeout. 2× multiplier for Android puts p95 back inside budget.
const ANDROID_MULTIPLIER = 2;

const METHOD_TIMEOUTS = new Map<string, number>([
  ['Runtime.getHeapUsage', CDP_TIMEOUT_FAST],
  ['Log.enable', CDP_TIMEOUT_FAST],
  ['Log.disable', CDP_TIMEOUT_FAST],
  ['HeapProfiler.takeHeapSnapshot', CDP_TIMEOUT_SLOW],
  ['HeapProfiler.startTrackingHeapObjects', CDP_TIMEOUT_SLOW],
  ['Profiler.start', CDP_TIMEOUT_SLOW],
  ['Profiler.stop', CDP_TIMEOUT_SLOW],
  ['Network.getResponseBody', CDP_TIMEOUT_SLOW],
]);

function applyPlatformMultiplier(base: number, platform?: Platform): number {
  return platform === 'android' ? base * ANDROID_MULTIPLIER : base;
}

export function timeoutForMethod(method: string, platform?: Platform): number {
  const base = METHOD_TIMEOUTS.get(method) ?? CDP_TIMEOUT_MS;
  return applyPlatformMultiplier(base, platform);
}

export function defaultTimeout(platform?: Platform): number {
  return applyPlatformMultiplier(CDP_TIMEOUT_MS, platform);
}
