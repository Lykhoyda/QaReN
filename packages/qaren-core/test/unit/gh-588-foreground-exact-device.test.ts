import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIosLaunchArgv,
  buildIosTerminateArgv,
  resolveIosLifecycleTarget,
} from '../../dist/handlers/app-lifecycle.js';

const UDID_A = '5C10B45B-2065-458B-B885-0F83F49747C8';
const UDID_B = '0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9';

test('GH-588: an exact UDID reaches the lifecycle argv verbatim, never the booted alias', () => {
  for (const udid of [UDID_A, UDID_B]) {
    assert.deepEqual(buildIosLaunchArgv('com.rndevagent.testapp', udid), [
      'simctl',
      'launch',
      udid,
      'com.rndevagent.testapp',
    ]);
    assert.deepEqual(buildIosTerminateArgv('com.rndevagent.testapp', udid), [
      'simctl',
      'terminate',
      udid,
      'com.rndevagent.testapp',
    ]);
  }
});

test('GH-588: two simulators produce two distinct argvs (counterfactual)', () => {
  const a = buildIosLaunchArgv('com.rndevagent.testapp', UDID_A);
  const b = buildIosLaunchArgv('com.rndevagent.testapp', UDID_B);
  assert.notDeepEqual(a, b);
  assert.ok(!a.includes('booted') && !b.includes('booted'));
});

test('GH-588: a non-UDID device identity is refused rather than silently widened', () => {
  for (const bogus of ['booted', 'iPhone 16 Pro', 'iPhone-16-Pro', '']) {
    assert.throws(
      () => resolveIosLifecycleTarget(bogus),
      /exact simulator UDID/,
      `"${bogus}" must not resolve to a lifecycle target`,
    );
  }
});

test('GH-588: only a wholly absent identity falls back to the booted alias', () => {
  assert.equal(resolveIosLifecycleTarget(undefined), 'booted');
  assert.deepEqual(buildIosLaunchArgv('com.rndevagent.testapp'), [
    'simctl',
    'launch',
    'booted',
    'com.rndevagent.testapp',
  ]);
});

test('GH-588: an empty bundleId is refused on both lifecycle argv builders', () => {
  assert.throws(() => buildIosLaunchArgv('', UDID_A), /bundleId is required/);
  assert.throws(() => buildIosTerminateArgv('', UDID_A), /bundleId is required/);
});
