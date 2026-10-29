import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const root = mkdtempSync(join(process.cwd(), '.retained-ios-driver-'));
const savedEnv = { ...process.env };
process.env.QAREN_NATIVE_RUNNER_ROOT = root;
process.env.QAREN_HOME = join(root, 'home');
process.env.QAREN_DEVICE_LEASE = `retained-driver:${'f'.repeat(32)}`;
const runnerRoot = join(root, 'qaren-ios-runner');
mkdirSync(join(runnerRoot, 'QarenIosRunner', 'QarenIosRunner.xcodeproj'), { recursive: true });
const products = join(runnerRoot, 'build', 'DerivedData', 'Build', 'Products');
mkdirSync(products, { recursive: true });
writeFileSync(join(products, 'fixture.xctestrun'), '');

const runner = await import('../../dist/runners/qaren-ios-runner-client.js');
const stateFiles = await import('../../dist/util/secure-state-file.js');
const device = '00000000-0000-0000-0000-000000000001';
const otherDevice = '00000000-0000-0000-0000-000000000002';

function failedDriver(pid: number) {
  const signals: (string | undefined)[] = [];
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill(signal?: string) {
      signals.push(signal);
      return true;
    },
    signals,
  });
}

function preventLegacyAdoption() {
  stateFiles.writeJsonStateFileAtomic(runner.iosStatePath(device), {});
}

test.after(() => {
  runner._setFastRunnerStateForTest(null);
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

test('a surviving failed launch blocks relaunch, adoption and cleanup until exit', async (t) => {
  const children: ReturnType<typeof failedDriver>[] = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    assert.equal(command, 'xcodebuild');
    assert.equal(args[0], 'test-without-building');
    const child = failedDriver(1_000_000_000 + children.length);
    children.push(child);
    queueMicrotask(() => child.stdout.write('RN_FAST_RUNNER_LISTENER_FAILED\n'));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  preventLegacyAdoption();
  const launch = (target = device) =>
    runner.startFastRunner(target, 'com.example.fixture', undefined, { forceLocalBuild: true });
  await assert.rejects(launch(), /LISTENER_FAILED/);
  const generation = runner.getRunnerLaunchCount();
  const child = children[0];
  assert.equal(await runner.awaitSpawnedRunnerExit(1, generation), false);
  assert.equal(await runner.awaitSpawnedRunnerExit(1, generation + 1), false);
  assert.deepEqual(child.signals, ['SIGINT']);

  const binding = {
    schemaVersion: 1,
    pid: process.pid,
    port: 12345,
    deviceId: device,
    bundleId: 'com.example.fixture',
    processBirth: 'fixture-birth',
    instanceId: 'fixture-instance',
  };
  stateFiles.writeJsonStateFileAtomic(runner.iosStatePath(device), binding);
  runner.adoptPersistedFastRunnerState(device);
  assert.equal(runner.getFastRunnerState(), null);
  const ownedBinding = { ...binding, pid: child.pid };
  stateFiles.writeJsonStateFileAtomic(runner.iosStatePath(device), ownedBinding);
  assert.throws(
    () => runner.clearFastRunnerAfterVerifiedStop(ownedBinding),
    /previous iOS runner driver has not exited/,
  );
  assert.deepEqual(stateFiles.readJsonStateFile(runner.iosStatePath(device)), ownedBinding);
  await assert.rejects(launch(), /previous iOS runner driver has not exited/);
  await assert.rejects(launch(otherDevice), /previous iOS runner driver has not exited/);
  await assert.rejects(runner.stopFastRunner(otherDevice), /belongs to another device/);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = runner.stopFastRunner(device);
  const stopped = assert.rejects(stopping, /initialization has not settled/);
  t.mock.timers.tick(30_000);
  await stopped;
  t.mock.timers.reset();
  child.emit('error', new Error('driver error without exit'));
  await assert.rejects(launch(), /previous iOS runner driver has not exited/);
  assert.equal(children.length, 1);
  assert.equal(runner.getRunnerLaunchCount(), generation);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGINT']);

  child.exitCode = 1;
  child.emit('exit', 1, null);
  assert.equal(await runner.awaitSpawnedRunnerExit(1, generation), true);
  preventLegacyAdoption();
  await assert.rejects(launch(), /LISTENER_FAILED/);
  assert.equal(children.length, 2);
  assert.equal(runner.getRunnerLaunchCount(), generation + 1);
  children[1].exitCode = 1;
  children[1].emit('exit', 1, null);
});
