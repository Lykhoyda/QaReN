// CDP-004: Android launch must be package-scoped via `-p` flag, not a bare
// trailing bundleId. Bare bundleId is parsed as an intent URI which can
// resolve to unrelated packages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAndroidLaunchArgv } from '../../dist/handlers/app-lifecycle.js';

test('CDP-004: argv contains -p <bundleId> immediately after the LAUNCHER category', () => {
  const argv = buildAndroidLaunchArgv('com.example.app');
  const idx = argv.indexOf('-p');
  assert.ok(idx >= 0, 'argv must include -p flag');
  assert.equal(argv[idx + 1], 'com.example.app', '-p must be followed by the bundleId');
});

test('CDP-004: argv does NOT contain a bare (un-flagged) bundleId', () => {
  const argv = buildAndroidLaunchArgv('com.example.app');
  // bundleId may appear once, immediately after -p. The bug shape was
  // `am start -a MAIN -c LAUNCHER <bundleId>` with bundleId as a bare
  // positional. The fixed shape is `... -p <bundleId>` — flag-scoped.
  const occurrences = argv.filter((a) => a === 'com.example.app').length;
  assert.equal(occurrences, 1, 'bundleId should only appear once');
  const bundleIdIdx = argv.indexOf('com.example.app');
  assert.equal(
    argv[bundleIdIdx - 1],
    '-p',
    'bundleId must be preceded by -p (flag-scoped, not bare)',
  );
});

test('CDP-004: argv structure matches expected shape (am start -W -a MAIN -c LAUNCHER -p PKG)', () => {
  const argv = buildAndroidLaunchArgv('com.example.app');
  assert.deepEqual(argv, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-p',
    'com.example.app',
  ]);
});

test('CDP-004: empty bundleId is rejected (defensive)', () => {
  assert.throws(() => buildAndroidLaunchArgv(''), /bundleId is required/);
});

test('CDP-004: non-string bundleId is rejected', () => {
  // @ts-expect-error — testing runtime validation
  assert.throws(() => buildAndroidLaunchArgv(undefined), /bundleId is required/);
  // @ts-expect-error
  assert.throws(() => buildAndroidLaunchArgv(123), /bundleId is required/);
});

test('CDP-004: -W (wait flag) is present so launch failures are not silently lost', () => {
  const argv = buildAndroidLaunchArgv('com.example.app');
  assert.ok(argv.includes('-W'), '-W is needed so adb returns non-zero on launch failure');
});
