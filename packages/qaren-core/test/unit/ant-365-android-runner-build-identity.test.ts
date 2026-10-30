import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'qaren-android-identity-'));
const runner = join(root, 'qaren-android-runner');
const appApk = join(runner, 'app/build/outputs/apk/debug/app-debug.apk');
const testApk = join(runner, 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
mkdirSync(dirname(appApk), { recursive: true });
mkdirSync(dirname(testApk), { recursive: true });
writeFileSync(join(runner, 'gradlew'), '');
const previousRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
process.env.QAREN_NATIVE_RUNNER_ROOT = root;
const { startAndroidRunner, _setAndroidRunnerStateForTest } =
  await import('../../dist/runners/qaren-android-runner-client.js');
if (previousRoot === undefined) delete process.env.QAREN_NATIVE_RUNNER_ROOT;
else process.env.QAREN_NATIVE_RUNNER_ROOT = previousRoot;

const MAIN = 'dev.lykhoyda.rndevagent.androidrunner';
const TEST = `${MAIN}.test`;
const expectedApp = Buffer.from('current app APK, versionCode=1 versionName=0.1.0');
const expectedTest = Buffer.from('current test APK, versionCode=0 versionName=null');
const oldApp = Buffer.from('older app APK, versionCode=1 versionName=0.1.0');
const oldTest = Buffer.from('older test APK, versionCode=0 versionName=null');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test.after(() => rmSync(root, { recursive: true, force: true }));

async function selectRunner(
  t: TestContext,
  installed: Map<string, Buffer>,
  opts: { apksAbsent?: boolean; oldOutputs?: boolean; unreadable?: boolean; paths?: string } = {},
) {
  if (opts.apksAbsent) {
    rmSync(appApk, { force: true });
    rmSync(testApk, { force: true });
  } else {
    writeFileSync(appApk, opts.oldOutputs ? oldApp : expectedApp);
    writeFileSync(testApk, opts.oldOutputs ? oldTest : expectedTest);
  }
  const effects = { installs: 0, builds: 0, hashReads: 0 };
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
      if (file === join(runner, 'gradlew')) {
        effects.builds++;
        writeFileSync(appApk, expectedApp);
        writeFileSync(testApk, expectedTest);
        return { stdout: '', stderr: '' };
      }
      assert.equal(file, 'adb');
      assert.deepEqual(args.slice(0, 2), ['-s', 'identity-fixture']);
      const command = args.slice(2);
      let stdout = '';
      if (command[0] === 'get-state') stdout = 'device\n';
      else if (command.join(' ') === 'shell pm list instrumentation') {
        if (installed.has(TEST)) {
          stdout = `instrumentation:${TEST}/androidx.test.runner.AndroidJUnitRunner (target=${MAIN})\n`;
        }
      } else if (command.slice(0, 3).join(' ') === 'shell pm path') {
        stdout = opts.paths ?? `package:/data/app/${command[3]}/base.apk\n`;
      } else if (command.slice(0, 2).join(' ') === 'shell sha256sum') {
        effects.hashReads++;
        if (opts.unreadable) throw new Error('installed APK cannot be read');
        const packageName = command[2].split('/')[3];
        stdout = `${digest(installed.get(packageName)!)}  ${command[2]}\n`;
      } else if (command[0] === 'install') {
        effects.installs++;
        const apk = command[2];
        installed.set(apk === appApk ? MAIN : TEST, readFileSync(apk));
        stdout = 'Success\n';
      } else assert.equal(command[0], 'forward');
      return { stdout, stderr: '' };
    },
  });
  childProcess.execFile = execute;
  t.mock.method(childProcess, 'spawn', () => {
    throw new Error('selection complete');
  });
  syncBuiltinESMExports();

  // Stop at instrumentation launch: this test exercises selection and real APK
  // files without a device, health response, or launch-supplied runner version.
  await assert.rejects(
    startAndroidRunner('identity-fixture', 'com.example', 0),
    /selection complete/,
  );
  return effects;
}

test('ANT-365: start replaces a registered older runner pair even when package versions match', async (t) => {
  const installed = new Map([
    [MAIN, oldApp],
    [TEST, oldTest],
  ]);
  await selectRunner(t, installed);
  assert.deepEqual(installed.get(MAIN), expectedApp, 'the older main APK must be replaced');
  assert.deepEqual(installed.get(TEST), expectedTest, 'the older test APK must be replaced');
});

test('ANT-365: a matching installed build is reused without reinstall', async (t) => {
  const installed = new Map([
    [MAIN, expectedApp],
    [TEST, expectedTest],
  ]);
  const effects = await selectRunner(t, installed);
  assert.equal(effects.installs, 0);
});

test('ANT-365: an absent runner builds and installs both APKs', async (t) => {
  const installed = new Map<string, Buffer>();
  const effects = await selectRunner(t, installed, { apksAbsent: true });
  assert.equal(effects.builds, 1);
  assert.deepEqual(installed.get(MAIN), expectedApp);
  assert.deepEqual(installed.get(TEST), expectedTest);
});

test('ANT-365: source changes refresh older local outputs before comparing installed bytes', async (t) => {
  const installed = new Map([
    [MAIN, oldApp],
    [TEST, oldTest],
  ]);
  await selectRunner(t, installed, { oldOutputs: true });
  assert.deepEqual(installed.get(MAIN), expectedApp);
  assert.deepEqual(installed.get(TEST), expectedTest);
});

for (const stalePackage of [MAIN, TEST]) {
  test(`ANT-365: a mismatch in ${stalePackage} replaces the pair`, async (t) => {
    const installed = new Map([
      [MAIN, expectedApp],
      [TEST, expectedTest],
    ]);
    installed.set(stalePackage, stalePackage === MAIN ? oldApp : oldTest);
    const effects = await selectRunner(t, installed);
    assert.equal(effects.installs, 2);
    assert.deepEqual(installed.get(MAIN), expectedApp);
    assert.deepEqual(installed.get(TEST), expectedTest);
  });
}

test('ANT-365: unreadable installed bytes cannot authorize reuse', async (t) => {
  const installed = new Map([
    [MAIN, expectedApp],
    [TEST, expectedTest],
  ]);
  const effects = await selectRunner(t, installed, { unreadable: true });
  assert.equal(effects.installs, 2);
});

for (const paths of [
  '',
  'package:/data/app/main/base.apk\npackage:/data/app/main/split.apk\n',
  'package:/data/app/main/../base.apk\n',
  'package:/data/app/main/$(unexpected)/base.apk\n',
]) {
  test(`ANT-365: unprovable APK path ${JSON.stringify(paths)} never runs a remote hash command`, async (t) => {
    const installed = new Map([
      [MAIN, expectedApp],
      [TEST, expectedTest],
    ]);
    const effects = await selectRunner(t, installed, { paths });
    assert.equal(effects.hashReads, 0);
    assert.equal(effects.installs, 2);
  });
}
