// GH #262: when the cold-relaunch fails AND simctl confirms the bundle is not
// installed, recovery short-circuits with reason 'app-not-installed'
// (carrying udid/appId for advice + a best-effort injected snapshot hint)
// instead of looping on reconnect attempts that can never succeed. Probe
// verdicts true/null keep the existing still-detached behavior (fail open).
// Concurrent recoveries are serialized (followers share the leader's
// verdict); a confirmed not-installed is cached per (udid, appId) and
// re-probed cheaply so a user reinstall self-heals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverDetached, resetDetachedRecoveryCounter } from '../../dist/cdp/recover-detached.js';

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
      relaunchApp: async () => {
        calls.push('relaunch');
        throw new Error('FBSOpenApplicationServiceErrorDomain, code=4');
      },
      stopFastRunner: () => calls.push('stop'),
      reconnect: async () => {
        calls.push('reconnect');
      },
      probeAlive: async () => false,
      sleep: async () => {
        calls.push('sleep');
      },
      maxPerSession: 3,
      ...over,
    },
  };
}

test('launch fails + probe FALSE → app-not-installed, short-circuits settle/reconnect', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({
    isAppInstalled: async (udid, appId) => {
      calls.push(`probe:${udid}:${appId}`);
      return false;
    },
    snapshotHint: () => ({ path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 7 }),
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'app-not-installed');
  assert.equal(r.attempt, 1);
  assert.equal(r.udid, 'AAAAAAAA-0000-0000-0000-000000000001');
  assert.equal(r.appId, 'com.example.app');
  assert.match(r.error, /code=4/);
  assert.deepEqual(r.snapshotHint, { path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 7 });
  assert.ok(calls.includes('probe:AAAAAAAA-0000-0000-0000-000000000001:com.example.app'));
  assert.ok(!calls.includes('sleep'), 'short-circuit: no settle wait');
  assert.ok(!calls.includes('reconnect'), 'short-circuit: no reconnect attempt');
});

test('no snapshotHint dep injected → app-not-installed without hint (cdp layer has no default)', async () => {
  resetDetachedRecoveryCounter();
  const { deps } = baseDeps({ isAppInstalled: async () => false });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'app-not-installed');
  assert.equal(r.snapshotHint, undefined);
});

test('launch fails + probe NULL (ambiguous) → still-detached with raw error (fail open)', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({ isAppInstalled: async () => null });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'still-detached');
  assert.match(r.error, /code=4/);
  assert.equal(r.snapshotHint, undefined);
  assert.ok(calls.includes('reconnect'), 'normal path still attempts reconnect');
});

test('launch fails + probe TRUE (installed) → existing behavior unchanged', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({ isAppInstalled: async () => true });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'still-detached');
  assert.ok(calls.includes('reconnect'));
});

test('snapshot hint THROWS → app-not-installed without hint (hint is best-effort)', async () => {
  resetDetachedRecoveryCounter();
  const { deps } = baseDeps({
    isAppInstalled: async () => false,
    snapshotHint: () => {
      throw new Error('plist exploded');
    },
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'app-not-installed');
  assert.equal(r.snapshotHint, undefined);
});

test('terminal cache: second call re-probes cheaply, NO relaunch side effects, NO budget burn', async () => {
  resetDetachedRecoveryCounter();
  const first = baseDeps({ isAppInstalled: async () => false });
  assert.equal((await recoverDetached({}, first.deps)).reason, 'app-not-installed');

  const second = baseDeps({ isAppInstalled: async () => false });
  const r2 = await recoverDetached({}, second.deps);
  assert.equal(r2.reason, 'app-not-installed');
  assert.equal(r2.attempt, 1, 'cached diagnosis does not burn budget');
  assert.ok(!second.calls.includes('relaunch'), 'no terminate/launch on a cached diagnosis');
});

test('terminal cache self-heals: re-probe TRUE clears the cache and recovery proceeds', async () => {
  resetDetachedRecoveryCounter();
  const first = baseDeps({ isAppInstalled: async () => false });
  await recoverDetached({}, first.deps);

  const calls = [];
  const deps = baseDeps({
    isAppInstalled: async () => true, // user reinstalled
    relaunchApp: async () => {
      calls.push('relaunch');
    },
    probeAlive: async () => true,
  }).deps;
  const r2 = await recoverDetached(
    {},
    {
      ...deps,
      relaunchApp: async () => {
        calls.push('relaunch');
      },
    },
  );
  assert.equal(r2.reason, 'recovered');
  assert.ok(calls.includes('relaunch'), 'normal recovery resumed after reinstall');
});

test('self-heal after exhausted-budget diagnosis also resets the budget (PR #280 P2)', async () => {
  resetDetachedRecoveryCounter();
  // Exhaust the budget (app installed, just wedged).
  for (let i = 0; i < 3; i += 1) {
    await recoverDetached({}, baseDeps({ isAppInstalled: async () => true }).deps);
  }
  // App uninstalled: exhausted-path probe diagnoses + caches.
  assert.equal(
    (await recoverDetached({}, baseDeps({ isAppInstalled: async () => false }).deps)).reason,
    'app-not-installed',
  );
  // User reinstalls: recovery must actually RETRY (not budget-exhausted).
  const calls = [];
  const { deps } = baseDeps({
    isAppInstalled: async () => true,
    probeAlive: async () => true,
  });
  deps.relaunchApp = async () => {
    calls.push('relaunch');
  };
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'recovered');
  assert.equal(r.attempt, 1, 'budget restarted fresh after confirmed reinstall');
  assert.ok(calls.includes('relaunch'));
});

test('self-heal re-probe NULL clears the cache but keeps the exhausted budget (fail open)', async () => {
  resetDetachedRecoveryCounter();
  for (let i = 0; i < 3; i += 1) {
    await recoverDetached({}, baseDeps({ isAppInstalled: async () => true }).deps);
  }
  await recoverDetached({}, baseDeps({ isAppInstalled: async () => false }).deps); // cache it
  const r = await recoverDetached({}, baseDeps({ isAppInstalled: async () => null }).deps);
  assert.equal(r.reason, 'budget-exhausted', 'null verdict is not evidence of reinstall');
});

test('concurrent recoveries are serialized: followers share the leader verdict, one relaunch total', async () => {
  resetDetachedRecoveryCounter();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let relaunches = 0;
  const { deps } = baseDeps({
    relaunchApp: async () => {
      relaunches += 1;
      await gate;
      throw new Error('code=4');
    },
    isAppInstalled: async () => false,
    snapshotHint: () => null,
  });
  const p1 = recoverDetached({}, deps);
  const p2 = recoverDetached({}, deps);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(relaunches, 1, 'follower must not run its own terminate/launch');
  assert.equal(r1.reason, 'app-not-installed');
  assert.deepEqual(r2, r1, 'follower shares the leader verdict');
});

test('relaunch SUCCEEDS → probe never called (cost lands only on the failed path)', async () => {
  resetDetachedRecoveryCounter();
  let probed = false;
  const { deps } = baseDeps({
    relaunchApp: async () => {},
    probeAlive: async () => true,
    isAppInstalled: async () => {
      probed = true;
      return false;
    },
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'recovered');
  assert.equal(probed, false);
});

test('exhausted budget does not mask a freshly missing bundle (PR #280 P2)', async () => {
  resetDetachedRecoveryCounter();
  // Exhaust the budget with still-detached attempts (app installed, just wedged).
  for (let i = 0; i < 3; i += 1) {
    const r = await recoverDetached({}, baseDeps({ isAppInstalled: async () => true }).deps);
    assert.equal(r.reason, 'still-detached');
  }
  // App now uninstalled: the 4th call must diagnose, not surrender.
  const { calls, deps } = baseDeps({
    isAppInstalled: async () => false,
    snapshotHint: () => ({ path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 1 }),
  });
  const r4 = await recoverDetached({}, deps);
  assert.equal(r4.reason, 'app-not-installed');
  assert.equal(r4.udid, 'AAAAAAAA-0000-0000-0000-000000000001');
  assert.deepEqual(r4.snapshotHint, {
    path: '/tmp/rn-appfile-snapshots/My App.app',
    ageMinutes: 1,
  });
  assert.ok(!calls.includes('relaunch'), 'no side effects on the exhausted path');
  // And it cached: the next call short-circuits the same way.
  const r5 = await recoverDetached({}, baseDeps({ isAppInstalled: async () => false }).deps);
  assert.equal(r5.reason, 'app-not-installed');
});

test('exhausted budget + probe true/null → budget-exhausted unchanged (fail open)', async () => {
  resetDetachedRecoveryCounter();
  for (let i = 0; i < 3; i += 1) {
    await recoverDetached({}, baseDeps({ isAppInstalled: async () => true }).deps);
  }
  const rTrue = await recoverDetached({}, baseDeps({ isAppInstalled: async () => true }).deps);
  assert.equal(rTrue.reason, 'budget-exhausted');
  const rNull = await recoverDetached({}, baseDeps({ isAppInstalled: async () => null }).deps);
  assert.equal(rNull.reason, 'budget-exhausted');
});

test('malformed session identifiers → no-session, nothing reaches simctl (codex-pair)', async () => {
  resetDetachedRecoveryCounter();
  const evilUdid = baseDeps({
    getSession: () => ({ deviceId: 'evil; rm -rf /', appId: 'com.example.app', platform: 'ios' }),
    isAppInstalled: async () => {
      throw new Error('probe must not run');
    },
  });
  const r1 = await recoverDetached({}, evilUdid.deps);
  assert.equal(r1.reason, 'no-session');
  assert.ok(!evilUdid.calls.includes('relaunch'), 'no simctl side effects');

  const evilAppId = baseDeps({
    getSession: () => ({
      deviceId: 'F1A2B3C4-1111-2222-3333-444455556666',
      appId: 'not a bundle id!',
      platform: 'ios',
    }),
    isAppInstalled: async () => {
      throw new Error('probe must not run');
    },
  });
  const r2 = await recoverDetached({}, evilAppId.deps);
  assert.equal(r2.reason, 'no-session');
  assert.ok(!evilAppId.calls.includes('relaunch'));

  // Budget untouched by the rejections: a real attempt is still attempt 1.
  const real = await recoverDetached({}, baseDeps({ isAppInstalled: async () => null }).deps);
  assert.equal(real.attempt, 1);
});
