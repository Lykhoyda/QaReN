import { test } from 'node:test';
import assert from 'node:assert/strict';
import { okResult, failResult, warnResult } from '../../dist/utils.js';
import { parseEnvelope, expectOk, expectWarn } from '../helpers/result-helpers.js';

// ── okResult ──────────────────────────────────────────────────────────

test('okResult wraps data in envelope with ok:true', () => {
  const result = okResult({ count: 5, items: ['a'] });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.deepEqual(env.data, { count: 5, items: ['a'] });
  assert.equal(result.isError, undefined);
});

test('okResult with truncated flag', () => {
  const result = okResult({ value: 'x' }, { truncated: true });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.truncated, true);
});

test('okResult with meta', () => {
  const result = okResult({ v: 1 }, { meta: { hint: 'hello' } });
  const env = parseEnvelope(result);
  assert.equal(env.meta.hint, 'hello');
});

test('okResult wraps null data', () => {
  const result = okResult(null);
  assert.deepEqual(expectOk(result), null);
});

// ── failResult ────────────────────────────────────────────────────────

test('failResult wraps error string with ok:false and isError flag', () => {
  const result = failResult('something broke');
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'something broke');
  assert.equal(result.isError, true);
});

test('failResult with meta', () => {
  const result = failResult('err', { hint: 'try again' });
  const env = parseEnvelope(result);
  assert.equal(env.meta.hint, 'try again');
});

// ── warnResult ────────────────────────────────────────────────────────

test('warnResult wraps data with ok:true and meta.warning', () => {
  const result = warnResult({ status: 'degraded' }, 'SOMETHING_WRONG');
  const { data, warning } = expectWarn(result);
  assert.deepEqual(data, { status: 'degraded' });
  assert.equal(warning, 'SOMETHING_WRONG');
  assert.equal(result.isError, undefined);
});

test('warnResult merges additional meta with warning', () => {
  const result = warnResult({ v: 1 }, 'WARN', { extra: 42 });
  const env = parseEnvelope(result);
  assert.equal(env.meta.warning, 'WARN');
  assert.equal(env.meta.extra, 42);
});

// ── envelope structure ────────────────────────────────────────────────

test('result content is always a single text item', () => {
  const ok = okResult({ a: 1 });
  const fail = failResult('err');
  const warn = warnResult({}, 'W');

  for (const r of [ok, fail, warn]) {
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, 'text');
    assert.equal(typeof r.content[0].text, 'string');
    JSON.parse(r.content[0].text); // must be valid JSON
  }
});
