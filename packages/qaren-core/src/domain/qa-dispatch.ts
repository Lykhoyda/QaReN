import type { ToolErrorCode } from '../types.js';

export type QaDispatchRefusal =
  | 'EVIDENCE_EXPIRED'
  | 'RUN_CANCELLED'
  | 'ACTION_CONTEXT_CHANGED'
  | 'ACTION_OUTCOME_UNCERTAIN'
  | 'TARGET_MOVED_BEFORE_DISPATCH';

export const NATIVE_CODES = [
  'ACTION_CONTEXT_CHANGED',
  'KEYBOARD_TARGET_STALE',
  'STALE_REF',
  'NO_TEXT_INPUT_TARGET',
  'TEXT_TARGET_FOCUS_FAILED',
  'OUTSIDE_APP_WINDOW',
  'RUNNER_OWNERSHIP_MISMATCH',
  'INTERACTION_NOT_ACTUATED',
  'KEYBOARD_RELAYOUT_REQUIRED',
  'RUNNER_TIMEOUT',
  'RUNNER_PROTOCOL_MISMATCH',
] as const satisfies readonly (ToolErrorCode | QaDispatchRefusal | 'KEYBOARD_RELAYOUT_REQUIRED')[];
export const REFUSAL_STAGES = ['dispatch-error', 'native-response', 'settle'] as const;
const NATIVE_REASONS = [
  'app-window-unavailable',
  'exact-target-unresolved',
  'exact-target-point-unavailable',
  'exact-target-missing',
  'exact-target-ambiguous',
  'exact-target-not-clickable',
  'exact-target-not-hittable',
  'coordinate-out-of-bounds',
  'focus-proof-refused',
] as const;

function allowed<T extends string>(value: unknown, values: readonly T[]): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

function fact(facts: unknown, key: string): unknown {
  try {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return undefined;
    return Object.getOwnPropertyDescriptor(facts, key)?.value;
  } catch {
    return undefined;
  }
}

function refusalDiagnostic(refusal: QaDispatchRefusal, facts: unknown) {
  const mutating = fact(facts, 'mutating');
  const responseOk = fact(facts, 'responseOk');
  return Object.freeze({
    refusal: allowed(refusal, [
      'EVIDENCE_EXPIRED',
      'RUN_CANCELLED',
      'ACTION_CONTEXT_CHANGED',
      'ACTION_OUTCOME_UNCERTAIN',
      'TARGET_MOVED_BEFORE_DISPATCH',
    ] as const),
    stage: allowed(fact(facts, 'stage'), REFUSAL_STAGES),
    mutating: typeof mutating === 'boolean' ? mutating : null,
    responseOk: typeof responseOk === 'boolean' ? responseOk : null,
    nativeCode: allowed(fact(facts, 'nativeCode'), NATIVE_CODES),
    nativeReason: allowed(fact(facts, 'nativeReason'), NATIVE_REASONS),
    nativeMutation: allowed(fact(facts, 'nativeMutation'), [
      'none',
      'observed',
      'possible',
    ] as const),
    probeState: allowed(fact(facts, 'probeState'), ['completed', 'failed', 'unknown'] as const),
    recovery: allowed(fact(facts, 'recovery'), ['recovered', 'recovered-error', 'resent'] as const),
    ...(fact(facts, 'sendUnresolved') === true ? { sendUnresolved: true as const } : {}),
  });
}

function measuredSettle(meta: unknown) {
  const ms = fact(fact(meta, 'timings_ms'), 'settle');
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER)
    return undefined;
  const settle = fact(meta, 'settle');
  const settled = fact(settle, 'settled');
  const hierarchyChanged = fact(settle, 'hierarchyChanged');
  return Object.freeze({
    settle: Object.freeze({
      method: allowed(fact(settle, 'method'), [
        'window-gate',
        'screen-static',
        'snapshot-eq',
        'timeout',
      ] as const),
      settled: typeof settled === 'boolean' ? settled : null,
      hierarchyChanged: typeof hierarchyChanged === 'boolean' ? hierarchyChanged : null,
    }),
    timings_ms: Object.freeze({ settle: ms }),
  });
}

export type QaDispatchDiagnostic = ReturnType<typeof refusalDiagnostic>;

export const PRESS_RETRY_REASONS = [
  'press-retry-screen-changed',
  'press-retry-target-changed',
  'press-retry-no-effect',
  'press-retry-evidence-unavailable',
] as const;
export type PressRetryReason = (typeof PRESS_RETRY_REASONS)[number];

export function asPressRetryReason(value: unknown): PressRetryReason | undefined {
  return allowed(value, PRESS_RETRY_REASONS) ?? undefined;
}

export const PRESS_DISPOSITIONS = ['none', 'possible', 'observed', 'unknown'] as const;
export type PressDisposition = (typeof PRESS_DISPOSITIONS)[number];

export function pressDisposition(result: {
  ok: boolean;
  proven: boolean;
  executed?: boolean;
  mutation?: 'none' | 'observed' | 'possible';
}): PressDisposition {
  if (result.executed === false || result.mutation === 'none') {
    return result.ok ||
      result.proven ||
      result.executed === true ||
      result.mutation === 'observed' ||
      result.mutation === 'possible'
      ? 'unknown'
      : 'none';
  }
  if (result.proven || result.executed === true || result.mutation === 'observed')
    return 'observed';
  return result.ok || result.mutation === 'possible' ? 'possible' : 'unknown';
}

const UNCERTAIN_REASONS = [
  ...PRESS_RETRY_REASONS,
  'keyboard-visible',
  'alert-blocked',
  'dispatch-unconfirmed',
  'context-unverified',
  'deadline-expired',
  'scroll-unverified',
  'unknown',
] as const;
export type UncertainReason = (typeof UNCERTAIN_REASONS)[number];

export function asUncertainReason(value: unknown): UncertainReason | undefined {
  return allowed(value, UNCERTAIN_REASONS) ?? undefined;
}

export function uncertainReason(value: unknown): UncertainReason {
  return asUncertainReason(value) ?? 'unknown';
}

// The first refusal decides the reason: an expiry or a lost context is named for what it is.
export function uncertainReasonOf(first: QaDispatchError): UncertainReason {
  if (first.code === 'EVIDENCE_EXPIRED') return 'deadline-expired';
  if (first.code === 'ACTION_CONTEXT_CHANGED') return 'context-unverified';
  return uncertainReason(first.uncertainReason);
}

export class QaDispatchError extends Error {
  private measuredSettle?: ReturnType<typeof measuredSettle>;
  readonly uncertainReason: UncertainReason | undefined;

  get settleMeta() {
    return this.measuredSettle;
  }

  retainSettle(meta: unknown): void {
    this.measuredSettle ??= measuredSettle(meta);
  }

  constructor(
    readonly code: QaDispatchRefusal,
    reason?: unknown,
  ) {
    super(code);
    this.name = 'QaDispatchError';
    this.uncertainReason =
      code === 'ACTION_OUTCOME_UNCERTAIN' ? uncertainReason(reason) : undefined;
  }
}

export class QaDispatchContext {
  private failure?: QaDispatchError;
  private sends = 0;
  private attested = false;
  private diagnostic?: QaDispatchDiagnostic;

  constructor(
    readonly deadline: number,
    private readonly now: () => number,
    private readonly cancelled: () => boolean = () => false,
    readonly line?: number,
  ) {}

  get authorizations(): number {
    return this.sends;
  }

  get refusal(): QaDispatchError | undefined {
    return this.failure;
  }

  get refusalDiagnostic(): QaDispatchDiagnostic | undefined {
    return this.diagnostic;
  }

  diagnoseRefusal<T>(facts: () => unknown, operation: () => T): T {
    const earlier = this.failure;
    try {
      return operation();
    } catch (error) {
      if (!earlier && !this.diagnostic && this.failure && error === this.failure) {
        let observed: unknown;
        try {
          observed = facts();
        } catch {
          /* Diagnostics cannot replace the refusal. */
        }
        this.diagnostic = refusalDiagnostic(this.failure.code, observed);
      }
      throw error;
    }
  }

  // The runner attested that the only authorized send changed nothing before refusing it.
  get refusedBeforeMutation(): boolean {
    return this.attested && this.sends === 1;
  }

  // Probes the time budget without recording a refusal; cancellation stays with check().
  get expired(): boolean {
    const now = this.now();
    return (
      this.failure !== undefined ||
      !Number.isFinite(now) ||
      !Number.isFinite(this.deadline) ||
      this.deadline < 0 ||
      now >= this.deadline
    );
  }

  refuse(code: 'ACTION_OUTCOME_UNCERTAIN', reason: UncertainReason): never;
  refuse(code: Exclude<QaDispatchRefusal, 'ACTION_OUTCOME_UNCERTAIN'>): never;
  refuse(code: QaDispatchRefusal, reason?: UncertainReason): never {
    this.failure ??= new QaDispatchError(code, reason);
    throw this.failure;
  }

  check(): void {
    this.assertComplete();
    if (this.cancelled()) this.refuse('RUN_CANCELLED');
    const now = this.now();
    if (!Number.isFinite(now) || !Number.isFinite(this.deadline) || this.deadline < 0) {
      this.refuse('ACTION_CONTEXT_CHANGED');
    }
    if (now >= this.deadline) this.refuse('EVIDENCE_EXPIRED');
  }

  authorize(): void {
    this.check();
    this.sends++;
  }

  invalidate(attestedNoMutation = false): never {
    if (!this.failure) this.attested = attestedNoMutation;
    return this.refuse('ACTION_CONTEXT_CHANGED');
  }

  assertComplete(): void {
    if (this.failure) throw this.failure;
  }
}
