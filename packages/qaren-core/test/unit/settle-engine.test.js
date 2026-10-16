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
