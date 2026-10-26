// GH #208 (RC3): bounded auto-relaunch recovery for the DETACHED-app case
// (Metro up, 0 Hermes targets). Mirrors recover-wedge's safety scaffolding
// (consecutive-attempt budget, arbiter flow-lease skip, session resolution,
// liveness-probe confirmation) BUT cold-restarts (terminate+launch) instead of
// recover-wedge's bare launch — the app isn't backgrounded, it's gone. Adds an
// opt-out (RN_AUTO_RELAUNCH_ON_DETACH=0) because a cold restart destroys JS
// state (acceptable here only because the session is ALREADY broken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverDetached,
  resetDetachedRecoveryCounter,
  defaultRelaunchApp,
} from '../../dist/cdp/recover-detached.js';

function baseDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      getSession: () => ({
        deviceId: 'AAAAAAAA-0000-0000-0000-000000000001',
        appId: 'com.example.app',
        platform: 'ios',
      }),
      isFlowActive: () => false,
      isOptedOut: () => false,
      relaunchApp: async (udid, appId) => {
        calls.push(`relaunch:${udid}:${appId}`);
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

test('recoverDetached: parks runner, cold-restarts, reconnects, recovers (happy path + order)', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps();
  const r = await recoverDetached({}, deps);
  assert.equal(r.recovered, true);
  assert.equal(r.reason, 'recovered');
  assert.equal(r.attempt, 1);
  assert.deepEqual(calls, [
    'stop',
    'relaunch:AAAAAAAA-0000-0000-0000-000000000001:com.example.app',
    'reconnect',
  ]);
});

test('recoverDetached: liveness probe FALSE after relaunch → still-detached', async () => {
  resetDetachedRecoveryCounter();
  const { deps } = baseDeps({ probeAlive: async () => false });
  const r = await recoverDetached({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-detached');
});

test('recoverDetached: SKIPS when a flow lease is held (no device calls, no budget burn)', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({ isFlowActive: () => true });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'flow-active');
  assert.equal(calls.length, 0);
});

test('recoverDetached: SKIPS when opted out (RN_AUTO_RELAUNCH_ON_DETACH=0) — no device calls, no budget burn', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({ isOptedOut: () => true });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'opted-out');
  assert.equal(calls.length, 0);
  // Budget intact: the next real attempt is still attempt 1.
  const real = await recoverDetached({}, baseDeps({ probeAlive: async () => false }).deps);
  assert.equal(real.attempt, 1);
});

test('recoverDetached: no session → no-session; Android → unsupported-platform; neither burns budget', async () => {
  resetDetachedRecoveryCounter();
  const noSess = await recoverDetached({}, baseDeps({ getSession: () => null }).deps);
  assert.equal(noSess.reason, 'no-session');
  const android = await recoverDetached(
    {},
    baseDeps({ getSession: () => ({ deviceId: 'X', appId: 'a', platform: 'android' }) }).deps,
  );
  assert.equal(android.reason, 'unsupported-platform');
  const real = await recoverDetached({}, baseDeps({ probeAlive: async () => false }).deps);
  assert.equal(real.attempt, 1);
});

test('recoverDetached: caps CONSECUTIVE failures; a success resets the budget', async () => {
  resetDetachedRecoveryCounter();
  const failing = baseDeps({ probeAlive: async () => false, maxPerSession: 2 }).deps;
  assert.equal((await recoverDetached({}, failing)).reason, 'still-detached'); // attempt 1
  assert.equal((await recoverDetached({}, failing)).reason, 'still-detached'); // attempt 2
  assert.equal((await recoverDetached({}, failing)).reason, 'budget-exhausted'); // refused (2 >= 2)

  resetDetachedRecoveryCounter();
  assert.equal((await recoverDetached({}, failing)).reason, 'still-detached'); // attempt 1
  const ok = await recoverDetached(
    {},
    baseDeps({ probeAlive: async () => true, maxPerSession: 2 }).deps,
  ); // attempt 2 → success
  assert.equal(ok.recovered, true);
  assert.equal((await recoverDetached({}, failing)).reason, 'still-detached'); // attempt 1 again → success reset the count
});

test('recoverDetached: relaunch throws + probe FALSE → still-detached (no false positive)', async () => {
  resetDetachedRecoveryCounter();
  const { deps } = baseDeps({
    relaunchApp: async () => {
      throw new Error('simctl boom');
    },
    probeAlive: async () => false,
    isAppInstalled: async () => null,
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'still-detached');
  // Codex F3 contract: the launch failure is surfaced, never swallowed.
  assert.match(r.error ?? '', /simctl boom/);
});

// The distinguishing behavior vs recover-wedge: a COLD restart (terminate THEN
// launch), not a bare launch. terminate may fail when the app isn't running —
// that's expected for a detached app and must be tolerated.
test('defaultRelaunchApp: cold-restart issues simctl terminate THEN launch', async () => {
  const execCalls = [];
  const fakeExec = async (bin, args) => {
    execCalls.push([bin, ...args].join(' '));
    return { stdout: '', stderr: '' };
  };
  await defaultRelaunchApp('UDID-A', 'com.example.app', fakeExec);
  assert.deepEqual(execCalls, [
    'xcrun simctl terminate UDID-A com.example.app',
    'xcrun simctl launch UDID-A com.example.app',
  ]);
});

test('defaultRelaunchApp: tolerates a terminate error (app not running) and still launches', async () => {
  const execCalls = [];
  const fakeExec = async (bin, args) => {
    const cmd = [bin, ...args].join(' ');
    execCalls.push(cmd);
    if (cmd.includes('terminate')) throw new Error('found no matching processes');
    return { stdout: '', stderr: '' };
  };
  await defaultRelaunchApp('UDID-A', 'com.example.app', fakeExec);
  assert.deepEqual(execCalls, [
    'xcrun simctl terminate UDID-A com.example.app',
    'xcrun simctl launch UDID-A com.example.app',
  ]);
});
