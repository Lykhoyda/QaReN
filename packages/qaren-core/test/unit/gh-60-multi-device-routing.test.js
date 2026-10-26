import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdbSerial,
  setActiveSession,
  clearActiveSession,
} from '../../dist/agent-device-wrapper.js';

// GH #60: when an iOS session is active and a caller targets Android (e.g. via
// device_deeplink platform:"android" or any adb-backed flow), the iOS UDID
// would leak into adb's `-s <serial>` arg and produce "device not found".
// The fix gates the session-deviceId branch on session.platform === 'android'.

test('getAdbSerial: returns empty when iOS session is active and no ANDROID_SERIAL env', () => {
  const prevEnv = process.env.ANDROID_SERIAL;
  delete process.env.ANDROID_SERIAL;
  try {
    setActiveSession({
      name: 'ios-test',
      platform: 'ios',
      deviceId: 'ABCDEF12-1234-5678-9012-IOS-UDID-EXAMPLE',
    });
    assert.deepEqual(
      getAdbSerial(),
      [],
      'iOS UDID must not leak into adb args when session is iOS',
    );
  } finally {
    clearActiveSession();
    if (prevEnv !== undefined) process.env.ANDROID_SERIAL = prevEnv;
  }
});

test('getAdbSerial: returns ANDROID_SERIAL when iOS session is active', () => {
  const prevEnv = process.env.ANDROID_SERIAL;
  process.env.ANDROID_SERIAL = 'emulator-5554';
  try {
    setActiveSession({
      name: 'ios-test',
      platform: 'ios',
      deviceId: 'ABCDEF12-1234-5678-9012-IOS-UDID-EXAMPLE',
    });
    assert.deepEqual(
      getAdbSerial(),
      ['-s', 'emulator-5554'],
      'falls back to ANDROID_SERIAL when iOS session has nothing usable',
    );
  } finally {
    clearActiveSession();
    if (prevEnv === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = prevEnv;
  }
});

test('getAdbSerial: returns session.deviceId when Android session is active', () => {
  const prevEnv = process.env.ANDROID_SERIAL;
  delete process.env.ANDROID_SERIAL;
  try {
    setActiveSession({ name: 'android-test', platform: 'android', deviceId: 'emulator-5554' });
    assert.deepEqual(
      getAdbSerial(),
      ['-s', 'emulator-5554'],
      'Android session deviceId is the correct adb serial',
    );
  } finally {
    clearActiveSession();
    if (prevEnv !== undefined) process.env.ANDROID_SERIAL = prevEnv;
  }
});

test('getAdbSerial: prefers Android session.deviceId over ANDROID_SERIAL env', () => {
  const prevEnv = process.env.ANDROID_SERIAL;
  process.env.ANDROID_SERIAL = 'env-serial';
  try {
    setActiveSession({ name: 'android-test', platform: 'android', deviceId: 'emulator-5554' });
    assert.deepEqual(
      getAdbSerial(),
      ['-s', 'emulator-5554'],
      'session takes precedence over env when platform matches',
    );
  } finally {
    clearActiveSession();
    if (prevEnv === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = prevEnv;
  }
});

test('getAdbSerial: returns empty when no session and no env', () => {
  const prevEnv = process.env.ANDROID_SERIAL;
  delete process.env.ANDROID_SERIAL;
  try {
    clearActiveSession();
    assert.deepEqual(
      getAdbSerial(),
      [],
      'empty array → adb picks the only connected device, or errors loudly',
    );
  } finally {
    if (prevEnv !== undefined) process.env.ANDROID_SERIAL = prevEnv;
  }
});
