import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNED_PACKAGES } from '../../dist/runners/release-android-slot.js';

test('GH#237 OWNED_PACKAGES: exactly our two in-tree runner packages', () => {
  assert.deepEqual(OWNED_PACKAGES, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

import { releaseAndroidInteractionSlot } from '../../dist/runners/release-android-slot.js';

function baseDeps(over = {}) {
  return {
    stopOwnRunner: async () => {},
    adbForceStop: async () => {},
    resolveSerial: (deviceId) => ['-s', deviceId ?? 'emulator-5554'],
    readDaemonPid: () => null,
    isAlive: () => false,
    fileExists: () => false,
    removeFile: () => {},
    cleanupLegacy: () => true,
    now: () => 0,
    ...over,
  };
}

test('GH#237 release: order is stopOwnRunner → force-stop both pkgs → daemon', async () => {
  const order = [];
  const r = await releaseAndroidInteractionSlot(
    { deviceId: 'emulator-5554' },
    baseDeps({
      stopOwnRunner: async () => {
        order.push('stop');
      },
      adbForceStop: async (pkg) => {
        order.push(`force:${pkg}`);
      },
      readDaemonPid: () => null,
    }),
  );
  assert.deepEqual(order, [
    'stop',
    'force:dev.lykhoyda.rndevagent.androidrunner.test',
    'force:dev.lykhoyda.rndevagent.androidrunner',
  ]);
  assert.equal(r.stoppedOwnRunner, true);
  assert.deepEqual(r.forceStoppedPackages, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

test('GH#237 release: deviceId resolves to an -s serial passed to force-stop', async () => {
  const serials = [];
  const result = await releaseAndroidInteractionSlot(
    { deviceId: 'emulator-5554' },
    baseDeps({
      resolveSerial: (id) => (id ? ['-s', id] : []),
      adbForceStop: async (_pkg, serial) => {
        serials.push(serial.join(' '));
      },
    }),
  );
  assert.equal(result.deviceId, 'emulator-5554');
  assert.deepEqual(serials, ['-s emulator-5554', '-s emulator-5554']);
});

test('GH#237 release: cleanupLegacy()=false skips daemon cleanup but still does steps 1+2', async () => {
  const order = [];
  const r = await releaseAndroidInteractionSlot(
    {},
    baseDeps({
      cleanupLegacy: () => false,
      stopOwnRunner: async () => order.push('stop'),
      adbForceStop: async () => order.push('force'),
      readDaemonPid: () => {
        throw new Error('daemon must not be read when cleanupLegacy=false');
      },
    }),
  );
  assert.deepEqual(order, ['stop', 'force', 'force']);
  assert.equal(r.killedDaemonPids.length, 0);
});

test('GH#237 release: removes orphaned daemon files when the daemon PID is dead', async () => {
  const removed = [];
  const r = await releaseAndroidInteractionSlot(
    {},
    baseDeps({
      readDaemonPid: () => 4242,
      isAlive: () => false,
      fileExists: () => true,
      removeFile: (p) => removed.push(p),
    }),
  );
  assert.equal(removed.length, 2);
  assert.equal(r.removedFiles.length, 2);
});

test('GH#237 release: never throws when stopOwnRunner fails (idempotent/best-effort)', async () => {
  const r = await releaseAndroidInteractionSlot(
    {},
    baseDeps({
      stopOwnRunner: async () => {
        throw new Error('runner already stopped');
      },
    }),
  );
  assert.equal(r.stoppedOwnRunner, false);
  assert.ok(r.warnings.some((w) => /stopping the Android runner failed/.test(w)));
});

test('GH#653 release: multi-target/no-exact refusal is actionable and non-mutating', async () => {
  const mutations = [];
  await assert.rejects(
    releaseAndroidInteractionSlot(
      {},
      baseDeps({
        resolveSerial: () => [],
        stopOwnRunner: async () => mutations.push('stop-runner'),
        adbForceStop: async () => mutations.push('force-stop'),
        readDaemonPid: () => {
          mutations.push('read-daemon');
          return 777;
        },
        kill: () => mutations.push('kill-daemon'),
        removeFile: () => mutations.push('remove-file'),
      }),
    ),
    /without an exact serial.*No device was mutated/s,
  );
  assert.deepEqual(mutations, []);
});

test('GH#653 release: exact cleanup is serial- and owned-package-scoped', async () => {
  const calls = [];
  await releaseAndroidInteractionSlot(
    { deviceId: 'emulator-5580', includeLegacy: false },
    baseDeps({
      stopOwnRunner: async (deviceId) => calls.push(['stop', deviceId]),
      adbForceStop: async (pkg, serial) => calls.push(['force-stop', serial, pkg]),
      readDaemonPid: () => assert.fail('legacy or foreign process cleanup is forbidden'),
    }),
  );
  assert.deepEqual(calls, [
    ['stop', 'emulator-5580'],
    ['force-stop', ['-s', 'emulator-5580'], 'dev.lykhoyda.rndevagent.androidrunner.test'],
    ['force-stop', ['-s', 'emulator-5580'], 'dev.lykhoyda.rndevagent.androidrunner'],
  ]);
});

test('GH#237 release: abort fences later destructive cleanup steps', async () => {
  const controller = new AbortController();
  const order = [];
  await assert.rejects(
    releaseAndroidInteractionSlot(
      { deviceId: 'emulator-5554', includeLegacy: false, signal: controller.signal },
      baseDeps({
        stopOwnRunner: async () => {
          order.push('stop');
          controller.abort(new Error('authority lost'));
        },
        adbForceStop: async () => {
          order.push('force-stop');
        },
      }),
    ),
    /authority lost/,
  );
  assert.deepEqual(order, ['stop']);
});
