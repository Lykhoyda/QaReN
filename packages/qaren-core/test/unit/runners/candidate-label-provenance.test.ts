import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearRefMap, getFreshRefTarget } from '../../../dist/fast-runner-ref-map.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
  readAndroidLabelProvenance,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';

test('Android candidate metadata leaves refs and generation intact and returns no tree or private values', async (t) => {
  clearRefMap();
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'test-emulator',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setAndroidRunnerStateForTest(null);
    clearRefMap();
  });
  const rect = { x: 0, y: 0, width: 1080, height: 200 };
  const bodies: Record<string, unknown>[] = [];
  let malformed = false;
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, 'QA_READ_ONLY_V1'],
      });
    const { commandId: _commandId, ...body } = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json({
      ok: true,
      data: body.labelProvenance
        ? {
            labelProvenance: [
              {
                index: malformed ? 99 : 0,
                labelSource: 'descendant',
                value: 'private-native-canary',
              },
            ],
            nodes: [{ index: 99, type: 'TextField', value: 'private-native-canary', rect }],
          }
        : {
            nodes: [
              { index: 0, depth: 0, type: 'android.widget.Button', label: 'Add coverage', rect },
            ],
            truncated: false,
            normalizationDroppedNodes: 0,
            snapshotGeneration: 17,
            keyboardVisible: false,
          },
    });
  });
  await runAndroid({
    command: 'snapshot',
    qaReadOnly: true,
    deviceId: 'test-emulator',
    bundleId: 'com.test',
  });
  const before = getFreshRefTarget('@e0');
  assert.ok(before, 'ordinary QA snapshot supplies a retained reference');
  const evidence = await readAndroidLabelProvenance(['@e0'], 777, 'com.test', 'test-emulator');
  assert.deepEqual(evidence, [{ ref: '@e0', labelSource: 'descendant' }]);
  assert.equal(JSON.stringify(evidence).includes('private-native-canary'), false);
  assert.deepEqual(getFreshRefTarget('@e0'), before);
  assert.equal(getFreshRefTarget('@e99'), null);
  assert.deepEqual(bodies[1], {
    command: 'snapshot',
    qaReadOnly: true,
    appBundleId: 'com.test',
    platformPresence: true,
    presenceBudgetMs: 777,
    labelProvenance: [0],
    snapshotGeneration: 17,
  });
  malformed = true;
  assert.equal(
    await readAndroidLabelProvenance(['@e0'], 777, 'com.test', 'test-emulator'),
    undefined,
  );
  assert.deepEqual(getFreshRefTarget('@e0'), before);
});
