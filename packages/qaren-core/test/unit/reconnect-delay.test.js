import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReconnectDelay,
  interruptibleSleep,
  reconnect,
} from '../../dist/cdp/reconnection.js';

// Minimal mock ReconnectContext — interruptibleSleep only touches isDisposed / isSoftReconnectRequested
function makeMockCtx(overrides = {}) {
  const state = {
    disposed: false,
    softReconnectRequested: false,
    ...overrides,
  };
  return {
    state,
    ctx: {
      isDisposed: () => state.disposed,
      isSoftReconnectRequested: () => state.softReconnectRequested,
      // Unused by interruptibleSleep — stubs kept minimal
      isReconnecting: () => false,
      setReconnecting: () => {},
      setSoftReconnectRequested: (v) => {
        state.softReconnectRequested = v;
      },
      setState: () => {},
      setReconnectAttempt: () => {},
      closeWs: () => {},
      rejectAllPending: () => {},
      discoverAndConnect: async () => '',
      getResettableState: () => ({}),
      getPort: () => 8081,
      setBgPollTimer: () => {},
      getBgPollTimer: () => null,
      isConnected: () => false,
    },
  };
}

// ── M2 / Phase 90 Tier 1: exponential reconnect with jitter ──
//
// Replaces the old linear RECONNECT_RETRY_MS = 1500 loop. Curve (with jitterMs=0):
//   [0, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, ...]
//
// Hot-reload responsiveness preserved by attempt 0 returning 0ms (no initial wait).
// Jitter ±500ms breaks lockstep when two MCPs reconnect simultaneously.

test('computeReconnectDelay: attempt 0 returns 0 (hot-reload happy path, never jittered)', () => {
  assert.equal(computeReconnectDelay(0), 0);
  assert.equal(
    computeReconnectDelay(0, { jitterMs: 10_000 }),
    0,
    'jitter does not apply to attempt 0',
  );
  assert.equal(computeReconnectDelay(-1), 0, 'negative attempts clamp to 0');
});

test('computeReconnectDelay: curve at attempts 0..10 with jitter=0 matches spec', () => {
  const noJitter = { jitterMs: 0 };
  const expected = [0, 500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000];
  for (let i = 0; i <= 10; i++) {
    assert.equal(
      computeReconnectDelay(i, noJitter),
      expected[i],
      `attempt ${i}: expected ${expected[i]}ms`,
    );
  }
});

test('computeReconnectDelay: jitter bounded within [0, jitterMs) at attempt 5', () => {
  // With baseMs=500, capMs=30000, attempt=5 → 8000ms base (uncapped), +jitter in [0, 500).
  // 1000 samples with real Math.random: all should fall in [8000, 8500).
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    samples.push(computeReconnectDelay(5));
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert.ok(min >= 8000, `min delay should be >= 8000, got ${min}`);
  assert.ok(max < 8500, `max delay should be < 8500, got ${max}`);
});

test('computeReconnectDelay: cap respected at very high attempt counts', () => {
  const noJitter = { jitterMs: 0 };
  // 2^20 = 1M, way past 30s cap. Must still return exactly 30_000.
  assert.equal(computeReconnectDelay(20, noJitter), 30_000);
  assert.equal(computeReconnectDelay(50, noJitter), 30_000);
  // And with jitter on, cap + jitter upper bound holds.
  const withJitter = computeReconnectDelay(100); // default jitterMs=500
  assert.ok(
    withJitter >= 30_000 && withJitter < 30_500,
    `attempt=100 with default jitter should be in [30000, 30500), got ${withJitter}`,
  );
});

test('computeReconnectDelay: rng injectable for deterministic output', () => {
  // Fixed rng() = 0.5 → jitter = floor(0.5 * 500) = 250
  const fixed = computeReconnectDelay(3, { rng: () => 0.5 });
  assert.equal(fixed, 2000 + 250, 'attempt 3 = 2000 base + 250 jitter at rng=0.5');

  // rng() = 0 → no jitter
  assert.equal(computeReconnectDelay(3, { rng: () => 0 }), 2000);

  // rng() = 0.999... → max jitter (floor(499.5) = 499)
  assert.equal(computeReconnectDelay(3, { rng: () => 0.999 }), 2000 + Math.floor(0.999 * 500));
});

test('computeReconnectDelay: custom baseMs/capMs/jitterMs params respected', () => {
  const opts = { baseMs: 1000, capMs: 10_000, jitterMs: 0 };
  assert.equal(computeReconnectDelay(0, opts), 0);
  assert.equal(computeReconnectDelay(1, opts), 1000, 'baseMs respected at attempt 1');
  assert.equal(computeReconnectDelay(2, opts), 2000);
  assert.equal(computeReconnectDelay(4, opts), 8000);
  assert.equal(computeReconnectDelay(5, opts), 10_000, 'capMs respected');
  assert.equal(computeReconnectDelay(10, opts), 10_000);
});

test('computeReconnectDelay: jitter=0 disables randomness even with default rng', () => {
  // Sanity: with jitterMs=0, output is deterministic regardless of rng.
  for (let i = 1; i <= 5; i++) {
    const a = computeReconnectDelay(i, { jitterMs: 0 });
    const b = computeReconnectDelay(i, { jitterMs: 0 });
    assert.equal(a, b, `attempt ${i} deterministic with jitterMs=0`);
  }
});

// ── D653 multi-review fix: interruptibleSleep preserves softReconnect preemption ──
//
// The first-pass review surfaced a race: after M2 raised the per-iteration sleep to
// 30s at attempt 7+, softReconnect's 3s bail window could no longer out-wait the
// exponential backoff loop, letting both paths race to call discoverAndConnect().
// Fix: interruptibleSleep polls isDisposed() / isSoftReconnectRequested() every
// 500ms (default slice) so preemption latency stays bounded regardless of the
// underlying delay.

test('interruptibleSleep: completes full delay when no interruption requested', async () => {
  const { ctx } = makeMockCtx();
  const start = Date.now();
  const completed = await interruptibleSleep(300, ctx, 100);
  const elapsed = Date.now() - start;
  assert.equal(completed, true, 'returns true when full delay elapsed');
  assert.ok(elapsed >= 290 && elapsed < 500, `elapsed should be ~300ms, got ${elapsed}`);
});

test('interruptibleSleep: exits within one slice when softReconnect requested mid-sleep', async () => {
  const { state, ctx } = makeMockCtx();
  const sliceMs = 100;
  // Flip the flag after 150ms — between slice 1 and slice 2 of a 1000ms sleep
  setTimeout(() => {
    state.softReconnectRequested = true;
  }, 150);

  const start = Date.now();
  const completed = await interruptibleSleep(1000, ctx, sliceMs);
  const elapsed = Date.now() - start;

  assert.equal(completed, false, 'returns false when interrupted');
  // Flag flipped at ~150ms; next slice boundary checked by ~200ms worst case
  assert.ok(elapsed < 350, `should exit within ~250ms of flag flip, got ${elapsed}`);
  assert.ok(elapsed < 1000, `must NOT wait out the full 1000ms delay, got ${elapsed}`);
});

test('interruptibleSleep: exits within one slice when disposed mid-sleep', async () => {
  const { state, ctx } = makeMockCtx();
  const sliceMs = 100;
  setTimeout(() => {
    state.disposed = true;
  }, 150);

  const start = Date.now();
  const completed = await interruptibleSleep(1000, ctx, sliceMs);
  const elapsed = Date.now() - start;

  assert.equal(completed, false, 'returns false when disposed');
  assert.ok(elapsed < 350, `should exit within ~250ms of dispose, got ${elapsed}`);
});

test('interruptibleSleep: returns false immediately when flag already set before call', async () => {
  const { ctx } = makeMockCtx({ softReconnectRequested: true });
  const start = Date.now();
  const completed = await interruptibleSleep(1000, ctx, 100);
  const elapsed = Date.now() - start;
  assert.equal(completed, false);
  assert.ok(elapsed < 50, `should return almost instantly, got ${elapsed}ms`);
});

test('interruptibleSleep: zero or negative delay returns true immediately', async () => {
  const { ctx } = makeMockCtx();
  assert.equal(await interruptibleSleep(0, ctx), true);
  assert.equal(await interruptibleSleep(-100, ctx), true);
});

test('interruptibleSleep: honors D653 worst case — 30s sleep preempted within 500ms slice', async () => {
  // Simulates M2's worst-case scenario: reconnect at attempt 7+, 30s backoff
  // sleep, softReconnect arrives 2s in. With default 500ms slices, preemption
  // latency <= 500ms. We shrink the numbers to keep the test fast but preserve
  // the proportion (30s:500ms = 60:1).
  const { state, ctx } = makeMockCtx();
  setTimeout(() => {
    state.softReconnectRequested = true;
  }, 40);

  const start = Date.now();
  const completed = await interruptibleSleep(3000, ctx, 50); // 60:1 ratio like prod
  const elapsed = Date.now() - start;

  assert.equal(completed, false, 'preempted');
  assert.ok(
    elapsed < 150,
    `prod-equivalent preemption should be <500ms/prod scaled ~100ms test, got ${elapsed}`,
  );
});

test('computeReconnectDelay: cumulative delay over 30 attempts vs old linear (reduction proof)', () => {
  // Old code: 30 × 1500ms = 45_000ms between first and last attempt.
  // New code: 0 + 500 + 1000 + 2000 + 4000 + 8000 + 16000 + 30000*23 ≈ 720_500ms worst case.
  // Wait — that's WORSE! But the story isn't cumulative sleep; it's Metro traffic density.
  // Old: 30 requests in 45s (linear 1 req/1.5s).
  // New: 30 requests spread over ~720s (1 req/1.5s early, then 1 req/30s late).
  // Metro load in first minute: old=40 attempts (hammer), new=7 attempts (0,0.5,1,2,4,8,16,30=62s... so 8 in 60s).
  //
  // Test this by counting how many attempts fit in the first 60 seconds (jitter-free).
  let elapsed = 0;
  let attemptsIn60s = 0;
  for (let i = 0; i < 30 && elapsed <= 60_000; i++) {
    const delay = computeReconnectDelay(i, { jitterMs: 0 });
    elapsed += delay;
    if (elapsed <= 60_000) attemptsIn60s++;
  }
  // Within first 60s: 0 + 500 + 1000 + 2000 + 4000 + 8000 + 16000 = 31500ms cumulative at attempt 6.
  // Adding attempt 7 (30000ms) puts us at 61500ms — just over 60s, so attempts 0..6 fit (7 attempts).
  assert.ok(
    attemptsIn60s >= 6 && attemptsIn60s <= 8,
    `expected 6-8 attempts in first 60s, got ${attemptsIn60s}`,
  );
  assert.ok(
    attemptsIn60s < 40,
    `new curve must be well under old linear ~40 attempts/60s, got ${attemptsIn60s}`,
  );
});

// ── B132: afterReconnect callback fires once on successful reconnect ──

function makeReconnectCtx({ succeedOnAttempt = 0, afterReconnect } = {}) {
  let attempt = 0;
  const state = {
    reconnecting: true,
    disposed: false,
    softReconnectRequested: false,
    state: 'reconnecting',
    attempts: [],
    afterReconnectCalls: 0,
    discoverCalls: 0,
  };
  const ctx = {
    isDisposed: () => state.disposed,
    isSoftReconnectRequested: () => state.softReconnectRequested,
    isReconnecting: () => state.reconnecting,
    setReconnecting: (v) => {
      state.reconnecting = v;
    },
    setSoftReconnectRequested: (v) => {
      state.softReconnectRequested = v;
    },
    setState: (s) => {
      state.state = s;
    },
    setReconnectAttempt: (count, ts) => {
      state.attempts.push({ count, ts });
    },
    closeWs: () => {},
    rejectAllPending: () => {},
    discoverAndConnect: async () => {
      state.discoverCalls++;
      if (attempt < succeedOnAttempt) {
        attempt++;
        throw new Error('mock discover failure');
      }
      return 'connected';
    },
    getResettableState: () => ({}),
    getPort: () => 8081,
    setBgPollTimer: () => {},
    getBgPollTimer: () => null,
    isConnected: () => false,
    afterReconnect: afterReconnect
      ? async () => {
          state.afterReconnectCalls++;
          await afterReconnect();
        }
      : undefined,
  };
  return { state, ctx };
}

test('B132: reconnect() calls afterReconnect exactly once after successful attempt', async () => {
  let hookCalls = 0;
  const { state, ctx } = makeReconnectCtx({
    succeedOnAttempt: 0, // first attempt succeeds — no backoff waits
    afterReconnect: async () => {
      hookCalls++;
    },
  });

  await reconnect(ctx);

  assert.equal(state.discoverCalls, 1);
  assert.equal(hookCalls, 1, 'afterReconnect fired exactly once');
  assert.equal(state.reconnecting, false, 'reconnecting flag cleared');
});

test('B132: reconnect() does NOT call afterReconnect when callback is not provided (backwards compat)', async () => {
  const { state, ctx } = makeReconnectCtx({ succeedOnAttempt: 0 });
  // ctx.afterReconnect is undefined — reconnect must not throw.

  await reconnect(ctx);

  assert.equal(state.discoverCalls, 1);
  assert.equal(state.reconnecting, false);
});

test('B132: afterReconnect failure is caught + logged, never propagates (reconnect success preserved)', async () => {
  const { state, ctx } = makeReconnectCtx({
    succeedOnAttempt: 0,
    afterReconnect: async () => {
      throw new Error('hook boom');
    },
  });

  // reconnect() must still resolve cleanly — hook failure cannot undo a successful reconnect.
  await reconnect(ctx);

  assert.equal(state.discoverCalls, 1);
  assert.equal(state.reconnecting, false, 'reconnect still succeeded despite hook failure');
});
