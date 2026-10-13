import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the executable seams with an empty HOME and no host tooling available.
// Every subprocess is replaced at the OS boundary; an unexpected one fails.
if (!process.env.QAREN_APK_LOCK_TEST_CHILD) {
  test(
    'ANT-597: provisioning is hermetic with no Android SDK or tools',
    { timeout: 15_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'qaren-apk-lock-'));
      const home = join(root, 'home');
      mkdirSync(home);
      try {
        const result = await promisify(childProcess.execFile)(
          process.execPath,
          ['--test', fileURLToPath(import.meta.url)],
          {
            env: { HOME: home, PATH: '', CI: 'true', QAREN_APK_LOCK_TEST_CHILD: root },
            timeout: 12_000,
          },
        );
        assert.match(result.stdout, /fail 0/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
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

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  test(
    'ANT-597: stale retry cannot delete APKs between a concurrent fresh build and hash/install',
    { timeout: 5_000 },
    async (t) => {
      const built = barrier();
      const resumeBuild = barrier();
      const invalidated = barrier();
      const resumeRetry = barrier();
      const installed = new Map<string, Buffer[]>();
      let builds = 0;
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
              await promisify(original)(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                timeout: 30,
              });
              assert.fail('fixture child did not stop');
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
        t.mock.restoreAll();
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
            heartbeat: (lock) =>
              client.heartbeatAndroidRunnerRebuildLock(lock, Date.now(), database),
            beginCleanup: (lock) =>
              client.beginAndroidRunnerRebuildCleanup(lock, Date.now(), database),
            release: (lock) => client.releaseAndroidRunnerRebuildLock(lock, Date.now(), database),
          },
        ),
        (err) => err === provisioned,
      );
      // On base, invalidation completes before the first hash read. With mutual
      // exclusion it waits; release the build after a bounded contention window.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        invalidated.promise,
        new Promise<void>((done) => {
          timer = setTimeout(done, 100);
        }),
      ]);
      clearTimeout(timer);
      resumeBuild.resolve();
      resumeRetry.resolve();
      await Promise.all([first, retry]);
      assert.deepEqual(installed.get('fresh-a'), [bytes, bytes]);
      assert.deepEqual(installed.get('fresh-b'), [bytes, bytes]);
      // The provisioning lock is gone before instrumentation starts, including
      // this launch failure; a later serial fresh start remains usable.
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
      forceBuildStop = true;
      await assert.rejects(
        client.startAndroidRunner('forced-build-stop', 'com.example', 0),
        /source build failed/,
      );
      const { withAndroidRunnerApkLock, AndroidRunnerApkLockTimeoutError } =
        await import('../../dist/runners/android-runner-apk-lock.js');
      const lock = join(runner, 'app/build/.qaren-apk-lock');
      try {
        await assert.rejects(
          withAndroidRunnerApkLock(lock, async () => assert.fail('forced build lost its fence'), {
            timeoutMs: 20,
          }),
          AndroidRunnerApkLockTimeoutError,
        );
      } finally {
        // The bounded fixture Node child has exited and has no descendants.
        // Retire only its fence so remaining scenarios can use the runner paths.
        rmSync(lock, { recursive: true, force: true });
      }
    },
  );

  const { withAndroidRunnerApkLock, AndroidRunnerApkLockTimeoutError } =
    await import('../../dist/runners/android-runner-apk-lock.js');

  test('ANT-597: separate worktrees provision independently', { timeout: 2_000 }, async () => {
    await withAndroidRunnerApkLock(join(root, 'worktree-a/lock'), async () => {
      const result = await withAndroidRunnerApkLock(
        join(root, 'worktree-b/lock'),
        async () => 'installed',
        { timeoutMs: 100 },
      );
      assert.equal(result, 'installed');
    });
  });

  test(
    'ANT-597: failed provisioning releases the outputs for another start',
    { timeout: 2_000 },
    async () => {
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
    },
  );

  test(
    'ANT-597: a contending process times out with the named refusal and cannot release its owner',
    { timeout: 3_000 },
    async () => {
      const lock = join(root, 'timeout/lock');
      await withAndroidRunnerApkLock(lock, async () => {
        const module = new URL('../../dist/runners/android-runner-apk-lock.js', import.meta.url)
          .href;
        const program = `import { withAndroidRunnerApkLock } from ${JSON.stringify(module)};
        try { await withAndroidRunnerApkLock(${JSON.stringify(lock)}, async () => { throw new Error('entered occupied outputs'); }, { timeoutMs: 30 }); }
        catch (error) { if (error.code !== 'ANDROID_RUNNER_APK_LOCK_TIMEOUT') throw error; console.log(error.code); }`;
        const result = await promisify(childProcess.execFile)(
          process.execPath,
          ['--input-type=module', '-e', program],
          { timeout: 1_500 },
        );
        assert.equal(result.stdout.trim(), 'ANDROID_RUNNER_APK_LOCK_TIMEOUT');
        await assert.rejects(
          withAndroidRunnerApkLock(
            lock,
            async () => assert.fail('waiter entered occupied outputs'),
            { timeoutMs: 30 },
          ),
          AndroidRunnerApkLockTimeoutError,
        );
      });
      assert.equal(
        await withAndroidRunnerApkLock(lock, async () => 'installed', { timeoutMs: 100 }),
        'installed',
      );
    },
  );

  test(
    'ANT-597: cancellation while waiting leaves the owner intact',
    { timeout: 2_000 },
    async () => {
      const lock = join(root, 'cancel-wait/lock');
      await withAndroidRunnerApkLock(lock, async () => {
        const controller = new AbortController();
        const refusal = new Error('cancelled');
        const waiting = withAndroidRunnerApkLock(
          lock,
          async () => assert.fail('cancelled waiter entered'),
          { signal: controller.signal },
        );
        controller.abort(refusal);
        await assert.rejects(waiting, (err) => err === refusal);
        await assert.rejects(
          withAndroidRunnerApkLock(lock, async () => assert.fail('owner lost'), { timeoutMs: 20 }),
          AndroidRunnerApkLockTimeoutError,
        );
      });
    },
  );

  test(
    'ANT-597: an aborted provisioning owner stays fenced until its children are proven stopped',
    { timeout: 2_000 },
    async () => {
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
        AndroidRunnerApkLockTimeoutError,
      );
    },
  );

  const { withCancellation, RunCancelledError } = await import('../../dist/domain/cancellation.js');
  for (const cancelledBy of ['caller', 'rebuild'] as const) {
    test(
      `ANT-597: ${cancelledBy} cancellation stops a waiting invalidation without deleting APKs`,
      { timeout: 2_000 },
      async () => {
        const removed: string[] = [];
        await withAndroidRunnerApkLock(join(runner, 'app/build/.qaren-apk-lock'), async () => {
          const caller = new AbortController();
          const rebuild = new AbortController();
          const reason = new RunCancelledError();
          const waiting = withCancellation(caller.signal, () =>
            client.invalidateAndroidRunnerApks((path) => removed.push(path), rebuild.signal),
          );
          const rejected = assert.rejects(waiting, (err) => err === reason);
          (cancelledBy === 'caller' ? caller : rebuild).abort(reason);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              rejected,
              new Promise<void>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('invalidation ignored cancellation')),
                  100,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
            caller.abort(reason);
            await rejected;
          }
          assert.deepEqual(removed, []);
        });
      },
    );
  }
}
