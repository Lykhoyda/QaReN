import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helperExpr, bridgeWithFallback } from '../../dist/cdp/helper-expr.js';

/**
 * Regression: the helper-expr injection guard must accept JSON object/array
 * arguments — getConsole({...}), dispatchAction({...}) — not just quoted-string
 * args, while still rejecting injection. The original guard banned `{}` outright,
 * which broke cdp_console_log (handshake OK, but the helper call was refused).
 * The guard now validates the argument list is pure JSON *data* (which cannot
 * carry executable code), so it is both more permissive (object literals) AND
 * stricter (rejects nested calls the old `[^;{}]*` regex let through).
 */

// ── Accepts every legitimate production call shape ──

test('accepts a JSON object-literal argument (getConsole) — the regression', () => {
  assert.equal(
    helperExpr('getConsole({"level":"all","limit":50})', true),
    '__RN_DEV_BRIDGE__.getConsole({"level":"all","limit":50})',
  );
});

test('accepts a nested-object argument (dispatchAction)', () => {
  const call =
    'dispatchAction({"action":"tasks/add","payload":{"title":"x"},"readPath":"tasks.items"})';
  assert.equal(helperExpr(call, false), `__QAREN.${call}`);
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

test('does NOT corrupt a JSON string value of "undefined" (validation-only normalization)', () => {
  const call = 'dispatchAction({"action":"x","payload":"undefined"})';
  // accepted, and the interpolated call keeps the original string intact
  assert.equal(helperExpr(call, true), `__RN_DEV_BRIDGE__.${call}`);
});

// ── Still rejects injection (defense in depth) ──

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
