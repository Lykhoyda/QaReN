// FILL_EVIDENCE_V1: a lagging runner is rebuilt, and never asked to replace a focused field it would append to.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../dist/runners/rn-fast-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
} from '../../dist/runners/protocol.js';

const state = {
  schemaVersion: 1,
  pid: process.pid,
  port: 22657,
  deviceId: 'fill-evidence-device',
  bundleId: 'dev.fixture',
  startedAt: new Date(0).toISOString(),
  protocolVersion: 2,
} as never;

test('a runner without FILL_EVIDENCE_V1 is incompatible on both platforms', () => {
  for (const [commands, features, others] of [
    [
      REQUIRED_IOS_COMMANDS,
      REQUIRED_IOS_FEATURES,
      [
        'EXACT_KEYBOARD_TARGET_GUARD',
        'HIT_TESTED_DISPATCH_V1',
        'TARGET_FRAME_GUARD_V1',
        'SNAPSHOT_FIDELITY_V1',
        'SYSTEM_ALERT_TAP_V1',
      ],
    ],
    [REQUIRED_ANDROID_COMMANDS, REQUIRED_ANDROID_FEATURES, ['APP_SCOPED_EXACT_INTERACTION']],
  ] as const) {
    const health = { protocolVersion: 2, commands: [...commands], capabilities: [...others] };
    assert.deepEqual(classifyRunnerCompatibility(health, null, commands, features), {
      compatible: false,
      reason: 'missing-features',
      missing: ['FILL_EVIDENCE_V1'],
    });
    assert.deepEqual(
      classifyRunnerCompatibility(
        { ...health, capabilities: [...others, 'FILL_EVIDENCE_V1'] },
        null,
        commands,
        features,
      ),
      { compatible: true },
    );
  }
});

for (const capable of [false, true]) {
  test(`a focused replace ${capable ? 'reaches' : 'never reaches'} a runner ${capable ? 'with' : 'without'} FILL_EVIDENCE_V1`, async () => {
    _setFastRunnerStateForTest(state);
    _setCapabilitiesForTest(capable ? ['EXACT_KEYBOARD_TARGET_GUARD', 'FILL_EVIDENCE_V1'] : []);
    const bodies: Record<string, unknown>[] = [];
    _setFetchForTest(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, v: 2, data: { message: 'typed' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const result = await runIOS({
        command: 'type',
        text: 'replacement',
        focused: true,
        clearFirst: true,
      } as never);
      if (!capable) {
        assert.equal(result.isError, true);
        const envelope = JSON.parse(result.content[0]!.text);
        assert.equal(envelope.code, 'RN_FAST_RUNNER_STALE');
        assert.equal(envelope.meta.mutation, 'none');
        assert.deepEqual(bodies, []);
        return;
      }
      assert.equal(result.isError, undefined);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].focused, true);
      assert.equal(bodies[0].clearFirst, true);
    } finally {
      _setFetchForTest(globalThis.fetch);
      _setFastRunnerStateForTest(null);
      _setCapabilitiesForTest([]);
    }
  });
}

for (const feature of ['FILL_EVIDENCE_V1', 'TARGET_FRAME_GUARD_V1']) {
  test(`iOS missing ${feature} rebuilds once at open`, async () => {
    const { ensureRunnerForCommand } = await import('../../dist/agent-device-wrapper.js');
    const events: string[] = [];
    const probes = [
      { liveness: 'stale', staleReason: 'missing-features', missingFeatures: [feature] },
      { liveness: 'alive' },
    ];
    const result = await ensureRunnerForCommand('U1', 'dev.fixture', {
      prebuilt: () => true,
      adopt: () => {},
      allowArtifactRebuild: true,
      probe: async () => probes.shift() as never,
      ensure: async (_device, _app, opts) => {
        assert.equal(opts?.forceLocalBuild, true);
        events.push('build');
      },
      reap: async () => {
        events.push('reap');
      },
      invalidateArtifact: () => {
        events.push('invalidate');
      },
      acquireBuildLock: () => true,
      releaseBuildLock: () => {},
      pluginVersion: 'fixture',
      rebuildBudget: { alreadyRebuiltFor: () => false, recordRebuild: () => {} },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(events, ['reap', 'invalidate', 'build']);
  });
}

test('Android reusable runner with missing fill evidence emits the bounded rebuild signal', async () => {
  const {
    _setAndroidRunnerStateForTest,
    _setFetchForTest: setFetch,
    startAndroidRunner,
    AndroidCommandsStaleError,
  } = await import('../../dist/runners/rn-android-runner-client.js');
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    pid: process.pid,
    deviceId: 'fixture-device',
    bundleId: 'dev.fixture',
    hostPort: 22657,
    devicePort: 22657,
    protocolVersion: 2,
    startedAt: new Date(0).toISOString(),
  });
  const urls: string[] = [];
  setFetch(async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        ok: true,
        protocolVersion: 2,
        instanceId: 'test-runner-instance',
        sessionId: 'test-session',
        claimEpoch: 1,
        deviceId: 'fixture-device',
        appId: 'dev.fixture',
        commands: [...REQUIRED_ANDROID_COMMANDS],
        capabilities: ['APP_SCOPED_EXACT_INTERACTION'],
      }),
      { status: 200 },
    );
  });
  try {
    await assert.rejects(
      startAndroidRunner('fixture-device', 'dev.fixture'),
      (error) =>
        error instanceof AndroidCommandsStaleError && error.missing.includes('FILL_EVIDENCE_V1'),
    );
    assert.equal(urls.length, 1);
    assert.ok(urls[0].endsWith('/health'));
  } finally {
    setFetch(globalThis.fetch);
    _setAndroidRunnerStateForTest(null);
  }
});
