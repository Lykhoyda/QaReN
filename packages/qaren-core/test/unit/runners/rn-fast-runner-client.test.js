import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runIOS,
  _setFetchForTest,
  _setRunnerStateForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';

// Pin a fake state so the client can resolve a port without spawning xcodebuild.
_setRunnerStateForTest({
  port: 12345,
  pid: 99999,
  deviceId: 'TEST-DEVICE',
  bundleId: 'com.example',
  startedAt: '2026-05-15T00:00:00.000Z',
});

let mockCalls = [];
let mockResponse = null;
_setFetchForTest(async (url, init) => {
  mockCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => mockResponse };
});

test('runIOS snapshot: POSTs /command with command=snapshot and bundleId', async () => {
  mockCalls = [];
  mockResponse = {
    ok: true,
    data: {
      tree: { type: 'Application', frame: { x: 0, y: 0, width: 393, height: 852 }, children: [] },
    },
  };
  const result = await runIOS({ command: 'snapshot', bundleId: 'com.example' });
  assert.equal(result.isError, undefined);
  assert.equal(mockCalls.length, 1);
  assert.match(mockCalls[0].url, /\/command$/);
  assert.equal(mockCalls[0].body.command, 'snapshot');
  assert.equal(mockCalls[0].body.appBundleId, 'com.example');
});

test('runIOS tap: POSTs /command with command=tap + coords', async () => {
  mockCalls = [];
  mockResponse = { ok: true, data: { x: 50, y: 100 } };
  const result = await runIOS({ command: 'tap', x: 50, y: 100, bundleId: 'com.example' });
  assert.equal(result.isError, undefined);
  assert.equal(mockCalls[0].body.command, 'tap');
  assert.equal(mockCalls[0].body.x, 50);
  assert.equal(mockCalls[0].body.y, 100);
});

test('runIOS surfaces runner error envelope', async () => {
  mockCalls = [];
  mockResponse = { ok: false, error: { message: 'app not running', code: 'APP_NOT_RUNNING' } };
  const result = await runIOS({ command: 'tap', x: 1, y: 1, bundleId: 'com.nope' });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.match(env.error, /app not running/);
});
