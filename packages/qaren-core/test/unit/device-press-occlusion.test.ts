// A runner occlusion refusal on a press reaches the walker typed and mutation-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { createDevicePressHandler } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const NODES = [
  { ref: '@e1', identifier: 'go', type: 'Button', rect: { x: 20, y: 700, width: 300, height: 44 } },
];

async function press(result: unknown): Promise<{ env: any; presses: number }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(NODES as never, { snapshotGeneration: 3, keyboardVisible: false });
  let presses = 0;
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] !== 'press') return okResult({ nodes: NODES });
    presses += 1;
    return result;
  });
  try {
    const handler = createDevicePressHandler((() => ({ isConnected: false })) as never);
    const out = await handler({ ref: '@e1' });
    return { env: JSON.parse(out.content[0].text), presses };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

test('an occluded tap keeps its code and mutation none, with no heal retry', async () => {
  const { env, presses } = await press(
    failResult('FOCUS_TARGET_OCCLUDED: covered', 'FOCUS_TARGET_OCCLUDED', { mutation: 'none' }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'FOCUS_TARGET_OCCLUDED');
  assert.equal(env.meta.mutation, 'none');
  assert.equal(presses, 1);
});

test('O5: an unavailable hit test dispatches the tap as before', async () => {
  const { env, presses } = await press(
    okResult({ message: 'tapped', occlusionCheck: 'unavailable' }),
  );
  assert.equal(env.ok, true);
  assert.equal(presses, 1);
});

test('an Android runner occlusion refusal reaches the walker typed, mutation-free and without a heal', async () => {
  const { QaDispatchContext } = await import('../../dist/domain/qa-dispatch.js');
  const { setActiveSessionInMemoryForTest, resetActiveSessionInMemoryForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { _setAndroidRunnerStateForTest, _setFetchForTest } =
    await import('../../dist/runners/rn-android-runner-client.js');
  const {
    REQUIRED_ANDROID_COMMANDS,
    REQUIRED_ANDROID_FEATURES,
    RUNNER_PROTOCOL_VERSION,
    getPluginVersion,
  } = await import('../../dist/runners/protocol.js');
  const { describeError, unwrap } = await import('../../dist/qa/adapt.js');
  setActiveSessionInMemoryForTest({
    name: 'qa',
    platform: 'android',
    appId: 'qa.app',
    deviceId: 'qa-device',
  });
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 12345,
    devicePort: 12345,
    pid: process.pid,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    startedAt: '',
    protocolVersion: 2,
  });
  clearRefMap();
  updateRefMapFromFlat(
    [
      {
        ref: '@e3',
        type: 'android.widget.Button',
        identifier: 'go',
        packageName: 'qa.app',
        rect: { x: 20, y: 700, width: 300, height: 44 },
      },
    ] as never,
    { snapshotGeneration: 3, keyboardVisible: false },
  );
  const taps: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, 'QA_READ_ONLY_V1'],
      });
    const body = JSON.parse(String(init?.body));
    if (body.command !== 'tap') return Response.json({ ok: true, data: { updating: false } });
    taps.push(body);
    return Response.json({
      ok: false,
      error: {
        code: 'FOCUS_TARGET_OCCLUDED',
        message:
          'FOCUS_TARGET_OCCLUDED: the tap point is covered by another element; no tap was performed',
        mutation: 'none',
      },
    });
  });
  try {
    const context = new QaDispatchContext(Number.MAX_SAFE_INTEGER, () => 1);
    const handler = createDevicePressHandler((() => ({ isConnected: false })) as never);
    const out = await handler({ ref: '@e3', qaContext: context } as never);
    const env = JSON.parse(out.content[0].text);
    assert.equal(env.code, 'FOCUS_TARGET_OCCLUDED');
    assert.equal(env.meta.mutation, 'none');
    assert.equal(taps.length, 1);
    assert.equal(taps[0].exactIdentifier, 'go');
    assert.doesNotThrow(() => context.assertComplete());
    // The walker's act(): `${code}: ${message}` keyed on the FOCUS_TARGET_OCCLUDED: prefix.
    let error = '';
    try {
      unwrap(out);
    } catch (thrown) {
      const { code, message } = describeError(thrown);
      error = `${code}: ${message}`;
    }
    assert.match(error, /^FOCUS_TARGET_OCCLUDED: /);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setAndroidRunnerStateForTest(null);
    resetActiveSessionInMemoryForTest();
    clearRefMap();
  }
});
