import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as input from '../../dist/handlers/device-interact.js';
import { buildFiber, createSandbox } from './helpers/inject-harness.js';

const TEXT = 'already held sentinel';
function fixture(props: Record<string, unknown> = {}, duplicate = false) {
  const field = () => ({
    hostType: 'RCTSinglelineTextInputView',
    props: { testID: 'name', value: TEXT, onChangeText() {}, ...props },
  });
  const sandbox = createSandbox({
    fiberRoot: buildFiber({
      hostType: 'RCTView',
      children: duplicate ? [field(), field()] : [field()],
    }),
  });
  const replies: string[] = [];
  const client = {
    async evaluate(expression: string) {
      const value = vm.runInContext(expression, sandbox);
      replies.push(value);
      return { value };
    },
  };
  return { client, replies };
}

test('the value-state projection reports an ordinary enabled input as disabled false', async () => {
  const { client } = fixture();
  const state = await input.readReactInputValue(client, 'name', {
    valueState: true,
    compareTo: TEXT,
  });
  assert.equal(state?.disabled, false);
});

for (const privateValue of [false, true]) {
  test(`two exact enabled controlled reads permit a skip (private: ${privateValue})`, async () => {
    const { client, replies } = fixture();
    let promoted = 0;
    assert.equal(
      await input.inputAlreadyHolds(client, 'name', TEXT, privateValue, () => promoted++),
      true,
    );
    assert.equal(replies.length, 2);
    assert.equal(promoted, privateValue ? 1 : 0);
    assert.equal(
      replies.some((reply) => reply.includes(TEXT)),
      false,
    );
  });
}

for (const [name, props, duplicate] of [
  ['disabled', { editable: false }],
  ['accessibility disabled', { accessibilityState: { disabled: true } }],
  ['secure', { secureTextEntry: true }],
  ['uncontrolled', { value: undefined, defaultValue: TEXT }],
  ['mismatch', { value: 'other' }],
  ['duplicate identity', {}, true],
] as const) {
  test(`the pre-focus comparison refuses ${name}`, async () => {
    const { client } = fixture(props, duplicate);
    let promoted = 0;
    assert.equal(
      await input.inputAlreadyHolds(client, 'name', TEXT, true, () => promoted++),
      false,
    );
    assert.equal(promoted, 0);
  });
}

for (const [name, client] of [
  ['no client', null],
  ['unreadable', { evaluate: async () => ({ error: 'unreadable' }) }],
  [
    'missing disabled',
    {
      evaluate: async () => ({
        value: JSON.stringify({ exact: true, controlled: true, secure: false }),
      }),
    },
  ],
] as const) {
  test(`the pre-focus comparison refuses ${name}`, async () => {
    assert.equal(await input.inputAlreadyHolds(client, 'name', TEXT, false), false);
  });
}

for (const second of [
  { disabled: true },
  { exact: false },
  { controlled: false },
  { secure: true },
  { disabled: undefined },
]) {
  test(`confirmation must remain eligible: ${JSON.stringify(second)}`, async () => {
    let reads = 0;
    const client = {
      evaluate: async () => ({
        value: JSON.stringify({
          exact: true,
          controlled: true,
          secure: false,
          disabled: false,
          ...(reads++ ? second : {}),
        }),
      }),
    };
    assert.equal(await input.inputAlreadyHolds(client, 'name', TEXT, false), false);
    assert.equal(reads, 2);
  });
}
