// GH #136 PR-A: explicit-platform raw screenshot path. When the caller passes
// `platform: 'ios' | 'android'` explicitly (not inferred from CDP target),
// device_screenshot bypasses `runAgentDevice` and uses xcrun simctl / adb
// directly to disambiguate when both an iOS sim and an Android emu are booted.
//
// Tests cover (1) pure parsers for `xcrun simctl list -j devices booted` JSON
// and `adb devices` stdout, (2) the `tryRawScreenshot` orchestrator branches
// (now returning a discriminated union `{ok:true,path}` | `{ok:false,reason}`),
// and (3) the device-list `captureAndResizeScreenshot` plumbing — that the
// raw path is taken when `platformExplicit` is true, and **hard-fails with an
// actionable SCREENSHOT_FAILED envelope** when raw fails (per PR-B; the
// original PR-A graceful-fallback was the regression vector for #136).
// Implicit-platform Android calls (platformExplicit=false) still route through
// runAgentDevice — backward parity preserved. Implicit iOS moved to the raw
// path in GH #422 (the runner's screenshot verb can't honor the caller path).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const RAW_MOD = '../../dist/handlers/device-screenshot-raw.js';

// ── resolveCaptureOutcome (deepsec 2026-05-12 follow-up) ────────────
// The Android capturer waits for BOTH the WriteStream's 'finish' event AND
// adb's exit code before settling. Node doesn't order these two events, so
// the decision helper must report 'pending' until both have arrived, and
// only return 'success' when both happened cleanly. The earlier version
// resolved on whichever fired first — adb exiting non-zero after the
// stream finished was silently swallowed (deepsec finding "Android
// screenshot can report success before adb exit status is known").

test('resolveCaptureOutcome: pending until both signals arrive', async () => {
  const { resolveCaptureOutcome } = await import(RAW_MOD);
  assert.equal(resolveCaptureOutcome(false, null), 'pending');
  assert.equal(resolveCaptureOutcome(true, null), 'pending');
  assert.equal(resolveCaptureOutcome(false, 0), 'pending');
});

test('resolveCaptureOutcome: success only when stream finished AND exit code 0', async () => {
  const { resolveCaptureOutcome } = await import(RAW_MOD);
  assert.equal(resolveCaptureOutcome(true, 0), 'success');
});

test('resolveCaptureOutcome: stream finished + non-zero exit → failure (the deepsec race)', async () => {
  const { resolveCaptureOutcome } = await import(RAW_MOD);
  // This is the exact scenario the deepsec scan caught: WriteStream drained
  // cleanly, then adb exited with non-zero status. Prior code reported
  // success on the 'finish' event; the new code must report failure once
  // both signals are in.
  assert.equal(resolveCaptureOutcome(true, 1), 'failure');
  assert.equal(resolveCaptureOutcome(true, 127), 'failure');
  assert.equal(resolveCaptureOutcome(true, -1), 'failure');
});

// ── Pure parsers ────────────────────────────────────────────────────

test('parseSimctlBootedAll: returns Booted device UDIDs, skips Shutdown', async () => {
  const { parseSimctlBootedAll } = await import(RAW_MOD);
  // `xcrun simctl list -j devices booted` actually only returns booted devices,
  // but the parser should still tolerate mixed state in case the caller passes
  // unfiltered output.
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'ABC-SHUTDOWN', state: 'Shutdown', name: 'iPhone 16' },
        { udid: 'DEF-BOOTED-IOS', state: 'Booted', name: 'iPhone 17 Pro' },
      ],
    },
  });
  assert.deepEqual(parseSimctlBootedAll(json), ['DEF-BOOTED-IOS']);
});

test('parseSimctlBootedAll: ignores booted non-iOS runtimes (GH #422 hardening)', async () => {
  const { parseSimctlBootedAll } = await import(RAW_MOD);
  // A booted paired Apple Watch precedes the iPhone in the runtime map; the
  // iOS resolvers must never count it.
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { udid: 'WATCH-BOOTED', state: 'Booted', name: 'Apple Watch Series 10' },
      ],
      'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
        { udid: 'TV-BOOTED', state: 'Booted', name: 'Apple TV 4K' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'PHONE-BOOTED', state: 'Booted', name: 'iPhone 17 Pro' },
      ],
    },
  });
  assert.deepEqual(parseSimctlBootedAll(json), ['PHONE-BOOTED']);
});

test('resolveIosUdid: booted watchOS sim must not make the single iOS sim ambiguous (GH #422 hardening)', async () => {
  const { resolveIosUdid } = await import(RAW_MOD);
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { udid: 'WATCH-BOOTED', state: 'Booted', name: 'Apple Watch Series 10' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'PHONE-BOOTED', state: 'Booted', name: 'iPhone 17 Pro' },
      ],
    },
  });
  assert.equal(await resolveIosUdid(undefined, async () => json), 'PHONE-BOOTED');
});

test('resolveIosUdid: TWO booted iOS sims → undefined (ambiguity must refuse, never first-pick — GH #422)', async () => {
  const { resolveIosUdid } = await import(RAW_MOD);
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'PHONE-A', state: 'Booted', name: 'iPhone 16' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { udid: 'PHONE-B', state: 'Booted', name: 'iPhone 17 Pro' },
      ],
    },
  });
  assert.equal(await resolveIosUdid(undefined, async () => json), undefined);
});

test('parseSimctlBootedAll: returns [] on no Booted device or malformed JSON', async () => {
  const { parseSimctlBootedAll } = await import(RAW_MOD);
  // No booted device
  const noBootedJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'X', state: 'Shutdown', name: 'iPhone 16' },
      ],
    },
  });
  assert.deepEqual(parseSimctlBootedAll(noBootedJson), []);
  // Empty devices object
  assert.deepEqual(parseSimctlBootedAll(JSON.stringify({ devices: {} })), []);
  // Malformed JSON
  assert.deepEqual(parseSimctlBootedAll('not-json'), []);
  // Missing devices key
  assert.deepEqual(parseSimctlBootedAll('{}'), []);
});

// GH #428: the first-pick parseAdbDevicesEmu was removed — with several
// emulators booted and no session binding it silently captured the wrong
// device. The Android adb-devices parser + exactly-one-or-refuse resolver
// (parseAdbDevicesEmuAll / resolveAndroidEmu) are covered in
// gh-428-android-raw-screenshot.test.ts, mirroring the iOS parseSimctlBootedAll
// tests above.

// ── tryRawScreenshot orchestrator ───────────────────────────────────

test('tryRawScreenshot(ios): resolver returns UDID, capturer succeeds → envelope returned', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  const captures = [];
  _setForTest({
    iosResolver: async () => 'DEF-UDID',
    iosCapturer: async (udid, path) => {
      captures.push({ udid, path });
      return true;
    },
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.deepEqual(result, { ok: true, path: '/tmp/shot.jpg' });
    assert.deepEqual(captures, [{ udid: 'DEF-UDID', path: '/tmp/shot.jpg' }]);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(ios): resolver returns null → ok:false with reason no-device (no capture attempt)', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  let capturerCalled = false;
  _setForTest({
    iosResolver: async () => null,
    iosCapturer: async () => {
      capturerCalled = true;
      return true;
    },
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.deepEqual(result, { ok: false, reason: 'no-device' });
    assert.equal(capturerCalled, false);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(ios): capturer fails → ok:false with reason capture-failed', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  _setForTest({
    iosResolver: async () => 'UDID-X',
    iosCapturer: async () => false,
  });
  try {
    const result = await tryRawScreenshot('ios', '/tmp/shot.jpg');
    assert.deepEqual(result, { ok: false, reason: 'capture-failed' });
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(android): resolver returns emu-id, capturer succeeds → envelope returned', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  const captures = [];
  _setForTest({
    androidResolver: async () => 'emulator-5556',
    androidCapturer: async (emuId, path) => {
      captures.push({ emuId, path });
      return true;
    },
  });
  try {
    const result = await tryRawScreenshot('android', '/tmp/shot.png');
    assert.deepEqual(result, { ok: true, path: '/tmp/shot.png' });
    assert.deepEqual(captures, [{ emuId: 'emulator-5556', path: '/tmp/shot.png' }]);
  } finally {
    _resetForTest();
  }
});

test('tryRawScreenshot(android): capturer fails → ok:false capture-failed (mirrors iOS for symmetry)', async () => {
  const mod = await import(RAW_MOD);
  const { tryRawScreenshot, _setForTest, _resetForTest } = mod;
  _setForTest({
    androidResolver: async () => 'emulator-5556',
    androidCapturer: async () => false,
  });
  try {
    const result = await tryRawScreenshot('android', '/tmp/shot.png');
    assert.deepEqual(result, { ok: false, reason: 'capture-failed' });
  } finally {
    _resetForTest();
  }
});

// ── device-list integration ─────────────────────────────────────────
