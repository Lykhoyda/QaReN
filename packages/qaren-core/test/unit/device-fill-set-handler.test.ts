// Fill ladder rung 3: the change handler receives the whole value and the same exact verification decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest } = await import('../../dist/agent-device-wrapper.js');
const { performSetFill } = await import('../../dist/handlers/device-interact.js');
const { QaDispatchContext } = await import('../../dist/domain/qa-dispatch.js');

const TEXT = 'person@example.test';

async function run(options: {
  setReply?: { value?: string; error?: string } | 'throw';
  after?: string | null;
  privateValue?: boolean;
  testID?: string;
}) {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  const expressions: string[] = [];
  let value: string | null = 'prior';
  const client = {
    isConnected: true,
    evaluate: async (expression: string) => {
      expressions.push(expression);
      if (expression.startsWith('__QAREN.setInputValue(')) {
        if (options.setReply === 'throw') throw new Error('transport lost');
        if (options.setReply) return options.setReply;
        value = options.after === undefined ? TEXT : options.after;
        return { value: JSON.stringify({ set: true }) };
      }
      const [, probe] = JSON.parse(
        '[' + expression.slice('__QAREN.readInputValue('.length, -1) + ']',
      );
      if (value === null) return { error: 'unreadable' };
      return {
        value: JSON.stringify({
          value: probe.privateValue ? null : value,
          controlled: true,
          focused: false,
          ...(probe.valueState
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
  const context = new QaDispatchContext(10_000, () => 1);
  try {
    const result = await performSetFill(
      {
        ref: options.testID ?? 'email',
        text: TEXT,
        ...(options.testID === '' ? {} : { testID: options.testID ?? 'email' }),
        setByHandler: true,
        privateValue: options.privateValue ?? true,
        qaContext: context,
      },
      client,
    );
    return { env: JSON.parse(result.content[0].text), expressions, context };
  } finally {
    _setActiveSessionForTest(null);
  }
}

test('a private value set through the handler verifies exactly and reports rung 3 without the value', async () => {
  const { env, expressions, context } = await run({});
  assert.equal(env.ok, true);
  assert.equal(env.meta.verify, 'exact');
  assert.equal(env.meta.fillMethod, 'set-handler');
  assert.equal(env.data.method, 'handler');
  assert.equal(context.authorizations, 1);
  assert.doesNotMatch(JSON.stringify(env), /person@example/);
  assert.ok(expressions.filter((e) => e.startsWith('__QAREN.setInputValue(')).length === 1);
});

test('a private mismatch after the handler fails the step with an observed mutation', async () => {
  const { env } = await run({ after: 'person@exampl.test' });
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.equal(env.meta.fillMethod, 'set-handler');
  assert.match(env.error, /rung 3/);
  assert.doesNotMatch(JSON.stringify(env), /person@exampl/);
});

test('a readable mismatch after the handler fails rather than passing unverified', async () => {
  const { env } = await run({ after: 'someone@example.test', privateValue: false });
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
});

test('a readable value set through the handler verifies exactly', async () => {
  const { env } = await run({ privateValue: false });
  assert.equal(env.meta.verify, 'exact');
  assert.equal(env.meta.fillMethod, 'set-handler');
});

for (const reason of ['secure', 'uncontrolled', 'unbound', 'disabled']) {
  test(`a ${reason} refusal sets nothing and reports no mutation`, async () => {
    const { env } = await run({ setReply: { value: JSON.stringify({ set: false, reason }) } });
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, 'none');
    assert.match(env.error, /nothing was set/);
  });
}

for (const setReply of ['throw', { error: 'evaluation failed' }] as const) {
  test(`an unconfirmed set reports a possible mutation (${typeof setReply === 'string' ? setReply : 'error'})`, async () => {
    const { env } = await run({ setReply });
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, 'possible');
    assert.match(env.error, /could not confirm/);
  });
}

test('a positional ref without a testID has no handler identity and sets nothing', async () => {
  const { env, expressions, context } = await run({ testID: '' });
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(expressions, []);
  assert.equal(context.authorizations, 0);
});
