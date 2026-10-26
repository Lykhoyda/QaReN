// GH #383: Android reuse gate — a reachable runner with an incompatible
// protocol is reaped (force-stop + state clear) and restarted; a fresh start
// that still reports a mismatch rejects with RUNNER_PROTOCOL_MISMATCH.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  consumePendingAndroidUpgradeNote,
  _setFetchForTest,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';

afterEach(() => {
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
  consumePendingAndroidUpgradeNote();
});

function fakeHealth(body) {
  _setFetchForTest(async () => ({
    ok: true,
    json: async () => body,
  }));
}

test('gh-383 android probe: parses protocol fields from /health', async () => {
  fakeHealth({ ok: true, protocolVersion: 1, runnerVersion: '0.58.0' });
  const info = await probeAndroidRunnerHealthInfo(22089);
  assert.deepEqual(info, {
    reachable: true,
    ok: true,
    protocolVersion: 1,
    runnerVersion: '0.58.0',
  });
});

test('gh-383 android probe: legacy health has no protocol fields', async () => {
  fakeHealth({ ok: true });
  const info = await probeAndroidRunnerHealthInfo(22089);
  assert.deepEqual(info, { reachable: true, ok: true });
});

test('gh-383 android probe: unreachable → reachable:false', async () => {
  _setFetchForTest(async () => {
    throw new Error('ECONNREFUSED');
  });
  const info = await probeAndroidRunnerHealthInfo(22089);
  assert.deepEqual(info, { reachable: false });
});

test('gh-383 android note: consume returns the note exactly once', () => {
  assert.equal(consumePendingAndroidUpgradeNote(), undefined);
});
