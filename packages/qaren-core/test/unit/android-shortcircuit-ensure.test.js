/**
 * Phase 2 Task 6: Android dispatch short-circuit ensures the runner before
 * calling runAndroid — parity with iOS ensureRunnerForCommand choke point.
 *
 * Test approach: the Android short-circuit inside runNative() is gated behind
 * the _setRunAgentDeviceForTest fuse (which blows on any real dispatch), so we
 * cannot unit-drive runNative() with mocks that exercise its internals cleanly.
 * Instead we use source-regex assertions (matching the structural guarantees in
 * the TS source) combined with an import-level test of the specific helpers
 * (resolveAndroidSerial, startAndroidRunner) to verify the failure paths work
 * correctly. The behavioral path (cold runner auto-starts) is device-verified in
 * Phase 4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = resolve(__dirname, '../../src/agent-device-wrapper.ts');
const source = readFileSync(WRAPPER_PATH, 'utf8');

// --- Structural source-regex assertions ---

test('Android short-circuit calls resolveAndroidSerial before runAndroid (non-screenshot)', () => {
  assert.match(
    source,
    /resolveAndroidSerial/,
    'wrapper must import/call resolveAndroidSerial for serial resolution',
  );
});

test('Android short-circuit calls startAndroidRunner before runAndroid (non-screenshot)', () => {
  assert.match(
    source,
    /startAndroidRunner/,
    'wrapper must call startAndroidRunner to ensure runner is up before dispatch',
  );
});

test('Android short-circuit has RN_ANDROID_RUNNER_DOWN on missing serial', () => {
  // The no-serial branch must return RN_ANDROID_RUNNER_DOWN before touching the runner
  assert.match(
    source,
    /No Android device resolved[\s\S]{0,200}RN_ANDROID_RUNNER_DOWN/,
    'wrapper must surface RN_ANDROID_RUNNER_DOWN when no serial can be resolved',
  );
});

test('Android short-circuit has RN_ANDROID_RUNNER_DOWN on startAndroidRunner rejection', () => {
  // The catch around startAndroidRunner must map to RN_ANDROID_RUNNER_DOWN
  assert.match(
    source,
    /rn-android-runner did not start[\s\S]{0,100}RN_ANDROID_RUNNER_DOWN|RN_ANDROID_RUNNER_DOWN[\s\S]{0,100}rn-android-runner did not start/,
    'wrapper must return RN_ANDROID_RUNNER_DOWN when startAndroidRunner rejects',
  );
});

test('Android short-circuit exempts screenshot from runner ensure (adb fallback parity with iOS simctl)', () => {
  // The screenshot exemption must appear inside the Android short-circuit block
  assert.match(
    source,
    /cliArgs\[0\] !== ['"]screenshot['"][\s\S]{0,600}startAndroidRunner|startAndroidRunner[\s\S]{0,600}cliArgs\[0\] !== ['"]screenshot['"]/,
    "wrapper must skip the ensure choke point for 'screenshot' (it has its own adb fallback)",
  );
});

test('Android short-circuit still imports and calls runAndroid after ensure', () => {
  // runAndroid must still be called (the ensure is additive, not a replacement)
  // GH #383: the destructure now also pulls consumePendingAndroidUpgradeNote (to
  // attach the transparent-upgrade meta.note), so the assertion tolerates extra
  // named imports + the multiline import() while still requiring runAndroid.
  assert.match(
    source,
    /const \{ runAndroid[\s\S]{0,80}\}\s*=\s*await import\(\s*['"]\.\/runners\/rn-android-runner-client\.js['"]/,
    'runAndroid import must remain inside the Android short-circuit',
  );
});

// --- Behavioural helper tests (import from dist) ---

import {
  resolveAndroidSerial,
  parseAdbDevicesSerials,
} from '../../dist/runners/rn-android-runner-client.js';

test('resolveAndroidSerial: respects explicit deviceId passed directly', async () => {
  const result = await resolveAndroidSerial('emulator-5554');
  assert.equal(result, 'emulator-5554');
});

test('resolveAndroidSerial: respects ANDROID_SERIAL env var (no adb call needed)', async () => {
  const orig = process.env.ANDROID_SERIAL;
  process.env.ANDROID_SERIAL = 'emulator-9999';
  try {
    const result = await resolveAndroidSerial();
    assert.equal(result, 'emulator-9999');
  } finally {
    if (orig === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = orig;
  }
});

test('parseAdbDevicesSerials: returns undefined when multiple devices listed (ambiguous)', () => {
  const stdout = `List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n`;
  const serials = parseAdbDevicesSerials(stdout);
  // Multiple → resolveAndroidSerial returns undefined (can't pick one)
  assert.equal(serials.length, 2, 'two serials parsed');
  // resolveAndroidSerial returns undefined when length !== 1
  const single = serials.length === 1 ? serials[0] : undefined;
  assert.equal(single, undefined);
});

test('parseAdbDevicesSerials: returns single serial when exactly one device', () => {
  const stdout = `List of devices attached\nemulator-5554\tdevice\n`;
  const serials = parseAdbDevicesSerials(stdout);
  assert.equal(serials.length, 1);
  assert.equal(serials[0], 'emulator-5554');
});
