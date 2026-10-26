import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runIOS,
  _setFetchForTest,
  _setRunnerStateForTest,
  _setHttpTimeoutForTest,
} from '../../dist/runners/rn-fast-runner-client.js';

function state() {
  return {
    schemaVersion: 1,
    port: 22088,
    pid: 999,
    deviceId: 'UDID-TEST',
    bundleId: 'com.test.app',
    startedAt: new Date().toISOString(),
    protocolVersion: 2,
  };
}

function jsonReply(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  _setRunnerStateForTest(state());
  _setHttpTimeoutForTest(null);
});

test('lost tap response + probe completed → recovered result, exactly one tap sent', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
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
        result: { ok: true, v: 1, data: { x: 10, y: 20 } },
      },
    });
  });
  const res = await runIOS({ command: 'tap', x: 10, y: 20 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['tap', 'status']);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.meta.transportRecovery.outcome, 'recovered');
});

test('lost tap + probe failed-with-result → recorded runner error surfaces', async () => {
  _setFetchForTest(async (url, init) => {
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
  const res = await runIOS({ command: 'tap', x: 1, y: 1 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /element vanished/);
});

test('lost tap + probe unknown → original transport error propagates, no resend', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'unknown' } });
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /socket hang up/);
  assert.deepEqual(sent, ['tap', 'status']);
});

test('lost snapshot + probe completed-unretained → resent once', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
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
  const res = await runIOS({ command: 'snapshot' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['snapshot', 'status', 'snapshot']);
});

test('old runner: probe answered UNSUPPORTED_COMMAND → original error propagates', async () => {
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: false, v: 1, error: { code: 'UNSUPPORTED_COMMAND', message: 'nope' } });
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /socket hang up/);
});

test('probe itself failing → original error propagates', async () => {
  _setFetchForTest(async () => {
    throw new Error('socket hang up');
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /socket hang up/);
});

test('pre-send failure (no runner state) → no probe attempted', async () => {
  _setRunnerStateForTest(null);
  let calls = 0;
  _setFetchForTest(async () => {
    calls += 1;
    throw new Error('unreachable');
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /not started/);
  assert.equal(calls, 0);
});
