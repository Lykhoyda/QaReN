import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSettle } from '../../dist/lifecycle/settle.js';
import { settleAfterMutationWithOutcome } from '../../dist/agent-device-wrapper.js';
import { okResult } from '../../dist/utils.js';

const probesBase = () => ({
  sleep: async () => {},
  now: (() => {
    let t = 0;
    return () => (t += 10);
  })(),
});

test('window-gate settle + initial hash → one post-settle hash probe → hierarchyChanged', async () => {
  let hashCalls = 0;
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'AAA',
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => {
        hashCalls++;
        return 'BBB';
      },
    },
  });
  assert.equal(outcome.method, 'window-gate');
  assert.equal(outcome.hierarchyChanged, true);
  assert.equal(hashCalls, 1);
});

test('window-gate settle, unchanged hash → hierarchyChanged false', async () => {
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'AAA',
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => 'AAA',
    },
  });
  assert.equal(outcome.hierarchyChanged, false);
});

test('window-gate WITHOUT initial hash → no hash probe at all (Story 04 budget intact)', async () => {
  let hashCalls = 0;
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => {
        hashCalls++;
        return 'X';
      },
    },
  });
  assert.equal(outcome.hierarchyChanged, undefined);
  assert.equal(hashCalls, 0);
});

test('snapshot settle + initial hash → hierarchyChanged computed', async () => {
  const outcome = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    initialSnapshotHash: 'AAA',
    probes: { ...probesBase(), isScreenStatic: async () => true, snapshotHash: async () => 'AAA' },
  });
  assert.equal(outcome.method, 'snapshot-eq');
  assert.equal(outcome.hierarchyChanged, false);
});

test('post-settle probe failure → hierarchyChanged stays undefined (fail-open)', async () => {
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'AAA',
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => {
        throw new Error('runner gone');
      },
    },
  });
  assert.equal(outcome.hierarchyChanged, undefined);
});

test('mutating verb settling BLIND (hierarchyChanged undefined) invalidates the baseline', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
  assert.notEqual(getLastSnapshotHash(), null);
  await settleAfterMutationWithOutcome(
    okResult({}),
    { platform: 'android', verb: 'swipe' }, // no initialSnapshotHash → fast tier settles blind
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
      wait: async () => ({ settled: true, method: 'window-gate', ms: 5 }),
    },
  );
  assert.equal(getLastSnapshotHash(), null);
  clearRefMap();
});

test('mutating verb with OBSERVED change keeps the baseline; non-mutating verbs never invalidate', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  const deps = (outcome) => ({
    enabled: () => true,
    capabilities: () => [],
    probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
    wait: async () => outcome,
  });
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
  const seeded = getLastSnapshotHash();
  await settleAfterMutationWithOutcome(
    okResult({}),
    { platform: 'ios', verb: 'tap', initialSnapshotHash: 'AAA' },
    deps({ settled: true, method: 'snapshot-eq', ms: 5, hierarchyChanged: true }),
  );
  assert.equal(getLastSnapshotHash(), seeded); // observed → baseline kept
  await settleAfterMutationWithOutcome(
    okResult({}),
    { platform: 'ios', verb: 'snapshot' },
    deps({}),
  );
  assert.equal(getLastSnapshotHash(), seeded); // non-mutating → untouched
  clearRefMap();
});

test('settle disabled per-call on a mutating verb → baseline invalidated', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
  await settleAfterMutationWithOutcome(okResult({}), {
    platform: 'ios',
    verb: 'tap',
    settle: { enabled: false },
  });
  assert.equal(getLastSnapshotHash(), null);
  clearRefMap();
});

test('settle disabled per-env on a mutating verb → baseline invalidated', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
  await settleAfterMutationWithOutcome(
    okResult({}),
    { platform: 'ios', verb: 'tap' },
    { enabled: () => false },
  );
  assert.equal(getLastSnapshotHash(), null);
  clearRefMap();
});

test('settle threw → baseline invalidated, original result returned', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
  const original = okResult({ tapped: true });
  const { result } = await settleAfterMutationWithOutcome(
    original,
    { platform: 'ios', verb: 'tap' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
      wait: async () => {
        throw new Error('settle engine exploded');
      },
    },
  );
  assert.equal(getLastSnapshotHash(), null);
  assert.equal(result, original);
  clearRefMap();
});

test('settleAfterMutationWithOutcome returns outcome + attaches meta.settle.hierarchyChanged', async () => {
  const { result, outcome } = await settleAfterMutationWithOutcome(
    okResult({ tapped: true }),
    { platform: 'ios', verb: 'tap', initialSnapshotHash: 'AAA' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ ...probesBase(), snapshotHash: async () => 'BBB' }),
      wait: async () => ({ settled: true, method: 'snapshot-eq', ms: 42, hierarchyChanged: true }),
    },
  );
  assert.equal(outcome.hierarchyChanged, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.settle.hierarchyChanged, true);
  assert.equal(env.meta.timings_ms.settle, 42);
});
