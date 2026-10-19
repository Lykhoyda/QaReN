import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  captureScreen,
  NativeCaptureError,
  type NativeObservation,
} from '../../../dist/qa/capture.js';
import { unwrap } from '../../../dist/qa/adapt.js';
import { nativeCapture } from '../qa/platform-presence-fixtures.ts';
import { afterEach, beforeEach, test } from 'node:test';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  ensureFastRunner,
  observeRunnerRelaunches,
  getFastRunnerState,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  getPluginVersion,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
} from '../../../dist/runners/protocol.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';

let launches = 0;
let failLaunch = false;
let resumeLaunch: (() => void) | undefined;
let holdLaunch = false;
let healthReads = 0;
let healthReady = true;
let launchEnv: NodeJS.ProcessEnv;
let fixtureFetch: typeof fetch;

beforeEach((t) => {
  launches = 0;
  holdLaunch = false;
  resumeLaunch = undefined;
  healthReads = 0;
  healthReady = true;
  failLaunch = false;
  launchEnv = {};
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
    queueMicrotask(() => {
      if (failLaunch) child.emit('error', new Error('fixture launch failed'));
      else {
        const ready = () =>
          child.stdout.write('RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22089\n');
        if (holdLaunch) resumeLaunch = ready;
        else ready();
      }
    });
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
  fixtureFetch = async (url, init) => {
    if (String(url).endsWith('/health')) {
      healthReads++;
      if (!healthReady) return Response.json({ ok: false });
      return Response.json({
        ok: true,
        protocolVersion: 2,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1'],
        instanceId: launchEnv.RN_RUNNER_INSTANCE_ID,
        sessionId: launchEnv.RN_RUNNER_SESSION_ID,
        claimEpoch: Number(launchEnv.RN_RUNNER_CLAIM_EPOCH),
        deviceId: 'fixture-ios',
        appId: 'dev.fixture',
      });
    }
    const request = JSON.parse(String(init?.body));
    if (request.command === 'snapshot' && request.platformPresence) {
      assert.equal(new URL(String(url)).port, '22089');
      const capture = nativeCapture();
      capture.presenceCapture.appliedBudgetMs = request.presenceBudgetMs;
      const { snapshotVerdict, ...data } = capture;
      return Response.json({ ok: true, data, meta: { snapshotVerdict } });
    }
    return Response.json({
      ok: false,
      error: {
        code: request.command === 'type' ? 'MAIN_THREAD_TIMEOUT' : 'RUNNER_TIMEOUT',
        message: 'main thread execution timed out',
      },
    });
  };
  _setFetchForTest(fixtureFetch);
});

afterEach((t) => {
  _setFastRunnerStateForTest(null);
  observeRunnerRelaunches(undefined);
  _setFetchForTest(globalThis.fetch);
  t.mock.timers.reset();
  t.mock.restoreAll();
  syncBuiltinESMExports();
});

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

test('containment attests readiness before returning from the relaunch', async () => {
  const result = parseEnvelope(await runIOS({ command: 'type', text: 'exact' }));
  assert.equal(result.code, 'RUNNER_TIMEOUT');
  assert.equal(healthReads, 1);
  assert.equal(result.meta.runnerTimeoutRecovery.relaunch.outcome, 'ready');
});

test('private capture waits for an in-progress relaunch and admits the next read', async (t) => {
  holdLaunch = true;
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  const timeout = runIOS({ command: 'type', text: 'exact' });
  await nextTurn();
  assert.ok(resumeLaunch);
  let reads = 0;
  const screen = captureScreen({
    requirePrivateInputs: true,
    platformPresence: true,
    appId: 'com.test',
    now: () => now,
    native: async (budget) => {
      reads++;
      const { data, meta } = unwrap<NativeObservation>(
        await runIOS({
          command: 'snapshot',
          qaReadOnly: true,
          platformPresence: true,
          presenceBudgetMs: budget,
        }),
      );
      return { ...data, snapshotVerdict: meta?.snapshotVerdict };
    },
    react: async () => ({}),
  }).catch((error: Error) => error);
  await nextTurn();
  assert.equal(reads, 1);
  resumeLaunch!();
  await timeout;
  now = 500;
  t.mock.timers.tick(500);
  await nextTurn();
  const result = await screen;
  assert.ok(!(result instanceof Error), String(result));
  assert.equal(reads, 2);
  assert.equal(result.coverage?.native, 'complete');
  assert.equal(launches, 1);
});

test('a never-ready relaunched reader keeps the native capture refusal after the settle window', async (t) => {
  healthReady = false;
  await runIOS({ command: 'type', text: 'exact' });
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  let reads = 0;
  let finished = false;
  const result = captureScreen({
    requirePrivateInputs: true,
    now: () => now,
    native: async (budget) => {
      reads++;
      return unwrap<NativeObservation>(
        await runIOS({
          command: 'snapshot',
          qaReadOnly: true,
          platformPresence: true,
          presenceBudgetMs: budget,
        }),
      ).data;
    },
    react: async () => ({}),
  }).catch((error: Error) => {
    finished = true;
    return error;
  });
  await nextTurn();
  for (let i = 0; i < 11; i++) {
    now += 500;
    t.mock.timers.tick(500);
    await nextTurn();
  }
  assert.equal(finished, false);
  now += 500;
  t.mock.timers.tick(500);
  await nextTurn();
  const error = await result;
  assert.ok(error instanceof NativeCaptureError);
  assert.equal(error.code, 'NATIVE_CAPTURE_UNAVAILABLE');
  assert.equal(error.message, 'Native capture is unavailable.');
  assert.equal(reads, 12);
  assert.equal(launches, 1);
});

test('the readiness probe uses only the remainder of the existing launch deadline', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  holdLaunch = true;
  let probeSignal: AbortSignal | undefined;
  _setFetchForTest(async (url, init) => {
    if (!String(url).endsWith('/health')) return fixtureFetch(url, init);
    probeSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      probeSignal!.addEventListener('abort', () => reject(probeSignal!.reason), { once: true });
    });
  });
  let finished = false;
  const result = runIOS({ command: 'type', text: 'exact' }).then((value) => {
    finished = true;
    return parseEnvelope(value);
  });
  await nextTurn();
  assert.ok(resumeLaunch);
  now = 29_500;
  t.mock.timers.tick(29_500);
  resumeLaunch!();
  await nextTurn();
  assert.ok(probeSignal);
  assert.equal(finished, false);
  now = 29_999;
  t.mock.timers.tick(499);
  await nextTurn();
  assert.equal(probeSignal.aborted, false);
  now = 30_000;
  t.mock.timers.tick(1);
  await nextTurn();
  const response = await result;
  assert.equal(response.code, 'RUNNER_TIMEOUT');
  assert.deepEqual(response.meta.runnerTimeoutRecovery.relaunch, {
    outcome: 'timeout',
    ms: 30_000,
  });
  assert.equal(probeSignal.aborted, true);
  assert.equal(launches, 1);
});

test('relaunch outcomes emit only fixed vocabulary and duration through the slot wire', async () => {
  const { createWriter } = await import('../../../dist/qa/wire.js');
  const { RunInputs, withInputs } = await import('../../../dist/qa/inputs.js');
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'fixture');
  observeRunnerRelaunches({
    now: () => 10,
    observe: (event) => writer.diagnostic({ kind: 'metric', ...event }),
  });
  failLaunch = true;
  await withInputs(new RunInputs({ PASSWORD: 'private-fixture-value' }, ['PASSWORD']), () =>
    runIOS({ command: 'type', text: 'private-fixture-value' }),
  );
  const events = lines.map((line) => JSON.parse(line).payload);
  assert.equal(events.length, 2);
  assert.equal(events[0].relaunch, 'attempted');
  assert.equal(events[1].relaunch, 'failed');
  assert.equal(events[1].stage, 'relaunch');
  assert.equal(events[1].reapDisposition, 'reaped');
  assert.equal(typeof events[1].ms, 'number');
  for (const event of events)
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        'at',
        'edge',
        'kind',
        'outcome',
        'reapDisposition',
        'relaunch',
        'stage',
        ...(event.ms === undefined ? [] : ['ms']),
      ].sort(),
    );
  assert.ok(!lines.join('').includes('private-fixture-value'));
});
