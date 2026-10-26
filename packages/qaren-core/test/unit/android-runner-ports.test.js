import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdbForwardArgs,
  buildAdbForwardRemoveArgs,
  buildInstrumentPortArgs,
  parseAdbDevicesSerials,
} from '../../dist/runners/rn-android-runner-client.js';

test('Android ports: adb forward maps probed hostPort → fixed devicePort', () => {
  assert.deepEqual(buildAdbForwardArgs('emulator-5554', 41001, 22089), [
    '-s',
    'emulator-5554',
    'forward',
    'tcp:41001',
    'tcp:22089',
  ]);
});
test('Android ports: instrumentation receives the DEVICE port, not the host port', () => {
  assert.deepEqual(buildInstrumentPortArgs(22089), ['-e', 'RN_ANDROID_RUNNER_PORT', '22089']);
});
test('Android ports: forward --remove targets the host port', () => {
  assert.deepEqual(buildAdbForwardRemoveArgs('emulator-5554', 41001), [
    '-s',
    'emulator-5554',
    'forward',
    '--remove',
    'tcp:41001',
  ]);
});
test('parseAdbDevicesSerials: extracts only online device serials', () => {
  const out = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n';
  assert.deepEqual(parseAdbDevicesSerials(out), ['emulator-5554']);
});
test('parseAdbDevicesSerials: tolerates trailing attributes (transport_id/product)', () => {
  const out =
    'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64 transport_id:1\nemulator-5556\toffline\n\n';
  assert.deepEqual(parseAdbDevicesSerials(out), ['emulator-5554']);
});
