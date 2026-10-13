import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInstrumentationRegistered,
  resolveAndroidInstallAction,
  buildAdbInstallArgs,
  buildGradleAssembleArgs,
} from '../../dist/runners/rn-android-runner-client.js';

const INSTR = 'dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner';

test('isInstrumentationRegistered: true when pm list contains the test package', () => {
  const out =
    'instrumentation:dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner (target=dev.lykhoyda.rndevagent.androidrunner)\n';
  assert.equal(isInstrumentationRegistered(out, INSTR), true);
});

test('isInstrumentationRegistered: false when absent or empty', () => {
  assert.equal(
    isInstrumentationRegistered('instrumentation:com.other/Runner (target=com.other)\n', INSTR),
    false,
  );
  assert.equal(isInstrumentationRegistered('', INSTR), false);
});

test('resolveAndroidInstallAction: reuse requires the expected main and test build identity', () => {
  const build = { appSha256: 'a'.repeat(64), testSha256: 'b'.repeat(64) };
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: true, apksExist: false }),
    'build-then-install',
  );
  assert.equal(
    resolveAndroidInstallAction({
      instrumentationRegistered: true,
      apksExist: true,
      expectedBuild: build,
      installedBuild: build,
    }),
    'reuse',
  );
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: true, apksExist: true }),
    'install',
  );
});

test('resolveAndroidInstallAction: install when not registered but APKs exist', () => {
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: true }),
    'install',
  );
});

test('resolveAndroidInstallAction: build-then-install when nothing present (fresh machine)', () => {
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: false }),
    'build-then-install',
  );
});

test('buildAdbInstallArgs: serial + install -r + apk path', () => {
  assert.deepEqual(buildAdbInstallArgs('emulator-5554', '/x/app-debug.apk'), [
    '-s',
    'emulator-5554',
    'install',
    '-r',
    '/x/app-debug.apk',
  ]);
});

test('buildAdbInstallArgs: no serial → bare install', () => {
  // (no deviceId, no ANDROID_SERIAL) — adbSerialArgs returns []
  const prev = process.env.ANDROID_SERIAL;
  delete process.env.ANDROID_SERIAL;
  try {
    assert.deepEqual(buildAdbInstallArgs(undefined, '/x/a.apk'), ['install', '-r', '/x/a.apk']);
  } finally {
    if (prev !== undefined) process.env.ANDROID_SERIAL = prev;
  }
});

test('buildGradleAssembleArgs: assembles both app + androidTest', () => {
  assert.deepEqual(buildGradleAssembleArgs(), [
    ':app:assembleDebug',
    ':app:assembleDebugAndroidTest',
    '--no-daemon',
    '-Pkotlin.compiler.execution.strategy=in-process',
  ]);
});

test('isInstrumentationRegistered: false on a superstring package (anchored, not substring)', () => {
  assert.equal(
    isInstrumentationRegistered(
      'instrumentation:dev.lykhoyda.rndevagent.androidrunner.testfoo/X (target=y)\n',
      INSTR,
    ),
    false,
  );
});

test('isInstrumentationRegistered: false when our id appears only inside a foreign (target=...) mention', () => {
  assert.equal(
    isInstrumentationRegistered(
      'instrumentation:com.foreign/Runner (target=dev.lykhoyda.rndevagent.androidrunner.test)\n',
      INSTR,
    ),
    false,
  );
});
