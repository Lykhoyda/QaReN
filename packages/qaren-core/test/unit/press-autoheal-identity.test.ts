// Keyboard auto-heal re-resolves the refused tap's identity; a recycled ref never retargets the retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { createDevicePressHandler, createDeviceLongPressHandler } =
  await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const rect = (y: number) => ({ x: 20, y, width: 300, height: 44 });
const skip = { ref: '@e1', type: 'Button', label: 'Skip', identifier: 'skip', rect: rect(700) };
const other = {
  ref: '@e1',
  type: 'Button',
  label: 'Delete',
  identifier: 'delete',
  rect: rect(300),
};

async function heal(
  refreshed: unknown[],
  handler: 'press' | 'longPress' = 'press',
): Promise<{ result: any; presses: string[] }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat([skip, { ...other, ref: '@e2' }, { ...other, ref: '@e3' }] as never, {
    snapshotGeneration: 3,
    keyboardVisible: true,
  });
  const presses: string[] = [];
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] === 'snapshot') return okResult({ nodes: refreshed, keyboardVisible: false });
    presses.push(cliArgs[1]);
    return presses.length === 1
      ? failResult('KEYBOARD_OCCLUDED: the tap is under the keyboard', 'KEYBOARD_OCCLUDED')
      : okResult({ message: 'tapped' });
  });
  const client = () =>
    ({ isConnected: true, evaluate: async () => ({ value: '{"dismissed":true}' }) }) as never;
  try {
    const run =
      handler === 'press'
        ? createDevicePressHandler(client)({ ref: 'e1' })
        : createDeviceLongPressHandler(client)({ ref: 'e1' });
    return { result: JSON.parse((await run).content[0].text), presses };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

for (const handler of ['press', 'longPress'] as const) {
  test(`${handler}: the retry follows the original identity to its new ref`, async () => {
    const { result, presses } = await heal([other, { ...skip, ref: '@e2' }], handler);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(presses, ['@e1', '@e2']);
  });

  for (const [name, nodes] of [
    ['absent', [other]],
    ['duplicated', [other, { ...skip, ref: '@e2' }, { ...skip, ref: '@e3', rect: rect(760) }]],
    [
      'same-id different type and label',
      [
        other,
        { ...skip, ref: '@e2' },
        { ...skip, ref: '@e3', type: 'Other', label: 'Continue', rect: rect(760) },
      ],
    ],
  ] as const) {
    test(`${handler}: an ${name} identity after dismissal is never retapped`, async () => {
      const { result, presses } = await heal([...nodes], handler);
      assert.equal(result.ok, false);
      assert.equal(result.code, name === 'absent' ? 'STALE_REF' : 'TARGET_AMBIGUOUS');
      assert.equal(result.meta.mutation, 'none');
      assert.deepEqual(presses, ['@e1']);
    });
  }
}
