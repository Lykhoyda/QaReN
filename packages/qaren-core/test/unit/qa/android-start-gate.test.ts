import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { androidStartGate } from '../../../dist/qa/android-start-gate.js';
import { admit, type AdmissionSteps } from '../../../dist/qa/admission.js';
import { createStop } from '../../../dist/qa/stop.js';
import { sleep, withCancellation } from '../../../dist/domain/cancellation.js';
import { CDPProbeTimeoutError } from '../../../dist/cdp/connect.js';
import { TargetReadinessTimeoutError } from '../../../dist/cdp/discovery.js';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;
type Outcome = { value?: unknown; error?: any; done: boolean };
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
    async advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
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
    async until(outcome: Outcome, end: number) {
      await nextTurn();
      while (!outcome.done && now < end) {
        now += 100;
        t.mock.timers.tick(100);
        await nextTurn();
      }
      assert.ok(outcome.done, `operation still pending at ${now} ms`);
    },
  };
}
function harness(
  c: ReturnType<typeof clock>,
  read: () => Promise<string>,
  walkMs = 1_200_000,
  logOffsetMs = 0,
) {
  const logs: string[] = [];
  const calls: string[] = [];
  const firstCall: Record<string, number> = {};
  const observations: any[] = [];
  const gate = androidStartGate({
    read,
    log: (line) => logs.push(line),
    at: () => c.now() + logOffsetMs,
  });
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    attachBudgetMs: 120_000,
    remainingMs: () => walkMs - c.now(),
    waitTargets: async (deadline) => {
      const window = () => Math.max(1, Math.min(30_000, steps.remainingMs(), deadline - c.now()));
      await gate.wait(window());
      calls.push('targets');
      firstCall.targets ??= c.now();
    },
    attach: async () => {
      calls.push('attach');
      firstCall.attach ??= c.now();
    },
    foreignDriver: async () => {
      calls.push('driver');
      return undefined;
    },
    open: async () => {
      calls.push('open');
    },
    prove: async () => {
      calls.push('prove');
      return PROVEN;
    },
    close: async () => {
      calls.push('close');
    },
    refusalNote: () => gate.note(),
    observe: (decision, facts) => observations.push({ decision, ...facts }),
    load: () => 1,
  };
  return { gate, logs, calls, firstCall, observations, steps };
}

test('H1: loading holds target discovery and attach for three windows', async (t) => {
  const c = clock(t);
  const h = harness(c, async () => (c.now() < 90_000 ? 'loading' : 'loaded'));
  const result = c.watch(admit(h.steps, c.stop));
  await nextTurn();
  while (c.now() < 89_000) {
    await c.advance(100);
    assert.deepEqual(h.calls, [], 'no target wait or debugger call during loading');
  }
  await c.until(result, 95_000);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, PROVEN);
  assert.deepEqual(h.calls, ['targets', 'attach', 'driver', 'open', 'prove']);
  assert.ok(h.observations.filter((o) => o.decision === 'retry').length >= 2);
  assert.ok(h.observations.every((o) => o.inner === 'target_readiness_timeout'));
});

for (const [index, targetMs, openMs, end, refuses] of [
  [1, 0, 100_000, 260_000, false],
  [2, 0, 115_000, 270_000, true],
  [3, 20_000, 100_000, 280_000, false],
  [4, 20_000, 115_000, 290_000, true],
] as const) {
  test(`H2 case ${index}: registration after target wait owns the shared attach budget`, async (t) => {
    const c = clock(t);
    const h = harness(c, async () => (c.now() < 150_000 ? 'loading' : 'loaded'));
    const wait = h.steps.waitTargets!;
    h.steps.waitTargets = async (deadline) => {
      await wait(deadline);
      if (targetMs) await sleep(targetMs);
    };
    h.steps.attach = async () => {
      h.calls.push('attach');
      await sleep(10_000);
    };
    h.steps.open = async () => {
      h.calls.push('open');
      await sleep(openMs);
    };
    const result = c.watch(admit(h.steps, c.stop));
    await c.until(result, end + 1000);
    assert.equal(c.now(), end);
    if (refuses) {
      assert.equal(result.error?.code, 'CDP_NOT_CONNECTED');
      assert.match(result.error.message, /Registered-target attach deadline exceeded/);
      assert.equal(result.error.meta.lastStarted, 'open');
      assert.equal(result.error.meta.lastCompleted, 'foreign_driver');
    } else {
      assert.equal(result.error, undefined);
      assert.deepEqual(result.value, PROVEN);
    }
  });
}

test('H3: a held start ends at the walk budget with its state note and closes once', async (t) => {
  const c = clock(t);
  const h = harness(c, async () => 'loading', 300_000);
  const result = c.watch(admit(h.steps, c.stop));
  await c.until(result, 300_000);
  assert.equal(c.now(), 300_000);
  assert.equal(result.error?.code, 'CDP_NOT_CONNECTED');
  assert.equal(result.error.meta.inner, 'target_readiness_timeout');
  assert.ok(
    result.error.message.endsWith(
      "; the app's first views had not appeared, so no debugger was attached",
    ),
  );
  assert.deepEqual(h.calls, ['close']);
});

for (const kind of ['unknown', 'reject', 'invalid'] as const) {
  test(`H4 ${kind}: no answer for 15 s releases the same wait permanently`, async (t) => {
    const c = clock(t);
    let reads = 0;
    let attaches = 0;
    let waits = 0;
    const h = harness(c, async () => {
      reads++;
      if (kind === 'reject') throw new Error('unreadable');
      return kind === 'invalid' ? 'unexpected' : 'unknown';
    });
    const wait = h.steps.waitTargets!;
    h.steps.waitTargets = async (deadline) => {
      waits++;
      await wait(deadline);
    };
    h.steps.attach = async () => {
      attaches++;
      throw new CDPProbeTimeoutError('not ready');
    };
    const result = c.watch(admit(h.steps, c.stop));
    await nextTurn();
    while (c.now() < 15_900) {
      await c.advance(100);
      assert.equal(attaches, 0, 'no attach before 15 s without an answer');
      assert.deepEqual(h.calls, []);
    }
    await c.advance(100);
    assert.equal(c.now(), 16_000);
    assert.equal(attaches, 1, 'the first answer at or after 15 s permits discovery in this call');
    assert.equal(waits, 1);
    assert.equal(reads, 9);
    await c.until(result, 140_000);
    assert.equal(reads, 9, 'no read after the let-through');
    assert.ok(attaches >= 6);
    assert.equal(c.now(), 136_000);
    assert.ok(
      result.error.message.endsWith(
        '; the first-views check could not be read; attaching a debugger was allowed as before',
      ),
    );
    assert.equal(h.gate.state(), 'let_through');
    assert.deepEqual(h.logs, [
      'android start: first-views check not answered at 0 ms; asking again',
      'android start: first-views check unavailable at 16000 ms; attaching as before',
    ]);
  });
}

for (const kind of [
  'pending-stop',
  'sleep-stop',
  'pending-deadline',
  'asking-again-stop',
  'asking-again-deadline',
] as const) {
  test(`H5 ${kind}: abort preserves the gate state and never permits attach`, async (t) => {
    const c = clock(t);
    const askingAgain = kind.startsWith('asking-again');
    const deadline = kind.endsWith('deadline');
    const h = harness(
      c,
      async () =>
        kind === 'sleep-stop' ? 'loading' : askingAgain ? 'unknown' : new Promise<string>(() => {}),
      1000,
    );
    const result = c.watch(admit(h.steps, c.stop));
    await nextTurn();
    const state = h.gate.state();
    if (deadline) await c.advance(1000);
    else {
      c.stop.begin();
      await nextTurn();
    }
    assert.ok(result.done);
    assert.equal(result.error?.code, deadline ? 'CDP_NOT_CONNECTED' : 'RUN_CANCELLED');
    assert.equal(h.gate.state(), state);
    assert.deepEqual(h.calls, ['close']);
    assert.ok(!h.logs.some((line) => line.includes('unavailable')));
    if (deadline)
      assert.ok(
        result.error.message.endsWith(
          '; the first-views check had not answered, so no debugger was attached',
        ),
      );
    if (askingAgain) {
      assert.equal(state, 'undecided');
      assert.deepEqual(h.logs, [
        'android start: first-views check not answered at 0 ms; asking again',
      ]);
    }
  });
}

test('H6: poll spacing survives fast reads and retry windows', async (t) => {
  const c = clock(t);
  const reads: number[] = [];
  const gate = androidStartGate({
    read: async () => {
      reads.push(c.now());
      return 'loading';
    },
    log: () => {},
    at: c.now,
  });
  const first = c.watch(withCancellation(c.stop.signal, () => gate.wait(2100)));
  await nextTurn();
  assert.deepEqual(reads, [0], 'first read has no sleep');
  await c.advance(2000);
  await c.advance(100);
  assert.ok(first.error instanceof TargetReadinessTimeoutError);
  assert.equal(first.error.constructor, TargetReadinessTimeoutError);
  assert.equal(first.error.state, undefined);
  await c.advance(500);
  const second = c.watch(withCancellation(c.stop.signal, () => gate.wait(2100)));
  await nextTurn();
  assert.deepEqual(reads, [0, 2000]);
  await c.advance(1400);
  assert.deepEqual(reads, [0, 2000, 4000]);
  c.stop.begin();
  await nextTurn();
  assert.ok(second.done);
});

test('H6: a slow pending read can overrun only its current window', async (t) => {
  const c = clock(t);
  const reads: number[] = [];
  const gate = androidStartGate({
    read: async () => {
      reads.push(c.now());
      if (reads.length === 2) await sleep(5000);
      return 'loading';
    },
    log: () => {},
    at: c.now,
  });
  const result = c.watch(withCancellation(c.stop.signal, () => gate.wait(2500)));
  await nextTurn();
  await c.advance(2000);
  await c.advance(500);
  assert.equal(result.done, false, 'window end does not abandon an in-flight read');
  await c.advance(4500);
  assert.ok(result.error instanceof TargetReadinessTimeoutError);
  assert.deepEqual(reads, [0, 2000]);
  assert.equal(c.now(), 7000);
});

test('H6 loaded: terminal state adds no sleep or later reads', async (t) => {
  const c = clock(t);
  let reads = 0;
  const gate = androidStartGate({
    read: async () => {
      reads++;
      return 'loaded';
    },
    log: () => {},
    at: c.now,
  });
  const result = c.watch(
    withCancellation(c.stop.signal, async () => {
      await gate.wait(30_000);
      await gate.wait(30_000);
    }),
  );
  await nextTurn();
  assert.equal(result.done, true);
  assert.equal(c.now(), 0);
  assert.equal(reads, 1);
});

test('H6 unknown: after the give-up a later wait adds no sleep or read', async (t) => {
  const c = clock(t);
  const reads: number[] = [];
  const gate = androidStartGate({
    read: async () => {
      reads.push(c.now());
      return 'unknown';
    },
    log: () => {},
    at: c.now,
  });
  const first = c.watch(withCancellation(c.stop.signal, () => gate.wait(30_000)));
  await c.until(first, 30_000);
  assert.equal(first.error, undefined);
  assert.equal(c.now(), 16_000);
  assert.equal(gate.state(), 'let_through');
  const second = c.watch(withCancellation(c.stop.signal, () => gate.wait(30_000)));
  await nextTurn();
  assert.equal(second.done, true);
  assert.equal(second.error, undefined);
  assert.equal(c.now(), 16_000);
  assert.deepEqual(reads, [0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 16_000]);
});

for (const kind of ['absent', 'text', 'throws'] as const) {
  test(`N1 ${kind}: optional refusal note preserves the refusal type`, async (t) => {
    const c = clock(t);
    let reads = 0;
    const h = harness(c, async () => 'loaded');
    delete h.steps.refusalNote;
    h.steps.attach = async () => {
      throw new Error('synthetic failure');
    };
    if (kind !== 'absent')
      h.steps.refusalNote = () => {
        reads++;
        if (kind === 'throws') throw new Error('note failed');
        return '; synthetic note';
      };
    const result = c.watch(admit(h.steps, c.stop));
    await nextTurn();
    assert.equal(result.error?.code, 'CDP_NOT_CONNECTED');
    assert.equal(result.error.meta.inner, 'untyped');
    assert.equal(result.error.message.endsWith('; synthetic note'), kind === 'text');
    assert.equal(reads, kind === 'absent' ? 0 : 1);
  });
}

test('N1: state notes name the first views and preserve the no-answer state', async (t) => {
  const c = clock(t);
  const gate = androidStartGate({ read: async () => 'loading', log: () => {}, at: c.now });
  assert.equal(
    gate.note(),
    '; the first-views check had not answered, so no debugger was attached',
  );
  const result = c.watch(withCancellation(c.stop.signal, () => gate.wait(1)));
  await nextTurn();
  await c.advance(1);
  assert.ok(result.error instanceof TargetReadinessTimeoutError);
  assert.equal(
    gate.note(),
    "; the app's first views had not appeared, so no debugger was attached",
  );
});

test('N1: refusals built by another owner receive no attach note', async (t) => {
  const c = clock(t);
  let reads = 0;
  const h = harness(c, async () => 'loaded');
  h.steps.foreignDriver = async () => 'foreign driver';
  h.steps.refusalNote = () => {
    reads++;
    return '; should not appear';
  };
  const result = c.watch(admit(h.steps, c.stop));
  await nextTurn();
  assert.equal(result.error?.code, 'BUSY_FOREIGN_FLOW');
  assert.equal(reads, 0);
  assert.equal(result.error.message, 'foreign driver');
});

test('H8: an early unanswered start asks again, then loading holds until loaded', async (t) => {
  const c = clock(t);
  const h = harness(
    c,
    async () => (c.now() < 4000 ? 'unknown' : c.now() < 10_000 ? 'loading' : 'loaded'),
    1_200_000,
    500,
  );
  const result = c.watch(admit(h.steps, c.stop));
  await nextTurn();
  while (c.now() < 9900) {
    await c.advance(100);
    assert.deepEqual(h.calls, [], 'no target wait or attach before 10 s');
  }
  await c.until(result, 11_000);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, PROVEN);
  assert.deepEqual(h.firstCall, { targets: 10_000, attach: 10_000 });
  assert.deepEqual(h.calls, ['targets', 'attach', 'driver', 'open', 'prove']);
  assert.deepEqual(h.logs, [
    'android start: first-views check not answered at 500 ms; asking again',
    "android start: holding the debugger until the app's first views at 4500 ms",
    'android start: first views seen at 10500 ms; attaching',
  ]);
});

// Runs the gate alone the way the admission retries it: a window, then 500 ms, then the next.
async function untilReleased(
  t: TestContext,
  windowMs: number,
  answer: (startedAt: number) => string,
  readMs = 0,
) {
  const c = clock(t);
  const reads: number[] = [];
  const logs: string[] = [];
  const ends: { at: number; state: string; note: string }[] = [];
  const gate = androidStartGate({
    read: async () => {
      const startedAt = c.now();
      reads.push(startedAt);
      if (readMs) await sleep(readMs);
      return answer(startedAt);
    },
    log: (line) => logs.push(line),
    at: () => c.now() + 500,
  });
  const result = c.watch(
    withCancellation(c.stop.signal, async () => {
      for (;;) {
        try {
          await gate.wait(windowMs);
          return;
        } catch (error: any) {
          assert.equal(error.constructor, TargetReadinessTimeoutError);
          assert.equal(error.state, undefined);
          ends.push({ at: c.now(), state: gate.state(), note: gate.note() });
          await sleep(500);
        }
      }
    }),
  );
  await c.until(result, 90_000);
  assert.equal(result.error, undefined);
  const released = c.now();
  const later = c.watch(withCancellation(c.stop.signal, () => gate.wait(windowMs)));
  await nextTurn();
  assert.ok(later.done && later.error === undefined, 'a later wait returns at once');
  assert.equal(c.now(), released);
  return { reads, logs, ends, released, gate };
}

function polled(reads: number[]) {
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i] - reads[i - 1] >= 2000);
}

test('H9: no answer lets through at the first answer at or after 15 s in one window', async (t) => {
  const r = await untilReleased(t, 30_000, () => 'unknown');
  assert.equal(r.released, 16_000);
  assert.deepEqual(r.reads, [0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 16_000]);
  assert.deepEqual(r.ends, []);
  assert.equal(r.gate.state(), 'let_through');
  assert.deepEqual(r.logs, [
    'android start: first-views check not answered at 500 ms; asking again',
    'android start: first-views check unavailable at 16500 ms; attaching as before',
  ]);
});

test('H9: the 15 s survive short windows, each ending with the bare readiness error', async (t) => {
  const r = await untilReleased(t, 6000, () => 'unknown');
  polled(r.reads);
  assert.ok(r.ends.length >= 2, 'several windows end before the let-through');
  for (const end of r.ends) {
    assert.ok(end.at < 15_000);
    assert.equal(end.state, 'undecided');
    assert.equal(end.note, '; the first-views check had not answered, so no debugger was attached');
  }
  assert.equal(r.released, r.reads.at(-1));
  assert.ok(r.released >= 15_000 && r.released <= 17_000);
  assert.ok(r.reads.at(-2)! < 15_000);
  assert.equal(r.logs.filter((line) => line.includes('unavailable')).length, 1);
  assert.equal(r.logs.filter((line) => line.includes('not answered')).length, 1);
});

test('H9: the 15 s are counted from the first ask, not from its answer', async (t) => {
  const r = await untilReleased(t, 60_000, () => 'unknown', 1000);
  assert.equal(r.released, 15_000);
  assert.deepEqual(r.reads, [0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000]);
  assert.equal(
    r.logs.at(-1),
    'android start: first-views check unavailable at 15500 ms; attaching as before',
  );
});

test('H10: a short run of failed reads during the load keeps the hold', async (t) => {
  const c = clock(t);
  const h = harness(c, async () =>
    c.now() <= 20_000
      ? 'loading'
      : c.now() < 27_000
        ? 'unknown'
        : c.now() < 40_000
          ? 'loading'
          : 'loaded',
  );
  const result = c.watch(admit(h.steps, c.stop));
  await nextTurn();
  while (c.now() < 39_900) {
    await c.advance(100);
    assert.deepEqual(h.calls, [], 'no target wait or attach before 40 s');
  }
  await c.until(result, 43_000);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, PROVEN);
  assert.ok(h.firstCall.targets >= 40_000 && h.firstCall.targets <= 42_000);
  assert.equal(h.firstCall.attach, h.firstCall.targets);
  assert.equal(h.logs.filter((line) => line.includes('not answered')).length, 1);
  assert.equal(h.logs.filter((line) => line.includes('holding')).length, 1);
  assert.equal(h.logs.filter((line) => line.includes('unavailable')).length, 0);
  assert.match(h.logs.at(-1)!, /^android start: first views seen at \d+ ms; attaching$/);
});

test('H11: an app that stops answering after loading lets through 15 s after the last loading', async (t) => {
  const c = clock(t);
  const h = harness(c, async () => (c.now() <= 20_000 ? 'loading' : 'unknown'));
  const result = c.watch(admit(h.steps, c.stop));
  await nextTurn();
  while (c.now() < 34_900) {
    await c.advance(100);
    assert.deepEqual(h.calls, [], 'not let through before 35 s');
  }
  await c.until(result, 38_000);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, PROVEN);
  assert.ok(h.firstCall.targets >= 35_000 && h.firstCall.targets <= 37_000);
  assert.equal(h.gate.state(), 'let_through');
  assert.deepEqual(
    h.logs.map((line) => line.replace(/\d+ ms/, 'N ms')),
    [
      "android start: holding the debugger until the app's first views at N ms",
      'android start: first-views check not answered at N ms; asking again',
      'android start: first-views check unavailable at N ms; attaching as before',
    ],
  );
  assert.equal(
    h.logs[1],
    'android start: first-views check not answered at 22000 ms; asking again',
  );
  assert.equal(
    h.logs[2],
    `android start: first-views check unavailable at ${h.firstCall.targets} ms; attaching as before`,
  );
});

test('H11: the 15 s are counted from the moment loading answered', async (t) => {
  const r = await untilReleased(
    t,
    60_000,
    (startedAt) => (startedAt < 19_000 ? 'loading' : 'unknown'),
    1000,
  );
  assert.equal(r.released, 35_000);
  assert.equal(r.reads.at(-1), 34_000);
  assert.equal(r.gate.state(), 'let_through');
});
