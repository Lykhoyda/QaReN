import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAndroidUsbSerial } from '../../../dist/runners/external-runner-detect.js';

// The CLI's `is_usb_serial` table (plan 7.4-6, first column). The wireless names are built from
// adb's mDNS service types, not captured; `adb-0A1B2C3D` has no service type and stays a serial.
test('USB-only admission rejects emulator, endpoint and wireless transport names', () => {
  for (const [serial, expected] of [
    ['0A1B2C3D', true],
    ['R58M12ABCDE', true],
    ['a.b_c-d', true],
    ['adb-0A1B2C3D', true],
    ['adb-0A1B2C3D-AbCdEf._adb-tls-connect._tcp', false],
    ['adb-0A1B2C3D-AbCdEf._adb-tls-connect._tcp.', false],
    ['adb-0A1B2C3D._adb._tcp', false],
    ['????????????', false],
    ['emulator-5554', false],
    ['emulator-invalid', false],
    ['127.0.0.1:5555', false],
    ['', false],
    ['-s', false],
    ['has space', false],
  ] as const) {
    assert.equal(isAndroidUsbSerial(serial), expected, serial);
  }
});
