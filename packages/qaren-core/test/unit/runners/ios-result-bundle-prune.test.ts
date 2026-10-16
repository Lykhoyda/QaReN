import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { iosRunnerResultBundleDirs } from '../../../dist/runners/runner-artifacts.js';
import {
  hasBuiltTestProduct,
  removeRunnerResultBundles,
  resolveRunnerStartPlan,
} from '../../../dist/runners/rn-fast-runner-client.js';

test('result bundle dirs cover the local DerivedData and the prebuilt cache for a version', () => {
  assert.deepEqual(iosRunnerResultBundleDirs('1.2.3', '/x/DerivedData'), [
    join('/x/DerivedData', 'Logs', 'Test'),
    join(homedir(), '.qaren', 'runtime', 'runners', '1.2.3', 'ios', 'products', 'Logs', 'Test'),
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
