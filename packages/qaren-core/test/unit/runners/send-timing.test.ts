import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  surfaceKeyboardGuard,
  createSendTimingAccumulator,
} from '../../../dist/runners/keyboard-guard.js';
import { waitForSettle } from '../../../dist/lifecycle/settle.js';
import { settleAfterMutation } from '../../../dist/agent-device-wrapper.js';
import { okResult } from '../../../dist/utils.js';
import { cleanTimingEvent } from '../../../dist/qa/timing.js';

const data = {
  keyboardGuardMs: 0,
  liveCheckMs: 12.5,
  handledMs: 80,
  gestureStartUptimeMs: 100,
  gestureEndUptimeMs: 140,
};
const timings = (result: ReturnType<typeof okResult>) =>
  JSON.parse(result.content[0].text).meta?.timings_ms;

test('runner durations surface without a keyboard status, preserving existing metadata', () => {
  const result = surfaceKeyboardGuard(
    okResult(data, { meta: { timings_ms: { settle: 200 }, settle: { probes: 2 } } }),
  );
  assert.deepEqual(timings(result), {
    keyboardGuard: 0,
    liveCheck: 12.5,
    runner: 80,
    gesture: 40,
    settle: 200,
  });
  assert.deepEqual(JSON.parse(result.content[0].text).meta.settle, { probes: 2 });
  const old = okResult({ message: 'typed' });
  assert.equal(surfaceKeyboardGuard(old), old);
  for (const bad of [NaN, Infinity, -1])
    assert.equal(timings(surfaceKeyboardGuard(okResult({ handledMs: bad }))), undefined);
  assert.equal(
    timings(surfaceKeyboardGuard(okResult({ gestureStartUptimeMs: 40, gestureEndUptimeMs: 20 }))),
    undefined,
  );
});

test('send accumulation counts every request and keeps partial older replies optional', () => {
  const accumulator = createSendTimingAccumulator();
  accumulator.observe(okResult(data));
  accumulator.observe(okResult({ handledMs: 5 }));
  accumulator.observe(okResult(data));
  assert.deepEqual(timings(accumulator.finish(okResult({}))), {
    keyboardGuard: 0,
    liveCheck: 25,
    runner: 165,
    gesture: 80,
  });
  const empty = okResult({});
  assert.equal(createSendTimingAccumulator().finish(empty), empty);
});

test('send accumulation sums probe counts and records no probes when settlement is disabled', () => {
  const accumulator = createSendTimingAccumulator();
  accumulator.observe(okResult(data, { meta: { settle: { probes: 2 } } }));
  accumulator.observe(okResult(data, { meta: { settle: { probes: 3 } } }));
  assert.equal(JSON.parse(accumulator.finish(okResult({})).content[0].text).meta.settle.probes, 5);
  const disabled = createSendTimingAccumulator({ settleDisabled: true });
  disabled.observe(okResult(data));
  assert.equal(JSON.parse(disabled.finish(okResult({})).content[0].text).meta.settle.probes, 0);
});

test('timing events retain only valid measured send numbers', () => {
  const event = { stage: 'settle', edge: 'end', outcome: 'ok', at: 0 } as const;
  const send = {
    keyboardGuardMs: 0,
    liveCheckMs: 12.5,
    gestureMs: 40,
    runnerMs: 80,
    settleProbes: 2,
  };
  assert.deepEqual(cleanTimingEvent({ ...event, send }), { ...event, send });
  for (const invalid of [
    null,
    'private',
    { runnerMs: -1 },
    { runnerMs: NaN },
    { settleProbes: 1.5 },
  ])
    assert.equal(cleanTimingEvent({ ...event, send: invalid }), undefined);
  assert.deepEqual(cleanTimingEvent({ ...event, send: {} }), event);
});

for (const changing of [false, true]) {
  test(`settle counts ${changing ? 'ten changing hashes at timeout' : 'two equal hashes'}`, async () => {
    let clock = 0;
    let calls = 0;
    const result = await waitForSettle({
      platform: 'ios',
      capabilities: [],
      probes: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        snapshotHash: async () => String(changing ? ++calls : ++calls && 1),
      },
    });
    assert.equal(result.probes, changing ? 10 : 2);
    assert.equal(result.settled, !changing);
  });
}

test('the settle wrapper projects the count without changing runner timings', async () => {
  const result = await settleAfterMutation(
    surfaceKeyboardGuard(okResult(data)),
    { platform: 'ios', verb: 'tap' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ now: () => 0, sleep: async () => {}, snapshotHash: async () => 'same' }),
      wait: async () => ({ settled: true, method: 'snapshot-eq', ms: 200, probes: 2 }),
    },
  );
  const meta = JSON.parse(result.content[0].text).meta;
  assert.equal(meta.settle.probes, 2);
  assert.deepEqual(meta.timings_ms, {
    keyboardGuard: 0,
    liveCheck: 12.5,
    runner: 80,
    gesture: 40,
    settle: 200,
  });
});
