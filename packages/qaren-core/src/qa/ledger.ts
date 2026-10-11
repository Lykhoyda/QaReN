export type RowOutcome = 'pass' | 'fail' | 'retry';

export interface Selector {
  id?: string;
  text?: string;
}

export type LedgerPath = 'walk' | 'replay' | `replay→walk@${number}`;

export interface LedgerRow {
  block: string;
  operationId?: number;
  line: number;
  text: string;
  attempt: number;
  kind: 'step' | 'check';
  resolvedBy: 'exact' | 'jev';
  ref?: string;
  screenshot?: string;
  t: number;
  outcome: RowOutcome;
  reason?: string;
  timing?: RowTiming;
  selector?: Selector;
  // Typed and held character counts of an unverified fill, kept out of the masked reason.
  kept?: { typed: number; observed: number[] };
  // Characters typed into a field that changed only their letter case.
  caseNormalized?: { chars: number };
  // The system dialog button the runner proved it tapped.
  dialog?: { label: string; rect: { x: number; y: number; width: number; height: number } };
}

// The value-free announcement that a plan line begins; its row later carries the same operationId.
export interface StepStart {
  operationId: number;
  line: number;
  kind: LedgerRow['kind'];
  t: number;
}

export interface LedgerFailure {
  step: number;
  seen: string;
  screenshot?: string;
}

export interface BlockResult {
  key: string;
  outcome: 'pass' | 'fail';
  source: 'discovered' | 'replayed' | 'patched';
  saved?: false;
  unsavable?: string;
}

export interface Ledger {
  verdict: 'PASS' | 'FAIL';
  videoPublication?: 'eligible' | 'withheld-fill' | 'withheld-privacy' | 'unknown';
  admittedAtMs?: number;
  publicationInterrupted?: boolean;
  path: LedgerPath;
  blocks: BlockResult[];
  blocksWritten?: string[];
  steps: LedgerRow[];
  jev: JevRollup;
  llmTurns: number;
  escapes: number;
  recoveries: number;
  speed?: LedgerSpeed;
  failure?: LedgerFailure;
}

export interface RefusedLedger extends Omit<Ledger, 'verdict'> {
  verdict: 'REFUSED';
  code: string;
  message: string;
}

export type WalkResult = Ledger | RefusedLedger;

// The verdict never contradicts the rows: a failed row or block without a failure detail synthesizes one.
export function buildLedger(
  blocks: BlockResult[],
  steps: LedgerRow[],
  failure?: LedgerFailure,
  calls: readonly JevCall[] = [],
  path: LedgerPath = 'walk',
  recoveries = 0,
): Ledger {
  const failedRow = [...steps].reverse().find((r) => r.outcome === 'fail');
  const failedBlock = blocks.find((b) => b.outcome === 'fail');
  if (!failure && (failedRow || failedBlock)) {
    failure = {
      step: failedRow?.line ?? 0,
      seen: failedRow?.reason ?? `block ${failedBlock?.key ?? ''} failed`,
      ...(failedRow?.screenshot ? { screenshot: failedRow.screenshot } : {}),
    };
  }
  const ledger: Ledger = {
    verdict: failure ? 'FAIL' : 'PASS',
    path,
    blocks,
    steps,
    jev: summarizeJev(calls),
    llmTurns: 0,
    escapes: 0,
    recoveries,
  };
  const speed = summarizeSpeed(steps);
  if (speed) ledger.speed = speed;
  if (failure) ledger.failure = failure;
  return ledger;
}

export interface JevRollup {
  calls: number;
  medianMs: number;
  inputTokens: number;
  callDetails: JevCall[];
}

export function summarizeJev(calls: readonly JevCall[]): JevRollup {
  const sorted = calls.map((call) => call.ms).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = !sorted.length
    ? 0
    : sorted.length % 2
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return {
    calls: calls.length,
    medianMs,
    inputTokens: calls.reduce((n, call) => n + (call.inputTokens ?? 0), 0),
    callDetails: [...calls],
  };
}

// A walk that ended without a verdict is a FAIL attributed to its last row; its rows cannot give a walk time.
export function ledgerWithoutResult(steps: LedgerRow[], seen: string): Ledger {
  const last = steps[steps.length - 1];
  const { speed: _speed, ...ledger } = buildLedger([], steps, {
    step: last?.line ?? 0,
    seen,
    ...(last?.screenshot ? { screenshot: last.screenshot } : {}),
  });
  return ledger;
}

export function screenshotName(index: number, line: number): string {
  return `screenshots/${String(index).padStart(2, '0')}-line${line}.png`;
}
import type { JevCall } from './questions.js';
import { summarizeSpeed, type LedgerSpeed, type RowTiming } from './row-timing.js';
