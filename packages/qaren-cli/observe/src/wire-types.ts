// GH #438 — single source of truth for the observe-UI wire shapes.
// PURE TYPES ONLY: this module must never gain a runtime or Node import.
// The browser SPA (src/observability/web) `import type`s it directly — its
// previous hand-copied twins in web/src/types.ts drifted silently (the
// #348/#351 class); a Node import here would leak `node:*` builtins into the
// vite bundle.

export type AgentEventFamily =
  | 'interaction'
  | 'introspection'
  | 'navigation'
  | 'lifecycle'
  | 'testing'
  | 'other';

export interface AgentEvent {
  seq: number;
  ts: number;
  tool: string;
  family: AgentEventFamily;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs?: number;
  error?: { message: string; code?: string };
  ghost?: { attempted: boolean; outcome: string };
  summary: string;
  payload?: unknown;
  truncated?: boolean;
}

export type E2eVerdict = 'green' | 'red' | 'setup_error' | 'empty';
export type E2eResultClassification = 'pass' | 'regression' | 'infra' | 'skipped';

export interface E2eFlowResult {
  testId: string;
  intent: string;
  passed: boolean;
  durationMs: number;
  classification: E2eResultClassification;
  failureKind?: string;
  infraAnnotation?: string | null;
  errorExcerpt?: string | null;
}

export interface E2eRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gitSha: string | null;
  gitDirty: boolean;
  platform: string;
  deviceId: string | null;
  metroReloaded: boolean;
  totals: { total: number; passed: number; failed: number; skipped: number };
  verdict: E2eVerdict;
  results: E2eFlowResult[];
  previousGreenRunId: string | null;
}

export interface E2eRunIndexEntry {
  runId: string;
  finishedAt: string;
  verdict: E2eVerdict;
  totals: { total: number; passed: number; failed: number; skipped: number };
}

export interface ActionSummary {
  id: string;
  intent: string;
  status: string;
  params?: string[];
  mutates?: boolean;
  appId?: string;
}

/** Wire shape of POST /api/e2e/actions/run — E2eServerDeps.runAction result. */
export interface ActionRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  missingParams?: string[];
}
