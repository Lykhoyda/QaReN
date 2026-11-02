import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CDPClient } from '../../../dist/cdp-client.js';
import { runInNewContext } from 'node:vm';
import { discoverAndConnect, type ConnectContext } from '../../../dist/cdp/connect.js';
import type { CDPClientState, HermesTarget } from '../../../dist/types.js';

async function targets(t: { after(fn: () => void): void }, modes: unknown[]) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const port = (server.address() as { port: number }).port;
  server.on('connection', (socket, request) => {
    socket.on('message', (bytes) => {
      const message = JSON.parse(String(bytes));
      const mode = modes[Number(request.url!.slice(1))];
      const world = mode === undefined ? {} : { __DEV__: mode };
      const value =
        message.method === 'Runtime.evaluate'
          ? runInNewContext(message.params.expression, world)
          : undefined;
      socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
    });
  });
  const list: HermesTarget[] = modes.map((_, index) => ({
    id: `synthetic-${index}`,
    title: 'synthetic',
    vm: 'Hermes',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${index}`,
  }));
  let ws: WebSocket | null = null;
  let state: CDPClientState = 'disconnected';
  const setup: number[] = [];
  const evaluate = async (expression: string) => {
    const mode = modes[Number(ws!.url.split('/').at(-1))];
    const world = mode === undefined ? {} : { __DEV__: mode };
    return { value: runInNewContext(expression, world) };
  };
  const ctx: ConnectContext = {
    isDisposed: () => false,
    isReconnecting: () => false,
    isSoftReconnectRequested: () => false,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    getPort: () => port,
    setPort: () => {},
    getConnectFilters: () => ({}),
    setConnectFilters: () => {},
    getWs: () => ws,
    setWs: (next) => {
      ws = next;
    },
    setHelpersInjected: () => {},
    setConnectedTarget: () => {},
    setConnectedAt: () => {},
    now: () => 0,
    incrementConnectionGeneration: () => 1,
    evaluate,
    evaluateWithinAttach: evaluate,
    sendWithTimeout: async () => ({}),
    handleMessage: () => {},
    handleClose: () => {},
    rejectAllPending: () => {},
    setup: async () => {
      setup.push(Number(ws!.url.split('/').at(-1)));
    },
    getProxyUrl: () => null,
  };
  t.after(() => {
    ws?.terminate();
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  return {
    ctx,
    list,
    setup,
    port,
    connect: (intent: 'qa' | 'default' | 'status' = 'qa') =>
      discoverAndConnect(ctx, port, {}, async () => ({ port, targets: list }), intent, 1),
  };
}

for (const mode of [false, undefined, 'unexpected']) {
  test(`QA never sets up an unproven development target (${String(mode)})`, async (t) => {
    const h = await targets(t, [mode]);
    await assert.rejects(h.connect(), (error: any) => {
      assert.equal(error.constructor.name, 'DevTargetUnavailableError');
      assert.deepEqual(error.counts, {
        targetsTotal: 1,
        devTrue: 0,
        devFalse: mode === false ? 1 : 0,
        devUndefined: mode === undefined ? 1 : 0,
        devUnknown: mode === 'unexpected' ? 1 : 0,
      });
      assert.doesNotMatch(JSON.stringify(error), /synthetic|ws:\/\//);
      return true;
    });
    assert.deepEqual(h.setup, []);
    assert.equal(h.ctx.getWs(), null);
  });
}

test('QA skips false and undefined candidates and sets up the true candidate once', async (t) => {
  const h = await targets(t, [false, undefined, true]);
  await h.connect();
  assert.deepEqual(h.setup, [2]);
});

for (const intent of ['default', 'status'] as const) {
  test(`${intent} retains its last non-dev target fallback`, async (t) => {
    const h = await targets(t, [false]);
    await h.connect(intent);
    assert.deepEqual(h.setup, [0]);
  });
}

test('an unresponsive first candidate leaves time to set up the second true candidate', async (t) => {
  const h = await targets(t, [true, true]);
  let probes = 0;
  h.ctx.sendWithTimeout = async () => {
    if (++probes === 1) return new Promise(() => {});
    return {};
  };
  const started = performance.now();
  await h.connect();
  assert.deepEqual(h.setup, [1]);
  assert.ok(performance.now() - started < 4000);
});

test('a context replacement during a false probe invalidates false certainty', async (t) => {
  const h = await targets(t, [false]);
  let token = 1;
  h.ctx.getRuntimeToken = () => token;
  h.ctx.evaluateWithinAttach = async () => {
    token++;
    return { value: 'false' };
  };
  await assert.rejects(h.connect(), (error: any) => {
    assert.equal(error.counts.devFalse, 0);
    assert.equal(error.counts.devUnknown, 1);
    return true;
  });
  assert.deepEqual(h.setup, []);
});

test('QA intent survives soft reconnect, ordinary reconnect and replacement until the exact binding ends', async (t) => {
  const h = await targets(t, [false]);
  const client = new CDPClient(h.port);
  t.after(() => client.disconnect());
  t.mock.method(globalThis, 'fetch', async () => ({
    json: async () => h.list,
    text: async () => 'packager-status:running',
  }));
  const unavailable = (error: Error) => error.constructor.name === 'DevTargetUnavailableError';
  await assert.rejects(client.connectExact(h.port, {}, 'qa', 1), unavailable);
  await assert.rejects(client.softReconnect(), unavailable);
  await assert.rejects(client.autoConnect(), unavailable);
  const replacement = client.createReplacement(h.port);
  t.after(() => replacement.disconnect());
  await assert.rejects(replacement.autoConnect(), unavailable);
  let setups = 0;
  replacement.clearAuthoritativeSessionPolicy();
  t.mock.method(replacement as any, 'setup', async () => {
    setups++;
  });
  await replacement.autoConnect(h.port, {});
  assert.equal(setups, 1);
});

test('a true probe before stalled setup invalidates an earlier complete false scan', async (t) => {
  const { admit } = await import('../../../dist/qa/admission.js');
  const { createStop } = await import('../../../dist/qa/stop.js');
  const modes = [false];
  const h = await targets(t, modes);
  const client = new CDPClient(h.port);
  t.after(() => client.disconnect());
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => h.list }));
  let attempts = 0;
  let setupStarted = false;
  t.mock.method(client as any, 'setup', async () => {
    setupStarted = true;
    await new Promise(() => {});
  });
  const stop = createStop();
  await assert.rejects(admit({
    metroPort: h.port,
    readinessMs: 30000,
    attachBudgetMs: 1500,
    remainingMs: () => 20000,
    attach: async () => {
      modes[0] = ++attempts > 1;
      await client.connectExact(h.port, {}, 'qa', 1);
    },
    observeDevelopmentTargets: (observe) => client.observeDevelopmentTargets(observe),
    open: async () => assert.fail('stalled setup cannot open a session'),
    prove: async () => assert.fail('stalled setup cannot prove a session'),
    close: async () => {},
    load: () => 1,
  }, stop), (error: any) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.equal(error.meta?.inner, 'no_dev_target_unknown');
    return true;
  });
  assert.equal(setupStarted, true);
  assert.equal(attempts, 2);
});

test('unfinished scans retain same-candidate evidence and invalidate replaced candidates', async (t) => {
  const h = await targets(t, [false, false]);
  const client = new CDPClient(h.port);
  t.after(() => client.disconnect());
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => h.list }));
  let observation: { devFalse: number } | undefined;
  const unsubscribe = client.observeDevelopmentTargets((counts) => {
    observation = counts;
  });
  t.after(unsubscribe);
  const unavailable = (error: Error) => error.constructor.name === 'DevTargetUnavailableError';
  await assert.rejects(client.connectExact(h.port, {}, 'qa', 1), unavailable);
  assert.equal(observation?.devFalse, 2);
  for (const replaced of [false, true]) {
    if (replaced) h.list[0].id = 'replacement';
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let probes = 0;
    t.mock.method(client as any, 'evaluateWithinAttach', async () => {
      if (++probes === 1) {
        entered.resolve();
        await resume.promise;
      }
      return { value: 'false' };
    });
    const retry = assert.rejects(client.connectExact(h.port, {}, 'qa', 1), unavailable);
    await entered.promise;
    try {
      assert.equal(observation?.devFalse, replaced ? undefined : 2);
    } finally {
      resume.resolve();
      await retry;
    }
  }
  h.list.splice(0);
  await assert.rejects(client.connectExact(h.port, {}, 'qa', 1));
  assert.equal(observation?.devFalse, 0, 'a completed empty scan replaces the false scan');
});
