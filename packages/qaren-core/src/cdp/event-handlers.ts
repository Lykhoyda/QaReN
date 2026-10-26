import type { RingBuffer, DeviceBufferManager } from '../ring-buffer.js';
import type { ConsoleEntry, NetworkEntry, LogEntry } from '../types.js';

export interface EventBuffers {
  console: RingBuffer<ConsoleEntry>;
  network: DeviceBufferManager<NetworkEntry, string>;
  log: RingBuffer<LogEntry>;
  scripts: Map<string, { scriptId: string; url: string; startLine: number; endLine: number }>;
}

export function wireEventHandlers(
  eventHandlers: Map<string, (params: unknown) => void>,
  buffers: EventBuffers,
  sendFn: (method: string, params?: unknown, ms?: number) => Promise<unknown>,
  getIsPaused: () => boolean,
  setIsPaused: (v: boolean) => void,
  getDeviceKey: () => string,
  executionContexts?: {
    created(params: {
      context?: { id?: number; uniqueId?: string; auxData?: { isDefault?: boolean } };
    }): void;
    destroyed(params: { executionContextId?: number; executionContextUniqueId?: string }): void;
    cleared(): void;
  },
): void {
  if (executionContexts) {
    eventHandlers.set('Runtime.executionContextCreated', (params) => {
      executionContexts.created(
        params as {
          context?: { id?: number; uniqueId?: string; auxData?: { isDefault?: boolean } };
        },
      );
    });
    eventHandlers.set('Runtime.executionContextDestroyed', (params) => {
      executionContexts.destroyed(
        params as { executionContextId?: number; executionContextUniqueId?: string },
      );
    });
    eventHandlers.set('Runtime.executionContextsCleared', () => executionContexts.cleared());
  }

  eventHandlers.set('Runtime.consoleAPICalled', (params: unknown) => {
    const p = params as { type: string; args?: Array<{ value?: unknown; description?: string }> };
    const text =
      p.args
        ?.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
        .join(' ') ?? '';
    if (text.startsWith('__RN_NET__:')) return;
    buffers.console.push({
      level: p.type,
      text,
      timestamp: new Date().toISOString(),
    });
  });

  eventHandlers.set('Network.requestWillBeSent', (params: unknown) => {
    const p = params as { requestId: string; request?: { method: string; url: string } };
    buffers.network.push(getDeviceKey(), {
      id: p.requestId,
      method: p.request?.method ?? 'GET',
      url: p.request?.url ?? '',
      timestamp: new Date().toISOString(),
    });
  });

  eventHandlers.set('Network.responseReceived', (params: unknown) => {
    const p = params as { requestId: string; response?: { status: number } };
    const entry = buffers.network.getByKey(getDeviceKey(), p.requestId);
    if (entry) {
      entry.status = p.response?.status;
      entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
    }
  });

  eventHandlers.set('Network.loadingFailed', (params: unknown) => {
    const p = params as { requestId: string };
    const entry = buffers.network.getByKey(getDeviceKey(), p.requestId);
    if (entry) {
      entry.status = 0;
      entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
    }
  });

  eventHandlers.set('Debugger.scriptParsed', (params: unknown) => {
    const p = params as { scriptId: string; url?: string; startLine?: number; endLine?: number };
    if (p.scriptId && p.url) {
      buffers.scripts.set(p.scriptId, {
        scriptId: p.scriptId,
        url: p.url,
        startLine: p.startLine ?? 0,
        endLine: p.endLine ?? 0,
      });
    }
  });

  eventHandlers.set('Log.entryAdded', (params: unknown) => {
    const p = params as {
      entry?: {
        source?: string;
        level?: string;
        text?: string;
        timestamp?: number;
        url?: string;
        lineNumber?: number;
      };
    };
    const e = p.entry;
    if (!e) return;
    buffers.log.push({
      source: e.source ?? 'other',
      level: e.level ?? 'info',
      text: e.text ?? '',
      timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString(),
      url: e.url,
      lineNumber: e.lineNumber,
    });
  });

  eventHandlers.set('Network.loadingFinished', (params: unknown) => {
    const p = params as { requestId: string; encodedDataLength?: number };
    const entry = buffers.network.getByKey(getDeviceKey(), p.requestId);
    if (entry) {
      entry.bodyAvailable = true;
      entry.bodySize = p.encodedDataLength;
    }
  });

  eventHandlers.set('Debugger.paused', async () => {
    setIsPaused(true);
    try {
      await sendFn('Debugger.resume');
    } catch {
      // Best effort auto-resume
    }
    setIsPaused(false);
  });
}

/**
 * Apply a single decoded hook-mode network entry to the buffer manager.
 * Shared by the legacy console-event path (parseNetworkHookMessage) and the
 * new buffered drain path (Task 6) so both paths apply entries identically.
 * Duplicate-id dedup: during the one-release back-compat window a stale
 * console callback can coexist with the new buffered callback, reporting the
 * same request id twice — the getByKey guard prevents a second push.
 */
export function applyNetworkHookEntry(
  type: string,
  data: { id: string; method?: string; url?: string; status?: number; duration_ms?: number },
  networkManager: DeviceBufferManager<NetworkEntry, string>,
  deviceKey: string,
  atMs?: number,
): void {
  if (type === 'request') {
    // Dedup: skip if this id is already in the buffer (double-reporting guard).
    if (networkManager.getByKey(deviceKey, data.id)) return;
    networkManager.push(deviceKey, {
      id: data.id,
      method: data.method ?? 'GET',
      url: data.url ?? '',
      timestamp: new Date(atMs ?? Date.now()).toISOString(),
    });
  } else if (type === 'response') {
    const entry = networkManager.getByKey(deviceKey, data.id);
    if (entry) {
      entry.status = data.status;
      entry.duration_ms = data.duration_ms;
    }
  }
}

export function parseNetworkHookMessage(
  params: unknown,
  networkMode: 'cdp' | 'hook' | 'none',
  networkManager: DeviceBufferManager<NetworkEntry, string>,
  deviceKey: string,
): void {
  if (networkMode !== 'hook') return;
  const p = params as { args?: Array<{ value?: unknown }> };
  const firstArg = p.args?.[0]?.value;
  if (typeof firstArg !== 'string' || !firstArg.startsWith('__RN_NET__:')) return;

  try {
    const parts = firstArg.split(':');
    const type = parts[1];
    const data = JSON.parse(parts.slice(2).join(':'));
    applyNetworkHookEntry(type, data, networkManager, deviceKey);
  } catch (err) {
    console.error(
      'CDP: malformed network hook message dropped:',
      typeof firstArg === 'string' ? firstArg.slice(0, 100) : typeof firstArg,
      err instanceof Error ? err.message : '',
    );
  }
}
