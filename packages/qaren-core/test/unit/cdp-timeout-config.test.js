import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CDP_TIMEOUT_FAST,
  CDP_TIMEOUT_MS,
  CDP_TIMEOUT_SLOW,
  defaultTimeout,
  timeoutForMethod,
} from '../../dist/cdp/timeout-config.js';

// B118/D637: Android emulator JS thread is 50-170× slower than iOS for
// Runtime.evaluate. The platform-aware timeout doubles the budget on Android
// while leaving iOS unchanged.

test('defaultTimeout returns base CDP_TIMEOUT_MS when no platform given', () => {
  assert.equal(defaultTimeout(), CDP_TIMEOUT_MS);
  assert.equal(defaultTimeout(null), CDP_TIMEOUT_MS);
});

test('defaultTimeout leaves iOS at the base timeout', () => {
  assert.equal(defaultTimeout('ios'), CDP_TIMEOUT_MS);
});

test('defaultTimeout doubles Android timeout', () => {
  assert.equal(defaultTimeout('android'), CDP_TIMEOUT_MS * 2);
});

test('timeoutForMethod falls through to CDP_TIMEOUT_MS for unknown methods', () => {
  assert.equal(timeoutForMethod('Runtime.evaluate'), CDP_TIMEOUT_MS);
  assert.equal(timeoutForMethod('SomeBespoke.call'), CDP_TIMEOUT_MS);
});

test('timeoutForMethod returns the mapped FAST timeout for fast methods', () => {
  assert.equal(timeoutForMethod('Runtime.getHeapUsage'), CDP_TIMEOUT_FAST);
  assert.equal(timeoutForMethod('Log.enable'), CDP_TIMEOUT_FAST);
  assert.equal(timeoutForMethod('Log.disable'), CDP_TIMEOUT_FAST);
});

test('timeoutForMethod returns the mapped SLOW timeout for slow methods', () => {
  assert.equal(timeoutForMethod('HeapProfiler.takeHeapSnapshot'), CDP_TIMEOUT_SLOW);
  assert.equal(timeoutForMethod('Profiler.start'), CDP_TIMEOUT_SLOW);
  assert.equal(timeoutForMethod('Network.getResponseBody'), CDP_TIMEOUT_SLOW);
});

test('timeoutForMethod with android doubles fast-class timeouts', () => {
  assert.equal(timeoutForMethod('Runtime.getHeapUsage', 'android'), CDP_TIMEOUT_FAST * 2);
  assert.equal(timeoutForMethod('Log.enable', 'android'), CDP_TIMEOUT_FAST * 2);
});

test('timeoutForMethod with android doubles slow-class timeouts', () => {
  assert.equal(timeoutForMethod('HeapProfiler.takeHeapSnapshot', 'android'), CDP_TIMEOUT_SLOW * 2);
});

test('timeoutForMethod with android doubles default (Runtime.evaluate path)', () => {
  assert.equal(timeoutForMethod('Runtime.evaluate', 'android'), CDP_TIMEOUT_MS * 2);
});

test('timeoutForMethod with ios is the same as no platform', () => {
  assert.equal(timeoutForMethod('Runtime.evaluate', 'ios'), timeoutForMethod('Runtime.evaluate'));
  assert.equal(
    timeoutForMethod('HeapProfiler.takeHeapSnapshot', 'ios'),
    timeoutForMethod('HeapProfiler.takeHeapSnapshot'),
  );
});
