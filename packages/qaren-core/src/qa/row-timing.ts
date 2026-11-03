import type { TimingEvent } from './timing.js';

// Only capture, resolve, act, post-capture and other durations partition the row window.
export interface RowTiming {
  captureMs: number;
  nativeMs: number;
  reactMs: number;
  presenceMs?: number;
  settleMethod?: TimingEvent['method'] | 'mixed';
  settleMs?: number;
  preparationSamples?: number;
  preparationResets?: number;
  resolveMs: number;
  jevMs: number;
  actMs: number;
  postCaptureMs: number;
  otherMs: number;
  total: number;
}

export interface LedgerSpeed {
  stepMedianMs?: number;
  stepP95Ms?: number;
  walkMs: number;
  steps: number;
  passed: number;
  failed: number;
}

interface Window {
  capture: number;
  postCapture: number;
  native: number;
  react: number;
  presence?: number;
  resolve: number;
  act: number;
  acted: boolean;
  settleMethod?: RowTiming['settleMethod'];
  settleMs?: number;
  preparationSamples?: number;
  preparationResets?: number;
}

const emptyWindow = (): Window => ({
  capture: 0,
  postCapture: 0,
  native: 0,
  react: 0,
  resolve: 0,
  act: 0,
  acted: false,
});

export interface RowTimer {
  observe(event: TimingEvent): void;
  take(t: number, jevMs: number): RowTiming;
}

// Projects the walker's timing events onto the window between consecutive ledger rows.
export function createRowTimer(startedAt: number): RowTimer {
  let windowStart = startedAt;
  let window = emptyWindow();
  return {
    observe(event) {
      if (event.stage === 'native-preparation' && event.edge === 'point') {
        if (event.count !== undefined)
          window.preparationSamples = (window.preparationSamples ?? 0) + event.count;
        if (event.resets !== undefined)
          window.preparationResets = (window.preparationResets ?? 0) + event.resets;
      }
      const ms = event.ms;
      if (ms === undefined) return;
      if (event.stage === 'native-production') {
        window.presence = (window.presence ?? 0) + ms;
        return;
      }
      if (event.edge !== 'end') return;
      if (event.stage === 'settle') {
        const method = event.method ?? 'unknown';
        window.settleMethod =
          window.settleMethod === undefined || window.settleMethod === method ? method : 'mixed';
        window.settleMs = (window.settleMs ?? 0) + ms;
        return;
      }
      switch (event.stage) {
        case 'capture':
          if (window.acted) window.postCapture += ms;
          else window.capture += ms;
          break;
        case 'native-total':
          window.native += ms;
          break;
        case 'react-private':
          window.react += ms;
          break;
        case 'decision':
          window.resolve += ms;
          break;
        case 'mutation':
          window.act += ms;
          // A dispatch refused before any authorization leaves later captures pre-action.
          if ((event.count ?? 1) > 0) window.acted = true;
          break;
      }
    },
    take(t, jevMs) {
      const total = Math.max(0, Math.round(t - windowStart));
      // Cumulative rounding clamped to the window keeps the partition exact.
      let raw = 0;
      let boundary = 0;
      const part = (ms: number): number => {
        raw += ms;
        const next = Math.min(total, Math.round(raw));
        const size = next - boundary;
        boundary = next;
        return size;
      };
      const captureMs = part(window.capture);
      const resolveMs = part(window.resolve);
      const actMs = part(window.act);
      const postCaptureMs = part(window.postCapture);
      const timing: RowTiming = {
        captureMs,
        nativeMs: Math.round(window.native),
        reactMs: Math.round(window.react),
        ...(window.presence !== undefined ? { presenceMs: Math.round(window.presence) } : {}),
        ...(window.settleMs !== undefined
          ? { settleMethod: window.settleMethod, settleMs: Math.round(window.settleMs) }
          : {}),
        ...(window.preparationSamples !== undefined
          ? { preparationSamples: window.preparationSamples }
          : {}),
        ...(window.preparationResets !== undefined
          ? { preparationResets: window.preparationResets }
          : {}),
        resolveMs,
        jevMs: Math.round(jevMs),
        actMs,
        postCaptureMs,
        otherMs: total - boundary,
        total,
      };
      windowStart = t;
      window = emptyWindow();
      return timing;
    },
  };
}

const operationIdentities = new WeakMap<RowTiming, object>();

export function separateRowOperations(
  rows: readonly { line: number; kind: string; timing?: RowTiming }[],
): void {
  const identities = new Map<string, object>();
  for (const row of rows) {
    if (!row.timing) continue;
    const key = JSON.stringify([row.line, row.kind]);
    const identity = identities.get(key) ?? {};
    identities.set(key, identity);
    operationIdentities.set(row.timing, identity);
  }
}

export function summarizeSpeed(
  rows: readonly { line: number; kind: string; outcome: string; timing?: RowTiming }[],
): LedgerSpeed | undefined {
  if (!rows.some((row) => row.timing)) return undefined;
  const steps = new Map<string | object, { total: number; outcome: string }>();
  let walkMs = 0;
  for (const row of rows) {
    if (!row.timing) continue;
    walkMs += row.timing.total;
    if (row.kind !== 'step' && row.kind !== 'check') continue;
    const key = operationIdentities.get(row.timing) ?? JSON.stringify([row.line, row.kind]);
    steps.set(key, {
      total: (steps.get(key)?.total ?? 0) + row.timing.total,
      outcome: row.outcome,
    });
  }
  const totals = [...steps.values()].map((step) => step.total).sort((a, b) => a - b);
  const mid = Math.floor(totals.length / 2);
  const passed = [...steps.values()].filter((step) => step.outcome === 'pass').length;
  return {
    ...(totals.length
      ? {
          stepMedianMs:
            totals.length % 2 ? totals[mid] : Math.round((totals[mid - 1] + totals[mid]) / 2),
          stepP95Ms: totals[Math.ceil(totals.length * 0.95) - 1],
        }
      : {}),
    walkMs,
    steps: steps.size,
    passed,
    failed: steps.size - passed,
  };
}
