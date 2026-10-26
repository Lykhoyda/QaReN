import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { CDPClient } from '../../dist/cdp-client.js';
import { closeConnectionAttempt, ConnectionSetupSupersededError } from '../../dist/cdp/connect.js';
import {
  HELPERS_VERSION,
  INJECTED_HELPERS,
  NETWORK_HOOK_SCRIPT,
  REACT_READY_PROBE_JS,
} from '../../dist/injected-helpers.js';
import { helpersNotInjectedResult } from '../../dist/utils.js';
import { performSetup } from '../../dist/cdp/setup.js';
import { DeviceBufferManager } from '../../dist/ring-buffer.js';
import type { EvaluateResult, NetworkEntry } from '../../dist/types.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Send = (
  method: string,
  params: { expression?: string; contextId?: number },
  timeoutMs: number,
) => Promise<unknown>;

function makeConnectedClient(send: Send): CDPClient {
  const client = new CDPClient(8081);
  Reflect.set(client, '_state', 'connected');
  Reflect.set(client, 'ws', { readyState: WebSocket.OPEN });
  Reflect.set(client, '_connectedTarget', { id: 'target-a', title: 'A' });
  Reflect.set(client, 'sendWithTimeout', send);
  const invalidate = Reflect.get(client, 'invalidateHelperWorld') as (cause: string) => void;
  invalidate.call(client, 'candidate_selected');
  return client;
}

function ensure(client: CDPClient, cause: 'setup_started' | 'reinject_started') {
  const fn = Reflect.get(client, 'ensureCurrentHelpers') as (cause: string) => Promise<boolean>;
  return fn.call(client, cause);
}

function invalidate(client: CDPClient, cause = 'socket_closed') {
  const fn = Reflect.get(client, 'invalidateHelperWorld') as (cause: string) => void;
  fn.call(client, cause);
}

function valueResponse(value: unknown): unknown {
  return { result: { value } };
}

function helperAwareSend(onPayload: () => Promise<unknown>): Send {
  return async (_method, params) => {
    if (params.expression === INJECTED_HELPERS) return onPayload();
    if (params.expression?.includes(`__v === ${HELPERS_VERSION}`)) return valueResponse(true);
    if (params.expression?.includes('__RN_DEV_BRIDGE__')) {
      return valueResponse(JSON.stringify({ present: false, version: null }));
    }
    return valueResponse(true);
  };
}

test('execution-context observation is installed before Runtime.enable', async () => {
  let handlersInstalled = false;
  const order: string[] = [];
  const networkManager = new DeviceBufferManager<NetworkEntry, string>({
    capacityPerDevice: 2,
    maxDevices: 1,
    indexKey: (entry) => entry.id,
    timestampOf: () => 0,
  });
  const result = await performSetup({
    send: async (method) => {
      if (method === 'Runtime.enable') assert.equal(handlersInstalled, true);
      order.push(method);
      if (method === 'Network.enable') throw new Error('unsupported');
      return {};
    },
    evaluate: async () => ({ value: undefined }),
    setupHelpers: async () => {
      order.push('helpers');
      return true;
    },
    port: 8081,
    networkManager,
    getDeviceKey: () => 'device',
    setupEventHandlers: () => {
      handlersInstalled = true;
      order.push('handlers');
    },
    clearScripts: () => {},
    clearEventHandlers: () => {},
  });
  assert.equal(result.helpersInjected, true);
  assert.ok(order.indexOf('handlers') < order.indexOf('Runtime.enable'));
  assert.ok(order.indexOf('Runtime.enable') < order.indexOf('helpers'));
});

test('setup and reinjection callers share one exact-version injection operation', async () => {
  const payload = deferred<unknown>();
  let payloads = 0;
  const client = makeConnectedClient(
    helperAwareSend(() => {
      payloads++;
      return payload.promise;
    }),
  );

  const setup = ensure(client, 'setup_started');
  const reinject = ensure(client, 'reinject_started');
  assert.equal(payloads, 1);
  payload.resolve(valueResponse(undefined));
  assert.deepEqual(await Promise.all([setup, reinject]), [true, true]);
  assert.equal(payloads, 1);
  assert.equal(client.helpersInjected, true);
});

test('mixed caller readiness deadlines stay outside the shared core', async () => {
  const payload = deferred<unknown>();
  let payloads = 0;
  const client = makeConnectedClient(async (_method, params) => {
    if (params.expression === REACT_READY_PROBE_JS) return valueResponse(true);
    if (params.expression === INJECTED_HELPERS) {
      payloads++;
      return payload.promise;
    }
    if (params.expression?.includes(`__v === ${HELPERS_VERSION}`)) return valueResponse(true);
    if (params.expression?.includes('__RN_DEV_BRIDGE__')) {
      return valueResponse(JSON.stringify({ present: false, version: null }));
    }
    return valueResponse(true);
  });

  const zeroBudget = client.reinjectHelpers(0);
  const longBudget = client.reinjectHelpers(30_000);
  await Promise.resolve();
  assert.equal(payloads, 1);
  payload.resolve(valueResponse(undefined));
  assert.deepEqual(await Promise.all([zeroBudget, longBudget]), [true, true]);
});

test('failed exact-version verification clears state and permits a later attempt', async () => {
  let exact = false;
  let payloads = 0;
  const client = makeConnectedClient(async (_method, params) => {
    if (params.expression === INJECTED_HELPERS) {
      payloads++;
      return valueResponse(undefined);
    }
    if (params.expression?.includes(`__v === ${HELPERS_VERSION}`)) {
      return valueResponse(exact);
    }
    if (params.expression?.includes('__RN_DEV_BRIDGE__')) {
      return valueResponse(JSON.stringify({ present: false, version: null }));
    }
    return valueResponse(undefined);
  });

  assert.equal(await ensure(client, 'reinject_started'), false);
  assert.equal(client.helpersInjected, false);
  exact = true;
  assert.equal(await ensure(client, 'reinject_started'), true);
  assert.equal(payloads, 2);
});

test('old success and late finally are inert after helper-world replacement', async () => {
  const payloadA = deferred<unknown>();
  const payloadB = deferred<unknown>();
  let world = 'A';
  const client = makeConnectedClient(
    helperAwareSend(() => (world === 'A' ? payloadA.promise : payloadB.promise)),
  );

  const oldAttempt = ensure(client, 'reinject_started');
  world = 'B';
  Reflect.set(client, 'ws', { readyState: WebSocket.OPEN });
  Reflect.set(client, '_connectedTarget', { id: 'target-b', title: 'B' });
  invalidate(client, 'socket_opened');
  const newAttempt = ensure(client, 'setup_started');
  const newSlot = Reflect.get(client, '_helperInjectionInFlight');

  payloadA.resolve(valueResponse(undefined));
  assert.equal(await oldAttempt, false);
  assert.equal(Reflect.get(client, '_helperInjectionInFlight'), newSlot);
  assert.equal(client.helpersInjected, false);

  payloadB.resolve(valueResponse(undefined));
  assert.equal(await newAttempt, true);
  assert.equal(client.helpersInjected, true);
});

test('old failure is inert and a rejected operation does not poison recovery', async () => {
  let attempts = 0;
  const client = makeConnectedClient(
    helperAwareSend(async () => {
      attempts++;
      if (attempts === 1) throw new Error('sentinel secret transport failure');
      return valueResponse(undefined);
    }),
  );

  assert.equal(await ensure(client, 'reinject_started'), false);
  assert.equal(Reflect.get(client, '_helperInjectionInFlight'), null);
  assert.equal(await ensure(client, 'reinject_started'), true);
  assert.equal(attempts, 2);
});

test('context lifecycle invalidates synchronously and pins helper evaluations', async () => {
  const contexts: Array<number | undefined> = [];
  const client = makeConnectedClient(async (_method, params) => {
    contexts.push(params.contextId);
    if (params.expression?.includes(`__v === ${HELPERS_VERSION}`)) return valueResponse(true);
    if (params.expression?.includes('__RN_DEV_BRIDGE__')) {
      return valueResponse(JSON.stringify({ present: false, version: null }));
    }
    return valueResponse(undefined);
  });
  const created = Reflect.get(client, 'handleExecutionContextCreated') as (params: unknown) => void;
  const destroyed = Reflect.get(client, 'handleExecutionContextDestroyed') as (
    params: unknown,
  ) => void;

  const publicGeneration = client.connectionGeneration;
  const before = client.helperWorldGeneration;
  created.call(client, { context: { id: 7, uniqueId: 'private-context-id' } });
  assert.equal(client.helperWorldGeneration, before + 1);
  assert.equal(client.connectionGeneration, publicGeneration);
  assert.equal(await ensure(client, 'setup_started'), true);
  assert.ok(contexts.length >= 2);
  assert.ok(contexts.every((id) => id === 7));

  destroyed.call(client, { executionContextId: 7 });
  assert.equal(client.helpersInjected, false);
  assert.equal(client.connectionGeneration, publicGeneration);
});

test('freshness mismatch invalidates ready evidence before reinjection', async () => {
  let response: unknown = 'current';
  const client = makeConnectedClient(async (_method, params) => {
    if (params.expression?.includes("Object.getOwnPropertyDescriptor(globalThis,'__QAREN')")) {
      return valueResponse(response);
    }
    return valueResponse(response);
  });
  assert.equal((await client.probeHelperHealth(20)).helper, 'current');
  assert.equal(client.helpersInjected, true);
  response = HELPERS_VERSION + 1;
  assert.equal((await client.probeHelperFreshness(20)).fresh, false);
  assert.equal(client.helpersInjected, false);
});

test('freshness probe failure invalidates ready evidence before reinjection', async () => {
  let shouldFail = false;
  const client = makeConnectedClient(async (_method, params) => {
    if (shouldFail) throw new Error('transport unavailable');
    if (params.expression?.includes("Object.getOwnPropertyDescriptor(globalThis,'__QAREN')")) {
      return valueResponse('current');
    }
    return valueResponse(HELPERS_VERSION);
  });
  assert.equal((await client.probeHelperHealth(20)).helper, 'current');
  assert.equal(client.helpersInjected, true);
  shouldFail = true;
  assert.equal((await client.probeHelperFreshness(20)).fresh, false);
  assert.equal(client.helpersInjected, false);
});

test('superseded setup cannot commit connection capability state', async () => {
  const hook = deferred<EvaluateResult>();
  const hookStarted = deferred<void>();
  const client = makeConnectedClient(async (method, params) => {
    if (method === 'Network.enable') throw new Error('unsupported');
    if (params?.expression === REACT_READY_PROBE_JS) return valueResponse(true);
    if (params?.expression === INJECTED_HELPERS) return valueResponse(undefined);
    if (params?.expression?.includes(`__v === ${HELPERS_VERSION}`)) return valueResponse(true);
    if (params?.expression?.includes('__RN_DEV_BRIDGE__')) {
      return valueResponse(JSON.stringify({ present: false, version: null }));
    }
    return valueResponse(undefined);
  });
  Reflect.set(client, 'ensureMetroEventsClient', async () => {});
  Reflect.set(client, 'evaluate', async (expression: string) => {
    assert.equal(expression, NETWORK_HOOK_SCRIPT);
    hookStarted.resolve();
    return hook.promise;
  });
  Reflect.set(client, '_networkMode', 'hook');
  Reflect.set(client, '_logDomainEnabled', false);
  Reflect.set(client, '_profilerAvailable', false);
  Reflect.set(client, '_heapProfilerAvailable', false);

  const setup = (Reflect.get(client, 'setup') as () => Promise<void>).call(client);
  await hookStarted.promise;
  const created = Reflect.get(client, 'handleExecutionContextCreated') as (params: unknown) => void;
  created.call(client, { context: { id: 9, uniqueId: 'replacement' } });
  hook.resolve({ value: undefined });

  await assert.rejects(setup, ConnectionSetupSupersededError);
  assert.equal(client.networkMode, 'hook');
  assert.equal(client.logDomainEnabled, false);
  assert.equal(client.profilerAvailable, false);
  assert.equal(client.heapProfilerAvailable, false);
  assert.equal(client.helpersInjected, false);
});

test('connection-attempt cleanup preserves replacements and closes owned sockets', () => {
  const replacementWs = {
    readyState: WebSocket.OPEN,
    removeAllListeners: () => {},
    close: () => {},
  } as unknown as WebSocket;
  let currentWs: WebSocket | null = replacementWs;
  let staleClosed = false;
  const staleWs = {
    readyState: WebSocket.OPEN,
    removeAllListeners: () => {},
    close: () => {
      staleClosed = true;
    },
  } as unknown as WebSocket;
  const ctx = {
    getWs: () => currentWs,
    setWs: (ws: WebSocket | null) => {
      currentWs = ws;
    },
  };

  assert.equal(closeConnectionAttempt(ctx, staleWs), false);
  assert.equal(staleClosed, false);
  assert.equal(currentWs, replacementWs);

  currentWs = staleWs;
  assert.equal(closeConnectionAttempt(ctx, staleWs), true);
  assert.equal(staleClosed, true);
  assert.equal(currentWs, null);
});

test('legacy one-context fallback omits contextId and freshness requires exact version', async () => {
  let version: number = HELPERS_VERSION - 1;
  const contexts: Array<number | undefined> = [];
  const client = makeConnectedClient(async (_method, params) => {
    contexts.push(params.contextId);
    return valueResponse(version);
  });

  assert.deepEqual(await client.probeHelperFreshness(17), {
    fresh: false,
    version: HELPERS_VERSION - 1,
    probed: true,
  });
  version = HELPERS_VERSION;
  assert.equal((await client.probeHelperFreshness(17)).fresh, true);
  assert.ok(contexts.every((id) => id === undefined));
});

test('health probe reconciles exact current helper and exposes only safe bounded enums', async () => {
  const sentinel = 'APP_VALUE_THAT_MUST_NOT_ESCAPE';
  let outcome: 'current' | 'version-mismatch' | 'invalid' = 'current';
  const client = makeConnectedClient(async () => valueResponse(outcome));

  const current = await client.probeHelperHealth(23);
  assert.deepEqual(current, { jsWorld: 'responsive', helper: 'current', probeBudgetMs: 23 });
  assert.equal(client.helpersInjected, true);

  invalidate(client, 'contexts_cleared');
  outcome = 'version-mismatch';
  const mismatch = await client.probeHelperHealth(23);
  assert.deepEqual(mismatch, {
    jsWorld: 'responsive',
    helper: 'version-mismatch',
    probeBudgetMs: 23,
  });
  assert.equal(JSON.stringify(mismatch).includes(sentinel), false);
});

test('both HELPERS_NOT_INJECTED boundaries use identical safe health metadata', async () => {
  const health = {
    jsWorld: 'responsive' as const,
    helper: 'missing' as const,
    probeBudgetMs: 2000,
  };
  const client = {
    helperWorldGeneration: 9,
    probeHelperHealth: async () => health,
  } as unknown as CDPClient;

  for (const boundary of ['initial', 'stale-recovery'] as const) {
    const result = await helpersNotInjectedResult(client, boundary);
    assert.ok(result);
    const envelope = JSON.parse(result.content[0].text) as {
      code: string;
      error: string;
      meta: { helperHealth: typeof health };
    };
    assert.equal(envelope.code, 'HELPERS_NOT_INJECTED');
    assert.deepEqual(envelope.meta.helperHealth, health);
    assert.equal(envelope.error.includes('genuinely hung'), false);
    assert.equal(envelope.error.includes('target metadata'), false);
  }
});

test('health probe distinguishes bounded timeout, transport failure, and supersession', async () => {
  const timeoutClient = makeConnectedClient(async () => {
    throw new Error('CDP timeout (19ms): Runtime.evaluate. sentinel app value');
  });
  assert.deepEqual(await timeoutClient.probeHelperHealth(19), {
    jsWorld: 'timeout',
    helper: 'unknown',
    probeBudgetMs: 19,
  });

  const transportClient = makeConnectedClient(async () => {
    throw new Error('raw socket failure with private target metadata');
  });
  assert.deepEqual(await transportClient.probeHelperHealth(19), {
    jsWorld: 'transport-error',
    helper: 'unknown',
    probeBudgetMs: 19,
  });

  const pending = deferred<unknown>();
  const supersededClient = makeConnectedClient(async () => pending.promise);
  const probe = supersededClient.probeHelperHealth(19);
  invalidate(supersededClient, 'context_created');
  pending.resolve(valueResponse('current'));
  assert.deepEqual(await probe, {
    jsWorld: 'superseded',
    helper: 'unknown',
    probeBudgetMs: 19,
  });
});
