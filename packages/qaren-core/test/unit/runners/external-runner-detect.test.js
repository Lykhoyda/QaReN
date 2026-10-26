import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAndroidExternalRunner } from '../../../dist/runners/external-runner-detect.js';

test('detectAndroidExternalRunner warns on competing uiautomator process', async () => {
  const fakeExec = async (_bin, _args, _opts) => ({
    stdout: 'shell        1234  1  uiautomator runtest upstream\n',
  });
  const warning = await detectAndroidExternalRunner(fakeExec, ['-s', 'emulator-5554']);
  assert.equal(warning.code, 'ANDROID_UIAUTOMATOR_COMPETITOR');
  assert.equal(warning.processLines.length, 1);
});

test('detectAndroidExternalRunner ignores our own runner package', async () => {
  const fakeExec = async () => ({
    stdout: 'u0_a123      2222  1  dev.lykhoyda.rndevagent.androidrunner\n',
  });
  const warning = await detectAndroidExternalRunner(fakeExec, ['-s', 'emulator-5554']);
  assert.equal(warning, null);
});
