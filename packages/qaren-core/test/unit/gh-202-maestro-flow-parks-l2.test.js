import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlowParked } from '../../dist/handlers/maestro-run.js';

test('GH#202 runFlowParked: parks L2 before the flow and marks CDP stale after (success)', async () => {
  const calls = [];
  const out = await runFlowParked(
    async () => {
      calls.push('flow');
      return 'RESULT';
    },
    {
      stopFastRunner: () => calls.push('stop'),
      completeRunnerPark: async () => calls.push('commit-park'),
      markCdpStale: () => calls.push('stale'),
    },
  );
  assert.equal(out, 'RESULT');
  assert.deepEqual(calls, ['stop', 'commit-park', 'flow', 'stale']);
});

test('GH#202 runFlowParked: still marks CDP stale when the flow throws', async () => {
  const calls = [];
  await assert.rejects(
    runFlowParked(
      async () => {
        calls.push('flow');
        throw new Error('boom');
      },
      { stopFastRunner: () => calls.push('stop'), markCdpStale: () => calls.push('stale') },
    ),
    /boom/,
  );
  assert.deepEqual(calls, ['stop', 'flow', 'stale']);
});

test('GH#237 runFlowParked: android releases the slot before the flow, marks stale after', async () => {
  const calls = [];
  const out = await runFlowParked(
    async () => {
      calls.push('flow');
      return 'OK';
    },
    {
      platform: 'android',
      deviceId: 'emulator-5554',
      releaseAndroidSlot: async () => {
        calls.push('release');
      },
      markCdpStale: () => calls.push('stale'),
    },
  );
  assert.equal(out, 'OK');
  assert.deepEqual(calls, ['release', 'flow', 'stale']);
});

test('GH#237 runFlowParked: android does NOT call stopFastRunner (iOS-only)', async () => {
  const calls = [];
  await runFlowParked(async () => 'OK', {
    platform: 'android',
    releaseAndroidSlot: async () => calls.push('release'),
    stopFastRunner: () => calls.push('stopFast'),
    markCdpStale: () => {},
  });
  assert.deepEqual(calls, ['release']);
});

test('GH#237 runFlowParked: android still marks stale when the flow throws', async () => {
  const calls = [];
  await assert.rejects(
    runFlowParked(
      async () => {
        throw new Error('boom');
      },
      {
        platform: 'android',
        releaseAndroidSlot: async () => calls.push('release'),
        markCdpStale: () => calls.push('stale'),
      },
    ),
    /boom/,
  );
  assert.deepEqual(calls, ['release', 'stale']);
});

test('GH#237 runFlowParked: marks stale even if the android release throws (flow skipped)', async () => {
  const calls = [];
  await assert.rejects(
    runFlowParked(
      async () => {
        calls.push('flow');
        return 'OK';
      },
      {
        platform: 'android',
        releaseAndroidSlot: async () => {
          throw new Error('release boom');
        },
        markCdpStale: () => calls.push('stale'),
      },
    ),
    /release boom/,
  );
  assert.ok(!calls.includes('flow'));
  assert.ok(calls.includes('stale'));
});
