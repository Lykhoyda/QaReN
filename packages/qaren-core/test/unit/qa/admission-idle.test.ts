import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  admit,
  formatAdmissionRefusal,
  launchBundleRequests,
  type AdmissionSteps,
  type BundleBuilt,
} from '../../../dist/qa/admission.js';
import { cleanAdmissionFacts } from '../../../dist/qa/admission-facts.js';
import { cleanTimingEvent } from '../../../dist/qa/timing.js';
import { TargetReadinessTimeoutError } from '../../../dist/cdp/discovery.js';
import { DevTargetUnavailableError } from '../../../dist/cdp/connect.js';
import { createStop } from '../../../dist/qa/stop.js';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;
const UNDEFINED = { targetsTotal: 1, devTrue: 0, devFalse: 0, devUndefined: 1, devUnknown: 0 };

type Scan = 'undefined' | 'true' | 'incomplete' | 'unknown' | 'mixed' | 'empty';

// One advertised page; `scan(now)` decides what each connect_exact attempt observes.
function idle(
  t: TestContext,
  scan: (now: number) => Scan,
  overrides: Partial<AdmissionSteps> = {},
) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  const stop = createStop();
  const state = {
    candidates: 'device-1',
    requests: 1 as number | undefined,
    built: 'none' as BundleBuilt,
    launchedAt: [] as number[],
    warmings: 0,
    opened: 0,
  };
  let settled = false;
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    attachBudgetMs: 300_000,
    remainingMs: () => 1_199_000 - now,
    attach: async () => {
      const observed = scan(now);
      if (observed === 'true') return;
      if (observed === 'empty') throw new TargetReadinessTimeoutError('no target', 'empty');
      if (observed === 'incomplete')
        throw new DevTargetUnavailableError(UNDEFINED, false, state.candidates);
      if (observed === 'unknown')
        throw new DevTargetUnavailableError(
          { ...UNDEFINED, devUndefined: 0, devUnknown: 1 },
          true,
          state.candidates,
        );
      if (observed === 'mixed')
        throw new DevTargetUnavailableError(
          { ...UNDEFINED, targetsTotal: 2, devFalse: 1 },
          true,
          state.candidates,
        );
      throw new DevTargetUnavailableError(UNDEFINED, true, state.candidates);
    },
    appAlive: async () => true,
    bundleRequested: async () => false,
    bundleRequestCount: () => state.requests,
    bundleBuilt: () => state.built,
    pages: () => ({ foreignPages: 1, sameNameDevices: 1 }),
    manifest: async () => {
      state.warmings++;
      return { ms: 100, attempts: 2 };
    },
    relaunch: async () => {
      state.launchedAt.push(now);
    },
    foreignDriver: async () => undefined,
    open: async () => {
      state.opened++;
    },
    prove: async () => PROVEN,
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
    state,
    elapsed: () => now,
    async run(until = 400_000) {
      await nextTurn();
      while (!settled && now < until) {
        now += 500;
        t.mock.timers.tick(500);
        await nextTurn();
      }
      assert.equal(settled, true, 'admission must settle');
      return result;
    },
  };
}

test('a page that never proves development mode relaunches once, then refuses as an unproven runtime', async (t) => {
  const fixture = idle(t, () => 'undefined');
  const error = await fixture.run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(fixture.state.launchedAt.length, 1);
  assert.equal(fixture.state.warmings, 1);
  assert.ok(fixture.state.launchedAt[0]! >= 60_000 && fixture.state.launchedAt[0]! < 61_000);
  assert.ok(fixture.elapsed() >= 120_000 && fixture.elapsed() < 122_000, `${fixture.elapsed()}`);
  assert.ok(fixture.elapsed() < 300_000, 'refuses before the attach deadline');
  assert.equal(fixture.state.opened, 0);
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.equal(error.meta.relaunches, 1);
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.equal(error.meta.bundleBuilt, 'none');
  assert.equal(error.meta.foreignPages, 1);
  assert.equal(error.meta.sameNameDevices, 1);
  assert.equal(error.meta.devUndefined, 1);
  assert.match(
    error.message,
    /^the app's page on port 8081 never proved development mode before the attach deadline; bundle request on the port: not received; bundle completion on the port: none; pages from 1 other device\(s\) are advertised on this Metro port; give each lane its own metroPort and its own simulator name$/,
  );
});

for (const broken of ['incomplete', 'unknown'] as const) {
  test(`an ${broken} scan restarts the idle clock`, async (t) => {
    let brokeAt: number | undefined;
    const fixture = idle(t, (now) => {
      if (now >= 40_000 && brokeAt === undefined) {
        brokeAt = now;
        return broken;
      }
      return 'undefined';
    });
    const error = await fixture.run();
    assert.equal(error.meta.inner, 'dev_runtime_unproven');
    assert.ok(
      fixture.state.launchedAt[0]! >= brokeAt! + 60_000,
      `relaunched at ${fixture.state.launchedAt[0]} after a break at ${brokeAt}`,
    );
  });
}

test('an idle relaunch keeps the patient empty-list relaunch available under the shared cap', async (t) => {
  let launches = 0;
  const fixture = idle(
    t,
    () => (launches === 0 ? 'undefined' : launches === 1 ? 'empty' : 'true'),
    {
      relaunch: async () => {
        launches++;
      },
    },
  );
  assert.deepEqual(await fixture.run(), PROVEN);
  assert.equal(launches, 2, 'the empty list after an idle relaunch still relaunches once');
});

test('a bundle request received before idle began does not extend the window', async (t) => {
  const fixture = idle(t, () => 'undefined', { bundleRequested: async () => true });
  fixture.state.requests = 3;
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.ok(fixture.state.launchedAt[0]! < 61_000);
  assert.equal(error.meta.bundleRequest, 'received');
});

test('a bundle request inside the window extends it once', async (t) => {
  const fixture = idle(t, (now) => {
    if (now >= 30_000) fixture.state.requests = 2;
    return 'undefined';
  });
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.equal(fixture.state.launchedAt.length, 1);
  assert.ok(fixture.state.launchedAt[0]! >= 120_000, `${fixture.state.launchedAt[0]}`);
});

for (const progress of ['request', 'completion'] as const) {
  test(`a late bundle ${progress} cannot extend the post-relaunch idle window`, async (t) => {
    const fixture = idle(t, (now) => {
      if (now >= 90_000) {
        if (progress === 'request') fixture.state.requests = 2;
        else fixture.state.built = 'completed';
      }
      return 'undefined';
    });
    const error = await fixture.run();
    assert.equal(error.meta.inner, 'dev_runtime_unproven');
    assert.equal(fixture.state.launchedAt.length, 1);
    assert.ok(fixture.elapsed() >= 120_000 && fixture.elapsed() < 122_000);
  });
}

for (const stalled of ['appAlive', 'foreignDriver', 'manifest', 'relaunch'] as const) {
  test(`idle recovery bounds a stalled ${stalled} by the attach deadline`, async (t) => {
    const fixture = idle(t, () => 'undefined', {
      attachBudgetMs: 120_000,
      [stalled]: () => new Promise<never>(() => {}),
    });
    const error = await fixture.run();
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.equal(error.meta.inner, 'dev_runtime_unproven');
    assert.ok(fixture.elapsed() >= 120_000 && fixture.elapsed() <= 120_500);
    assert.equal(fixture.state.opened, 0);
  });
}

test('manifest warm-up and relaunch share the remaining attach budget', async (t) => {
  const fixture = idle(t, () => 'undefined', {
    attachBudgetMs: 120_000,
    manifest: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 45_000));
      return { ms: 45_000, attempts: 1 };
    },
    relaunch: async () => {
      fixture.state.launchedAt.push(performance.now());
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
    },
  });
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.equal(fixture.state.launchedAt.length, 1);
  assert.ok(fixture.state.launchedAt[0]! >= 105_000);
  assert.ok(fixture.elapsed() >= 120_000 && fixture.elapsed() <= 120_500);
});

test('a page that proves development mode before the window ends is admitted without a relaunch', async (t) => {
  const fixture = idle(t, (now) => (now < 20_000 ? 'undefined' : 'true'));
  assert.deepEqual(await fixture.run(), PROVEN);
  assert.equal(fixture.state.launchedAt.length, 0);
});

test('a completed bundle extends the window once and a later proof admits without a relaunch', async (t) => {
  const fixture = idle(t, (now) => {
    if (now >= 50_000) fixture.state.built = 'completed';
    return now < 100_000 ? 'undefined' : 'true';
  });
  assert.deepEqual(await fixture.run(), PROVEN);
  assert.equal(fixture.state.launchedAt.length, 0);
  assert.equal(fixture.state.warmings, 0);
});

for (const mixed of ['mixed', 'incomplete'] as const) {
  test(`${mixed} scans never enter idle and keep today's refusal`, async (t) => {
    const fixture = idle(t, () => mixed, { attachBudgetMs: 150_000 });
    const error = await fixture.run();
    assert.equal(error.meta.inner, 'no_dev_target_unknown');
    assert.equal(fixture.state.launchedAt.length, 0);
    assert.ok(fixture.elapsed() >= 150_000);
  });
}

test('a replaced candidate restarts the idle clock', async (t) => {
  const fixture = idle(t, (now) => {
    if (now >= 40_000) fixture.state.candidates = 'device-2';
    return 'undefined';
  });
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.ok(fixture.state.launchedAt[0]! >= 100_000, `${fixture.state.launchedAt[0]}`);
});

test('a remaining budget too small for a relaunch waits for the deadline and never relaunches', async (t) => {
  const fixture = idle(t, () => 'undefined', { remainingMs: () => 70_000 - performance.now() });
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.equal(fixture.state.launchedAt.length, 0);
  assert.ok(fixture.elapsed() >= 69_000 && fixture.elapsed() <= 70_000, `${fixture.elapsed()}`);
});

test('without a relaunch step an idle page refuses only at the attach deadline', async (t) => {
  const fixture = idle(t, () => 'undefined', { relaunch: undefined, attachBudgetMs: 150_000 });
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.ok(fixture.elapsed() >= 150_000 && fixture.elapsed() <= 151_000, `${fixture.elapsed()}`);
});

test('an idle deadline reports a bundle completion after the extension decision', async (t) => {
  const fixture = idle(
    t,
    (now) => {
      if (now >= 30_000) fixture.state.requests = 2;
      if (now >= 90_000) fixture.state.built = 'completed';
      return 'undefined';
    },
    { attachBudgetMs: 120_000, bundleRequested: async () => true },
  );
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.equal(error.meta.bundleBuilt, 'completed');
  assert.match(error.message, /bundle completion on the port: completed/);
  assert.equal(fixture.state.launchedAt.length, 0);
});

test('an idle deadline reports a request received after a no-relaunch decision', async (t) => {
  const fixture = idle(t, () => 'undefined', {
    remainingMs: () => 70_000 - performance.now(),
    bundleRequested: async () => performance.now() >= 65_000,
  });
  const error = await fixture.run();
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.equal(error.meta.bundleRequest, 'received');
  assert.match(error.message, /bundle request on the port: received/);
  assert.equal(fixture.state.launchedAt.length, 0);
});

function files(contents: Record<string, string>) {
  return (path: string) => {
    const text = contents[path];
    if (text === undefined) throw new Error('ENOENT');
    return text;
  };
}

test('bundle outcomes are read against the launch baseline and rebased on relaunch', () => {
  const contents: Record<string, string> = { '/r': '4\n', '/o': '2 1\n' };
  const signal = {
    path: '/r',
    atLaunch: 4,
    outcomesPath: '/o',
    completedAtLaunch: 1,
    failedAtLaunch: 1,
  };
  const counts = launchBundleRequests(signal, files(contents));
  // A completion between launch and core start-up counts through the CLI's baseline.
  assert.equal(counts.built(), 'completed');
  assert.equal(counts.count(), 4);
  contents['/r'] = '5\n';
  assert.equal(counts.requested(), true);
  counts.relaunching();
  assert.equal(counts.requested(), false, 'the request baseline rebases with the outcomes');
  assert.equal(counts.built(), 'none');
  contents['/o'] = '2 2\n';
  assert.equal(counts.built(), 'failed');
  contents['/o'] = '3 2\n';
  assert.equal(counts.built(), 'completed');
  contents['/o'] = '0 0\n';
  assert.equal(counts.built(), 'unknown', 'a count below its baseline is unknown');
  delete contents['/o'];
  assert.equal(counts.built(), 'unknown', 'an absent counter is unknown');
});

test('the new admission facts pass every allowlist and malformed values are rejected', () => {
  const facts = {
    attempt: 3,
    lastStarted: 'attach',
    lastCompleted: 'relaunch',
    inner: 'dev_runtime_unproven',
    relaunches: 1,
    relaunchFailed: false,
    liveness: 'alive',
    bundleRequest: 'received',
    bundleBuilt: 'failed',
    elapsedMs: 120_000,
    remainingMs: 1,
    budgetMs: 2,
    foreignPages: 2,
    sameNameDevices: 1,
  };
  const record = JSON.parse(formatAdmissionRefusal(facts));
  assert.equal(record.inner, 'dev_runtime_unproven');
  assert.equal(record.bundleBuilt, 'failed');
  assert.equal(record.foreignPages, 2);
  assert.equal(record.sameNameDevices, 1);
  assert.equal(
    JSON.parse(formatAdmissionRefusal({ ...facts, bundleBuilt: 'PRIVATE' })).bundleBuilt,
    'unknown',
  );
  assert.deepEqual(cleanAdmissionFacts(facts), facts);
  const event = {
    stage: 'admission',
    edge: 'point',
    outcome: 'failed',
    at: 0,
    admission: 'refused',
    ...facts,
  };
  assert.equal(cleanTimingEvent(event)?.bundleBuilt, 'failed');
  for (const [key, value] of [
    ['bundleBuilt', 'PRIVATE'],
    ['foreignPages', 1.5],
    ['sameNameDevices', -1],
  ] as const)
    assert.equal(cleanTimingEvent({ ...event, [key]: value }), undefined, key);
});

test('a request signal without outcomes reports bundle outcomes unknown', () => {
  const counts = launchBundleRequests({ path: '/r', atLaunch: 0 }, files({ '/r': '1\n' }));
  assert.equal(counts.built(), 'unknown');
  assert.equal(counts.requested(), true);
});
