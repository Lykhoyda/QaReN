import { interruptible } from '../../../dist/domain/cancellation.js';
import { createStop } from '../../../dist/qa/stop.js';
import { TargetReadinessTimeoutError } from '../../../dist/cdp/discovery.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_ENVELOPE,
  admit,
  awaitBundleReady,
  createBundleReload,
  metroDevicePin,
  type AdmissionSteps,
} from '../../../dist/qa/admission.js';
import { REACT_READY_PROBE_JS } from '../../../dist/injected-helpers.js';
import { runInNewContext } from 'node:vm';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;

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

test('an attach timeout under host load is retried once and refused as environment with the load', async () => {
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 42.25,
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
    assert.match(error.message, /1-minute load 42\.3 is above the envelope 10/);
    assert.match(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 2);
  assert.ok(!calls.includes('open'));
  assert.equal(LOAD_ENVELOPE, 10);
});

test('within the load envelope an attach failure is refused at once, with the load recorded', async () => {
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
    assert.match(error.message, /1-minute load 3\.0 is within the envelope 10/);
    assert.doesNotMatch(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('a retried attach that connects under load continues the admission', async () => {
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 50,
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

test('a loaded timeout with only 15 seconds left refuses without a second 30-second wait', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 42,
    remainingMs: () => 15_000,
    attach: async () => {
      attempts++;
      throw new TargetReadinessTimeoutError('readiness timeout');
    },
  });
  await assert.rejects(admit(steps, stop), /environment refusal without enough budget/);
  assert.equal(attempts, 1);
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

test('loaded handshake timeout retries once and remains an environment refusal', async () => {
  const { CDPHandshakeTimeoutError } = await import('../../../dist/cdp/connect.js');
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 42,
    attach: async () => {
      attempts++;
      throw new CDPHandshakeTimeoutError('handshake timed out');
    },
  });
  await assert.rejects(
    admit(steps, stop),
    /host 1-minute load 42.0.*environment refusal after one retry/,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['close']);
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

test('within the load envelope nothing is relaunched', async () => {
  let relaunched = 0;
  const { stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      throw new TargetReadinessTimeoutError('no target');
    },
    relaunch: async () => {
      relaunched++;
    },
  });
  await assert.rejects(admit(steps, stop));
  assert.equal(relaunched, 0);
});

test('a failed relaunch skips the second wait and stays an environment refusal', async () => {
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
    assert.match(error.message, /environment refusal/);
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
  const { calls, stop, steps } = harness();
  steps.bundleReady = async () => {
    calls.push('bundleReady');
    throw new TargetReadinessTimeoutError('React never became ready on the attached client');
  };
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /React never became ready/);
    return true;
  });
  assert.ok(!calls.includes('prove'), calls.join());
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
    deadline: () => performance.now() + 5_000,
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
    deadline: () => performance.now() + 20,
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
    deadline: () => performance.now() + 5_000,
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
    deadline: () => performance.now() + 5_000,
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
    deadline: () => performance.now() + 5_000,
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
      deadline: () => performance.now() + 50,
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
