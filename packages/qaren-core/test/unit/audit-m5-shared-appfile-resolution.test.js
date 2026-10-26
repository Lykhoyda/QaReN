import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppFileForClearState } from '../../dist/handlers/resolve-ios-app-file.js';

// Audit M5: the iOS clearState --app-file resolution (#201) must be shared by
// maestro_run, maestro_test_all, and runMaestroInline. This locks the shared
// helper's contract that all three now call.

const IOS_CLEARSTATE = '- launchApp:\n    clearState: true\n';
const NO_CLEARSTATE = '- launchApp\n';

test('M5: an explicit appFile is passed through untouched', () => {
  const r = resolveAppFileForClearState('ios', IOS_CLEARSTATE, 'com.app', '/built/My.app');
  assert.deepEqual(r, { ok: true, appFile: '/built/My.app' });
});

test('M5: a non-clearState flow needs no appFile', () => {
  const r = resolveAppFileForClearState('ios', NO_CLEARSTATE, 'com.app', undefined);
  assert.deepEqual(r, { ok: true });
});

test('M5: Android never needs an appFile even with clearState', () => {
  const r = resolveAppFileForClearState('android', IOS_CLEARSTATE, 'com.app', undefined);
  assert.deepEqual(r, { ok: true });
});

test('M5: iOS clearState with no appId is a structured error (not a silent miss)', () => {
  const r = resolveAppFileForClearState('ios', IOS_CLEARSTATE, undefined, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /no appId is known/);
});

test('M5: iOS clearState resolves via the injected container lookup (snapshotted — GH#186 contract)', () => {
  const r = resolveAppFileForClearState('ios', IOS_CLEARSTATE, 'com.app', undefined, {
    getAppContainer: () => '/Containers/My.app',
    exists: () => true,
    snapshotApp: () => '/tmp/rn-appfile-y/My.app',
  });
  assert.deepEqual(r, { ok: true, appFile: '/tmp/rn-appfile-y/My.app' });
});

test('M5: iOS clearState with no locatable .app is a structured error', () => {
  const r = resolveAppFileForClearState('ios', IOS_CLEARSTATE, 'com.app', undefined, {
    getAppContainer: () => null,
    newestDerivedDataApp: () => null,
    exists: () => false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no built \.app could be located/);
});
