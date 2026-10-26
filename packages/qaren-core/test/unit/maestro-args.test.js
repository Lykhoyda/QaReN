import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleMaestroArgs } from '../../dist/handlers/maestro-run.js';

test('params are spliced BEFORE the flow file (not appended after it)', () => {
  const base = ['--platform', 'ios', 'test', '/tmp/flow.yaml'];
  const params = ['-e', 'TITLE=Ship demo', '-e', 'DESC=end to end'];
  assert.deepEqual(assembleMaestroArgs(base, params), [
    '--platform',
    'ios',
    'test',
    '-e',
    'TITLE=Ship demo',
    '-e',
    'DESC=end to end',
    '/tmp/flow.yaml',
  ]);
});

test('params land before the flow file with an --app-file prefix too', () => {
  const base = ['--app-file', '/x.app', '--platform', 'ios', 'test', '/tmp/flow.yaml'];
  const out = assembleMaestroArgs(base, ['-e', 'K=V']);
  assert.equal(out[out.length - 1], '/tmp/flow.yaml');
  assert.ok(out.indexOf('-e') < out.indexOf('/tmp/flow.yaml'));
});

test('no params → baseArgs returned unchanged', () => {
  const base = ['--platform', 'ios', 'test', '/tmp/flow.yaml'];
  assert.deepEqual(assembleMaestroArgs(base, []), base);
});
