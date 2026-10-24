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
  let current = before;
  _setRunAgentDeviceForTest(
    async (
      cliArgs: string[],
      opts: {
        focusedDeleteCount?: number;
        focusedProof?: (focusOnly?: boolean) => Promise<boolean>;
      },
    ) => {
      if (cliArgs[0] !== 'fill') return okResult({ nodes: WRAPPER_ONLY });
      dispatched.push(cliArgs.slice(2));
      clearCounts.push(opts.focusedDeleteCount);
      if (options.mutation)
        return failResult('Replacement refused', 'TEXT_SYNTHESIS_UNAVAILABLE', {
          mutation: options.mutation,
        });
      if (cliArgs.includes('--clear-first')) {
        current = { value: '', focused: true };
        assert.equal(await opts.focusedProof?.(true), true);
      }
      const after = options.after;
      current =
        'after' in options
          ? ((Array.isArray(after)
              ? after[Math.min(dispatched.length - 1, after.length - 1)]
              : after) ?? null)
          : { value: options.text ?? 'real@example.test', focused: true };
      return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
    },
  );
  const client = {
    isConnected: true,
    evaluate: async (expression: string) => {
      const [, probeOptions] = JSON.parse(
        '[' + expression.slice('__QAREN.readInputValue('.length, -1) + ']',
      );
      const protectedValue =
        probeOptions.privateValue === true ||
        (options.secureValue === true && probeOptions.protectSecure === true);
      const read = current;
      return read
        ? {
            value: JSON.stringify({
              value: protectedValue ? null : read.value,
              controlled: protectedValue
                ? probeOptions.valueState === true && !options.secureValue && read.value !== null
                : read.value !== null,
              ...(protectedValue ? { secure: options.secureValue === true } : {}),
              ...(probeOptions.valueState && !options.secureValue && read.value !== null
                ? {
                    contentLength: read.value.length,
                    ...(typeof probeOptions.compareTo === 'string'
                      ? { exact: read.value === probeOptions.compareTo }
                      : {}),
                  }
                : {}),
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

const TEXT = 'real@example.test';
const REPLACE = [TEXT, '--clear-first'];

for (const before of ['', 'decoy@example.test', TEXT]) {
  test(`a non-secure input verifies exactly from ${before === '' ? 'empty' : before === TEXT ? 'already-equal' : 'prefilled'} content`, async () => {
    const { env, dispatched, clearCounts } = await run({ value: before, focused: true });
    assert.equal(env.ok, true);
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(dispatched, [before ? REPLACE : [TEXT]]);
    assert.deepEqual(clearCounts, [before ? before.length : undefined]);
  });
}

for (const value of [
  'decoy@example.testreal@example.test',
  'eal@example.test',
  'real@example',
  'REAL@example.test',
  'real @example.test',
  '',
]) {
  test('a stable readable mismatch stays unverified without exposing values', async () => {
    const { env, dispatched } = await run(
      { value: 'old', focused: true },
      { after: { value, focused: true } },
    );
    assert.equal(env.ok, true);
    assert.equal(env.data.verified, false);
    assert.deepEqual(dispatched, [REPLACE]);
    assert.doesNotMatch(JSON.stringify(env), /real@example|decoy@example|eal@example/);
  });
}

for (const before of ['', 'private-prefill']) {
  test('private non-secure input uses value-free metadata and exact verification', async () => {
    const { env, dispatched, clearCounts } = await run(
      { value: before, focused: true },
      { privateValue: true },
    );
    assert.equal(env.ok, true);
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(dispatched, [before ? REPLACE : [TEXT]]);
    assert.deepEqual(clearCounts, [before ? before.length : undefined]);
    assert.doesNotMatch(JSON.stringify(env), /private-prefill|real@example/);
  });
  test('secure input types directly and stays unverified even when prefilled', async () => {
    const { env, dispatched, clearCounts } = await run(
      { value: before, focused: true },
      { secureValue: true },
    );
    assert.equal(env.ok, true);
    assert.equal(env.data.verified, false);
    assert.deepEqual(dispatched, [[TEXT]]);
    assert.deepEqual(clearCounts, [undefined]);
  });
}

test('a focused readable prefill beyond the clear budget refuses without mutation', async () => {
  const { env, dispatched } = await run({ value: 'x'.repeat(257), focused: true });
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
});

test('an explicit non-private insertion verifies the appended readback', async () => {
  const { env, dispatched } = await run(
    { value: 'old', focused: true },
    {
      after: { value: 'old' + TEXT, focused: true },
      clearFirst: false,
    },
  );
  assert.equal(env.meta.verify, 'exact');
  assert.deepEqual(dispatched, [[TEXT]]);
});

test('an unreadable final value stays honestly unverified', async () => {
  const { env, dispatched } = await run({ value: 'old', focused: true }, { after: null });
  assert.equal(env.ok, true);
  assert.equal(env.data.verified, false);
  assert.deepEqual(dispatched, [REPLACE]);
});

for (const before of [null, { value: '', focused: false }]) {
  test('unavailable or lost initial focus refuses before any mutation', async () => {
    const { env, dispatched } = await run(before);
    assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(dispatched, []);
  });
}

test('unknown non-secure content refuses before any clear or insertion', async () => {
  const { env, dispatched } = await run({ value: null, focused: true });
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
});

for (const mutation of ['none', 'possible'] as const) {
  test(`native refusal preserves mutation ${mutation}`, async () => {
    const { env, dispatched } = await run({ value: 'old', focused: true }, { mutation });
    assert.equal(env.code, mutation === 'none' ? 'NO_TEXT_INPUT_TARGET' : 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, mutation);
    assert.deepEqual(dispatched, [REPLACE]);
  });
}

for (const afterRecovery of [TEXT, 'real @example.test', 'old' + TEXT]) {
  test(`proven retained prefix permits only one recovery: ${afterRecovery}`, async () => {
    const { env, dispatched, clearCounts } = await run(
      { value: 'old', focused: true },
      {
        after: [
          { value: 'old' + TEXT, focused: true },
          { value: afterRecovery, focused: true },
        ],
      },
    );
    assert.deepEqual(dispatched, [REPLACE, REPLACE]);
    assert.deepEqual(clearCounts, [3, ('old' + TEXT).length]);
    if (afterRecovery === TEXT) assert.equal(env.meta.verify, 'exact');
    else if (afterRecovery === 'old' + TEXT) {
      assert.equal(env.ok, false);
      assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    } else {
      assert.equal(env.ok, true);
      assert.equal(env.data.verified, false);
    }
  });
}

test('retained-prefix recovery refuses when intended-field focus is lost', async () => {
  const { env, dispatched } = await run(
    { value: 'old', focused: true },
    { after: { value: 'old' + TEXT, focused: false } },
  );
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(dispatched, [REPLACE]);
});

test('formatting an initially empty readable field stays unverified without recovery', async () => {
  const { env, dispatched } = await run(
    { value: '', focused: true },
    { text: '123456', after: { value: '123 456', focused: true } },
  );
  assert.equal(env.ok, true);
  assert.equal(env.data.verified, false);
  assert.deepEqual(dispatched, [['123456']]);
});
