import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithRetryIfNoChange, tapRetryPolicy } from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { _resetNoChangeStreakForTest } from '../../dist/lifecycle/no-change-tracker.js';
import { okResult } from '../../dist/utils.js';

const seedRefMap = () =>
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', label: 'Go', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
const parse = (result) => JSON.parse(result.content[0].text);
const androidContext = { platform: 'android', verb: 'tap' };
const iosContext = { platform: 'ios', verb: 'tap' };
const policy = { eligible: false, verificationRequired: true, targetKey: 'tap@50,20' };
const changed = { settled: true, method: 'snapshot-eq', ms: 10, hierarchyChanged: true };
const unchanged = { settled: true, method: 'snapshot-eq', ms: 10, hierarchyChanged: false };
const probeFailed = { settled: false, method: 'timeout', ms: 10 };

const depsWith = (outcome) => ({
  enabled: () => true,
  capabilities: () => [],
  probes: () => ({
    snapshotHash: async () => 'H',
    sleep: async () => {},
    now: () => 0,
  }),
  wait: async (opts) => {
    assert.notEqual(opts.initialSnapshotHash, undefined);
    return outcome;
  },
});

beforeEach(() => {
  clearRefMap();
  _resetNoChangeStreakForTest();
  seedRefMap();
});

test('changed hierarchy returns the first successful result without replay', async () => {
  let redispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      redispatches++;
      return okResult({ tapped: true });
    },
    androidContext,
    policy,
    depsWith(changed),
  );

  assert.equal(redispatches, 0);
  assert.equal(parse(result).ok, true);
  assert.equal(parse(result).meta.tapRetried, undefined);
});

test('uncertain Android effect fails after one possible dispatch and never re-actuates', async () => {
  let redispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      redispatches++;
      return okResult({ tapped: true });
    },
    androidContext,
    // This deliberately models the pre-simplification retry-eligible policy.
    { ...policy, eligible: true },
    depsWith(unchanged),
  );

  const envelope = parse(result);
  assert.equal(redispatches, 0, 'effect uncertainty must never authorize a second actuation');
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'INTERACTION_EFFECT_UNVERIFIED');
  assert.equal(envelope.meta.reason, 'no-ui-change');
  assert.equal(envelope.meta.attempts, 1);
  assert.equal(envelope.meta.tapRetried, undefined);
});

test('Android tap drawn after the window gate is verified by the re-probe, not reported unverified', async () => {
  let gateCalls = 0;
  let hashCalls = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => okResult({ tapped: true }),
    { ...androidContext, initialSnapshotHash: 'pre-tap' },
    policy,
    {
      enabled: () => true,
      capabilities: () => ['WINDOW_UPDATE'],
      probes: () => ({
        isWindowUpdating: async () => gateCalls++ > 0,
        snapshotHash: async () => (hashCalls++ === 0 ? 'pre-tap' : 'tab-switched'),
        sleep: async () => {},
        now: () => 0,
      }),
    },
  );

  assert.equal(result.isError, undefined);
  assert.equal(parse(result).ok, true);
  assert.equal(parse(result).meta.settle.hierarchyChanged, true);
  assert.equal(gateCalls, 2);
});

test('unavailable Android effect probe fails after one possible dispatch without replay', async () => {
  let redispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      redispatches++;
      return okResult({ tapped: true });
    },
    androidContext,
    { ...policy, eligible: true },
    depsWith(probeFailed),
  );

  const envelope = parse(result);
  assert.equal(redispatches, 0);
  assert.equal(envelope.code, 'INTERACTION_EFFECT_UNVERIFIED');
  assert.equal(envelope.meta.reason, 'effect-probe-unavailable');
  assert.equal(envelope.meta.attempts, 1);
});

test('iOS unchanged effect stays advisory but is never replayed', async () => {
  let redispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      redispatches++;
      return okResult({ tapped: true });
    },
    iosContext,
    { ...policy, eligible: true },
    depsWith(unchanged),
  );

  const envelope = parse(result);
  assert.equal(redispatches, 0);
  assert.equal(result.isError, undefined);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.noUiChange, true);
  assert.equal(envelope.meta.tapRetried, undefined);
});

test('three distinct unchanged Android controls still surface the wedged hint', async () => {
  let result;
  for (const targetKey of ['tap@1,1', 'tap@2,2', 'tap@3,3']) {
    result = await settleWithRetryIfNoChange(
      okResult({ tapped: true }),
      async () => okResult({ tapped: true }),
      androidContext,
      { ...policy, targetKey },
      depsWith(unchanged),
    );
  }

  assert.match(parse(result).meta.hint, /wedged/);
});

test('non-verifiable gestures settle without effect classification or replay', async () => {
  let redispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      redispatches++;
      return okResult({ tapped: true });
    },
    androidContext,
    { eligible: false, verificationRequired: false, targetKey: '' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
      wait: async (opts) => {
        assert.equal(opts.initialSnapshotHash, undefined);
        return unchanged;
      },
    },
  );

  assert.equal(redispatches, 0);
  assert.equal(parse(result).ok, true);
  assert.equal(parse(result).meta.noUiChange, undefined);
});

test('tap policy preserves effect-verification boundaries while disabling every replay', () => {
  const ordinary = tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {});
  assert.equal(ordinary.eligible, false);
  assert.equal(ordinary.verificationRequired, true);
  assert.equal(ordinary.targetKey, 'tap@50,20');

  const optedOut = tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {
    retryIfNoChange: false,
  });
  assert.equal(optedOut.eligible, false);
  assert.equal(optedOut.verificationRequired, true);

  assert.equal(
    tapRetryPolicy(['longpress', '50', '20'], 'longPress', 50, 20, {}).verificationRequired,
    true,
  );
  assert.equal(
    tapRetryPolicy(['press', '@e0', '--double-tap'], 'tap', 50, 20, {}).verificationRequired,
    false,
  );
  assert.equal(
    tapRetryPolicy(['press', '@e0', '--hold-ms', '1000'], 'tap', 50, 20, {}).verificationRequired,
    false,
  );
  assert.equal(
    tapRetryPolicy(['fill', '@e0', 'hi'], 'type', 50, 20, {}).verificationRequired,
    false,
  );
});
