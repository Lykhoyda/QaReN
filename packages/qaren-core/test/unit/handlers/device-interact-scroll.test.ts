import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceScrollHandler } from '../../../dist/handlers/device-interact.js';
import {
  resetActiveSessionInMemoryForTest,
  setActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';

for (const enabled of [true, false]) {
  test(
    enabled
      ? 'iOS fast scroll waits for a static screen before returning its settle receipt'
      : 'RN_SETTLE=0 disables post-scroll probes and settle metadata',
    async () => {
      const previousSettle = process.env.RN_SETTLE;
      process.env.RN_SETTLE = enabled ? '1' : '0';
      const bodies: Array<Record<string, unknown>> = [];
      let probes = 0;
      _setFastRunnerStateForTest({
        schemaVersion: 1,
        pid: process.pid,
        port: 4242,
        deviceId: 'TEST-UDID',
        bundleId: 'dev.lykhoyda.rndevagent.fastrunner',
        startedAt: '2026-10-13T00:00:00.000Z',
        protocolVersion: 1,
      });
      _setCapabilitiesForTest(['SCREEN_STATIC']);
      setActiveSessionInMemoryForTest({
        name: 'test-scroll',
        platform: 'ios',
        deviceId: 'TEST-UDID',
        openedAt: '2026-10-13T00:00:00.000Z',
        appId: 'dev.lykhoyda.rndevagent.fixture',
      });
      _setFetchForTest((async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.command === 'isScreenStatic') {
          probes += 1;
          return Response.json({ ok: true, data: { static: probes >= 3 }, v: 1 });
        }
        assert.equal(body.command, 'drag');
        return Response.json({ ok: true });
      }) as typeof fetch);
      try {
        const result = await createDeviceScrollHandler()({ direction: 'down', distance: 300 });
        const envelope = JSON.parse(result.content[0].text);
        assert.equal(envelope.ok, true);
        if (enabled) {
          assert.deepEqual(envelope.meta?.settle, { method: 'screen-static', settled: true });
          assert.equal(probes, 3);
        } else {
          assert.equal(envelope.meta?.settle, undefined);
          assert.equal(probes, 0);
        }
        assert.equal(bodies.filter((body) => body.command === 'drag').length, 1);
        assert.ok(bodies.every((body) => body.appBundleId === 'dev.lykhoyda.rndevagent.fixture'));
      } finally {
        if (previousSettle === undefined) delete process.env.RN_SETTLE;
        else process.env.RN_SETTLE = previousSettle;
        resetActiveSessionInMemoryForTest();
        _setFetchForTest(globalThis.fetch);
        _setFastRunnerStateForTest(null);
        _setCapabilitiesForTest([]);
      }
    },
  );
}

test('a scroll band too short for a real drag refuses before any runner call, so it cannot land as a tap', async () => {
  const bodies: unknown[] = [];
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: process.pid,
    port: 4242,
    deviceId: 'TEST-UDID',
    bundleId: 'dev.lykhoyda.rndevagent.fastrunner',
    startedAt: '2026-10-13T00:00:00.000Z',
    protocolVersion: 1,
  });
  setActiveSessionInMemoryForTest({
    name: 'test-scroll',
    platform: 'ios',
    deviceId: 'TEST-UDID',
    openedAt: '2026-10-13T00:00:00.000Z',
    appId: 'dev.lykhoyda.rndevagent.fixture',
  });
  _setFetchForTest((async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch);
  try {
    const result = await createDeviceScrollHandler()({
      direction: 'down',
      within: { x: 0, y: 300, width: 390, height: 40 },
    });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'SCROLL_BAND_TOO_SMALL');
    assert.equal(envelope.meta?.mutation, 'none');
    assert.deepEqual(bodies, []);
  } finally {
    resetActiveSessionInMemoryForTest();
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
  }
});
