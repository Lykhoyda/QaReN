import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { clearActiveSession, setActiveSession } from '../../dist/agent-device-wrapper.js';
import { createDeviceSnapshotHandler } from '../../dist/handlers/device-session.js';

afterEach(() => clearActiveSession());

test('supported iOS runner close restores the cold-rebuild recovery credit', async () => {
  let resets = 0;
  let unbinds = 0;
  const deviceId = randomUUID().toUpperCase();
  const terminated: Array<string | undefined> = [];
  setActiveSession({
    name: 'runner-budget',
    platform: 'ios',
    deviceId,
    appId: 'com.rndevagent.testapp',
  });
  const handler = createDeviceSnapshotHandler({
    terminateIosRunnerHost: async (id) => {
      terminated.push(id);
    },
    resetIosRunnerRebuildBudget: () => {
      resets += 1;
    },
    unbindRunner: async (beforeRelease) => {
      unbinds += 1;
      beforeRelease?.('ios');
    },
  });

  const result = await handler({ action: 'close' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 1);
  assert.equal(unbinds, 1);
  assert.deepEqual(terminated, [deviceId]);
});

test('idempotent close resets iOS recovery credit for stranded runner authority', async () => {
  let resets = 0;
  let unbinds = 0;
  const handler = createDeviceSnapshotHandler({
    resetIosRunnerRebuildBudget: () => {
      resets += 1;
    },
    unbindRunner: async (beforeRelease) => {
      unbinds += 1;
      beforeRelease?.('ios');
    },
  });

  const result = await handler({ action: 'close', platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 1);
  assert.equal(unbinds, 1);
});

test('idempotent close restores iOS rebuild credit after runner authority was parked', async () => {
  let resets = 0;
  let unbinds = 0;
  const handler = createDeviceSnapshotHandler({
    resetIosRunnerRebuildBudget: () => {
      resets += 1;
    },
    unbindRunner: async () => {
      unbinds += 1;
    },
  });

  const result = await handler({ action: 'close', platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(resets, 1);
  assert.equal(unbinds, 1);
});

test('refused iOS open can recover through supported close and reopen', async () => {
  const previousKillLegacy = process.env.RN_DEVICE_KILL_LEGACY;
  process.env.RN_DEVICE_KILL_LEGACY = '0';
  const deviceId = randomUUID().toUpperCase();
  let rebuildCredit = false;
  let ensureCalls = 0;
  let stoppedRunners = 0;
  const handler = createDeviceSnapshotHandler({
    isAppRunning: async () => true,
    ensureIosRunner: async () => {
      ensureCalls += 1;
      return rebuildCredit
        ? { ok: true as const }
        : {
            ok: false as const,
            code: 'RUNNER_COMMANDS_STALE' as const,
            message: 'runner rebuild credit is unavailable',
          };
    },
    stopIosRunner: async () => {
      stoppedRunners += 1;
    },
    bindRunner: async () => {},
    unbindRunner: async () => {},
    resetIosRunnerRebuildBudget: () => {
      rebuildCredit = true;
    },
  });

  try {
    const first = await handler({
      action: 'open',
      platform: 'ios',
      deviceId,
      appId: 'com.rndevagent.testapp',
      attachOnly: true,
    });
    assert.equal(JSON.parse(first.content[0].text).ok, false);
    assert.equal(stoppedRunners, 1);

    const close = await handler({ action: 'close', platform: 'ios' });
    assert.equal(JSON.parse(close.content[0].text).ok, true);
    assert.equal(rebuildCredit, true);

    const reopened = await handler({
      action: 'open',
      platform: 'ios',
      deviceId,
      appId: 'com.rndevagent.testapp',
      attachOnly: true,
    });
    assert.equal(JSON.parse(reopened.content[0].text).ok, true);
    assert.equal(ensureCalls, 2);
  } finally {
    if (previousKillLegacy === undefined) delete process.env.RN_DEVICE_KILL_LEGACY;
    else process.env.RN_DEVICE_KILL_LEGACY = previousKillLegacy;
  }
});
