import { currentInputs } from './inputs.js';
import {
  cancellableFetch,
  sleep as cancellableSleep,
  interruptible,
} from '../domain/cancellation.js';
import {
  type Answers,
  type Judge,
  type JevCall,
  type Questions,
  JevError,
  isRecord,
  validateAnswer,
} from './questions.js';
import { observeTiming, measureTiming, type TimingObserver } from './timing.js';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_TIMEOUT_MS = 10_000;
export const JEV_MAX_RETRIES = 2;
export const MAX_REQUEST_BYTES = 48_000;
export const MAX_STATE_QUESTION_BYTES = 24_000;
export const MAX_RESPONSE_BYTES = 512_000;
export const MAX_QUESTIONS = 64;

export interface JevOptions {
  timing?: TimingObserver;
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
}

function requestBody(state: unknown, questions: Questions): string {
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return currentInputs()?.redact(value) ?? value;
    if (Array.isArray(value)) return value.map(mask);
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, mask(val)]));
    return value;
  };
  state = mask(state);
  questions = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      {
        ...q,
        instructions: currentInputs()?.redact(q.instructions) ?? q.instructions,
        ...(q.type === 'choice' ? { criteria: mask(q.criteria) } : {}),
      },
    ]),
  ) as Questions;
  const invalid = (): never => {
    throw new JevError('JEV_REQUEST_INVALID');
  };
  if (
    (typeof state !== 'string' && !isRecord(state) && !Array.isArray(state)) ||
    !isRecord(questions)
  )
    return invalid();
  const entries = Object.entries(questions);
  if (!entries.length || entries.length > MAX_QUESTIONS) return invalid();
  try {
    const stateBytes = Buffer.byteLength(JSON.stringify(state));
    for (const [id, q] of entries) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(id) ||
        !isRecord(q) ||
        typeof q.instructions !== 'string' ||
        !q.instructions.trim() ||
        (q.type !== 'choice' && q.type !== 'noul')
      )
        return invalid();
      if (
        q.type === 'choice' &&
        (!isRecord(q.criteria) ||
          Object.keys(q.criteria).length < 2 ||
          Object.keys(q.criteria).length > 255 ||
          !Object.entries(q.criteria).every(
            ([key, text]) => key.length > 0 && typeof text === 'string',
          ))
      )
        return invalid();
      if (stateBytes + Buffer.byteLength(JSON.stringify(q)) > MAX_STATE_QUESTION_BYTES)
        return invalid();
    }
    const body = JSON.stringify({ state, questions, model: JEV_MODEL });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return invalid();
    return body;
  } catch {
    return invalid();
  }
}

export function retryDelay(
  header: string | null,
  attempt: number,
  now: number,
  random: number,
  millisecondHeader: string | null = null,
  maximum = 60_000,
): number {
  if (millisecondHeader?.trim()) {
    const ms = Number(millisecondHeader);
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, maximum);
  }
  if (header?.trim()) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, maximum);
  }
  return Math.min(5000, Math.max(500, 500 * 2 ** attempt * (0.75 + random * 0.5)));
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new JevError('JEV_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new JevError('JEV_RESPONSE_INVALID');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new JevError('JEV_RESPONSE_INVALID');
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export function createJev(options: JevOptions = {}): Judge {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const sleep = options.sleep ?? cancellableSleep;
  const calls: JevCall[] = [];
  let elapsedMs = 0;
  return {
    calls,
    get elapsedMs() {
      return elapsedMs;
    },
    async ask(state, questions, scope = 'walk', deadline) {
      if (!apiKey?.trim() || /[\r\n]/.test(apiKey)) throw new JevError('JEV_AUTH_FAILED');
      if (deadline !== undefined && !Number.isFinite(deadline))
        throw new JevError('JEV_REQUEST_INVALID');
      const body = requestBody(state, questions);
      const askStarted = now();
      try {
        for (let attempt = 0; attempt <= JEV_MAX_RETRIES; attempt++) {
          const started = now();
          const remaining = deadline === undefined ? Infinity : deadline - started;
          if (remaining <= 0) {
            observeTiming(options.timing, {
              stage: 'jev-attempt',
              edge: 'point',
              outcome: 'failed',
              at: started,
              ms: 0,
            });
            throw new JevError('JEV_DEADLINE_EXCEEDED');
          }
          const timeout = Math.min(options.timeoutMs ?? JEV_TIMEOUT_MS, JEV_TIMEOUT_MS);
          const clipped = remaining <= timeout;
          const record: JevCall = {
            scope,
            questionIds: Object.keys(questions),
            inputTokens: null,
            ms: 0,
            outcome: 'network',
          };
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let retryAfter: string | null = null;
          let retryAfterMs: string | null = null;
          let retry = false;
          let accepted = false;
          let failure = new JevError('JEV_UNAVAILABLE');
          observeTiming(options.timing, {
            stage: 'jev-attempt',
            edge: 'start',
            outcome: 'ok',
            at: started,
            count: calls.length + 1,
          });
          try {
            const operation = async (): Promise<Answers> => {
              const response = await cancellableFetch(fetcher, JEV_ENDPOINT, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
                redirect: 'error',
              });
              record.status = response.status;
              if (!response.ok) {
                record.outcome = 'http';
                retryAfter = response.headers.get('Retry-After');
                retryAfterMs = response.headers.get('retry-after-ms');
                retry =
                  response.status === 408 || response.status === 429 || response.status >= 500;
                void response.body?.cancel().catch(() => undefined);
                throw new JevError(
                  response.status === 401 || response.status === 403
                    ? 'JEV_AUTH_FAILED'
                    : response.status === 422 || response.status === 400
                      ? 'JEV_REQUEST_INVALID'
                      : 'JEV_UNAVAILABLE',
                );
              }
              record.outcome = 'invalid';
              const validationStarted = options.timing ? now() : 0;
              observeTiming(options.timing, {
                stage: 'jev-validation',
                edge: 'start',
                outcome: 'ok',
                at: validationStarted,
              });
              let validated = false;
              try {
                const data = await interruptible(() => readResponse(response));
                if (
                  !isRecord(data) ||
                  data.model !== JEV_MODEL ||
                  !isRecord(data.answers) ||
                  !isRecord(data.usage) ||
                  !Number.isSafeInteger(data.usage.input_tokens) ||
                  (data.usage.input_tokens as number) < 0 ||
                  Object.keys(data.answers).length !== Object.keys(questions).length
                )
                  throw new JevError('JEV_RESPONSE_INVALID');
                record.inputTokens = data.usage.input_tokens as number;
                const answers: Answers = {};
                for (const [id, question] of Object.entries(questions))
                  answers[id] = validateAnswer(question, data.answers[id]);
                record.outcome = 'ok';
                validated = true;
                return answers;
              } finally {
                if (options.timing) {
                  const at = now();
                  observeTiming(options.timing, {
                    stage: 'jev-validation',
                    edge: 'end',
                    outcome: validated ? 'ok' : 'failed',
                    at,
                    ms: at - validationStarted,
                  });
                }
              }
            };
            const answers = await Promise.race([
              operation(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => {
                    controller.abort();
                    reject(new JevError(clipped ? 'JEV_DEADLINE_EXCEEDED' : 'JEV_UNAVAILABLE'));
                  },
                  Math.min(timeout, remaining),
                );
              }),
            ]);
            if (deadline !== undefined && now() >= deadline)
              throw new JevError('JEV_DEADLINE_EXCEEDED');
            accepted = true;
            return answers;
          } catch (error) {
            if (controller.signal.aborted) {
              record.outcome = clipped ? 'deadline' : 'timeout';
              retry = !clipped;
            } else if (!(error instanceof JevError)) {
              record.outcome = 'network';
              retry = true;
            }
            if (error instanceof JevError) failure = error;
            if (retry && deadline !== undefined && now() >= deadline) {
              if (record.outcome === 'http') record.diagnostic = 'retry-after-outside-window';
              failure = new JevError(
                record.outcome === 'http' ? 'JEV_UNAVAILABLE' : 'JEV_DEADLINE_EXCEEDED',
              );
              retry = false;
            }
          } finally {
            clearTimeout(timer);
            controller.abort();
            record.ms = Math.max(0, Math.round(now() - started));
            calls.push({ ...record });
            if (options.timing)
              observeTiming(options.timing, {
                stage: 'jev-attempt',
                edge: 'end',
                outcome: accepted ? 'ok' : 'failed',
                at: now(),
                ms: record.ms,
                count: calls.length,
              });
          }
          if (!retry || attempt === JEV_MAX_RETRIES) throw failure;
          const delay = retryDelay(
            retryAfter,
            attempt,
            wallNow(),
            (options.random ?? Math.random)(),
            retryAfterMs,
            deadline === undefined ? 60_000 : Infinity,
          );
          if (deadline !== undefined && now() + delay >= deadline) {
            calls[calls.length - 1].diagnostic = 'retry-after-outside-window';
            if (options.timing)
              observeTiming(options.timing, {
                stage: 'jev-backoff',
                edge: 'point',
                outcome: 'failed',
                at: now(),
                ms: 0,
                count: delay,
              });
            throw new JevError('JEV_UNAVAILABLE');
          }
          await measureTiming(options.timing, now, 'jev-backoff', () =>
            interruptible(() => sleep(delay)),
          );
        }
        throw new JevError('JEV_UNAVAILABLE');
      } finally {
        elapsedMs += Math.max(0, now() - askStarted);
      }
    },
  };
}
