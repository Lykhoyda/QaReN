// GH #383 (device-caught): xcodebuild only forwards TEST_RUNNER_-prefixed env
// vars to the XCUITest runner process (prefix stripped). Live verification
// showed /health returned runnerVersion: undefined because the plain
// RN_PLUGIN_VERSION var alone never reached the runner. The env helpers emit
// both forms so the plain var still works for any direct launch path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunnerPortEnv,
  buildRunnerVersionEnv,
} from '../../dist/runners/rn-fast-runner-client.js';

test('gh-383: buildRunnerVersionEnv emits plain + TEST_RUNNER_-prefixed keys when known', () => {
  assert.deepEqual(buildRunnerVersionEnv('0.58.0'), {
    RN_PLUGIN_VERSION: '0.58.0',
    TEST_RUNNER_RN_PLUGIN_VERSION: '0.58.0',
  });
});

test('gh-383: buildRunnerVersionEnv is empty when version unknown (fail-open)', () => {
  assert.deepEqual(buildRunnerVersionEnv(null), {});
});

test('gh-383: buildRunnerPortEnv emits plain + TEST_RUNNER_-prefixed keys', () => {
  assert.deepEqual(buildRunnerPortEnv(22088), {
    RN_FAST_RUNNER_PORT: '22088',
    TEST_RUNNER_RN_FAST_RUNNER_PORT: '22088',
  });
});
