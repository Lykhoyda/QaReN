import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMaestroDispatch,
  _resetMaestroDispatchCache,
} from '../../dist/handlers/maestro-dispatch.js';

// Force the maestro-runner tier: pretend the binary exists and adb is present
// so runnerViable is true on both platforms.
function runnerDispatch(platform) {
  _resetMaestroDispatchCache();
  return chooseMaestroDispatch({
    platform,
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/bin/maestro-runner',
  });
}

test('GH#201 maestro-runner buildArgs injects --app-file before --platform when given', () => {
  const d = runnerDispatch('ios');
  assert.equal(d.runner, 'maestro-runner');
  assert.deepEqual(d.buildArgs('ios', '/tmp/flow.yaml', '/DerivedData/MyApp.app'), [
    '--app-file',
    '/DerivedData/MyApp.app',
    '--platform',
    'ios',
    'test',
    '/tmp/flow.yaml',
  ]);
});

test('GH#201 maestro-runner buildArgs unchanged when appFile omitted', () => {
  const d = runnerDispatch('ios');
  assert.deepEqual(d.buildArgs('ios', '/tmp/flow.yaml'), [
    '--platform',
    'ios',
    'test',
    '/tmp/flow.yaml',
  ]);
});
