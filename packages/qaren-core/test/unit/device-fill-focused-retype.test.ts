// A keyboard-fallback fill that lost characters is cleared and retyped once; only lengths ever leave the handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');
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
  refuseRetype?: boolean;
  expireAfterFirst?: boolean;
  metrics?: Array<Record<string, unknown>>;
  text?: string;
}

async function run(options: Options) {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(NODES as never, { snapshotGeneration: 7, keyboardVisible: true });
  const dispatched: string[][] = [];
  const attempts: string[][] = [];
  let clock = 0;
  const context = new QaDispatchContext(1_000, () => clock);
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] !== 'fill') return okResult({ nodes: NODES });
    attempts.push(cliArgs.slice(2));
    if (dispatched.length === 1 && options.refuseRetype)
      return failResult('focus lost', 'TEXT_TARGET_FOCUS_FAILED', { mutation: 'none' });
    dispatched.push(cliArgs.slice(2));
    if (options.expireAfterFirst) clock = 2_000;
    return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
  });
  const client = {
    isConnected: true,
    evaluate: async () => ({
      value: JSON.stringify({
        value: dispatched.length === 0 ? '' : options.valueAfter(dispatched.length),
        controlled: true,
        focused: true,
      }),
    }),
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

const REPLACE = [TEXT, '--clear-first'];

test('an exact read-back verifies the fallback fill in one dispatch', async () => {
  const { env, dispatched } = await run({ valueAfter: () => TEXT });
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.meta?.verify, 'exact');
  assert.deepEqual(dispatched, [REPLACE]);
});

test('dropped characters are cleared and retyped once, then verified', async () => {
  const { env, dispatched } = await run({ valueAfter: (n) => (n === 1 ? 'SYNTHETICW' : TEXT) });
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.meta?.verify, 'exact');
  assert.deepEqual(dispatched, [REPLACE, REPLACE]);
});

test('characters still dropped after the retype refuse with lengths, never the value', async () => {
  const { raw, env, dispatched } = await run({
    valueAfter: (n) => (n === 1 ? 'SYNTHETICW' : 'SYNTHETICWR'),
  });
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.match(env.error, /13 characters/);
  assert.match(env.error, /holds 11/);
  assert.equal(env.meta?.mutation, 'observed');
  assert.doesNotMatch(raw, /SYNTH|WRAP|ETIC/);
  assert.deepEqual(dispatched, [REPLACE, REPLACE]);
});

test('a field that strips the same characters on both attempts stays unverified, not refused', async () => {
  const { env, dispatched } = await run({ text: 'AB CD-12', valueAfter: () => 'ABCD12' });
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.data?.verified, false);
  assert.deepEqual(dispatched, [
    ['AB CD-12', '--clear-first'],
    ['AB CD-12', '--clear-first'],
  ]);
  assert.equal(env.data?.typedLength, 8);
  assert.deepEqual(env.data?.observedLengths, [6, 6]);
});

test('a field that only changed letter case is not retyped and discloses the character count', async () => {
  const { env, dispatched } = await run({ valueAfter: () => TEXT.toLowerCase() });
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.data?.verified, false);
  assert.equal(env.data?.caseNormalizedChars, 13);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('a field that changed letters stays unverified without a case disclosure', async () => {
  const { env, dispatched } = await run({ valueAfter: () => 'SYNTHETICWRAX' });
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.data?.verified, false);
  assert.equal(env.data?.caseNormalizedChars, undefined);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('no remaining step budget refuses with lengths instead of retyping', async () => {
  const { raw, env, dispatched } = await run({
    valueAfter: () => 'SYNTHETICW',
    expireAfterFirst: true,
  });
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.match(env.error, /13 characters/);
  assert.match(env.error, /holds 10/);
  assert.doesNotMatch(raw, /SYNTH|WRAP|ETIC/);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('a refused retype refuses with the first lengths', async () => {
  const { raw, env, dispatched, attempts } = await run({
    valueAfter: () => 'SYNTHETICW',
    refuseRetype: true,
  });
  assert.deepEqual(attempts, [REPLACE, REPLACE]);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.match(env.error, /holds 10/);
  assert.doesNotMatch(raw, /SYNTH|WRAP|ETIC/);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('an empty read-back is not dropped keystrokes and is not retyped', async () => {
  const { env, dispatched } = await run({ valueAfter: () => '' });
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.data?.verified, false);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('each fallback readback records only its verdict and duration through retyping', async () => {
  const metrics: Array<Record<string, unknown>> = [];
  const { env, dispatched } = await run({
    valueAfter: (dispatches) => (dispatches === 1 ? 'SYNTH' : TEXT),
    metrics,
  });
  assert.equal(env.ok, true);
  assert.equal(dispatched.length, 2);
  const readbacks = metrics.filter((event) => event.stage === 'type-readback');
  assert.deepEqual(
    readbacks.map((event) => [event.edge, event.outcome]),
    [
      ['start', 'ok'],
      ['end', 'failed'],
      ['start', 'ok'],
      ['end', 'ok'],
    ],
  );
  assert.ok(
    readbacks
      .filter((event) => event.edge === 'end')
      .every((event) => typeof event.ms === 'number'),
  );
  assert.equal(JSON.stringify(metrics).includes(TEXT), false);
  assert.equal(JSON.stringify(metrics).includes('SYNTH'), false);
});
