import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { _setActiveSessionForTest, runNative } from '../../dist/agent-device-wrapper.js';
import { getPluginVersion, REQUIRED_IOS_COMMANDS } from '../../dist/runners/protocol.js';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  buildRunnerPortEnv,
  buildRunnerTestFaultEnv,
  getFastRunnerState,
  getRunnerPostMortem,
  resolveRunnerRequestedPort,
  runIOS,
  verifyTypeResultAfterSettle,
} from '../../dist/runners/rn-fast-runner-client.js';
import { okResult } from '../../dist/utils.js';

function state() {
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: 999_999_999,
    port: 22088,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 2,
    provenance: 'build-local',
  } as never);
}

function timeoutFetch() {
  _setFetchForTest(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { command?: string };
    assert.equal(body.command, 'type');
    return new Response(
      JSON.stringify({
        ok: false,
        v: 2,
        error: { code: 'MAIN_THREAD_TIMEOUT', message: 'main thread execution timed out' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

function body(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    code?: string;
    data?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  };
}

test('GH-588 runner lifecycle: default launch requests an isolated OS-assigned listener port', () => {
  const requested = resolveRunnerRequestedPort();
  assert.equal(requested, 0, 'parallel simulator runners must never contend for fixed port 22088');
  assert.deepEqual(buildRunnerPortEnv(requested), {
    RN_FAST_RUNNER_PORT: '0',
    TEST_RUNNER_RN_FAST_RUNNER_PORT: '0',
  });
  assert.equal(resolveRunnerRequestedPort(31_337), 31_337, 'explicit test seam remains available');
});

test('GH-588 Slice C: deterministic wedge hook is compile-gated out of release artifacts', () => {
  const source = readFileSync(
    new URL(
      '../../../rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+CommandExecution.swift',
      import.meta.url,
    ),
    'utf8',
  );
  const releaseWorkflow = readFileSync(
    new URL('../../../../.github/workflows/runner-artifacts.yml', import.meta.url),
    'utf8',
  );
  assert.match(source, /#if RN_FAST_RUNNER_TEST_FAULTS/);
  assert.doesNotMatch(releaseWorkflow, /RN_FAST_RUNNER_TEST_FAULTS/);
});

test('GH-588 Slice C: deterministic fault uses the TEST_RUNNER_ XCUITest launch contract', () => {
  assert.deepEqual(buildRunnerTestFaultEnv({ RN_FAST_RUNNER_TEST_FAULT: 'block-main-35s' }), {
    RN_FAST_RUNNER_TEST_FAULT: 'block-main-35s',
    TEST_RUNNER_RN_FAST_RUNNER_TEST_FAULT: 'block-main-35s',
  });
  assert.deepEqual(buildRunnerTestFaultEnv({}), {});
});

test('GH-588 Slice C: timeout succeeds only as exact-readback recovery', async () => {
  state();
  timeoutFetch();
  const result = body(
    await runIOS({
      command: 'type',
      text: 'exact',
      _verifyExactReadback: async (expected) => ({
        matches: expected === 'exact',
        actual: 'exact',
      }),
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data?.recovered, true);
  assert.equal(result.data?.verification, 'exact-readback');
  const recovery = result.meta?.runnerTimeoutRecovery as
    | {
        reaped?: boolean;
        runner?: {
          before?: { pid?: number };
          afterReapPid?: number | null;
          stateCleared?: boolean;
        };
        containmentOrder?: string[];
        runnerPostMortem?: { available?: boolean; provenance?: string };
      }
    | undefined;
  assert.equal(recovery?.reaped, true);
  assert.equal(recovery?.runner?.before?.pid, 999_999_999);
  assert.equal(recovery?.runner?.afterReapPid, null);
  assert.equal(recovery?.runner?.stateCleared, true);
  assert.deepEqual(recovery?.containmentOrder, [
    'poison',
    'independent-readback',
    'reap',
    'result',
  ]);
  assert.equal(recovery?.runnerPostMortem?.provenance, 'adopted');
  assert.equal('runnerTimeoutShim' in (result.meta ?? {}), false);
});

test('GH-588 Slice C: mismatch and unavailable CDP fail closed as RUNNER_TIMEOUT', async () => {
  for (const verify of [
    async () => ({ matches: false, actual: 'wrong' }),
    async () => {
      throw new Error('CDP down');
    },
  ]) {
    state();
    timeoutFetch();
    const result = body(
      await runIOS({ command: 'type', text: 'exact', _verifyExactReadback: verify }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RUNNER_TIMEOUT');
  }
});

test('GH-588 Slice C: a typed snapshot timeout poisons and reaps the exact runner', async () => {
  state();
  _setFetchForTest(async (_input, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { command?: string };
    assert.equal(request.command, 'snapshot');
    return new Response(
      JSON.stringify({
        ok: false,
        v: 2,
        error: { code: 'RUNNER_TIMEOUT', message: 'main thread execution timed out' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const result = body(await runIOS({ command: 'snapshot' }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(getFastRunnerState(), null);
  assert.equal(
    (result.meta?.runnerTimeoutRecovery as { runner?: { stateCleared?: boolean } } | undefined)
      ?.runner?.stateCleared,
    true,
  );
});

test('GH-581: a thrown verifyInput timeout poisons and reaps the runner', async () => {
  state();
  _setFetchForTest(async () => {
    throw new Error('RUNNER_TIMEOUT: verifyInput transport deadline exceeded');
  });

  const result = body(await runIOS({ command: 'verifyInput', text: 'redacted' }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(getFastRunnerState(), null);
  assert.equal(
    (result.meta?.runnerTimeoutRecovery as { runner?: { stateCleared?: boolean } } | undefined)
      ?.runner?.stateCleared,
    true,
  );
});

test('GH-581: verifyInput timeout preserves a concurrent replacement runner', async (t) => {
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
  });
  state();
  _setFetchForTest(async () => {
    _setFastRunnerStateForTest({
      schemaVersion: 1,
      pid: 222_222_222,
      port: 22089,
      deviceId: 'fixture-ios',
      bundleId: 'dev.fixture',
      startedAt: new Date(1).toISOString(),
      protocolVersion: 2,
      provenance: 'build-local',
    } as never);
    return new Response(
      JSON.stringify({
        ok: false,
        v: 2,
        error: { code: 'RUNNER_TIMEOUT', message: 'verifyInput timed out' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const result = body(await runIOS({ command: 'verifyInput', text: 'redacted' }));

  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(
    (result.meta?.runnerTimeoutRecovery as { reapDisposition?: string } | undefined)
      ?.reapDisposition,
    'replacement-preserved',
  );
  assert.equal(getFastRunnerState()?.pid, 222_222_222);
});

test('GH-588 Slice C: adopted runner postmortem is honestly unavailable', () => {
  state();
  assert.deepEqual(getRunnerPostMortem(), { available: false, provenance: 'adopted' });
});

test('GH-588 Slice C: a second mutator is refused while the triggering runner is poisoned', async () => {
  state();
  timeoutFetch();
  let entered!: () => void;
  const readbackEntered = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const first = runIOS({
    command: 'type',
    text: 'exact',
    _verifyExactReadback: async () => {
      entered();
      await hold;
      return { matches: true, actual: 'exact' };
    },
  });
  await readbackEntered;
  const second = body(await runIOS({ command: 'tap', x: 10, y: 10 }));
  assert.equal(second.code, 'RUNNER_TIMEOUT');
  assert.equal((second.meta as { dispatched?: boolean }).dispatched, false);
  release();
  await first;
});

test('GH-588 V6: a replacement runner is preserved when prior type authority is lost', async (t) => {
  t.after(() => _setFastRunnerStateForTest(null));
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: 222_222_222,
    port: 22089,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: new Date(1).toISOString(),
    protocolVersion: 2,
    provenance: 'build-local',
  } as never);

  const result = body(
    await verifyTypeResultAfterSettle(
      {
        command: 'type',
        text: 'never-landed',
        _verifyExactReadback: async () => ({ matches: false, actual: '' }),
      },
      okResult({ message: 'typed' }),
      {
        pid: 111_111_111,
        port: 22088,
        deviceId: 'fixture-ios',
        statePath: '/tmp/old-state.json',
        provenance: 'spawned',
      },
    ),
  );

  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(
    (result.meta?.runnerTimeoutRecovery as { reapDisposition?: string } | undefined)
      ?.reapDisposition,
    'replacement-preserved',
  );
  assert.equal(getFastRunnerState()?.pid, 222_222_222, 'replacement PID is never signaled');
});

test('GH-588 V6: success-shaped fill fails closed when settle observes runner authority loss', async (t) => {
  const pluginVersion = getPluginVersion();
  assert.ok(pluginVersion, 'source-checkout tests resolve the current plugin version');
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  assert.ok(dummy.pid);
  t.after(() => {
    dummy.kill('SIGKILL');
    _setFastRunnerStateForTest(null);
    _setActiveSessionForTest(null);
    _setFetchForTest(globalThis.fetch);
  });
  _setActiveSessionForTest({
    platform: 'ios',
    deviceId: 'fixture-ios',
    appId: 'dev.fixture',
  });
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: dummy.pid!,
    port: 22088,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 2,
    provenance: 'build-local',
  } as never);
  let typeReplies = 0;
  _setFetchForTest(async (_input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 2,
          runnerVersion: pluginVersion,
          capabilities: [
            'SCREEN_STATIC',
            'HONEST_HITTABLE',
            'EXACT_KEYBOARD_TARGET_GUARD',
            'FILL_EVIDENCE_V1',
            'HIT_TESTED_DISPATCH_V1',
            'TARGET_FRAME_GUARD_V1',
            'SNAPSHOT_FIDELITY_V1',
            'SYSTEM_ALERT_TAP_V1',
          ],
          commands: REQUIRED_IOS_COMMANDS,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const request = JSON.parse(String(init?.body ?? '{}')) as { command?: string };
    if (request.command === 'type') {
      typeReplies++;
      return new Response(
        JSON.stringify({ ok: true, v: 2, data: { message: 'typed', typingBurst: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (request.command === 'isScreenStatic') {
      // Reproduce the live race: the type reply was success-shaped, then the
      // health/settle window observed the triggering XCTest state disappear.
      _setFastRunnerStateForTest(null);
      return new Response(JSON.stringify({ ok: true, v: 2, data: { static: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected command ${String(request.command)}`);
  });

  const result = body(
    await runNative(['fill', '@e0', 'never-landed', '--at-x', '10', '--at-y', '10'], {
      platform: 'ios',
      settle: { timeoutMs: 100 },
      verifyTypeReadback: async () => ({ matches: false, actual: '' }),
    }),
  );

  assert.equal(typeReplies, 1, 'the mutating type command is never resent');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  const recovery = result.meta?.runnerTimeoutRecovery as {
    trigger?: string;
    reaped?: boolean;
    reapDisposition?: string;
    verification?: string;
  };
  assert.equal(recovery.trigger, 'post-settle-runner-authority-lost');
  assert.equal(recovery.verification, 'unverified');
  assert.equal(recovery.reaped, false);
  assert.equal(recovery.reapDisposition, 'already-absent');
});
