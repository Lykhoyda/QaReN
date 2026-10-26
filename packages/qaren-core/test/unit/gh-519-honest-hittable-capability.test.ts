// A healthy probe without the compiled-in HONEST_HITTABLE capability means
// the artifact predates #395 and emits stale hittable — queue a warn-once
// advisory note; liveness must stay 'alive'.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeFastRunnerLivenessDetailed,
  consumePendingFastRunnerArtifactNote,
  _resetStaleHittableWarnForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';

const STATE = { pid: 1, port: 22088, deviceId: 'U1', bundleId: 'com.example' };
const deps = (probeBody, plugin = '0.58.0') => ({
  getState: () => STATE,
  processAlive: () => true,
  httpProbe: async () => probeBody,
  clearState: () => {},
  pluginVersion: plugin,
});
const aliveBody = (capabilities) => ({
  ok: true,
  status: 200,
  bodyOk: true,
  protocolVersion: 1,
  runnerVersion: '0.58.0',
  commands: [...REQUIRED_IOS_COMMANDS],
  ...(capabilities !== undefined
    ? { capabilities: [...REQUIRED_IOS_FEATURES, ...capabilities] }
    : {}),
});

beforeEach(() => {
  consumePendingFastRunnerArtifactNote();
  _resetStaleHittableWarnForTest();
});

test('gh-519: alive artifact without HONEST_HITTABLE queues a stale-hittable advisory', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.equal(d.liveness, 'alive', 'advisory never degrades liveness');
  const note = consumePendingFastRunnerArtifactNote();
  assert.ok(note !== undefined, 'advisory note queued');
  assert.match(note, /hittable/i);
  assert.match(note, /#395/);
});

test('gh-519: artifact advertising HONEST_HITTABLE queues no note', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps(aliveBody(['SCREEN_STATIC', 'HONEST_HITTABLE'])),
  );
  assert.equal(d.liveness, 'alive');
  assert.equal(consumePendingFastRunnerArtifactNote(), undefined);
});

test('gh-656: capabilities-less artifact is stale before any hittable advisory', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps(aliveBody(undefined)));
  assert.equal(d.liveness, 'stale');
  assert.equal(d.staleReason, 'missing-features');
  assert.deepEqual(d.missingFeatures, [...REQUIRED_IOS_FEATURES]);
  assert.equal(consumePendingFastRunnerArtifactNote(), undefined);
});

test('gh-519: advisory is warn-once per process', async () => {
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.ok(consumePendingFastRunnerArtifactNote() !== undefined);
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.equal(consumePendingFastRunnerArtifactNote(), undefined, 'no re-nag on later probes');
});

test('gh-519: an occupied pending-note slot defers the advisory without spending the warn budget', async () => {
  // Clobbering is not directly observable (identical note text); the guard's
  // side effect is: occupied slot → early-return BEFORE marking warned, so an
  // overwrite implementation would queue nothing at the final probe.
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  _resetStaleHittableWarnForTest();
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.ok(consumePendingFastRunnerArtifactNote() !== undefined, 'original note still present');
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.ok(
    consumePendingFastRunnerArtifactNote() !== undefined,
    'warn budget survived the occupied-slot probe and fires once the slot frees',
  );
});
