import { NATIVE_CODES, REFUSAL_STAGES } from '../domain/qa-dispatch.js';
import { cleanTimingEvent } from './timing.js';
import { isRecord } from './questions.js';
import { cleanTargetMiss } from './target-miss.js';

export type BlockOutcome = 'pass' | 'fail' | 'refused';
export interface BlockOutcomeDiagnostic {
  kind: 'block-outcome';
  line: number;
  outcome: BlockOutcome;
}

const DISPATCH_CODES = [
  'ACCEPTED',
  'COMPLETED',
  'EVIDENCE_EXPIRED',
  'ITEM_DEADLINE_EXCEEDED',
  'ACTION_INTERRUPTED',
  'ACTION_CONTEXT_CHANGED',
  'RUN_CANCELLED',
  'ACTION_OUTCOME_UNCERTAIN',
  'TARGET_MOVED_BEFORE_DISPATCH',
  'CENTRE_COVERED',
  'SCREEN_EVIDENCE_INCOMPLETE',
];

export function cleanDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'target-miss') return cleanTargetMiss(value);
  const number = (key: string): boolean =>
    typeof value[key] === 'number' &&
    Number.isFinite(value[key]) &&
    value[key] >= 0 &&
    value[key] <= Number.MAX_SAFE_INTEGER;
  if (value.kind === 'metric') {
    const event = cleanTimingEvent(value);
    return event ? { kind: 'metric', ...event } : undefined;
  }
  if (value.kind === 'block-outcome' || value.kind === 'login-outcome') {
    if (!['pass', 'fail', 'refused'].includes(value.outcome as string)) return undefined;
    if (value.kind === 'block-outcome' && (!number('line') || value.line === 0)) return undefined;
    return {
      kind: value.kind,
      outcome: value.outcome,
      ...(value.kind === 'block-outcome' ? { line: value.line } : {}),
    };
  }
  if (
    value.kind !== 'timing' ||
    !['decision', 'dispatch'].includes(value.stage as string) ||
    !DISPATCH_CODES.includes(value.code as string)
  )
    return undefined;
  const event: Record<string, unknown> = { kind: 'timing', stage: value.stage, code: value.code };
  for (const key of [
    'line',
    'at',
    'acquisitionMs',
    'observationAgeMs',
    'authorizations',
    'observation',
  ]) {
    if (value[key] === undefined && ['authorizations', 'observation'].includes(key)) continue;
    if (!number(key)) return undefined;
    event[key] = value[key];
  }
  const refusal = isRecord(value.refusalDiagnostic) ? value.refusalDiagnostic : {};
  if (REFUSAL_STAGES.some((stage) => stage === refusal.stage)) event.refusalStage = refusal.stage;
  if (typeof refusal.mutating === 'boolean') event.mutating = refusal.mutating;
  if (NATIVE_CODES.some((code) => code === refusal.nativeCode))
    event.nativeCode = refusal.nativeCode;
  if (['none', 'observed', 'possible'].includes(refusal.nativeMutation as string))
    event.nativeMutation = refusal.nativeMutation;
  return event;
}
