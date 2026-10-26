import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAndroid,
  _setFetchForTest,
  _setAndroidRunnerStateForTest,
} from '../../../dist/runners/rn-android-runner-client.js';
import { refCenter, clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../../dist/runners/protocol.js';

_setAndroidRunnerStateForTest({
  hostPort: 22089,
  devicePort: 22089,
  pid: process.pid,
  deviceId: 'emulator-5554',
  bundleId: 'com.example',
  startedAt: '2026-05-16T00:00:00.000Z',
});

let calls = [];
let response = { ok: true, data: {} };

_setFetchForTest(async (url, init) => {
  // GH #383: the reuse-time protocol gate probes GET /health on every
  // startAndroidRunner (runAndroid calls it per dispatch). Answer /health with a
  // compatible body so the live injected state is reused (not reaped); only
  // /command POSTs are recorded for the command-dispatch assertions.
  // GH #418: compatible now also requires the full advertised command surface.
  if (String(url).endsWith('/health')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        protocolVersion: 1,
        commands: [...REQUIRED_ANDROID_COMMANDS],
        capabilities: [...REQUIRED_ANDROID_FEATURES],
      }),
    };
  }
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => response };
});

afterEach(() => {
  calls = [];
  response = { ok: true, data: {} };
  clearRefMap();
});

test('runAndroid posts snapshot to /command with appBundleId', async () => {
  response = {
    ok: true,
    data: {
      nodes: [
        {
          index: 1,
          type: 'TextView',
          identifier: 'tab-home',
          rect: { x: 0, y: 0, width: 100, height: 50 },
        },
      ],
    },
  };
  const result = await runAndroid({ command: 'snapshot', bundleId: 'com.rndevagent.testapp' });
  assert.equal(result.isError, undefined);
  assert.match(calls[0].url, /\/command$/);
  assert.equal(calls[0].body.command, 'snapshot');
  assert.equal(calls[0].body.appBundleId, 'com.rndevagent.testapp');
  assert.deepEqual(refCenter('@e1'), { x: 50, y: 25 });
});

test('runAndroid tap posts coordinates', async () => {
  response = { ok: true, data: { tapped: true } };
  const result = await runAndroid({ command: 'tap', x: 12, y: 34, bundleId: 'com.example' });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].body.command, 'tap');
  assert.equal(calls[0].body.x, 12);
  assert.equal(calls[0].body.y, 34);
});

test('runAndroid returns STALE_REF without posting', async () => {
  const result = await runAndroid({ command: 'tap', _staleRef: '@e9' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(result.content[0].text, /STALE_REF|stale/i);
});

test('runAndroid surfaces runner error code', async () => {
  response = {
    ok: false,
    error: { code: 'APP_NOT_FOREGROUND', message: 'target did not foreground' },
  };
  const result = await runAndroid({ command: 'snapshot', bundleId: 'com.nope' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /target did not foreground/);
});
