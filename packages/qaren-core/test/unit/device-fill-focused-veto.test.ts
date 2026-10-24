import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult } = await import('../../dist/utils.js');

const WRAPPER_ONLY = [
  {
    ref: '@e1',
    identifier: 'qa-hidden-email-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

async function withSeam<T>(
  run: () => Promise<T>,
): Promise<{ result: T; fills: number; commands: string[] }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(WRAPPER_ONLY as never, { snapshotGeneration: 7, keyboardVisible: true });
  let fills = 0;
  const commands: string[] = [];
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    commands.push(cliArgs[0]);
    if (cliArgs[0] === 'fill') {
      fills += 1;
      return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
    }
    return okResult({ nodes: WRAPPER_ONLY });
  });
  try {
    return { result: await run(), fills, commands };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

function client(reads: Array<{ value: string; focused: boolean } | null>) {
  let index = 0;
  return {
    isConnected: true,
    evaluate: async (expr: string) => {
      const [testID] = JSON.parse('[' + expr.slice('__QAREN.readInputValue('.length, -1) + ']');
      assert.equal(testID, 'qa-hidden-email');
      const read = reads[Math.min(index++, reads.length - 1)];
      return read
        ? { value: JSON.stringify({ value: read.value, controlled: true, focused: read.focused }) }
        : { error: 'unreadable' };
    },
  } as never;
}

const envelope = (result: unknown) =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

const args = {
  ref: '@e1',
  text: 'qa@example.test',
  testID: 'qa-hidden-email',
  focused: true,
  vetoUnfocused: true,
};

test('U10: an unfocused React input vetoes the type with no mutation', async () => {
  const { result, fills, commands } = await withSeam(() =>
    performFocusedFill(args, client([{ value: '', focused: false }])),
  );
  assert.deepEqual(commands, []);
  const env = envelope(result);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.equal(fills, 0);
  assert.ok(!JSON.stringify(env).includes(args.text));
});

test('an unfocused read refuses even without the veto flag', async () => {
  const { fills } = await withSeam(() =>
    performFocusedFill({ ...args, vetoUnfocused: false }, client([{ value: '', focused: false }])),
  );
  assert.equal(fills, 0);
});

test('an unavailable React focus probe refuses without mutation', async () => {
  const { result, fills } = await withSeam(() => performFocusedFill(args, client([null])));
  assert.equal(fills, 0);
  assert.equal(envelope(result).code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(envelope(result).meta.mutation, 'none');
});

for (const read of [null, { value: '', focused: false }]) {
  test(`proof-mode fill refuses ${read ? 'unfocused' : 'unavailable'} pre-dispatch evidence`, async () => {
    const { result, fills, commands } = await withSeam(() =>
      performFocusedFill({ ...args, requireFocused: true }, client([read])),
    );
    assert.deepEqual(commands, []);
    assert.equal(fills, 0);
    assert.equal(envelope(result).code, 'NO_TEXT_INPUT_TARGET');
    assert.equal(envelope(result).meta.mutation, 'none');
  });
}

test('proof-mode fill types once with positive pre-dispatch focus evidence', async () => {
  const { result, fills } = await withSeam(() =>
    performFocusedFill(
      { ...args, requireFocused: true, skipFinalValidation: true },
      client([{ value: '', focused: true }]),
    ),
  );
  assert.equal(fills, 1);
  assert.equal(envelope(result).ok, true);
});

test('U9: a focused React input types once and verifies through the React tree', async () => {
  const { result, fills } = await withSeam(() =>
    performFocusedFill(
      args,
      client([
        { value: '', focused: true },
        { value: 'qa@example.test', focused: true },
      ]),
    ),
  );
  assert.equal(fills, 1);
  assert.equal(envelope(result).meta.verifiedOracle, 'react-tree');
});

for (const focused of [true, false]) {
  test(`a normalized fallback stays unverified while retaining focus veto (${focused})`, async () => {
    let reads = 0;
    const normalizingClient = {
      isConnected: true,
      evaluate: async () => {
        reads += 1;
        return {
          value: JSON.stringify({
            value: reads === 1 ? '' : 'normalized',
            controlled: true,
            focused,
          }),
        };
      },
    } as never;
    const { result, fills } = await withSeam(() =>
      performFocusedFill({ ...args, skipFinalValidation: true }, normalizingClient),
    );
    assert.equal(reads > 1, focused);
    assert.equal(fills, focused ? 1 : 0);
    const env = envelope(result);
    if (focused) {
      assert.equal(env.ok, true);
      assert.equal(env.data.verified, false);
      assert.equal(env.data.verifiedOracle, 'none');
    } else {
      assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
      assert.equal(env.meta.mutation, 'none');
    }
  });
}
