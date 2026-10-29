import { currentInputs, InputPrivacyRefusal } from './inputs.js';
import type { ToolResult } from '../utils.js';

export class HandlerError extends Error {
  readonly code: string;
  readonly meta?: Record<string, unknown>;

  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'HandlerError';
    this.code = code;
    this.meta = meta;
  }
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
  code?: string;
  meta?: Record<string, unknown>;
}

export interface Unwrapped<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export function unwrap<T>(result: ToolResult): Unwrapped<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content[0]?.text ?? '');
  } catch {
    throw new HandlerError('BAD_RESPONSE', 'the handler returned a non-JSON envelope');
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Envelope<T>).ok !== 'boolean') {
    throw new HandlerError('BAD_RESPONSE', 'the handler returned an envelope without an ok flag');
  }
  const envelope = parsed as Envelope<T>;
  if (result.isError || envelope.ok !== true) {
    const code =
      envelope.code ??
      (typeof envelope.meta?.code === 'string' ? (envelope.meta.code as string) : 'HANDLER_FAILED');
    throw new HandlerError(code, envelope.error ?? 'the handler failed', envelope.meta);
  }
  return { data: envelope.data as T, ...(envelope.meta ? { meta: envelope.meta } : {}) };
}

// The kept handlers stay as they are; the walker calls them through this unwrap.
export function adapt<A, T = unknown>(
  handler: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<Unwrapped<T>> {
  return async (args) => unwrap<T>(await handler(args));
}

// The evidence class a refused fill still proved; masked and unavailable are unverified, never verified.
export function fillEvidence(
  error: unknown,
): 'masked' | 'unavailable' | 'mismatch' | 'case-normalized' | undefined {
  if (!(error instanceof HandlerError) || error.code !== 'TEXT_ENTRY_UNVERIFIED') return undefined;
  const evidence = (error.meta?.verification as { evidence?: unknown } | undefined)?.evidence;
  return evidence === 'masked' ||
    evidence === 'unavailable' ||
    evidence === 'mismatch' ||
    evidence === 'case-normalized'
    ? evidence
    : undefined;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof InputPrivacyRefusal) return { code: 'CORE_REFUSED', message: error.message };
  const described = describeRawError(error);
  const inputs = currentInputs();
  if (inputs?.hasStrictInputs)
    return { code: described.code, message: '[private output withheld]' };
  return inputs?.hasInputs
    ? { ...described, message: inputs.redact(described.message) }
    : described;
}

function describeRawError(error: unknown): { code: string; message: string } {
  if (error instanceof HandlerError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const prefixed = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(message);
  return prefixed
    ? { code: prefixed[1], message: prefixed[2] }
    : { code: 'UNEXPECTED_ERROR', message };
}
