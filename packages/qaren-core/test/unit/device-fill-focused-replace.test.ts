// Focused fill requests replacement and proves focus immediately before dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const WRAPPER_ONLY = [
  {
    ref: '@e1',
    identifier: 'qa-hidden-email-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

type Read = { value: string | null; focused: boolean } | null;

async function run(
  before: Read,
  options: {
    after?: Read | Read[];
    mutation?: 'none' | 'possible';
    requireFocused?: boolean;
    clearFirst?: boolean;
    privateValue?: boolean;
    secureValue?: boolean;
    text?: string;
  } = {},
): Promise<{ env: any; dispatched: string[][]; clearCounts: (number | undefined)[] }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(WRAPPER_ONLY as never, { snapshotGeneration: 7, keyboardVisible: true });
  const dispatched: string[][] = [];
  const clearCounts: (number | undefined)[] = [];
  _setRunAgentDeviceForTest(async (cliArgs: string[], opts: { focusedDeleteCount?: number }) => {
    if (cliArgs[0] !== 'fill') return okResult({ nodes: WRAPPER_ONLY });
    dispatched.push(cliArgs.slice(2));
    clearCounts.push(opts.focusedDeleteCount);
    if (options.mutation)
      return failResult('Replacement refused', 'TEXT_SYNTHESIS_UNAVAILABLE', {
        mutation: options.mutation,
      });
    return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
  });
  const client = {
    isConnected: true,
    evaluate: async (expression: string) => {
      const [, probeOptions] = JSON.parse(
        '[' + expression.slice('__QAREN.readInputValue('.length, -1) + ']',
      );
      const protectedValue =
        probeOptions.privateValue === true ||
        (options.secureValue === true && probeOptions.protectSecure === true);
      const after = options.after;
      const read =
        dispatched.length > 0 && 'after' in options
          ? Array.isArray(after)
            ? after[Math.min(dispatched.length - 1, after.length - 1)]
            : after
          : before;
      return read
        ? {
            value: JSON.stringify({
              value: protectedValue ? null : read.value,
              controlled: protectedValue ? false : read.value !== null,
              focused: read.focused,
              ...(protectedValue ? { privateValue: true } : {}),
            }),
          }
        : { error: 'unreadable' };
    },
  } as never;
  try {
    const result = await performFocusedFill(
      {
        ref: '@e1',
        text: options.text ?? 'real@example.test',
        testID: 'qa-hidden-email',
        focused: true,
        vetoUnfocused: true,
        ...(options.requireFocused ? { requireFocused: true } : {}),
        skipFinalValidation: true,
        clearFirst: options.clearFirst ?? true,
        privateValue: options.privateValue,
      },
      client,
    );
    return { env: JSON.parse(result.content[0].text), dispatched, clearCounts };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

const REPLACE = ['real@example.test', '--clear-first'];

test('a fallback refill requests replacement in one runner dispatch', async () => {
  const { env, dispatched } = await run({ value: 'decoy@example.test', focused: true });
  assert.equal(env.ok, true);
  assert.equal(env.data.verified, false);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('a stable retained-prefix concatenation still fails after one bounded clear without raw values', async () => {
  const { env, dispatched } = await run(
    { value: 'decoy@example.test', focused: true },
    { after: { value: 'decoy@example.testreal@example.test', focused: true } },
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.notEqual(env.meta.verify, 'exact');
  assert.deepEqual(dispatched, [REPLACE, REPLACE]);
  assert.doesNotMatch(JSON.stringify(env), /decoy@example\.test|real@example\.test/);
});

for (const retained of [
  'decoy@example.testreal@example.test',
  'decoy@example.tesreal@example.test',
]) {
  test('an ineffective select-all recovers once by clearing the current observed length', async () => {
    const { env, dispatched, clearCounts } = await run(
      { value: 'decoy@example.test', focused: true },
      {
        after: [
          { value: retained, focused: true },
          { value: 'real@example.test', focused: true },
        ],
      },
    );
    assert.equal(env.ok, true);
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(dispatched, [REPLACE, REPLACE]);
    assert.deepEqual(clearCounts, ['decoy@example.test'.length, retained.length]);
    assert.doesNotMatch(JSON.stringify(env), /decoy@example|real@example/);
  });
}

for (const [maxLength, dropFirst] of [
  [8, false],
  [40, false],
  [8, true],
] as const) {
  test(`prefilled middle-caret replacement clears before insertion with maxLength ${maxLength}, dropped first entry ${dropFirst}`, async () => {
    _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
    let value = 'Old Road';
    let caret = 4;
    const counts: Array<number | undefined> = [];
    _setRunAgentDeviceForTest(async (_args: string[], opts: { focusedDeleteCount?: number }) => {
      counts.push(opts.focusedDeleteCount);
      if (opts.focusedDeleteCount) {
        caret = value.length;
        const removed = Math.min(caret, opts.focusedDeleteCount);
        value = value.slice(0, caret - removed);
        caret -= removed;
      } else if (caret) {
        value = value.slice(0, caret - 1) + value.slice(caret);
        caret--;
      }
      const available = Math.max(0, maxLength - value.length);
      const typed = dropFirst && counts.length === 1 ? 'New' : 'New Lane';
      const inserted = typed.slice(0, available);
      value = value.slice(0, caret) + inserted + value.slice(caret);
      return okResult({ typed: true });
    });
    const client = {
      evaluate: async () => ({ value: JSON.stringify({ value, controlled: true, focused: true }) }),
    } as never;
    try {
      const result = await performFocusedFill(
        {
          ref: 'street',
          testID: 'street',
          text: 'New Lane',
          clearFirst: true,
          skipFinalValidation: true,
        },
        client,
      );
      const env = JSON.parse(result.content[0].text);
      assert.equal(value, 'New Lane');
      assert.equal(env.meta.verify, 'exact');
      assert.deepEqual(counts, dropFirst ? [8, 3] : [8]);
    } finally {
      _setRunAgentDeviceForTest(null);
      _setActiveSessionForTest(null);
    }
  });
}

for (const after of [
  [{ value: '123 456', focused: true }],
  [
    { value: '123', focused: true },
    { value: '123 456', focused: true },
  ],
]) {
  test('formatting stays unverified on initial typing and dropped-keystroke retyping', async () => {
    const { env, dispatched } = await run({ value: '', focused: true }, { text: '123456', after });
    assert.equal(env.ok, true);
    assert.equal(env.data.verified, false);
    assert.equal(dispatched.length, after.length);
  });
}

test('a focused readable prefill beyond the clear budget preserves its refusal without mutation', async () => {
  const { env, dispatched, clearCounts } = await run({ value: 'x'.repeat(257), focused: true });
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
  assert.deepEqual(clearCounts, []);
});

for (const kind of ['private', 'secure'] as const) {
  for (const value of ['', 'private-prefill']) {
    test(`${kind} ${value ? 'prefilled' : 'empty'} input clears only before its first dispatch`, async () => {
      const { env, dispatched, clearCounts } = await run(
        { value, focused: true },
        { privateValue: kind === 'private', secureValue: kind === 'secure' },
      );
      assert.equal(env.ok, true);
      assert.equal(env.data.verified, false);
      assert.equal(env.data.verifiedOracle, 'none');
      assert.deepEqual(dispatched, [REPLACE]);
      assert.deepEqual(clearCounts, [undefined]);
      assert.doesNotMatch(JSON.stringify(env), /private-prefill|real@example/);
    });
  }
}

test('a shorter first readback then initial retained prefix fails after the existing retype', async () => {
  const { env, dispatched } = await run(
    { value: 'decoy@example.test', focused: true },
    {
      after: [
        { value: 'real@example', focused: true },
        { value: 'decoy@example.testreal@example.test', focused: true },
      ],
    },
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(dispatched, [REPLACE, REPLACE]);
  assert.doesNotMatch(JSON.stringify(env), /decoy@example\.test|real@example/);
});

test('a shorter first readback then retype-dispatch retained prefix fails without a third mutation', async () => {
  const { env, dispatched } = await run(
    { value: 'decoy@example.test', focused: true },
    {
      after: [
        { value: 'real@example', focused: true },
        { value: 'real@examplereal@example.test', focused: true },
      ],
    },
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(dispatched, [REPLACE, REPLACE]);
  assert.doesNotMatch(JSON.stringify(env), /decoy@example\.test|real@example/);
});

for (const [name, value, verified] of [
  ['exact', 'real@example.test', true],
  ['same shorter', 'real@example', false],
  ['unreadable', null, false],
] as const) {
  test(`a shorter first readback then ${name} preserves its policy after two dispatches`, async () => {
    const { env, dispatched } = await run(
      { value: 'decoy@example.test', focused: true },
      {
        after: [
          { value: 'real@example', focused: true },
          { value, focused: true },
        ],
      },
    );
    assert.equal(env.ok, true);
    assert.equal(env.meta?.verify === 'exact', verified);
    if (!verified) assert.equal(env.data.verified, false);
    assert.deepEqual(dispatched, [REPLACE, REPLACE]);
  });
}

for (const before of ['decoy@example.test', '', 'real@example.test']) {
  test(`an exact replacement readback verifies from ${before === '' ? 'empty' : before.startsWith('decoy') ? 'prefilled' : 'already-equal'} contents`, async () => {
    const { env, dispatched } = await run(
      { value: before, focused: true },
      { after: { value: 'real@example.test', focused: true } },
    );
    assert.equal(env.ok, true);
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(dispatched, [REPLACE]);
  });
}

test('an explicit insertion still verifies its appended readback', async () => {
  const { env, dispatched } = await run(
    { value: 'decoy@example.test', focused: true },
    {
      after: { value: 'decoy@example.testreal@example.test', focused: true },
      clearFirst: false,
    },
  );
  assert.equal(env.ok, true);
  assert.equal(env.meta.verify, 'exact');
  assert.deepEqual(dispatched, [['real@example.test']]);
});

test('an unreadable readback preserves unverified policy', async () => {
  const { env, dispatched } = await run(
    { value: 'decoy@example.test', focused: true },
    { after: null },
  );
  assert.equal(env.ok, true);
  assert.equal(env.data.verified, false);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('an unavailable focus probe on the keyboard-down transition refuses before clearing', async () => {
  const { env, dispatched } = await run(null);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
});

test('a value-free positive focus probe still permits replacement', async () => {
  const { env, dispatched } = await run({ value: null, focused: true });
  assert.equal(env.ok, true);
  assert.equal(env.data.verified, false);
  assert.deepEqual(dispatched, [REPLACE]);
});

for (const after of [
  [{ value: 'other@example.testreal@example.test', focused: true }],
  [
    { value: 'real@example', focused: true },
    { value: 'other@example.testreal@example.test', focused: true },
  ],
]) {
  test('a longer readback without a proven retained prefix stays unverified', async () => {
    const { env, dispatched } = await run(
      { value: 'decoy@example.test', focused: true },
      { after },
    );
    assert.equal(env.ok, true);
    assert.equal(env.data.verified, false);
    assert.equal(dispatched.length, after.length);
  });
}

for (const [name, read] of [
  ['unreadable', null],
  ['unfocused', { value: '', focused: false }],
] as const) {
  test(`keyboard-up focus that is ${name} at dispatch types nothing`, async () => {
    const { env, dispatched } = await run(read, { requireFocused: true });
    assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(dispatched, []);
  });
}

test('I2: a contradictory read at dispatch time vetoes typing on the transition path', async () => {
  const { env, dispatched } = await run({ value: 'decoy', focused: false });
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
});

for (const mutation of ['none', 'possible'] as const) {
  test(`a refused replacement with mutation ${mutation} keeps its disposition`, async () => {
    const { env, dispatched } = await run({ value: 'decoy', focused: true }, { mutation });
    assert.equal(env.code, mutation === 'none' ? 'NO_TEXT_INPUT_TARGET' : 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, mutation);
    assert.match(
      env.meta.hint,
      mutation === 'none' ? /No text was entered/ : /do not blindly re-run device_fill/,
    );
    assert.deepEqual(dispatched, [REPLACE]);
    assert.ok(!JSON.stringify(env).includes('decoy'));
  });
}
