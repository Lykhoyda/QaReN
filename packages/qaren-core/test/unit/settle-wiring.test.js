import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  getAndroidRunnerCapabilities,
  _setFetchForTest as setAndroidFetch,
  _resetCapabilitiesForTest as resetAndroidCaps,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import { buildIosProbes, buildAndroidProbes } from '../../dist/lifecycle/settle.js';
import {
  runIOS,
  _setFetchForTest as setIosFetch,
  _setFastRunnerStateForTest,
  _resetCapabilitiesForTest as resetIosCaps,
} from '../../dist/runners/rn-fast-runner-client.js';

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });

const iosState = () => ({
  schemaVersion: 1,
  pid: process.pid,
  port: 22090,
  deviceId: 'TEST-UDID',
  bundleId: 'com.test',
  startedAt: '',
  protocolVersion: 1,
});

afterEach(() => {
  setIosFetch(globalThis.fetch);
  setAndroidFetch(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setAndroidRunnerStateForTest(null);
  resetAndroidCaps();
  resetIosCaps();
});

test('android /health probe parses + caches capabilities', async () => {
  setAndroidFetch(async () =>
    jsonResponse({ ok: true, protocolVersion: 1, capabilities: ['WINDOW_UPDATE'], commands: [] }),
  );
  const info = await probeAndroidRunnerHealthInfo(12345);
  assert.deepEqual(info.capabilities, ['WINDOW_UPDATE']);
  assert.deepEqual(getAndroidRunnerCapabilities(), ['WINDOW_UPDATE']);
});

test('runIOS dispatches isScreenStatic and returns {static}', async () => {
  _setFastRunnerStateForTest(iosState());
  let posted;
  setIosFetch(async (_url, init) => {
    posted = JSON.parse(init.body);
    return jsonResponse({ ok: true, data: { static: true }, v: 1 });
  });
  const result = await runIOS({ command: 'isScreenStatic', bundleId: 'com.test' });
  assert.equal(posted.command, 'isScreenStatic');
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.data.static, true);
});

test('buildIosProbes.isScreenStatic maps envelope → boolean, failure → null', async () => {
  _setFastRunnerStateForTest(iosState());
  setIosFetch(async () => jsonResponse({ ok: true, data: { static: false }, v: 1 }));
  const probes = buildIosProbes('com.test');
  assert.equal(await probes.isScreenStatic(), false);
  setIosFetch(async () => {
    throw new Error('boom');
  });
  assert.equal(await probes.isScreenStatic(), null);
});

test('buildAndroidProbes.isWindowUpdating posts timeoutMs and maps {updating}', async () => {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 23456,
    devicePort: 7100,
    pid: process.pid,
    startedAt: '',
    protocolVersion: 1,
  });
  let posted;
  setAndroidFetch(async (_url, init) => {
    posted = JSON.parse(init.body);
    return jsonResponse({ ok: true, data: { updating: false }, v: 1 });
  });
  const probes = buildAndroidProbes('com.test');
  assert.equal(await probes.isWindowUpdating(100), false);
  assert.equal(posted.timeoutMs, 100);
  assert.equal(posted.command, 'isWindowUpdating');
});

test('settleAfterMutation attaches meta.settle + timings_ms.settle on mutating success', async () => {
  const { settleAfterMutation } = await import('../../dist/agent-device-wrapper.js');
  const { okResult } = await import('../../dist/utils.js');
  const out = await settleAfterMutation(
    okResult({ tapped: true }),
    { platform: 'ios', verb: 'tap' },
    {
      enabled: () => true,
      capabilities: () => ['SCREEN_STATIC'],
      probes: () => ({ snapshotHash: async () => 'h', sleep: async () => {}, now: () => 0 }),
      wait: async () => ({ settled: true, method: 'screen-static', ms: 240 }),
    },
  );
  const envelope = JSON.parse(out.content[0].text);
  assert.deepEqual(envelope.meta.settle, { method: 'screen-static', settled: true });
  assert.equal(envelope.meta.timings_ms.settle, 240);
});

test('settleAfterMutation skips non-mutating verbs, errors, per-call opt-out, and RN_SETTLE off', async () => {
  const { settleAfterMutation } = await import('../../dist/agent-device-wrapper.js');
  const { okResult, failResult } = await import('../../dist/utils.js');
  const fakeDeps = {
    enabled: () => true,
    capabilities: () => ['SCREEN_STATIC'],
    probes: () => ({ snapshotHash: async () => 'h', sleep: async () => {}, now: () => 0 }),
    wait: async () => ({ settled: true, method: 'screen-static', ms: 1 }),
  };
  const cases = [
    [okResult({}), { platform: 'ios', verb: 'snapshot' }, fakeDeps],
    [okResult({}), { platform: 'ios', verb: 'tap', settle: { enabled: false } }, fakeDeps],
    [okResult({}), { platform: 'android', verb: 'tap' }, { ...fakeDeps, enabled: () => false }],
    [failResult('nope'), { platform: 'ios', verb: 'tap' }, fakeDeps],
  ];
  for (const [result, ctx, deps] of cases) {
    const out = await settleAfterMutation(result, ctx, deps);
    assert.equal(
      JSON.parse(out.content[0].text).meta?.settle,
      undefined,
      `verb=${ctx.verb} settle=${JSON.stringify(ctx.settle)}`,
    );
  }
});

test('settleAfterMutation swallows a throwing waiter (advisory, never fails the action)', async () => {
  const { settleAfterMutation } = await import('../../dist/agent-device-wrapper.js');
  const { okResult } = await import('../../dist/utils.js');
  const out = await settleAfterMutation(
    okResult({ tapped: true }),
    { platform: 'ios', verb: 'tap' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'h', sleep: async () => {}, now: () => 0 }),
      wait: async () => {
        throw new Error('boom');
      },
    },
  );
  assert.equal(JSON.parse(out.content[0].text).data.tapped, true);
});

test('attachMeta merges timings_ms instead of clobbering', async () => {
  const { attachMeta } = await import('../../dist/agent-device-wrapper.js');
  const { okResult } = await import('../../dist/utils.js');
  const base = okResult({}, { meta: { timings_ms: { dispatch: 12 } } });
  const out = attachMeta(base, {
    timings_ms: { settle: 34 },
    settle: { method: 'snapshot-eq', settled: true },
  });
  const envelope = JSON.parse(out.content[0].text);
  assert.deepEqual(envelope.meta.timings_ms, { dispatch: 12, settle: 34 });
});

test('meta.settle survives surfaceKeyboardGuard post-processing', async () => {
  const { surfaceKeyboardGuard } = await import('../../dist/runners/keyboard-guard.js');
  const { okResult } = await import('../../dist/utils.js');
  const withSettle = okResult(
    { tapped: true, keyboardGuard: 'no_keyboard' },
    { meta: { settle: { method: 'window-gate', settled: true }, timings_ms: { settle: 150 } } },
  );
  const out = surfaceKeyboardGuard(withSettle);
  const envelope = JSON.parse(out.content[0].text);
  assert.equal(envelope.meta.keyboardGuard, 'no_keyboard');
  assert.deepEqual(envelope.meta.settle, { method: 'window-gate', settled: true });
});

test('waitForSettle clamps non-finite/oversized budgets', async () => {
  const { waitForSettle, SETTLE_MAX_BUDGET_MS } = await import('../../dist/lifecycle/settle.js');
  let t = 0;
  const clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  let i = 0;
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    budgetMs: Number.POSITIVE_INFINITY,
    probes: { snapshotHash: async () => `h${i++}`, sleep: clock.sleep, now: clock.now },
  });
  assert.equal(out.settled, false);
  assert.ok(out.ms <= SETTLE_MAX_BUDGET_MS + 200, `ran ${out.ms}ms — budget not clamped`);
});

test('end-to-end: runNative ios tap → runner /command + settle probe → meta.settle', async () => {
  const { runNative, _setActiveSessionForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { _setPluginVersionForTest } = await import('../../dist/runners/protocol.js');
  const { spawn } = await import('node:child_process');
  // Disposable child as the fake runner pid: this test enters the PRODUCTION
  // runNative lifecycle, and a stale classification would reap (SIGTERM) the
  // recorded pid — process.pid here would kill the test process itself
  // (observed before the fetchImpl health-probe fix; keep it impossible).
  const dummy = spawn('sleep', ['300'], { stdio: 'ignore' });
  _setPluginVersionForTest(null); // disables version-skew gate
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  _setFastRunnerStateForTest({ ...iosState(), pid: dummy.pid, port: 22091 });
  const REQUIRED = [
    'tap',
    'type',
    'verifyInput',
    'drag',
    'longPress',
    'pinch',
    'snapshot',
    'screenshot',
    'back',
    'keyboardDismiss',
    'status',
  ];
  setIosFetch(async (url, init) => {
    if (String(url).includes('/health')) {
      return jsonResponse({
        ok: true,
        protocolVersion: 1,
        capabilities: [
          'SCREEN_STATIC',
          'EXACT_KEYBOARD_TARGET_GUARD',
          'FILL_EVIDENCE_V1',
          'HIT_TESTED_DISPATCH_V1',
          'TARGET_FRAME_GUARD_V1',
          'SNAPSHOT_FIDELITY_V1',
          'SYSTEM_ALERT_TAP_V1',
        ],
        commands: REQUIRED,
      });
    }
    const body = JSON.parse(init.body);
    if (body.command === 'tap') return jsonResponse({ ok: true, data: { tapped: true }, v: 1 });
    if (body.command === 'isScreenStatic')
      return jsonResponse({ ok: true, data: { static: true }, v: 1 });
    return jsonResponse({ ok: true, data: {}, v: 1 });
  });
  try {
    const result = await runNative(['tap', '100', '200'], { platform: 'ios' });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.meta.settle.settled, true);
    assert.equal(envelope.meta.settle.method, 'screen-static');
    assert.equal(typeof envelope.meta.timings_ms.settle, 'number');
  } finally {
    _setPluginVersionForTest(undefined);
    _setActiveSessionForTest(null);
    dummy.kill();
  }
});

test('android probes degrade to null when the pinned host port no longer matches', async () => {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 23456,
    devicePort: 7100,
    pid: process.pid,
    startedAt: '',
    protocolVersion: 1,
  });
  setAndroidFetch(async () => {
    throw new Error('must not post — pinned port mismatch');
  });
  const probes = buildAndroidProbes('com.test'); // pins 23456
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 29999,
    devicePort: 7100,
    pid: process.pid,
    startedAt: '',
    protocolVersion: 1,
  });
  assert.equal(await probes.isWindowUpdating(100), null);
  assert.equal(await probes.snapshotHash(), null);
});
