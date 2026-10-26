import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeDeviceSession } from '../../../dist/handlers/device-session-close.js';
import { okResult } from '../../../dist/utils.js';

const device = '2E24DCF0-C991-4EB0-80CC-CCFEB9042A73';

function close(
  calls: string[],
  stop: () => Promise<void> = async () => {},
  terminate: () => Promise<void> = async () => {},
) {
  return closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => okResult({ closed: true }),
    clearActiveSession: () => calls.push('clear'),
    stopFastRunner: async (deviceId) => {
      calls.push(`stop:${deviceId}`);
      await stop();
    },
    terminateRunnerHost: async (deviceId) => {
      calls.push(`terminate:${deviceId}`);
      await terminate();
    },
    stopAndroidRunner: async () => {},
    finalizeSuccessfulClose: () => {},
    getDeviceId: () => device,
  });
}

test('closing a session terminates the runner host app after the verified runner stop', async () => {
  const calls: string[] = [];
  assert.equal((await close(calls)).isError, undefined);
  assert.deepEqual(calls, [`stop:${device}`, `terminate:${device}`, 'clear']);
});

test('an unverified runner stop leaves the host app and the session for recovery', async () => {
  const calls: string[] = [];
  await assert.rejects(
    close(calls, async () => {
      throw new Error('RUNNER_ADOPTION_REQUIRED');
    }),
    /RUNNER_ADOPTION_REQUIRED/,
  );
  assert.deepEqual(calls, [`stop:${device}`]);
});

test('a failed host termination keeps the session for recovery instead of reporting a clean close', async () => {
  const calls: string[] = [];
  await assert.rejects(
    close(
      calls,
      async () => {},
      async () => {
        throw new Error('simctl timed out');
      },
    ),
    /simctl timed out/,
  );
  assert.deepEqual(calls, [`stop:${device}`, `terminate:${device}`]);
});
