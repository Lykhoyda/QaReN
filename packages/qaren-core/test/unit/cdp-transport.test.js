import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWithTimeout, rejectAllPending, handleMessage } from '../../dist/cdp/transport.js';

const OPEN = 1; // WebSocket.OPEN

function fakeWs({ open = true } = {}) {
  const sent = [];
  return {
    readyState: open ? OPEN : 3, // CLOSED
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    _sent: sent,
  };
}

test('sendWithTimeout rejects when ws is null', async () => {
  const pending = new Map();
  await assert.rejects(
    () => sendWithTimeout(null, pending, () => 1, 'X', {}, 100),
    /WebSocket not connected/,
  );
  assert.equal(pending.size, 0);
});

test('sendWithTimeout rejects when ws is not OPEN', async () => {
  const pending = new Map();
  const ws = fakeWs({ open: false });
  await assert.rejects(
    () => sendWithTimeout(ws, pending, () => 1, 'X', {}, 100),
    /WebSocket not connected/,
  );
});

test('sendWithTimeout serializes {id, method, params} onto the socket', async () => {
  const pending = new Map();
  const ws = fakeWs();
  let id = 0;
  const p = sendWithTimeout(
    ws,
    pending,
    () => ++id,
    'Runtime.evaluate',
    { expression: '1+1' },
    200,
  );
  assert.equal(ws._sent.length, 1);
  assert.deepEqual(ws._sent[0], {
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
  });
  assert.equal(pending.size, 1);
  // Resolve the promise so the test doesn't leak the timer
  const entry = pending.get(1);
  entry.resolve({ ok: true });
  clearTimeout(entry.timer);
  pending.delete(1);
  await p;
});

test('sendWithTimeout rejects with timeout message after ms elapses', async () => {
  const pending = new Map();
  const ws = fakeWs();
  await assert.rejects(
    () => sendWithTimeout(ws, pending, () => 1, 'SlowMethod', {}, 20),
    /CDP timeout \(20ms\): SlowMethod/,
  );
  assert.equal(pending.size, 0);
});

test('rejectAllPending clears the map and rejects every entry', () => {
  const pending = new Map();
  const errors = [];
  pending.set(1, {
    resolve: () => {},
    reject: (err) => errors.push(err.message),
    timer: setTimeout(() => {}, 60_000),
  });
  pending.set(2, {
    resolve: () => {},
    reject: (err) => errors.push(err.message),
    timer: setTimeout(() => {}, 60_000),
  });
  rejectAllPending(pending, new Error('bye'));
  assert.equal(pending.size, 0);
  assert.deepEqual(errors, ['bye', 'bye']);
});

test('handleMessage resolves matching pending call by id', () => {
  const pending = new Map();
  let resolved;
  pending.set(7, {
    resolve: (v) => {
      resolved = v;
    },
    reject: () => {},
    timer: setTimeout(() => {}, 60_000),
  });
  handleMessage(JSON.stringify({ id: 7, result: { x: 1 } }), pending, new Map());
  assert.deepEqual(resolved, { x: 1 });
  assert.equal(pending.size, 0);
});

test('handleMessage rejects pending call when error is present', () => {
  const pending = new Map();
  let rejected;
  pending.set(8, {
    resolve: () => {},
    reject: (e) => {
      rejected = e;
    },
    timer: setTimeout(() => {}, 60_000),
  });
  handleMessage(JSON.stringify({ id: 8, error: { message: 'boom' } }), pending, new Map());
  assert.equal(rejected.message, 'boom');
  assert.equal(pending.size, 0);
});

test('handleMessage routes events to registered handler by method name', () => {
  const handlers = new Map();
  let received;
  handlers.set('Network.requestWillBeSent', (p) => {
    received = p;
  });
  handleMessage(
    JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: 'r1' } }),
    new Map(),
    handlers,
  );
  assert.deepEqual(received, { requestId: 'r1' });
});

test('handleMessage invokes console hook on Runtime.consoleAPICalled', () => {
  let hookParams;
  handleMessage(
    JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [] } }),
    new Map(),
    new Map(),
    (p) => {
      hookParams = p;
    },
  );
  assert.deepEqual(hookParams, { type: 'log', args: [] });
});

test('handleMessage ignores malformed JSON without throwing', () => {
  // Should not throw
  handleMessage('not json', new Map(), new Map());
});

test('handleMessage ignores non-object shapes', () => {
  handleMessage(JSON.stringify([1, 2, 3]), new Map(), new Map());
  handleMessage(JSON.stringify(null), new Map(), new Map());
});
