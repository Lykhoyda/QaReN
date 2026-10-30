import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { CDPClient } from '../../dist/cdp-client.js';
import {
  CDPProtocolError,
  CDPRequestTimeoutError,
  CDPTargetClosedError,
} from '../../dist/cdp/transport.js';
import {
  clearDevOverlays,
  recoverDevOverlays,
  createDevSettingsHandler,
} from '../../dist/handlers/dev-settings.js';
import { RunCancelledError, withCancellation } from '../../dist/domain/cancellation.js';
import { devOverlayDeadline } from '../../dist/domain/dev-overlay.js';
import { WAIT_BUDGET_MS } from '../../dist/qa/walker.js';
import { okResult } from '../../dist/utils.js';
import { parseEnvelope } from '../helpers/result-helpers.js';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

for (const [failure, kind] of [
  [new CDPRequestTimeoutError('opaque'), 'timeout'],
  [new CDPProtocolError(-1, 'opaque'), 'protocol'],
  [new CDPTargetClosedError('opaque'), 'target_closed'],
  [new Error('timeout is only message text'), 'other'],
] as const) {
  test(`async evaluation initialization preserves ${kind}`, async () => {
    const client = new CDPClient();
    Object.assign(client, {
      sendWithTimeout: async () => {
        throw failure;
      },
    });
    assert.equal((await client.evaluate('work()', true)).errorKind, kind);
  });
}

test('an expired async evaluation submits no work', async () => {
  let calls = 0;
  const client = new CDPClient();
  Object.assign(client, {
    sendWithTimeout: async () => {
      calls++;
    },
  });
  assert.equal((await client.evaluate('work()', true, 0)).errorKind, 'timeout');
  assert.equal(calls, 0);
});

test('successful async evaluation awaits bounded cleanup and preserves its value', async () => {
  const client = new CDPClient();
  const calls: string[] = [];
  Object.assign(client, {
    async sendWithTimeout(_method: string, params: { expression: string }, timeout: number) {
      calls.push(params.expression);
      if (calls.length === 1) return { result: {} };
      if (calls.length === 2) return { result: { value: { v: '7' } } };
      assert.ok(params.expression.startsWith('delete '));
      assert.ok(timeout <= 1000);
      return {};
    },
  });
  assert.deepEqual(await client.evaluate('work()', true, 2000), { value: 7 });
  assert.equal(calls.length, 3);
});

test('evaluation exceptions are typed for synchronous and asynchronous calls', async () => {
  const client = new CDPClient();
  Object.assign(client, {
    async sendWithTimeout() {
      return { exceptionDetails: { text: 'opaque' } };
    },
  });
  for (const awaitPromise of [false, true])
    assert.equal((await client.evaluate('work()', awaitPromise)).errorKind, 'evaluation');
});

test('promise timeout sends no late poll or slot cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const client = new CDPClient();
  const calls: string[] = [];
  Object.assign(client, {
    async sendWithTimeout(_method: string, params: { expression: string }) {
      calls.push(params.expression);
      return { result: { value: undefined } };
    },
  });
  const pending = client.evaluate('work()', true, 1000);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal((await pending).errorKind, 'timeout');
  const completedCalls = calls.length;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, completedCalls);
  assert.ok(!calls.some((call) => call.startsWith('delete ')));
});

test('poll timeout stays typed and cleanup is awaited inside the evaluation deadline', async () => {
  const calls: string[] = [];
  const client = new CDPClient();
  let release!: () => void;
  Object.assign(client, {
    async sendWithTimeout(_method: string, params: { expression: string }, timeout: number) {
      calls.push(params.expression);
      assert.ok(timeout <= 1000);
      if (calls.length === 1) return { result: {} };
      if (calls.length === 2) throw new CDPRequestTimeoutError('poll');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    },
  });
  let finished = false;
  const pending = client.evaluate('work()', true, 1000).then((result) => {
    finished = true;
    return result;
  });
  await flush();
  assert.equal(finished, false);
  assert.equal(calls.length, 3);
  release();
  assert.equal((await pending).errorKind, 'timeout');
});

for (const boundary of ['initialization', 'poll'] as const) {
  test(`external abort during ${boundary} clears transport state and sends nothing later`, async () => {
    const client = new CDPClient();
    const controller = new AbortController();
    const sent: Array<{ id: number }> = [];
    const ws: WebSocket = Object.create(WebSocket.prototype);
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    ws.send = (data) => {
      const request = JSON.parse(String(data));
      sent.push(request);
      if (boundary === 'poll' && sent.length === 1)
        Reflect.get(client, 'handleMessage').call(
          client,
          JSON.stringify({ id: request.id, result: {} }),
        );
    };
    Object.assign(client, { ws });
    const reason = new RunCancelledError();
    const pending = withCancellation(controller.signal, () =>
      client.evaluate('work()', true, 1000),
    );
    const rejected = assert.rejects(pending, (error) => error === reason);
    await flush();
    assert.equal(sent.length, boundary === 'poll' ? 2 : 1);
    controller.abort(reason);
    await rejected;
    await flush();
    assert.equal(Reflect.get(client, 'pending').size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(sent.length, boundary === 'poll' ? 2 : 1);
  });
}

for (const operation of ['read', 'evaluate'] as const) {
  test(`overlay deadline during ${operation} refuses with its cause and blocks later effects`, async () => {
    const calls: string[] = [];
    let release!: () => void;
    const pending = clearDevOverlays({
      deadline: performance.now() + 30,
      async devSettings({ action }) {
        calls.push(action);
        if (operation === 'evaluate' && action === 'hideDevMenuFab')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return okResult({ executed: true });
      },
      async observeDevOverlay() {
        calls.push('read');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { state: 'clear', front: 'app' };
      },
      log() {},
    });
    const env = parseEnvelope(await pending);
    assert.equal(
      env.code,
      `DEV_MENU_HIDE_UNVERIFIED_${operation === 'read' ? 'READ_FAILED' : 'EVALUATE_TIMEOUT'}`,
    );
    const completedCalls = [...calls];
    release();
    await flush();
    assert.deepEqual(calls, completedCalls);
  });
}

test('a walk preference timeout cannot trigger connection recovery after expiry', async () => {
  const client = new CDPClient();
  let reconnects = 0;
  Object.assign(client, {
    evaluate: async () => {
      throw new RunCancelledError();
    },
    autoConnect: async () => {
      reconnects++;
    },
  });
  const handler = createDevSettingsHandler(() => client);
  await assert.rejects(handler({ action: 'hideDevMenuFab', timeoutMs: 1000 }), /RUN_CANCELLED/);
  assert.equal(reconnects, 0);
});

test('typed preference timeout differs from a false readback', async () => {
  for (const timeout of [false, true]) {
    const client = new CDPClient();
    Object.assign(client, {
      evaluate: async () =>
        timeout ? { error: 'opaque', errorKind: 'timeout' } : { value: 'unverified' },
    });
    const env = parseEnvelope(
      await createDevSettingsHandler(() => client)({ action: 'hideDevMenuFab', timeoutMs: 1000 }),
    );
    assert.equal(env.code, `DEV_MENU_HIDE_UNVERIFIED_EVALUATE_${timeout ? 'TIMEOUT' : 'FAILED'}`);
  }
});

for (const platform of ['ios', 'android'] as const) {
  for (const action of ['hideDevMenuFab', 'disableDevMenu', 'disableFastRefresh'] as const) {
    test(`${platform} ${action} retains the platform evaluation timeout`, async () => {
      const client = new CDPClient();
      const timeouts: number[] = [];
      Object.assign(client, {
        _connectedTarget: { platform },
        evaluate: async (_expression: string, _async: boolean, timeout: number) => {
          timeouts.push(timeout);
          return { value: 'ok' };
        },
      });
      const handler = createDevSettingsHandler(() => client, { settleAfterHide: async () => {} });
      await handler({ action, timeoutMs: 1_199_000 });
      await handler({ action, timeoutMs: 800 });
      assert.deepEqual(timeouts, [platform === 'android' ? 10_000 : 5000, 800]);
    });
  }
}

test('FAB evaluation is not dispatched without enough time for a poll', async () => {
  const client = new CDPClient();
  Object.assign(client, { evaluate: async () => assert.fail('no unconfirmable mutation') });
  const result = await createDevSettingsHandler(() => client)({
    action: 'hideDevMenuFab',
    timeoutMs: 499,
  });
  assert.equal(parseEnvelope(result).code, 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT');
});

for (const recovery of [false, true]) {
  test(`${recovery ? 'recovery' : 'admission'} unknown reads stop at the existing budget`, async () => {
    const budget = recovery ? WAIT_BUDGET_MS : 120_000;
    let clock = Math.ceil(performance.now());
    const start = clock;
    const deadline = devOverlayDeadline(clock, budget, clock + 1_199_000);
    let reads = 0;
    let reconnects = 0;
    const deps = {
      deadline,
      now: () => clock,
      reconnect: async () => {
        reconnects++;
        clock += 1000;
      },
      devSettings: async () => okResult({ executed: true }),
      observeDevOverlay: async () => {
        reads++;
        return { state: 'unknown', error: 'coverage_incomplete' } as const;
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      log() {},
    };
    const result = await (recovery ? recoverDevOverlays(deps) : clearDevOverlays(deps));
    const env = parseEnvelope(result);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED_READ_FAILED');
    assert.equal(clock - start, budget);
    assert.equal(reconnects, recovery ? 1 : 0);
    assert.match(
      env.error!,
      new RegExp(`reads=${reads};.*elapsed_ms=${budget}; last_error=coverage_incomplete`),
    );
    assert.equal(devOverlayDeadline(start, budget, start + 100), start + 100);
  });
}

test('reconnect shares the recovery deadline and cannot resume work after expiry', async () => {
  let release!: () => void;
  let calls = 0;
  const result = await recoverDevOverlays({
    deadline: performance.now() + 30,
    reconnect: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    devSettings: async () => {
      calls++;
      return okResult({ executed: true });
    },
    observeDevOverlay: async () => {
      calls++;
      return { state: 'clear', front: 'app' };
    },
    log() {},
  });
  assert.equal(parseEnvelope(result).code, 'DEV_MENU_HIDE_UNVERIFIED_READ_FAILED');
  release();
  await flush();
  assert.equal(calls, 0);
});

test('reconnect failure returns the value-free read failure without overlay effects', async () => {
  const result = await recoverDevOverlays({
    deadline: performance.now() + 1000,
    reconnect: async () => {
      throw new CDPTargetClosedError('private connection detail');
    },
    devSettings: async () => assert.fail('no settings after failed reconnect'),
    observeDevOverlay: async () => assert.fail('no reads after failed reconnect'),
    log() {},
  });
  const env = parseEnvelope(result);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED_READ_FAILED');
  assert.match(env.error!, /reads=0;.*last_error=transport/);
  assert.doesNotMatch(env.error!, /private connection detail/);
});
