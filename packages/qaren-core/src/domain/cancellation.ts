import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile as nativeExecFile, spawn as nativeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const scope = new AsyncLocalStorage<AbortSignal | undefined>();

export function cancellationSignal(signal?: AbortSignal): AbortSignal | undefined {
  const current = scope.getStore();
  current?.throwIfAborted();
  signal?.throwIfAborted();
  return current && signal && current !== signal
    ? AbortSignal.any([current, signal])
    : (current ?? signal);
}

export function throwIfCancelled(signal?: AbortSignal): void {
  cancellationSignal(signal);
}

export function withCancellation<T>(signal: AbortSignal | undefined, operation: () => T): T {
  return scope.run(signal, operation);
}

export class RunCancelledError extends Error {
  readonly code = 'RUN_CANCELLED';
  constructor() {
    super('RUN_CANCELLED: the run is stopping');
    this.name = 'AbortError';
  }
}

export function interruptible<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    signal = cancellationSignal(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!signal) return operation();
  const active = signal;
  return new Promise<T>((resolve, reject) => {
    const signal = active;
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation(signal);
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
      return;
    }
    pending
      .then((value) => {
        signal.throwIfAborted();
        resolve(value);
      })
      .catch(reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return interruptible((signal) => delay(ms, undefined, { signal }), signal);
}

export function cancellableFetch(
  fetcher: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signal = cancellationSignal(init?.signal ?? undefined);
  return interruptible(() => fetcher(input, { ...init, signal }), signal);
}

function processArguments(args: unknown[]): unknown[] {
  const optionsAt = Array.isArray(args[1]) ? 2 : 1;
  const options = args[optionsAt];
  const supplied =
    options && typeof options === 'object' ? (options as { signal?: AbortSignal }) : {};
  const signal = cancellationSignal(supplied.signal);
  if (!signal) return args;
  const result = [...args];
  if (options && typeof options === 'object') result[optionsAt] = { ...supplied, signal };
  else result.splice(optionsAt, 0, { signal });
  return result;
}

export const execFile = ((...args: unknown[]) =>
  Reflect.apply(nativeExecFile, undefined, processArguments(args))) as typeof nativeExecFile;
// Promisified per call so the live builtin binding (and any swapped-in implementation) is used.
Object.defineProperty(execFile, promisify.custom, {
  value: (...args: unknown[]) =>
    interruptible(() =>
      Reflect.apply(promisify(nativeExecFile), undefined, processArguments(args)),
    ),
});

export const spawn = ((...args: unknown[]) =>
  Reflect.apply(nativeSpawn, undefined, processArguments(args))) as typeof nativeSpawn;

// Only a signal abort; a domain RUN_CANCELLED refusal (QaDispatchError) is handled by its own owner.
export function isAbort(error: unknown): boolean {
  const candidate = error as { name?: string } | null;
  return candidate?.name === 'AbortError' || scope.getStore()?.aborted === true;
}

export async function withDeadline<T>(
  deadline: number,
  reason: Error,
  operation: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const remaining = deadline - performance.now();
  if (remaining <= 0) controller.abort(reason);
  const timer = remaining > 0 ? setTimeout(() => controller.abort(reason), remaining) : undefined;
  try {
    const signal = cancellationSignal(controller.signal);
    return await withCancellation(signal, () => interruptible(operation));
  } finally {
    clearTimeout(timer);
  }
}
