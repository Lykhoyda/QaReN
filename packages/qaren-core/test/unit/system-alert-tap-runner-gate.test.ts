// SYSTEM_ALERT_TAP_V1: a SpringBoard alert button is tapped by its label in the runner, never by an older runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../dist/runners/rn-fast-runner-client.js';
import { buildRunIOSArgs } from '../../dist/agent-device-wrapper.js';
import { REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';

const state = {
  schemaVersion: 1,
  pid: process.pid,
  port: 22658,
  deviceId: 'system-alert-device',
  bundleId: 'dev.fixture',
  startedAt: new Date(0).toISOString(),
  protocolVersion: 2,
} as never;

test('the system alert verb carries the exact chosen label to the runner command', () => {
  assert.deepEqual(buildRunIOSArgs(['system-alert-tap', 'Don’t Allow'], 'dev.fixture'), {
    command: 'systemAlertTap',
    text: 'Don’t Allow',
    bundleId: 'dev.fixture',
  });
  assert.ok((REQUIRED_IOS_FEATURES as readonly string[]).includes('SYSTEM_ALERT_TAP_V1'));
});

for (const capable of [false, true]) {
  test(`a system alert tap ${capable ? 'reaches' : 'never reaches'} a runner ${capable ? 'with' : 'without'} SYSTEM_ALERT_TAP_V1`, async () => {
    _setFastRunnerStateForTest(state);
    _setCapabilitiesForTest(capable ? ['EXACT_KEYBOARD_TARGET_GUARD', 'SYSTEM_ALERT_TAP_V1'] : []);
    const bodies: Record<string, unknown>[] = [];
    _setFetchForTest(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, v: 2, data: { message: 'tapped' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const result = await runIOS({ command: 'systemAlertTap', text: 'Allow' } as never);
      if (!capable) {
        const envelope = JSON.parse(result.content[0]!.text);
        assert.equal(envelope.code, 'RN_FAST_RUNNER_STALE');
        assert.equal(envelope.meta.mutation, 'none');
        assert.deepEqual(bodies, []);
        return;
      }
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].command, 'systemAlertTap');
      assert.equal(bodies[0].text, 'Allow');
    } finally {
      _setFetchForTest(globalThis.fetch);
      _setFastRunnerStateForTest(null);
      _setCapabilitiesForTest([]);
    }
  });
}
