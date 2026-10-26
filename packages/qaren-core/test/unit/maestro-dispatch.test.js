// Pin-cache maestro-runner is the only session engine. Ambient PATH,
// ~/.maestro-runner, brew maestro, and iOS-adb/hideKeyboard CLI fallbacks
// are never selected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMaestroDispatch,
  _resetMaestroDispatchCache,
  flowContainsHideKeyboard,
} from '../../dist/handlers/maestro-dispatch.js';

test.beforeEach(() => _resetMaestroDispatchCache());

test('pin-cache present: ios without adb still uses maestro-runner', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => null,
    whichMaestro: () => '/opt/homebrew/bin/maestro',
    maestroRunnerPath: () => '/cache/maestro-runner/1.1.28/bin/maestro-runner',
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro-runner');
  assert.equal(
    'binPath' in d ? d.binPath : null,
    '/cache/maestro-runner/1.1.28/bin/maestro-runner',
  );
  assert.equal('fallbackReason' in d && d.fallbackReason !== undefined, false);
});

test('pin-cache present: android hideKeyboard still uses maestro-runner', () => {
  const d = chooseMaestroDispatch({
    platform: 'android',
    flowHasHideKeyboard: true,
    whichAdb: () => '/adb',
    whichMaestro: () => '/opt/homebrew/bin/maestro',
    maestroRunnerPath: () => '/cache/bin/maestro-runner',
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro-runner');
  assert.equal('fallbackReason' in d && d.fallbackReason !== undefined, false);
  assert.equal('degradedReason' in d && d.degradedReason !== undefined, false);
});

test('pin-cache present: buildArgs emits --platform and optional --device', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    maestroRunnerPath: () => '/runner',
  });
  if (!('buildArgs' in d)) throw new Error('expected dispatch');
  assert.deepEqual(d.buildArgs('ios', '/tmp/flow.yaml'), [
    '--platform',
    'ios',
    'test',
    '/tmp/flow.yaml',
  ]);
  assert.deepEqual(d.buildArgs('android', '/tmp/flow.yaml', undefined, 'emulator-5554'), [
    '--platform',
    'android',
    '--device',
    'emulator-5554',
    'test',
    '/tmp/flow.yaml',
  ]);
});

test('pin-cache missing: refuses brew maestro and PATH runners', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => null,
    whichMaestro: () => '/opt/homebrew/bin/maestro',
    maestroRunnerPath: () => null,
  });
  assert.ok('error' in d, 'expected error');
  assert.match(d.error, /pin-cache/);
  assert.match(d.error, /1\.1\.28/);
  assert.doesNotMatch(d.error, /brew install maestro/);
  assert.match(d.hint, /ensure-maestro-runner/);
});

test('pin-cache missing: android also refuses CLI substitution', () => {
  const d = chooseMaestroDispatch({
    platform: 'android',
    whichAdb: () => '/adb',
    whichMaestro: () => '/maestro',
    maestroRunnerPath: () => null,
  });
  assert.ok('error' in d);
  assert.doesNotMatch(d.error, /brew install maestro/);
  assert.match(d.error, /never used/);
});

test('flowContainsHideKeyboard still detects the command for preflight callers', () => {
  assert.equal(
    flowContainsHideKeyboard(['launchApp', 'hideKeyboard', { tapOn: { id: 'x' } }]),
    true,
  );
  assert.equal(flowContainsHideKeyboard([{ hideKeyboard: true }]), true);
  assert.equal(flowContainsHideKeyboard(['launchApp', { tapOn: { id: 'x' } }]), false);
});

test('_resetMaestroDispatchCache exists for hermetic suites', () => {
  assert.equal(typeof _resetMaestroDispatchCache, 'function');
  _resetMaestroDispatchCache();
});
