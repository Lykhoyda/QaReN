// SYSTEM_ALERT_TAP_V1 on Android: a system dialog button is tapped by its label in the runner, never by an older runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetCapabilitiesForTest,
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  classifyAndroidHealth,
  probeAndroidRunnerHealthInfo,
  runAndroid,
} from '../../dist/runners/qaren-android-runner-client.js';
import { buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';

const PORT = 22091;

test('the system alert verb carries the exact chosen label to the Android runner command', () => {
  assert.deepEqual(buildRunAndroidArgs(['system-alert-tap', 'Don’t allow'], 'dev.fixture'), {
    command: 'systemAlertTap',
    labels: ['Don’t allow'],
    bundleId: 'dev.fixture',
  });
});

test('an Android runner without systemAlertTap and SYSTEM_ALERT_TAP_V1 classifies for rebuild', () => {
  assert.ok((REQUIRED_ANDROID_FEATURES as readonly string[]).includes('SYSTEM_ALERT_TAP_V1'));
  assert.ok((REQUIRED_ANDROID_COMMANDS as readonly string[]).includes('systemAlertTap'));
  const capabilities = REQUIRED_ANDROID_FEATURES.filter((f) => f !== 'SYSTEM_ALERT_TAP_V1');
  const commands = REQUIRED_ANDROID_COMMANDS.filter((c) => c !== 'systemAlertTap');
  assert.deepEqual(
    classifyAndroidHealth({
      protocolVersion: 2,
      commands: [...REQUIRED_ANDROID_COMMANDS],
      capabilities: [...capabilities],
    }),
    { compatible: false, reason: 'missing-features', missing: ['SYSTEM_ALERT_TAP_V1'] },
  );
  assert.equal(
    classifyAndroidHealth({
      protocolVersion: 2,
      commands: [...commands],
      capabilities: [...REQUIRED_ANDROID_FEATURES],
    }).compatible,
    false,
  );
});

for (const capable of [false, true]) {
  test(`an Android system alert tap ${capable ? 'reaches' : 'never reaches'} a runner ${capable ? 'with' : 'without'} SYSTEM_ALERT_TAP_V1`, async () => {
    _setAndroidRunnerStateForTest({
      schemaVersion: 1,
      hostPort: PORT,
      devicePort: PORT,
      pid: process.pid,
      deviceId: 'emulator-alert',
      bundleId: 'dev.fixture',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 2,
    });
    const bodies: Record<string, unknown>[] = [];
    _setFetchForTest(async (url, init) => {
      if (String(url).endsWith('/health'))
        return new Response(
          JSON.stringify({
            ok: true,
            protocolVersion: 2,
            commands: [...REQUIRED_ANDROID_COMMANDS],
            capabilities: [...REQUIRED_ANDROID_FEATURES],
          }),
        );
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          ok: true,
          v: 2,
          data: {
            tappedLabel: 'Allow',
            tappedRect: { x: 1, y: 2, width: 3, height: 4 },
            alertClosed: true,
          },
        }),
      );
    });
    try {
      if (capable) await probeAndroidRunnerHealthInfo(PORT);
      else _resetCapabilitiesForTest();
      const result = await runAndroid({
        command: 'systemAlertTap',
        labels: ['Allow'],
        bundleId: 'dev.fixture',
        deviceId: 'emulator-alert',
      } as never);
      const envelope = JSON.parse(result.content[0]!.text);
      if (!capable) {
        assert.equal(envelope.code, 'RUNNER_COMMANDS_STALE');
        assert.deepEqual(envelope.meta.missingFeatures, ['SYSTEM_ALERT_TAP_V1']);
        assert.equal(envelope.meta.mutation, 'none');
        assert.deepEqual(bodies, []);
        return;
      }
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].command, 'systemAlertTap');
      assert.deepEqual(bodies[0].labels, ['Allow']);
      assert.equal(bodies[0].appBundleId, 'dev.fixture');
      assert.equal(envelope.data.alertClosed, true);
    } finally {
      _setFetchForTest(globalThis.fetch);
      _setAndroidRunnerStateForTest(null);
      _resetCapabilitiesForTest();
    }
  });
}
