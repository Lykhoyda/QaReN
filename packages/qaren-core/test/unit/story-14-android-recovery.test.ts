import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAndroid,
  androidIsWindowUpdatingProbe,
  _setFetchForTest,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';

// The real AndroidRunnerState requires schemaVersion/devicePort/protocolVersion.
// pid MUST be a live process (process.pid) so runAndroid's mandatory
// startAndroidRunner ensure path reuses the injected runner instead of spawning
// a real `adb instrument` — the same seam gh-243-android-runner-health.test.js uses.
function state() {
  return {
    schemaVersion: 1,
    hostPort: 22111,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-5554',
    bundleId: 'com.example',
    startedAt: new Date().toISOString(),
    protocolVersion: 1,
  };
}

function jsonReply(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// startAndroidRunner's reuse gate probes GET /health and requires a compatible
// protocol + full command surface before it will adopt the injected runner.
function healthReply() {
  return jsonReply({
    ok: true,
    protocolVersion: 1,
    commands: [...REQUIRED_ANDROID_COMMANDS],
    capabilities: [...REQUIRED_ANDROID_FEATURES],
  });
}

beforeEach(() => {
  _setAndroidRunnerStateForTest(state());
});

afterEach(() => {
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
});

test('lost tap response + probe completed → recovered result, exactly one tap sent', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'tap')
      throw Object.assign(new Error('socket hang up'), { name: 'FetchError' });
    assert.equal(body.command, 'status');
    assert.ok(body.commandId.length > 8);
    return jsonReply({
      ok: true,
      v: 1,
      data: {
        commandId: body.commandId,
        state: 'completed',
        result: { ok: true, v: 1, data: { x: 10, y: 20, tapped: true } },
      },
    });
  });
  const res = await runAndroid({ command: 'tap', x: 10, y: 20 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['tap', 'status']);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.meta.transportRecovery.outcome, 'recovered');
});

test('lost tap + probe failed-with-result → recorded runner error surfaces', async () => {
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({
      ok: true,
      v: 1,
      data: {
        commandId: body.commandId,
        state: 'failed',
        result: { ok: false, v: 1, error: { code: 'RUNNER_ERROR', message: 'element vanished' } },
      },
    });
  });
  const res = await runAndroid({ command: 'tap', x: 1, y: 1 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /element vanished/);
});

test('lost tap + probe unknown → maps to RN_ANDROID_RUNNER_DOWN, no resend', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'unknown' } });
  });
  const res = await runAndroid({ command: 'tap', x: 1, y: 1 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RN_ANDROID_RUNNER_DOWN/);
  assert.deepEqual(sent, ['tap', 'status']);
});

test('lost snapshot + probe completed-unretained → resent once', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'snapshot' && sent.filter((c) => c === 'snapshot').length === 1) {
      throw new Error('socket hang up');
    }
    if (body.command === 'status') {
      return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'completed' } });
    }
    return jsonReply({ ok: true, v: 1, data: { nodes: [] } });
  });
  const res = await runAndroid({ command: 'snapshot' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['snapshot', 'status', 'snapshot']);
});

test('old runner: probe answered UNSUPPORTED_COMMAND → original error maps to RN_ANDROID_RUNNER_DOWN', async () => {
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: false, v: 1, error: { code: 'UNSUPPORTED_COMMAND', message: 'nope' } });
  });
  const res = await runAndroid({ command: 'tap', x: 1, y: 1 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RN_ANDROID_RUNNER_DOWN/);
});

test('probe itself failing → original error maps to RN_ANDROID_RUNNER_DOWN (probe was attempted)', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    sent.push(body.command);
    throw new Error('socket hang up');
  });
  const res = await runAndroid({ command: 'tap', x: 1, y: 1 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RN_ANDROID_RUNNER_DOWN/);
  assert.deepEqual(sent, ['tap', 'status']);
});

test('pre-send failure (no runner state) → no probe attempted', async () => {
  _setAndroidRunnerStateForTest(null);
  let calls = 0;
  _setFetchForTest(async () => {
    calls += 1;
    throw new Error('unreachable');
  });
  // The settle probe reaches postCommand's not-started guard directly (it skips
  // the ensure path by design), so the pre-send guard can be exercised without
  // spawning a real instrument. A non-ambiguous "not started" never probes.
  const res = await androidIsWindowUpdatingProbe(500, undefined, undefined);
  assert.equal(res, null);
  assert.equal(calls, 0);
});

test('recovery happens before RN_ANDROID_RUNNER_DOWN mapping', async () => {
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthReply();
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('fetch failed');
    return jsonReply({
      ok: true,
      v: 1,
      data: {
        commandId: body.commandId,
        state: 'completed',
        result: { ok: true, v: 1, data: { tapped: true } },
      },
    });
  });
  const res = await runAndroid({ command: 'tap', x: 5, y: 5 });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.meta.transportRecovery.outcome, 'recovered');
});

test('unrecovered connection failure still maps to RN_ANDROID_RUNNER_DOWN', async () => {
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health')) return healthReply();
    throw new Error('fetch failed');
  });
  const res = await runAndroid({ command: 'tap', x: 5, y: 5 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RN_ANDROID_RUNNER_DOWN/);
});
