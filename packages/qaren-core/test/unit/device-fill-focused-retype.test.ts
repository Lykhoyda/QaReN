import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult } = await import('../../dist/utils.js');
const { QaDispatchContext } = await import('../../dist/domain/qa-dispatch.js');

const TEXT = 'SYNTHETICWRAP';
const NODES = [
  {
    ref: '@e1',
    identifier: 'qa-kb-input-7-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

interface Options {
  // The field's React value after the nth dispatch (1-based); '' before any.
  valueAfter: (dispatches: number) => string;
  metrics?: Array<Record<string, unknown>>;
  text?: string;
}

async function run(options: Options) {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(NODES as never, { snapshotGeneration: 7, keyboardVisible: true });
  const requested = options.text ?? TEXT;
  const dispatched: string[][] = [];
  const attempts: string[][] = [];
  let warmed = '';
  const clock = 0;
  const context = new QaDispatchContext(1_000, () => clock);
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] !== 'fill') return okResult({ nodes: NODES });
    const typed = cliArgs[2];
    attempts.push(cliArgs.slice(2));
    if (!warmed && typed !== requested && requested.startsWith(typed)) warmed = typed;
    else {
      dispatched.push([warmed + typed]);
      warmed = '';
    }
    return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
  });
  const client = {
    isConnected: true,
    evaluate: async (expression: string) => {
      const [, probe] = JSON.parse(
        '[' + expression.slice('__QAREN.readInputValue('.length, -1) + ']',
      );
      const value = dispatched.length === 0 ? warmed : options.valueAfter(dispatched.length);
      return {
        value: JSON.stringify({
          value,
          controlled: true,
          focused: true,
          ...(probe?.valueState
            ? {
                contentLength: value.length,
                ...(typeof probe.compareTo === 'string'
                  ? { exact: value === probe.compareTo }
                  : {}),
              }
            : {}),
        }),
      };
    },
  } as never;
  try {
    const result = await performFocusedFill(
      {
        ref: '@e1',
        text: options.text ?? TEXT,
        testID: 'qa-kb-input-7',
        focused: true,
        vetoUnfocused: true,
        requireFocused: true,
        skipFinalValidation: true,
        clearFirst: true,
        qaContext: context,
        ...(options.metrics
          ? { qaTiming: { now: () => clock, observe: (event) => options.metrics!.push(event) } }
          : {}),
      },
      client,
    );
    const raw = result.content[0].text;
    return { raw, env: JSON.parse(raw), dispatched, attempts };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

test('an exact read-back verifies without clearing the initially empty field', async () => {
  const { env, dispatched } = await run({ valueAfter: () => TEXT });
  assert.equal(env.ok, true);
  assert.equal(env.meta?.verify, 'exact');
  assert.deepEqual(dispatched, [[TEXT]]);
});

for (const value of [
  'SYNTHETICW',
  'SYNTHETICWR',
  'ABCD12',
  TEXT.toLowerCase(),
  'SYNTHETICWRAX',
  '',
]) {
  test('a stable changed or shortened readback stays unverified without retyping or exposing text', async () => {
    const { raw, env, dispatched, attempts } = await run({ valueAfter: () => value });
    assert.equal(env.ok, true);
    assert.equal(env.data.verified, false);
    assert.deepEqual(dispatched, [[TEXT]]);
    assert.deepEqual(attempts, [[TEXT[0]], [TEXT.slice(1)]]);
    assert.doesNotMatch(raw, /SYNTH|WRAP|ETIC|ABCD/);
  });
}

test('readback metrics contain only verdict and duration', async () => {
  const metrics: Array<Record<string, unknown>> = [];
  const { env, dispatched } = await run({ valueAfter: () => 'SYNTH', metrics });
  assert.equal(env.ok, true);
  assert.equal(dispatched.length, 1);
  const readbacks = metrics.filter((event) => event.stage === 'type-readback');
  assert.deepEqual(
    readbacks.map((event) => [event.edge, event.outcome]),
    [
      ['start', 'ok'],
      ['end', 'failed'],
    ],
  );
  assert.equal(typeof readbacks[1].ms, 'number');
  assert.doesNotMatch(JSON.stringify(metrics), /SYNTH|WRAP/);
});
