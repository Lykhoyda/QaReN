import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { withConnection, okResult, failResult } from '../../dist/utils.js';
import { resetActiveSessionInMemoryForTest } from '../../dist/agent-device-wrapper.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';

// Test isolation: clear the in-memory agent-device session pointer (without
// unlinking the on-disk file, which would break a developer's live MCP run).
// handleDevClientPicker is gated on hasActiveSession(); without this the
// HELPERS_NOT_INJECTED fallback in withConnection would shell out to the real
// agent-device daemon and burn ~70s per test.
beforeEach(() => {
  resetActiveSessionInMemoryForTest();
});

// ── Happy path ────────────────────────────────────────────────────────

test('withConnection passes args and client to handler when already connected', async () => {
  let receivedArgs, receivedClient;
  const client = createMockClient({
    evaluate: async () => ({ value: 13 }),
  });
  const handler = withConnection(
    () => client,
    async (args, c) => {
      receivedArgs = args;
      receivedClient = c;
      return okResult({ done: true });
    },
  );
  const result = await handler({ foo: 'bar' });
  assert.deepEqual(receivedArgs, { foo: 'bar' });
  assert.equal(receivedClient, client);
  assert.equal(parseEnvelope(result).ok, true);
});

// ── Auto-connect when disconnected ────────────────────────────────────

test('withConnection auto-connects when client is disconnected', async () => {
  let autoConnectCalled = false;
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: false,
    async autoConnect() {
      autoConnectCalled = true;
      client._isConnected = true;
      client._helpersInjected = true;
    },
    evaluate: async () => ({ value: 13 }),
  });

  const handler = withConnection(
    () => client,
    async (_args, c) => okResult({ connected: c.isConnected }),
  );
  const result = await handler({});
  assert.equal(autoConnectCalled, true);
  assert.equal(parseEnvelope(result).ok, true);
});

test('withConnection joins an active reconnect before dispatch', async () => {
  const reconnectState = { active: true, lastAttempt: null, attemptCount: 1 };
  const client = createMockClient({
    _isConnected: false,
    reconnectState,
  });
  let dispatched = false;
  setTimeout(() => {
    client._isConnected = true;
    reconnectState.active = false;
  }, 10);

  const handler = withConnection(
    () => client,
    async () => {
      dispatched = true;
      return okResult({ recovered: true });
    },
    { requireHelpers: false },
  );
  const result = await handler({});

  assert.equal(parseEnvelope(result).ok, true);
  assert.equal(dispatched, true);
  assert.equal(reconnectState.active, false);
});

// ── Auto-connect failure ──────────────────────────────────────────────

test('withConnection returns failResult when autoConnect throws', async () => {
  const client = createMockClient({
    _isConnected: false,
    async autoConnect() {
      throw new Error('Metro not running');
    },
  });

  const handler = withConnection(
    () => client,
    async () => okResult({ unreachable: true }),
  );
  const result = await handler({});
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error, /Metro not running/);
});

// ── Helpers not injected — waits then succeeds ────────────────────────

test('withConnection waits for helpers to be injected', async () => {
  const client = createMockClient({
    _helpersInjected: false,
    evaluate: async () => ({ value: 13 }),
  });
  // Simulate helpers becoming ready after a short delay
  setTimeout(() => {
    client._helpersInjected = true;
  }, 100);

  const handler = withConnection(
    () => client,
    async () => okResult({ ready: true }),
  );
  const result = await handler({});
  assert.equal(parseEnvelope(result).ok, true);
});

// ── Active 1-shot re-inject when passive wait expires (D###) ──────────

test('withConnection actively re-injects helpers when passive wait expires', async () => {
  let reinjectCalled = 0;
  const client = createMockClient({
    _helpersInjected: false,
    async reinjectHelpers() {
      reinjectCalled++;
      client._helpersInjected = true;
      return true;
    },
    evaluate: async () => ({ value: 13 }),
  });
  // Note: do NOT auto-flip the flag — let the 5s passive wait expire so the
  // active reinject path runs.

  const handler = withConnection(
    () => client,
    async () => okResult({ recovered: true }),
  );
  const result = await handler({});
  assert.equal(
    reinjectCalled,
    1,
    'reinjectHelpers should fire exactly once after passive wait expires',
  );
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.deepEqual(env.data, { recovered: true });
});

test('withConnection returns actionable HELPERS_NOT_INJECTED error when active re-inject also fails', async () => {
  let reinjectCalled = 0;
  const client = createMockClient({
    _helpersInjected: false,
    async reinjectHelpers() {
      reinjectCalled++;
      // Simulate JS world hung — re-inject can't land
      return false;
    },
    evaluate: async () => ({ value: 13 }),
  });

  const handler = withConnection(
    () => client,
    async () => okResult({ unreachable: true }),
  );
  const result = await handler({});
  assert.equal(reinjectCalled, 1, 'reinjectHelpers should still be attempted once');
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'HELPERS_NOT_INJECTED');
  assert.match(env.error, /device_\* tools/, 'error must guide caller to fallback path');
  assert.match(env.error, /cdp_reload/, 'error must mention cdp_reload as escape hatch');
});

test('withConnection skips active re-inject when not connected', async () => {
  let reinjectCalled = 0;
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: false,
    async autoConnect() {
      throw new Error('Metro not running');
    },
    async reinjectHelpers() {
      reinjectCalled++;
      return true;
    },
  });

  const handler = withConnection(
    () => client,
    async () => okResult({}),
  );
  const result = await handler({});
  assert.equal(reinjectCalled, 0, 'reinjectHelpers must NOT be attempted when autoConnect failed');
  assert.equal(parseEnvelope(result).ok, false);
});

// ── requireHelpers: false skips helper check ──────────────────────────

test('withConnection skips helper check when requireHelpers is false', async () => {
  const client = createMockClient({
    _helpersInjected: false,
    evaluate: async () => ({ value: undefined }),
  });

  const handler = withConnection(
    () => client,
    async () => okResult({ raw: true }),
    { requireHelpers: false },
  );
  const result = await handler({});
  assert.equal(parseEnvelope(result).ok, true);
});

// ── Handler error: WebSocket disconnect → retry ───────────────────────

test('withConnection retries after WebSocket disconnect', async () => {
  let callCount = 0;
  const client = createMockClient({
    evaluate: async () => ({ value: 13 }),
  });

  const handler = withConnection(
    () => client,
    async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('WebSocket closed unexpectedly');
      }
      return okResult({ retried: true });
    },
  );
  // Client stays connected so the retry path finds it reconnected
  const result = await handler({});
  assert.equal(callCount, 2);
  assert.equal(parseEnvelope(result).ok, true);
});

// ── Handler error: non-disconnect error ───────────────────────────────

test('withConnection returns failResult for non-disconnect errors', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: 13 }),
  });

  const handler = withConnection(
    () => client,
    async () => {
      throw new Error('Unexpected null reference');
    },
  );
  const result = await handler({});
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error, /Unexpected null reference/);
});

// ── Stale helper detection via B63 ────────────────────────────────────

test('withConnection re-injects helpers when handler returns __QAREN not defined', async () => {
  let callCount = 0;
  let reinjectCount = 0;
  const client = createMockClient({
    evaluate: async (expr) => {
      if (expr.includes('typeof globalThis.__QAREN')) {
        // D502 proactive freshness check: return version number (helpers are alive)
        // B63 stale detection probe: after handler returns stale error, probe fails
        // The B63 path calls this AFTER the handler returned a stale indicator
        if (callCount === 1 && reinjectCount === 0) {
          // Probe during B63 stale check — helpers gone
          return { value: false };
        }
        return { value: 13 };
      }
      return { value: undefined };
    },
    async reinjectHelpers() {
      reinjectCount++;
      client._helpersInjected = true;
      return true;
    },
  });

  const handler = withConnection(
    () => client,
    async () => {
      callCount++;
      if (callCount === 1) {
        return failResult('__QAREN is not defined');
      }
      return okResult({ recovered: true });
    },
  );
  const result = await handler({});
  assert.ok(reinjectCount >= 1, 'reinjectHelpers should have been called');
  assert.equal(callCount, 2, 'handler should have been called twice (original + retry)');
  assert.equal(parseEnvelope(result).ok, true);
});
