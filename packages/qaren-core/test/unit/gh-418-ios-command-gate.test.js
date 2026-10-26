// GH #418: the iOS liveness gate is strict about the command surface — a
// healthy, protocol-current runner that does not advertise every
// REQUIRED_IOS_COMMANDS verb is 'stale'/'missing-commands'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeFastRunnerLivenessDetailed,
  runIOS,
  _setRunnerStateForTest,
  _setFetchForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';

const STATE = { pid: 1, port: 22088, deviceId: 'U1', bundleId: 'com.example' };
const deps = (probeBody, plugin = '0.99.0') => ({
  getState: () => STATE,
  processAlive: () => true,
  httpProbe: async () => probeBody,
  clearState: () => {},
  pluginVersion: plugin,
});
const HEALTHY = {
  ok: true,
  status: 200,
  bodyOk: true,
  protocolVersion: 1,
  capabilities: [...REQUIRED_IOS_FEATURES],
};

test('gh-418 gate: full command surface → alive', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ...HEALTHY, commands: [...REQUIRED_IOS_COMMANDS] }),
  );
  assert.equal(d.liveness, 'alive');
});

test('gh-418 gate: absent commands field (pre-#418 artifact) → stale/missing-commands, full list', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps({ ...HEALTHY }));
  assert.equal(d.liveness, 'stale');
  assert.equal(d.staleReason, 'missing-commands');
  assert.deepEqual(d.missingCommands, [...REQUIRED_IOS_COMMANDS]);
});

test('gh-418 gate: one verb missing → stale naming exactly it', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ...HEALTHY, commands: REQUIRED_IOS_COMMANDS.filter((c) => c !== 'keyboardDismiss') }),
  );
  assert.equal(d.staleReason, 'missing-commands');
  assert.deepEqual(d.missingCommands, ['keyboardDismiss']);
});

test('gh-418: runIOS surfaces the runner-typed UNSUPPORTED_COMMAND (spec §4 passthrough)', async () => {
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setFetchForTest(async () => ({
    json: async () => ({
      ok: false,
      v: 1,
      error: {
        code: 'UNSUPPORTED_COMMAND',
        message: 'Unsupported iOS runner command: bogus — the runner artifact predates it.',
      },
    }),
  }));
  try {
    const res = await runIOS({ command: 'back' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /UNSUPPORTED_COMMAND/);
    assert.match(res.content[0].text, /artifact predates/);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
  }
});
