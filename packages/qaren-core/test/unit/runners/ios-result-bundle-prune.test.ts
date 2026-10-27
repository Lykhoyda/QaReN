import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { iosRunnerResultBundleDirs } from '../../../dist/runners/runner-artifacts.js';
import {
  hasBuiltTestProduct,
  removeRunnerResultBundles,
  resolveRunnerStartPlan,
} from '../../../dist/runners/rn-fast-runner-client.js';

test('result bundle dirs cover the local DerivedData and the prebuilt cache for a version', (t) => {
  const prior = process.env.QAREN_HOME;
  t.after(() => {
    if (prior === undefined) delete process.env.QAREN_HOME;
    else process.env.QAREN_HOME = prior;
  });
  delete process.env.QAREN_HOME;
  assert.deepEqual(iosRunnerResultBundleDirs('1.2.3', '/x/DerivedData'), [
    join('/x/DerivedData', 'Logs', 'Test'),
    join(homedir(), '.qaren', 'runtime', 'runners', '1.2.3', 'ios', 'products', 'Logs', 'Test'),
  ]);
  process.env.QAREN_HOME = '/side-home';
  assert.deepEqual(iosRunnerResultBundleDirs('1.2.3', '/x/DerivedData'), [
    join('/x/DerivedData', 'Logs', 'Test'),
    join('/side-home', 'runtime', 'runners', '1.2.3', 'ios', 'products', 'Logs', 'Test'),
  ]);
  assert.deepEqual(iosRunnerResultBundleDirs(null, '/x/DerivedData'), [
    join('/x/DerivedData', 'Logs', 'Test'),
  ]);
});

test('the prune removes Logs/Test and keeps the built test product warm', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-result-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const staging = join(root, 'Logs', 'Test', 'Test-RnFastRunner-x.xcresult', 'Staging');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'Session-RnFastRunnerUITests-x.log'), 'value: typed');
  mkdirSync(join(root, 'Build', 'Products'), { recursive: true });
  writeFileSync(join(root, 'Build', 'Products', 'RnFastRunner.xctestrun'), '');

  removeRunnerResultBundles(iosRunnerResultBundleDirs(null, root));

  assert.equal(existsSync(join(root, 'Logs', 'Test')), false);
  assert.equal(hasBuiltTestProduct(root), true);
});

test('the prune tolerates an absent DerivedData root', () => {
  const missing = join(tmpdir(), `qaren-absent-${process.pid}-${Date.now()}`);
  assert.doesNotThrow(() => removeRunnerResultBundles(iosRunnerResultBundleDirs(null, missing)));
});

test('direct reap removes result bundles after stopping an adopted process', (t) => {
  const root = mkdtempSync(join(process.cwd(), '.test-ios-reap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'runners', 'rn-fast-runner'), { recursive: true });
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import {
      _setFastRunnerStateForTest, derivedDataPathForRunner, getFastRunnerState,
      hasBuiltTestProduct, reapStaleFastRunner,
    } from ${JSON.stringify(new URL('../../../dist/runners/rn-fast-runner-client.js', import.meta.url).href)};
    import { iosRunnerResultBundleDirs } from ${JSON.stringify(new URL('../../../dist/runners/runner-artifacts.js', import.meta.url).href)};
    import { getPluginVersion } from ${JSON.stringify(new URL('../../../dist/runners/protocol.js', import.meta.url).href)};
    import { readProcessBirth } from ${JSON.stringify(new URL('../../../dist/lifecycle/process-birth.js', import.meta.url).href)};

    const dirs = iosRunnerResultBundleDirs(getPluginVersion(), derivedDataPathForRunner());
    assert.equal(dirs.length, 2);
    const seed = () => {
      for (const dir of dirs) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'snapshot.log'), 'typed-canary');
        const products = join(dirname(dirname(dir)), 'Build', 'Products');
        mkdirSync(products, { recursive: true });
        writeFileSync(join(products, 'RnFastRunner.xctestrun'), 'warm-product');
      }
    };
    const check = () => {
      for (const dir of dirs) {
        assert.equal(existsSync(dir), false, dir);
        assert.equal(hasBuiltTestProduct(dirname(dirname(dir))), true);
      }
    };
    seed();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
      await once(child, 'spawn');
      const birth = readProcessBirth(child.pid);
      assert.ok(birth, 'disposable process birth must be proven');
      _setFastRunnerStateForTest({
        pid: child.pid, processBirth: birth.token, port: 1,
        deviceId: 'disposable', bundleId: 'test.app',
      });
      await reapStaleFastRunner({ graceMs: 10 });
      await exited;
      assert.equal(getFastRunnerState(), null);
      check();
      seed();
      await reapStaleFastRunner();
      check();
      await reapStaleFastRunner();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  `,
    ],
    {
      env: {
        ...process.env,
        HOME: root,
        QAREN_HOME: join(root, 'qaren-home'),
        QAREN_NATIVE_RUNNER_ROOT: join(root, 'runners'),
      },
      timeout: 15_000,
      stdio: 'pipe',
    },
  );
});

test('the runner launch passes no -resultBundlePath', () => {
  const plan = resolveRunnerStartPlan({
    projectPath: '/p/RnFastRunner.xcodeproj',
    scheme: 'RnFastRunner',
    deviceId: 'UDID-123',
    derivedDataPath: '/p/build/DerivedData',
    onlyTesting: 'RnFastRunnerUITests/RnFastRunnerTests/testCommand',
    hasBuiltTestProduct: false,
  });
  for (const step of plan) assert.ok(!step.args.includes('-resultBundlePath'));
});
