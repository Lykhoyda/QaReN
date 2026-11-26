import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { promisify } from 'node:util';
import { androidStartGate } from '../../../dist/qa/android-start-gate.js';
import { androidStartSteps } from '../../../dist/qa/android-start-steps.js';
import { androidStartNote } from '../../../dist/qa/android-start-note.js';
import {
  admit,
  launchBundleRequests,
  type AdmissionRefusalFacts,
  type AdmissionSteps,
  type BundleBuilt,
} from '../../../dist/qa/admission.js';
import { createStop } from '../../../dist/qa/stop.js';
import { interruptible, sleep } from '../../../dist/domain/cancellation.js';
import { CDPTargetClosedError } from '../../../dist/cdp/connect.js';
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
const URL_8081 =
  'exp+synthetic://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F%3FdisableOnboarding%3D1';
const RESTARTED = '; QaReN stopped the app and issued one recovery start command';
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
    // A synchronous read that blocks the host this long.
    jump(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
    },
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

// The phase a fake answers for: before the force-stop, between it and the start, after the start.
type Phase = 'before' | 'stopped' | 'started';
type Answer = boolean | 'reject';

// rig of android-start-admission.test.ts:83-162, with the restart's fakes; `restartAt` is when the fake start ran.
function rig(
  c: ReturnType<typeof clock>,
  options: {
    reader: (now: number, restartAt?: number) => Reader;
    wait?: (now: number, restartAt?: number) => Wait;
    walkMs?: number;
    attachBudgetMs?: number;
    requested?: (now: number, call: number) => boolean | undefined;
    requestedMs?: (call: number) => number;
    // Metro's request counter file, through the real launch counts (3 at launch).
    counter?: (now: number) => number;
    relaunchingMs?: number;
    built?: (now: number) => BundleBuilt;
    noCounts?: true;
    // By phase; a picker answers true, false, true.
    process?: Answer | ((phase: Phase, call: number) => Answer | 'never');
    launch?: true;
    driver?: 'clear' | 'busy' | 'unknown';
    stopFails?: true;
    start?: 'sent' | 'timed_out' | 'reject' | 'never';
    startMs?: number;
    processMs?: number;
  },
) {
  const walkMs = options.walkMs ?? 1_200_000;
  const calls = { process: [] as number[], requested: [] as number[] };
  const events: [string, number][] = [];
  const lines: string[] = [];
  const decisions: string[] = [];
  let phase: Phase = 'before';
  let restartAt: number | undefined;
  const realGate = androidStartGate({
    read: async () => options.reader(c.now(), restartAt),
    log: () => undefined,
    at: () => c.now(),
  });
  const gate = {
    ...realGate,
    restart() {
      events.push(['restart', c.now()]);
      realGate.restart();
    },
  };
  const real = options.counter
    ? launchBundleRequests({ path: 'metro.bundle-requests', atLaunch: 3 }, () =>
        String(options.counter!(c.now())),
      )
    : undefined;
  const bundleRequests = options.noCounts
    ? undefined
    : real
      ? {
          requested: () => {
            calls.requested.push(c.now());
            return real.requested();
          },
          built: () => real.built(),
          relaunching: () => {
            events.push(['relaunching', c.now()]);
            real.relaunching();
            if (options.relaunchingMs) c.jump(options.relaunchingMs);
          },
        }
      : {
          requested: () => {
            calls.requested.push(c.now());
            const answer = options.requested?.(c.now(), calls.requested.length);
            const ms = options.requestedMs?.(calls.requested.length) ?? 0;
            if (ms > 0) c.jump(ms);
            return answer;
          },
          built: () => options.built?.(c.now()) ?? 'unknown',
          relaunching: () => {
            events.push(['relaunching', c.now()]);
            if (options.relaunchingMs) c.jump(options.relaunchingMs);
          },
        };
  const process = async (appId: string, serial: string): Promise<boolean> => {
    assert.equal(appId, APP);
    assert.equal(serial, SERIAL);
    calls.process.push(c.now());
    events.push(['process', c.now()]);
    const spec = options.process ?? true;
    const answer =
      typeof spec === 'function'
        ? spec(phase, calls.process.length)
        : spec === true && phase === 'stopped'
          ? false
          : spec;
    if (answer === 'never') return interruptible(() => new Promise<never>(() => undefined));
    if (options.processMs) await sleep(options.processMs);
    if (answer === 'reject') throw new Error('adb failed');
    return answer;
  };
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    attachBudgetMs: options.attachBudgetMs ?? 120_000,
    remainingMs: () => walkMs - c.now(),
    waitTargets: async (deadline) => {
      const window = () => Math.max(1, Math.min(30_000, steps.remainingMs(), deadline - c.now()));
      await gate.wait(window());
      const mode = options.wait?.(c.now(), restartAt) ?? 'listed';
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
      metroPort: 8081,
      ...(options.launch ? { launchUrl: URL_8081 } : {}),
      bundleRequests,
      gate,
      process,
      driver: async (serial) => {
        assert.equal(serial, SERIAL);
        events.push(['driver', c.now()]);
        return options.driver ?? 'clear';
      },
      stop: async (appId, serial) => {
        assert.deepEqual([appId, serial], [APP, SERIAL]);
        events.push(['stop', c.now()]);
        if (options.stopFails) throw new Error('adb failed');
        phase = 'stopped';
      },
      start: async (appId, serial, url) => {
        assert.deepEqual([appId, serial, url], [APP, SERIAL, URL_8081]);
        events.push(['start', c.now()]);
        restartAt = c.now();
        phase = 'started';
        const answer = options.start ?? 'sent';
        if (answer === 'never') return interruptible(() => new Promise<never>(() => undefined));
        if (options.startMs) await sleep(options.startMs);
        if (answer === 'reject') throw new Error('adb: exit 1 for ' + url);
        return answer;
      },
      log: (line) => lines.push(line),
      at: () => c.now(),
    }),
  };
  return { steps, calls, events, lines, decisions, names: () => events.map(([name]) => name) };
}

const refusal = (outcome: Outcome, code = 'CDP_NOT_CONNECTED') => {
  assert.equal(outcome.error?.code, code, String(outcome.error?.stack));
  return outcome.error as { message: string; meta: Record<string, unknown> };
};
const picker = { reader: () => 'loading' as const, requested: () => false };

test('R1: a picker start is restarted once and the walk continues', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: (now, restart) =>
      restart === undefined || now < restart + 40_000 ? 'loading' : 'loaded',
    requested: () => false,
    launch: true,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.deepEqual(result.value, PROVEN);
  assert.equal(c.now(), 162_500);
  assert.deepEqual(r.events, [
    ['driver', 121_500],
    ['stop', 121_500],
    ['process', 121_500],
    ['relaunching', 121_500],
    ['start', 121_500],
    ['restart', 121_500],
  ]);
  assert.deepEqual(r.lines, [
    'android start: restart: the app was stopped at 121500 ms; sending the same start once',
    'android start: restart: start sent at 121500 ms',
  ]);
});

test('R2: a dead start is restarted at the first failed wait and the walk continues', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: (now, restart) =>
      restart === undefined ? 'unknown' : now < restart + 30_000 ? 'loading' : 'loaded',
    wait: (_now, restart) => (restart === undefined ? 'empty' : 'listed'),
    requested: () => true,
    process: (phase) => phase === 'started',
    launch: true,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.equal(c.now(), 77_000);
  assert.deepEqual(r.events, [
    ['process', 46_000],
    ['driver', 46_000],
    ['process', 46_000],
    ['stop', 46_000],
    ['process', 46_000],
    ['relaunching', 46_000],
    ['start', 46_000],
    ['restart', 46_000],
  ]);
});

test('R3: a restarted start still dead is refused at the first failed wait of its own budget, once', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'unknown',
    wait: () => 'empty',
    requested: () => true,
    built: () => 'none',
    process: false,
    launch: true,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  // Restarted at 46.0 s, judged from 166.0 s: its waits fail at 92.5, 123.0, 153.5 and 184.0 s.
  assert.equal(c.now(), 184_000);
  const error = refusal(result);
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.bundleRequest, 'received');
  assert.equal(error.meta.bundleBuilt, 'none');
  assert.equal(error.meta.relaunches, 1);
  assert.equal(error.meta.relaunchFailed, false);
  assert.equal(error.meta.relaunchBlocked, undefined);
  assert.equal(error.meta.inner, 'target_list_empty');
  assert.deepEqual(r.calls.process, [46_000, 46_000, 46_000, 184_000]);
  assert.equal(r.names().filter((name) => name === 'start').length, 1);
  assert.ok(
    error.message.includes(RESTARTED + "; the app's process was not running"),
    error.message,
  );
});

test('R4: a restarted picker is refused on the rebased count once its own budget has passed', async (t) => {
  const c = clock(t);
  const r = rig(c, { ...picker, launch: true });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  // Restarted at 121.5 s, judged from 241.5 s: its held waits fail at 152.0, 182.5, 213.0 and 243.5 s.
  assert.equal(c.now(), 243_500);
  const error = refusal(result);
  assert.equal(error.meta.liveness, 'alive');
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.equal(error.meta.relaunches, 1);
  assert.deepEqual(r.calls.requested, [121_500, 121_500, 243_500]);
  assert.deepEqual(r.calls.process, [121_500, 243_500]);
});

test('R5: without a launch URL a dead start is refused at the first failed wait', async (t) => {
  for (const [name, options, request] of [
    ['E1', { requested: () => false }, 'not_received'],
    ['E4', { requested: () => true, built: () => 'none' as const, walkMs: 300_000 }, 'received'],
    ['expo route', { noCounts: true as const, walkMs: 300_000 }, 'unknown'],
  ] as const) {
    await t.test(name, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: () => 'unknown',
        wait: () => 'empty',
        process: false,
        ...options,
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      assert.equal(c.now(), 46_000);
      const error = refusal(result);
      assert.equal(error.meta.liveness, 'dead');
      assert.equal(error.meta.bundleRequest, request);
      assert.equal(error.meta.relaunches, 0);
      assert.deepEqual(r.calls.process, [46_000]);
      assert.deepEqual(r.names(), ['process']);
    });
  }
});

test("R6: the restart needs the restarted start's own budget after its slowest start; a timed-out start is judged from its return", async (t) => {
  for (const walkMs of [335_400, 335_500, 400_000]) {
    await t.test(`walk ${walkMs} ms`, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: (_now, restart) => (restart === undefined ? 'loading' : 'unknown'),
        wait: () => 'empty',
        walkMs,
        requested: (_now, call) => call > 2,
        process: (phase) => phase === 'before',
        launch: true,
        start: 'timed_out',
        startMs: 60_000,
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 500_000);
      const error = refusal(result);
      if (walkMs === 335_400) {
        // 121.5 + 94 + 120 = 335.5 s of walk are needed.
        assert.equal(c.now(), 121_500);
        assert.deepEqual(r.events, [['process', 121_500]]);
        assert.equal(error.meta.relaunches, 0);
        assert.equal(error.meta.bundleRequest, 'not_received');
        return;
      }
      assert.equal(r.names().filter((name) => name === 'start').length, 1);
      assert.equal(r.lines[1], 'android start: restart: start command timed out at 181500 ms');
      assert.equal(error.meta.relaunches, 1);
      assert.equal(error.meta.relaunchFailed, false);
      // Judged from 181.5 + 120 = 301.5 s: the first failed wait from then on is at 319.5 s.
      if (walkMs === 335_500) {
        // Only 16 s are left there, too few for a death read: the walk's end refuses, never later.
        assert.equal(c.now(), 335_500);
        assert.equal(error.meta.liveness, 'not_probed');
        assert.deepEqual(r.calls.process, [121_500]);
        return;
      }
      assert.equal(c.now(), 319_500);
      assert.equal(error.meta.liveness, 'dead');
      assert.deepEqual(r.calls.process, [121_500, 319_500]);
    });
  }
});

test("R6d: reads before the stop that take the restart's share withdraw it; a late start is never repeated", async (t) => {
  await t.test('a 45 s confirming count read at the equality walk: no stop', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      ...picker,
      walkMs: 335_500,
      requestedMs: (call) => (call === 2 ? 45_000 : 0),
      launch: true,
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 500_000);
    const error = refusal(result);
    // 166.5 + 81 > 335.5 - 120: the stop, its proof and the start could not return in time.
    assert.equal(c.now(), 166_500);
    // The table, then only the refusal's own read: no stop.
    assert.deepEqual(r.events, [
      ['driver', 121_500],
      ['process', 166_500],
    ]);
    assert.equal(error.meta.relaunches, 0);
    assert.equal(error.meta.lastStarted, 'attach');
    assert.equal(error.meta.bundleRequest, 'not_received');
    assert.equal(error.meta.liveness, 'alive');
  });
  await t.test('a 45 s count rebase after the stop: the one start is still sent', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      ...picker,
      walkMs: 335_500,
      relaunchingMs: 45_000,
      launch: true,
      startMs: 60_000,
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 500_000);
    const error = refusal(result);
    // 49 s were left before latestReturn 215.5 s: no check withdraws the start after a proven stop.
    assert.deepEqual(r.events.slice(0, 5), [
      ['driver', 121_500],
      ['stop', 121_500],
      ['process', 121_500],
      ['relaunching', 121_500],
      ['start', 166_500],
    ]);
    assert.equal(r.names().filter((name) => name === 'start').length, 1);
    assert.equal(r.lines[1], 'android start: restart: start sent at 226500 ms');
    assert.equal(c.now(), 335_500);
    assert.equal(error.meta.relaunches, 1);
    assert.equal(error.meta.relaunchFailed, false);
    assert.equal(error.meta.liveness, 'not_probed');
  });
  await t.test(
    'a start that returns past its own limit is judged as sent, never repeated',
    async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: (_now, restart) => (restart === undefined ? 'loading' : 'unknown'),
        wait: () => 'empty',
        walkMs: 335_500,
        requested: (_now, call) => call > 2,
        process: (phase) => phase === 'before',
        launch: true,
        start: 'timed_out',
        startMs: 100_000,
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 500_000);
      const error = refusal(result);
      // Returned at 221.5 s, past latestReturn 215.5 s: J 341.5 s lies past the walk, which refuses at its end.
      assert.equal(r.lines[1], 'android start: restart: start command timed out at 221500 ms');
      assert.equal(c.now(), 335_500);
      assert.equal(error.meta.relaunches, 1);
      assert.equal(error.meta.relaunchFailed, false);
      assert.equal(error.meta.liveness, 'not_probed');
      assert.equal(r.names().filter((name) => name === 'start').length, 1);
    },
  );
});

test('R7: progress seen after the driver check keeps the app', async (t) => {
  await t.test('a request recorded during the check', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      reader: (now) => (now < 150_000 ? 'loading' : 'loaded'),
      requested: (_now, call) => call > 1,
      launch: true,
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 1_300_000);
    assert.equal(result.error, undefined, String(result.error?.message));
    assert.equal(c.now(), 150_000);
    assert.deepEqual(r.events, [['driver', 121_500]]);
    assert.deepEqual(r.calls.requested, [121_500, 121_500]);
  });
  await t.test('the process seen again during the check', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      reader: () => 'unknown',
      wait: (now) => (now < 46_500 ? 'empty' : 'listed'),
      requested: () => true,
      process: (_phase, call) => call > 1,
      launch: true,
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 1_300_000);
    assert.equal(result.error, undefined, String(result.error?.message));
    assert.equal(c.now(), 46_500);
    assert.deepEqual(r.events, [
      ['process', 46_000],
      ['driver', 46_000],
      ['process', 46_000],
    ]);
  });
});

test('R8: a busy or unreadable process table refuses at once without a stop', async (t) => {
  for (const [driver, code, blocked, words] of [
    [
      'busy',
      'BUSY_FOREIGN_FLOW',
      'driver_busy',
      "the device's process table matched another automation driver",
    ],
    ['unknown', 'CDP_NOT_CONNECTED', 'device_unreadable', 'the device did not answer the reads'],
  ] as const) {
    await t.test(driver, async (t) => {
      const c = clock(t);
      const r = rig(c, { ...picker, launch: true, driver });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      assert.equal(c.now(), 121_500);
      const error = refusal(result, code);
      assert.equal(error.meta.relaunchBlocked, blocked);
      assert.equal(error.meta.relaunches, 0);
      assert.equal(error.meta.relaunchFailed, false);
      assert.equal(error.meta.liveness, 'alive');
      assert.equal(error.meta.bundleRequest, 'not_received');
      assert.deepEqual(r.names(), ['driver', 'process']);
      assert.ok(error.message.includes(`; QaReN did not restart the app: ${words}`), error.message);
    });
  }
  await t.test('a death that cannot be confirmed', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      reader: () => 'unknown',
      wait: () => 'empty',
      requested: () => true,
      process: (_phase, call) => (call === 1 ? false : 'reject'),
      launch: true,
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 1_300_000);
    assert.equal(c.now(), 46_000);
    const error = refusal(result);
    assert.equal(error.meta.relaunchBlocked, 'device_unreadable');
    assert.equal(error.meta.liveness, 'probe_failed');
    assert.deepEqual(r.names(), ['process', 'driver', 'process']);
  });
});

test('R9: a restart that fails after the stop refuses at once, with fixed words', async (t) => {
  for (const [name, options, words, starts] of [
    [
      'running after the stop',
      { process: true as const },
      "the app's process was running after the force-stop",
      0,
    ],
    ['stop fails', { stopFails: true as const }, 'the force-stop command failed', 0],
    [
      'proof fails',
      { process: (phase: Phase) => (phase === 'stopped' ? ('reject' as const) : true) },
      "the app's process could not be read after the force-stop",
      0,
    ],
    ['start fails', { start: 'reject' as const }, 'the start command failed', 1],
  ] as const) {
    await t.test(name, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        ...picker,
        launch: true,
        ...options,
        ...(name === 'running after the stop' ? { process: () => true } : {}),
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      assert.equal(c.now(), 121_500);
      const error = refusal(result);
      assert.equal(error.meta.relaunches, 1);
      assert.equal(error.meta.relaunchFailed, true);
      assert.equal(error.meta.lastStarted, 'relaunch');
      assert.ok(error.message.includes(`; relaunch failed: ${words}`), error.message);
      assert.doesNotMatch(error.message, /exit 1 for|recovery start command/);
      assert.equal(r.names().filter((n) => n === 'start').length, starts);
    });
  }
});

test('R9b: a failed restart keeps the count this launch showed, never the rebased one', async (t) => {
  for (const [name, deadFrom, at, request] of [
    ['decided before the count was due', 0, 46_000, 'unknown'],
    ['decided with a request seen', 125_000, 137_500, 'received'],
  ] as const) {
    await t.test(name, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: () => 'unknown',
        wait: () => 'empty',
        // A request was recorded (3 at launch, 4 since): the rebase moves the baseline to 4.
        counter: () => 4,
        process: (phase) => phase === 'before' && c.now() < deadFrom,
        launch: true,
        start: 'reject',
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      assert.equal(c.now(), at);
      const error = refusal(result);
      assert.equal(error.meta.relaunches, 1);
      assert.equal(error.meta.relaunchFailed, true);
      assert.equal(error.meta.liveness, 'dead');
      assert.equal(error.meta.bundleRequest, request);
      assert.equal(r.names().filter((n) => n === 'start').length, 1);
      assert.doesNotMatch(error.message, /no bundle request|build outcomes could not be read/);
    });
  }
});

test('R11: a start that never answers ends with the run, never as a lost failure', async (t) => {
  await t.test('cancelled', async (t) => {
    const c = clock(t);
    const r = rig(c, { ...picker, launch: true, start: 'never' });
    const result = c.watch(admit(r.steps, c.stop));
    await c.advanceUntil(() => r.names().includes('start'), 200_000);
    c.stop.begin();
    await c.until(result, 200_000);
    assert.equal(result.error?.code, 'RUN_CANCELLED');
    assert.equal(r.decisions.includes('refused'), false);
  });
  await t.test('the walk deadline', async (t) => {
    const c = clock(t);
    const r = rig(c, { ...picker, launch: true, start: 'never', walkMs: 336_000 });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 400_000);
    assert.equal(c.now(), 336_000);
    const error = refusal(result);
    assert.equal(error.meta.relaunchFailed, true);
    assert.equal(error.meta.liveness, 'not_probed');
    assert.equal(error.meta.lastStarted, 'relaunch');
    assert.ok(
      error.message.includes('; relaunch failed: the walk budget ended during the restart'),
    );
  });
  await t.test('the walk deadline after a recorded request keeps the count', async (t) => {
    const c = clock(t);
    const r = rig(c, {
      reader: () => 'unknown',
      wait: () => 'empty',
      // 3 at launch, 4 since: the rebase moves the baseline to 4 before the start that never answers.
      counter: () => 4,
      process: (phase) => phase === 'before' && c.now() < 125_000,
      launch: true,
      start: 'never',
      walkMs: 400_000,
    });
    const result = c.watch(admit(r.steps, c.stop));
    await c.until(result, 500_000);
    assert.equal(c.now(), 400_000);
    const error = refusal(result);
    assert.equal(error.meta.bundleRequest, 'received');
    assert.equal(error.meta.liveness, 'not_probed');
    assert.equal(error.meta.relaunchFailed, true);
    assert.equal(r.names().filter((n) => n === 'start').length, 1);
    assert.doesNotMatch(error.message, /no bundle request/);
    assert.ok(
      error.message.includes('; relaunch failed: the walk budget ended during the restart'),
    );
  });
});

test('R12: a death read keeps a healthy start its next full wait', async (t) => {
  for (const [walkMs, reads] of [
    [300_999, [46_000, 76_500, 107_000, 137_500, 168_000, 198_500, 229_000]],
    [301_000, [46_000, 76_500, 107_000, 137_500, 168_000, 198_500, 229_000, 259_500]],
  ] as const) {
    await t.test(`walk ${walkMs} ms`, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: () => 'unknown',
        wait: (now) => (now < 259_000 ? 'empty' : 'listed'),
        walkMs,
        requested: () => true,
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 400_000);
      assert.equal(result.error, undefined, String(result.error?.message));
      assert.equal(c.now(), 260_000);
      assert.deepEqual(r.calls.process, reads);
    });
  }
});

test('R13: an unanswered list still reads the process', async (t) => {
  for (const launch of [false, true]) {
    await t.test(launch ? 'with a launch URL' : 'without', async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: () => 'unknown',
        wait: (_now, restart) => (restart === undefined ? 'unanswered' : 'listed'),
        walkMs: 300_000,
        requested: () => false,
        process: launch ? (phase) => phase === 'started' : false,
        ...(launch ? { launch: true as const } : {}),
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 400_000);
      if (!launch) {
        assert.equal(c.now(), 46_000);
        const error = refusal(result);
        assert.equal(error.meta.inner, 'target_list_attempt_timeout');
        assert.equal(error.meta.liveness, 'dead');
        return;
      }
      assert.equal(result.error, undefined, String(result.error?.message));
      assert.deepEqual(
        r.events.filter(([name]) => name === 'start'),
        [['start', 46_000]],
      );
    });
  }
});

test('R14: after a listing nothing restarts the app', async (t) => {
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
    requested: () => false,
    process: false,
    launch: true,
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
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.relaunches, 0);
  assert.deepEqual(r.names(), ['process']);
});

test('R15: the factory exposes the restart only for a checked target, in its order', async () => {
  const base = { appId: APP, serial: SERIAL, metroPort: 8081, process: async () => false };
  const keys = (options: Record<string, unknown>) =>
    Object.keys(androidStartSteps({ ...base, ...options })).sort();
  const four = ['refusalNote', 'startCounts', 'startHeld', 'startProcess'];
  assert.deepEqual(keys({}), four);
  assert.deepEqual(keys({ launchUrl: URL_8081 }), [...four, 'startRecovery'].sort());
  for (const options of [
    { launchUrl: URL_8081, metroPort: 8082 },
    { launchUrl: URL_8081.replace('127.0.0.1', '10.0.2.2') },
    { launchUrl: URL_8081 + '%26x%3D1' },
    { launchUrl: 'bad;://expo-development-client/?url=' },
    { launchUrl: URL_8081, appId: 'com.example;rm' },
    { launchUrl: URL_8081, serial: '' },
    { launchUrl: URL_8081, serial: 'a b' },
    { launchUrl: URL_8081, metroPort: undefined },
  ])
    assert.deepEqual(keys(options), four, JSON.stringify(options));
  const order: string[] = [];
  const lines: string[] = [];
  let state = 'holding';
  const steps = androidStartSteps({
    ...base,
    launchUrl: URL_8081,
    bundleRequests: {
      requested: () => false,
      built: () => 'none',
      relaunching: () => order.push('relaunching'),
    },
    gate: { note: () => '', state: () => state, restart: () => order.push('restart') },
    process: async () => {
      order.push('process');
      return false;
    },
    driver: async () => 'clear',
    stop: async () => {
      order.push('stop');
    },
    start: async (_a, _s, url) => {
      order.push('start');
      assert.equal(url, URL_8081);
      return 'sent';
    },
    log: (line) => lines.push(line),
    at: () => 7,
  });
  assert.equal(steps.startHeld(), true);
  state = 'let_through';
  assert.equal(steps.startHeld(), false);
  await steps.startRecovery?.relaunch();
  assert.deepEqual(order, ['stop', 'process', 'relaunching', 'start', 'restart']);
  assert.deepEqual(lines, [
    'android start: restart: the app was stopped at 7 ms; sending the same start once',
    'android start: restart: start sent at 7 ms',
  ]);
  assert.ok(lines.every((line) => !line.includes('expo-development-client')));
  assert.equal(await steps.startRecovery?.driver(), 'clear');
});

// The promisified execFile of android-app-process.test.ts, answering each adb call in turn.
function adb(t: TestContext, answers: ((args: string[], options: any) => unknown)[]) {
  const calls: { args: string[]; options: any }[] = [];
  const execute = (() => {
    throw new Error('use the promise boundary');
  }) as typeof childProcess.execFile;
  Object.defineProperty(execute, promisify.custom, {
    value: async (file: string, args: string[], options: any) => {
      assert.equal(file, 'adb');
      calls.push({ args, options });
      const answer = answers.shift();
      assert.ok(answer, 'no more adb answers were scripted');
      return answer(args, options);
    },
  });
  const original = childProcess.execFile;
  childProcess.execFile = execute;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  });
  return calls;
}
const fail = (fields: Record<string, unknown>) => () => {
  throw Object.assign(new Error('Command failed'), fields);
};

test('R16: the default driver check is the strict process-table probe', async (t) => {
  const table = 'USER PID NAME\nroot 1 init\n';
  const steps = () =>
    androidStartSteps({ appId: APP, serial: SERIAL, metroPort: 8081, launchUrl: URL_8081 });
  for (const [name, answer, status] of [
    ['empty table', () => ({ stdout: '', stderr: '' }), 'unknown'],
    ['failed read', fail({ code: 1, stdout: '', stderr: 'device offline' }), 'unknown'],
    [
      'a Maestro driver',
      () => ({ stdout: table + 'shell 9 dev.mobile.maestro\n', stderr: '' }),
      'busy',
    ],
    [
      'an instrumentation',
      () => ({
        stdout: table + 'shell 9 app_process /system/bin com.android.commands.instrument\n',
        stderr: '',
      }),
      'busy',
    ],
    [
      'QaReN runner only',
      () => ({ stdout: table + 'shell 9 dev.lykhoyda.rndevagent.androidrunner\n', stderr: '' }),
      'clear',
    ],
    ['clear', () => ({ stdout: table, stderr: '' }), 'clear'],
  ] as const) {
    await t.test(name, async (t) => {
      const calls = adb(t, [answer]);
      assert.equal(await steps().startRecovery?.driver(), status);
      assert.deepEqual(
        calls.map(({ args }) => args),
        [['-s', SERIAL, 'shell', 'ps', '-A']],
      );
      assert.equal(calls[0].options.timeout, 2000);
    });
  }
});

test('G1: a restarted gate holds the new start again', async (t) => {
  for (const first of ['unknown', 'loaded'] as const) {
    await t.test(`after ${first}`, async (t) => {
      const c = clock(t);
      let answer: Reader = first;
      const reads: number[] = [];
      const gate = androidStartGate({
        read: async () => {
          reads.push(c.now());
          return answer;
        },
        log: () => undefined,
        at: () => c.now(),
      });
      const opened = c.watch(gate.wait(30_000));
      await c.until(opened, 40_000);
      assert.equal(opened.error, undefined);
      assert.equal(gate.state(), first === 'loaded' ? 'loaded' : 'let_through');
      gate.restart();
      assert.equal(gate.state(), 'undecided');
      answer = 'loading';
      const before = c.now();
      const readsBefore = reads.length;
      const held = c.watch(gate.wait(30_000));
      await c.until(held, 100_000);
      assert.ok(held.error instanceof TargetReadinessTimeoutError);
      assert.equal(c.now(), before + 30_000);
      assert.equal(reads[readsBefore], before, 'the first read after restart() comes at once');
      answer = 'loaded';
      const released = c.watch(gate.wait(30_000));
      await c.until(released, 200_000);
      assert.equal(released.error, undefined);
      assert.equal(gate.state(), 'loaded');
    });
  }
});

test('N1: the note opens with what QaReN did to the start', () => {
  const base: AdmissionRefusalFacts = {
    attempt: 1,
    lastStarted: 'attach',
    lastCompleted: 'none',
    inner: 'target_readiness_timeout',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'dead',
    elapsedMs: 0,
    remainingMs: 0,
    budgetMs: 0,
  };
  const dead = "; the app's process was not running";
  const note = (facts: Partial<AdmissionRefusalFacts>) =>
    androidStartNote({ ...base, ...facts }, '');
  assert.equal(note({}), dead);
  assert.equal(note({ relaunches: 1 }), RESTARTED + dead);
  assert.equal(note({ relaunches: 1, relaunchFailed: true }), dead);
  assert.equal(
    note({ relaunchBlocked: 'driver_busy' }),
    "; QaReN did not restart the app: the device's process table matched another automation driver" +
      dead,
  );
  assert.equal(
    note({ relaunchBlocked: 'device_unreadable' }),
    '; QaReN did not restart the app: the device did not answer the reads needed before a force-stop' +
      dead,
  );
});

test('R17: a death read that crosses the attach budget does not make the count due', async (t) => {
  const c = clock(t);
  const slow = rig(c, {
    reader: () => 'unknown',
    wait: () => 'empty',
    requested: () => false,
    processMs: 6000,
  });
  const result = c.watch(admit(slow.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(c.now(), 161_500);
  const error = refusal(result);
  assert.equal(error.meta.bundleRequest, 'not_received');
  assert.equal(error.meta.liveness, 'alive');
  assert.deepEqual(slow.calls.process, [46_000, 82_500, 119_000, 155_500]);
  assert.deepEqual(slow.calls.requested, [155_500]);
});

test('R6c: below 60 s of attach budget the restarted start still gets the CLI first-pid grace', async (t) => {
  for (const walkMs of [199_900, 200_000]) {
    await t.test(`walk ${walkMs} ms`, async (t) => {
      const c = clock(t);
      const r = rig(c, {
        reader: () => 'unknown',
        wait: () => 'empty',
        attachBudgetMs: 30_000,
        walkMs,
        requested: () => true,
        process: false,
        launch: true,
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 400_000);
      const error = refusal(result);
      assert.equal(error.meta.liveness, 'dead');
      if (walkMs === 199_900) {
        // 46 + 94 + 60 = 200 s of walk are needed.
        assert.equal(c.now(), 46_000);
        assert.equal(error.meta.relaunches, 0);
        assert.deepEqual(r.calls.process, [46_000]);
        return;
      }
      // Judged from 46 + 60 = 106 s, not 46 + 30: the waits fail at 92.5 and 123.0 s.
      assert.equal(c.now(), 123_000);
      assert.equal(error.meta.relaunches, 1);
      assert.deepEqual(r.calls.process, [46_000, 46_000, 46_000, 123_000]);
    });
  }
});

test('R7c: an unreadable count re-read keeps the app and its baseline', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: (now) => (now < 150_000 ? 'loading' : 'loaded'),
    requested: (_now, call) => (call === 1 ? false : call === 2 ? undefined : true),
    launch: true,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.equal(c.now(), 150_000);
  assert.deepEqual(r.events, [['driver', 121_500]]);
});

test('R18: a restarted start that dies late while its gate holds is refused at its first let-through wait, never past the walk', async (t) => {
  for (const walkMs of [1_200_000, 336_000]) {
    await t.test(`walk ${walkMs} ms`, async (t) => {
      const c = clock(t);
      // Restarted at 121.5 s (judged from 241.5 s); the restarted start loads, asks for its bundle, and dies at 290 s.
      const r = rig(c, {
        reader: (now, restart) => (restart === undefined || now < 290_000 ? 'loading' : 'unknown'),
        wait: () => 'empty',
        walkMs,
        requested: (_now, call) => call > 2,
        process: (phase) => (phase === 'started' ? c.now() < 290_000 : phase === 'before'),
        launch: true,
      });
      const result = c.watch(admit(r.steps, c.stop));
      await c.until(result, 1_300_000);
      const error = refusal(result);
      assert.equal(error.meta.relaunches, 1);
      assert.equal(error.meta.bundleRequest, 'received');
      // Held turns from 241.5 s read Metro's count, never the process; the gate lets the start through at 305.0 s, its wait fails at 335.0 s.
      if (walkMs === 336_000) {
        assert.equal(c.now(), 336_000);
        assert.equal(error.meta.liveness, 'not_probed');
        assert.deepEqual(r.calls.process, [121_500]);
        return;
      }
      assert.equal(c.now(), 335_000);
      assert.equal(error.meta.liveness, 'dead');
      assert.deepEqual(r.calls.process, [121_500, 335_000]);
    });
  }
});

test('R19: the blocked word survives every cleaner the facts pass', async () => {
  const { cleanAdmissionFacts } = await import('../../../dist/qa/admission-facts.js');
  const { cleanTimingEvent } = await import('../../../dist/qa/timing.js');
  const { admissionMetric, formatAdmissionRefusal } = await import('../../../dist/qa/admission.js');
  const facts: AdmissionRefusalFacts = {
    attempt: 4,
    lastStarted: 'relaunch',
    lastCompleted: 'retry_wait',
    inner: 'target_readiness_timeout',
    relaunches: 0,
    relaunchFailed: false,
    relaunchBlocked: 'driver_busy',
    liveness: 'alive',
    bundleRequest: 'not_received',
    elapsedMs: 121_500,
    remainingMs: 1_078_500,
    budgetMs: 1_200_000,
  };
  for (const word of ['driver_busy', 'device_unreadable'] as const) {
    const blocked = { ...facts, relaunchBlocked: word };
    assert.equal(cleanAdmissionFacts(blocked)?.relaunchBlocked, word);
    assert.equal(JSON.parse(formatAdmissionRefusal(blocked)).relaunchBlocked, word);
    assert.equal(
      cleanTimingEvent(admissionMetric('refused', blocked, 'wait_targets', 121_500))
        ?.relaunchBlocked,
      word,
    );
  }
  assert.equal(cleanAdmissionFacts({ ...facts, relaunchBlocked: 'busy' }), undefined);
  assert.equal(
    cleanTimingEvent(
      admissionMetric(
        'refused',
        { ...facts, relaunchBlocked: 'busy' as never },
        'wait_targets',
        121_500,
      ),
    ),
    undefined,
  );
  assert.equal(
    JSON.parse(formatAdmissionRefusal({ ...facts, relaunchBlocked: 'busy' as never }))
      .relaunchBlocked,
    'unknown',
  );
});

test('R17b: a death read that never answers is cut at 11 s and decides nothing', async (t) => {
  const c = clock(t);
  const r = rig(c, {
    reader: () => 'unknown',
    wait: (now) => (now < 57_000 ? 'empty' : 'listed'),
    requested: () => true,
    process: (_phase, call) => (call === 1 ? 'never' : true),
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.equal(c.now(), 57_500);
  assert.deepEqual(r.calls.process, [46_000]);
});

test('R20: device row D4 in the rig: the restarted start dead after its bundle request is refused as dead after the restart, inside the bound', async (t) => {
  const c = clock(t);
  let restartedAt: number | undefined;
  const dead = (now: number) =>
    now >= 20_000 && (restartedAt === undefined || now >= restartedAt + 5_000);
  const r = rig(c, {
    // The first start loads and is killed at 20 s; the restarted one is killed 5 s after its start.
    reader: (now, restart) => {
      restartedAt = restart;
      return dead(now) ? 'unknown' : 'loading';
    },
    wait: () => 'empty',
    requested: () => true,
    process: (phase) => (phase === 'stopped' ? false : !dead(c.now())),
    launch: true,
  });
  const result = c.watch(admit(r.steps, c.stop));
  await c.until(result, 1_300_000);
  const error = refusal(result);
  assert.equal(error.meta.liveness, 'dead');
  assert.equal(error.meta.bundleRequest, 'received');
  assert.equal(error.meta.relaunches, 1);
  assert.equal(error.meta.relaunchFailed, false);
  assert.equal(error.meta.inner, 'target_list_empty');
  const start = r.events.find(([name]) => name === 'start')?.[1];
  assert.ok(start !== undefined);
  // The contract only: the restarted start's death, refused inside D4's bound. Which read first saw the death is not asserted.
  assert.equal(start, 64_500);
  assert.equal(c.now(), 206_500);
  assert.ok(c.now() >= start + 120_000 && c.now() <= start + 120_000 + 41_500);
  assert.deepEqual(
    r.names().filter((name) => name === 'start'),
    ['start'],
  );
});
