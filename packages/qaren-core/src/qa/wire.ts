import { RunInputs, withInputs, currentInputs } from './inputs.js';
import { cleanDiagnostic } from './diagnostics.js';
import { ObservedPrivacy } from './privacy.js';
import { assertLoginPolicy, inputInventory } from './input-preflight.js';
import { readBlock } from './blocks.js';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Ledger, LedgerRow, StepStart, WalkResult } from './ledger.js';
import { ledgerWithoutResult } from './ledger.js';
import type { PreparedPlan } from './plan.js';
import { type JevCall, isRecord } from './questions.js';
import type { LoginMarker } from './recover.js';
import { isValidActionId } from '../domain/path-safety.js';

export const WIRE_VERSION = 1 as const;

export type EnvelopeType =
  | 'request'
  | 'admitted'
  | 'start'
  | 'diagnostic'
  | 'row'
  | 'resource'
  | 'result'
  | 'cancel';

export interface Envelope<T = unknown> {
  v: typeof WIRE_VERSION;
  runId: string;
  seq: number;
  type: EnvelopeType;
  payload: T;
}

export interface WireTarget {
  deviceId: string;
  // The name Metro reports for the device's runtime; on iOS that is the simulator's name.
  deviceName: string;
  metroPort: number;
  metroUrlForDevice: string;
  worktree: string;
  // The CLI's Metro drain count of bundle requests, and its value when the app launched.
  metroBundleRequests?: { path: string; atLaunch: number };
}

export interface WireRequest {
  runId: string;
  t0: number;
  walkBudgetMs: number;
  attachBudgetMs: number;
  plan: string;
  prepared?: PreparedPlan;
  preflightCalls?: JevCall[];
  platform: 'ios' | 'android';
  appId: string;
  appRoot: string;
  runDir: string;
  lease: string;
  target: WireTarget;
  loginBlock?: string;
  loginMarker?: LoginMarker;
  loginSnapshot?: { slug: string; content: string | null };
}

// Exactly one of id or text, never empty.
export function validMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    (keys[0] === 'id' || keys[0] === 'text') &&
    typeof value[keys[0]] === 'string' &&
    (value[keys[0]] as string).length > 0
  );
}

export interface Refusal extends Partial<Omit<Ledger, 'verdict'>> {
  verdict: 'REFUSED';
  code: string;
  message: string;
  lease: string;
}

export type ResultPayload = Ledger | Refusal;

export function resultForWalk(result: WalkResult, lease: string): ResultPayload {
  return result.verdict === 'REFUSED' ? { ...result, lease } : result;
}

export class WireError extends Error {}

// The result line and the exit code must agree: 0 PASS, 1 FAIL, 4 typed refusal.
export function exitCodeFor(result: ResultPayload): 0 | 1 | 4 {
  switch (result.verdict) {
    case 'PASS':
      return 0;
    case 'FAIL':
      return 1;
    default:
      return 4;
  }
}

export function verdictAgrees(verdict: string, exit: number): boolean {
  return (
    (verdict === 'PASS' && exit === 0) ||
    (verdict === 'FAIL' && exit === 1) ||
    (verdict === 'REFUSED' && exit === 4)
  );
}

// The first row the child writes, so a child that dies later always has a last row.
export const STARTUP_ROW_FIELDS = [
  'block',
  'line',
  'attempt',
  'kind',
  'resolvedBy',
  't',
  'outcome',
] as const;

export function startupRow(): LedgerRow {
  return {
    block: '',
    line: 0,
    text: 'startup',
    attempt: 1,
    kind: 'step',
    resolvedBy: 'exact',
    t: 0,
    outcome: 'pass',
  };
}

const TYPES: ReadonlySet<string> = new Set([
  'request',
  'admitted',
  'start',
  'diagnostic',
  'row',
  'resource',
  'result',
  'cancel',
]);

function validCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.questionIds) &&
    value.questionIds.every((id) => typeof id === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(id)) &&
    ['preflight', 'parse'].includes(String(value.scope)) &&
    Number.isSafeInteger(value.ms) &&
    (value.ms as number) >= 0 &&
    (value.inputTokens === null ||
      (Number.isSafeInteger(value.inputTokens) && (value.inputTokens as number) >= 0)) &&
    ['ok', 'timeout', 'deadline', 'network', 'http', 'invalid'].includes(String(value.outcome)) &&
    (value.diagnostic === undefined ||
      value.diagnostic === null ||
      value.diagnostic === 'retry-after-outside-window') &&
    (value.status === undefined ||
      (Number.isInteger(value.status) &&
        (value.status as number) >= 100 &&
        (value.status as number) <= 599))
  );
}

export function parseEnvelope(line: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  if (
    e.v !== WIRE_VERSION ||
    typeof e.runId !== 'string' ||
    typeof e.seq !== 'number' ||
    typeof e.type !== 'string' ||
    !TYPES.has(e.type) ||
    e.payload === undefined
  ) {
    return null;
  }
  return e as unknown as Envelope;
}

export function parsePublicRequest(line: string): WireRequest {
  const envelope = parseEnvelope(line);
  if (!envelope) throw new WireError('the first stdin line is not a v1 wire envelope');
  if (envelope.type !== 'request')
    throw new WireError(`expected a request envelope, got ${envelope.type}`);
  if (envelope.seq !== 1) throw new WireError('the request must be seq 1');
  const p = envelope.payload as Partial<WireRequest> | null;
  const target = p?.target as Partial<WireTarget> | undefined;
  const bad =
    !p ||
    typeof p.runId !== 'string' ||
    !p.runId ||
    !Number.isSafeInteger(p.t0) ||
    !Number.isSafeInteger(p.walkBudgetMs) ||
    (p.walkBudgetMs as number) < 1 ||
    !Number.isSafeInteger(p.attachBudgetMs) ||
    (p.attachBudgetMs as number) < 1 ||
    typeof p.plan !== 'string' ||
    (p.preflightCalls !== undefined &&
      (!Array.isArray(p.preflightCalls) || !p.preflightCalls.every(validCall))) ||
    (p.platform !== 'ios' && p.platform !== 'android') ||
    typeof p.appId !== 'string' ||
    typeof p.appRoot !== 'string' ||
    !isAbsolute(p.appRoot) ||
    typeof p.runDir !== 'string' ||
    typeof p.lease !== 'string' ||
    !target ||
    typeof target.deviceId !== 'string' ||
    typeof target.deviceName !== 'string' ||
    target.deviceName.trim() === '' ||
    !Number.isInteger(target.metroPort) ||
    (target.metroPort as number) < 1 ||
    (target.metroPort as number) > 65535 ||
    typeof target.metroUrlForDevice !== 'string' ||
    typeof target.worktree !== 'string' ||
    (target.metroBundleRequests !== undefined &&
      (typeof target.metroBundleRequests?.path !== 'string' ||
        !isAbsolute(target.metroBundleRequests.path) ||
        !Number.isSafeInteger(target.metroBundleRequests.atLaunch) ||
        target.metroBundleRequests.atLaunch < 0)) ||
    (p.loginBlock !== undefined && (!isValidActionId(p.loginBlock) || !p.loginMarker)) ||
    (p.loginMarker !== undefined && !validMarker(p.loginMarker));
  if (bad) throw new WireError('the request payload is missing required fields');
  if (p.runId !== envelope.runId) throw new WireError('the request payload names another run');
  const {
    inputs: _inputs,
    inputProtocol: _protocol,
    ...publicRequest
  } = p as Partial<WireRequest> & { inputs?: unknown; inputProtocol?: unknown };
  const keys = [
    'runId',
    't0',
    'walkBudgetMs',
    'attachBudgetMs',
    'plan',
    'prepared',
    'preflightCalls',
    'platform',
    'appId',
    'appRoot',
    'runDir',
    'lease',
    'target',
    'loginBlock',
    'loginMarker',
    'loginSnapshot',
  ];
  return Object.fromEntries(
    Object.entries(publicRequest).filter(([key]) => keys.includes(key)),
  ) as unknown as WireRequest;
}

export const PRIVATE_REQUEST_MAX_BYTES = 16 * 1024 * 1024;

export async function readPrivateLine(input: AsyncIterable<Buffer | string>): Promise<string> {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > PRIVATE_REQUEST_MAX_BYTES) throw new WireError('private request exceeds limit');
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const newline = buffered.indexOf('\n');
    if (newline >= 0) return buffered.slice(0, newline).trim();
  }
  const line = (buffered + decoder.end()).trim();
  if (!line) throw new WireError('stdin closed before a request arrived');
  return line;
}

export function parsePrivateRequest(line: string): {
  request: WireRequest;
  inputs: RunInputs;
  privacy: ObservedPrivacy;
} {
  const request = parsePublicRequest(line);
  const payload = parseEnvelope(line)!.payload;
  if (!isRecord(payload)) throw new WireError('runtime inputs are invalid');
  if (request.loginSnapshot !== undefined) {
    const snap = request.loginSnapshot;
    if (
      !isRecord(snap) ||
      Object.keys(snap).sort().join(',') !== 'content,slug' ||
      snap.slug !== request.loginBlock ||
      !request.loginMarker ||
      !validMarker(request.loginMarker) ||
      (snap.content !== null && typeof snap.content !== 'string')
    )
      throw new WireError('runtime inputs are invalid');
  }
  if (request.loginSnapshot?.content) {
    const stored = readBlock(request.loginSnapshot.content);
    if (
      'invalid' in stored ||
      stored.header.appId !== request.appId ||
      stored.header.platform !== request.platform
    )
      throw new WireError('runtime inputs are invalid');
  }
  const inventory = inputInventory(request.plan, request.loginSnapshot);
  const names = inventory.requiredInputs;
  if (
    (names.length || payload.inputs !== undefined || payload.inputProtocol !== undefined) &&
    payload.inputProtocol !== 1
  )
    throw new WireError('runtime inputs are invalid');
  if (request.loginBlock && names.length && !request.loginSnapshot)
    throw new WireError('runtime inputs are invalid');
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs(payload.inputs ?? {}, names, privacy, inventory.nonSecretInputs);
  withInputs(inputs, () => {
    assertLoginPolicy(request.loginSnapshot, inputs);
    for (const text of [request.runId, request.appId, request.lease, request.loginBlock ?? ''])
      inputs.assertHashSafe(text);
  });
  return { request, inputs, privacy };
}

export function parseRequest(line: string): WireRequest {
  return parsePrivateRequest(line).request;
}
export async function readRequest(input: AsyncIterable<Buffer | string>): Promise<WireRequest> {
  return parseRequest(await readPrivateLine(input));
}
export async function readPrivateRequest(input: AsyncIterable<Buffer | string>) {
  return parsePrivateRequest(await readPrivateLine(input));
}

export interface WireWriter {
  diagnostic(payload: unknown): void;
  admitted(): void;
  start(payload: StepStart): void;
  row(payload: LedgerRow): void;
  runnerDriver(pid: number): void;
  result(payload: ResultPayload): 0 | 1 | 4;
  readonly seq: number;
}

// seq 1 is the request the CLI wrote; everything the child writes counts up from 2.
export function createWriter(write: (line: string) => void, runId: string): WireWriter {
  let seq = 1;
  let closed = false;
  let diagnostics = 0;
  let outcomes = 0;
  const send = (type: EnvelopeType, payload: unknown): void => {
    if (closed) throw new WireError('the result line was already written; nothing may follow it');
    seq += 1;
    const envelope: Envelope = { v: WIRE_VERSION, runId, seq, type, payload };
    write(`${JSON.stringify(envelope)}\n`);
  };
  return {
    diagnostic: (payload) => {
      if (closed) return;
      try {
        const clean = cleanDiagnostic(payload);
        if (!clean) return;
        if (
          !currentInputs()?.hasInputs &&
          !['target-miss', 'media-withheld'].includes(clean.kind as string)
        )
          return;
        if (clean.kind === 'block-outcome' || clean.kind === 'login-outcome') {
          if (outcomes >= 10_000) return;
          outcomes++;
        } else {
          if (diagnostics >= 20_000) return;
          diagnostics++;
        }
        send('diagnostic', clean);
      } catch {
        // Diagnostics cannot change the run's outcome.
      }
    },
    admitted: () => send('admitted', {}),
    start: ({ operationId, line, kind, t }) => send('start', { operationId, line, kind, t }),
    row: (payload) => send('row', payload),
    // The CLI records the driver's own process group before it can outlive this child.
    runnerDriver: (pid) => {
      if (!closed) send('resource', { kind: 'runner_driver', pid });
    },
    result: (payload) => {
      send('result', payload);
      closed = true;
      return exitCodeFor(payload);
    },
    get seq() {
      return seq;
    },
  };
}

export function missingResult(rows: LedgerRow[], seen: string, inFlight?: number): Ledger {
  return ledgerWithoutResult(rows, seen, inFlight);
}
