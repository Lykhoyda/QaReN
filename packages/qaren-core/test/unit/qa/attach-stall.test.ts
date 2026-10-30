import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  admissionMetric,
  admit,
  awaitDevClientManifest,
  launchBundleRequests,
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
import { sleep } from '../../../dist/domain/cancellation.js';
import { createTimingObserver, type RecordedTimingEvent } from '../../../dist/qa/timing.js';

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

for (const [name, atRelaunch, afterRelaunch, expected] of [
  ['makes no request of its own refuses at the attach budget', '1', '1', 'refused'],
  ['requests its bundle keeps the walk budget', '1', '2', 'waiting'],
  ['cannot rebase an unreadable request count keeps the walk budget', 'gone', '1', 'waiting'],
] as const) {
  test(`a relaunched app that ${name}`, async (t) => {
    let count = '1';
    let probes = 0;
    let relaunched = false;
    const requests = launchBundleRequests(
      { path: '/run/logs/metro.bundle-requests', atLaunch: 0 },
      () => count,
    );
    const fixture = stalled(t, {
      appAlive: async () => ++probes === 1 || relaunched,
      bundleRequested: async () => requests.requested(),
      relaunch: async () => {
        count = atRelaunch;
        requests.relaunching();
        relaunched = true;
        count = afterRelaunch;
      },
    });
    if (expected === 'waiting') {
      await fixture.waiting();
      assert.equal(relaunched, true);
      return;
    }
    const error = await fixture.run();
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.equal(error.meta.bundleRequest, 'not_received');
    assert.equal(error.meta.liveness, 'alive');
    assert.equal(error.meta.relaunches, 1);
    assert.ok(fixture.elapsed() >= 120_000);
    refusedAt(error);
  });
}

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

const proven = async () => ({
  ok: true as const,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
});

test('a dev client left on its launcher is relaunched once Metro answers its manifest and then loads', async (t) => {
  const deadlines: number[] = [];
  const fixture = stalled(t, {
    attach: async () => {
      if (deadlines.length === 0) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    bundleRequested: async () => false,
    relaunch: async (deadline) => void deadlines.push(deadline),
    open: async () => undefined,
    prove: proven,
  });
  assert.equal((await fixture.run()).ok, true);
  assert.deepEqual(deadlines, [120_000]);
});

test('a relaunched dev client that boots slowly is never terminated again', async (t) => {
  let relaunches = 0;
  const fixture = stalled(t, {
    attach: async () => {
      if (performance.now() < 100_000) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    bundleRequested: async () => performance.now() >= 70_000,
    relaunch: async () => void relaunches++,
    open: async () => undefined,
    prove: proven,
  });
  assert.equal((await fixture.run()).ok, true);
  assert.equal(relaunches, 1);
});

test('a first relaunch after the attach budget still gets a readiness window to reach Metro', async (t) => {
  const deadlines: number[] = [];
  const fixture = stalled(t, {
    appAlive: async () => performance.now() < 150_000,
    relaunch: async (deadline) => void deadlines.push(deadline),
  });
  const error = await fixture.run(200_000);
  assert.equal(error.meta.liveness, 'dead');
  assert.deepEqual(deadlines, [180_000]);
});

async function metro(t: TestContext, answer: RequestListener): Promise<string> {
  const server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/?disableOnboarding=1`;
}

test('a relaunch waits for two consecutive manifest answers inside half the dev client request timeout', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const seen: unknown[] = [];
  // 7 s fits the dev client's 10 s limit but not the 5 s margin, so it restarts the streak.
  const answers = [12_000, 1_000, 7_000, 1_000, 1_000];
  const url = await metro(t, (req, res) => {
    seen.push([req.method, req.url, req.headers['expo-platform'], req.headers.accept]);
    clock += answers[seen.length - 1]!;
    res.end('{}');
  });
  assert.deepEqual(await awaitDevClientManifest(url, 60_000), { ms: 1_000, attempts: 5 });
  const request = ['GET', '/?disableOnboarding=1', 'ios', 'application/expo+json,application/json'];
  assert.deepEqual(seen, Array(5).fill(request));
});

test('a manifest slower than the dev client timeout until the deadline fails the relaunch', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const url = await metro(t, (_req, res) => {
    clock += 12_000;
    res.end('{}');
  });
  await assert.rejects(
    awaitDevClientManifest(url, 30_000),
    /never answered 2 times in a row inside 5s, half the dev client's 10s request timeout: last 12000 ms after 3 attempts/,
  );
});

test('an unanswered manifest request ends at the deadline', async (t) => {
  const url = await metro(t, () => undefined);
  await assert.rejects(
    awaitDevClientManifest(url, performance.now() + 100),
    /never answered 2 times in a row inside 5s, half the dev client's 10s request timeout: last \d+ ms after \d+ attempts/,
  );
});

test('a manifest error or an unreachable Metro fails the relaunch at once', async (t) => {
  let requests = 0;
  const url = await metro(t, (_req, res) => {
    requests++;
    res.statusCode = 500;
    res.end();
  });
  await assert.rejects(
    awaitDevClientManifest(url, performance.now() + 60_000),
    /answered HTTP 500/,
  );
  assert.equal(requests, 1);
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  await assert.rejects(
    awaitDevClientManifest(`http://127.0.0.1:${port}/`, performance.now() + 60_000),
    /dev client manifest request failed/,
  );
});

function patient(
  t: TestContext,
  overrides: Partial<AdmissionSteps> = {},
  durations = [15_000, 15_000, 1_000, 1_000],
) {
  const receipt: RecordedTimingEvent[] = [];
  const timing = createTimingObserver((event) => receipt.push(event));
  let requests = 0;
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    await sleep(durations[Math.min(requests++, durations.length - 1)]!);
    return new Response('{}');
  });
  const fixture = stalled(t, {
    attach: async () => {
      if (launches === 0) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    bundleRequested: async () => false,
    manifest: (deadline, retry) =>
      awaitDevClientManifest('http://127.0.0.1:8081/', deadline, retry),
    relaunch: async () => {
      launches++;
    },
    open: async () => undefined,
    prove: proven,
    timing,
    ...overrides,
  });
  return { ...fixture, receipt, launches: () => launches, requests: () => requests };
}

test('patient warming recovers transient slow QaReN manifest probes and records every attempt', async (t) => {
  const fixture = patient(t);
  assert.equal((await fixture.run()).ok, true);
  assert.equal(fixture.launches(), 1);
  assert.ok(fixture.elapsed() < 100_000);
  const probes = fixture.receipt.filter((event) => event.stage === 'manifest-probe');
  assert.equal(probes.length, fixture.requests());
  assert.deepEqual(
    probes.map((event) => [event.ms, event.outcome, event.method]),
    [
      [10_000, 'failed', 'timeout'],
      [10_000, 'failed', 'timeout'],
      [1_000, 'ok', 'unknown'],
      [1_000, 'ok', 'unknown'],
    ],
  );
  assert.deepEqual(
    probes.map((event) => event.at),
    [10_000, 21_000, 24_000, 29_000],
  );
  assert.deepEqual(
    fixture.receipt
      .filter((event) => event.stage === 'dev-client-relaunch')
      .map((event) => [event.relaunch, event.ms]),
    [['ready', 0]],
  );
});

test('persistent slow QaReN probes refuse after one bounded patient window with timings', async (t) => {
  const fixture = patient(t, {}, [15_000]);
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(fixture.elapsed(), 100_000);
  assert.equal(fixture.launches(), 0);
  assert.match(error.message, /host contention is the likely cause; QaReN manifest probes 10000, /);
  assert.doesNotMatch(error.message, /the dev client's manifest request outlasted/);
  assert.equal(
    fixture.receipt.filter((event) => event.stage === 'manifest-probe').length,
    fixture.requests(),
  );
  assert.ok(fixture.receipt.every((event) => event.at <= 100_000));
});

test('patient warming and relaunches cannot overrun the remaining run budget', async (t) => {
  const fixture = patient(t, { remainingMs: () => 40_000 - performance.now() }, [15_000]);
  const error = await fixture.run(41_000);
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(fixture.elapsed(), 40_000);
  assert.equal(fixture.launches(), 0);
  assert.match(error.message, /host contention is the likely cause/);
  assert.ok(fixture.receipt.every((event) => event.at <= 40_000));
});

test('only the slow-probe proxy permits two additional relaunches', async (t) => {
  let relaunches = 0;
  const fixture = patient(t, {
    attach: async () => {
      if (relaunches < 3) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    relaunch: async () => {
      relaunches++;
    },
  });
  assert.equal((await fixture.run()).ok, true);
  const launches = fixture.receipt.filter((event) => event.stage === 'dev-client-relaunch');
  assert.equal(relaunches, 3);
  assert.equal(launches.length, 3);
  assert.deepEqual(
    launches.map((event) => event.count),
    [1, 2, 3],
  );
});

test('patient recovery stops after its two additional relaunches when no target appears', async (t) => {
  const fixture = patient(t, {
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target', 'empty');
    },
  });
  const error = await fixture.run(200_000);
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(fixture.launches(), 3);
  assert.equal(error.meta.relaunches, 3);
  assert.ok(fixture.elapsed() <= 120_000 + 3 * 30_000);
});

test('a bundle request arriving during patient warming prevents another relaunch', async (t) => {
  const fixture = patient(t, {
    attach: async () => {
      if (performance.now() < 20_000) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    bundleRequested: async () => performance.now() >= 20_000,
  });
  assert.equal((await fixture.run()).ok, true);
  assert.equal(fixture.launches(), 0);
});

test('a requested bundle with no CDP target never enters patient warming', async (t) => {
  const fixture = patient(t, {
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    bundleRequested: async () => true,
  });
  await fixture.waiting();
  assert.equal(fixture.requests(), 0);
  assert.equal(fixture.launches(), 0);
});

test('fast manifest probes retain the single relaunch and original attach deadline', async (t) => {
  const fixture = patient(
    t,
    {
      attach: async () => {
        throw new TargetReadinessTimeoutError('no target', 'empty');
      },
    },
    [1_000],
  );
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(fixture.launches(), 1);
  assert.equal(fixture.elapsed(), 120_000);
  assert.doesNotMatch(error.message, /host contention/);
});

for (const [name, state, alive] of [
  ['a dead app', 'empty', false],
  ['another device', 'other_device', true],
  ['an unclassified target wait', undefined, true],
] as const) {
  test(`slow manifest probes for ${name} do not activate patient recovery`, async (t) => {
    const fixture = patient(
      t,
      {
        attach: async () => {
          throw new TargetReadinessTimeoutError('no target', state);
        },
        appAlive: async () => alive,
      },
      [15_000],
    );
    const error = await fixture.run();
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.equal(fixture.elapsed(), 120_000);
    assert.equal(fixture.launches(), 0);
    assert.doesNotMatch(error.message, /host contention/);
    assert.ok(
      fixture.receipt
        .filter((event) => event.stage === 'manifest-probe')
        .every((event) => event.ms === 15_000),
    );
  });
}

test('a slow HTTP failure is not evidence for patient manifest recovery', async (t) => {
  const fixture = patient(t);
  t.mock.method(globalThis, 'fetch', async () => {
    await sleep(9_000);
    return new Response('', { status: 500 });
  });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.match(error.message, /manifest answered HTTP 500/);
  assert.doesNotMatch(error.message, /host contention/);
  assert.equal(fixture.launches(), 0);
  assert.equal(fixture.receipt.filter((event) => event.stage === 'manifest-probe').length, 1);
});

test('an app that dies during patient warming is not relaunched', async (t) => {
  const fixture = patient(t, {
    appAlive: async () => performance.now() < 20_000,
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target', 'empty');
    },
  });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.relaunches, 0);
  assert.equal(fixture.launches(), 0);
});

test('a relaunch still running at the run deadline is cancelled within that budget', async (t) => {
  const fixture = patient(t, {
    remainingMs: () => 50_000 - performance.now(),
    relaunch: async () => {
      await sleep(60_000);
    },
  });
  const error = await fixture.run(51_000);
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(fixture.elapsed(), 50_000);
  assert.deepEqual(
    fixture.receipt
      .filter((event) => event.stage === 'dev-client-relaunch')
      .map((event) => [event.at, event.ms, event.outcome]),
    [[50_000, 21_000, 'failed']],
  );
});

for (const [name, requested] of [
  ['received', async () => true],
  ['unknown', async () => undefined],
  [
    'unreadable',
    async () => {
      throw new Error('unreadable');
    },
  ],
] as const) {
  test(`failed patient warming resumes attachment with a ${name} bundle signal`, async (t) => {
    const facts: AdmissionRefusalFacts[] = [];
    const fixture = patient(
      t,
      {
        attach: async () => {
          if (performance.now() < 40_000)
            throw new TargetReadinessTimeoutError('no target', 'empty');
        },
        bundleRequested: async () => (performance.now() < 40_000 ? false : requested()),
        observe: (_decision, fact) => facts.push(fact),
      },
      [15_000],
    );
    assert.equal((await fixture.run()).ok, true);
    assert.equal(fixture.elapsed(), 100_500);
    assert.equal(fixture.launches(), 0);
    assert.equal(facts.at(-1)?.relaunches, 0);
    assert.equal(facts.at(-1)?.relaunchFailed, false);
    assert.equal(
      fixture.receipt.filter((event) => event.stage === 'dev-client-relaunch').length,
      0,
    );
  });
}

for (const durations of [[15_000, 15_000, 1_000, 1_000], [15_000]]) {
  test(`patient rechecks preserve foreign-driver authority with probe durations ${durations}`, async (t) => {
    let checks = 0;
    const fixture = patient(
      t,
      {
        foreignDriver: async () => (++checks === 1 ? undefined : 'foreign driver active'),
      },
      durations,
    );
    const error = await fixture.run();
    assert.equal(error.code, 'BUSY_FOREIGN_FLOW');
    assert.equal(error.message, 'foreign driver active');
    assert.equal(fixture.launches(), 0);
  });
}

test('a skipped successful patient warm-up records no relaunch', async (t) => {
  const facts: AdmissionRefusalFacts[] = [];
  const fixture = patient(t, {
    attach: async () => {
      if (performance.now() < 20_000) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    bundleRequested: async () => performance.now() >= 20_000,
    observe: (_decision, fact) => facts.push(fact),
  });
  assert.equal((await fixture.run()).ok, true);
  assert.equal(facts.at(-1)?.relaunches, 0);
  assert.equal(fixture.launches(), 0);
});

test('an attempted failed patient relaunch still counts and records its duration', async (t) => {
  const fixture = patient(t, {
    relaunch: async () => {
      await sleep(1_000);
      throw new Error('launch failed');
    },
  });
  const error = await fixture.run();
  assert.equal(error.meta.relaunches, 1);
  assert.equal(error.meta.relaunchFailed, true);
  assert.deepEqual(
    fixture.receipt
      .filter((event) => event.stage === 'dev-client-relaunch')
      .map((event) => [event.count, event.ms, event.outcome]),
    [[1, 1_000, 'failed']],
  );
});

test('a nearly expired patient window still allows the next warm-up readiness window', async (t) => {
  let warms = 0;
  let launches = 0;
  const fixture = patient(
    t,
    {
      attach: async () => {
        if (launches < 2) throw new TargetReadinessTimeoutError('no target', 'empty');
      },
      manifest: async (deadline, retry) => {
        if (++warms === 1) {
          await sleep(10_000);
          retry.observe({ ms: 10_000, outcome: 'timeout' });
          await sleep(57_500);
          return { ms: 1_000, attempts: 3 };
        }
        assert.equal(performance.now(), 97_500);
        assert.equal(deadline, 127_500);
        return awaitDevClientManifest('http://127.0.0.1:8081/', deadline, retry);
      },
      relaunch: async () => {
        launches++;
      },
    },
    [1_000],
  );
  assert.equal((await fixture.run(150_000)).ok, true);
  assert.equal(launches, 2);
});

test('patient refusal does not wait for a relaunch that lacks a readiness budget', async (t) => {
  const fixture = patient(t, {
    attachBudgetMs: 60_000,
    remainingMs: () => 110_000 - performance.now(),
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target', 'empty');
    },
  });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.relaunches, 2);
  assert.equal(fixture.elapsed(), 92_000);
});

test('patient relaunch receives a fresh deadline capped by the current run budget', async (t) => {
  let warms = 0;
  let launches = 0;
  const deadlines: number[][] = [];
  const fixture = patient(t, {
    remainingMs: () => 110_000 - performance.now(),
    attach: async () => {
      if (launches < 2) throw new TargetReadinessTimeoutError('no target', 'empty');
    },
    manifest: async (_deadline, retry) => {
      if (++warms === 1) {
        await sleep(10_000);
        retry.observe({ ms: 10_000, outcome: 'timeout' });
        await sleep(19_000);
      } else {
        await sleep(36_000);
      }
      return { ms: 1_000, attempts: 3 };
    },
    relaunch: async (deadline) => {
      deadlines.push([performance.now(), deadline]);
      launches++;
    },
  });
  assert.equal((await fixture.run()).ok, true);
  assert.deepEqual(deadlines, [
    [29_000, 110_000],
    [95_000, 110_000],
  ]);
});

test('an opened session cannot retain the patient relaunch refusal exemption', async (t) => {
  let launched = false;
  let attached = false;
  const fixture = patient(t, {
    attachBudgetMs: 60_000,
    attach: async () => {
      if (!launched || attached) throw new TargetReadinessTimeoutError('no target', 'empty');
      attached = true;
    },
    relaunch: async () => {
      launched = true;
    },
    prove: async () => {
      throw new CDPProbeTimeoutError('runtime unavailable');
    },
  });
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.relaunches, 1);
  assert.equal(fixture.elapsed(), 60_000);
});
