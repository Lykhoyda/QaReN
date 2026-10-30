import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('native startup settles cancellation and rejects buffered readiness without persistence', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'qaren-readiness-'));
  const removeFixture = fs.rmSync;
  for (const [relativePath, bytes] of [
    ['debug/app-debug.apk', 'readiness fixture main APK'],
    ['androidTest/debug/app-debug-androidTest.apk', 'readiness fixture test APK'],
  ]) {
    const apk = join(root, 'qaren-android-runner/app/build/outputs/apk', relativePath);
    fs.mkdirSync(dirname(apk), { recursive: true });
    fs.writeFileSync(apk, bytes);
  }
  fs.writeFileSync(join(root, 'qaren-android-runner/gradlew'), '');
  t.after(() => removeFixture(root, { recursive: true, force: true }));
  const originalExists = fs.existsSync;
  const originalReadDir = fs.readdirSync;
  const originalLstat = fs.lstatSync;
  const originalMkdir = fs.mkdirSync;
  t.mock.method(fs, 'lstatSync', (path, options) => {
    if (
      /runner-state|session-|\/tmp\/(?:rn-(?:fast|android)-runner-state|qaren-session)\.json/.test(
        String(path),
      )
    ) {
      throw Object.assign(new Error('fixture state is absent'), { code: 'ENOENT' });
    }
    return originalLstat(path, options);
  });
  const writes: unknown[] = [];
  const mutations: unknown[] = [];
  t.mock.method(fs, 'mkdirSync', (...args) => {
    mutations.push(['mkdir', ...args]);
    // Provisioning coordinates real APK files through the fixture's outputs
    // lock; keep that filesystem lifecycle real while stubbing durable state.
    if (String(args[0]).startsWith(join(root, 'qaren-android-runner/app/build'))) {
      return Reflect.apply(originalMkdir, fs, args);
    }
  });
  t.mock.method(fs, 'rmSync', (...args) => {
    mutations.push(['rm', ...args]);
  });
  const originalCreateServer = net.createServer;
  let bindings = 0;
  t.mock.method(net, 'createServer', (...args) => {
    bindings++;
    return Reflect.apply(originalCreateServer, net, args);
  });
  let pmWait: (() => Promise<{ stdout: string; stderr: string }>) | undefined;
  const commands: string[][] = [];
  const spawns: Array<
    EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; kill(): boolean }
  > = [];
  t.mock.method(
    fs,
    'existsSync',
    (path) =>
      String(path).endsWith('.xcodeproj') ||
      String(path).endsWith('/Build/Products') ||
      originalExists(path),
  );
  t.mock.method(fs, 'readdirSync', (path, options) =>
    String(path).endsWith('/Build/Products')
      ? ['fixture.xctestrun']
      : originalReadDir(path, options),
  );
  t.mock.method(fs, 'writeFileSync', (...args) => {
    writes.push(args);
  });
  t.mock.method(fs, 'renameSync', () => {});
  t.mock.method(fs, 'unlinkSync', () => {});
  t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      kill: () => true,
    });
    spawns.push(child);
    return child;
  });
  const originalExecFile = childProcess.execFile;
  const execute = (_command, args, ...rest) => {
    const callback = rest.at(-1);
    const stdout = args.includes('get-state')
      ? 'device'
      : args.includes('instrumentation')
        ? 'instrumentation:dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner'
        : '';
    queueMicrotask(() => callback(null, stdout, ''));
    return new EventEmitter();
  };
  Object.defineProperty(execute, promisify.custom, {
    configurable: true,
    value: async (command, args, options) => {
      commands.push(args);
      if (pmWait && args.includes('instrumentation')) return pmWait();
      return new Promise((resolve, reject) => {
        execute(command, args, options, (error, stdout, stderr) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      });
    },
  });
  childProcess.execFile = execute;
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { withCancellation, RunCancelledError } =
    await import('../../../dist/domain/cancellation.js');
  const previousRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
  process.env.QAREN_NATIVE_RUNNER_ROOT = root;
  let ios: typeof import('../../../dist/runners/qaren-ios-runner-client.js');
  let android: typeof import('../../../dist/runners/qaren-android-runner-client.js');
  try {
    ios = await import('../../../dist/runners/qaren-ios-runner-client.js');
    android = await import('../../../dist/runners/qaren-android-runner-client.js');
  } finally {
    if (previousRoot === undefined) delete process.env.QAREN_NATIVE_RUNNER_ROOT;
    else process.env.QAREN_NATIVE_RUNNER_ROOT = previousRoot;
  }
  t.after(() => android._setFetchForTest(globalThis.fetch));
  const previousLease = process.env.QAREN_DEVICE_LEASE;
  process.env.QAREN_DEVICE_LEASE = 'test:abcdefghijklmnop';
  t.after(() => {
    if (previousLease === undefined) delete process.env.QAREN_DEVICE_LEASE;
    else process.env.QAREN_DEVICE_LEASE = previousLease;
  });

  android._setAndroidRunnerStateForTest(null);
  android.consumePendingAndroidUpgradeNote();
  const pmController = new AbortController();
  let notifyPm!: () => void;
  const pmStarted = new Promise<void>((resolve) => {
    notifyPm = resolve;
  });
  let releasePm!: () => void;
  pmWait = () => {
    notifyPm();
    return new Promise((resolve) => {
      releasePm = () => resolve({ stdout: '', stderr: '' });
    });
  };
  const pmPending = withCancellation(pmController.signal, () =>
    android.startAndroidRunner('emulator-test', 'com.example.app', 0),
  );
  const pmReason = new RunCancelledError();
  const pmRejected = assert.rejects(pmPending, (error) => error === pmReason);
  await Promise.race([
    pmStarted,
    pmPending.then(() => assert.fail('startup completed before the instrumentation query')),
  ]);
  const beforeAbort = commands.length;
  const beforeMutations = mutations.length;
  const beforeBindings = bindings;
  const beforeSpawns = spawns.length;
  pmController.abort(pmReason);
  await pmRejected;
  releasePm();
  await setImmediate();
  assert.equal(commands.length, beforeAbort);
  assert.equal(mutations.length, beforeMutations);
  assert.equal(bindings, beforeBindings);
  assert.equal(spawns.length, beforeSpawns);
  assert.equal(android.consumePendingAndroidUpgradeNote(), undefined);
  assert.equal(android.getAndroidRunnerState(), null);
  assert.deepEqual(writes, []);
  pmWait = undefined;

  for (const terminal of ['abort-with-buffered-output', 'error', 'exit'] as const) {
    ios._setFastRunnerStateForTest(null);
    const controller = new AbortController();
    const spawnCount = spawns.length;
    const pending = withCancellation(controller.signal, () =>
      ios.startFastRunner('00000000-0000-0000-0000-000000000001', 'com.example.app', 22087, {
        forceLocalBuild: true,
      }),
    );
    const rejected = assert.rejects(pending);
    await setImmediate();
    assert.equal(spawns.length, spawnCount + 1);
    const child = spawns.at(-1)!;
    assert.ok(child);
    if (terminal === 'abort-with-buffered-output') controller.abort(new RunCancelledError());
    else if (terminal === 'error') child.emit('error', new Error('launch failed'));
    else child.emit('exit', 1, null);
    child.stdout.write('RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22087\n');
    child.stderr.write('RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22087\n');
    if (terminal === 'abort-with-buffered-output') child.emit('error', new RunCancelledError());
    await rejected;
    assert.equal(ios.getFastRunnerState(), null);
    assert.deepEqual(writes, []);
  }

  for (const phase of ['polling', 'success-continuation'] as const) {
    android._setAndroidRunnerStateForTest(null);
    const controller = new AbortController();
    let healthCalls = 0;
    let notify!: () => void;
    const reached = new Promise<void>((resolve) => {
      notify = resolve;
    });
    android._setFetchForTest(async () => {
      healthCalls++;
      if (phase === 'success-continuation' && healthCalls === 2) {
        controller.abort(new RunCancelledError());
        notify();
        throw controller.signal.reason;
      }
      notify();
      return Response.json({ ok: phase === 'success-continuation' });
    });
    const pending = withCancellation(controller.signal, () =>
      android.startAndroidRunner('emulator-test', 'com.example.app', 0),
    );
    const rejected = assert.rejects(pending);
    await Promise.race([
      reached,
      pending.then(() => assert.fail('startup completed before the health callback')),
    ]);
    await setImmediate();
    if (phase === 'polling') controller.abort(new RunCancelledError());
    await rejected;
    await setImmediate();
    assert.equal(android.getAndroidRunnerState(), null);
    assert.deepEqual(writes, []);
  }
});
