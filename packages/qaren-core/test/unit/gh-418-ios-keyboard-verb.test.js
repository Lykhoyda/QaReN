// GH #418 (B235 root cause): the iOS keyboard-dismiss wire verb must be the
// Swift enum's `keyboardDismiss` — 'dismissKeyboard' has never decoded on any
// iOS artifact. Android's wire verb stays 'dismissKeyboard' (Kotlin when-label).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';

test('gh-418: iOS keyboard CLI verb maps to keyboardDismiss on the wire', () => {
  assert.equal(buildRunIOSArgs(['keyboard']).command, 'keyboardDismiss');
});

test('gh-418: Android keyboard CLI verbs keep dismissKeyboard on the wire', () => {
  assert.equal(buildRunAndroidArgs(['keyboard']).command, 'dismissKeyboard');
  assert.equal(buildRunAndroidArgs(['dismissKeyboard']).command, 'dismissKeyboard');
});
