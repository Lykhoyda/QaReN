import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reapMismatchedAndroidRunner,
  shouldReapAndroidRunnerBeforeStart,
  shouldReuseAndroidRunner,
} from '../../dist/runners/rn-android-runner-client.js';

// Audit H4: parity with iOS shouldReuseRunner. A live Android runner bound to
// emulator-A must NOT be reused to drive emulator-B (its adb forward + port
// still target A — every device_* would silently hit the wrong emulator).

const LEASE = `session-a:${'f'.repeat(32)}`;
process.env.QAREN_DEVICE_LEASE = LEASE;

const stateFor = (deviceId) => ({
  hostPort: 22089,
  devicePort: 22089,
  pid: 4242,
  deviceId,
  startedAt: 'now',
  sessionId: LEASE,
  claimEpoch: 1,
  capability: 'x'.repeat(32),
});

test('H4: same emulator → reuse', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor('emulator-5554'), 'emulator-5554'), true);
});

test('H4: different emulator → do NOT reuse (the wrong-device bug)', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor('emulator-5554'), 'emulator-5556'), false);
});

test('H4: no live runner → cannot reuse', () => {
  assert.equal(shouldReuseAndroidRunner(null, 'emulator-5554'), false);
});

test('H4: no target requested never expands exact-device authority', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor('emulator-5554'), undefined), false);
});

test('H4: runner with no recorded device + a specific target requested → do not reuse', () => {
  assert.equal(shouldReuseAndroidRunner(stateFor(undefined), 'emulator-5556'), false);
});

test('H4: sibling claim epoch cannot reuse the runner', () => {
  assert.equal(
    shouldReuseAndroidRunner({ ...stateFor('emulator-5554'), claimEpoch: 6 }, 'emulator-5554'),
    false,
  );
});

test('a live non-reusable runner is reaped before replacement', () => {
  assert.equal(
    shouldReapAndroidRunnerBeforeStart(
      { ...stateFor('emulator-5554'), claimEpoch: 6 },
      'emulator-5554',
      true,
    ),
    true,
  );
  assert.equal(
    shouldReapAndroidRunnerBeforeStart(stateFor('emulator-5554'), 'emulator-5554', true),
    false,
  );
});

test('runner replacement targets recorded device and requires decisive cleanup', async () => {
  let target;
  let verified;
  const state = stateFor('emulator-5554');
  await reapMismatchedAndroidRunner(
    state,
    async (opts) => {
      target = opts.deviceId;
      return {
        stoppedOwnRunner: true,
        forceStoppedPackages: [
          'dev.lykhoyda.rndevagent.androidrunner.test',
          'dev.lykhoyda.rndevagent.androidrunner',
        ],
      };
    },
    async (released) => {
      verified = released.deviceId;
    },
  );
  assert.equal(target, 'emulator-5554');
  assert.equal(verified, 'emulator-5554');

  await assert.rejects(
    () =>
      reapMismatchedAndroidRunner(state, async () => ({
        stoppedOwnRunner: true,
        forceStoppedPackages: ['dev.lykhoyda.rndevagent.androidrunner.test'],
      })),
    /RUNNER_CLEANUP_UNCONFIRMED/,
  );
});
