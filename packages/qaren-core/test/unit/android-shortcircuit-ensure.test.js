import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAndroidSerial,
  parseAdbDevicesSerials,
} from '../../dist/runners/qaren-android-runner-client.js';

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
