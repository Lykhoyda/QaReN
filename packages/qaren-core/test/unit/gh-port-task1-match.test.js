// Task 1 / port: RNTL matches() + getDefaultNormalizer -> __QAREN.__match.
// Single-matcher form: {value,exact?} for strings, {regexSource,regexFlags?}
// for regexes. Normalizer trims + collapses whitespace but does NOT lowercase
// (RNTL's case-insensitivity lives in the non-exact string compare, not the
// normalizer — kept separate from the existing lowercasing norm() at
// injected-helpers.ts:1114).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function sb() {
  // __match is a pure helper; a minimal root keeps createSandbox happy.
  const root = buildFiber({ name: 'App', children: [] });
  return createSandbox({ fiberRoot: root });
}

test('1: {value:"Login",exact:true} matches "Login" not "Login button"', () => {
  const s = sb();
  assert.equal(s.__QAREN.__match('Login', { value: 'Login', exact: true }), true);
  assert.equal(s.__QAREN.__match('Login button', { value: 'Login', exact: true }), false);
});

test('2: {value:"detail"} case-insensitively substring-matches "DeTaiLs"', () => {
  const s = sb();
  assert.equal(s.__QAREN.__match('DeTaiLs', { value: 'detail' }), true);
});

test('3: normalizer trims + collapses inner whitespace before compare', () => {
  const s = sb();
  assert.equal(s.__QAREN.__match('  Hello   World  ', { value: 'Hello World', exact: true }), true);
});

test('4: {regexSource:"^Save$"} matches "Save" not "Saved"', () => {
  const s = sb();
  assert.equal(s.__QAREN.__match('Save', { regexSource: '^Save$' }), true);
  assert.equal(s.__QAREN.__match('Saved', { regexSource: '^Save$' }), false);
});

test('5: {regexSource:"a",regexFlags:"g"} matches on two consecutive calls (lastIndex reset)', () => {
  const s = sb();
  const m = { regexSource: 'a', regexFlags: 'g' };
  assert.equal(s.__QAREN.__match('cat', m), true);
  assert.equal(s.__QAREN.__match('cat', m), true);
});

test('6: text undefined returns false', () => {
  const s = sb();
  assert.equal(s.__QAREN.__match(undefined, { value: 'x' }), false);
});

test('divergence guard: {value:"ABC",exact:true} does NOT match "abc" (no lowercasing)', () => {
  const s = sb();
  assert.equal(s.__QAREN.__match('abc', { value: 'ABC', exact: true }), false);
});

// ── source-grep regression guard (mirrors gh-60-bug-5-label-matching.test.js:422-432) ──
test('source guard: __match helper is attached and wired', () => {
  assert.match(INJECTED_HELPERS, /function __match\(/);
  assert.match(INJECTED_HELPERS, /__match: __match/);
  assert.match(INJECTED_HELPERS, /function __matchNormalize\(/);
});
