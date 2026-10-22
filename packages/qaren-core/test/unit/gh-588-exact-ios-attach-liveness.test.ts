import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIosAppRunningArgs,
  createDeviceSnapshotHandler,
  iosAppJobRunning,
  isAppRunning,
} from '../../dist/handlers/device-session.js';

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
// A per-process valid UDID avoids colliding with a real simulator lock held by
// another concurrent test/agent lane on the shared development machine.
const FOREIGN = randomUUID().toUpperCase();
const APP_ID = 'com.rndevagent.testapp';

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

test('GH-588: iOS liveness command targets the exact UDID and never booted', () => {
  const args = buildIosAppRunningArgs(EXACT);
  assert.deepEqual(args, ['simctl', 'spawn', EXACT, 'launchctl', 'list']);
  assert.equal(args.includes('booted'), false);
});

test('GH-588: the iOS job row needs a numeric PID and the exact bundle label', () => {
  const row = (pid: string, id: string) => `${pid}\t0\tUIKitApplication:${id}[0x1a2b][512]`;
  assert.equal(iosAppJobRunning(row('512', APP_ID), APP_ID), true);
  assert.equal(iosAppJobRunning(row('-', APP_ID), APP_ID), false);
  assert.equal(iosAppJobRunning(row('512', `${APP_ID}.sibling`), APP_ID), false);
  assert.equal(iosAppJobRunning('', APP_ID), false);
});

test('GH-588: multi-simulator liveness accepts only the supplied running UDID', async () => {
  const probed: string[] = [];
  const runningByDevice = new Map([
    [EXACT, true],
    [FOREIGN, false],
  ]);
  const ios = async (_bundleId: string, deviceId: string): Promise<boolean> => {
    probed.push(deviceId);
    return runningByDevice.get(deviceId) ?? false;
  };

  assert.equal(await isAppRunning('ios', APP_ID, { ios }, EXACT), true);
  assert.equal(await isAppRunning('ios', APP_ID, { ios }, FOREIGN), false);
  assert.deepEqual(probed, [EXACT, FOREIGN]);
});

test('GH-588: missing exact iOS identity refuses without probing booted', async () => {
  let probes = 0;
  const running = await isAppRunning('ios', APP_ID, {
    ios: async () => {
      probes++;
      return true;
    },
  });
  assert.equal(running, false);
  assert.equal(probes, 0);
});

test('GH-588: attachOnly refuses a wrong UDID even when another simulator runs the app', async () => {
  const calls: Array<{ platform: string; appId: string; deviceId: string }> = [];
  const handler = createDeviceSnapshotHandler({
    isAppRunning: async (platform, appId, deviceId) => {
      calls.push({ platform, appId, deviceId });
      return deviceId === EXACT;
    },
  });

  const result = await handler({
    action: 'open',
    platform: 'ios',
    deviceId: FOREIGN,
    appId: APP_ID,
    attachOnly: true,
  });
  const body = envelope(result);
  assert.equal(result.isError, true);
  assert.equal(body.code, 'NOT_CONNECTED');
  assert.match(body.error, /attachOnly=true.*not running/);
  assert.deepEqual(calls, [{ platform: 'ios', appId: APP_ID, deviceId: FOREIGN }]);
});

test('a failed or timed-out iOS liveness probe is reported as a failure, never as a dead app', async (t) => {
  const original = childProcess.execFile;
  t.after(() => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  });
  for (const failure of [
    Object.assign(new Error('Command failed'), { code: 1 }),
    Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }),
  ]) {
    let probed: unknown[] | undefined;
    childProcess.execFile = ((...args: unknown[]) => {
      probed = args;
      (args.at(-1) as (error: Error) => void)(failure);
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    await assert.rejects(isAppRunning('ios', APP_ID, undefined, EXACT), failure);
    assert.deepEqual(probed?.slice(0, 2), ['xcrun', buildIosAppRunningArgs(EXACT)]);
  }
});
