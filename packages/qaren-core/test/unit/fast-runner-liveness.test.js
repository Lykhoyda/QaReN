import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setFastRunnerStateForTest,
  getFastRunnerState,
  getFastRunnerCapabilities,
  _setCapabilitiesForTest,
  probeFastRunnerLiveness,
  probeFastRunnerLivenessDetailed,
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

test('detailed readiness reasons preserve liveness, stale policy and clearing counts', async () => {
  const healthy = {
    ok: true,
    status: 200,
    bodyOk: true,
    protocolVersion: 1,
    runnerVersion: '1.0.0',
    commands: [...REQUIRED_IOS_COMMANDS],
    capabilities: [...REQUIRED_IOS_FEATURES],
  };
  const cases = [
    ['no-state', null, true, healthy, 'dead', undefined, 0],
    ['process-check-failed', STATE, false, healthy, 'dead', undefined, 1],
    ['health-unauthorized', STATE, true, { ok: false, status: 401 }, 'stale', 'health', 0],
    ['health-http-rejected', STATE, true, { ok: false, status: 500 }, 'stale', 'health', 0],
    ['health-http-rejected', STATE, true, { ...healthy, status: 201 }, 'stale', 'health', 0],
    ['health-body-not-ok', STATE, true, { ...healthy, bodyOk: false }, 'stale', 'health', 0],
    ['health-body-not-ok', STATE, true, { ...healthy, bodyOk: undefined }, 'stale', 'health', 0],
    [
      'health-body-unreadable',
      STATE,
      true,
      { ...healthy, bodyOk: false, bodyReason: 'health-body-unreadable' },
      'stale',
      'health',
      0,
    ],
    [
      'health-wedged',
      STATE,
      true,
      { ...healthy, bodyOk: false, bodyReason: 'health-wedged' },
      'stale',
      'health',
      0,
    ],
    [
      'authority-mismatch',
      { ...STATE, sessionId: 'PRIVATE' },
      true,
      healthy,
      'stale',
      'authority-mismatch',
      0,
    ],
    ['legacy', STATE, true, { ...healthy, protocolVersion: undefined }, 'stale', 'legacy', 0],
    [
      'protocol-older',
      STATE,
      true,
      { ...healthy, protocolVersion: 0 },
      'stale',
      'protocol-older',
      0,
    ],
    [
      'protocol-newer',
      STATE,
      true,
      { ...healthy, protocolVersion: 99 },
      'stale',
      'protocol-newer',
      0,
    ],
    [
      'version-skew',
      STATE,
      true,
      { ...healthy, runnerVersion: '0.0.1' },
      'stale',
      'version-skew',
      0,
    ],
    ['missing-commands', STATE, true, { ...healthy, commands: [] }, 'stale', 'missing-commands', 0],
    [
      'missing-features',
      STATE,
      true,
      { ...healthy, capabilities: [] },
      'stale',
      'missing-features',
      0,
    ],
    ['probe-exception', STATE, true, new Error('PRIVATE'), 'stale', 'health', 0],
    ['alive', STATE, true, healthy, 'alive', undefined, 0],
  ];
  for (const [reason, state, alive, reply, liveness, staleReason, clears] of cases) {
    let clearCalls = 0;
    let healthCalls = 0;
    let processCalls = 0;
    _setCapabilitiesForTest(['PRIVATE-cache']);
    const result = await probeFastRunnerLivenessDetailed({
      getState: () => state,
      processAlive: () => {
        processCalls++;
        return alive;
      },
      httpProbe: async () => {
        healthCalls++;
        if (reply instanceof Error) throw reply;
        return reply;
      },
      clearState: () => {
        clearCalls++;
      },
      pluginVersion: '1.0.0',
    });
    assert.equal(result.readinessReason, reason);
    assert.equal(result.liveness, liveness);
    assert.equal(result.staleReason, staleReason);
    assert.equal(clearCalls, clears);
    assert.deepEqual(
      getFastRunnerCapabilities(),
      liveness === 'alive' ? healthy.capabilities : liveness === 'dead' ? ['PRIVATE-cache'] : [],
    );
    assert.equal(processCalls, state ? 1 : 0);
    assert.equal(healthCalls, state && alive ? 1 : 0);
  }
});

test('injected probe exceptions retain a finite class without changing stale policy or counts', async () => {
  const codes = [
    ['ECONNREFUSED', 'connection-refused'],
    ['ECONNRESET', 'connection-reset'],
    ['UND_ERR_SOCKET', 'socket-closed'],
    ['ETIMEDOUT', 'transport-timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'transport-timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'transport-timeout'],
    ['HPE_INVALID_CONSTANT', 'http-protocol'],
    ['HPE_INVALID_HEADER_TOKEN', 'http-protocol'],
    ['HPE_INVALID_CONTENT_LENGTH', 'http-protocol'],
    ['HPE_UNEXPECTED_CONTENT_LENGTH', 'http-protocol'],
    ['HPE_INVALID_CHUNK_SIZE', 'http-protocol'],
    ['PRIVATE-code', 'other'],
  ];
  for (const [code, kind] of codes) {
    for (const nested of [false, true]) {
      let health = 0,
        processes = 0,
        clears = 0;
      _setCapabilitiesForTest(['PRIVATE-cached']);
      const result = await probeFastRunnerLivenessDetailed({
        getState: () => ({ ...STATE }),
        processAlive: () => {
          processes++;
          return true;
        },
        httpProbe: async () => {
          health++;
          throw nested ? { cause: { code } } : { code };
        },
        clearState: () => {
          clears++;
        },
      });
      assert.deepEqual(result, {
        liveness: 'stale',
        staleReason: 'health',
        readinessReason: 'probe-exception',
        readinessExceptionStage: 'http-probe',
        readinessExceptionKind: kind,
      });
      assert.deepEqual([processes, health, clears], [1, 1, 0]);
      assert.deepEqual(getFastRunnerCapabilities(), []);
    }
  }
});

test('exceptions after health identify their existing operation without weakening any guard', async () => {
  for (const stage of [
    'health-evaluation',
    'authority-evaluation',
    'compatibility-evaluation',
    'state-update',
  ]) {
    const state = { ...STATE };
    const reply = {
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      commands: [...REQUIRED_IOS_COMMANDS],
      capabilities: [...REQUIRED_IOS_FEATURES],
    };
    if (stage === 'health-evaluation')
      Object.defineProperty(reply, 'ok', {
        get: () => {
          throw Error('PRIVATE');
        },
      });
    if (stage === 'authority-evaluation')
      Object.defineProperty(state, 'sessionId', {
        get: () => {
          throw Error('PRIVATE');
        },
      });
    if (stage === 'compatibility-evaluation')
      reply.commands = {
        [Symbol.iterator]() {
          throw Error('PRIVATE');
        },
      };
    if (stage === 'state-update')
      Object.defineProperty(state, 'protocolVersion', { value: 1, writable: false });
    let health = 0,
      clears = 0;
    _setCapabilitiesForTest(['PRIVATE-cached']);
    const result = await probeFastRunnerLivenessDetailed({
      getState: () => state,
      processAlive: () => true,
      httpProbe: async () => {
        health++;
        return reply;
      },
      clearState: () => {
        clears++;
      },
      pluginVersion: null,
    });
    assert.deepEqual(result, {
      liveness: 'stale',
      staleReason: 'health',
      readinessReason: 'probe-exception',
      readinessExceptionStage: stage,
      readinessExceptionKind: 'other',
    });
    assert.deepEqual([health, clears], [1, 0]);
    assert.deepEqual(getFastRunnerCapabilities(), []);
  }
});
