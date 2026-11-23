import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { androidStartGate } from '../../../dist/qa/android-start-gate.js';
import { androidStartSteps } from '../../../dist/qa/android-start-steps.js';
import { androidStartNote } from '../../../dist/qa/android-start-note.js';
import {
  admit,
  type AdmissionRefusalFacts,
  type AdmissionSteps,
  type BundleBuilt,
} from '../../../dist/qa/admission.js';
import { createStop } from '../../../dist/qa/stop.js';
import { interruptible, sleep } from '../../../dist/domain/cancellation.js';
import { CDPTargetClosedError, DevTargetUnavailableError } from '../../../dist/cdp/connect.js';
import {
  BundleReadinessTimeoutError,
  TargetListAttemptTimeoutError,
  TargetReadinessTimeoutError,
} from '../../../dist/cdp/discovery.js';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;
const APP = 'com.example.synthetic';
const SERIAL = 'synthetic-android';
const HOLDING = "; the app's first views had not appeared, so no debugger was attached";
const COUNT_CHECK =
  '; at the count check Metro had recorded no bundle request on this port since the launch';
type Outcome = { value?: unknown; error?: any; done: boolean };
type Reader = 'loading' | 'loaded' | 'unknown';
type Wait = 'listed' | 'empty' | 'unanswered' | 'other_bundle';

function clock(t: TestContext) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  const stop = createStop();
  const pending: Promise<unknown>[] = [];
  t.after(async () => {
    stop.begin();
    await Promise.allSettled(pending);
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return {
    stop,
    now: () => now,
    watch(promise: Promise<unknown>) {
      const outcome: Outcome = { done: false };
      pending.push(
        promise.then(
          (value) => {
            outcome.value = value;
            outcome.done = true;
          },
          (error) => {
            outcome.error = error;
            outcome.done = true;
          },
        ),
      );
      return outcome;
    },
    until(outcome: Outcome, end: number) {
      return this.advanceUntil(() => outcome.done, end);
    },
    async advanceUntil(condition: () => boolean, end: number) {
      await nextTurn();
      while (!condition() && now < end) {
        now += 100;
        t.mock.timers.tick(100);
        await nextTurn();
      }
      assert.ok(condition(), `condition still false at ${now} ms`);
    },
  };
}

type Process = boolean | 'reject' | 'never';

// The real admission and gate under a fake clock, with the Android factory's three steps spread in.
function rig(
  c: ReturnType<typeof clock>,
  options: {
    reader: (now: number) => Reader;
    wait?: (now: number) => Wait;
    walkMs?: number;
    requested?: (now: number) => boolean | undefined;
    built?: (now: number) => BundleBuilt;
    noCounts?: true;
    process?: Process;
    processMs?: number;
  },
) {
  const walkMs = options.walkMs ?? 1_200_000;
  const calls = { process: [] as number[], requested: [] as number[], built: [] as number[] };
  const decisions: string[] = [];
  const gate = androidStartGate({
    read: async () => options.reader(c.now()),
    log: () => undefined,
    at: () => c.now(),
  });
  const bundleRequests = options.noCounts
    ? undefined
    : {
        requested: () => {
          calls.requested.push(c.now());
          return options.requested?.(c.now());
        },
        built: () => {
          calls.built.push(c.now());
          return options.built?.(c.now()) ?? 'unknown';
        },
      };
  const process = async (appId: string, serial: string): Promise<boolean> => {
    assert.equal(appId, APP);
    assert.equal(serial, SERIAL);
    calls.process.push(c.now());
    const answer = options.process ?? true;
    if (answer === 'never') return interruptible(() => new Promise<never>(() => undefined));
    if (options.processMs) await sleep(options.processMs);
    if (answer === 'reject') throw new Error('adb failed');
    return answer;
  };
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    attachBudgetMs: 120_000,
    remainingMs: () => walkMs - c.now(),
    waitTargets: async (deadline) => {
      const window = () => Math.max(1, Math.min(30_000, steps.remainingMs(), deadline - c.now()));
      await gate.wait(window());
      const mode = options.wait?.(c.now()) ?? 'listed';
      if (mode === 'listed') return;
      await sleep(window());
      if (mode === 'empty') throw new TargetReadinessTimeoutError('empty', 'empty');
      if (mode === 'unanswered') throw new TargetListAttemptTimeoutError('list', 'list_timeout');
      throw new BundleReadinessTimeoutError('other bundle', 'other_bundle');
    },
    attach: async () => undefined,
    foreignDriver: async () => undefined,
    open: async () => undefined,
    prove: async () => PROVEN,
    close: async () => undefined,
    observe: (decision) => decisions.push(decision),
    load: () => 1,
    ...androidStartSteps({
      appId: APP,
      serial: SERIAL,
      bundleRequests,
      gate,
      process,
    }),
  };
  return { steps, calls, decisions };
}

const refusal = (outcome: Outcome) => {
  assert.equal(outcome.error?.code, 'CDP_NOT_CONNECTED', String(outcome.error?.stack));
  return outcome.error as { message: string; meta: Record<string, unknown> };
};

test('E1: a start with no bundle request is refused at the first eligible failed wait', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'unknown',
    wait: () => 'empty',
    requested: () => false,
    process: false,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(c.now(), 137_500);
  const error = refusal(result);
  assert.equal(error.meta.inner, 'target_list_empty');
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.equal(error.meta.bundleBuilt, undefined);
  assert.deepEqual(r.calls.process, [137_500]);
  assert.deepEqual(r.calls.requested, [137_500]);
  assert.deepEqual(r.calls.built, []);
});

test('E2: the deciding count is kept and the process is read after it', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'loading',
    requested: (now) => now >= 122_000,
    process: true,
    processMs: 2000,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(c.now(), 123_500);
  const error = refusal(result);
  assert.equal(error.meta.liveness, 'alive');
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.equal(error.meta.elapsedMs, 123_500);
  assert.ok(error.message.includes(COUNT_CHECK), error.message);
  assert.doesNotMatch(error.message, /likely cause/);
  assert.deepEqual(r.calls.requested, [121_500]);
  assert.deepEqual(r.calls.built, []);
  assert.deepEqual(r.calls.process, [121_500]);
});

test('E2b: a failed process read is reported as not checked', async (t) => {
  const c = clock(t);
  const r = rig(c, { reader: () => 'loading', requested: () => false, process: 'reject' });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(c.now(), 121_500);
  const error = refusal(result);
  assert.equal(error.meta.liveness, 'probe_failed');
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.ok(error.message.includes("; the app's process could not be checked"), error.message);
  assert.doesNotMatch(error.message, /was running/);
});

test('E3: a recorded request or no counts at all never refuses early', async (t) => {
  for (const noCounts of [false, true]) {
    await t.test(noCounts ? 'no counts' : 'request recorded', async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: (now) => (now < 150_000 ? 'loading' : 'loaded'),
        requested: () => true,
        ...(noCounts ? { noCounts: true as const } : {}),
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      assert.equal(result.error, undefined, String(result.error?.message));
      assert.deepEqual(result.value, PROVEN);
      assert.equal(c.now(), 150_000);
      assert.deepEqual(r.calls.process, []);
      assert.deepEqual(r.calls.built, []);
      assert.deepEqual(r.calls.requested, noCounts ? [] : [121_500]);
    });
  }
});

test('E4: a dead start with a request recorded is not refused early', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'unknown',
    wait: () => 'empty',
    walkMs: 300_000,
    requested: () => true,
    built: () => 'none',
    process: false,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 400_000);
  assert.equal(c.now(), 300_000);
  const error = refusal(result);
  assert.deepEqual(r.calls.process, []);
  assert.equal(error.meta.liveness, 'not_probed');
  assert.equal(error.meta.bundleRequest, 'received');
  assert.equal(error.meta.bundleBuilt, 'none');
});

test('E5: the factory gives Android exactly its three steps and reads what Metro recorded', async () => {
  const base = { appId: APP, serial: SERIAL, gate: { note: () => '' }, process: async () => true };
  const noCounts = androidStartSteps(base);
  for (const steps of [
    noCounts,
    androidStartSteps({ ...base, bundleRequests: { requested: () => true, built: () => 'none' } }),
  ])
    assert.deepEqual(Object.keys(steps).sort(), ['refusalNote', 'startCounts', 'startProcess']);
  assert.deepEqual(noCounts.startCounts(true), { bundleRequest: 'unknown' });
  for (const requested of [undefined, false, true]) {
    for (const built of ['completed', 'failed', 'none', 'unknown'] as const) {
      let builtCalls = 0;
      const steps = androidStartSteps({
        ...base,
        bundleRequests: {
          requested: () => requested,
          built: () => {
            builtCalls++;
            return built;
          },
        },
      });
      const request = requested === undefined ? 'unknown' : requested ? 'received' : 'not_received';
      assert.deepEqual(steps.startCounts(true), {
        bundleRequest: request,
        ...(requested ? { bundleBuilt: built } : {}),
      });
      const before = builtCalls;
      assert.deepEqual(steps.startCounts(false), { bundleRequest: request });
      assert.equal(builtCalls, before, 'startCounts(false) never reads the build outcomes');
    }
  }
  const asked: string[][] = [];
  const steps = androidStartSteps({
    ...base,
    process: async (appId: string, serial: string) => {
      asked.push([appId, serial]);
      return false;
    },
  });
  assert.equal(await steps.startProcess(), false);
  assert.deepEqual(asked, [[APP, SERIAL]]);
});

test('E7: no device read sits in the loop', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: (now) => (now < 122_000 ? 'loading' : 'loaded'),
    walkMs: 125_000,
    requested: () => true,
    process: true,
    processMs: 5000,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 200_000);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.deepEqual(result.value, PROVEN);
  assert.equal(c.now(), 122_000);
  assert.deepEqual(r.calls.process, []);
});

test('E8: an unanswered target list never decides on a zero count', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'unknown',
    wait: () => 'unanswered',
    walkMs: 300_000,
    requested: () => false,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 400_000);
  assert.equal(c.now(), 300_000);
  const error = refusal(result);
  assert.equal(error.meta.inner, 'target_list_attempt_timeout');
  assert.equal(error.meta.liveness, 'not_probed');
  assert.equal(error.meta.bundleRequest, 'not_received');
});

test('E9: a wait the loop does not retry is not decided, and its counts follow the process read', async (t) => {
  const c = clock(t);
  let waits = 0;
  const r = rig(c, {
    reader: () => 'unknown',
    wait: () => (++waits <= 3 ? 'empty' : 'other_bundle'),
    requested: (now) => now >= 138_000,
    built: () => 'none',
    process: true,
    processMs: 2000,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(c.now(), 139_500);
  const error = refusal(result);
  assert.equal(error.meta.inner, 'bundle_readiness_timeout');
  assert.equal(error.meta.liveness, 'alive');
  assert.equal(error.meta.bundleRequest, 'received');
  assert.equal(error.meta.bundleBuilt, 'none');
  assert.deepEqual(r.calls.requested, [139_500]);
});

test('F1: a deadline after the attach reads the process and names the step', async (t) => {
  await t.test('time left: the process is read', async (t) => {
    const c = clock(t);
    const r = rig(c, { reader: () => 'loaded', requested: () => true, process: true });
    r.steps.bundleReady = async () => undefined;
    r.steps.open = () => interruptible(() => new Promise<never>(() => undefined));
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 1_300_000);
    assert.equal(c.now(), 120_000);
    const error = refusal(result);
    assert.equal(error.meta.lastStarted, 'open');
    assert.equal(error.meta.liveness, 'alive');
    assert.equal(error.meta.bundleRequest, undefined);
    assert.ok(
      error.message.endsWith(
        "; the app's process was running; the debugger was attached and React was ready; the deadline ended at step open",
      ),
      error.message,
    );
    assert.deepEqual(r.calls.process, [120_000]);
    assert.deepEqual(r.calls.requested, []);
    assert.deepEqual(r.calls.built, []);
  });
  await t.test('no time left: the read is cut at the walk deadline', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      reader: () => 'loaded',
      walkMs: 123_000,
      process: true,
      processMs: 5000,
    });
    r.steps.bundleReady = async () => undefined;
    r.steps.open = () => interruptible(() => new Promise<never>(() => undefined));
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 200_000);
    assert.equal(c.now(), 123_000);
    assert.equal(refusal(result).meta.liveness, 'not_probed');
  });
  await t.test('cancelled during the read: no refusal is recorded', async (t) => {
    const c = clock(t);
    const r = rig(c, { reader: () => 'loaded', process: 'never' });
    r.steps.bundleReady = async () => undefined;
    r.steps.open = () => interruptible(() => new Promise<never>(() => undefined));
    const result = c.watch(admit(r.steps, c.stop));
    await c.advanceUntil(() => r.calls.process.length > 0, 200_000);
    assert.deepEqual(r.calls.process, [120_000]);
    c.stop.begin();
    await c.until(result, 200_000);
    assert.equal(result.error?.code, 'RUN_CANCELLED');
    assert.equal(r.decisions.includes('refused'), false);
  });
});

test('F2: an unproven development mode names the dead process after its fixed sentence', async (t) => {
  const c = clock(t);
  const r = rig(c, { reader: () => 'loaded', requested: () => true, process: false });
  r.steps.attach = async () => {
    throw new DevTargetUnavailableError(
      { targetsTotal: 1, devTrue: 0, devFalse: 0, devUndefined: 0, devUnknown: 1 },
      false,
    );
  };
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  const error = refusal(result);
  assert.equal(error.meta.inner, 'no_dev_target_unknown');
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.bundleRequest, undefined);
  assert.equal(
    error.message,
    "Development mode could not be established before the attach deadline; the app's process was not running",
  );
});

test('F3: the walk end reads the counts; a listing keeps them out', async (t) => {
  await t.test('walk end, no listing: counts read at the end', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      reader: () => 'loading',
      walkMs: 300_000,
      requested: (now) => (now < 300_000 ? undefined : true),
      built: () => 'none',
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 400_000);
    assert.equal(c.now(), 300_000);
    const error = refusal(result);
    assert.equal(error.meta.liveness, 'not_probed');
    assert.equal(error.meta.bundleRequest, 'received');
    assert.equal(error.meta.bundleBuilt, 'none');
    assert.equal(r.calls.requested.at(-1), 300_000);
    assert.deepEqual(r.calls.built, [300_000]);
    assert.deepEqual(r.calls.process, []);
    assert.ok(
      error.message.endsWith(
        '; a bundle request and no completed build were recorded on this Metro port since the launch' +
          HOLDING,
      ),
      error.message,
    );
  });
  for (const [walkMs, end, liveness] of [
    [200_000, 200_000, 'not_probed'],
    [1_200_000, 270_000, 'alive'],
  ] as const) {
    await t.test(`listed, then a stalled connect, walk ${walkMs / 1000} s`, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: (now) => (now < 150_000 ? 'loading' : 'loaded'),
        walkMs,
        requested: () => true,
        process: true,
      });
      r.steps.attach = () => interruptible(() => new Promise<never>(() => undefined));
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      assert.equal(c.now(), end);
      const error = refusal(result);
      assert.equal(error.meta.inner, 'target_readiness_timeout');
      assert.equal(error.meta.liveness, liveness);
      assert.equal(error.meta.bundleRequest, undefined);
      assert.deepEqual(r.calls.requested, [121_500]);
    });
  }
});

test('F6: after a listing no count is read and none is reported', async (t) => {
  const c = clock(t);
  let proofs = 0;
  let listed: number | undefined;
  const r = rig(c, {
    reader: (now) => (now < 100_000 ? 'loading' : 'loaded'),
    wait: (now) => {
      if (listed === undefined) {
        listed = now;
        return 'listed';
      }
      return 'empty';
    },
    requested: () => true,
    process: true,
  });
  r.steps.prove = async () => {
    if (++proofs === 1) throw new CDPTargetClosedError('synthetic socket loss');
    return PROVEN;
  };
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(listed, 101_500);
  assert.equal(c.now(), 221_500);
  const error = refusal(result);
  assert.equal(error.meta.inner, 'target_list_empty');
  assert.equal(error.meta.lastStarted, 'attach');
  assert.equal(error.meta.lastCompleted, 'retry_wait');
  assert.equal(error.meta.liveness, 'alive');
  assert.equal(error.meta.bundleRequest, undefined);
  assert.deepEqual(
    r.calls.requested.filter((at) => at >= 101_500),
    [],
  );
  assert.deepEqual(r.calls.process, [221_500]);
});

test('F7: the idle refusal keeps its counts, read once at the refusal', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'loaded',
    requested: () => true,
    built: () => 'completed',
    process: true,
  });
  r.steps.attach = async () => {
    throw new DevTargetUnavailableError(
      { targetsTotal: 1, devTrue: 0, devFalse: 0, devUndefined: 1, devUnknown: 0 },
      true,
      'device-1',
    );
  };
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(c.now(), 120_000);
  const error = refusal(result);
  assert.equal(error.meta.inner, 'dev_runtime_unproven');
  assert.match(
    error.message,
    /bundle request on the port: received; bundle completion on the port: completed/,
  );
  assert.equal(error.meta.bundleRequest, 'received');
  assert.equal(error.meta.bundleBuilt, 'completed');
  assert.equal(error.meta.liveness, 'alive');
  assert.deepEqual(r.calls.process, [120_000]);
  assert.deepEqual(r.calls.requested, [120_000]);
  assert.deepEqual(r.calls.built, [120_000]);
});

test('T1: the note names the process, the counts and the stage before the gate note', () => {
  const gate = '; GATE';
  const base: AdmissionRefusalFacts = {
    attempt: 1,
    lastStarted: 'attach',
    lastCompleted: 'none',
    inner: 'target_readiness_timeout',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'not_probed',
    elapsedMs: 0,
    remainingMs: 0,
    budgetMs: 0,
  };
  const note = (facts: Partial<AdmissionRefusalFacts>) =>
    androidStartNote({ ...base, ...facts }, gate);
  assert.equal(androidStartNote(undefined, gate), gate);
  assert.equal(note({}), gate);
  assert.equal(note({ bundleRequest: 'unknown' }), gate);
  assert.equal(note({ liveness: 'dead' }), "; the app's process was not running" + gate);
  assert.equal(note({ liveness: 'alive' }), "; the app's process was running" + gate);
  assert.equal(
    note({ liveness: 'probe_failed' }),
    "; the app's process could not be checked" + gate,
  );
  assert.equal(note({ bundleRequest: 'not_received' }), COUNT_CHECK + gate);
  const unread =
    '; a bundle request was recorded on this Metro port since the launch; build outcomes could not be read';
  for (const [built, text] of [
    ['failed', 'a failed build'],
    ['none', 'no completed build'],
    ['completed', 'a completed build'],
    ['unknown', undefined],
    [undefined, undefined],
  ] as const)
    assert.equal(
      note({ bundleRequest: 'received', ...(built ? { bundleBuilt: built } : {}) }),
      (text
        ? `; a bundle request and ${text} were recorded on this Metro port since the launch`
        : unread) + gate,
    );
  for (const step of ['foreign_driver', 'open', 'prove'] as const)
    assert.equal(
      note({ lastStarted: step }),
      `; the debugger was attached and React was ready; the deadline ended at step ${step}` + gate,
    );
  assert.equal(
    note({ liveness: 'alive', bundleRequest: 'not_received', lastStarted: 'prove' }),
    "; the app's process was running" +
      COUNT_CHECK +
      '; the debugger was attached and React was ready; the deadline ended at step prove' +
      gate,
  );
});
