import assert from 'node:assert/strict';
import { test } from 'node:test';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { okResult, failResult } = await import('../../dist/utils.js');

async function fillPrivate(dropPrefix: number) {
  const requested = 'person@example.test';
  let value = '';
  const dispatches: string[][] = [];
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST', appId: 'com.test' });
  _setRunAgentDeviceForTest(async (args: string[]) => {
    dispatches.push(args);
    value = requested.slice(dropPrefix);
    return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
  });
  const client = {
    evaluate: async (expression: string) => {
      const [, options] = JSON.parse(
        '[' + expression.slice('__QAREN.readInputValue('.length, -1) + ']',
      );
      return {
        value: JSON.stringify({
          value: null,
          focused: true,
          controlled: options.valueState === true,
          privateValue: true,
          ...(options.valueState ? { contentLength: value.length, secure: false } : {}),
          ...(typeof options.compareTo === 'string'
            ? { exact: value.length === options.compareTo.length && value === options.compareTo }
            : {}),
        }),
      };
    },
  } as never;
  try {
    const result = await performFocusedFill(
      {
        ref: 'email',
        testID: 'email',
        text: requested,
        focused: true,
        clearFirst: true,
        privateValue: true,
        skipFinalValidation: true,
      },
      client,
    );
    return { envelope: JSON.parse(result.content[0].text), dispatches, value, requested };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
}

test('an empty private non-secure field receives the full input without any clear sequence', async () => {
  const { envelope, dispatches, value, requested } = await fillPrivate(0);
  assert.equal(value, requested);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].includes('--clear-first'), false);
  assert.equal(envelope.meta?.verify, 'exact');
  assert.doesNotMatch(JSON.stringify(envelope), /person@example/);
});

for (const dropped of [1, 3]) {
  test(`a private non-secure input missing ${dropped} leading characters fails instead of passing unverified`, async () => {
    const { envelope, dispatches, requested } = await fillPrivate(dropped);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(dispatches.length, 1);
    assert.equal(JSON.stringify(envelope).includes(requested), false);
    assert.equal(JSON.stringify(envelope).includes(requested.slice(dropped)), false);
  });
}

for (const applyClear of [true, false]) {
  test(`private replacement waits for clear completion before typing: applied=${applyClear}`, async () => {
    let value = 'old';
    let clearing = false;
    let clearProbes = 0;
    let typed = 0;
    _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST', appId: 'com.test' });
    _setRunAgentDeviceForTest(
      async (
        args: string[],
        options: {
          focusedProof?: (focusOnly?: boolean) => Promise<boolean>;
        },
      ) => {
        assert.equal(args.includes('--clear-first'), false);
        if (!(await options.focusedProof?.())) {
          return failResult('Clear not confirmed', 'TEXT_ENTRY_UNVERIFIED', {
            mutation: 'possible',
          });
        }
        assert.equal(value, '');
        typed++;
        value = 'person@example.test';
        return okResult({ typed: true });
      },
    );
    const client = {
      evaluate: async (expression: string) => {
        if (expression.startsWith('__QAREN.clearInputValue(')) {
          clearing = true;
          return { value: JSON.stringify({ cleared: true }) };
        }
        const [, options] = JSON.parse(
          '[' + expression.slice('__QAREN.readInputValue('.length, -1) + ']',
        );
        if (clearing && options.compareTo === '') {
          clearProbes++;
          if (applyClear && clearProbes >= 2) value = '';
        }
        return {
          value: JSON.stringify({
            value: null,
            controlled: true,
            focused: true,
            privateValue: true,
            secure: false,
            contentLength: value.length,
            ...(typeof options.compareTo === 'string'
              ? { exact: value === options.compareTo }
              : {}),
          }),
        };
      },
    } as never;
    try {
      const result = await performFocusedFill(
        {
          ref: 'email',
          testID: 'email',
          text: 'person@example.test',
          focused: true,
          clearFirst: true,
          privateValue: true,
          skipFinalValidation: true,
        },
        client,
      );
      const envelope = JSON.parse(result.content[0].text);
      assert.equal(envelope.ok, applyClear);
      assert.equal(typed, applyClear ? 1 : 0);
      assert.ok(clearProbes >= 3);
      assert.doesNotMatch(JSON.stringify(envelope), /person@example/);
    } finally {
      _setRunAgentDeviceForTest(null);
      _setActiveSessionForTest(null);
    }
  });
}
