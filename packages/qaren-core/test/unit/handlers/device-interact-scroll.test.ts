import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDirectionalScrollCliArgs,
  createDeviceScrollHandler,
} from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import {
  resetActiveSessionInMemoryForTest,
  setActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';

test('a precise band drag stays 10% inside its edges', () => {
  updateRefMapFromFlat([
    { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
  ]);
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, {
      x: 0,
      y: 100,
      width: 402,
      height: 700,
    }).map(Number);
    assert.ok(y1 <= 730 && y2 >= 170, `${y1} -> ${y2}`);
  } finally {
    clearRefMap();
  }
});

test('a band outside the window refuses', () => {
  updateRefMapFromFlat([
    { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
  ]);
  try {
    assert.throws(
      () =>
        buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, {
          x: 0,
          y: 1000,
          width: 402,
          height: 100,
        }),
      /SCROLL_BAND_TOO_SMALL/,
    );
  } finally {
    clearRefMap();
  }
});

test('a 50px precise band shrinks its dead zone to preserve a 48px drag', () => {
  updateRefMapFromFlat([
    { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
  ]);
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, {
      x: 0,
      y: 300,
      width: 402,
      height: 50,
    }).map(Number);
    assert.deepEqual([y1, y2], [349, 301]);
    assert.equal(y1 - y2, 48);
  } finally {
    clearRefMap();
  }
});

for (const platform of ['ios', 'android'] as const) {
  const pointScale = platform === 'android' ? 2.625 : 1;
  const topInset = platform === 'android' ? 48 * pointScale : 20;
  const bottomInset = platform === 'android' ? 48 * pointScale : 34;
  const height = platform === 'android' ? 2400 : 844;
  const width = platform === 'android' ? 1080 : 390;

  function withWindow(run: () => void): void {
    setActiveSessionInMemoryForTest({
      name: 'test-scroll-edges',
      platform,
      deviceId: 'TEST-DEVICE',
      openedAt: '2026-10-18T00:00:00.000Z',
    });
    updateRefMapFromFlat(
      [{ ref: '@e0', type: 'Window', rect: { x: 0, y: 0, width, height }, hittable: true }],
      { snapshotGeneration: 1, keyboardVisible: false, pointScale },
    );
    try {
      run();
    } finally {
      clearRefMap();
      resetActiveSessionInMemoryForTest();
    }
  }

  test(`${platform} scroll endpoints stay outside the window gesture insets`, () => {
    withWindow(() => {
      for (const direction of ['up', 'down'] as const) {
        for (const distance of [undefined, 5000]) {
          for (const top of [0, 300]) {
            const [, , y1, , y2] = buildDirectionalScrollCliArgs(
              direction,
              0.6,
              undefined,
              distance,
              { x: 0, y: top, width, height: height - top },
            ).map(Number);
            for (const y of [y1, y2]) {
              assert.ok(y >= topInset, `${direction}: ${y} < ${topInset}`);
              assert.ok(y <= height - bottomInset, `${direction}: ${y} > ${height - bottomInset}`);
            }
          }
        }
      }
    });
  });

  test(`${platform} interior scroll bands keep their dead zone`, () => {
    withWindow(() => {
      assert.deepEqual(
        buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, {
          x: 0,
          y: 300,
          width,
          height: 200,
        }),
        ['scroll', String(width / 2), '480', String(width / 2), '320', '300'],
      );
    });
  });

  test(`${platform} a gesture-inset-clamped band too short to drag still refuses`, () => {
    withWindow(() => {
      for (const band of [
        { x: 0, y: height - bottomInset - 40, width, height: bottomInset + 40 },
        { x: 0, y: 0, width, height: topInset + 40 },
        { x: 0, y: height - 20, width, height: 20 },
      ]) {
        assert.throws(
          () => buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, band),
          /SCROLL_BAND_TOO_SMALL/,
        );
      }
    });
  });
}

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
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 }, hittable: true },
  ]);
  try {
    for (const within of [
      { x: 0, y: 300, width: 390, height: 40 },
      { x: 0, y: 770, width: 390, height: 74 },
    ]) {
      const result = await createDeviceScrollHandler()({ direction: 'down', within });
      const envelope = JSON.parse(result.content[0].text);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.code, 'SCROLL_BAND_TOO_SMALL');
      assert.equal(envelope.meta?.mutation, 'none');
    }
    assert.deepEqual(bodies, []);
  } finally {
    clearRefMap();
    resetActiveSessionInMemoryForTest();
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
  }
});
