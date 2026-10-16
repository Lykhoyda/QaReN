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
      ? 'iOS fast scroll waits for an unchanged hierarchy before returning its settle receipt'
      : 'RN_SETTLE=0 disables post-scroll probes and settle metadata',
    async () => {
      const previousSettle = process.env.RN_SETTLE;
      process.env.RN_SETTLE = enabled ? '1' : '0';
      const bodies: Array<Record<string, unknown>> = [];
      let snapshots = 0;
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
        if (body.command === 'snapshot') {
          snapshots += 1;
          return Response.json({ ok: true, data: { nodes: [] }, v: 1 });
        }
        assert.equal(body.command, 'drag');
        return Response.json({ ok: true });
      }) as typeof fetch);
      try {
        const result = await createDeviceScrollHandler()({ direction: 'down', distance: 300 });
        const envelope = JSON.parse(result.content[0].text);
        assert.equal(envelope.ok, true);
        if (enabled) {
          assert.deepEqual(envelope.meta?.settle, { method: 'snapshot-eq', settled: true });
          assert.equal(snapshots, 2);
        } else {
          assert.equal(envelope.meta?.settle, undefined);
          assert.equal(snapshots, 0);
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
