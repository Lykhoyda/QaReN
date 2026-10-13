import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apkLockSystem, barrier } from '../helpers/android-apk-lock-system.ts';

// Isolate HOME and PATH; provisioning subprocesses are replaced at the OS boundary.
if (!process.env.QAREN_APK_LOCK_TEST_CHILD) {
  test('ANT-597: provisioning is hermetic with no Android SDK or tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qaren-apk-lock-'));
    const home = join(root, 'home');
    mkdirSync(home);
    try {
      const result = await promisify(childProcess.execFile)(
        process.execPath,
        ['--test', fileURLToPath(import.meta.url)],
        {
          env: { HOME: home, PATH: '', CI: 'true', QAREN_APK_LOCK_TEST_CHILD: root },
          timeout: 5 * 60_000,
        },
      );
      assert.match(result.stdout, /tests 8/);
      assert.match(result.stdout, /fail 0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
} else {
  const root = process.env.QAREN_APK_LOCK_TEST_CHILD;
  const runner = join(root, 'rn-android-runner');
  const app = join(runner, 'app/build/outputs/apk/debug/app-debug.apk');
  const instrumentation = join(
    runner,
    'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
  );
  mkdirSync(dirname(app), { recursive: true });
  mkdirSync(dirname(instrumentation), { recursive: true });
  process.env.QAREN_NATIVE_RUNNER_ROOT = root;
  process.env.QAREN_DEVICE_LEASE = 'test-check:0123456789abcdef';
  const client = await import('../../dist/runners/rn-android-runner-client.js');
  const bytes = Buffer.from('expected runner build');
  const provisioned = new Error('provisioning complete');

  test('ANT-597: stale retry cannot delete APKs between a concurrent fresh build and hash/install', async (t) => {
    const system = apkLockSystem(t);
    const built = barrier();
    const resumeBuild = barrier();
    const invalidated = barrier();
    const resumeRetry = barrier();
    const installed = new Map<string, Buffer[]>();
    let builds = 0;
    let invalidationCompleted = false;
    let failBuild = false;
    let failInstall = false;
    let forceBuildStop = false;
    const original = childProcess.execFile;
    const execute = (() => {
      throw new Error('unexpected callback subprocess');
    }) as typeof childProcess.execFile;
    Object.defineProperty(execute, promisify.custom, {
      value: async (file: string, args: string[]) => {
        if (file === join(runner, 'gradlew')) {
          if (forceBuildStop) {
            throw Object.assign(new Error('fixture build stopped'), {
              killed: true,
              signal: 'SIGTERM',
            });
          }
          if (failBuild) throw new Error('fixture build failure');
          builds++;
          writeFileSync(app, bytes);
          writeFileSync(instrumentation, bytes);
          if (builds === 1) {
            built.resolve();
            await resumeBuild.promise;
          }
          return { stdout: '', stderr: '' };
        }
        assert.equal(file, 'adb', 'unexpected host executable');
        assert.equal(args[0], '-s');
        const command = args.slice(2);
        if (command[0] === 'get-state') return { stdout: 'device\n' };
        if (command.join(' ') === 'shell pm list instrumentation') return { stdout: '' };
        if (command[0] === 'install') {
          if (failInstall) throw new Error('fixture install failure');
          const pair = installed.get(args[1]) ?? [];
          pair.push(readFileSync(command[2]));
          installed.set(args[1], pair);
          return { stdout: 'Success\n' };
        }
        assert.equal(command[0], 'forward');
        return { stdout: '' };
      },
    });
    childProcess.execFile = execute;
    t.mock.method(childProcess, 'spawn', () => {
      throw provisioned;
    });
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.execFile = original;
      syncBuiltinESMExports();
      client._setAndroidRunnerStateForTest(null);
    });
    const first = assert.rejects(
      client.startAndroidRunner('fresh-a', 'com.example', 0),
      (err) => err === provisioned,
    );
    await built.promise;
    const database = join(root, 'retry.sqlite');
    const retry = assert.rejects(
      client.runBoundedAndroidRunnerRebuild(
        new client.AndroidAuthorityStaleError('fresh-b'),
        async (signal) => {
          await client.invalidateAndroidRunnerApks();
          invalidationCompleted = true;
          invalidated.resolve();
          await resumeRetry.promise;
          return client.startAndroidRunner('fresh-b', 'com.example', 0, {
            _forceReinstall: true,
            _rebuildSignal: signal,
          });
        },
        async () => {},
        {
          acquire: (version) =>
            client.acquireAndroidRunnerRebuildLock(version, Date.now(), 'retry', database),
          heartbeat: (lock) => client.heartbeatAndroidRunnerRebuildLock(lock, Date.now(), database),
          beginCleanup: (lock) =>
            client.beginAndroidRunnerRebuildCleanup(lock, Date.now(), database),
          release: (lock) => client.releaseAndroidRunnerRebuildLock(lock, Date.now(), database),
        },
      ),
      (err) => err === provisioned,
    );
    assert.equal(await system.nextSleep(retry), 25);
    assert.equal(
      invalidationCompleted,
      false,
      'retry deleted APKs while build/hash/install held the fence',
    );
    resumeBuild.resolve();
    await first;
    system.advance(25);
    await invalidated.promise;
    resumeRetry.resolve();
    await retry;
    assert.deepEqual(installed.get('fresh-a'), [bytes, bytes]);
    assert.deepEqual(installed.get('fresh-b'), [bytes, bytes]);
    // Instrumentation failure must leave provisioning available for the next start.
    await assert.rejects(
      client.startAndroidRunner('serial-c', 'com.example', 0),
      (err) => err === provisioned,
    );
    assert.deepEqual(installed.get('serial-c'), [bytes, bytes]);
    failBuild = true;
    await assert.rejects(
      client.startAndroidRunner('failed-build', 'com.example', 0),
      /fixture build failure/,
    );
    failBuild = false;
    failInstall = true;
    await assert.rejects(
      client.startAndroidRunner('failed-install', 'com.example', 0),
      /fixture install failure/,
    );
    failInstall = false;
    await assert.rejects(
      client.startAndroidRunner('after-failure', 'com.example', 0),
      (err) => err === provisioned,
    );
    assert.deepEqual(installed.get('after-failure'), [bytes, bytes]);
    system.processes.get(process.pid)!.pgid = process.pid + 100;
    forceBuildStop = true;
    await assert.rejects(
      client.startAndroidRunner('forced-build-stop', 'com.example', 0),
      /source build failed/,
    );
    const { withAndroidRunnerApkLock, AndroidRunnerApkLockUnprovenError } =
      await import('../../dist/runners/android-runner-apk-lock.js');
    const lock = join(runner, 'app/build/.qaren-apk-lock');
    try {
      await assert.rejects(
        withAndroidRunnerApkLock(lock, async () => assert.fail('forced build lost its fence'), {
          timeoutMs: 20,
        }),
        AndroidRunnerApkLockUnprovenError,
      );
    } finally {
      // Retire only the fake unscoped owner's retained fence.
      rmSync(lock, { recursive: true, force: true });
    }
  });

  const {
    withAndroidRunnerApkLock,
    AndroidRunnerApkLockTimeoutError,
    AndroidRunnerApkLockUnprovenError,
  } = await import('../../dist/runners/android-runner-apk-lock.js');

  test('ANT-597: separate worktrees provision independently', async (t) => {
    apkLockSystem(t);
    await withAndroidRunnerApkLock(join(root, 'worktree-a/lock'), async () => {
      const result = await withAndroidRunnerApkLock(
        join(root, 'worktree-b/lock'),
        async () => 'installed',
        { timeoutMs: 100 },
      );
      assert.equal(result, 'installed');
    });
  });

  test('ANT-597: failed provisioning releases the outputs for another start', async (t) => {
    apkLockSystem(t);
    const lock = join(root, 'failure/lock');
    const failure = new Error('build failed');
    await assert.rejects(
      withAndroidRunnerApkLock(lock, async () => {
        throw failure;
      }),
      (err) => err === failure,
    );
    assert.equal(
      await withAndroidRunnerApkLock(lock, async () => 'installed', { timeoutMs: 100 }),
      'installed',
    );
  });

  test('ANT-597: a contending caller times out with the named refusal and cannot release its owner', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'timeout/lock');
    await withAndroidRunnerApkLock(lock, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const waiting = withAndroidRunnerApkLock(
          lock,
          async () => assert.fail('waiter entered occupied outputs'),
          { timeoutMs: 30 },
        );
        const rejected = assert.rejects(waiting, AndroidRunnerApkLockTimeoutError);
        assert.equal(await system.nextSleep(waiting), 25);
        system.advance(25);
        assert.equal(await system.nextSleep(waiting), 5);
        system.advance(5);
        await system.withoutSleeping(rejected);
      }
    });
    assert.equal(await withAndroidRunnerApkLock(lock, async () => 'installed'), 'installed');
    assert.deepEqual(system.signals, []);
  });

  test('ANT-597: cancellation while waiting leaves the owner intact', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'cancel-wait/lock');
    await withAndroidRunnerApkLock(lock, async () => {
      const controller = new AbortController();
      const refusal = new Error('cancelled');
      const waiting = withAndroidRunnerApkLock(
        lock,
        async () => assert.fail('cancelled waiter entered'),
        { signal: controller.signal },
      );
      const rejected = assert.rejects(waiting, (err) => err === refusal);
      assert.equal(await system.nextSleep(waiting), 25);
      controller.abort(refusal);
      await rejected;
      const stillHeld = assert.rejects(
        withAndroidRunnerApkLock(lock, async () => assert.fail('owner lost'), { timeoutMs: 20 }),
        AndroidRunnerApkLockTimeoutError,
      );
      assert.equal(await system.nextSleep(stillHeld), 20);
      system.advance(20);
      await stillHeld;
    });
  });

  test('ANT-597: an unscoped aborted owner refuses without signaling its peers', async (t) => {
    const system = apkLockSystem(t);
    system.processes.get(process.pid)!.pgid = process.pid + 100;
    const lock = join(root, 'cancel-owner/lock');
    const controller = new AbortController();
    const reason = new Error('cancelled build');
    await assert.rejects(
      withAndroidRunnerApkLock(
        lock,
        async () => {
          controller.abort(reason);
          throw reason;
        },
        { signal: controller.signal },
      ),
      (err) => err === reason,
    );
    await assert.rejects(
      withAndroidRunnerApkLock(lock, async () => assert.fail('abandoned outputs taken over'), {
        timeoutMs: 20,
      }),
      AndroidRunnerApkLockUnprovenError,
    );
    assert.deepEqual(system.signals, []);
  });

  const { withCancellation, RunCancelledError } = await import('../../dist/domain/cancellation.js');
  for (const cancelledBy of ['caller', 'rebuild'] as const) {
    test(`ANT-597: ${cancelledBy} cancellation stops a waiting invalidation without deleting APKs`, async (t) => {
      const system = apkLockSystem(t);
      const removed: string[] = [];
      await withAndroidRunnerApkLock(join(runner, 'app/build/.qaren-apk-lock'), async () => {
        const caller = new AbortController();
        const rebuild = new AbortController();
        const reason = new RunCancelledError();
        const waiting = withCancellation(caller.signal, () =>
          client.invalidateAndroidRunnerApks((path) => removed.push(path), rebuild.signal),
        );
        const rejected = assert.rejects(waiting, (err) => err === reason);
        assert.equal(await system.nextSleep(waiting), 25);
        (cancelledBy === 'caller' ? caller : rebuild).abort(reason);
        await rejected;
        assert.deepEqual(removed, []);
      });
    });
  }
}
