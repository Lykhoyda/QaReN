import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { bridgeWithFallback, helperCall } from '../../dist/cdp/helper-expr.js';
import { CDPClient } from '../../dist/cdp-client.js';

const FRONTMOST = 'isTestIdFrontmost("submit")';

// ── Validation: helperCall ───────────────────────────────────────────

test('helperCall accepts a JSON object-literal argument', () => {
  assert.equal(
    helperCall('interact({"action":"press","limit":50})'),
    'interact({"action":"press","limit":50})',
  );
});

test('helperCall accepts a nested-object argument and escapes "/"', () => {
  const call = 'interact({"action":"tasks/add","payload":{"title":"x"},"path":"tasks.items"})';
  assert.equal(helperCall(call), call.replace('tasks/add', 'tasks\\u002fadd'));
});

test('helperCall accepts the bare `undefined` token for an absent argument', () => {
  assert.equal(
    helperCall(`isTestIdFrontmost(${JSON.stringify(undefined)})`),
    'isTestIdFrontmost(undefined)',
  );
  assert.equal(helperCall('readInputValue("x", undefined)'), 'readInputValue("x", undefined)');
});

test('helperCall accepts JSON string args and no-arg calls', () => {
  assert.equal(helperCall(FRONTMOST), FRONTMOST);
  assert.equal(helperCall('getNavState()'), 'getNavState()');
});

test('helperCall does NOT corrupt a JSON string value of "undefined"', () => {
  const call = 'interact({"action":"x","payload":"undefined"})';
  assert.equal(helperCall(call), call);
});

test('helperCall rejects statement injection, nested calls and non-identifier names', () => {
  for (const call of [
    'getNavState(); stealSecrets()',
    'interact(stealSecrets())',
    'interact({"x":stealSecrets()})',
    'interact("safe", stealSecrets())',
    'interact("safe"); stealSecrets()//)',
    'interact("unterminated)',
    'interact([1, 2)',
    'interact(1,)',
    '1evil()',
    'a.b()',
  ]) {
    assert.throws(() => helperCall(call), /refusing to interpolate/, call);
  }
});

// ── Destination: bridgeWithFallback (the isTestIdFrontmost path) ─────

type Bridge = { isTestIdFrontmost?: (...args: unknown[]) => string };

function evaluate(expression: string, globals: { __QAREN: Bridge; __RN_DEV_BRIDGE__?: Bridge }) {
  return runInNewContext(expression, { JSON, ...globals });
}

function injected() {
  const calls: unknown[][] = [];
  const helper: Bridge = {
    isTestIdFrontmost: (...args) => {
      calls.push(args);
      return JSON.stringify({ visible: true, source: 'injected' });
    },
  };
  return { helper, calls };
}

test('bridgeWithFallback without a detected bridge calls __QAREN directly', () => {
  const { helper, calls } = injected();
  const bridge: Bridge = { isTestIdFrontmost: () => JSON.stringify({ source: 'bridge' }) };
  const expression = bridgeWithFallback(helperCall(FRONTMOST), false);
  assert.equal(expression, `__QAREN.${FRONTMOST}`);
  assert.equal(
    JSON.parse(evaluate(expression, { __QAREN: helper, __RN_DEV_BRIDGE__: bridge })).source,
    'injected',
  );
  assert.deepEqual(calls, [['submit']]);
});

test('bridgeWithFallback returns a successful bridge reply and bypasses __QAREN', () => {
  const { helper, calls } = injected();
  const reply = JSON.stringify({ visible: false, source: 'bridge' });
  const bridge: Bridge = { isTestIdFrontmost: (id) => (id === 'submit' ? reply : 'wrong id') };
  const expression = bridgeWithFallback(helperCall(FRONTMOST), true);
  assert.equal(evaluate(expression, { __QAREN: helper, __RN_DEV_BRIDGE__: bridge }), reply);
  assert.deepEqual(calls, []);
});

test('bridgeWithFallback falls back to __QAREN when the bridge cannot answer', () => {
  const cases: Array<[string, Bridge | undefined]> = [
    ['bridge global absent', undefined],
    ['bridge method absent', {}],
    [
      'bridge throws',
      {
        isTestIdFrontmost: () => {
          throw new Error('bridge broke');
        },
      },
    ],
    ['bridge error reply', { isTestIdFrontmost: () => JSON.stringify({ error: 'retry' }) }],
    [
      'bridge agent-error reply',
      { isTestIdFrontmost: () => JSON.stringify({ __agent_error: 'no' }) },
    ],
    ['bridge non-JSON reply', { isTestIdFrontmost: () => 'not json' }],
  ];
  for (const [name, bridge] of cases) {
    const { helper, calls } = injected();
    const globals = bridge ? { __QAREN: helper, __RN_DEV_BRIDGE__: bridge } : { __QAREN: helper };
    const result = evaluate(bridgeWithFallback(helperCall(FRONTMOST), true), globals);
    assert.equal(JSON.parse(result).source, 'injected', name);
    assert.deepEqual(calls, [['submit']], name);
  }
});

test('escapes code-sensitive characters while preserving argument values on both routes', () => {
  const separators = String.fromCharCode(0x2028, 0x2029);
  const args = [
    `</script>${separators}`,
    { value: 'undefined, "quoted" \\ path' },
    [1, null, true],
  ];
  const call = `isTestIdFrontmost(${args.map((arg) => JSON.stringify(arg)).join(', ')}, undefined)`;
  for (const bridgeDetected of [false, true]) {
    const expression = bridgeWithFallback(helperCall(call), bridgeDetected);
    assert.doesNotMatch(expression, new RegExp(`[<>/${separators}]`));
    assert.ok(expression.includes('\\u003c\\u002fscript\\u003e\\u2028\\u2029'));
    const received: Record<string, unknown[]> = {};
    const recorder = (route: string): Bridge => ({
      isTestIdFrontmost: (...values) => {
        received[route] = values;
        return JSON.stringify({ route });
      },
    });
    const route = bridgeDetected ? 'bridge' : 'injected';
    const result = evaluate(expression, {
      __QAREN: recorder('injected'),
      __RN_DEV_BRIDGE__: recorder('bridge'),
    });
    assert.equal(JSON.parse(result).route, route);
    assert.deepEqual(Object.keys(received), [route]);
    // The values come from the vm realm, so compare their JSON and the trailing undefined.
    assert.equal(JSON.stringify(received[route]!.slice(0, 3)), JSON.stringify(args));
    assert.equal(received[route]!.length, 4);
    assert.equal(received[route]![3], undefined);
  }
});

test('CDPClient.bridgeWithFallback validates before choosing a destination', () => {
  const client = new CDPClient();
  for (const bridgeDetected of [false, true]) {
    (client as unknown as { _bridgeDetected: boolean })._bridgeDetected = bridgeDetected;
    assert.throws(
      () => client.bridgeWithFallback('isTestIdFrontmost(evil())'),
      /refusing to interpolate/,
    );
    assert.equal(
      client.bridgeWithFallback(FRONTMOST),
      bridgeWithFallback(helperCall(FRONTMOST), bridgeDetected),
    );
  }
});
