import { interruptible, withCancellation } from '../../../dist/domain/cancellation.js';
import { createStop } from '../../../dist/qa/stop.js';
import { TargetReadinessTimeoutError, TargetSelectionError } from '../../../dist/cdp/discovery.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admit,
  awaitBundleReady,
  createBundleReload,
  formatAdmissionRefusal,
  metroDevicePin,
  type AdmissionSteps,
} from '../../../dist/qa/admission.js';
import { REACT_READY_PROBE_JS } from '../../../dist/injected-helpers.js';
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
  test(`persistent ${Timeout.name} gets one iOS relaunch after its readiness window`, async (t) => {
    let now = 10_000;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    syncBuiltinESMExports();
    t.mock.method(performance, 'now', () => now);
    let relaunched = 0;
    const deadlines: number[] = [];
    const { stop, steps } = harness({
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
    await advance(500);
    assert.deepEqual(await admitted, PROVEN);
    assert.equal(new Set(deadlines).size, 1, 'relaunch must not renew the admission deadline');
  });
}

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
    androidPackages: 'null',
    iosPackages: 'nonempty',
    iosDeviceNames: 'null',
    androidDeviceModels: 'null',
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
    inference: SUMMARY,
  });
  assert.ok(remainingMs > 0);
  assert.deepEqual(calls, ['close']);
});

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
  assert.equal(rest.inner, 'cdp_probe_timeout');
  assert.equal(rest.attempt, 2);
  assert.equal(remainingMs, 0);
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

test('the deterministic attach refusal message is unchanged', async () => {
  const { stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      throw new Error('no target');
    },
  });
  const error = await refusalOf(admit(steps, stop));
  assert.equal(
    error.message,
    'cannot attach to the dev client through Metro 8081: no target (host 1-minute load 3.0)',
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
