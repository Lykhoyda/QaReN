import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apkLockSystem, barrier } from '../helpers/android-apk-lock-system.ts';

if (!process.env.QAREN_APK_RECOVERY_TEST_CHILD) {
  test('ANT-597: provisioning recovery is hermetic without Android tooling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qaren-apk-recovery-'));
    const home = join(root, 'home');
    mkdirSync(home);
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ['--test', fileURLToPath(import.meta.url)],
        {
          env: {
            HOME: home,
            PATH: '',
            CI: 'true',
            QAREN_APK_RECOVERY_TEST_CHILD: root,
            QAREN_APK_RECOVERY_LOCK_MODULE: process.env.QAREN_APK_RECOVERY_LOCK_MODULE,
          },
          timeout: 5 * 60_000,
        },
      );
      assert.match(result.stdout, /tests 9/);
      assert.match(result.stdout, /fail 0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
} else {
  const root = process.env.QAREN_APK_RECOVERY_TEST_CHILD;
  const moduleUrl =
    process.env.QAREN_APK_RECOVERY_LOCK_MODULE ??
    new URL('../../dist/runners/android-runner-apk-lock.js', import.meta.url).href;
  const { withAndroidRunnerApkLock } = await import(moduleUrl);
  const { probeProcessBirth } = await import('../../dist/lifecycle/process-birth.js');
  const { openAuthorityStore } = await import('../../dist/util/sqlite-store.js');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`ANT-597: ${signal} cancellation stops provisioning children and permits the follow-up start`, async (t) => {
      const system = apkLockSystem(t);
      const lock = join(root, signal, 'lock');
      const writer = process.pid + 1;
      const peer = process.pid + 2;
      system.addProcess(writer, process.pid);
      system.addProcess(peer);
      const controller = new AbortController();
      const reason = new Error(`cancelled by ${signal}`);
      const operation = withAndroidRunnerApkLock(
        lock,
        async () => {
          controller.abort(reason);
          throw reason;
        },
        { signal: controller.signal },
      );
      const rejected = assert.rejects(operation, (error) => error === reason);
      await Promise.resolve();
      assert.deepEqual(system.signals, [{ pid: writer, signal: 'SIGKILL' }]);
      assert.ok(system.processes.has(peer), 'cleanup signaled a foreign group');
      system.advance(25);
      await rejected;
      assert.equal(
        probeProcessBirth(writer).status,
        'absent',
        'cancelled provisioning left a writer alive',
      );
      assert.equal(await withAndroidRunnerApkLock(lock, async () => 'installed'), 'installed');
    });
  }
  function heldOwner(lock: string, system: ReturnType<typeof apkLockSystem>) {
    const pid = process.pid + 10;
    system.addProcess(pid);
    const observed = probeProcessBirth(pid);
    assert.equal(observed.status, 'present');
    assert.ok('birth' in observed);
    const owner = { nonce: 'fixture-owner', birth: observed.birth, pgid: pid, retained: false };
    const store = openAuthorityStore(lock);
    try {
      store.database.exec(
        'CREATE TABLE android_apk_owner (slot INTEGER PRIMARY KEY CHECK(slot = 1), owner TEXT NOT NULL)',
      );
      store.database
        .prepare('INSERT INTO android_apk_owner VALUES (1, ?)')
        .run(JSON.stringify(owner));
    } finally {
      store.close();
    }
    return {
      ...owner,
      release: () => {
        const store = openAuthorityStore(lock);
        try {
          store.database
            .prepare('DELETE FROM android_apk_owner WHERE owner = ?')
            .run(JSON.stringify(owner));
        } finally {
          store.close();
        }
      },
      assertIntact: () => {
        const store = openAuthorityStore(lock);
        try {
          assert.equal(
            store.database.prepare('SELECT owner FROM android_apk_owner').get()?.owner,
            JSON.stringify(owner),
          );
        } finally {
          store.close();
        }
      },
    };
  }

  test('ANT-597: a killed owner is reclaimed immediately after its writer group is gone', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'crash', 'lock');
    const owner = heldOwner(lock, system);
    system.processes.delete(owner.birth.pid);
    assert.equal(await withAndroidRunnerApkLock(lock, async () => 'installed'), 'installed');
    assert.equal(system.sleepCalls, 0, 'dead owner was waited on instead of reclaimed');
    assert.deepEqual(system.signals, []);
  });

  test('ANT-597: live-owner overlap waits with owner/path progress and both starts succeed', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'overlap', 'lock');
    const ready = barrier();
    const release = barrier();
    const first = withAndroidRunnerApkLock(lock, async () => {
      ready.resolve();
      await release.promise;
      return 'first installed';
    });
    await ready.promise;
    const messages: string[] = [];
    let entered = false;
    const next = withAndroidRunnerApkLock(
      lock,
      async () => {
        entered = true;
        return 'second installed';
      },
      { onWait: (message: string) => messages.push(message) },
    );
    assert.equal(await system.nextSleep(next), 25);
    assert.equal(entered, false, 'waiter bypassed the live owner');
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes(lock));
    assert.ok(messages[0].includes(`pid=${process.pid}`));
    release.resolve();
    assert.equal(await first, 'first installed');
    system.advance(25);
    assert.equal(await next, 'second installed');
    assert.deepEqual(system.signals, []);
  });

  test('ANT-597: the live-owner backstop refuses with the fence, owner and recovery steps', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'hung-owner', 'lock');
    const owner = heldOwner(lock, system);
    const waiting = withAndroidRunnerApkLock(lock, async () => assert.fail('hung owner bypassed'), {
      timeoutMs: 30,
      onWait: () => {},
    });
    const rejected = assert.rejects(waiting, (error: Error & { code: string }) => {
      assert.equal(error.code, 'ANDROID_RUNNER_APK_LOCK_TIMEOUT');
      assert.ok(error.message.includes(lock));
      assert.ok(error.message.includes(`pid=${owner.birth.pid}`));
      assert.match(error.message, /Verify.*identity.*process group/);
      assert.match(error.message, /keep the fence/);
      return true;
    });
    assert.equal(await system.nextSleep(waiting), 25);
    system.advance(25);
    assert.equal(await system.nextSleep(waiting), 5);
    system.advance(5);
    await system.withoutSleeping(rejected);
    owner.assertIntact();
    assert.deepEqual(system.signals, []);
    owner.release();
    assert.equal(await withAndroidRunnerApkLock(lock, async () => 'installed'), 'installed');
  });

  test('ANT-597: unprovable owner liveness refuses immediately with actionable owner/path evidence', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'unknown', 'lock');
    const owner = heldOwner(lock, system);
    system.processes.get(owner.birth.pid)!.unknown = true;
    await assert.rejects(
      withAndroidRunnerApkLock(lock, async () => assert.fail('unknown owner bypassed'), {
        timeoutMs: 100,
        onWait: () => assert.fail('unknown liveness announced a wait'),
      }),
      (error: Error & { code: string }) => {
        assert.equal(error.code, 'ANDROID_RUNNER_APK_LOCK_UNPROVEN');
        assert.ok(error.message.includes(lock));
        assert.ok(error.message.includes(`pid=${owner.birth.pid}`));
        assert.match(error.message, /Verify.*identity.*process group/);
        assert.match(error.message, /keep the fence/);
        return true;
      },
    );
    assert.equal(system.sleepCalls, 0, 'unknown liveness waited instead of refusing');
    assert.equal(performance.now(), 0);
    owner.assertIntact();
    assert.deepEqual(system.signals, []);
  });

  for (const orphan of [false, true]) {
    test(`ANT-597: killed owner mid-provisioning ${orphan ? 'refuses a surviving writer before reclaim' : 'permits a follow-up after writer shutdown'}`, async (t) => {
      const system = apkLockSystem(t);
      const lock = join(root, `crash-writer-${orphan}`, 'lock');
      const owner = heldOwner(lock, system);
      const writer = owner.birth.pid + 1;
      system.addProcess(writer, owner.pgid);
      system.processes.delete(owner.birth.pid);
      if (orphan) {
        await assert.rejects(
          withAndroidRunnerApkLock(lock, async () => assert.fail('orphan writer bypassed')),
          (error: Error & { code: string }) => {
            assert.equal(error.code, 'ANDROID_RUNNER_APK_LOCK_UNPROVEN');
            assert.ok(error.message.includes(lock));
            assert.ok(error.message.includes(`group=${owner.pgid}`));
            return true;
          },
        );
        owner.assertIntact();
        assert.equal(system.sleepCalls, 0);
        assert.deepEqual(system.signals, []);
      }
      system.processes.delete(writer);
      assert.equal(await withAndroidRunnerApkLock(lock, async () => 'installed'), 'installed');
      assert.equal(system.sleepCalls, 0);
    });
  }

  test('ANT-597: pid reuse cannot authorize reclaim while the recorded group remains live', async (t) => {
    const system = apkLockSystem(t);
    const lock = join(root, 'pid-reuse', 'lock');
    const owner = heldOwner(lock, system);
    system.addProcess(owner.birth.pid);
    await assert.rejects(
      withAndroidRunnerApkLock(lock, async () => assert.fail('reused pid bypassed')),
      (error: Error & { code: string }) => error.code === 'ANDROID_RUNNER_APK_LOCK_UNPROVEN',
    );
    owner.assertIntact();
    assert.equal(system.sleepCalls, 0);
    assert.deepEqual(system.signals, []);
    system.processes.delete(owner.birth.pid);
    assert.equal(await withAndroidRunnerApkLock(lock, async () => 'installed'), 'installed');
  });
}
