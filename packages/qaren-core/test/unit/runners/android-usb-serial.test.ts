import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAndroidUsbSerial } from '../../../dist/runners/external-runner-detect.js';

test('USB-only admission rejects emulator and wireless transport names', () => {
  for (const [serial, expected] of [
    ['0A1B2C3D', true],
    ['emulator-5554', false],
    ['emulator-invalid', false],
    ['127.0.0.1:5555', false],
    ['adb-0A1B2C3D-AbCdEf._adb-tls-connect._tcp', false],
    ['adb-0A1B2C3D-AbCdEf._adb._tcp', false],
  ] as const) {
    assert.equal(isAndroidUsbSerial(serial), expected, serial);
  }
});
