import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const RUNNER_DIAGNOSTICS_MAX_EVENTS = 200;

export type RunnerDiagnosticEventType =
  | 'spawn-begin'
  | 'payload-verify'
  | 'cache-provision'
  | 'cache-seed'
  | 'cache-publish'
  | 'runner-exec-begin'
  | 'wda-bootstrap-begin'
  | 'flow-park'
  | 'flow-stage'
  | 'typed-failure'
  | 'cleanup'
  | 'tool-outcome';

export interface RunnerDiagnosticEvent {
  sequence: number;
  monotonicMs: number;
  timestamp: string;
  type: RunnerDiagnosticEventType;
  detail: Record<string, unknown>;
}

export interface RunnerDiagnosticsSnapshot {
  rootTool: string;
  rootParams: Record<string, unknown>;
  events: RunnerDiagnosticEvent[];
  truncated: boolean;
}

interface RunnerDiagnosticsState extends RunnerDiagnosticsSnapshot {
  startedAt: number;
  nextSequence: number;
}

const storage = new AsyncLocalStorage<RunnerDiagnosticsState>();
const TERMINAL_EVENT_TYPES = new Set<RunnerDiagnosticEventType>([
  'typed-failure',
  'cleanup',
  'tool-outcome',
]);

export function retainRunnerDiagnosticEvents(
  events: readonly RunnerDiagnosticEvent[],
  maximum: number,
): RunnerDiagnosticEvent[] {
  if (maximum <= 0) return [];
  const retained = [...events];
  while (retained.length > maximum) {
    const counts = new Map<RunnerDiagnosticEventType, number>();
    for (const event of retained) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    let removeAt = retained.findIndex(
      (event) => !TERMINAL_EVENT_TYPES.has(event.type) && (counts.get(event.type) ?? 0) > 1,
    );
    if (removeAt < 0) {
      removeAt = retained.findIndex((event) => !TERMINAL_EVENT_TYPES.has(event.type));
    }
    if (removeAt < 0) {
      removeAt = retained.findIndex((event) => (counts.get(event.type) ?? 0) > 1);
    }
    retained.splice(removeAt < 0 ? 0 : removeAt, 1);
  }
  return retained;
}

export function withRunnerDiagnosticsContext<T>(
  tool: string,
  params: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  if (storage.getStore()) return work();
  return storage.run(
    {
      rootTool: tool,
      rootParams: params,
      events: [],
      truncated: false,
      startedAt: performance.now(),
      nextSequence: 0,
    },
    work,
  );
}

export function recordRunnerDiagnostic(
  type: RunnerDiagnosticEventType,
  detail: Record<string, unknown> = {},
): void {
  const state = storage.getStore();
  if (!state) return;
  const event: RunnerDiagnosticEvent = {
    sequence: ++state.nextSequence,
    monotonicMs: Math.max(0, Math.round((performance.now() - state.startedAt) * 1000) / 1000),
    timestamp: new Date().toISOString(),
    type,
    detail,
  };
  const retained = retainRunnerDiagnosticEvents(
    [...state.events, event],
    RUNNER_DIAGNOSTICS_MAX_EVENTS,
  );
  if (retained.length < state.events.length + 1) {
    state.truncated = true;
  }
  state.events = retained;
}

export function currentRunnerDiagnosticsPlatform(): string | null {
  const value = storage.getStore()?.rootParams.platform;
  return typeof value === 'string' ? value : null;
}

export function snapshotRunnerDiagnostics(): RunnerDiagnosticsSnapshot | undefined {
  const state = storage.getStore();
  if (!state || state.events.length === 0) return undefined;
  return {
    rootTool: state.rootTool,
    rootParams: { ...state.rootParams },
    events: state.events.map((event) => ({ ...event, detail: { ...event.detail } })),
    truncated: state.truncated,
  };
}
