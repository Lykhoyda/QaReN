import { interruptible } from '../domain/cancellation.js';
import WebSocket from 'ws';
import type { CDPMessage, PendingCall } from '../types.js';

export class CDPProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'CDPProtocolError';
    this.code = code;
  }
}

export class CDPRequestTimeoutError extends Error {}

export class CDPTargetClosedError extends Error {}

export function sendWithTimeout(
  ws: WebSocket | null,
  pending: Map<number, PendingCall>,
  nextId: () => number,
  method: string,
  params: unknown,
  ms: number,
  onDispatched?: () => void,
): Promise<unknown> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new CDPTargetClosedError('WebSocket not connected'));
  }

  return interruptible(
    (signal) =>
      new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          pending.delete(id);
          reject(
            new CDPRequestTimeoutError(
              `CDP timeout (${ms}ms): ${method}. JS thread may be blocked, paused on a breakpoint, or waiting on an unresolved promise.`,
            ),
          );
        }, ms);

        const abort = () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        const settled =
          <T>(settle: (value: T) => void) =>
          (value: T) => {
            signal?.removeEventListener('abort', abort);
            settle(value);
          };
        pending.set(id, { resolve: settled(resolve), reject: settled(reject), timer });
        try {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new CDPTargetClosedError('WebSocket closed between check and send');
          }
          ws.send(JSON.stringify({ id, method, params }));
          onDispatched?.();
        } catch (err) {
          signal?.removeEventListener('abort', abort);
          clearTimeout(timer);
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(`ws.send failed: ${err}`));
        }
      }),
  );
}

export function rejectAllPending(pending: Map<number, PendingCall>, reason: Error): void {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(reason);
  }
  pending.clear();
}

export function handleMessage(
  data: WebSocket.RawData,
  pending: Map<number, PendingCall>,
  eventHandlers: Map<string, (params: unknown) => void>,
  onConsoleHook?: (params: unknown) => void,
): void {
  try {
    const msg = JSON.parse(data.toString()) as CDPMessage;

    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      console.error('CDP: unexpected message shape, ignoring');
      return;
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (Object.hasOwn(msg, 'error')) {
        p.reject(
          new CDPProtocolError(
            typeof msg.error?.code === 'number' ? msg.error.code : -32603,
            typeof msg.error?.message === 'string' ? msg.error.message : 'CDP protocol failure',
          ),
        );
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method) {
      const handler = eventHandlers.get(msg.method);
      if (handler) handler(msg.params);

      if (msg.method === 'Runtime.consoleAPICalled' && onConsoleHook) {
        onConsoleHook(msg.params);
      }
    }
  } catch {
    console.error('CDP: malformed message, ignoring');
  }
}
