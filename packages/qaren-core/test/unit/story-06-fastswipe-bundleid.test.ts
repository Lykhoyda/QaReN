// Story 06 Phase B (#387): device_scroll/device_swipe dispatch through
// fastSwipe(), whose /command body omitted appBundleId. The runner treats a
// missing appBundleId as "no target" (executeOnMain clears currentApp), so it
// activated its OWN host app and dragged on a blank screen — every coordinate
// drag foreground-stole RnFastRunner and no-op'd with ok:true. Device-proven
// on the Phase B contract fixture (rows 1-11 static across 14 "ok" scrolls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fastSwipe,
  _setFastRunnerStateForTest,
  _setFetchForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import {
  createDeviceScrollHandler,
  createDeviceSwipeHandler,
} from '../../dist/handlers/device-interact.js';
import {
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from '../../dist/agent-device-wrapper.js';

function armFakeRunner(bodies: Array<Record<string, unknown>>) {
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    // process.pid: isFastRunnerAvailable() liveness-probes the pid, so it must
    // be a live process for the dispatch path to choose the fast-runner branch.
    pid: process.pid,
    port: 4242,
    deviceId: 'TEST-UDID',
    bundleId: 'dev.lykhoyda.rndevagent.fastrunner',
    startedAt: '2026-07-06T00:00:00.000Z',
    protocolVersion: 1,
  } as never);
  _setFetchForTest((async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as never);
}

function disarmFakeRunner() {
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
}

test('device_scroll dispatch carries the active session appId into the drag body', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  armFakeRunner(bodies);
  setActiveSessionInMemoryForTest({
    name: 'test-session',
    platform: 'ios',
    deviceId: 'TEST-UDID',
    openedAt: '2026-07-06T00:00:00.000Z',
    appId: 'dev.lykhoyda.rndevagent.fixture',
  });
  try {
    const result = await createDeviceScrollHandler()({ direction: 'down', amount: 1 });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(
      payload.ok,
      true,
      `scroll dispatch failed: ${result.content[0].text.slice(0, 300)}`,
    );
    const drag = bodies.find((b) => b.command === 'drag');
    assert.ok(drag, `no drag reached the runner; bodies: ${JSON.stringify(bodies).slice(0, 300)}`);
    assert.equal(
      drag.appBundleId,
      'dev.lykhoyda.rndevagent.fixture',
      'device_scroll must forward the session appId — omitting it makes the runner activate its own host app',
    );
  } finally {
    // In-memory reset only — clearActiveSession() would unlink the SHARED
    // session file and clobber a developer's live MCP session.
    resetActiveSessionInMemoryForTest();
    disarmFakeRunner();
  }
});

test('device_swipe dispatch carries the active session appId into the drag body', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  armFakeRunner(bodies);
  setActiveSessionInMemoryForTest({
    name: 'test-session',
    platform: 'ios',
    deviceId: 'TEST-UDID',
    openedAt: '2026-07-06T00:00:00.000Z',
    appId: 'dev.lykhoyda.rndevagent.fixture',
  });
  try {
    const result = await createDeviceSwipeHandler()({ x1: 10, y1: 400, x2: 10, y2: 100 });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(
      payload.ok,
      true,
      `swipe dispatch failed: ${result.content[0].text.slice(0, 300)}`,
    );
    const drag = bodies.find((b) => b.command === 'drag');
    assert.ok(drag, `no drag reached the runner; bodies: ${JSON.stringify(bodies).slice(0, 300)}`);
    assert.equal(
      drag.appBundleId,
      'dev.lykhoyda.rndevagent.fixture',
      'device_swipe must forward the session appId — omitting it makes the runner activate its own host app',
    );
  } finally {
    resetActiveSessionInMemoryForTest();
    disarmFakeRunner();
  }
});

test('fastSwipe sends appBundleId so the runner drags the TARGET app, not its own host', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  armFakeRunner(bodies);
  try {
    await fastSwipe(10, 20, 30, 40, 250, 'dev.lykhoyda.rndevagent.fixture');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].command, 'drag');
    assert.equal(
      bodies[0].appBundleId,
      'dev.lykhoyda.rndevagent.fixture',
      'drag body must carry the target appBundleId — without it the runner activates its own host app',
    );
  } finally {
    disarmFakeRunner();
  }
});

test('fastSwipe omits appBundleId when no target is provided (legacy shape preserved)', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  armFakeRunner(bodies);
  try {
    await fastSwipe(10, 20, 30, 40);
    assert.equal(bodies.length, 1);
    assert.ok(!('appBundleId' in bodies[0]), 'no target → no appBundleId key');
    assert.ok(!('durationMs' in bodies[0]), 'no duration → no durationMs key');
  } finally {
    disarmFakeRunner();
  }
});
