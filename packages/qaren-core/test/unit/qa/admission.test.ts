import { interruptible, withCancellation } from '../../../dist/domain/cancellation.js';
import { createStop } from '../../../dist/qa/stop.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { createWriter } from '../../../dist/qa/wire.js';
import { getEventListeners } from 'node:events';
import {
  TargetReadinessTimeoutError,
  TargetSelectionError,
  cachedPackageProbe,
  inferPlatforms,
  clearPackageProbeCache,
} from '../../../dist/cdp/discovery.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admissionMetric,
  admit,
  awaitBundleReady,
  bundleRequestedSinceLaunch,
  createBundleReload,
  devClientLaunchUrl,
  formatAdmissionRefusal,
  logAdmissionRefusal,
  metroDevicePin,
  type AdmissionDecision,
  type AdmissionSteps,
} from '../../../dist/qa/admission.js';
import { cleanTimingEvent } from '../../../dist/qa/timing.js';
import { REACT_READY_PROBE_JS } from '../../../dist/injected-helpers.js';
import { HandlerError } from '../../../dist/qa/adapt.js';
import { buildIosRelaunchArgv } from '../../../dist/handlers/app-lifecycle.js';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  CDPProbeTimeoutError,
  CDPHandshakeTimeoutError,
  CDPTargetClosedError,
} from '../../../dist/cdp/connect.js';
import { CDPRequestTimeoutError, sendWithTimeout } from '../../../dist/cdp/transport.js';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;

test('bundle readiness returns socket loss to admission instead of polling a dead transport', async () => {
  await assert.rejects(
    awaitBundleReady(
      async () => {
        await sendWithTimeout(null, new Map(), () => 1, 'Runtime.evaluate', {}, 100);
        return {};
      },
      performance.now() + 20,
      1,
    ),
    CDPTargetClosedError,
  );
});

function harness(overrides: Partial<AdmissionSteps> = {}) {
  const calls: string[] = [];
  const stop = createStop();
  const step =
    <T>(name: string, result: () => T) =>
    async (): Promise<T> => {
      calls.push(name);
      return result();
    };
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    remainingMs: () => 90_000,
    attach: step('attach', () => undefined),
    foreignDriver: step('foreignDriver', () => undefined),
    open: step('open', () => undefined),
    prove: step('prove', () => PROVEN),
    close: async () => {
      calls.push('close');
    },
    load: () => 1,
    ...overrides,
  };
  return { calls, stop, steps };
}

test('admission runs connect, driver probe, session open and bundle proof in order', async () => {
  const { calls, stop, steps } = harness();
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.deepEqual(calls, ['attach', 'foreignDriver', 'open', 'prove']);
});

test('a stop raised before each setup effect runs neither that effect nor any later one', async () => {
  const order = ['attach', 'foreignDriver', 'open', 'prove'];
  for (const [index, effect] of order.entries()) {
    const { calls, stop, steps } = harness();
    const raise = order[index - 1];
    if (raise) {
      const original = steps[raise as 'attach'];
      steps[raise as 'attach'] = async () => {
        await original();
        stop.begin();
      };
    } else stop.begin();
    await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'RUN_CANCELLED');
      return true;
    });
    assert.ok(!calls.includes(effect), `${effect} ran after the stop: ${calls}`);
    assert.deepEqual(calls.slice(-1), ['close'], `${effect}: the session is closed`);
  }
});

test('a stop during the attach wait ends the wait instead of running to its timeout', async () => {
  const stop = createStop();
  const calls: string[] = [];
  const steps: AdmissionSteps = {
    ...harness().steps,
    attach: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stop.begin();
      throw new Error('the readiness wait was cancelled');
    },
    open: async () => void calls.push('open'),
    close: async () => void calls.push('close'),
  };
  const started = Date.now();
  await assert.rejects(admit(steps, stop), { code: 'RUN_CANCELLED' });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(calls, ['close']);
});

test('cancellation during the retry pause prevents another attach', async () => {
  const { CDPProbeTimeoutError } = await import('../../../dist/cdp/connect.js');
  const { calls, stop, steps } = harness();
  let attempts = 0;
  steps.attach = async () => {
    attempts++;
    setTimeout(() => stop.begin(), 20);
    throw new CDPProbeTimeoutError('JS is not ready yet');
  };
  await assert.rejects(admit(steps, stop), { code: 'RUN_CANCELLED' });
  assert.equal(attempts, 1);
  assert.deepEqual(calls, ['close']);
});

test('an exhausted attach deadline refuses with the diagnostic host load', async () => {
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 42.25,
    remainingMs: () => 20,
    attach: async () => {
      attempts++;
      throw new TargetReadinessTimeoutError(
        'Timed out waiting for CDP targets on port 8081 after 30000ms',
      );
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /Metro 8081/);
    assert.match(error.message, /1-minute load 42\.3/);
    assert.match(error.message, /deadline exceeded/);
    return true;
  });
  assert.equal(attempts, 1);
  assert.ok(!calls.includes('open'));
});

test('a deterministic attach failure is refused at once, with the load recorded', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      attempts++;
      throw new Error('no target');
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /1-minute load 3\.0/);
    assert.doesNotMatch(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('a retried attach that connects at low load continues the admission', async () => {
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('no target yet');
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['foreignDriver', 'open', 'prove']);
});

test('a failed bundle proof closes the session and refuses with its own code', async () => {
  const { calls, stop, steps } = harness({
    prove: async () => ({ ok: false, code: 'METRO_ORIGIN_MISMATCH', message: 'foreign bundle' }),
  });
  await assert.rejects(admit(steps, stop), { code: 'METRO_ORIGIN_MISMATCH' });
  assert.deepEqual(calls.slice(-1), ['close']);
});

test('a deterministic origin proof error keeps its original classification without a retry', async () => {
  const failure = new Error('invalid proof adapter metadata');
  const { calls, stop, steps } = harness({
    prove: async () => {
      throw failure;
    },
  });
  await assert.rejects(admit(steps, stop), (error) => error === failure);
  assert.deepEqual(calls, ['attach', 'foreignDriver', 'open', 'close']);
});

test('a socket lost before origin proof reattaches without reopening the admitted device session', async () => {
  let proofs = 0;
  const { calls, stop, steps } = harness({
    prove: async () => {
      if (++proofs === 1)
        await sendWithTimeout(null, new Map(), () => 1, 'Runtime.evaluate', {}, 100);
      return PROVEN;
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(proofs, 2);
  assert.deepEqual(calls, ['attach', 'foreignDriver', 'open', 'attach']);
});

test('repeated socket loss at origin proof cannot renew the admission deadline', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let proofs = 0;
  const deadlines: number[] = [];
  const { calls, stop, steps } = harness({
    remainingMs: () => 1_000 - now,
    attach: async (deadline) => {
      deadlines.push(deadline);
    },
    prove: async () => {
      now = ++proofs === 1 ? 100 : 1_000;
      await sendWithTimeout(null, new Map(), () => 1, 'Runtime.evaluate', {}, 100);
      return PROVEN;
    },
  });
  await assert.rejects(admit(steps, stop), { code: 'CDP_NOT_CONNECTED' });
  assert.equal(proofs, 2);
  assert.deepEqual(deadlines, [1_000, 1_000]);
  assert.deepEqual(calls, ['foreignDriver', 'open', 'close']);
});

test('a foreign automation driver refuses before the session opens', async () => {
  const { calls, stop, steps } = harness({ foreignDriver: async () => 'Maestro holds the device' });
  await assert.rejects(admit(steps, stop), { code: 'BUSY_FOREIGN_FLOW' });
  assert.ok(!calls.includes('open'));
});

test('cancellation during bundle proof refuses the proven result', async () => {
  const { calls, steps, stop } = harness();
  steps.prove = async () => {
    stop.begin();
    return PROVEN;
  };
  await assert.rejects(admit(steps, stop), { code: 'RUN_CANCELLED' });
  assert.equal(calls.at(-1), 'close');
});

test('a transient timeout can retry with less than a full readiness window remaining', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    remainingMs: () => 15_000,
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('readiness timeout');
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(attempts, 2);
});

test('a deterministic rejection under load is never retried or called environmental', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 42,
    attach: async () => {
      attempts++;
      throw new Error('PLATFORM_TARGET_NOT_FOUND: wrong app');
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error) => {
    assert.doesNotMatch(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('abort during each awaited admission primitive rejects before any later effect', async () => {
  const order = ['attach', 'foreignDriver', 'open', 'prove'] as const;
  for (const effect of order) {
    const { calls, stop, steps } = harness();
    const original = steps[effect];
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    steps[effect as 'attach'] = (async () => {
      ready();
      await interruptible(() => blocked);
      return original();
    }) as typeof steps.attach;
    const admitted = admit(steps, stop);
    const refused = assert.rejects(admitted, /RUN_CANCELLED/);
    await started;
    stop.begin();
    await refused;
    assert.deepEqual(calls, [...order.slice(0, order.indexOf(effect)), 'close']);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [...order.slice(0, order.indexOf(effect)), 'close']);
  }
});

test('handshake attempts share one deadline at low load', async () => {
  const { CDPHandshakeTimeoutError } = await import('../../../dist/cdp/connect.js');
  const deadlines: number[] = [];
  const { calls, stop, steps } = harness({
    load: () => 3,
    remainingMs: () => 1200,
    attach: async (deadline) => {
      deadlines.push(deadline);
      throw new CDPHandshakeTimeoutError('handshake timed out');
    },
  });
  await assert.rejects(admit(steps, stop), /CDP attach deadline exceeded/);
  assert.ok(deadlines.length >= 2);
  assert.equal(new Set(deadlines).size, 1, 'retry must not extend the deadline');
  assert.deepEqual(calls, ['close']);
});

for (const Timeout of [CDPProbeTimeoutError, CDPHandshakeTimeoutError]) {
  test(`a live no-target wait preserves subsequent ${Timeout.name} recovery`, async (t) => {
    let now = 10_000;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    syncBuiltinESMExports();
    t.mock.method(performance, 'now', () => now);
    let attempts = 0;
    let relaunched = 0;
    const { stop, steps } = harness({
      readinessMs: 1000,
      remainingMs: () => 13_000 - now,
      appAlive: async () => true,
      attach: async () => {
        if (++attempts === 1) throw new TargetReadinessTimeoutError('bundle still building');
        if (!relaunched) throw new Timeout('registered runtime remains paused');
      },
      relaunch: async () => {
        relaunched++;
      },
    });
    const admitted = admit(steps, stop).catch((error) => error);
    t.after(async () => {
      stop.begin();
      await admitted;
      t.mock.timers.reset();
      syncBuiltinESMExports();
    });
    const advance = async (ms: number) => {
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    };
    await nextTurn();
    assert.equal(relaunched, 0, 'the live app survives the no-target wait');
    await advance(500);
    await advance(500);
    assert.equal(relaunched, 0, 'a stall first seen after the skip gets its own readiness window');
    await advance(500);
    assert.equal(relaunched, 1, 'persistent target timeouts retain their recovery');
    await advance(500);
    assert.deepEqual(await admitted, PROVEN);
  });

  test(`persistent ${Timeout.name} gets one iOS relaunch after its readiness window`, async (t) => {
    let now = 10_000;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    syncBuiltinESMExports();
    t.mock.method(performance, 'now', () => now);
    let relaunched = 0;
    let probes = 0;
    const deadlines: number[] = [];
    const { stop, steps } = harness({
      appAlive: async () => {
        probes++;
        return true;
      },
      readinessMs: 1000,
      remainingMs: () => 13_000 - now,
      attach: async (deadline) => {
        deadlines.push(deadline);
        if (!relaunched) throw new Timeout('runtime remains paused');
      },
      relaunch: async () => {
        relaunched++;
      },
    });
    const admitted = admit(steps, stop).catch((error) => error);
    t.after(async () => {
      stop.begin();
      await admitted;
      t.mock.timers.reset();
      syncBuiltinESMExports();
    });
    const advance = async (ms: number) => {
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    };
    await nextTurn();
    await advance(500);
    assert.equal(relaunched, 0, 'transient attempt timeouts do not relaunch immediately');
    await advance(500);
    assert.equal(relaunched, 1, 'exhausted readiness retains the existing relaunch recovery');
    assert.equal(
      probes,
      0,
      'a listed target that stays silent is relaunched without a liveness probe',
    );
    await advance(500);
    assert.deepEqual(await admitted, PROVEN);
    assert.equal(new Set(deadlines).size, 1, 'relaunch must not renew the admission deadline');
  });
}

// Each attach call settles at its scripted time on the mock clock; times are ms since admission started.
function scriptedAttach(
  t: { mock: any; after: (fn: () => Promise<void>) => void },
  {
    budgetMs,
    script,
  }: { budgetMs: number; script: (call: number) => { at: number; error?: Error } },
) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  let calls = 0;
  const relaunchedAt: number[] = [];
  const { stop, steps } = harness({
    remainingMs: () => budgetMs - now,
    appAlive: async () => true,
    attach: async () => {
      const { at, error } = script(++calls);
      if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
      if (error) throw error;
    },
    relaunch: async () => {
      relaunchedAt.push(now);
    },
  });
  let settled = false;
  const admitted = admit(steps, stop).then(
    (proof) => ((settled = true), proof),
    (error) => ((settled = true), error),
  );
  t.after(async () => {
    stop.begin();
    await admitted;
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return {
    relaunchedAt,
    async run() {
      await nextTurn();
      while (!settled && now < budgetMs + 1000) {
        now += 500;
        t.mock.timers.tick(500);
        await nextTurn();
      }
      return admitted;
    },
  };
}

const probeStall = () => new CDPProbeTimeoutError('runtime probe timed out');
const noTargetYet = () => new TargetReadinessTimeoutError('no target yet');

test('a live app whose target registers after the skip is not relaunched while it starts', async (t) => {
  const { relaunchedAt, run } = scriptedAttach(t, {
    budgetMs: 120_000,
    script: (call) =>
      [
        { at: 30_000, error: noTargetYet() },
        { at: 46_000, error: probeStall() },
        { at: 53_000, error: probeStall() },
        { at: 58_000 },
      ][call - 1],
  });
  assert.deepEqual(await run(), PROVEN);
  assert.deepEqual(relaunchedAt, []);
});

test('a target that stalls after the skip is relaunched once a full readiness window after its first stall', async (t) => {
  const { relaunchedAt, run } = scriptedAttach(t, {
    budgetMs: 120_000,
    script: (call) => {
      if (call === 1) return { at: 30_000, error: noTargetYet() };
      if (relaunchedAt.length) return { at: 0 };
      return { at: 39_000 + 7_000 * (call - 1), error: probeStall() };
    },
  });
  assert.deepEqual(await run(), PROVEN);
  assert.deepEqual(relaunchedAt, [81_000]);
});

test('a target that registers just before the readiness window ends gets its own window', async (t) => {
  const { relaunchedAt, run } = scriptedAttach(t, {
    budgetMs: 120_000,
    script: (call) =>
      [{ at: 31_000, error: probeStall() }, { at: 38_000, error: probeStall() }, { at: 45_000 }][
        call - 1
      ],
  });
  assert.deepEqual(await run(), PROVEN);
  assert.deepEqual(relaunchedAt, []);
});

test('an early persistent stall is relaunched a full readiness window after it is first seen', async (t) => {
  const { relaunchedAt, run } = scriptedAttach(t, {
    budgetMs: 120_000,
    script: (call) =>
      call > 1 && relaunchedAt.length
        ? { at: 0 }
        : { at: 6_000 + 1_500 * (call - 1), error: probeStall() },
  });
  assert.deepEqual(await run(), PROVEN);
  assert.deepEqual(relaunchedAt, [36_000]);
});

test('a stall window that ends without a full readiness wait left refuses without relaunching', async (t) => {
  const { relaunchedAt, run } = scriptedAttach(t, {
    budgetMs: 50_000,
    script: (call) => ({
      at: call === 1 ? 6_000 : 6_000 + 1_500 * (call - 1),
      error: probeStall(),
    }),
  });
  const error = await run();
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta.relaunches, 0);
  assert.deepEqual(relaunchedAt, []);
});

test('the single retry relaunches the app before waiting again', async () => {
  const order: string[] = [];
  const { stop, steps } = harness({
    load: () => 50,
    foreignDriver: async () => {
      order.push('foreignDriver');
      return undefined;
    },
    attach: async () => {
      order.push('attach');
      if (order.length === 1) throw new TargetReadinessTimeoutError('stuck on the launcher');
    },
    relaunch: async () => {
      order.push('relaunch');
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.deepEqual(order, ['attach', 'foreignDriver', 'relaunch', 'attach', 'foreignDriver']);
});

test('an exhausted readiness wait can relaunch once at low load', async () => {
  let relaunched = 0;
  const { stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      if (!relaunched) throw new TargetReadinessTimeoutError('no target');
    },
    relaunch: async () => {
      relaunched++;
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(relaunched, 1);
});

test('a failed relaunch skips the next wait and retains the failure detail', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 50,
    attach: async () => {
      attempts++;
      throw new TargetReadinessTimeoutError('stuck on the launcher');
    },
    relaunch: async () => {
      throw new Error('simctl launch failed');
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /relaunch failed: simctl launch failed/);
    return true;
  });
  assert.equal(attempts, 1);
});

for (const foreign of ['Maestro holds the device', 'XCTest holds the device']) {
  test(`a driver arriving during the readiness wait prevents relaunch: ${foreign}`, async () => {
    const order: string[] = [];
    let active: string | undefined;
    const { stop, steps } = harness({
      load: () => 50,
      attach: async () => {
        order.push('attach');
        active = foreign;
        throw new TargetReadinessTimeoutError('stuck on the launcher');
      },
      foreignDriver: async () => {
        order.push('foreignDriver');
        return active;
      },
      relaunch: async () => {
        order.push('relaunch');
      },
      open: async () => {
        order.push('open');
      },
      prove: async () => {
        order.push('prove');
        return PROVEN;
      },
      close: async () => {
        order.push('close');
      },
    });
    await assert.rejects(admit(steps, stop), { code: 'BUSY_FOREIGN_FLOW', message: foreign });
    assert.deepEqual(order, ['attach', 'foreignDriver', 'close']);
  });
}

test('cancellation during the retry driver probe prevents relaunch', async () => {
  const { calls, stop, steps } = harness({
    load: () => 50,
    attach: async () => {
      throw new TargetReadinessTimeoutError('stuck on the launcher');
    },
  });
  steps.foreignDriver = async () => {
    calls.push('foreignDriver');
    stop.begin();
    return undefined;
  };
  steps.relaunch = async () => {
    calls.push('relaunch');
  };
  await assert.rejects(admit(steps, stop), { code: 'RUN_CANCELLED' });
  assert.deepEqual(calls, ['foreignDriver', 'close']);
});

test('a live app skips the one relaunch and admission keeps waiting', async () => {
  const order: string[] = [];
  let attempts = 0;
  const { stop, steps } = harness({
    attach: async () => {
      order.push('attach');
      if (++attempts < 3) throw new TargetReadinessTimeoutError('bundle still building');
    },
    foreignDriver: async () => {
      order.push('foreignDriver');
      return undefined;
    },
    appAlive: async () => {
      order.push('appAlive');
      return true;
    },
    relaunch: async () => {
      order.push('relaunch');
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.deepEqual(order, [
    'attach',
    'foreignDriver',
    'appAlive',
    'attach',
    'attach',
    'foreignDriver',
  ]);
});

test('a skipped relaunch is recorded value-free with zero relaunches', async () => {
  let remaining = 90_000;
  const { stop, steps } = harness({
    remainingMs: () => remaining,
    attach: async () => {
      throw new TargetReadinessTimeoutError('bundle still building');
    },
    appAlive: async () => {
      remaining = 0;
      return true;
    },
    relaunch: async () => assert.fail('a live app must not be relaunched'),
  });
  const error = await refusalOf(admit(steps, stop));
  const { rest } = budget(error.meta!);
  assert.deepEqual(rest, {
    attempt: 2,
    lastStarted: 'attach',
    lastCompleted: 'retry_wait',
    inner: 'target_readiness_timeout',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'alive',
    bundleRequest: 'unknown',
  });
});

test('a dead app gets the one relaunch as before', async () => {
  const order: string[] = [];
  let relaunched = 0;
  const { stop, steps } = harness({
    attach: async () => {
      order.push('attach');
      if (!relaunched) throw new TargetReadinessTimeoutError('no target');
    },
    foreignDriver: async () => {
      order.push('foreignDriver');
      return undefined;
    },
    appAlive: async () => {
      order.push('appAlive');
      return false;
    },
    relaunch: async () => {
      order.push('relaunch');
      relaunched++;
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(relaunched, 1);
  assert.deepEqual(order, [
    'attach',
    'foreignDriver',
    'appAlive',
    'relaunch',
    'attach',
    'foreignDriver',
  ]);
});

function launcherStall(bundleRequested: AdmissionSteps['bundleRequested']) {
  const order: string[] = [];
  const deadlines: number[] = [];
  let relaunched = 0;
  let remaining = 90_000;
  const { stop, steps } = harness({
    remainingMs: () => remaining,
    attach: async (deadline) => {
      order.push('attach');
      deadlines.push(deadline);
      if (!relaunched) {
        if (order.filter((step) => step === 'attach').length >= 3) remaining = 0;
        throw new TargetReadinessTimeoutError('no target');
      }
    },
    foreignDriver: async () => {
      order.push('foreignDriver');
      return undefined;
    },
    appAlive: async () => {
      order.push('appAlive');
      return true;
    },
    bundleRequested,
    relaunch: async () => {
      order.push('relaunch');
      relaunched++;
    },
  });
  return { order, deadlines, relaunches: () => relaunched, admitted: admit(steps, stop) };
}

test('a live app on its launcher with no bundle request gets the one relaunch', async () => {
  const stall = launcherStall(async () => false);
  assert.deepEqual(await stall.admitted, PROVEN);
  assert.equal(stall.relaunches(), 1);
  assert.deepEqual(stall.order, [
    'attach',
    'foreignDriver',
    'appAlive',
    'relaunch',
    'attach',
    'foreignDriver',
  ]);
  assert.equal(new Set(stall.deadlines).size, 1, 'relaunch must not renew the admission deadline');
});

test('a live app whose bundle request is in flight is never relaunched', async () => {
  let probes = 0;
  const stall = launcherStall(async () => {
    probes++;
    return true;
  });
  const error = await refusalOf(stall.admitted);
  assert.equal(stall.relaunches(), 0, 'a slow bundle with a request in flight keeps its load');
  assert.equal(probes, 1, 'the one relaunch is decided once');
  const { rest } = budget(error.meta!);
  assert.equal(rest.relaunches, 0);
  assert.equal(rest.liveness, 'alive');
});

test('a live app whose bundle request was received before its build started is never relaunched', async () => {
  let probes = 0;
  const signal = { path: '/run/logs/metro.bundle-requests', atLaunch: 0 };
  const stall = launcherStall(async () => {
    probes++;
    return bundleRequestedSinceLaunch(signal, () => '1\n');
  });
  await refusalOf(stall.admitted);
  assert.equal(stall.relaunches(), 0, 'a cold dependency graph still has the request in flight');
  assert.equal(probes, 1, 'the one relaunch is decided once');
});

for (const [name, bundleRequested] of [
  ['an unknown bundle signal', async () => undefined],
  ['a failing bundle signal', async () => assert.fail('signal unreadable')],
  ['no bundle signal', undefined],
] as const) {
  test(`a live app with ${name} keeps the existing skip`, async () => {
    const stall = launcherStall(bundleRequested);
    await refusalOf(stall.admitted);
    assert.equal(stall.relaunches(), 0);
  });
}

test('a dead app relaunches without reading the bundle signal', async () => {
  let relaunched = 0;
  const { stop, steps } = harness({
    attach: async () => {
      if (!relaunched) throw new TargetReadinessTimeoutError('no target');
    },
    appAlive: async () => false,
    bundleRequested: async () => assert.fail('a dead app needs no bundle signal'),
    relaunch: async () => {
      relaunched++;
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(relaunched, 1);
});

test('the bundle signal compares the drained count with the count at launch', () => {
  const read = (content: string | Error) => () => {
    if (content instanceof Error) throw content;
    return content;
  };
  const signal = { path: '/run/logs/metro.bundle-requests', atLaunch: 2 };
  assert.equal(bundleRequestedSinceLaunch(signal, read('2\n')), false);
  assert.equal(bundleRequestedSinceLaunch(signal, read('3')), true);
  assert.equal(
    bundleRequestedSinceLaunch(signal, read('1')),
    undefined,
    'a reset count proves nothing',
  );
  assert.equal(bundleRequestedSinceLaunch(signal, read('two')), undefined);
  assert.equal(bundleRequestedSinceLaunch(signal, read('')), undefined);
  assert.equal(
    bundleRequestedSinceLaunch(signal, read(Object.assign(new Error('gone'), { code: 'ENOENT' }))),
    undefined,
    'an absent count means Metro never logged a request',
  );
});

test('the relaunch opens the run’s own Metro, never a launcher-remembered server', () => {
  const argv = buildIosRelaunchArgv(
    'com.example.app',
    '00000000-0000-0000-0000-000000000001',
    devClientLaunchUrl({ metroUrlForDevice: 'http://127.0.0.1:19341' }),
  );
  assert.deepEqual(argv.slice(-2), ['--initialUrl', 'http://127.0.0.1:19341/?disableOnboarding=1']);
  assert.doesNotMatch(argv.join(' '), /8791/, 'a stale recent entry never reaches the relaunch');
});

test('a failed liveness probe is reset after a relaunch exhausts the budget', async () => {
  let remaining = 90_000;
  let probes = 0;
  const { stop, steps } = harness({
    remainingMs: () => remaining,
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target');
    },
    appAlive: async () => {
      probes++;
      throw new Error('launchctl PRIVATE-udid failed');
    },
    relaunch: async () => {
      remaining = 0;
    },
  });
  const error = await refusalOf(admit(steps, stop));
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  const { rest } = budget(error.meta!);
  assert.deepEqual(rest, {
    attempt: 2,
    lastStarted: 'attach',
    lastCompleted: 'retry_wait',
    inner: 'target_readiness_timeout',
    relaunches: 1,
    relaunchFailed: false,
    liveness: 'not_probed',
  });
  assert.equal(probes, 1, 'the exhausted budget prevents probing the relaunched app');
  assert.doesNotMatch(JSON.stringify(error.meta) + error.message, /PRIVATE/);
});

test('a target that registers in time never probes the app', async () => {
  const { calls, stop, steps } = harness();
  steps.appAlive = async () => {
    calls.push('appAlive');
    return true;
  };
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.deepEqual(calls, ['attach', 'foreignDriver', 'open', 'prove']);
});

test('a first launch waits on React readiness while Metro still builds the bundle', async () => {
  const answers = [false, false, undefined, true];
  let reads = 0;
  await awaitBundleReady(
    async () => {
      reads += 1;
      return { value: answers.shift() };
    },
    performance.now() + 5_000,
    1,
  );
  assert.equal(
    reads,
    4,
    'unready and unreadable answers keep waiting until the probe proves React',
  );
});

test('a bundle that never becomes ready ends attach as a readiness timeout, never at the origin proof', async () => {
  let reads = 0;
  await assert.rejects(
    awaitBundleReady(
      async () => {
        reads += 1;
        return { value: false };
      },
      performance.now() + 20,
      5,
    ),
    TargetReadinessTimeoutError,
  );
  assert.ok(reads >= 1);
});

test('the attached client must have run its bundle before the driver probe, session or origin proof', async () => {
  const { calls, stop, steps } = harness();
  steps.bundleReady = async () => {
    calls.push('bundleReady');
  };
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.deepEqual(calls, ['attach', 'bundleReady', 'foreignDriver', 'open', 'prove']);
});

test('a bundle still building at the attach deadline refuses as an attach timeout, not an origin mismatch', async () => {
  const { calls, stop, steps } = harness({ remainingMs: () => 20 });
  steps.bundleReady = async () => {
    calls.push('bundleReady');
    throw new TargetReadinessTimeoutError('React never became ready on the attached client');
  };
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /deadline exceeded/);
    return true;
  });
  assert.ok(!calls.includes('prove'), calls.join());
});

test('an Android foreign-driver warning refuses admission with its message', async () => {
  const { androidForeignDriverMessage } =
    await import('../../../dist/runners/external-runner-detect.js');
  const argv: string[][] = [];
  const exec = (async (_bin: string, args: string[]) => {
    argv.push(args);
    return {
      stdout:
        'USER PID PPID VSZ RSS WCHAN ADDR S NAME\nshell 4242 1 0 0 0 0 S uiautomator\nu0_a1 99 1 0 0 0 0 S dev.lykhoyda.rndevagent.androidrunner\n',
    };
  }) as never;
  const message = await androidForeignDriverMessage('emulator-5554', exec);
  assert.deepEqual(argv, [['-s', 'emulator-5554', 'shell', 'ps', '-A']]);
  assert.match(message ?? '', /competing Android UIAutomator/);
  const { calls, stop, steps } = harness({ foreignDriver: async () => message });
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'BUSY_FOREIGN_FLOW');
    assert.match(error.message, /competing Android UIAutomator/);
    return true;
  });
  assert.ok(!calls.includes('open'));

  const ownRunnerOnly = (async () => ({
    stdout: 'u0_a1 99 1 0 0 0 0 S dev.lykhoyda.rndevagent.androidrunner\n',
  })) as never;
  assert.equal(await androidForeignDriverMessage('emulator-5554', ownRunnerOnly), undefined);
});

// A fake dev client: each runtime is its own global object; a reload swaps it for a fresh one.
function devClient() {
  const reads: string[] = [];
  let runtime: Record<string, unknown> = { ready: true };
  const script: Array<'old' | 'closed' | 'unready' | 'ready'> = [];
  const evaluate = async (expression: string): Promise<{ value?: unknown; error?: string }> => {
    const next = script.shift();
    if (next === 'closed') {
      reads.push('closed');
      throw new Error('WebSocket closed');
    }
    if (next === 'unready' || next === 'ready') runtime = { ready: next === 'ready' };
    if (expression === REACT_READY_PROBE_JS) {
      reads.push(`react ${runtime.ready}`);
      return { value: runtime.ready };
    }
    reads.push('mark');
    return { value: runInNewContext(expression, runtime) };
  };
  return { reads, script, evaluate };
}

test('a Fast Refresh reload is over only once the marked runtime is gone, React is ready again, the helpers are back and the bundle is proven', async () => {
  const client = devClient();
  const calls: string[] = [];
  const reload = createBundleReload({
    evaluate: client.evaluate,
    reinjectHelpers: async () => {
      calls.push(`helpers after ${client.reads.at(-1)}`);
      return true;
    },
    prove: async () => {
      calls.push('prove');
      return PROVEN;
    },
    remainingMs: () => 5_000,
    pollMs: 1,
  });
  await reload.mark();
  // The marked runtime still answers React ready, then the socket drops, then the replacement boots.
  client.script.push('old', 'old', 'closed', 'unready', 'unready', 'ready', 'ready');
  await reload.settled();
  assert.ok(
    client.script.length <= 1,
    `the old runtime answering ready never ends the wait: ${client.reads.join()}`,
  );
  assert.deepEqual(calls, ['helpers after react true', 'prove']);
});

test('concurrent reloads retry slow helper and origin reads within their own admission budget', async () => {
  const results = await Promise.allSettled(
    ['helpers', 'proof'].map(async (slow) => {
      const client = devClient();
      let helpers = 0;
      let proofs = 0;
      const reload = createBundleReload({
        evaluate: client.evaluate,
        reinjectHelpers: async () => {
          if (++helpers === 1 && slow === 'helpers')
            throw new CDPRequestTimeoutError('the reloaded runtime has not answered yet');
          return true;
        },
        prove: async () => {
          if (++proofs === 1 && slow === 'proof')
            throw new CDPRequestTimeoutError('the reloaded SourceCode has not answered yet');
          return PROVEN;
        },
        remainingMs: () => 5_000,
        pollMs: 1,
      });
      await reload.mark();
      client.script.push('closed', 'unready', 'unready', 'ready', 'ready');
      await reload.settled();
      assert.ok(helpers >= 1 && proofs >= 1);
    }),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
});

test('concurrent reloads becoming ready after 30 seconds use the remaining run budget', async (t) => {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  const stop = createStop();
  const clients = [devClient(), devClient()];
  let proven = 0;
  const reloads = clients.map((client) =>
    createBundleReload({
      evaluate: client.evaluate,
      reinjectHelpers: async (waitMs) => {
        assert.ok(waitMs > 0 && waitMs <= 59_000);
        return true;
      },
      prove: async () => {
        proven++;
        return PROVEN;
      },
      remainingMs: () => 90_000 - now,
    }),
  );
  await Promise.all(reloads.map((reload) => reload.mark()));
  const settled = withCancellation(stop.signal, () =>
    Promise.allSettled(reloads.map((reload) => reload.settled())),
  );
  t.after(async () => {
    stop.begin();
    await settled;
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  await nextTurn();
  assert.equal(proven, 0, 'a responsive old runtime is not reload proof');
  clients.forEach((client) => client.script.push('ready'));
  now = 31_000;
  t.mock.timers.tick(31_000);
  await nextTurn();
  assert.deepEqual(
    (await settled).map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(proven, 2);
});

test('transient reload attempts cannot renew an exhausted run budget', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const client = devClient();
  let helpers = 0;
  let proven = false;
  const reload = createBundleReload({
    evaluate: client.evaluate,
    reinjectHelpers: async () => {
      helpers++;
      now = helpers === 1 ? 200 : 1_000;
      throw new CDPRequestTimeoutError('still not answering');
    },
    prove: async () => {
      proven = true;
      return PROVEN;
    },
    remainingMs: () => 1_000 - now,
    pollMs: 1,
  });
  await reload.mark();
  client.script.push('ready');
  await assert.rejects(reload.settled(), { code: 'CDP_NOT_CONNECTED' });
  assert.equal(helpers, 2);
  assert.equal(proven, false);
});

test('cancellation during reload readiness prevents helper injection and origin proof', async () => {
  const client = devClient();
  const stop = createStop();
  const calls: string[] = [];
  const reload = createBundleReload({
    evaluate: client.evaluate,
    reinjectHelpers: async () => {
      calls.push('helpers');
      return true;
    },
    prove: async () => {
      calls.push('proof');
      return PROVEN;
    },
    remainingMs: () => 90_000,
  });
  await reload.mark();
  const settled = withCancellation(stop.signal, () => reload.settled());
  const refused = assert.rejects(settled, { code: 'RUN_CANCELLED' });
  await nextTurn();
  stop.begin();
  await refused;
  assert.deepEqual(calls, []);
});

test('a runtime that never reloads refuses as an attach timeout and is never proven', async () => {
  const client = devClient();
  let proven = false;
  const reload = createBundleReload({
    evaluate: client.evaluate,
    reinjectHelpers: async () => true,
    prove: async () => {
      proven = true;
      return PROVEN;
    },
    remainingMs: () => 20,
    pollMs: 1,
  });
  await reload.mark();
  await assert.rejects(reload.settled(), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /reload/);
    return true;
  });
  assert.equal(proven, false);
});

test('a reloaded bundle from another origin refuses with the origin proof', async () => {
  const client = devClient();
  const reload = createBundleReload({
    evaluate: client.evaluate,
    reinjectHelpers: async () => true,
    prove: async () => ({
      ok: false,
      code: 'METRO_ORIGIN_MISMATCH',
      message: "scriptURL 127.0.0.1:9999 is not the run's Metro port 8081",
    }),
    remainingMs: () => 5_000,
    pollMs: 1,
  });
  await reload.mark();
  client.script.push('ready');
  await assert.rejects(reload.settled(), { code: 'METRO_ORIGIN_MISMATCH' });
});

test('a runtime that cannot be marked refuses before the setting that reloads it', async () => {
  const reload = createBundleReload({
    evaluate: async () => ({ error: 'ReferenceError' }),
    reinjectHelpers: async () => true,
    prove: async () => PROVEN,
    remainingMs: () => 5_000,
    pollMs: 1,
  });
  await assert.rejects(reload.mark(), { code: 'CDP_NOT_CONNECTED' });
});

test('a reloaded bundle the walk helpers cannot reach refuses before the origin proof', async () => {
  const client = devClient();
  let proven = false;
  const reload = createBundleReload({
    evaluate: client.evaluate,
    reinjectHelpers: async () => false,
    prove: async () => {
      proven = true;
      return PROVEN;
    },
    remainingMs: () => 5_000,
    pollMs: 1,
  });
  await reload.mark();
  client.script.push('ready');
  await assert.rejects(reload.settled(), { code: 'HELPERS_NOT_INJECTED' });
  assert.equal(proven, false);
});

for (const late of ['helpers', 'proof'] as const) {
  test(`${late === 'helpers' ? 'helper injection' : 'an origin proof'} still running at the deadline refuses before step 1`, async () => {
    const client = devClient();
    const never = new Promise<never>(() => {});
    const reload = createBundleReload({
      evaluate: client.evaluate,
      reinjectHelpers: async () => (late === 'helpers' ? never : true),
      prove: async () => (late === 'proof' ? never : PROVEN),
      remainingMs: () => 50,
      pollMs: 1,
    });
    await reload.mark();
    client.script.push('ready');
    await assert.rejects(reload.settled(), { code: 'CDP_NOT_CONNECTED' });
  });
}

test("an iOS attach is pinned to the run's simulator; Android's Metro device name is a model, so it is not", () => {
  assert.equal(metroDevicePin('ios', 'qa-pr1080-testapp-r2'), 'qa-pr1080-testapp-r2');
  assert.equal(metroDevicePin('android', 'emulator-5574'), undefined);
});

type Refusal = Error & { code?: string; meta?: Record<string, unknown> };

const SUMMARY = {
  readers: {
    androidPackages: 'empty',
    iosPackages: 'nonempty',
    iosDeviceNames: 'empty',
    androidDeviceModels: 'empty',
  },
  targets: [
    {
      token: 'none',
      name: 'neither',
      identity: 'present',
      packages: 'neither',
      confidence: 'defaulted',
      deviceMatch: true,
      bundleMatch: true,
    },
  ],
} as const;

async function refusalOf(admitted: Promise<unknown>): Promise<Refusal> {
  const error = await admitted.then(
    () => assert.fail('admission was expected to refuse'),
    (error: Refusal) => error,
  );
  return error;
}

function budget(meta: Record<string, unknown>) {
  const { elapsedMs, remainingMs, budgetMs, ...rest } = meta;
  for (const value of [elapsedMs, remainingMs, budgetMs])
    assert.ok(Number.isSafeInteger(value) && (value as number) >= 0, `budget field ${value}`);
  return { rest, remainingMs: remainingMs as number };
}

function mockClock(t: { mock: any; after: (fn: () => Promise<void>) => void }) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  return {
    async advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    },
    cleanup(stop: { begin(): void }, admitted: Promise<unknown>) {
      t.after(async () => {
        stop.begin();
        await admitted.catch(() => undefined);
        t.mock.timers.reset();
        syncBuiltinESMExports();
      });
    },
  };
}

test('a platform selection refusal keeps the public refusal and records its class and inference', async () => {
  const { calls, stop, steps } = harness({
    attach: async () => {
      throw new TargetSelectionError(
        'PLATFORM_TARGET_NOT_FOUND',
        'PLATFORM_TARGET_NOT_FOUND: x',
        [],
        SUMMARY,
      );
    },
  });
  const error = await refusalOf(admit(steps, stop));
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.match(error.message, /Metro 8081/);
  assert.match(error.message, /1-minute load/);
  const { rest, remainingMs } = budget(error.meta!);
  assert.deepEqual(rest, {
    attempt: 1,
    lastStarted: 'attach',
    lastCompleted: 'none',
    inner: 'target_selection_platform_not_found',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'not_probed',
    inference: SUMMARY,
  });
  assert.ok(remainingMs > 0);
  assert.deepEqual(calls, ['close']);
});

for (const [code, inner, deviceMatch, bundleMatch] of [
  ['DEVICE_TARGET_NOT_FOUND', 'target_selection_device_not_found', false, true],
  ['DEVICE_TARGET_AMBIGUOUS', 'target_selection_device_ambiguous', true, false],
  ['BUNDLE_TARGET_NOT_FOUND', 'target_selection_bundle_not_found', true, false],
] as const) {
  test(`a ${code} selection refusal records its finite class and bounded match booleans without candidate strings`, async () => {
    const inference = {
      readers: SUMMARY.readers,
      targets: Array.from({ length: 10 }, () => ({
        token: 'ios' as const,
        name: 'not_reached' as const,
        identity: 'present' as const,
        packages: 'not_reached' as const,
        confidence: 'probed' as const,
        deviceMatch,
        bundleMatch,
      })),
    };
    const { calls, stop, steps } = harness({
      attach: async () => {
        throw new TargetSelectionError(
          code,
          `${code}: bundleId="com.private.app" title="com.private.app (PRIVATE-phone)" url="ws://127.0.0.1:8081/private"`,
          [],
          inference,
        );
      },
    });
    const error = await refusalOf(admit(steps, stop));
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.deepEqual(calls, ['close']);
    const formatted = formatAdmissionRefusal(error.meta, 'connect_exact');
    for (const sentinel of ['com.private.app', 'PRIVATE-phone', 'ws://', '8081'])
      assert.ok(!formatted.includes(sentinel), `${sentinel} leaked: ${formatted}`);
    const parsed = JSON.parse(formatted);
    assert.equal(parsed.inner, inner);
    assert.equal(parsed.attachStage, 'connect_exact');
    assert.equal(parsed.inference.targetsTotal, 10);
    assert.equal(parsed.inference.targets.length, 8);
    assert.equal(parsed.inference.targets[0].deviceMatch, deviceMatch);
    assert.equal(parsed.inference.targets[0].bundleMatch, bundleMatch);
  });
}

test('a deadline during origin proof after one transient attach records the stalled boundary', async (t) => {
  const clock = mockClock(t);
  let attempts = 0;
  const { stop, steps } = harness({
    remainingMs: () => 1_000,
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('no target yet');
    },
    prove: () => interruptible(() => new Promise<never>(() => undefined)),
  });
  const admitted = refusalOf(admit(steps, stop));
  clock.cleanup(stop, admitted);
  await nextTurn();
  await clock.advance(500);
  await clock.advance(500);
  const error = await admitted;
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.match(error.message, /CDP attach deadline exceeded/);
  const { rest, remainingMs } = budget(error.meta!);
  assert.deepEqual(rest, {
    attempt: 2,
    lastStarted: 'prove',
    lastCompleted: 'open',
    inner: 'cdp_probe_timeout',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'not_probed',
  });
  assert.equal(remainingMs, 0);
});

test('a deadline during the retry pause records the pause, not the attach', async (t) => {
  const clock = mockClock(t);
  const { stop, steps } = harness({
    remainingMs: () => 700,
    attach: async () => {
      throw new CDPHandshakeTimeoutError('handshake timed out');
    },
  });
  const admitted = refusalOf(admit(steps, stop));
  clock.cleanup(stop, admitted);
  await nextTurn();
  await clock.advance(500);
  await clock.advance(200);
  const error = await admitted;
  const { rest, remainingMs } = budget(error.meta!);
  assert.equal(rest.lastStarted, 'retry_wait');
  assert.equal(rest.inner, 'cdp_handshake_timeout');
  assert.equal(rest.attempt, 2);
  assert.equal(remainingMs, 0);
});

const UNPROVEN = {
  readers: {
    androidPackages: 'null',
    iosPackages: 'null',
    iosDeviceNames: 'null',
    androidDeviceModels: 'not_consumed',
  },
  targets: [{ ...SUMMARY.targets[0] }],
} as const;
const unprovenSelection = (inference: object = UNPROVEN) =>
  new TargetSelectionError(
    'PLATFORM_TARGET_NOT_FOUND',
    'PLATFORM_TARGET_NOT_FOUND: x',
    [],
    inference as typeof SUMMARY,
  );

test('a platform selection with every probe failed retries with backoff, then attaches', async (t) => {
  const clock = mockClock(t);
  let attempts = 0;
  const decisions: string[] = [];
  const { stop, steps } = harness({
    attach: async () => {
      if (++attempts <= 2) throw unprovenSelection();
    },
    observe: (decision, facts) => decisions.push(`${decision}:${facts.inner}`),
  });
  const admitted = admit(steps, stop);
  clock.cleanup(stop, admitted);
  await nextTurn();
  assert.equal(attempts, 1);
  await clock.advance(999);
  assert.equal(attempts, 1);
  await clock.advance(1);
  assert.equal(attempts, 2);
  await clock.advance(1_999);
  assert.equal(attempts, 2, 'the second pause doubles');
  await clock.advance(1);
  assert.deepEqual(await admitted, PROVEN);
  assert.deepEqual(decisions, Array(2).fill('retry:target_selection_platform_not_found'));
});

for (const reader of [
  'androidPackages',
  'iosPackages',
  'iosDeviceNames',
  'androidDeviceModels',
] as const) {
  test(`a matching defaulted candidate retries when ${reader} answered without proving its platform`, async (t) => {
    const clock = mockClock(t);
    let attempts = 0;
    const inference = { ...UNPROVEN, readers: { ...UNPROVEN.readers, [reader]: 'nonempty' } };
    const { stop, steps } = harness({
      attach: async () => {
        if (++attempts === 1) throw unprovenSelection(inference);
      },
    });
    const admitted = admit(steps, stop);
    clock.cleanup(stop, admitted);
    await nextTurn();
    assert.equal(attempts, 1);
    await clock.advance(1_000);
    assert.deepEqual(await admitted, PROVEN);
    assert.equal(attempts, 2);
  });
}

for (const mismatch of ['deviceMatch', 'bundleMatch'] as const) {
  test(`a sibling iPhone 17 target with a ${mismatch} mismatch does not block retry`, async (t) => {
    const clock = mockClock(t);
    const targets = ['qa-device', 'iPhone 17'].map((deviceName, index) => ({
      id: `${index}-1`,
      title: 'Hermes',
      appId: 'com.example.app',
      deviceName,
      webSocketDebuggerUrl: `ws://localhost:8081/${index}`,
    }));
    const inference = inferPlatforms(targets, {
      readAndroid: () => null,
      readIOS: () => null,
      readIOSDeviceNames: () => null,
      readAndroidDeviceModels: () => null,
    });
    inference.targets.forEach((target, index) => {
      target.deviceMatch = true;
      target.bundleMatch = true;
      if (index === 1) target[mismatch] = false;
    });
    assert.equal(inference.targets[0]?.confidence, 'defaulted');
    assert.equal(inference.targets[1]?.confidence, 'probed');
    let attempts = 0;
    const { stop, steps } = harness({
      attach: async () => {
        if (++attempts === 1) throw unprovenSelection(inference);
      },
    });
    const admitted = admit(steps, stop);
    clock.cleanup(stop, admitted);
    await nextTurn();
    assert.equal(attempts, 1);
    await clock.advance(1_000);
    assert.deepEqual(await admitted, PROVEN);
    assert.equal(attempts, 2);
  });
}

for (const [name, error] of [
  ['all relevant probe readers answered', unprovenSelection(SUMMARY)],
  [
    'the candidate is another app',
    unprovenSelection({ ...UNPROVEN, targets: [{ ...UNPROVEN.targets[0], bundleMatch: false }] }),
  ],
  [
    'the candidate is another device',
    unprovenSelection({ ...UNPROVEN, targets: [{ ...UNPROVEN.targets[0], deviceMatch: false }] }),
  ],
  [
    'the failed readers cannot prove the missing name or identity',
    unprovenSelection({
      ...UNPROVEN,
      targets: [{ ...UNPROVEN.targets[0], name: 'absent', identity: 'missing' }],
    }),
  ],
  [
    'the candidate was proven on the other platform',
    unprovenSelection({ ...UNPROVEN, targets: [{ ...UNPROVEN.targets[0], confidence: 'probed' }] }),
  ],
  [
    'the device has no target',
    new TargetSelectionError('DEVICE_TARGET_NOT_FOUND', 'x', [], UNPROVEN as typeof SUMMARY),
  ],
  ['no inference was recorded', new TargetSelectionError('PLATFORM_TARGET_NOT_FOUND', 'x', [])],
] as const) {
  test(`a selection refusal stays terminal when ${name}`, async () => {
    let attempts = 0;
    const { calls, stop, steps } = harness({
      attach: async () => {
        attempts++;
        throw error;
      },
    });
    const refused = await refusalOf(admit(steps, stop));
    assert.equal(refused.code, 'CDP_NOT_CONNECTED');
    assert.equal(attempts, 1);
    assert.deepEqual(calls, ['close']);
  });
}

test('a cached failed probe is probed again on the unproven-selection retry; a cached answer is kept', async (t) => {
  clearPackageProbeCache();
  t.after(clearPackageProbeCache);
  let now = 0;
  const probeClock = () => now;
  let failed = 0;
  let answered = 0;
  const slowFailure = () => {
    failed++;
    now += 1_000;
    return null;
  };
  const answer = () => {
    answered++;
    return new Set(['com.example']);
  };
  const readAll = () => {
    cachedPackageProbe('ios-test', slowFailure, probeClock);
    cachedPackageProbe('android-test', answer, probeClock);
  };
  readAll();
  readAll();
  assert.deepEqual([failed, answered], [1, 1], 'a slow failure is cached for the long TTL');

  const clock = mockClock(t);
  let attempts = 0;
  const { stop, steps } = harness({
    attach: async () => {
      readAll();
      if (++attempts === 1) throw unprovenSelection();
    },
  });
  const admitted = admit(steps, stop);
  clock.cleanup(stop, admitted);
  await nextTurn();
  await clock.advance(1_000);
  assert.deepEqual(await admitted, PROVEN);
  assert.deepEqual([failed, answered], [2, 1]);
});

test('an unproven selection that outlasts the deadline refuses with its inference and bundle request, without a late liveness probe', async (t) => {
  const clock = mockClock(t);
  let attempts = 0;
  let livenessProbes = 0;
  const { stop, steps } = harness({
    remainingMs: () => 2_500,
    attach: async () => {
      attempts++;
      throw unprovenSelection();
    },
    appAlive: async () => {
      livenessProbes++;
      return true;
    },
    bundleRequested: async () => true,
  });
  const admitted = refusalOf(admit(steps, stop));
  clock.cleanup(stop, admitted);
  await nextTurn();
  await clock.advance(1_000);
  await clock.advance(1_500);
  const error = await admitted;
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(attempts, 2);
  const record = JSON.parse(formatAdmissionRefusal(error.meta, 'connect_exact'));
  assert.equal(record.inner, 'target_selection_platform_not_found');
  assert.equal(record.attempt, 2);
  assert.equal(record.liveness, 'not_probed');
  assert.equal(livenessProbes, 0);
  assert.equal(record.bundleRequest, 'received');
  assert.deepEqual(record.inference.readers, UNPROVEN.readers);
  assert.equal(record.budgetMs, 2_500);
});

for (const exhausted of ['attach deadline', 'remaining run budget'] as const) {
  test(`a selection refusal skips liveness after exhausting the ${exhausted}`, async (t) => {
    let now = 0;
    let remaining = 2_500;
    let livenessProbes = 0;
    t.mock.method(performance, 'now', () => now);
    const { stop, steps } = harness({
      remainingMs: () => remaining,
      attach: async () => {
        if (exhausted === 'attach deadline') now = 3_000;
        else remaining = 0;
        throw unprovenSelection();
      },
      appAlive: async () => {
        livenessProbes++;
        return true;
      },
      bundleRequested: async () => true,
    });
    const error = await refusalOf(admit(steps, stop));
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.equal(error.meta?.inner, 'target_selection_platform_not_found');
    assert.equal(error.meta?.liveness, 'not_probed');
    assert.equal(error.meta?.bundleRequest, 'received');
    assert.equal(livenessProbes, 0);
  });
}

test('refusal liveness is cancelled at the remaining budget and preserves the selection evidence', async (t) => {
  const clock = mockClock(t);
  let remaining = 2_500;
  let probeSignal: AbortSignal | undefined;
  const { stop, steps } = harness({
    remainingMs: () => remaining,
    attach: async () => {
      remaining = 500;
      throw new TargetSelectionError('PLATFORM_TARGET_NOT_FOUND', 'x', [], SUMMARY);
    },
    appAlive: () =>
      interruptible(async (signal) => {
        probeSignal = signal;
        return new Promise<boolean>(() => {});
      }),
    bundleRequested: async () => false,
  });
  const refused = refusalOf(admit(steps, stop));
  clock.cleanup(stop, refused);
  await nextTurn();
  assert.equal(probeSignal?.aborted, false);
  await clock.advance(500);
  const error = await refused;
  assert.equal(probeSignal?.aborted, true);
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(error.meta?.inner, 'target_selection_platform_not_found');
  assert.equal(error.meta?.liveness, 'not_probed');
  assert.equal(error.meta?.bundleRequest, 'not_received');
  assert.deepEqual(error.meta?.inference, SUMMARY);
});

test('a refusal with no bundle request carries the last manifest warm-up and names the likely cause', async () => {
  const { stop, steps } = harness({
    launchWarm: { ms: 7_100, attempts: 2 },
    attach: async () => {
      throw new Error('no target');
    },
    appAlive: async () => true,
    bundleRequested: async () => false,
  });
  const error = await refusalOf(admit(steps, stop));
  assert.match(
    error.message,
    /bundle request not_received; last manifest warm-up 7100 ms after 2 attempts; likely cause: the dev client's manifest request outlasted its 10s timeout/,
  );
  const record = JSON.parse(formatAdmissionRefusal(error.meta));
  assert.equal(record.warmMs, 7_100);
  assert.equal(record.warmAttempts, 2);
  assert.equal(record.bundleRequest, 'not_received');
  assert.equal(record.liveness, 'alive');
  assert.ok(cleanTimingEvent(admissionMetric('refused', error.meta as never, undefined, 1)));
});

test('the relaunch warm-up replaces the launch warm-up in the refusal', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    launchWarm: { ms: 7_100, attempts: 2 },
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('stuck on the launcher');
      throw new Error('no target');
    },
    relaunch: async () => ({ ms: 900, attempts: 3 }),
  });
  const error = await refusalOf(admit(steps, stop));
  assert.deepEqual([error.meta?.warmMs, error.meta?.warmAttempts], [900, 3]);
  assert.doesNotMatch(error.message, /likely cause/);
});

test('a relaunch followed by a deterministic failure records one relaunch and two attempts', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('stuck on the launcher');
      throw new Error('no target');
    },
    relaunch: async () => undefined,
  });
  const error = await refusalOf(admit(steps, stop));
  const { rest } = budget(error.meta!);
  assert.deepEqual(rest, {
    attempt: 2,
    lastStarted: 'attach',
    lastCompleted: 'retry_wait',
    inner: 'untyped',
    relaunches: 1,
    relaunchFailed: false,
    liveness: 'not_probed',
  });
});

test('a failed relaunch records the relaunch boundary and failure without its detail', async () => {
  const { stop, steps } = harness({
    attach: async () => {
      throw new TargetReadinessTimeoutError('stuck on the launcher');
    },
    relaunch: async () => {
      throw new Error('simctl launch failed');
    },
  });
  const error = await refusalOf(admit(steps, stop));
  const { rest } = budget(error.meta!);
  assert.deepEqual(rest, {
    attempt: 1,
    lastStarted: 'relaunch',
    lastCompleted: 'foreign_driver',
    inner: 'target_readiness_timeout',
    relaunches: 1,
    relaunchFailed: true,
    liveness: 'not_probed',
  });
  assert.doesNotMatch(JSON.stringify(error.meta), /simctl/);
});

test('refusals with their own code carry no admission record', async () => {
  const mismatch = harness({
    prove: async () => ({ ok: false, code: 'METRO_ORIGIN_MISMATCH', message: 'foreign bundle' }),
  });
  const refused = await refusalOf(admit(mismatch.steps, mismatch.stop));
  assert.equal(refused.code, 'METRO_ORIGIN_MISMATCH');
  assert.equal(refused.meta, undefined);

  const cancelled = harness();
  cancelled.stop.begin();
  const stopped = await refusalOf(admit(cancelled.steps, cancelled.stop));
  assert.equal(stopped.code, 'RUN_CANCELLED');
  assert.equal(stopped.meta, undefined);
});

test('the deterministic attach refusal names its observed state', async () => {
  const { stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      throw new Error('no target');
    },
  });
  const error = await refusalOf(admit(steps, stop));
  assert.equal(
    error.message,
    'cannot attach to the dev client through Metro 8081: no target (observed attach: untyped; app not_probed; bundle request not_probed; host 1-minute load 3.0)',
  );
});

test('the admission refusal line round-trips allowlisted facts', () => {
  const facts = {
    attempt: 1,
    lastStarted: 'attach',
    lastCompleted: 'none',
    inner: 'target_selection_platform_not_found',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'alive',
    elapsedMs: 45_513,
    remainingMs: 254_487,
    budgetMs: 300_000,
    inference: SUMMARY,
  };
  assert.deepEqual(JSON.parse(formatAdmissionRefusal(facts, 'connect_exact')), {
    ...facts,
    attachStage: 'connect_exact',
    inference: { ...SUMMARY, targetsTotal: 1 },
  });
  const later = JSON.parse(
    formatAdmissionRefusal({ ...facts, lastStarted: 'prove' }, 'wait_targets'),
  );
  assert.equal(later.attachStage, undefined);
});

test('the admission refusal line never copies a value outside its allowlist', () => {
  const hostile = {
    attempt: Number.NaN,
    lastStarted: 'PRIVATE-udid',
    lastCompleted: { nested: 'com.private.app' },
    inner: 'http://private.example/bundle',
    relaunches: -1,
    relaunchFailed: 'com.private.app',
    liveness: 'PRIVATE-udid',
    elapsedMs: 1e300,
    remainingMs: 1.5,
    budgetMs: 'PRIVATE-udid',
    deviceName: 'PRIVATE-udid',
    inference: {
      readers: {
        androidPackages: 'com.private.app',
        iosPackages: 'nonempty',
        extra: 'PRIVATE-udid',
      },
      targets: Array.from({ length: 9 }, () => ({
        token: 'PRIVATE-udid',
        name: 'com.private.app',
        identity: 'present',
        packages: { url: 'http://private.example' },
        confidence: 'probed',
        deviceMatch: 'PRIVATE-udid',
        appId: 'com.private.app',
      })),
    },
  };
  const line = formatAdmissionRefusal(hostile, 'connect_exact');
  for (const sentinel of ['PRIVATE', 'private', 'http'])
    assert.ok(!line.includes(sentinel), `${sentinel} leaked: ${line}`);
  const record = JSON.parse(line);
  assert.equal(record.attempt, 'unknown');
  assert.equal(record.lastStarted, 'unknown');
  assert.equal(record.attachStage, undefined);
  assert.equal(record.relaunches, 'unknown');
  assert.equal(record.relaunchFailed, 'unknown');
  assert.equal(record.liveness, 'unknown');
  assert.equal(record.elapsedMs, 'unknown');
  assert.equal(record.remainingMs, 'unknown');
  assert.equal(record.inference.readers.androidPackages, 'unknown');
  assert.equal(record.inference.readers.iosDeviceNames, 'unknown');
  assert.equal(record.inference.readers.extra, undefined);
  assert.equal(record.inference.targetsTotal, 9);
  assert.equal(record.inference.targets.length, 8);
  assert.deepEqual(record.inference.targets[0], {
    token: 'unknown',
    name: 'unknown',
    identity: 'present',
    packages: 'unknown',
    confidence: 'probed',
    deviceMatch: 'unknown',
  });
  assert.equal(
    formatAdmissionRefusal(undefined),
    JSON.stringify(JSON.parse(formatAdmissionRefusal({}))),
  );
});

test('a refused admission writes exactly one value-free refusal line, and other errors write none', async () => {
  const { stop, steps } = harness({
    attach: async () => {
      throw new TargetSelectionError(
        'PLATFORM_TARGET_NOT_FOUND',
        'PLATFORM_TARGET_NOT_FOUND: device="PRIVATE-phone"',
        [],
        SUMMARY,
      );
    },
  });
  const refusal = await refusalOf(admit(steps, stop));
  const lines: string[] = [];
  logAdmissionRefusal(refusal, 'connect_exact', (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^admission-refusal=\{/);
  const record = JSON.parse(lines[0]!.slice('admission-refusal='.length));
  assert.equal(record.inner, 'target_selection_platform_not_found');
  assert.equal(record.attachStage, 'connect_exact');
  assert.ok(!lines[0]!.includes('PRIVATE'));

  logAdmissionRefusal(new Error('no target'), 'connect_exact', (line) => lines.push(line));
  logAdmissionRefusal(new HandlerError('METRO_ORIGIN_MISMATCH', 'x'), undefined, (line) =>
    lines.push(line),
  );
  assert.equal(lines.length, 1);
  logAdmissionRefusal(refusal, undefined, () => {
    throw new Error('stderr closed');
  });
});

function observed(overrides: Partial<AdmissionSteps> = {}) {
  const events: Array<{ decision: AdmissionDecision; facts: Record<string, unknown> }> = [];
  const admission = harness({
    observe: (decision, facts) => void events.push({ decision, facts: { ...facts } }),
    ...overrides,
  });
  const facts = () => events.map(({ decision, facts }) => ({ decision, ...budget(facts).rest }));
  return { ...admission, events, facts };
}

test('each retry decision is observed with its liveness and relaunch count', async () => {
  let attempts = 0;
  const { stop, steps, facts } = observed({
    attach: async () => {
      if (++attempts < 3) throw new TargetReadinessTimeoutError('PRIVATE bundle still building');
    },
    appAlive: async () => true,
    relaunch: async () => assert.fail('a live app must not be relaunched'),
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  const retry = {
    decision: 'retry',
    inner: 'target_readiness_timeout',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'alive',
    bundleRequest: 'unknown',
  };
  assert.deepEqual(facts(), [
    { ...retry, attempt: 1, lastStarted: 'attach', lastCompleted: 'none' },
    { ...retry, attempt: 2, lastStarted: 'attach', lastCompleted: 'retry_wait' },
  ]);
  assert.doesNotMatch(JSON.stringify(facts()), /PRIVATE/);
});

test('a cancelled admission is observed once with the facts of its last retry', async () => {
  let attempts = 0;
  const { calls, stop, steps, facts } = observed({
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('PRIVATE launcher');
      stop.begin();
      await interruptible(() => new Promise(() => undefined));
    },
    appAlive: async () => true,
    relaunch: async () => assert.fail('a live app must not be relaunched'),
  });
  const stopped = await refusalOf(admit(steps, stop));
  assert.equal(stopped.code, 'RUN_CANCELLED');
  assert.equal(stopped.meta, undefined);
  assert.deepEqual(calls.slice(-1), ['close']);
  assert.deepEqual(facts().slice(1), [
    {
      decision: 'cancelled',
      attempt: 2,
      lastStarted: 'attach',
      lastCompleted: 'retry_wait',
      inner: 'target_readiness_timeout',
      relaunches: 0,
      relaunchFailed: false,
      liveness: 'alive',
      bundleRequest: 'unknown',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(facts()), /PRIVATE/);
});

test('an admission cancelled before its first retry is observed with no inner failure', async () => {
  const { stop, steps, facts } = observed();
  stop.begin();
  assert.equal((await refusalOf(admit(steps, stop))).code, 'RUN_CANCELLED');
  assert.deepEqual(facts(), [
    {
      decision: 'cancelled',
      attempt: 0,
      lastStarted: 'attach',
      lastCompleted: 'none',
      inner: 'none',
      relaunches: 0,
      relaunchFailed: false,
      liveness: 'not_probed',
    },
  ]);
});

for (const boundary of [
  'attach',
  'bundle_ready',
  'foreign_driver',
  'open',
  'prove',
  'relaunch',
  'retry_wait',
] as const) {
  test(`stop.track writes cancelled admission facts before its result during ${boundary}`, async () => {
    await withInputs(new RunInputs({ ACCOUNT: 'private-account' }, ['ACCOUNT']), async () => {
      const lines: string[] = [];
      const writer = createWriter((line) => void lines.push(line), 'cancel-admission');
      const entered = Promise.withResolvers<void>();
      const stall = () => {
        entered.resolve();
        return new Promise<never>(() => undefined);
      };
      const { stop, steps } = harness({
        observe: (decision, facts) => {
          writer.diagnostic({
            kind: 'metric',
            ...admissionMetric(decision, facts, 'wait_targets', 0),
          });
          if (boundary === 'retry_wait' && decision === 'retry') entered.resolve();
        },
      });
      if (boundary === 'attach') steps.attach = stall;
      if (boundary === 'bundle_ready') steps.bundleReady = stall;
      if (boundary === 'foreign_driver') steps.foreignDriver = stall;
      if (boundary === 'open') steps.open = stall;
      if (boundary === 'prove') steps.prove = stall;
      if (boundary === 'relaunch' || boundary === 'retry_wait') {
        steps.attach = async () => {
          throw new TargetReadinessTimeoutError('no target');
        };
        if (boundary === 'relaunch') steps.relaunch = stall;
      }
      const pending = stop
        .track(() => admit(steps, stop))
        .catch((error) => {
          assert.equal(error.code, 'RUN_CANCELLED');
          assert.equal(
            writer.result({
              verdict: 'REFUSED',
              code: error.code,
              message: 'the run was cancelled',
              lease: 'cancel-admission',
            }),
            4,
          );
        });
      await entered.promise;
      stop.begin();
      await pending;
      await stop.drained(100);
      const envelopes = lines.map((line) => JSON.parse(line));
      const cancelled = envelopes.filter((event) => event.payload.admission === 'cancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].type, 'diagnostic');
      assert.equal(cancelled[0].payload.lastStarted, boundary);
      assert.equal(envelopes.at(-1).type, 'result');
      assert.equal(envelopes.at(-2), cancelled[0]);
      assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
    });
  });
}

test('settled admissions remove the cancellation observer', async () => {
  for (const refused of [false, true]) {
    const { stop, steps, events } = observed(
      refused
        ? {
            attach: async () => {
              throw new Error('attach failed');
            },
          }
        : {},
    );
    await admit(steps, stop).catch(() => undefined);
    const count = events.length;
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
    stop.begin();
    assert.equal(events.length, count);
  }
});

test('a refused admission is observed with its refusal facts; its own codes are not', async () => {
  let remaining = 90_000;
  const { stop, steps, events } = observed({
    remainingMs: () => remaining,
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target');
    },
    appAlive: async () => {
      remaining = 0;
      return true;
    },
    relaunch: async () => assert.fail('a live app must not be relaunched'),
  });
  const error = await refusalOf(admit(steps, stop));
  assert.deepEqual(
    events.map(({ decision }) => decision),
    ['retry', 'refused'],
  );
  assert.deepEqual(events.at(-1)!.facts, error.meta);

  const own = observed({
    prove: async () => ({ ok: false, code: 'METRO_ORIGIN_MISMATCH', message: 'foreign bundle' }),
  });
  await refusalOf(admit(own.steps, own.stop));
  assert.deepEqual(own.events, []);
});

test('an observer that throws changes neither an admission nor its refusal', async () => {
  let attempts = 0;
  const throwing = () => {
    throw new Error('stdout closed');
  };
  const admitted = harness({
    observe: throwing,
    attach: async () => {
      if (++attempts < 2) throw new TargetReadinessTimeoutError('no target');
    },
  });
  assert.deepEqual(await admit(admitted.steps, admitted.stop), PROVEN);
  const refused = harness({
    observe: throwing,
    remainingMs: () => 20,
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target');
    },
  });
  assert.equal((await refusalOf(admit(refused.steps, refused.stop))).code, 'CDP_NOT_CONNECTED');
});

test('admission facts become a cleaned metric with only allowlisted words and numbers', () => {
  const facts = {
    attempt: 3,
    lastStarted: 'attach',
    lastCompleted: 'retry_wait',
    inner: 'target_readiness_timeout',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'alive',
    bundleRequest: 'received',
    elapsedMs: 61_000,
    remainingMs: 1_138_000,
    budgetMs: 1_199_000,
    inference: SUMMARY,
  } as const;
  const metric = admissionMetric('cancelled', facts, 'wait_targets', 70_000);
  const { inference: _inference, ...rest } = facts;
  const expected = {
    stage: 'admission',
    edge: 'point',
    outcome: 'failed',
    at: 70_000,
    admission: 'cancelled',
    attachStage: 'wait_targets',
    ...rest,
  };
  assert.deepEqual(metric, expected);
  assert.deepEqual(cleanTimingEvent(metric), expected);
  assert.equal(admissionMetric('retry', facts, undefined, 1).outcome, 'unknown');
  assert.equal(
    admissionMetric('retry', { ...facts, lastStarted: 'prove' }, 'connect_exact', 1).attachStage,
    undefined,
  );
  for (const [key, value] of [
    ['admission', 'PRIVATE'],
    ['lastStarted', 'PRIVATE'],
    ['inner', 'http://private.example'],
    ['liveness', 1],
    ['bundleRequest', 'PRIVATE'],
    ['relaunchFailed', 'false'],
    ['attempt', -1],
    ['attachStage', 'PRIVATE'],
  ] as const)
    assert.equal(cleanTimingEvent({ ...expected, [key]: value }), undefined, key);
  assert.equal(cleanTimingEvent({ ...expected, stage: 'capture' }), undefined);
  assert.equal(cleanTimingEvent({ ...expected, edge: 'end' }), undefined);
});
