import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { helperExpr, bridgeWithFallback } from '../../dist/cdp/helper-expr.js';

test('accepts a JSON object-literal argument (getConsole) — the regression', () => {
  assert.equal(
    helperExpr('getConsole({"level":"all","limit":50})', true),
    '__RN_DEV_BRIDGE__.getConsole({"level":"all","limit":50})',
  );
});

test('accepts a nested-object argument (dispatchAction)', () => {
  const call =
    'dispatchAction({"action":"tasks/add","payload":{"title":"x"},"readPath":"tasks.items"})';
  assert.equal(helperExpr(call, false), `__QAREN.${call.replace('tasks/add', 'tasks\\u002fadd')}`);
});

test('accepts the bare `undefined` token (store-state absent path/type)', () => {
  assert.equal(
    helperExpr('getStoreState(undefined, undefined)', true),
    '__RN_DEV_BRIDGE__.getStoreState(undefined, undefined)',
  );
});

test('accepts JSON string args (getStoreState path/type)', () => {
  assert.equal(
    helperExpr('getStoreState("cart.items", "redux")', true),
    '__RN_DEV_BRIDGE__.getStoreState("cart.items", "redux")',
  );
});

test('accepts no-arg calls on either bridge', () => {
  assert.equal(helperExpr('getNavState()', true), '__RN_DEV_BRIDGE__.getNavState()');
  assert.equal(helperExpr('clearConsole()', false), '__QAREN.clearConsole()');
});

test('does NOT corrupt a JSON string value of "undefined"', () => {
  const call = 'dispatchAction({"action":"x","payload":"undefined"})';
  assert.equal(helperExpr(call, true), `__RN_DEV_BRIDGE__.${call}`);
});

test('REJECTS statement-injection via `;`', () => {
  assert.throws(() => helperExpr('getConsole(); stealSecrets()', true), /refusing to interpolate/);
});

test('REJECTS a nested function-call argument (not JSON data) — tightened vs old guard', () => {
  assert.throws(() => helperExpr('getConsole(stealSecrets())', true), /refusing to interpolate/);
});

test('REJECTS a non-identifier / member-access method name', () => {
  assert.throws(() => helperExpr('1evil()', true), /refusing to interpolate/);
  assert.throws(() => helperExpr('a.b()', true), /refusing to interpolate/);
});

test('bridgeWithFallback validates the same way and wraps both bridges', () => {
  const out = bridgeWithFallback('getStoreState("x", undefined)', true);
  assert.match(out, /__RN_DEV_BRIDGE__\.getStoreState\("x", undefined\)/);
  assert.match(out, /__QAREN\.getStoreState\("x", undefined\)/);
  assert.throws(() => bridgeWithFallback('getConsole(evil())', true), /refusing to interpolate/);
});

test('escapes code-sensitive characters while preserving argument values on both routes', () => {
  const args = ['</script>\u2028\u2029', { value: 'undefined, "quoted" \\ path' }, [1, null, true]];
  const call = `isTestIdFrontmost(${args.map((arg) => JSON.stringify(arg)).join(', ')}, undefined)`;
  for (const build of [helperExpr, bridgeWithFallback]) {
    for (const bridgeDetected of [false, true]) {
      const expression = build(call, bridgeDetected);
      assert.doesNotMatch(expression, /[<>/\u2028\u2029]/);
      assert.ok(expression.includes('\\u003c\\u002fscript\\u003e\\u2028\\u2029'));
      const helper = { isTestIdFrontmost: (...received) => JSON.stringify(received) };
      const fallback = { isTestIdFrontmost: () => JSON.stringify({ error: 'retry' }) };
      for (const bridge of [helper, fallback]) {
        assert.equal(
          runInNewContext(expression, { __QAREN: helper, __RN_DEV_BRIDGE__: bridge }),
          JSON.stringify([...args, undefined]),
        );
        if (build === helperExpr) break;
      }
    }
  }
});

test('refuses executable arguments and malformed JSON through either entry point', () => {
  for (const build of [helperExpr, bridgeWithFallback]) {
    for (const bridgeDetected of [false, true]) {
      for (const call of [
        'getConsole({"x":stealSecrets()})',
        'getConsole("safe", stealSecrets())',
        'getConsole("safe"); stealSecrets()//)',
        'getConsole("unterminated)',
        'getConsole([1, 2)',
        'getConsole(1,)',
      ]) {
        assert.throws(() => build(call, bridgeDetected), /refusing to interpolate/);
      }
    }
  }
});
