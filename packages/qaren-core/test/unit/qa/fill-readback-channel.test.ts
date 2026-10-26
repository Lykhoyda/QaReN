import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';

test('a secure fill keeps its targeted read-back while the capture never reads input values', () => {
  const secret = 's3cret-fill-value';
  const fiber = buildFiber({
    hostType: 'RCTSinglelineTextInputView',
    props: { testID: 'password', value: secret, secureTextEntry: true, onChangeText() {} },
  });
  const sandbox = createSandbox({ fiberRoot: fiber });
  const readBack = JSON.parse(vm.runInContext('__QAREN.readInputValue("password")', sandbox));
  assert.equal(readBack.value, secret);
  assert.equal(readBack.controlled, true);
  const reply = vm.runInContext('__QAREN.beginQaCapture(false)', sandbox);
  assert.equal(Object.hasOwn(reply, 'inputs'), false);
  assert.equal(JSON.stringify(reply).includes(secret), false);
});
