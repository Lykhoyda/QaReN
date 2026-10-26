// test/unit/gh-263-tap-latency.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTapLatencies,
  median,
  resolveFloorMs,
  classifyRuntimeDegradation,
  formatRuntimeDegradedHint,
  augmentFailureWithDegradation,
  DEFAULT_FLOOR_MS,
} from '../../dist/domain/tap-latency.js';

const DEGRADED = `  ✓ launchApp (2.3s)
  ✓ tapOn: id="a" (2.8s)
  ✓ tapOn: id="b" (3.0s)
  ✓ assertVisible: text="x" (1.1s)
  ✗ tapOn: id="c" (12.7s)
✗ rn-maestro-run 23.8s`;

const NORMAL = `  ✓ launchApp (1.0s)
  ✓ tapOn: id="a" (0.7s)
  ✓ tapOn: id="b" (0.9s)
  ✗ assertVisible: text="x" (10.0s)
✗ rn-maestro-run 12.0s`;

// A genuine "element not found" failure with ONE tap that timed out — the ✗
// duration must NOT be counted, else this false-positives as degraded.
const SINGLE_FAILED_TAP = `  ✓ launchApp (1.1s)
  ✗ tapOn: id="missing" (12.7s)
✗ rn-maestro-run 14.0s`;

test('parseTapLatencies: only successful (✓) tapOn lines, seconds→ms', () => {
  assert.deepEqual(parseTapLatencies(DEGRADED), [2800, 3000]);
});

test('parseTapLatencies: a single failed (✗) tap yields no samples (no false positive)', () => {
  assert.deepEqual(parseTapLatencies(SINGLE_FAILED_TAP), []);
});

test('parseTapLatencies: output with no tapOn lines → []', () => {
  assert.deepEqual(parseTapLatencies('  ✓ launchApp (2.0s)\n✓ rn-maestro-run 2.0s'), []);
  assert.deepEqual(parseTapLatencies(''), []);
});

// GH #312 / B212: parseTapLatencies delegates to parseSteps, so the same trim
// caveat applies — an UNINDENTED (column-0) tap-shaped app log must not become
// a latency sample (it would skew the wedge median off untrusted output).
test('parseTapLatencies: an unindented (column-0) tap-shaped app log is not a sample (B212)', () => {
  assert.deepEqual(parseTapLatencies('✓ tapOn: id="x" (2.0s)\n✓ tapOn: id="y" (2.5s)'), []);
  // \r-prefixed (common in terminal/progress output) must not skew the median either
  assert.deepEqual(parseTapLatencies('\r✓ tapOn: id="x" (2.0s)\n\r✓ tapOn: id="y" (2.5s)'), []);
});

// Review finding #2: a non-tap step whose text VALUE contains "tapOn" must not
// be counted (anchor on the step verb, not a substring match).
test('parseTapLatencies: "tapOn" inside another step\'s text value is not a tap sample', () => {
  assert.deepEqual(parseTapLatencies('  ✓ assertVisible: text="tapOn the button" (3.0s)'), []);
});

// Review finding #1 (both reviewers, verified vs the canonical #105 fixture):
// one successful tap before an element-not-found failure must NOT be flagged
// degraded — a single slow cold-start tap is normal, and hinting "reboot" on an
// ordinary missing-element failure is the exact misdirection this feature fights.
const SINGLE_SUCCESS_THEN_NOTFOUND = `  ✓ launchApp (2.3s)
  ✓ tapOn: id="tab-tasks" (2.8s)
  ✓ assertVisible: text="Tasks" (1.3s)
  ✗ tapOn: id="task-mark-all-done" (12.7s)
      ╰─ Element not found: id='task-mark-all-done'
✗ rn-maestro-run 23.8s`;

test('classifyRuntimeDegradation: a single successful slow tap is NOT degraded (needs ≥2 samples)', () => {
  const d = classifyRuntimeDegradation(SINGLE_SUCCESS_THEN_NOTFOUND, 1500);
  assert.equal(d.sampleCount, 1);
  assert.equal(d.medianMs, 2800);
  assert.equal(d.degraded, false, 'one slow tap is not enough evidence of a wedge');
});

test('median: odd, even, single, empty', () => {
  assert.equal(median([3000, 2800, 1000]), 2800); // sorted 1000,2800,3000
  assert.equal(median([2800, 3000]), 2900); // average of two middle
  assert.equal(median([1500]), 1500);
  assert.equal(median([]), null);
});

test('resolveFloorMs: default, valid override, invalid → default', () => {
  assert.equal(resolveFloorMs(undefined), DEFAULT_FLOOR_MS);
  assert.equal(DEFAULT_FLOOR_MS, 1500);
  assert.equal(resolveFloorMs('2000'), 2000);
  assert.equal(resolveFloorMs('abc'), DEFAULT_FLOOR_MS);
  assert.equal(resolveFloorMs('0'), DEFAULT_FLOOR_MS);
  assert.equal(resolveFloorMs('-5'), DEFAULT_FLOOR_MS);
});

test('classifyRuntimeDegradation: degraded when median ≥ floor', () => {
  const d = classifyRuntimeDegradation(DEGRADED, 1500);
  assert.equal(d.degraded, true);
  assert.equal(d.medianMs, 2900); // median of [2800,3000]
  assert.equal(d.sampleCount, 2);
  assert.equal(d.floorMs, 1500);
});

test('classifyRuntimeDegradation: normal latency is not degraded', () => {
  const d = classifyRuntimeDegradation(NORMAL, 1500);
  assert.equal(d.degraded, false);
  assert.equal(d.medianMs, 800); // median of [700,900]
});

test('classifyRuntimeDegradation: no tap samples → not degraded, medianMs null', () => {
  const d = classifyRuntimeDegradation(SINGLE_FAILED_TAP, 1500);
  assert.equal(d.degraded, false);
  assert.equal(d.medianMs, null);
  assert.equal(d.sampleCount, 0);
});

test('formatRuntimeDegradedHint: names the code, median, floor, and reboot', () => {
  const hint = formatRuntimeDegradedHint(classifyRuntimeDegradation(DEGRADED, 1500));
  assert.match(hint, /RUNTIME_DEGRADED/);
  assert.match(hint, /2900ms/);
  assert.match(hint, /1500ms/);
  assert.match(hint, /simctl shutdown/);
});

test('augmentFailureWithDegradation: degraded → hint appended + meta.runtimeDegraded', () => {
  const { message, meta } = augmentFailureWithDegradation(DEGRADED, 1500, 'Flow failed', {
    passed: false,
  });
  assert.match(message, /Flow failed — RUNTIME_DEGRADED:/);
  assert.deepEqual(meta.runtimeDegraded, { medianTapMs: 2900, floorMs: 1500, sampleCount: 2 });
  assert.equal(meta.passed, false); // base meta preserved
});

test('augmentFailureWithDegradation: not degraded → message + meta unchanged', () => {
  const base = { passed: false, output: 'x' };
  const { message, meta } = augmentFailureWithDegradation(NORMAL, 1500, 'Flow failed', base);
  assert.equal(message, 'Flow failed');
  assert.equal(meta.runtimeDegraded, undefined);
  assert.deepEqual(meta, base);
});
