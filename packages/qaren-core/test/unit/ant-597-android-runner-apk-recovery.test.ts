import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.QAREN_APK_RECOVERY_TEST_CHILD) {
  test(
    'ANT-597: provisioning recovery is hermetic without Android tooling',
    { timeout: 15_000 },
    async () => {
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
  const root = process.env.QAREN_APK_RECOVERY_TEST_CHILD;
  const moduleUrl =
    process.env.QAREN_APK_RECOVERY_LOCK_MODULE ??
    new URL('../../dist/runners/android-runner-apk-lock.js', import.meta.url).href;
  const { withAndroidRunnerApkLock } = await import(moduleUrl);
  const { probeProcessBirth } = await import('../../dist/lifecycle/process-birth.js');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(
      `ANT-597: ${signal} stops provisioning children and permits the follow-up start`,
      { timeout: 3_000 },
      async (t) => {
        const lock = join(root, signal, 'lock');
        const program = `
        import { spawn } from 'node:child_process';
        import { withAndroidRunnerApkLock } from ${JSON.stringify(moduleUrl)};
        const controller = new AbortController();
        const keepAlive = setInterval(() => {}, 1000);
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort(new Error('cancelled')));
        try {
          await withAndroidRunnerApkLock(${JSON.stringify(lock)}, async () => {
            const writer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
            await new Promise((resolve, reject) => {
              writer.once('spawn', () => { writer.unref(); process.send({ writer: writer.pid }); });
              controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
            });
          }, { signal: controller.signal });
        } catch (error) { if (error.message !== 'cancelled') throw error; }
        clearInterval(keepAlive); process.disconnect();
      `;
        const owner = spawn(process.execPath, ['--input-type=module', '-e', program], {
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        assert.ok(owner.pid);
        t.after(() => {
          try {
            process.kill(-owner.pid!, 'SIGKILL');
          } catch {}
        });
        let stderr = '';
        owner.stderr!.on('data', (chunk) => {
          stderr += chunk;
        });
        const exited = new Promise<void>((resolve, reject) => {
          owner.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`owner exit ${code}: ${stderr}`)),
          );
          owner.once('error', reject);
        });
        const { writer } = await new Promise<{ writer: number }>((resolve) =>
          owner.once('message', resolve),
        );
        owner.kill(signal);
        await exited;
        assert.equal(
          probeProcessBirth(writer).status,
          'absent',
          'cancelled provisioning left a writer alive',
        );
        assert.equal(
          await withAndroidRunnerApkLock(lock, async () => 'installed', { timeoutMs: 50 }),
          'installed',
        );
      },
    );
  }
  function heldOwner(lock: string) {
    const program = `
      import { withAndroidRunnerApkLock } from ${JSON.stringify(moduleUrl)};
      const keepAlive = setInterval(() => {}, 1000);
      await withAndroidRunnerApkLock(${JSON.stringify(lock)}, async () => {
        process.send({ ready: true });
        await new Promise((resolve) => process.once('message', resolve));
      });
      clearInterval(keepAlive); process.disconnect();
    `;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', program], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = new Promise<void>((resolve, reject) => {
      owner.once('message', () => resolve());
      owner.once('error', reject);
      owner.once('exit', () => reject(new Error('owner exited before readiness')));
    });
    const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    return { owner, ready, exited };
  }

  test(
    'ANT-597: a SIGKILL owner is reclaimed immediately after its writer group is gone',
    { timeout: 2_000 },
    async (t) => {
      const lock = join(root, 'crash', 'lock');
      const { owner, ready, exited } = heldOwner(lock);
      t.after(() => {
        try {
          process.kill(-owner.pid!, 'SIGKILL');
        } catch {}
      });
      await ready;
      owner.kill('SIGKILL');
      await exited;
      assert.equal(
        await withAndroidRunnerApkLock(lock, async () => 'installed', { timeoutMs: 50 }),
        'installed',
      );
    },
  );

  test(
    'ANT-597: live-owner overlap waits with owner/path progress and both starts succeed',
    { timeout: 2_000 },
    async (t) => {
      const lock = join(root, 'overlap', 'lock');
      const { owner, ready, exited } = heldOwner(lock);
      t.after(() => {
        try {
          process.kill(-owner.pid!, 'SIGKILL');
        } catch {}
      });
      await ready;
      let announced!: () => void;
      const announcement = new Promise<void>((resolve) => {
        announced = resolve;
      });
      const messages: string[] = [];
      const next = withAndroidRunnerApkLock(lock, async () => 'installed', {
        timeoutMs: 500,
        onWait: (message: string) => {
          messages.push(message);
          announced();
        },
      });
      next.catch(() => {});
      await Promise.race([
        announcement,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('live contention provided no progress')),
            300,
          );
          timer.unref();
        }),
      ]);
      assert.ok(messages[0].includes(lock));
      assert.ok(messages[0].includes(`pid=${owner.pid}`));
      owner.send('build/hash/install complete');
      assert.equal(await next, 'installed');
      await exited;
    },
  );

  test(
    'ANT-597: the live-owner backstop refuses with the fence, owner and recovery steps',
    { timeout: 2_000 },
    async (t) => {
      const lock = join(root, 'hung-owner', 'lock');
      const { owner, ready, exited } = heldOwner(lock);
      t.after(() => {
        try {
          process.kill(-owner.pid!, 'SIGKILL');
        } catch {}
      });
      await ready;
      try {
        await assert.rejects(
          withAndroidRunnerApkLock(lock, async () => assert.fail('hung owner bypassed'), {
            timeoutMs: 30,
            onWait: () => {},
          }),
          (error: Error & { code: string }) => {
            assert.equal(error.code, 'ANDROID_RUNNER_APK_LOCK_TIMEOUT');
            assert.ok(error.message.includes(lock));
            assert.ok(error.message.includes(`pid=${owner.pid}`));
            assert.match(error.message, /Verify.*identity.*process group/);
            assert.match(error.message, /keep the fence/);
            return true;
          },
        );
      } finally {
        owner.send('complete');
        await exited;
      }
      assert.equal(
        await withAndroidRunnerApkLock(lock, async () => 'installed', { timeoutMs: 50 }),
        'installed',
      );
    },
  );

  test(
    'ANT-597: unprovable owner liveness refuses immediately with actionable owner/path evidence',
    { timeout: 2_000 },
    async (t) => {
      const lock = join(root, 'unknown', 'lock');
      const { owner, ready, exited } = heldOwner(lock);
      t.after(() => {
        try {
          process.kill(-owner.pid!, 'SIGKILL');
        } catch {}
      });
      await ready;
      const originalRead = fs.readFileSync;
      const originalExec = childProcess.execFileSync;
      t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
        if (String(args[0]) === `/proc/${owner.pid}/stat`)
          throw Object.assign(new Error('identity unreadable'), { code: 'EACCES' });
        return Reflect.apply(originalRead, fs, args);
      });
      t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof originalExec>) => {
        if (args[0] === '/bin/ps' && Array.isArray(args[1]) && args[1].includes(String(owner.pid)))
          throw new Error('identity unreadable');
        return Reflect.apply(originalExec, childProcess, args);
      });
      syncBuiltinESMExports();
      try {
        const started = performance.now();
        await assert.rejects(
          withAndroidRunnerApkLock(lock, async () => assert.fail('unknown owner bypassed'), {
            timeoutMs: 100,
          }),
          (error: Error & { code: string }) => {
            assert.equal(error.code, 'ANDROID_RUNNER_APK_LOCK_UNPROVEN');
            assert.ok(error.message.includes(lock));
            assert.ok(error.message.includes(`pid=${owner.pid}`));
            assert.match(error.message, /Verify.*identity.*process group/);
            assert.match(error.message, /keep the fence/);
            return true;
          },
        );
        assert.ok(performance.now() - started < 500, 'unknown liveness waited instead of refusing');
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        owner.send('complete');
        await exited;
      }
    },
  );

  async function waitForWriterStop(pid: number) {
    const deadline = performance.now() + 500;
    while (probeProcessBirth(pid).status !== 'absent') {
      assert.ok(performance.now() < deadline, 'fixture writer failed to exit');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  for (const orphan of [false, true]) {
    test(
      `ANT-597: SIGKILL mid-provisioning ${orphan ? 'refuses a surviving writer before reclaim' : 'permits a follow-up after writer shutdown'}`,
      { timeout: 2_000 },
      async (t) => {
        const lock = join(root, `crash-writer-${orphan}`, 'lock');
        const writerProgram = orphan
          ? "process.stdout.write('ready'); setInterval(() => {}, 1000)"
          : "process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); process.stdout.write('ready')";
        const program = `
        import { spawn } from 'node:child_process';
        import { withAndroidRunnerApkLock } from ${JSON.stringify(moduleUrl)};
        const keepAlive = setInterval(() => {}, 1000);
        await withAndroidRunnerApkLock(${JSON.stringify(lock)}, async () => {
          const writer = spawn(process.execPath, ['-e', ${JSON.stringify(writerProgram)}], { stdio: ['pipe', 'pipe', 'ignore'] });
          writer.stdout.once('data', () => process.send({ writer: writer.pid }));
          await new Promise(() => {});
        });
      `;
        const owner = spawn(process.execPath, ['--input-type=module', '-e', program], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        t.after(() => {
          try {
            process.kill(-owner.pid!, 'SIGKILL');
          } catch {}
        });
        const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
        const { writer } = await new Promise<{ writer: number }>((resolve) =>
          owner.once('message', resolve),
        );
        owner.kill('SIGKILL');
        await exited;
        if (orphan) {
          await assert.rejects(
            withAndroidRunnerApkLock(lock, async () => assert.fail('orphan writer bypassed'), {
              timeoutMs: 100,
            }),
            (error: Error & { code: string }) => {
              assert.equal(error.code, 'ANDROID_RUNNER_APK_LOCK_UNPROVEN');
              assert.ok(error.message.includes(lock));
              assert.ok(error.message.includes(`group=${owner.pid}`));
              return true;
            },
          );
          process.kill(-owner.pid!, 'SIGKILL');
        }
        await waitForWriterStop(writer);
        assert.equal(
          await withAndroidRunnerApkLock(lock, async () => 'installed', { timeoutMs: 50 }),
          'installed',
        );
      },
    );
  }

  test(
    'ANT-597: pid reuse cannot authorize reclaim while the recorded group remains live',
    { timeout: 2_000 },
    async (t) => {
      const lock = join(root, 'pid-reuse', 'lock');
      const { owner, ready, exited } = heldOwner(lock);
      t.after(() => {
        try {
          process.kill(-owner.pid!, 'SIGKILL');
        } catch {}
      });
      await ready;
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(lock);
      const original = database.prepare('SELECT owner FROM android_apk_owner WHERE slot = 1').get()!
        .owner as string;
      const reused = JSON.parse(original);
      reused.birth.token = '0'.repeat(64);
      database
        .prepare('UPDATE android_apk_owner SET owner = ? WHERE slot = 1')
        .run(JSON.stringify(reused));
      try {
        await assert.rejects(
          withAndroidRunnerApkLock(lock, async () => assert.fail('reused pid bypassed'), {
            timeoutMs: 50,
          }),
          (error: Error & { code: string }) => error.code === 'ANDROID_RUNNER_APK_LOCK_UNPROVEN',
        );
      } finally {
        database.prepare('UPDATE android_apk_owner SET owner = ? WHERE slot = 1').run(original);
        database.close();
        owner.send('complete');
        await exited;
      }
    },
  );
}
