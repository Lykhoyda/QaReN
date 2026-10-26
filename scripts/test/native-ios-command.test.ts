import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('native iOS tests disable parallel testing and preserve the explicit destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-ios-command-'));
  try {
    for (const dir of ['scripts', 'bin', 'packages/rn-fast-runner/RnFastRunner']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const script = join(root, 'scripts/test-native-ios.sh');
    copyFileSync(new URL('../test-native-ios.sh', import.meta.url), script);
    symlinkSync('/usr/bin/dirname', join(root, 'bin/dirname'));
    symlinkSync('/bin/rm', join(root, 'bin/rm'));
    writeFileSync(join(root, 'bin/xcodebuild'), '#!/bin/bash\nprintf \'%s\\0\' "$@"\n', {
      mode: 0o755,
    });
    const destination = 'platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001';
    const results = join(root, 'test results.xcresult');
    const output = spawnSync('/bin/bash', [script], {
      env: {
        PATH: join(root, 'bin'),
        HOME: root,
        RN_IOS_TEST_DESTINATION: destination,
        RN_IOS_TEST_RESULTS: results,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.equal(output.stderr, '');
    assert.deepEqual(output.stdout.split('\0'), [
      'test',
      '-project',
      'RnFastRunner.xcodeproj',
      '-scheme',
      'RnFastRunner',
      '-destination',
      destination,
      '-parallel-testing-enabled',
      'NO',
      '-derivedDataPath',
      '../build/DerivedData-native-tests',
      '-resultBundlePath',
      results,
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGN_IDENTITY=',
      'CODE_SIGNING_REQUIRED=NO',
      'ONLY_ACTIVE_ARCH=YES',
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG RN_FAST_RUNNER_TEST_FAULTS',
      '-skip-testing:RnFastRunnerUITests/RnFastRunnerTests',
      '-skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest',
      '',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
