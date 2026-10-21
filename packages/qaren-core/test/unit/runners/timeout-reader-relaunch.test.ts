import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { buildIosProbes, waitForSettle } from '../../../dist/lifecycle/settle.js';
import {
  captureScreen,
  NativeCaptureError,
  postAdmissionSnapshots,
} from '../../../dist/qa/capture.js';
import { unwrap } from '../../../dist/qa/adapt.js';
import { okResult } from '../../../dist/utils.js';
import { nativeCapture } from '../qa/platform-presence-fixtures.ts';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  ensureFastRunner,
  getFastRunnerState,
  runIOS,
  resolveReadyTimeoutMs,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  getPluginVersion,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
} from '../../../dist/runners/protocol.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';

let healthReplies: ('down' | 'missing-presence' | 'alive')[] = [];
let emptySnapshots = 0;
let launches = 0;
let failLaunch = false;
let launchDelayMs = 0;
let healthDelayMs = 0;
let blockSnapshots = false;
let recoveryStage: 'status' | 'resend' | undefined;
let snapshotRequests = 0;
let appProcessIdentifier = 41;
let commands: string[] = [];
let abortedRequests: string[] = [];
let launchEnv: NodeJS.ProcessEnv;
let timeoutKind: 'runner' | 'transport';
let capturePort: string;

beforeEach((t) => {
  healthReplies = [];
  emptySnapshots = 0;
  launches = 0;
  failLaunch = false;
  launchDelayMs = 0;
  healthDelayMs = 0;
  blockSnapshots = false;
  recoveryStage = undefined;
  snapshotRequests = 0;
  appProcessIdentifier = 41;
  commands = [];
  abortedRequests = [];
  launchEnv = {};
  timeoutKind = 'runner';
  capturePort = '22089';
  for (const [key, value] of Object.entries({
    QAREN_DEVICE_LEASE: 'fixture:abcdefghijklmnop',
    RN_RUNNER_BUILD: 'local',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const exists = fs.existsSync;
  t.mock.method(
    fs,
    'existsSync',
    (path) =>
      String(path).endsWith('.xcodeproj') ||
      String(path).endsWith('/Build/Products') ||
      exists(path),
  );
  const readDir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (path, options) =>
    String(path).endsWith('/Build/Products') ? ['fixture.xctestrun'] : readDir(path, options),
  );
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (path, options) => {
    if (/runner-state|\/tmp\/rn-.*-runner-state\.json/.test(String(path)))
      throw Object.assign(new Error('fixture has no persisted runner'), { code: 'ENOENT' });
    return lstat(path, options);
  });
  t.mock.method(fs, 'mkdirSync', () => {});
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(fs, 'renameSync', () => {});
  t.mock.method(fs, 'unlinkSync', () => {});
  t.mock.method(fs, 'rmSync', () => {});
  t.mock.method(childProcess, 'spawn', (_command, args, options) => {
    launches++;
    assert.equal(_command, 'xcodebuild');
    assert.equal(args[0], 'test-without-building');
    assert.ok(args.includes('platform=iOS Simulator,id=fixture-ios'));
    launchEnv = options.env;
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => assert.fail('fixture runner must never be signalled'),
    });
    const ready = () => {
      if (failLaunch) child.emit('error', new Error('fixture launch failed'));
      else child.stdout.write('RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22089\n');
    };
    if (launchDelayMs > 0) setTimeout(ready, launchDelayMs);
    else queueMicrotask(ready);
    return child;
  });
  syncBuiltinESMExports();
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: 999_999_999,
    port: 22088,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: 'now',
  });
  _setFetchForTest(async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    init?.signal?.addEventListener('abort', () => abortedRequests.push(endpoint), { once: true });
    if (endpoint === '/health') {
      if (healthDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
      const health = healthReplies.shift() ?? 'alive';
      if (health === 'down') return Response.json({ ok: false });
      return Response.json({
        ok: true,
        protocolVersion: 2,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [
          ...REQUIRED_IOS_FEATURES,
          'QA_READ_ONLY_V1',
          ...(health === 'alive' ? ['PLATFORM_PRESENCE_V2'] : []),
        ],
        instanceId: launchEnv.RN_RUNNER_INSTANCE_ID,
        sessionId: launchEnv.RN_RUNNER_SESSION_ID,
        claimEpoch: Number(launchEnv.RN_RUNNER_CLAIM_EPOCH),
        deviceId: 'fixture-ios',
        appId: 'dev.fixture',
      });
    }
    const request = JSON.parse(String(init?.body));
    assert.equal(request.advisorySnapshot, undefined);
    commands.push(request.command);
    if (request.command === 'status' && recoveryStage) {
      if (recoveryStage === 'status') await new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return Response.json({
        ok: true,
        data: { commandId: request.commandId, state: 'completed' },
      });
    }
    if (request.command === 'snapshot' && (request.platformPresence || request.qaReadOnly)) {
      snapshotRequests++;
      if (recoveryStage && snapshotRequests === 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, recoveryStage === 'status' ? 4_000 : 1_000),
        );
        throw new Error('connection reset');
      }
      if (blockSnapshots) await new Promise(() => {});
      assert.equal(new URL(String(url)).port, capturePort);
      const data = { ...nativeCapture(), appProcessIdentifier };
      if (emptySnapshots > 0) {
        emptySnapshots--;
        data.nodes = [];
      }
      return Response.json({ ok: true, data });
    }
    if (timeoutKind === 'transport') throw new DOMException('fixture timeout', 'AbortError');
    return Response.json({
      ok: false,
      error: {
        code: request.command === 'type' ? 'MAIN_THREAD_TIMEOUT' : 'RUNNER_TIMEOUT',
        message: 'main thread execution timed out',
      },
    });
  });
});

afterEach((t) => {
  _setFastRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
  t.mock.restoreAll();
  syncBuiltinESMExports();
});

for (const kind of ['runner', 'transport'] as const) {
  test(`an advisory settle ${kind} timeout preserves the reader until a real command times out`, async (t) => {
    timeoutKind = kind;
    capturePort = '22088';
    let readerAlive = true;
    const kill = process.kill;
    t.mock.method(process, 'kill', (pid, signal) => {
      assert.equal(signal, 0, 'no process may be signalled by the fixture');
      if (pid === 999_999_999 && readerAlive) return true;
      return kill(pid, signal);
    });
    const initial = getFastRunnerState();
    const context = new QaDispatchContext(10_000, () => 0);
    context.authorize();
    const probes = buildIosProbes('dev.fixture', context);
    assert.equal(await probes.snapshotHash(), null);
    assert.equal(launches, 0);
    assert.equal(getFastRunnerState(), initial);
    let now = 0;
    const outcome = await waitForSettle({
      platform: 'ios',
      capabilities: [],
      probes: {
        ...probes,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    assert.equal(outcome.method, 'timeout');
    assert.equal(outcome.settled, false);
    assert.equal(context.refusal, undefined);
    context.assertComplete();
    assert.equal(launches, 0);
    assert.equal(getFastRunnerState(), initial);
    const capture = parseEnvelope(
      await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
    );
    assert.equal(capture.ok, true, JSON.stringify(capture));
    assert.equal(launches, 0);
    assert.equal(getFastRunnerState(), initial);

    readerAlive = false;
    const command = parseEnvelope(await runIOS({ command: 'snapshot' }));
    assert.equal(command.code, 'RUNNER_TIMEOUT');
    assert.equal(command.meta.runnerTimeoutRecovery.reaped, true);
    assert.equal(launches, 1);
    assert.equal(getFastRunnerState()?.port, 22089);
  });
}

test('a verified type timeout relaunches the reaped reader before the next presence capture', async () => {
  const result = parseEnvelope(
    await runIOS({
      command: 'type',
      text: 'exact',
      _verifyExactReadback: async () => ({ matches: true }),
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.verification, 'exact-readback');
  assert.equal(result.meta.runnerTimeoutRecovery.runnerPostMortem.provenance, 'adopted');
  assert.equal(launchEnv.RN_RUNNER_ATTACH_ONLY, '1');
  assert.equal(launchEnv.TEST_RUNNER_RN_RUNNER_ATTACH_ONLY, '1');
  assert.equal(launchEnv.TEST_RUNNER_RN_RUNNER_APP_ID, 'dev.fixture');
  const capture = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(capture.ok, true, JSON.stringify(capture));
  assert.equal(launches, 1);
  assert.equal(getFastRunnerState()?.port, 22089);
});

test('an unverified type timeout keeps its verdict and restores presence capture', async () => {
  const result = parseEnvelope(await runIOS({ command: 'type', text: 'exact' }));
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(launches, 1);
  const capture = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(capture.ok, true, JSON.stringify(capture));
  assert.equal(launches, 1);
});

test('a non-type timeout keeps its verdict and restores presence capture', async () => {
  const result = parseEnvelope(await runIOS({ command: 'drag', x: 50, y: 100, x2: 50, y2: 50 }));
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(launches, 1);
  const capture = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(capture.ok, true, JSON.stringify(capture));
  assert.equal(launches, 1);
});

test('an advisory snapshot marker cannot disable mutation timeout recovery', async () => {
  const result = parseEnvelope(
    await runIOS({ command: 'tap', x: 50, y: 50, advisorySnapshot: true }),
  );
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(result.meta.runnerTimeoutRecovery.reaped, true);
  assert.equal(launches, 1);
});

test('a failed relaunch is attempted once and leaves presence capture refused', async () => {
  failLaunch = true;
  const result = parseEnvelope(
    await runIOS({
      command: 'type',
      text: 'exact',
      _verifyExactReadback: async () => ({ matches: true }),
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(launches, 1);
  const capture = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(capture.code, 'RN_FAST_RUNNER_DOWN');
  assert.equal(launches, 1);
  assert.equal(getFastRunnerState(), null);
});

test('an already absent reader is not relaunched by containment', async () => {
  const result = parseEnvelope(
    await runIOS({
      command: 'type',
      text: 'exact',
      _verifyExactReadback: async () => {
        _setFastRunnerStateForTest(null);
        return { matches: true };
      },
    }),
  );
  assert.equal(result.meta.runnerTimeoutRecovery.reapDisposition, 'already-absent');
  assert.equal(launches, 0);
});

test('containment preserves a reader replaced during independent readback', async () => {
  const replacement = {
    pid: process.pid,
    port: 22090,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: 'later',
  };
  const result = parseEnvelope(
    await runIOS({
      command: 'type',
      text: 'exact',
      _verifyExactReadback: async () => {
        _setFastRunnerStateForTest(replacement);
        return { matches: true };
      },
    }),
  );
  assert.equal(result.meta.runnerTimeoutRecovery.reapDisposition, 'replacement-preserved');
  assert.equal(getFastRunnerState()?.port, 22090);
  assert.equal(launches, 0);
});

test('concurrent timeouts share one reap and relaunch', async () => {
  const results = await Promise.all([
    runIOS({ command: 'verifyInput', text: 'exact' }),
    runIOS({ command: 'verifyInput', text: 'exact' }),
  ]);
  for (const result of results) assert.equal(parseEnvelope(result).code, 'RUNNER_TIMEOUT');
  assert.equal(launches, 1);
  assert.equal(getFastRunnerState()?.port, 22089);
});

test('ensureFastRunner reuses a healthy reader without launching', async () => {
  _setFastRunnerStateForTest({
    pid: process.pid,
    port: 22089,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: 'now',
  });
  await ensureFastRunner('fixture-ios', 'dev.fixture');
  assert.equal(launches, 0);
  assert.equal(getFastRunnerState()?.port, 22089);
});

test('ensureFastRunner replaces a wedged reader whose process exits before reaping', async (t) => {
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === 999_999_999 && signal === 0) return true;
    assert.equal(signal, 0, 'no process may be signalled by the fixture');
    return kill(pid, signal);
  });
  _setFetchForTest(async () => Response.json({ ok: false }));
  await ensureFastRunner('fixture-ios', 'dev.fixture');
  assert.equal(launches, 1);
  assert.equal(getFastRunnerState()?.port, 22089);
});

function clock(t: TestContext) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();
  return {
    now: () => now,
    async advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    },
  };
}

function privateCapture(
  now: () => number,
  onRead: () => void,
  platformPresence = true,
  snapshot = runIOS,
) {
  return captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    now,
    native: async (presenceBudgetMs) => {
      onRead();
      const { data, meta } = unwrap<Record<string, unknown>>(
        await snapshot({
          command: 'snapshot',
          qaReadOnly: true,
          ...(platformPresence ? { platformPresence: true, presenceBudgetMs } : {}),
        }),
      );
      return { ...data, snapshotVerdict: meta?.snapshotVerdict };
    },
    react: async () => ({}),
  });
}

test('relaunch waits for alive readiness with platform presence after the listener marker', async (t) => {
  const time = clock(t);
  healthReplies = ['down', 'missing-presence', 'alive'];
  let finished = false;
  const type = runIOS({ command: 'type', text: 'exact' }).then((result) => {
    finished = true;
    return parseEnvelope(result);
  });
  await nextTurn();
  assert.equal(launches, 1);
  assert.equal(finished, false);
  await time.advance(500);
  assert.equal(finished, false, 'alive without PLATFORM_PRESENCE_V2 is insufficient');
  await time.advance(500);
  assert.equal((await type).code, 'RUNNER_TIMEOUT');
  assert.equal(finished, true);
});

test(
  'private capture during reap and relaunch succeeds on its second read',
  { timeout: 5_000 },
  async (t) => {
    const time = clock(t);
    healthReplies = ['down', 'alive'];
    const type = runIOS({ command: 'type', text: 'exact' });
    await nextTurn();
    assert.equal(launches, 1);
    let reads = 0;
    const capture = privateCapture(time.now, () => reads++).catch((error: Error) => error);
    await nextTurn();
    assert.equal(reads, 1);
    await time.advance(500);
    assert.equal(parseEnvelope(await type).code, 'RUNNER_TIMEOUT');
    const screen = await capture;
    assert.ok(!(screen instanceof Error), String(screen));
    assert.equal(screen.captureCoverage?.native, 'complete');
    assert.equal(reads, 2);
    assert.equal(launches, 1);
  },
);

test('failed relaunch private capture keeps its refusal after the existing settle budget', async (t) => {
  const time = clock(t);
  failLaunch = true;
  await runIOS({ command: 'type', text: 'exact' });
  let reads = 0;
  let finished = false;
  const capture = privateCapture(time.now, () => reads++).catch((error: Error) => {
    finished = true;
    return error;
  });
  await nextTurn();
  for (let poll = 0; poll < 11; poll++) await time.advance(500);
  assert.equal(finished, false);
  await time.advance(499);
  assert.equal(finished, false);
  await time.advance(1);
  const error = await capture;
  assert.ok(error instanceof NativeCaptureError);
  assert.equal(error.code, 'NATIVE_CAPTURE_UNAVAILABLE');
  assert.equal(reads, 12);
  assert.equal(launches, 1);
});

test('post-relaunch readiness uses only the remaining READY timeout', async (t) => {
  const time = clock(t);
  const readyTimeout = resolveReadyTimeoutMs();
  launchDelayMs = readyTimeout - 1_000;
  healthReplies = ['down', 'down', 'alive'];
  let finished = false;
  const type = runIOS({ command: 'type', text: 'exact' }).then((result) => {
    finished = true;
    return parseEnvelope(result);
  });
  await nextTurn();
  await time.advance(launchDelayMs);
  assert.equal(finished, false);
  await time.advance(500);
  assert.equal(finished, false);
  await time.advance(499);
  assert.equal(finished, false);
  await time.advance(1);
  assert.equal((await type).code, 'RUNNER_TIMEOUT');
  assert.equal(time.now(), readyTimeout);
  assert.deepEqual(healthReplies, ['alive'], 'no probe starts after the existing deadline');
});

test(
  'private capture also retries a runner down immediately after relaunch completes',
  { timeout: 5_000 },
  async (t) => {
    const time = clock(t);
    await runIOS({ command: 'type', text: 'exact' });
    healthReplies = ['down', 'alive'];
    let reads = 0;
    const capture = privateCapture(time.now, () => reads++);
    await nextTurn();
    assert.equal(reads, 1);
    await time.advance(500);
    assert.equal((await capture).captureCoverage?.native, 'complete');
    assert.equal(reads, 2);
    healthReplies = ['down'];
    await assert.rejects(
      privateCapture(time.now, () => reads++),
      NativeCaptureError,
    );
    assert.equal(reads, 3);
  },
);

test(
  'an empty read retains relaunch retry eligibility through the private capture',
  { timeout: 5_000 },
  async (t) => {
    const time = clock(t);
    await runIOS({ command: 'type', text: 'exact' });
    emptySnapshots = 1;
    healthReplies = ['alive', 'alive', 'down', 'alive', 'alive'];
    let reads = 0;
    const capture = privateCapture(time.now, () => reads++).catch((error: Error) => error);
    await nextTurn();
    await time.advance(500);
    await time.advance(500);
    const screen = await capture;
    assert.ok(!(screen instanceof Error), String(screen));
    assert.equal(screen.captureCoverage?.native, 'complete');
    assert.equal(reads, 3);
  },
);

for (const platformPresence of [true, false]) {
  for (const slowStage of ['health', 'snapshot', 'status', 'resend'] as const) {
    if (platformPresence && (slowStage === 'status' || slowStage === 'resend')) continue;
    test(`${platformPresence ? 'presence' : 'ordinary'} relaunch recovery bounds slow ${slowStage} reads by the settle budget`, async (t) => {
      const time = clock(t);
      await runIOS({ command: 'type', text: 'exact' });
      healthReplies = ['down'];
      let reads = 0;
      let finished = false;
      const capture = privateCapture(time.now, () => reads++, platformPresence).catch(
        (error: Error) => {
          finished = true;
          return error;
        },
      );
      await nextTurn();
      assert.equal(reads, 1);
      commands = [];
      if (slowStage === 'health') {
        healthDelayMs = 2_000;
        healthReplies = ['down', 'down', 'down'];
      } else {
        healthDelayMs = slowStage === 'snapshot' ? 1_500 : 0;
        blockSnapshots = true;
        if (slowStage === 'status' || slowStage === 'resend') recoveryStage = slowStage;
      }
      for (let tick = 0; tick < 11; tick++) await time.advance(500);
      assert.equal(finished, false);
      await time.advance(499);
      assert.equal(finished, false);
      await time.advance(1);
      assert.ok((await capture) instanceof NativeCaptureError);
      assert.equal(time.now(), 6_000);
      assert.ok(abortedRequests.includes(slowStage === 'health' ? '/health' : '/command'));
      if (slowStage === 'status') assert.deepEqual(commands, ['snapshot', 'status']);
      if (slowStage === 'resend') assert.deepEqual(commands, ['snapshot', 'status', 'snapshot']);
      assert.equal(launches, 1);
    });
  }
}

test('ordinary private relaunch recovery admits a successful re-read', async (t) => {
  const time = clock(t);
  await runIOS({ command: 'type', text: 'exact' });
  healthReplies = ['down', 'alive'];
  let reads = 0;
  const capture = privateCapture(time.now, () => reads++, false);
  await nextTurn();
  await time.advance(500);
  assert.equal((await capture).captureCoverage?.native, 'complete');
  assert.equal(reads, 2);
  assert.equal(launches, 1);
});

for (const platformPresence of [true, false]) {
  for (const recoveredProcess of [41, 77]) {
    test(`${platformPresence ? 'presence' : 'ordinary'} recovered capture preserves post-admission process tracking for PID ${recoveredProcess}`, async (t) => {
      const time = clock(t);
      let baseline = true;
      const snapshots = postAdmissionSnapshots(async (args: Parameters<typeof runIOS>[0]) => {
        if (baseline) {
          baseline = false;
          return okResult({ appProcessIdentifier: 41, nodes: [] });
        }
        return runIOS(args);
      }, 'com.test');
      await snapshots.snapshot({ command: 'snapshot', qaReadOnly: true });
      await runIOS({ command: 'type', text: 'exact' });
      assert.equal(snapshots.interrupted(), false);
      appProcessIdentifier = recoveredProcess;
      healthReplies = ['down', 'alive'];
      let reads = 0;
      const capture = privateCapture(time.now, () => reads++, platformPresence, snapshots.snapshot);
      await nextTurn();
      assert.equal(reads, 1);
      assert.equal(snapshots.interrupted(), false, 'transient absence is not a process change');
      await time.advance(500);
      assert.equal((await capture).captureCoverage?.native, 'complete');
      assert.equal(reads, 2);
      assert.equal(snapshots.interrupted(), recoveredProcess !== 41);
    });
  }
}
