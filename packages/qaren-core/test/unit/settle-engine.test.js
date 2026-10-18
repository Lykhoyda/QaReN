import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSettle, settleEnabled } from '../../dist/lifecycle/settle.js';

// Fake clock: sleep() advances time; now() reads it. No real timers.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
function seq(values) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

test('android: window not updating → window-gate settles in ~150ms', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      isWindowUpdating: async (timeoutMs) => {
        clock.advance(timeoutMs);
        return false;
      },
      snapshotHash: async () => {
        throw new Error('must not reach snapshot tier');
      },
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.deepEqual(
    { settled: out.settled, method: out.method },
    { settled: true, method: 'window-gate' },
  );
  assert.ok(out.ms <= 150, `expected ≤150ms, got ${out.ms}`);
});

test('android: window updating → falls to snapshot-eq and settles on equal hashes', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      isWindowUpdating: async () => true,
      snapshotHash: seq(['h1', 'h2', 'h2']),
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.equal(out.method, 'snapshot-eq');
  assert.equal(out.settled, true);
});

test('android: capability absent → snapshot-eq only (legacy degrade)', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    probes: { snapshotHash: seq(['a', 'a']), sleep: clock.sleep, now: clock.now },
  });
  assert.equal(out.method, 'snapshot-eq');
});

test('ios: SCREEN_STATIC never probes pixels and still requires equal snapshots', async () => {
  const clock = fakeClock();
  let pixelCalls = 0;
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    probes: {
      isScreenStatic: async () => {
        pixelCalls++;
        return true;
      },
      snapshotHash: seq(['first', 'second', 'second']),
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.deepEqual(
    { settled: out.settled, method: out.method },
    { settled: true, method: 'snapshot-eq' },
  );
  assert.equal(pixelCalls, 0);
});

test('ios: never static → snapshot-eq tier settles (perpetual animation, stable hierarchy)', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    probes: {
      isScreenStatic: async () => {
        clock.advance(300);
        return false;
      }, // each probe ≈2 screenshots
      snapshotHash: seq(['x', 'x']),
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.equal(out.method, 'snapshot-eq');
  assert.equal(out.settled, true);
});

test('ios: probe infra failure (null) skips straight to snapshot tier', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    probes: {
      isScreenStatic: async () => null,
      snapshotHash: seq(['x', 'x']),
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.equal(out.method, 'snapshot-eq');
});

test('budget exhaustion → settled:false, method:timeout (never hangs)', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    budgetMs: 1000,
    probes: {
      isScreenStatic: async () => {
        clock.advance(300);
        return false;
      },
      snapshotHash: (() => {
        let i = 0;
        return async () => `h${i++}`;
      })(), // never repeats
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.deepEqual(
    { settled: out.settled, method: out.method },
    { settled: false, method: 'timeout' },
  );
});

test('snapshot tier is bounded at 10 iterations even inside a large budget', async () => {
  const clock = fakeClock();
  let calls = 0;
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    budgetMs: 60_000,
    probes: {
      snapshotHash: async () => `h${calls++}`,
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.equal(out.settled, false);
  assert.ok(calls <= 10, `snapshot polled ${calls} times`);
});

test('hierarchyChanged reflects initialSnapshotHash comparison', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    initialSnapshotHash: 'before',
    probes: { snapshotHash: seq(['after', 'after']), sleep: clock.sleep, now: clock.now },
  });
  assert.equal(out.hierarchyChanged, true);
});

// A tap whose JS render has not drawn yet: the 100ms gate sees no window
// update, the hash still equals the pre-tap hash, and the draw lands later.
function lateDrawProbes(clock, { updates, hashes, calls }) {
  const nextUpdate = seq(updates);
  const nextHash = seq(hashes);
  return {
    isWindowUpdating: async (timeoutMs) => {
      calls.push(timeoutMs);
      const updating = await nextUpdate();
      clock.advance(updating ? Math.min(timeoutMs, 400) : timeoutMs);
      return updating;
    },
    snapshotHash: nextHash,
    sleep: clock.sleep,
    now: clock.now,
  };
}

test('android window-gate: idle gate, unchanged hash, late window update → re-probe sees the change', async () => {
  const clock = fakeClock();
  const calls = [];
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'before',
    probes: lateDrawProbes(clock, { updates: [false, true], hashes: ['before', 'after'], calls }),
  });
  assert.equal(out.method, 'window-gate');
  assert.equal(out.settled, true);
  assert.equal(out.hierarchyChanged, true);
  assert.deepEqual(calls, [100, 2000]);
});

test('android window-gate: idle twice with unchanged hash → unchanged, inside the settle budget', async () => {
  const clock = fakeClock();
  const calls = [];
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'before',
    budgetMs: 1000,
    probes: lateDrawProbes(clock, { updates: [false, false], hashes: ['before'], calls }),
  });
  assert.equal(out.method, 'window-gate');
  assert.equal(out.hierarchyChanged, false);
  assert.deepEqual(calls, [100, 850]);
  assert.ok(out.ms <= 1000, `expected ≤1000ms, got ${out.ms}`);
});

test('android window-gate: re-probe update but hash still unchanged → unchanged', async () => {
  const clock = fakeClock();
  const calls = [];
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'before',
    probes: lateDrawProbes(clock, { updates: [false, true], hashes: ['before'], calls }),
  });
  assert.equal(out.hierarchyChanged, false);
  assert.equal(calls.length, 2);
});

test('android window-gate: no budget left after the gate → no re-probe', async () => {
  const clock = fakeClock();
  const calls = [];
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'before',
    budgetMs: 150,
    probes: lateDrawProbes(clock, { updates: [false, true], hashes: ['before', 'after'], calls }),
  });
  assert.equal(out.hierarchyChanged, false);
  assert.deepEqual(calls, [100]);
  assert.ok(out.ms <= 150, `expected ≤150ms, got ${out.ms}`);
});

test('android window-gate: changed hash on the first read → no re-probe', async () => {
  const clock = fakeClock();
  const calls = [];
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'before',
    probes: lateDrawProbes(clock, { updates: [false, true], hashes: ['after'], calls }),
  });
  assert.equal(out.hierarchyChanged, true);
  assert.deepEqual(calls, [100]);
});

test('android window-gate: caller without initialSnapshotHash → one gate probe, no hash', async () => {
  const clock = fakeClock();
  const calls = [];
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      ...lateDrawProbes(clock, { updates: [false, true], hashes: ['x'], calls }),
      snapshotHash: async () => {
        throw new Error('must not hash without a pre-tap hash');
      },
    },
  });
  assert.equal(out.hierarchyChanged, undefined);
  assert.deepEqual(calls, [100]);
});

test('ios with an unchanged hash settles on snapshots and never probes the window', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC', 'WINDOW_UPDATE'],
    initialSnapshotHash: 'before',
    probes: {
      isScreenStatic: async () => {
        throw new Error('settle must not compare screenshots');
      },
      isWindowUpdating: async () => {
        throw new Error('ios must not probe the window');
      },
      snapshotHash: async () => 'before',
      sleep: clock.sleep,
      now: clock.now,
    },
  });
  assert.equal(out.method, 'snapshot-eq');
  assert.equal(out.hierarchyChanged, false);
});

test('all snapshot probes fail (null) → timeout, no throw', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    probes: { snapshotHash: async () => null, sleep: clock.sleep, now: clock.now },
  });
  assert.deepEqual(
    { settled: out.settled, method: out.method },
    { settled: false, method: 'timeout' },
  );
});

test('settleEnabled: default on, RN_SETTLE=0/false off', () => {
  assert.equal(settleEnabled({}), true);
  assert.equal(settleEnabled({ RN_SETTLE: '1' }), true);
  assert.equal(settleEnabled({ RN_SETTLE: '0' }), false);
  assert.equal(settleEnabled({ RN_SETTLE: 'false' }), false);
  assert.equal(settleEnabled({ RN_SETTLE: 'FALSE' }), false);
});
