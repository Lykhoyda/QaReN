import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setFastRunnerStateForTest,
  getFastRunnerState,
  probeFastRunnerLiveness,
  reapStaleFastRunner,
} from '../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';

// M7 / D666 — hermetic tests for the tri-state fast-runner liveness probe.
// Mirrors the injectable-deps pattern from test/unit/lockfile.test.js so we
// never touch a real process, the real state file, or a real HTTP server.

const STATE = {
  pid: 12345,
  port: 22088,
  deviceId: 'sim-1',
  bundleId: 'com.example',
  processBirth: 'birth-12345',
};
function birthProbe(...results) {
  let index = 0;
  return {
    probeProcessBirth: () => results[Math.min(index++, results.length - 1)],
  };
}

const MATCHING_BIRTH = {
  status: 'present',
  birth: { pid: STATE.pid, source: 'darwin-libproc', token: STATE.processBirth },
};
const REUSED_BIRTH = {
  status: 'present',
  birth: { pid: STATE.pid, source: 'darwin-libproc', token: 'replacement-birth' },
};
const ABSENT_BIRTH = { status: 'absent' };
const UNKNOWN_BIRTH = { status: 'unknown' };

// ── probe: dead paths ─────────────────────────────────────────────────

test('M7 probe: returns dead when no state (no runner ever started)', async () => {
  let clearCalls = 0;
  const liveness = await probeFastRunnerLiveness({
    getState: () => null,
    processAlive: () => assert.fail('processAlive should not be consulted when state is null'),
    httpProbe: async () => assert.fail('httpProbe should not run when state is null'),
    clearState: () => {
      clearCalls++;
    },
  });
  assert.equal(liveness, 'dead');
  assert.equal(clearCalls, 0, 'no state to clear');
});

test('M7 probe: returns dead and clears state when PID has exited', async () => {
  let clearCalls = 0;
  const liveness = await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => false,
    httpProbe: async () => assert.fail('httpProbe should not run after PID check failed'),
    clearState: () => {
      clearCalls++;
    },
  });
  assert.equal(liveness, 'dead');
  assert.equal(clearCalls, 1, 'state file must be cleared so next call rediscovers');
});

// ── probe: alive path ────────────────────────────────────────────────

test('M7 probe: returns alive when PID lives and /health returns {ok:true}', async () => {
  // GH #383: alive now also requires a compatible protocol; `1` matches
  // RUNNER_PROTOCOL_VERSION (tri-file sync test guards drift). pluginVersion:null
  // keeps this hermetic — no version-skew intent here. GH #418: alive also
  // requires the full advertised command surface.
  const liveness = await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => ({
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      commands: [...REQUIRED_IOS_COMMANDS],
      capabilities: [...REQUIRED_IOS_FEATURES],
    }),
    pluginVersion: null,
  });
  assert.equal(liveness, 'alive');
});

// ── probe: stale paths ───────────────────────────────────────────────

test('M7 probe: returns stale when PID lives but /health returns {ok:false}', async () => {
  const liveness = await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => ({ ok: true, status: 200, bodyOk: false }),
  });
  assert.equal(liveness, 'stale');
});

test('M7 probe: returns stale on HTTP 500 (server crashed handler)', async () => {
  const liveness = await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(liveness, 'stale');
});

test('M7 probe: returns stale when httpProbe throws AbortError (hung listener)', async () => {
  const liveness = await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  assert.equal(liveness, 'stale');
});

test('M7 probe: returns stale when httpProbe throws ECONNREFUSED (port not listening)', async () => {
  const liveness = await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => {
      const err = new Error('connect ECONNREFUSED ::1:22088');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  });
  assert.equal(liveness, 'stale');
});

test('M7 probe: timeoutMs override forwards to httpProbe', async () => {
  let observedTimeout = -1;
  await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async (_port, timeoutMs) => {
      observedTimeout = timeoutMs;
      return {
        ok: true,
        status: 200,
        bodyOk: true,
        protocolVersion: 1,
        commands: [...REQUIRED_IOS_COMMANDS],
      };
    },
    pluginVersion: null,
    timeoutMs: 750,
  });
  assert.equal(observedTimeout, 750);
});

test('M7 probe: default timeout is 2000ms (matches existing fastHealthCheck)', async () => {
  let observedTimeout = -1;
  await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async (_port, timeoutMs) => {
      observedTimeout = timeoutMs;
      return {
        ok: true,
        status: 200,
        bodyOk: true,
        protocolVersion: 1,
        commands: [...REQUIRED_IOS_COMMANDS],
      };
    },
    pluginVersion: null,
  });
  assert.equal(observedTimeout, 2000);
});

// ── probe: state cleanup invariants ───────────────────────────────────

test('M7 probe: stale path does NOT clear state (reap is the explicit action)', async () => {
  let clearCalls = 0;
  await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => ({ ok: true, status: 200, bodyOk: false }),
    clearState: () => {
      clearCalls++;
    },
  });
  assert.equal(clearCalls, 0, 'probe is read-only on a living process');
});

test('M7 probe: alive path does NOT clear state', async () => {
  let clearCalls = 0;
  await probeFastRunnerLiveness({
    getState: () => STATE,
    processAlive: () => true,
    httpProbe: async () => ({
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      commands: [...REQUIRED_IOS_COMMANDS],
    }),
    pluginVersion: null,
    clearState: () => {
      clearCalls++;
    },
  });
  assert.equal(clearCalls, 0);
});

// ── reap ─────────────────────────────────────────────────────────────

test('M7 reap: no-op when state is already null', async () => {
  let signals = 0;
  let clearCalls = 0;
  await reapStaleFastRunner({
    getState: () => null,
    processAlive: () => assert.fail('processAlive should not be consulted when state is null'),
    sendSignal: () => {
      signals++;
    },
    sleep: async () => {},
    clearState: () => {
      clearCalls++;
    },
  });
  assert.equal(signals, 0);
  assert.equal(clearCalls, 0);
});

test('M7 reap: SIGTERM succeeds — does not escalate to SIGKILL', async () => {
  const signals = [];
  let clearCalls = 0;
  await reapStaleFastRunner({
    ...birthProbe(MATCHING_BIRTH, ABSENT_BIRTH),
    getState: () => STATE,
    sendSignal: (pid, sig) => {
      signals.push([pid, sig]);
    },
    sleep: async () => {},
    clearState: () => {
      clearCalls++;
    },
    graceMs: 0,
  });
  assert.deepEqual(
    signals,
    [[STATE.pid, 'SIGTERM']],
    'only SIGTERM should be sent on graceful death',
  );
  assert.equal(clearCalls, 1, 'state must be cleared after successful reap');
});

test('M7 reap: SIGTERM ignored → SIGKILL escalation', async () => {
  const signals = [];
  let clearCalls = 0;
  await reapStaleFastRunner({
    ...birthProbe(MATCHING_BIRTH, MATCHING_BIRTH, ABSENT_BIRTH),
    getState: () => STATE,
    sendSignal: (pid, sig) => {
      signals.push([pid, sig]);
    },
    sleep: async () => {},
    clearState: () => {
      clearCalls++;
    },
    graceMs: 0,
  });
  assert.deepEqual(signals, [
    [STATE.pid, 'SIGTERM'],
    [STATE.pid, 'SIGKILL'],
  ]);
  assert.equal(clearCalls, 1);
});

test('M7 reap: SIGTERM throws ESRCH (already dead) — clearState still called', async () => {
  let clearCalls = 0;
  await reapStaleFastRunner({
    ...birthProbe(MATCHING_BIRTH, ABSENT_BIRTH),
    getState: () => STATE,
    sendSignal: (_pid, _sig) => {
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
    sleep: async () => {},
    clearState: () => {
      clearCalls++;
    },
    graceMs: 0,
  });
  assert.equal(clearCalls, 1, 'state is cleared even when signal throws — target was already dead');
});

test('M7 reap: graceMs override respected (fake sleep captures value)', async () => {
  let observedGrace = -1;
  await reapStaleFastRunner({
    ...birthProbe(MATCHING_BIRTH, ABSENT_BIRTH),
    getState: () => STATE,
    sendSignal: () => {},
    sleep: async (ms) => {
      observedGrace = ms;
    },
    clearState: () => {},
    graceMs: 250,
  });
  assert.equal(observedGrace, 250);
});

test('M7 reap: default graceMs is 500', async () => {
  let observedGrace = -1;
  await reapStaleFastRunner({
    ...birthProbe(MATCHING_BIRTH, ABSENT_BIRTH),
    getState: () => STATE,
    sendSignal: () => {},
    sleep: async (ms) => {
      observedGrace = ms;
    },
    clearState: () => {},
  });
  assert.equal(observedGrace, 500);
});

test('M7 reap: reused PID clears state without sending a signal', async () => {
  const signals = [];
  let clearCalls = 0;
  await reapStaleFastRunner({
    getState: () => STATE,
    ...birthProbe(REUSED_BIRTH),
    sendSignal: (pid, signal) => signals.push([pid, signal]),
    sleep: async () => assert.fail('reused PID must not enter the grace period'),
    clearState: () => {
      clearCalls++;
    },
  });
  assert.deepEqual(signals, []);
  assert.equal(clearCalls, 1);
});

test('M7 reap: live legacy state without process birth blocks replacement', async () => {
  let clearCalls = 0;
  await assert.rejects(
    () =>
      reapStaleFastRunner({
        getState: () => ({ ...STATE, processBirth: undefined }),
        processAlive: () => true,
        sendSignal: () => assert.fail('unproven process must not be signalled'),
        sleep: async () => assert.fail('unproven process must not enter the grace period'),
        clearState: () => {
          clearCalls++;
        },
      }),
    /RUNNER_ADOPTION_REQUIRED/,
  );
  assert.equal(clearCalls, 0);
});

test('M7 reap: dead legacy state without process birth can be cleared', async () => {
  let clearCalls = 0;
  await reapStaleFastRunner({
    getState: () => ({ ...STATE, processBirth: undefined }),
    processAlive: () => false,
    sendSignal: () => assert.fail('dead legacy process must not be signalled'),
    sleep: async () => assert.fail('dead legacy process must not enter the grace period'),
    clearState: () => {
      clearCalls++;
    },
  });
  assert.equal(clearCalls, 1);
});

test('M7 reap: PID reuse during grace prevents SIGKILL escalation', async () => {
  const signals = [];
  let clearCalls = 0;
  await reapStaleFastRunner({
    getState: () => STATE,
    ...birthProbe(MATCHING_BIRTH, REUSED_BIRTH),
    sendSignal: (pid, signal) => signals.push([pid, signal]),
    sleep: async () => {},
    clearState: () => {
      clearCalls += 1;
    },
    graceMs: 0,
  });
  assert.deepEqual(signals, [[STATE.pid, 'SIGTERM']]);
  assert.equal(clearCalls, 1);
});

test('M7 reap: unknown identity preserves state and blocks replacement', async () => {
  let clearCalls = 0;
  await assert.rejects(
    () =>
      reapStaleFastRunner({
        getState: () => STATE,
        ...birthProbe(UNKNOWN_BIRTH),
        sendSignal: () => assert.fail('unknown process identity must not be signalled'),
        sleep: async () => assert.fail('unknown process identity must not enter the grace period'),
        clearState: () => {
          clearCalls += 1;
        },
      }),
    /RUNNER_ADOPTION_REQUIRED/,
  );
  assert.equal(clearCalls, 0);
});

test('M7 reap: unproven SIGKILL termination preserves state', async () => {
  let clearCalls = 0;
  await assert.rejects(
    () =>
      reapStaleFastRunner({
        getState: () => STATE,
        ...birthProbe(MATCHING_BIRTH, MATCHING_BIRTH, UNKNOWN_BIRTH),
        sendSignal: () => {},
        sleep: async () => {},
        clearState: () => {
          clearCalls += 1;
        },
        graceMs: 0,
      }),
    /RUNNER_ADOPTION_REQUIRED/,
  );
  assert.equal(clearCalls, 0);
});

test('M7 reap: completed teardown cannot clear a concurrent replacement', async () => {
  const replacement = {
    ...STATE,
    pid: STATE.pid + 1,
    processBirth: 'replacement-birth',
  };
  _setFastRunnerStateForTest(STATE);
  await reapStaleFastRunner({
    getState: () => STATE,
    ...birthProbe(MATCHING_BIRTH, ABSENT_BIRTH),
    sendSignal: () => {},
    sleep: async () => {
      _setFastRunnerStateForTest(replacement);
    },
    graceMs: 0,
  });
  assert.equal(getFastRunnerState()?.pid, replacement.pid);
  _setFastRunnerStateForTest(null);
});
