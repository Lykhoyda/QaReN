import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  admissionMetric,
  admit,
  type AdmissionRefusalFacts,
  type AdmissionSteps,
} from '../../../dist/qa/admission.js';
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
    attachBudgetMs: 120_000,
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
  const advance = async (until: number) => {
    await nextTurn();
    while (!settled && now < until) {
      now += 500;
      t.mock.timers.tick(500);
      await nextTurn();
    }
  };
  return {
    relaunches: () => relaunches,
    elapsed: () => now,
    async run(until = 121_000) {
      await advance(until);
      assert.equal(settled, true, 'a stall without progress must not consume the walk budget');
      return result;
    },
    async waiting(until = 160_000) {
      await advance(until);
      assert.equal(settled, false, 'a stall with a requested bundle keeps the walk budget');
    },
  };
}

for (const [name, bundleRequested, state] of [
  ['a received bundle request', async () => true, 'received'],
  ['an unknown signal', async () => undefined, 'unknown'],
  ['an absent signal', undefined, 'unknown'],
  [
    'an unreadable signal',
    async () => {
      throw new Error('unreadable');
    },
    'probe_failed',
  ],
] as const) {
  test(`a live app without a target and ${name} keeps the walk budget`, async (t) => {
    const facts: Array<Record<string, unknown>> = [];
    const fixture = stalled(t, {
      bundleRequested,
      observe: (_decision, observed) => void facts.push({ ...observed }),
    });
    await fixture.waiting();
    assert.equal(fixture.relaunches(), 0);
    assert.equal(facts.at(-1)?.bundleRequest, state);
  });
}

function refusedAt(error: { meta: AdmissionRefusalFacts }) {
  assert.equal(error.meta.lastStarted, 'attach');
  assert.equal(
    admissionMetric('refused', error.meta, 'wait_targets', 0).attachStage,
    'wait_targets',
  );
}

test('no bundle request since launch refuses at the attach budget after the one relaunch', async (t) => {
  const fixture = stalled(t, { bundleRequested: async () => false });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.match(error.message, /observed attach: target_readiness_timeout/);
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.equal(error.meta.relaunches, 1);
  assert.equal(error.meta.budgetMs, 1_199_000);
  assert.ok(fixture.elapsed() >= 120_000);
  refusedAt(error);
});

test('an app that dies after its relaunch refuses despite its bundle request', async (t) => {
  let relaunched = false;
  const fixture = stalled(t, {
    appAlive: async () => !relaunched,
    bundleRequested: async () => relaunched,
    relaunch: async () => {
      relaunched = true;
    },
  });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.relaunches, 1);
  refusedAt(error);
});

test('the attach budget is the configured one', async (t) => {
  const fixture = stalled(t, { attachBudgetMs: 60_000, bundleRequested: async () => false });
  const error = await fixture.run(61_000);
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.ok(fixture.elapsed() >= 60_000);
});

test('a bundle request after the one relaunch keeps the walk budget', async (t) => {
  let relaunched = false;
  const fixture = stalled(t, {
    bundleRequested: async () => relaunched,
    relaunch: async () => {
      relaunched = true;
    },
  });
  await fixture.waiting();
  assert.equal(relaunched, true);
});

for (const [name, error, inner, relaunches] of [
  ['an empty list', new TargetReadinessTimeoutError('no target', 'empty'), 'target_list_empty', 1],
  [
    'another device',
    new TargetReadinessTimeoutError('no target', 'other_device'),
    'target_other_device',
    1,
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
] as const) {
  test(`${name} without a bundle request cannot extend admission to the walk deadline`, async (t) => {
    const fixture = stalled(t, {
      attach: async () => {
        throw error;
      },
      bundleRequested: async () => false,
    });
    const refused = await fixture.run();
    assert.equal(refused.code, 'CDP_NOT_CONNECTED');
    assert.equal(refused.meta.inner, inner);
    assert.equal(fixture.relaunches(), relaunches);
    refusedAt(refused);
  });
}

for (const [name, attach, relaunches] of [
  [
    'a silent probe',
    async () => {
      throw new CDPProbeTimeoutError('probe timed out');
    },
    1,
  ],
  [
    'a silent handshake',
    async () => {
      throw new CDPHandshakeTimeoutError('handshake timed out');
    },
    1,
  ],
  [
    'a closed target',
    async () => {
      throw new CDPTargetClosedError('target closed');
    },
    0,
  ],
  [
    'an unanswered request',
    async () => {
      throw new CDPRequestTimeoutError('Runtime.evaluate timed out');
    },
    0,
  ],
  ['a never-settling attach', () => new Promise<void>(() => undefined), 0],
] as const) {
  test(`${name} against a registered target keeps the walk budget`, async (t) => {
    const fixture = stalled(t, { attach, bundleRequested: undefined });
    await fixture.waiting();
    assert.equal(fixture.relaunches(), relaunches);
  });
}

test('React that never becomes ready keeps the walk budget without a no-target relaunch', async (t) => {
  const fixture = stalled(t, {
    attach: async () => undefined,
    bundleReady: () => new Promise(() => undefined),
    bundleRequested: undefined,
  });
  await fixture.waiting();
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

test('a platform without a relaunch adapter still refuses a stall at the attach budget', async (t) => {
  const fixture = stalled(t, { relaunch: undefined, bundleRequested: async () => false });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.relaunches, 0);
});
