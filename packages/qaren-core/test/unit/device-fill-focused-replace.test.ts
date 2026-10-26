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
    clearLeaves?: Read;
    clearReply?: { value?: string; error?: string };
    warmLost?: boolean;
  } = {},
): Promise<{ env: any; dispatched: string[][]; clears: number[]; raw: string[][] }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(WRAPPER_ONLY as never, { snapshotGeneration: 7, keyboardVisible: true });
  const requested = options.text ?? 'real@example.test';
  const dispatched: string[][] = [];
  const raw: string[][] = [];
  const clears: number[] = [];
  let current = before;
  let warmed = '';
  _setRunAgentDeviceForTest(
    async (
      cliArgs: string[],
      opts: { focusedProof?: (focusOnly?: boolean) => Promise<boolean> },
    ) => {
      if (cliArgs[0] !== 'fill') return okResult({ nodes: WRAPPER_ONLY });
      if (opts.focusedProof && !(await opts.focusedProof()))
        return failResult('Focus proof refused', 'NO_TEXT_INPUT_TARGET', { mutation: 'none' });
      const typed = cliArgs[2];
      raw.push(cliArgs.slice(2));
      if (options.mutation) {
        dispatched.push([typed]);
        return failResult('Replacement refused', 'TEXT_SYNTHESIS_UNAVAILABLE', {
          mutation: options.mutation,
        });
      }
      if (!warmed && typed !== requested && requested.startsWith(typed)) {
        warmed = typed;
        if (!options.warmLost)
          current = { value: (current?.value ?? '') + typed, focused: current?.focused === true };
        return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
      }
      dispatched.push([warmed + typed]);
      warmed = '';
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
      if (expression.startsWith('__QAREN.clearInputValue(')) {
        assert.doesNotMatch(expression, /real@example|private-prefill/);
        clears.push(current?.value?.length ?? -1);
        if (options.clearReply) return options.clearReply;
        const ok = current?.focused === true && current.value !== null && !options.secureValue;
        if (ok)
          current =
            'clearLeaves' in options ? (options.clearLeaves ?? null) : { value: '', focused: true };
        return {
          value: JSON.stringify(ok ? { cleared: true } : { cleared: false, reason: 'unfocused' }),
        };
      }
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
    return { env: JSON.parse(result.content[0].text), dispatched, clears, raw };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

const TEXT = 'real@example.test';
const LONG = 'qa-tests+m9271792187899724906001234@long-example-domain.test';

for (const before of ['', 'decoy@example.test', TEXT, LONG]) {
  test(`a non-secure input verifies exactly from ${before === '' ? 'empty' : before === TEXT ? 'already-equal' : 'prefilled'} content`, async () => {
    const { env, dispatched, clears } = await run({ value: before, focused: true });
    assert.equal(env.ok, true);
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(dispatched, [[TEXT]]);
    assert.deepEqual(clears, before ? [before.length] : []);
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
    assert.deepEqual(dispatched, [[TEXT]]);
    assert.doesNotMatch(JSON.stringify(env), /real@example|decoy@example|eal@example/);
  });
}

for (const before of ['', 'private-prefill', 'private-prefill'.repeat(4)]) {
  test('private non-secure input uses value-free metadata and exact verification', async () => {
    const { env, dispatched, clears } = await run(
      { value: before, focused: true },
      { privateValue: true },
    );
    assert.equal(env.ok, true);
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(dispatched, [[TEXT]]);
    assert.deepEqual(clears, before ? [before.length] : []);
    assert.doesNotMatch(JSON.stringify(env), /private-prefill|real@example/);
  });
  test('secure input types directly and stays unverified even when prefilled', async () => {
    const { env, dispatched, clears } = await run(
      { value: before, focused: true },
      { secureValue: true },
    );
    assert.equal(env.ok, true);
    assert.equal(env.data.verified, false);
    assert.deepEqual(dispatched, [[TEXT]]);
    assert.deepEqual(clears, []);
  });
}

test('a genuine private mismatch after clearing still fails the step', async () => {
  const { env, dispatched } = await run(
    { value: 'private-prefill', focused: true },
    { privateValue: true, after: { value: 'real@exampl.test', focused: true } },
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(dispatched, [[TEXT]]);
  assert.doesNotMatch(JSON.stringify(env), /private-prefill|real@exampl/);
});

for (const privateValue of [false, true]) {
  test(`a clear that leaves text refuses before typing (private: ${privateValue})`, async () => {
    const { env, dispatched, clears } = await run(
      { value: 'private-prefill', focused: true },
      { privateValue, clearLeaves: { value: 'prefill', focused: true } },
    );
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, 'possible');
    assert.deepEqual(clears, ['private-prefill'.length]);
    assert.deepEqual(dispatched, []);
    assert.doesNotMatch(JSON.stringify(env), /private-prefill|prefill"/);
  });
}

test('a focused readable prefill beyond the clear budget refuses without mutation', async () => {
  const { env, dispatched, clears } = await run({ value: 'x'.repeat(257), focused: true });
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
  assert.deepEqual(clears, []);
});

test('an explicit non-private insertion verifies the appended readback', async () => {
  const { env, dispatched, clears } = await run(
    { value: 'old', focused: true },
    {
      after: { value: 'old' + TEXT, focused: true },
      clearFirst: false,
    },
  );
  assert.equal(env.meta.verify, 'exact');
  assert.deepEqual(dispatched, [[TEXT]]);
  assert.deepEqual(clears, []);
});

test('an unreadable final value stays honestly unverified', async () => {
  const { env, dispatched } = await run({ value: 'old', focused: true }, { after: null });
  assert.equal(env.ok, true);
  assert.equal(env.data.verified, false);
  assert.deepEqual(dispatched, [[TEXT]]);
});

for (const before of [null, { value: '', focused: false }, { value: 'old', focused: false }]) {
  test('unavailable or lost initial focus refuses before any mutation', async () => {
    const { env, dispatched, clears } = await run(before);
    assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(dispatched, []);
    assert.deepEqual(clears, []);
  });
}

test('unknown non-secure content refuses before any clear or insertion', async () => {
  const { env, dispatched, clears } = await run({ value: null, focused: true });
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
  assert.deepEqual(clears, []);
});

for (const mutation of ['none', 'possible'] as const) {
  test(`native refusal after clearing reports possible mutation (native ${mutation})`, async () => {
    const { env, dispatched } = await run({ value: 'old', focused: true }, { mutation });
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, 'possible');
    assert.deepEqual(dispatched, [[TEXT[0]]]);
  });
  test(`native refusal on an empty field preserves mutation ${mutation}`, async () => {
    const { env, dispatched } = await run({ value: '', focused: true }, { mutation });
    assert.equal(env.code, mutation === 'none' ? 'NO_TEXT_INPUT_TARGET' : 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, mutation);
    assert.deepEqual(dispatched, [[TEXT[0]]]);
  });
}

for (const afterRecovery of [TEXT, 'real @example.test', 'old' + TEXT]) {
  test(`proven retained prefix permits only one recovery: ${afterRecovery}`, async () => {
    const { env, dispatched, clears } = await run(
      { value: 'old', focused: true },
      {
        after: [
          { value: 'old' + TEXT, focused: true },
          { value: afterRecovery, focused: true },
        ],
      },
    );
    assert.deepEqual(dispatched, [[TEXT], [TEXT]]);
    assert.deepEqual(clears, [3, ('old' + TEXT).length]);
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
  assert.deepEqual(dispatched, [[TEXT]]);
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

for (const [reply, mutation] of [
  [{ value: JSON.stringify({ cleared: false, reason: 'unfocused' }) }, 'none'],
  [{ value: JSON.stringify({ cleared: false, reason: 'disabled' }) }, 'none'],
  [{ value: JSON.stringify({ cleared: false, reason: 'handler-threw' }) }, 'possible'],
  [{ error: 'transport lost' }, 'possible'],
] as const) {
  test(`an unproven clear refuses before typing with mutation ${mutation}`, async () => {
    const { env, dispatched } = await run(
      { value: 'private-prefill', focused: true },
      { privateValue: true, clearReply: reply },
    );
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, mutation);
    assert.deepEqual(dispatched, []);
  });
}

for (const before of ['', 'private-prefill']) {
  test(`the rest of the text waits for the first character to settle (${before ? 'prefilled' : 'empty'})`, async () => {
    const { env, raw } = await run({ value: before, focused: true }, { privateValue: true });
    assert.equal(env.meta.verify, 'exact');
    assert.deepEqual(raw, [[TEXT[0]], [TEXT.slice(1)]]);
  });
}

test('a first character the field never shows refuses before the rest is typed', async () => {
  const { env, raw } = await run(
    { value: '', focused: true },
    { privateValue: true, warmLost: true },
  );
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.deepEqual(raw, [[TEXT[0]]]);
});

test('a one-character fill is typed in one dispatch', async () => {
  const { env, raw } = await run({ value: '', focused: true }, { text: '7' });
  assert.equal(env.meta.verify, 'exact');
  assert.deepEqual(raw, [['7']]);
});

test('the first typed unit is a whole grapheme, not a code point', async () => {
  const text = 'éclair@example.test';
  const { env, raw } = await run({ value: '', focused: true }, { text });
  assert.equal(env.meta.verify, 'exact');
  assert.deepEqual(raw, [['é'], [text.slice(2)]]);
});

for (const [before, method] of [
  ['', 'keyboard'],
  ['private-prefill', 'clear-type'],
] as const) {
  test(`a focused fill reports its ladder rung (${method})`, async () => {
    const { env } = await run({ value: before, focused: true }, { privateValue: true });
    assert.equal(env.meta.fillMethod, method);
  });
}

test('a focused refusal after clearing still reports the clear-then-type rung', async () => {
  const { env } = await run({ value: 'old', focused: true }, { mutation: 'possible' });
  assert.equal(env.ok, false);
  assert.equal(env.meta.fillMethod, 'clear-type');
});
