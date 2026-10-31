// An exact Android tap waits for the keyboard it opens within the tap's own post-act settle
// budget, and a keyboard that never opened reaches the effect refusal value-free.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const { setActiveSessionInMemoryForTest, resetActiveSessionInMemoryForTest } =
  await import('../../dist/agent-device-wrapper.js');
const { createDevicePressHandler } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap, invalidateLastSnapshotHash } =
  await import('../../dist/fast-runner-ref-map.js');
const { _setAndroidRunnerStateForTest, _setFetchForTest } =
  await import('../../dist/runners/qaren-android-runner-client.js');
const {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} = await import('../../dist/runners/protocol.js');
const { QaDispatchContext } = await import('../../dist/domain/qa-dispatch.js');
const { SETTLE_DEFAULT_BUDGET_MS } = await import('../../dist/lifecycle/settle.js');

const EMAIL = {
  ref: '@e3',
  type: 'android.widget.EditText',
  identifier: 'rhf-email',
  packageName: 'qa.app',
  rect: { x: 20, y: 700, width: 300, height: 44 },
};
// The runner's QA read of an unchanged screen: an app window holding the field.
const NODES = [
  {
    index: 0,
    depth: 0,
    parentIndex: -1,
    type: 'Application',
    rect: EMAIL.rect,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.EditText',
    identifier: 'rhf-email',
    packageName: 'qa.app',
    rect: EMAIL.rect,
    enabled: true,
    hittable: true,
  },
];

afterEach(() => {
  delete process.env.RN_SETTLE;
  _setFetchForTest(globalThis.fetch);
  _setAndroidRunnerStateForTest(null);
  resetActiveSessionInMemoryForTest();
  clearRefMap();
});

async function pressEmail(keyboardShown: boolean | undefined) {
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
  updateRefMapFromFlat([EMAIL] as never, {
    snapshotGeneration: 3,
    keyboardVisible: false,
  });
  // The effect baseline then comes from the runner's read, as the post-tap read does.
  invalidateLastSnapshotHash();
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
    if (body.command === 'isWindowUpdating')
      return Response.json({ ok: true, data: { updating: false } });
    if (body.command === 'snapshot')
      return Response.json({
        ok: true,
        data: { nodes: NODES, snapshotGeneration: 4, keyboardVisible: false },
      });
    taps.push(body);
    return Response.json({
      ok: true,
      data: {
        tapped: true,
        method: 'accessibility-action',
        identifier: 'rhf-email',
        ...(keyboardShown !== undefined ? { keyboardShown } : {}),
      },
    });
  });
  const context = new QaDispatchContext(Number.MAX_SAFE_INTEGER, () => 1);
  const handler = createDevicePressHandler((() => ({
    isConnected: false,
  })) as never);
  const out = await handler({ ref: '@e3', qaContext: context } as never);
  return { env: JSON.parse(out.content[0].text), taps };
}

test("an exact tap carries the tap's post-act settle budget as its keyboard wait bound", async () => {
  const { taps } = await pressEmail(true);
  assert.equal(taps.length, 1);
  assert.equal(taps[0].exactIdentifier, 'rhf-email');
  assert.equal(taps[0].keyboardWaitMs, SETTLE_DEFAULT_BUDGET_MS);
});

test('with settle off the tap carries no keyboard wait bound', async () => {
  process.env.RN_SETTLE = '0';
  const { taps } = await pressEmail(undefined);
  assert.equal(taps.length, 1);
  assert.equal('keyboardWaitMs' in taps[0], false);
});

test('a keyboard that never opened on an unchanged screen refuses as unverified, naming the keyboard', async () => {
  const { env } = await pressEmail(false);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'INTERACTION_EFFECT_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(env.meta.keyboardShown, false);
});
