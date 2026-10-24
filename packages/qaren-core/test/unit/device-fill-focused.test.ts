// device_fill focused: true — type into the first responder when the inner
// TextInput is absent from the snapshot, verify through the React tree when
// a testID is derivable, and keep the default bind path's refusal code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { createDeviceFillHandler, performExactFill, performFocusedFill } =
  await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const WRAPPER_ONLY = [
  {
    ref: '@e1',
    identifier: 'EmailOtpFormContent_email-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

interface Call {
  cliArgs: string[];
  opts: Record<string, unknown>;
}

async function withFocusedSeam<T>(
  config: {
    platform?: 'ios' | 'android';
    nodes?: typeof WRAPPER_ONLY;
    fill?: (call: Call) => ReturnType<typeof okResult>;
  },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  _setActiveSessionForTest({
    platform: config.platform ?? 'ios',
    deviceId: 'TEST-DEVICE',
    appId: 'com.test',
  });
  clearRefMap();
  markSnapshotDirty();
  const nodes = config.nodes ?? WRAPPER_ONLY;
  updateRefMapFromFlat(nodes as never, { snapshotGeneration: 7, keyboardVisible: true });
  const calls: Call[] = [];
  _setRunAgentDeviceForTest(async (cliArgs: string[], opts: Record<string, unknown>) => {
    const call = { cliArgs, opts };
    calls.push(call);
    if (cliArgs[0] === 'snapshot') {
      return okResult({ nodes });
    }
    if (cliArgs[0] === 'fill') {
      return config.fill
        ? config.fill(call)
        : okResult({
            typed: true,
            textEntryRoute: 'synthesized-first-responder',
            inputResolution: 'focused-first-responder',
          });
    }
    return okResult({});
  });
  try {
    const result = await run();
    return { result, calls };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

function fakeClient(
  values: Array<{ value?: string | null; controlled?: boolean; focused?: boolean } | null>,
) {
  let reads = 0;
  return {
    isConnected: true,
    evaluate: async (expr: string) => {
      if (!expr.includes('readInputValue')) return { value: JSON.stringify({}) };
      const read = values[Math.min(reads, values.length - 1)];
      reads += 1;
      if (!read) return { error: 'unreadable' };
      return {
        value: JSON.stringify({
          value: read.value ?? null,
          controlled: read.controlled ?? true,
          focused: read.focused === true,
        }),
      };
    },
  } as never;
}

test('focused fill: wrapper ref derives the base testID and matching read-back verifies', async () => {
  const client = fakeClient([
    { value: '', controlled: true, focused: true },
    { value: 'qa.user@example.com', controlled: true, focused: true },
  ]);
  const { result, calls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 19 });
  assert.equal(env.meta.verify, 'exact');
  assert.equal(env.meta.textEntryPath, 'focused-synthesized');
  assert.equal(env.meta.verifiedOracle, 'react-tree');
  assert.equal(env.meta.textEntryRoute, 'synthesized-first-responder');
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], 'EmailOtpFormContent_email-pressable');
  assert.equal(fill.opts.focusedType, true);
  assert.equal(fill.opts.exactTarget, undefined);
});

test('focused fill: React mismatch returns TEXT_ENTRY_UNVERIFIED with observed mutation', async () => {
  const client = fakeClient([
    { value: '', controlled: true, focused: true },
    { value: 'other@example.com', controlled: true, focused: true },
  ]);
  const { result, calls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(env.meta.pathsTried, ['focused']);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('focused fill: positional ref or no client refuses before mutation', async () => {
  const { result: positional, calls: positionalCalls } = await withFocusedSeam({}, () =>
    performFocusedFill({ ref: '@e1', text: 'qa.user@example.com' }, null),
  );
  const positionalEnv = envelope(positional as never);
  assert.equal(positionalEnv.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(positionalEnv.meta.mutation, 'none');
  assert.ok(!positionalCalls.some((c) => c.cliArgs[0] === 'fill'));

  const { result: noClient, calls: noClientCalls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      null,
    ),
  );
  const noClientEnv = envelope(noClient as never);
  assert.equal(noClientEnv.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(noClientEnv.meta.mutation, 'none');
  assert.ok(!noClientCalls.some((c) => c.cliArgs[0] === 'fill'));
});

test('focused fill: runner TEXT_TARGET_FOCUS_FAILED surfaces as NO_TEXT_INPUT_TARGET with no mutation', async () => {
  const { result, calls } = await withFocusedSeam(
    {
      fill: () =>
        failResult(
          'TEXT_TARGET_FOCUS_FAILED: no software keyboard is visible, so no field is proven focused; tap the field, then retry. No typing was performed.',
          'TEXT_TARGET_FOCUS_FAILED',
          { mutation: 'none' },
        ),
    },
    () =>
      performFocusedFill(
        { ref: 'EmailOtpFormContent_email-pressable', text: 'a' },
        fakeClient([{ value: '', focused: true }]),
      ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /TEXT_TARGET_FOCUS_FAILED/);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('focused fill: Android refuses with no mutation', async () => {
  const { result, calls } = await withFocusedSeam({ platform: 'android' }, () =>
    createDeviceFillHandler(() => null as never)({
      ref: 'EmailOtpFormContent_email-pressable',
      text: 'qa.user@example.com',
      focused: true,
    }),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /iOS-only/);
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('default fill: wrapper-bind refusal names focused: true and keeps NO_TEXT_INPUT_TARGET', async () => {
  const { result, calls } = await withFocusedSeam({}, () =>
    performExactFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      null,
      {},
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /retry with focused: true\.$/);
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('focused fill: matching unfocused named field refuses before mutation', async () => {
  const client = fakeClient([
    { value: '', controlled: true, focused: false },
    { value: 'qa.user@example.com', controlled: true, focused: false },
  ]);
  const { result, calls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('focused fill: missing pre-read refuses before a later matching read can permit mutation', async () => {
  const client = fakeClient([null, { value: 'qa.user@example.com', controlled: true }]);
  const { result, calls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('focused fill: stale then exact React read-back verifies', async () => {
  const client = fakeClient([
    { value: '', controlled: true, focused: true },
    { value: '', controlled: true, focused: true },
    { value: '', controlled: true, focused: true },
    { value: 'qa.user@example.com', controlled: true, focused: true },
  ]);
  const { result } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  const env = envelope(result as never);
  assert.ok(!(result as { isError?: boolean }).isError, env.error);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 19 });
  assert.equal(env.meta.verify, 'exact');
  assert.equal(env.meta.verifiedOracle, 'react-tree');
});

test('focused fill: exact read followed by a failed confirm is typed but unverified, not a mismatch', async () => {
  const client = fakeClient([
    { value: '', controlled: true, focused: true },
    { value: '', controlled: true, focused: true },
    { value: '', controlled: true, focused: true },
    { value: 'qa.user@example.com', controlled: true, focused: true },
    null,
  ]);
  const { result } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.ok, true);
  assert.equal(env.code, undefined);
  assert.equal(env.data.typed, true);
  assert.equal(env.data.verified, false);
  assert.equal(env.data.verifiedOracle, 'none');
});

test('focused fill: runner TEXT_SYNTHESIS_UNAVAILABLE surfaces as NO_TEXT_INPUT_TARGET with no mutation', async () => {
  const message = 'text synthesis is unavailable on this Xcode; no typing was performed.';
  const { result, calls } = await withFocusedSeam(
    {
      fill: () => failResult(message, 'TEXT_SYNTHESIS_UNAVAILABLE', { mutation: 'none' }),
    },
    () =>
      performFocusedFill(
        { ref: 'EmailOtpFormContent_email-pressable', text: 'a' },
        fakeClient([{ value: '', focused: true }]),
      ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.equal(env.error, message);
  assert.match(env.meta.hint, /cannot synthesize text/);
  assert.match(env.meta.hint, /Do not retry focused: true/);
  assert.equal(env.meta.hint.includes('rebind'), false);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('default fill: Android wrapper-bind refusal omits the focused: true hint', async () => {
  const { result, calls } = await withFocusedSeam({ platform: 'android' }, () =>
    performExactFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      null,
      {},
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /No text was entered\.$/);
  assert.equal(env.error.includes('focused: true'), false);
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

for (const focused of [false, true]) {
  test(`native ambiguity stays terminal for ${focused ? 'focused' : 'exact'} fill`, async () => {
    const { result, calls } = await withFocusedSeam(
      {
        ...(focused
          ? {}
          : { nodes: [{ ...WRAPPER_ONLY[0], identifier: 'email', type: 'TextField' }] }),
        fill: () => failResult('duplicate target', 'TARGET_AMBIGUOUS', { mutation: 'none' }),
      },
      () =>
        focused
          ? performFocusedFill(
              { ref: 'EmailOtpFormContent_email-pressable', text: 'x' },
              fakeClient([{ value: '', focused: true }]),
            )
          : performExactFill({ ref: 'email', text: 'x' }, null, {}),
    );
    assert.equal(envelope(result as never).code, 'TARGET_AMBIGUOUS');
    assert.equal(envelope(result as never).meta.mutation, 'none');
    assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
  });
}
