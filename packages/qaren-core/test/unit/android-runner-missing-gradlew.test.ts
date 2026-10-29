import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'qaren-android-missing-gradlew-'));
const runner = join(root, 'qaren-android-runner');
mkdirSync(runner);
const previousNativeRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
const previousRoot = process.env.QAREN_ROOT;
process.env.QAREN_NATIVE_RUNNER_ROOT = root;
delete process.env.QAREN_ROOT;
const { startAndroidRunner, _setAndroidRunnerStateForTest } =
  await import('../../dist/runners/qaren-android-runner-client.js');

test.after(() => {
  if (previousNativeRoot === undefined) delete process.env.QAREN_NATIVE_RUNNER_ROOT;
  else process.env.QAREN_NATIVE_RUNNER_ROOT = previousNativeRoot;
  if (previousRoot === undefined) delete process.env.QAREN_ROOT;
  else process.env.QAREN_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

async function startWithoutGradlew(t: TestContext): Promise<{ error: Error; commands: string[] }> {
  const commands: string[] = [];
  const originalLease = process.env.QAREN_DEVICE_LEASE;
  const originalExecFile = childProcess.execFile;
  process.env.QAREN_DEVICE_LEASE = 'test-check:0123456789abcdef';
  _setAndroidRunnerStateForTest(null);
  t.after(() => {
    if (originalLease === undefined) delete process.env.QAREN_DEVICE_LEASE;
    else process.env.QAREN_DEVICE_LEASE = originalLease;
    t.mock.restoreAll();
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    _setAndroidRunnerStateForTest(null);
  });
  const execute = (() => {
    throw new Error('use the promisified subprocess boundary');
  }) as typeof childProcess.execFile;
  Object.defineProperty(execute, promisify.custom, {
    configurable: true,
    value: async (file: string, args: string[]) => {
      commands.push([file, ...args].join(' '));
      return { stdout: args.includes('get-state') ? 'device\n' : '', stderr: '' };
    },
  });
  childProcess.execFile = execute;
  t.mock.method(childProcess, 'spawn', () => {
    throw new Error('instrumentation must not start');
  });
  syncBuiltinESMExports();

  let error: Error | undefined;
  await startAndroidRunner('missing-gradlew-fixture', 'com.example', 0).catch((err: Error) => {
    error = err;
  });
  assert.ok(error, 'start must refuse a runner directory without gradlew');
  return { error, commands };
}

test('a runner directory without gradlew refuses before any build, install or lock', async (t) => {
  const { error, commands } = await startWithoutGradlew(t);
  assert.equal(error.message, `Android runner not found at ${runner} (no gradlew).`);
  assert.deepEqual(commands, ['adb -s missing-gradlew-fixture get-state']);
  assert.equal(existsSync(join(runner, 'app', 'build')), false);
});

test('the missing-gradlew refusal names an existing pre-2.0.4 runner directory', async (t) => {
  const legacy = join(root, 'rn-android-runner');
  mkdirSync(join(legacy, 'app'), { recursive: true });
  const { error } = await startWithoutGradlew(t);
  assert.equal(
    error.message,
    `Android runner not found at ${runner} (no gradlew). found pre-2.0.4 runner directory ${legacy}; this version cannot use it: install the current runner (qaren update, or a fresh source checkout) or unset QAREN_NATIVE_RUNNER_ROOT/QAREN_ROOT`,
  );
});
