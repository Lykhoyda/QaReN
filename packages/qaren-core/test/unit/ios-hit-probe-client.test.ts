import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { buildRunIOSArgs } from '../../dist/agent-device-wrapper.js';
import { QaDispatchContext } from '../../dist/domain/qa-dispatch.js';
import { clearRefMap, updateRefMapFromFlat } from '../../dist/fast-runner-ref-map.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  readIOSHitProbe,
  runIOS,
} from '../../dist/runners/qaren-ios-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';

const identity = { identifier: 'row', rect: { x: 20, y: 20, width: 300, height: 40 } };
let capabilities: string[];
let bodies: Record<string, unknown>[];
let response: () => Response | Promise<Response>;
function seed(generation = 7, identifier: string | undefined = 'row') {
  updateRefMapFromFlat(
    [
      {
        ref: '@e6',
        type: 'Other',
        identifier,
        rect: { x: 20, y: 20, width: 300, height: 40 },
        hittable: true,
      },
    ],
    { snapshotGeneration: generation, keyboardVisible: false },
  );
}
beforeEach(() => {
  clearRefMap();
  seed();
  capabilities = [
    ...REQUIRED_IOS_FEATURES,
    'QA_READ_ONLY_V1',
    'STRICT_LIVE_HIT_V1',
    'LIVE_HIT_PROBE_V1',
  ];
  bodies = [];
  response = () =>
    Response.json({ ok: true, v: 2, data: { hitProbe: 'hittable', snapshotGeneration: 7 } });
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    port: 22088,
    pid: process.pid,
    deviceId: 'hit-probe-test',
    bundleId: 'dev.fixture',
    startedAt: 'now',
    protocolVersion: 2,
  });
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities,
      });
    bodies.push(JSON.parse(String(init?.body)));
    return response();
  });
});
afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  clearRefMap();
});

for (const verdict of ['hittable', 'not-hittable', 'moved', 'unavailable']) {
  test(`a read-only ${verdict} probe carries the captured descriptor without authorizing an action`, async () => {
    response = () =>
      Response.json({ ok: true, v: 2, data: { hitProbe: verdict, snapshotGeneration: 7 } });
    const context = new QaDispatchContext(10_000, () => 0);
    assert.equal(await readIOSHitProbe('@e6', 'dev.fixture', 7, context, identity), verdict);
    assert.equal(context.authorizations, 0);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].command, 'hitProbe');
    assert.equal(bodies[0].qaReadOnly, true);
    assert.equal(bodies[0].snapshotNodeIndex, 6);
    assert.equal(bodies[0].snapshotGeneration, 7);
    assert.equal(bodies[0].snapshotIdentifier, 'row');
  });
}

for (const fault of [
  'old-runner',
  'anonymous',
  'stale-generation',
  'reused-index',
  'reused-index-same-generation',
  'late',
  'wrong-reply-generation',
  'transport',
  'runner-timeout',
]) {
  test(`a ${fault} probe cannot override an inferred refusal or trigger recovery`, async () => {
    let now = 0;
    const context = new QaDispatchContext(10_000, () => now);
    if (fault === 'old-runner')
      capabilities = capabilities.filter((c) => c !== 'LIVE_HIT_PROBE_V1');
    if (fault === 'anonymous') seed(7, '');
    if (fault === 'stale-generation') seed(8);
    if (fault === 'reused-index-same-generation') seed(7, 'different');
    response = () => {
      if (fault === 'reused-index') seed(8, 'different');
      if (fault === 'late') now = 10_001;
      if (fault === 'transport') throw new Error('connection reset');
      if (fault === 'runner-timeout')
        return Response.json({
          ok: false,
          v: 2,
          error: { code: 'RUNNER_TIMEOUT', message: 'timeout' },
        });
      return Response.json({
        ok: true,
        v: 2,
        data: {
          hitProbe: 'hittable',
          snapshotGeneration: fault === 'wrong-reply-generation' ? 8 : 7,
        },
      });
    };
    assert.equal(await readIOSHitProbe('@e6', 'dev.fixture', 7, context, identity), 'unavailable');
    assert.equal(context.authorizations, 0);
    assert.ok(bodies.every((body) => body.command === 'hitProbe'));
    assert.ok(bodies.length <= 1, 'a read never retries, restarts, or repairs the runner');
    if (['old-runner', 'anonymous', 'stale-generation'].includes(fault))
      assert.deepEqual(bodies, []);
  });
}

test('the strict fill flag reaches type while ordinary fills retain their wire shape', () => {
  assert.equal(buildRunIOSArgs(['fill', '10', 'x', '--require-live-hit']).requireLiveHit, true);
  assert.equal(buildRunIOSArgs(['fill', '10', 'x']).requireLiveHit, undefined);
});

test('a runner with strict taps alone cannot silently downgrade a strict fill', async () => {
  _setCapabilitiesForTest(['STRICT_LIVE_HIT_V1']);
  const result = await runIOS({ command: 'type', requireLiveHit: true, text: 'x' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'RN_FAST_RUNNER_STALE');
  assert.deepEqual(bodies, []);
});
