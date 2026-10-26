import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleClose, startBackgroundPoll } from '../../dist/cdp/reconnection.js';

// Spec 2026-06-10-debugger-seat-optout: with autoConnect disabled, the
// BACKGROUND seat-grabbing paths (handleClose reconnect loop, background
// poll) must not run. On-demand connect during tool calls is untouched.

function makeCtx(overrides = {}) {
  const calls = { discover: 0, stateSet: [], resetCalls: 0 };
  const ctx = {
    isDisposed: () => false,
    isReconnecting: () => false,
    isConnected: () => false,
    isSoftReconnectRequested: () => false,
    setReconnecting: () => {},
    setSoftReconnectRequested: () => {},
    setState: (s) => calls.stateSet.push(s),
    setReconnectAttempt: () => {},
    closeWs: () => {},
    rejectAllPending: () => {},
    discoverAndConnect: async () => {
      calls.discover++;
      return 'ws://x';
    },
    getResettableState: () => ({
      setState: () => {},
      setHelpersInjected: () => {
        calls.resetCalls++;
      },
      setBridgeDetected: () => {},
      setBridgeVersion: () => {},
      setConnectedTarget: () => {},
      setConnectedAt: () => {},
      setLogDomainEnabled: () => {},
      setProfilerAvailable: () => {},
      setHeapProfilerAvailable: () => {},
      clearScripts: () => {},
    }),
    getPort: () => 8081,
    setBgPollTimer: (t) => {
      ctx._timer = t;
    },
    getBgPollTimer: () => ctx._timer ?? null,
    _timer: null,
    ...overrides,
  };
  return { ctx, calls };
}

test('handleClose: passive mode → state disconnected, no reconnect loop', async () => {
  const { ctx, calls } = makeCtx({ isAutoConnectEnabled: () => false });
  handleClose(ctx, 1006);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.discover, 0, 'reconnect loop must not start');
  assert.ok(calls.stateSet.includes('disconnected'));
  assert.ok(!calls.stateSet.includes('reconnecting'));
  assert.ok(calls.resetCalls >= 1, 'resetState must run before the passive gate');
});

test('handleClose: default (no isAutoConnectEnabled) → reconnect starts (back-compat)', async () => {
  const { ctx, calls } = makeCtx();
  handleClose(ctx, 1006);
  // attempt 0 has 0ms delay → discoverAndConnect fires on the microtask queue
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.discover >= 1, 'reconnect loop must start when callback absent');
  assert.ok(calls.stateSet.includes('reconnecting'));
});

test('handleClose: autoConnect enabled → reconnect starts', async () => {
  const { ctx, calls } = makeCtx({ isAutoConnectEnabled: () => true });
  handleClose(ctx, 1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.discover >= 1);
});

test('startBackgroundPoll: passive mode → no timer installed', () => {
  const { ctx } = makeCtx({ isAutoConnectEnabled: () => false });
  startBackgroundPoll(ctx);
  assert.equal(ctx.getBgPollTimer(), null, 'background poll must not be armed');
});

test('startBackgroundPoll: enabled → timer installed (and cleaned up)', () => {
  const { ctx } = makeCtx({ isAutoConnectEnabled: () => true });
  startBackgroundPoll(ctx);
  assert.notEqual(ctx.getBgPollTimer(), null);
  clearInterval(ctx.getBgPollTimer());
});
