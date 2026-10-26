import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TargetSelectionError } from '../../dist/cdp/discovery.js';
import {
  ConnectionSetupSupersededError,
  connectWebSocket,
  discoverAndConnect,
} from '../../dist/cdp/connect.js';

// Minimal ConnectContext stub — only the methods discoverAndConnect calls
// before the connectToTarget loop are exercised by these tests. The G9
// throw exits early on empty `sorted`, so we don't need a real WebSocket.
function createMockContext({ initialFilters = {}, port = 8081 } = {}) {
  const state = {
    disposed: false,
    port,
    connectFilters: { ...initialFilters },
    currentState: 'disconnected',
    setConnectFiltersCalled: false,
    setStateCalls: [],
  };
  const ctx = {
    isDisposed: () => state.disposed,
    isReconnecting: () => false,
    isSoftReconnectRequested: () => false,
    getState: () => state.currentState,
    setState: (s) => {
      state.currentState = s;
      state.setStateCalls.push(s);
    },
    getPort: () => state.port,
    setPort: (v) => {
      state.port = v;
    },
    getConnectFilters: () => state.connectFilters,
    setConnectFilters: (v) => {
      state.connectFilters = v;
      state.setConnectFiltersCalled = true;
    },
    getWs: () => null,
    setWs: () => {},
    setHelpersInjected: () => {},
    setConnectedTarget: () => {},
    setConnectedAt: () => {},
    now: () => 1_000_000,
    incrementConnectionGeneration: () => 1,
    evaluate: async () => ({ value: undefined }),
    sendWithTimeout: async () => null,
    handleMessage: () => {},
    handleClose: () => {},
    rejectAllPending: () => {},
    setup: async () => {},
    getProxyUrl: () => null,
  };
  return { state, ctx };
}

// ── B111 / D643 / G9: discoverAndConnect throws on empty target list ──

test('discoverAndConnect: throws with selectionWarning when discover returns [] (B111/D643/G9)', async () => {
  const { state, ctx } = createMockContext({ port: 8081 });
  const mockDiscover = async () => ({
    port: 8081,
    targets: [],
    warning: 'targetId "phantom-99" not found. Available ids: real-1, real-2',
  });
  await assert.rejects(
    () => discoverAndConnect(ctx, undefined, undefined, mockDiscover),
    /targetId "phantom-99" not found/,
  );
  // State must be left clean for the reconnect loop / caller error handling
  assert.equal(state.currentState, 'disconnected');
  assert.ok(
    state.setStateCalls.includes('disconnected'),
    'setState("disconnected") must be called before throw',
  );
});

test('discoverAndConnect: a selection refusal carries the discovery inference on its typed error', async () => {
  const { state, ctx } = createMockContext();
  const inference = { readers: {}, targets: [] };
  const candidate = { id: 'a-1' };
  const mockDiscover = async () => ({
    port: 8081,
    targets: [],
    warning: 'PLATFORM_TARGET_NOT_FOUND: requested platform cannot be proven',
    errorCode: 'PLATFORM_TARGET_NOT_FOUND',
    candidates: [candidate],
    inference,
  });
  await assert.rejects(
    () => discoverAndConnect(ctx, undefined, undefined, mockDiscover),
    (error) => {
      assert.ok(error instanceof TargetSelectionError);
      assert.equal(error.code, 'PLATFORM_TARGET_NOT_FOUND');
      assert.equal(error.inference, inference);
      assert.deepEqual(error.candidates, [candidate]);
      return true;
    },
  );
  assert.equal(state.currentState, 'disconnected');
});

test('discoverAndConnect: throws with default message when discover returns [] without warning (B111/D643/G9)', async () => {
  const { ctx } = createMockContext();
  const mockDiscover = async () => ({ port: 8081, targets: [], warning: undefined });
  await assert.rejects(
    () => discoverAndConnect(ctx, undefined, undefined, mockDiscover),
    /No matching CDP targets found/,
  );
});

// ── B111 / D643 / G7: filters preserved across no-filters call (softReconnect path) ──

test('discoverAndConnect: filters=undefined preserves stored _connectFilters (B111/D643/G7)', async () => {
  // Simulates softReconnect — previously-set filters must survive a no-args reconnect call.
  const { state, ctx } = createMockContext({
    initialFilters: { bundleId: 'com.persisted', targetId: 'page-1' },
  });
  let observedFilters;
  const mockDiscover = async (_port, filters) => {
    observedFilters = filters;
    return { port: 8081, targets: [], warning: 'observable-stop' };
  };
  await assert.rejects(
    () => discoverAndConnect(ctx, undefined, undefined, mockDiscover),
    /observable-stop/,
  );
  // The stored bundleId+targetId must have been forwarded to discover via getConnectFilters
  assert.equal(observedFilters.bundleId, 'com.persisted');
  assert.equal(observedFilters.targetId, 'page-1');
  // setConnectFilters must NOT have been called — undefined is the "preserve" signal
  assert.equal(state.setConnectFiltersCalled, false);
});

test('discoverAndConnect: explicit filters overwrite _connectFilters (B111/D643/G7)', async () => {
  const { state, ctx } = createMockContext({ initialFilters: { bundleId: 'com.old' } });
  const newFilters = { bundleId: 'com.new', targetId: 'page-9' };
  const mockDiscover = async () => ({ port: 8081, targets: [], warning: 'observable-stop' });
  await assert.rejects(
    () => discoverAndConnect(ctx, undefined, newFilters, mockDiscover),
    /observable-stop/,
  );
  assert.equal(state.setConnectFiltersCalled, true);
  assert.deepEqual(state.connectFilters, newFilters);
});

test('connectWebSocket terminates a socket that opens after client disposal', async () => {
  const { state, ctx } = createMockContext();
  const socket = new EventEmitter();
  socket.readyState = 0;
  socket.terminated = false;
  socket.terminate = () => {
    socket.terminated = true;
    socket.readyState = 3;
  };

  const pending = connectWebSocket(ctx, 'ws://127.0.0.1:8191/exact', () => socket);
  state.disposed = true;
  socket.emit('open');

  await assert.rejects(pending, ConnectionSetupSupersededError);
  assert.equal(socket.terminated, true);
  assert.equal(state.currentState, 'disconnected');
  assert.deepEqual(state.setStateCalls, []);
});
