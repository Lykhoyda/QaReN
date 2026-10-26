import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'node:test';
import {
  _setCapabilitiesForTest,
  _setFetchForTest,
  _setRunnerStateForTest,
  captureRunnerScreenshot,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { captureQaScreenshot } from '../../../dist/qa/screenshot.js';
import {
  _setForTest as rawCapture,
  _resetForTest as resetRawCapture,
} from '../../../dist/handlers/device-screenshot-raw.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';

const UDID = '9386B79E-DAB5-45A3-BC86-984F403B3CC1';
const originalExecFile = childProcess.execFile;
// The client caches the container per device, so every test shares one.
const container = mkdtempSync(join(tmpdir(), 'runner-container-'));
let lookups: string[][];
let rawCalls: number;

function runnerReturns(data: unknown, ok = true): void {
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
      });
    return Response.json(ok ? { ok, data } : { ok, error: { message: 'refused' } });
  });
}

beforeEach(() => {
  rmSync(container, { recursive: true, force: true });
  mkdirSync(join(container, 'tmp'), { recursive: true });
  lookups = [];
  rawCalls = 0;
  rawCapture({
    iosCapturer: async (_device, path) => {
      rawCalls += 1;
      writeFileSync(path, 'other-app-private-pixels');
      return true;
    },
  });
  const fake = ((_: string, args: string[], __: unknown, done: (...r: unknown[]) => void) => {
    lookups.push(args);
    done(null, `${container}\n`, '');
  }) as unknown as typeof childProcess.execFile;
  Object.assign(fake, {
    [promisify.custom]: async (_: string, args: string[]) => {
      lookups.push(args);
      return { stdout: `${container}\n`, stderr: '' };
    },
  });
  childProcess.execFile = fake;
  syncBuiltinESMExports();
  _setCapabilitiesForTest(['QA_READ_ONLY_V1']);
  _setRunnerStateForTest({
    port: 22089,
    pid: process.pid,
    deviceId: UDID,
    bundleId: 'com.test',
    startedAt: 'now',
  });
});

afterEach(() => {
  resetRawCapture();
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  _setFetchForTest(globalThis.fetch);
  _setRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
});

test('a runner screenshot moves out of the runner container to the row path', async () => {
  writeFileSync(join(container, 'tmp', 'screenshot-1.png'), 'png-bytes');
  runnerReturns({ message: 'tmp/screenshot-1.png' });
  const destination = join(container, 'row.png');
  assert.deepEqual(await captureQaScreenshot('ios', destination, UDID, 'com.test'), { ok: true });
  assert.equal(readFileSync(destination, 'utf8'), 'png-bytes');
  assert.equal(existsSync(join(container, 'tmp', 'screenshot-1.png')), false);
  assert.deepEqual(lookups, [
    [
      'simctl',
      'get_app_container',
      UDID,
      'dev.lykhoyda.rndevagent.fastrunner.uitests.xctrunner',
      'data',
    ],
  ]);
});

test('a refused or unexpected runner screenshot reports unavailable', async () => {
  const destination = join(container, 'row.png');
  runnerReturns(undefined, false);
  assert.equal(await captureRunnerScreenshot(UDID, 'com.test', destination), false);
  // Warm the container cache so a regression that follows a crafted path finds a real file.
  writeFileSync(join(container, 'tmp', 'screenshot-2.png'), 'warm');
  runnerReturns({ message: 'tmp/screenshot-2.png' });
  assert.equal(await captureRunnerScreenshot(UDID, 'com.test', join(container, 'warm.png')), true);
  writeFileSync(join(container, 'secret.png'), 'sentinel');
  for (const message of [
    'tmp/../secret.png',
    'secret.png',
    'tmp/screenshot-1.png/../../secret.png',
    42,
  ]) {
    runnerReturns({ message });
    assert.equal(await captureRunnerScreenshot(UDID, 'com.test', destination), false);
    assert.equal(existsSync(destination), false, String(message));
  }
  assert.equal(readFileSync(join(container, 'secret.png'), 'utf8'), 'sentinel');
  assert.equal(await captureRunnerScreenshot('not-a-simulator', 'com.test', destination), false);
  assert.equal(existsSync(destination), false);
});

for (const failure of [
  'app-not-running',
  'target-changed',
  'unknown-runner',
  'admission',
  'invalid-path',
  'missing-device',
]) {
  test(`QA screenshot ${failure} never captures raw or persists other-app pixels`, async () => {
    runnerReturns({ message: 'tmp/../secret.png' });
    if (failure === 'app-not-running' || failure === 'target-changed') {
      _setFetchForTest(async (url) =>
        String(url).endsWith('/health')
          ? Response.json({
              ok: true,
              protocolVersion: 2,
              commands: REQUIRED_IOS_COMMANDS,
              capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
            })
          : Response.json({
              ok: false,
              error: {
                code: 'ACTION_CONTEXT_CHANGED',
                reason: failure,
                message: 'private refusal detail',
              },
            }),
      );
    }
    if (failure === 'unknown-runner') _setRunnerStateForTest(null);
    if (failure === 'admission') {
      _setFetchForTest(async () =>
        Response.json({
          ok: true,
          protocolVersion: 2,
          commands: REQUIRED_IOS_COMMANDS,
          capabilities: REQUIRED_IOS_FEATURES,
        }),
      );
    }
    const path = join(container, 'unavailable.png');
    const result = await captureQaScreenshot(
      'ios',
      path,
      failure === 'missing-device' ? undefined : UDID,
      'com.test',
    );
    assert.deepEqual(result, {
      ok: false,
      reason:
        failure === 'missing-device'
          ? 'TARGET_IDENTITY_UNAVAILABLE'
          : 'RUNNER_SCREENSHOT_UNAVAILABLE',
    });
    assert.equal(rawCalls, 0);
    assert.deepEqual(lookups, []);
    assert.equal(existsSync(path), false);
    assert.doesNotMatch(JSON.stringify(result), /private refusal detail|other-app-private-pixels/);
  });
}

test('Android QA screenshots keep the inspected-device capture path', async () => {
  const path = join(container, 'android.png');
  const devices: string[] = [];
  rawCapture({
    androidCapturer: async (device, destination) => {
      devices.push(device);
      writeFileSync(destination, 'observed-app-pixels');
      return true;
    },
  });
  const result = await captureQaScreenshot('android', path, 'emulator-5554', 'com.test');
  assert.equal(result.ok, true);
  assert.deepEqual(devices, ['emulator-5554']);
  assert.equal(readFileSync(path, 'utf8'), 'observed-app-pixels');
});
