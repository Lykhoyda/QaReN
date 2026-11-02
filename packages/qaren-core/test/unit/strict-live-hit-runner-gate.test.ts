// STRICT_LIVE_HIT_V1: a live-hit-strict tap reaches only a runner that refuses on an unproven read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../dist/runners/qaren-ios-runner-client.js';
import { buildRunIOSArgs } from '../../dist/agent-device-wrapper.js';

const state = {
  schemaVersion: 1,
  pid: process.pid,
  port: 22659,
  deviceId: 'strict-live-hit-device',
  bundleId: 'dev.fixture',
  startedAt: new Date(0).toISOString(),
  protocolVersion: 2,
} as never;

test('the strict press flag becomes requireLiveHit on the tap, and only when asked', () => {
  assert.deepEqual(buildRunIOSArgs(['press', '10', '20', '--require-live-hit'], 'dev.fixture'), {
    command: 'tap',
    x: 10,
    y: 20,
    requireLiveHit: true,
    bundleId: 'dev.fixture',
  });
  assert.deepEqual(buildRunIOSArgs(['press', '10', '20'], 'dev.fixture'), {
    command: 'tap',
    x: 10,
    y: 20,
    bundleId: 'dev.fixture',
  });
});

for (const capable of [false, true]) {
  test(`a strict tap ${capable ? 'reaches' : 'never reaches'} a runner ${capable ? 'with' : 'without'} STRICT_LIVE_HIT_V1`, async () => {
    _setFastRunnerStateForTest(state);
    _setCapabilitiesForTest(capable ? ['STRICT_LIVE_HIT_V1'] : []);
    const bodies: Record<string, unknown>[] = [];
    _setFetchForTest(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, v: 2, data: { message: 'tapped' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const result = await runIOS({ command: 'tap', x: 10, y: 20, requireLiveHit: true });
      if (!capable) {
        const envelope = JSON.parse(result.content[0]!.text);
        assert.equal(envelope.code, 'RN_FAST_RUNNER_STALE');
        assert.equal(envelope.meta.mutation, 'none');
        assert.deepEqual(bodies, []);
        return;
      }
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].command, 'tap');
      assert.equal(bodies[0].requireLiveHit, true);
    } finally {
      _setFetchForTest(globalThis.fetch);
      _setFastRunnerStateForTest(null);
      _setCapabilitiesForTest([]);
    }
  });
}
