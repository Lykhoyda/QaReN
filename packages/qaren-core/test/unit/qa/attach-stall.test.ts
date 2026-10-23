import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { admit, type AdmissionSteps } from '../../../dist/qa/admission.js';
import {
  BundleReadinessTimeoutError,
  TargetListAttemptTimeoutError,
  TargetReadinessTimeoutError,
} from '../../../dist/cdp/discovery.js';
import {
  CDPProbeTimeoutError,
  CDPHandshakeTimeoutError,
  CDPTargetClosedError,
} from '../../../dist/cdp/connect.js';
import { CDPRequestTimeoutError } from '../../../dist/cdp/transport.js';
import { createStop } from '../../../dist/qa/stop.js';

function stalled(t: TestContext, overrides: Partial<AdmissionSteps> = {}) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  const stop = createStop();
  let settled = false;
  let relaunches = 0;
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    remainingMs: () => 1_199_000 - now,
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target');
    },
    appAlive: async () => true,
    bundleRequested: async () => true,
    relaunch: async () => {
      relaunches++;
    },
    foreignDriver: async () => undefined,
    open: async () => assert.fail('no session without a target'),
    prove: async () => assert.fail('no proof without a target'),
    close: async () => undefined,
    ...overrides,
  };
  const result = admit(steps, stop).then(
    (proof) => {
      settled = true;
      return proof;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  t.after(async () => {
    stop.begin();
    await result;
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return {
    relaunches: () => relaunches,
    async run() {
      await nextTurn();
      while (!settled && now < 121_000) {
        now += 500;
        t.mock.timers.tick(500);
        await nextTurn();
      }
      assert.equal(settled, true, 'attach must not consume the 1,199-second walk budget');
      return result;
    },
  };
}

for (const [name, bundleRequested, state] of [
  ['a received bundle request', async () => true, 'received'],
  ['an unknown signal', async () => undefined, 'unknown'],
  ['an absent signal', undefined, 'unknown'],
  [
    'a failed signal',
    async () => {
      throw new Error('unreadable');
    },
    'probe_failed',
  ],
] as const) {
  test(`a live app without a target and ${name} refuses within two minutes`, async (t) => {
    const fixture = stalled(t, { bundleRequested });
    const error = await fixture.run();
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /target_readiness_timeout/);
    assert.equal(error.meta.bundleRequest, state);
    assert.equal(error.meta.budgetMs, 120_000);
    assert.equal(fixture.relaunches(), 0);
  });
}

for (const [name, error, inner, relaunches] of [
  ['an empty list', new TargetReadinessTimeoutError('no target', 'empty'), 'target_list_empty', 0],
  [
    'another device',
    new TargetReadinessTimeoutError('no target', 'other_device'),
    'target_other_device',
    0,
  ],
  [
    'another bundle',
    new BundleReadinessTimeoutError('wrong bundle', 'other_bundle'),
    'bundle_readiness_timeout',
    0,
  ],
  [
    'an unreadable list',
    new TargetListAttemptTimeoutError('list timed out'),
    'target_list_attempt_timeout',
    0,
  ],
  ['a silent probe', new CDPProbeTimeoutError('probe timed out'), 'cdp_probe_timeout', 1],
  [
    'a silent handshake',
    new CDPHandshakeTimeoutError('handshake timed out'),
    'cdp_handshake_timeout',
    1,
  ],
  ['a closed target', new CDPTargetClosedError('target closed'), 'cdp_target_closed', 0],
  [
    'an unanswered request',
    new CDPRequestTimeoutError('Runtime.evaluate timed out'),
    'cdp_request_timeout',
    0,
  ],
] as const) {
  test(`${name} cannot extend admission to the walk deadline`, async (t) => {
    const fixture = stalled(t, {
      attach: async () => {
        throw error;
      },
    });
    const refused = await fixture.run();
    assert.equal(refused.code, 'CDP_NOT_CONNECTED');
    assert.equal(refused.meta.inner, inner);
    assert.equal(fixture.relaunches(), relaunches);
  });
}

test('a never-settling attach is interrupted by the admission bound', async (t) => {
  const fixture = stalled(t, { attach: () => new Promise(() => undefined) });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.budgetMs, 120_000);
  assert.equal(error.meta.lastStarted, 'attach');
});

test('React that never becomes ready is bounded without a no-target relaunch', async (t) => {
  const fixture = stalled(t, {
    attach: async () => undefined,
    bundleReady: () => new Promise(() => undefined),
  });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.lastStarted, 'bundle_ready');
  assert.equal(fixture.relaunches(), 0);
});

for (const change of ['dead_app', 'no_request'] as const) {
  test(`a skipped no-target recovery is reconsidered when it observes ${change}`, async (t) => {
    let launched = false;
    let probes = 0;
    const fixture = stalled(t, {
      attach: async () => {
        if (!launched) throw new TargetReadinessTimeoutError('no target');
      },
      appAlive: async () => ++probes === 1 || change !== 'dead_app',
      bundleRequested: async () => (probes === 1 ? undefined : false),
      relaunch: async () => {
        launched = true;
      },
      open: async () => undefined,
      prove: async () => ({
        ok: true,
        scriptURL: 'http://127.0.0.1:8081/index.bundle',
        appModules: 3,
      }),
    });
    assert.equal((await fixture.run()).ok, true);
    assert.equal(launched, true);
    assert.equal(probes, 2);
  });
}

test('a platform without a relaunch adapter still has a bounded attach', async (t) => {
  const fixture = stalled(t, { relaunch: undefined });
  assert.equal((await fixture.run()).code, 'CDP_NOT_CONNECTED');
});
