import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverWedge, resetWedgeRecoveryCounter } from '../../dist/cdp/recover-wedge.js';

function baseDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      getSession: () => ({ deviceId: 'UDID-A', appId: 'com.example.app', platform: 'ios' }),
      isFlowActive: () => false,
      launchApp: async (udid, appId) => {
        calls.push(`launch:${udid}:${appId}`);
      },
      stopFastRunner: () => calls.push('stop'),
      reconnect: async () => {
        calls.push('reconnect');
      },
      probeAlive: async () => true,
      sleep: async () => {},
      maxPerSession: 3,
      ...over,
    },
  };
}

test('GH#202 recoverWedge: re-foregrounds, reconnects, recovers (happy path + order)', async () => {
  resetWedgeRecoveryCounter();
  const { calls, deps } = baseDeps();
  const r = await recoverWedge({}, deps);
  assert.equal(r.recovered, true);
  assert.equal(r.reason, 'recovered');
  assert.equal(r.attempt, 1);
  assert.deepEqual(calls, ['stop', 'launch:UDID-A:com.example.app', 'reconnect']);
});

test('GH#202 recoverWedge: liveness probe FALSE after re-foreground → still-wedged', async () => {
  resetWedgeRecoveryCounter();
  const { deps } = baseDeps({ probeAlive: async () => false });
  const r = await recoverWedge({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-wedged');
});

test('GH#202 recoverWedge: SKIPS when a flow lease is held (no device calls, no budget burn)', async () => {
  resetWedgeRecoveryCounter();
  const { calls, deps } = baseDeps({ isFlowActive: () => true, probeAlive: async () => false });
  const r = await recoverWedge({}, deps);
  assert.equal(r.reason, 'flow-active');
  assert.equal(calls.length, 0);
  const real = await recoverWedge({}, baseDeps({ probeAlive: async () => false }).deps);
  assert.equal(real.attempt, 1);
});

test('GH#202 recoverWedge: no session → no-session; Android → unsupported-platform; neither burns budget', async () => {
  resetWedgeRecoveryCounter();
  const noSess = await recoverWedge({}, baseDeps({ getSession: () => null }).deps);
  assert.equal(noSess.reason, 'no-session');
  const android = await recoverWedge(
    {},
    baseDeps({ getSession: () => ({ deviceId: 'X', appId: 'a', platform: 'android' }) }).deps,
  );
  assert.equal(android.reason, 'unsupported-platform');
  const real = await recoverWedge({}, baseDeps({ probeAlive: async () => false }).deps);
  assert.equal(real.attempt, 1);
});

test('GH#202 recoverWedge: caps CONSECUTIVE failures; a success resets the budget', async () => {
  resetWedgeRecoveryCounter();
  const failing = baseDeps({ probeAlive: async () => false, maxPerSession: 2 }).deps;
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 1
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 2
  assert.equal((await recoverWedge({}, failing)).reason, 'budget-exhausted'); // refused (2 >= 2)

  // A SUCCESS resets the consecutive-failure count — exercised BEFORE the cap:
  resetWedgeRecoveryCounter();
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 1
  const ok = await recoverWedge(
    {},
    baseDeps({ probeAlive: async () => true, maxPerSession: 2 }).deps,
  ); // attempt 2 → success
  assert.equal(ok.recovered, true);
  assert.equal((await recoverWedge({}, failing)).reason, 'still-wedged'); // attempt 1 again → success reset the count
});

test('GH#202 recoverWedge: re-foreground throws + probe FALSE → still-wedged (no false positive)', async () => {
  resetWedgeRecoveryCounter();
  const { deps } = baseDeps({
    launchApp: async () => {
      throw new Error('simctl boom');
    },
    probeAlive: async () => false,
  });
  const r = await recoverWedge({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-wedged');
});
