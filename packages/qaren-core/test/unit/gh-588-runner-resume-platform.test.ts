import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunnerResume } from '../../dist/handlers/maestro-run.js';

test('GH-588: an iOS failure carries the real rn-fast-runner health verdict', async () => {
  assert.deepEqual(await buildRunnerResume('ios', async () => true), {
    attempted: true,
    healthy: true,
  });
  assert.deepEqual(await buildRunnerResume('ios', async () => false), {
    attempted: true,
    healthy: false,
  });
});

test('GH-588: a probe failure degrades to unhealthy rather than throwing', async () => {
  assert.deepEqual(
    await buildRunnerResume('ios', async () => {
      throw new Error('probe exploded');
    }),
    { attempted: true, healthy: false },
  );
});

test('GH-588 disconfirmation: Android failures never probe the iOS runner', async () => {
  let probeCalls = 0;
  const resume = await buildRunnerResume('android', async () => {
    probeCalls += 1;
    return false;
  });
  assert.equal(resume, undefined, 'no iOS runner is involved in an Android run');
  assert.equal(probeCalls, 0);
});
