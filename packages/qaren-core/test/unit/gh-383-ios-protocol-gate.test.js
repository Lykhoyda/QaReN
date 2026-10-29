// GH #383: classifier matrix — a reachable runner with a missing/older/newer
// protocol or a skewed runnerVersion is 'stale' (reap-and-restart path);
// post-reinstall mismatch surfaces RUNNER_PROTOCOL_MISMATCH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFastRunnerLivenessDetailed } from '../../dist/runners/qaren-ios-runner-client.js';
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';

const STATE = { pid: 1, port: 22088, deviceId: 'U1', bundleId: 'com.example' };
const deps = (probeBody, plugin = '0.58.0') => ({
  getState: () => STATE,
  processAlive: () => true,
  httpProbe: async () => probeBody,
  clearState: () => {},
  pluginVersion: plugin,
});

test('gh-383 gate: healthy + matching protocol + version → alive', async () => {
  // GH #418: alive now also requires the full advertised command surface.
  const d = await probeFastRunnerLivenessDetailed(
    deps({
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      runnerVersion: '0.58.0',
      commands: [...REQUIRED_IOS_COMMANDS],
      capabilities: [...REQUIRED_IOS_FEATURES],
    }),
  );
  assert.deepEqual(d, {
    liveness: 'alive',
    runnerProtocolVersion: 1,
    runnerVersion: '0.58.0',
    capabilities: [...REQUIRED_IOS_FEATURES],
  });
});

test('gh-383 gate: healthy but NO protocolVersion (legacy runner) → stale/legacy', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps({ ok: true, status: 200, bodyOk: true }));
  assert.equal(d.liveness, 'stale');
  assert.equal(d.staleReason, 'legacy');
});

test('gh-383 gate: newer protocol → stale/protocol-newer; version skew → stale/version-skew', async () => {
  const newer = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true, protocolVersion: 99 }),
  );
  assert.equal(newer.staleReason, 'protocol-newer');
  const skew = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true, protocolVersion: 1, runnerVersion: '0.0.1' }),
  );
  assert.equal(skew.staleReason, 'version-skew');
});

test('gh-383 gate: version check is fail-open when plugin version unknown', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps(
      {
        ok: true,
        status: 200,
        bodyOk: true,
        protocolVersion: 1,
        runnerVersion: '0.0.1',
        commands: [...REQUIRED_IOS_COMMANDS],
        capabilities: [...REQUIRED_IOS_FEATURES],
      },
      null,
    ),
  );
  assert.equal(d.liveness, 'alive');
});

test('gh-383 gate: health failure stays stale/health', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps({ ok: false, status: 500 }));
  assert.deepEqual(d, { liveness: 'stale', staleReason: 'health', healthDetail: 'http-5xx' });
});

test('iOS authority mismatch has a rebuild-eligible stale reason', async () => {
  const state = {
    ...STATE,
    instanceId: 'expected-instance',
    sessionId: 'expected-session',
    claimEpoch: 7,
  };
  const d = await probeFastRunnerLivenessDetailed({
    ...deps({}),
    getState: () => state,
    httpProbe: async () => ({
      ok: true,
      status: 200,
      bodyOk: true,
      instanceId: 'foreign-instance',
      sessionId: 'expected-session',
      claimEpoch: 7,
      deviceId: state.deviceId,
      appId: state.bundleId,
    }),
  });

  assert.deepEqual(d, { liveness: 'stale', staleReason: 'authority-mismatch' });
});

test('gh-383 ensure: transparent upgrade returns ok + note', async () => {
  const probes = [{ liveness: 'stale', staleReason: 'legacy' }, { liveness: 'alive' }];
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(ensured, 1);
  assert.deepEqual(res, { ok: true, note: 'runner upgraded (protocol/version mismatch)' });
});

test('gh-383 ensure: mismatch surviving reinstall → RUNNER_PROTOCOL_MISMATCH', async () => {
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    probe: async () => ({ liveness: 'stale', staleReason: 'protocol-older' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_PROTOCOL_MISMATCH');
  assert.match(res.message, /build-for-testing|rebuild/i);
});

test('gh-383 ensure: plain spawn failure keeps the existing untyped message', async () => {
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    probe: async () => ({ liveness: 'stale', staleReason: 'health' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, undefined);
});
