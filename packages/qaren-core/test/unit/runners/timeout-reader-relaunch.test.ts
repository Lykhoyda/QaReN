import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import { unwrap } from '../../../dist/qa/adapt.js';
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
let abortedRequests: string[] = [];
let launchEnv: NodeJS.ProcessEnv;

beforeEach((t) => {
  healthReplies = [];
  emptySnapshots = 0;
  launches = 0;
  failLaunch = false;
  launchDelayMs = 0;
  healthDelayMs = 0;
  blockSnapshots = false;
  abortedRequests = [];
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
    if (request.command === 'snapshot' && request.platformPresence) {
      if (blockSnapshots) await new Promise(() => {});
      assert.equal(new URL(String(url)).port, '22089');
      const data = nativeCapture();
      if (emptySnapshots > 0) {
        emptySnapshots--;
        data.nodes = [];
      }
      return Response.json({ ok: true, data });
    }
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

function privateCapture(now: () => number, onRead: () => void) {
  return captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    now,
    native: async (presenceBudgetMs) => {
      onRead();
      const { data, meta } = unwrap<Record<string, unknown>>(
        await runIOS({
          command: 'snapshot',
          qaReadOnly: true,
          platformPresence: true,
          presenceBudgetMs,
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

for (const slowStage of ['health', 'snapshot'] as const) {
  test(`private relaunch recovery bounds slow ${slowStage} reads by the settle budget`, async (t) => {
    const time = clock(t);
    await runIOS({ command: 'type', text: 'exact' });
    healthReplies = ['down'];
    let reads = 0;
    let finished = false;
    const capture = privateCapture(time.now, () => reads++).catch((error: Error) => {
      finished = true;
      return error;
    });
    await nextTurn();
    assert.equal(reads, 1);
    healthDelayMs = slowStage === 'health' ? 2_000 : 1_500;
    if (slowStage === 'health') healthReplies = ['down', 'down', 'down'];
    else blockSnapshots = true;
    for (let tick = 0; tick < 11; tick++) await time.advance(500);
    assert.equal(finished, false);
    await time.advance(499);
    assert.equal(finished, false);
    await time.advance(1);
    assert.ok((await capture) instanceof NativeCaptureError);
    assert.equal(time.now(), 6_000);
    assert.ok(abortedRequests.includes(slowStage === 'health' ? '/health' : '/command'));
    assert.equal(launches, 1);
  });
}
