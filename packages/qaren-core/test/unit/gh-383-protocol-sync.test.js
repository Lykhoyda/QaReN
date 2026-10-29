import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunnerCompatibility } from '../../dist/runners/protocol.js';

test('gh-383 classify: missing protocolVersion → legacy', () => {
  assert.deepEqual(classifyRunnerCompatibility({}, '0.58.0'), {
    compatible: false,
    reason: 'legacy',
  });
});

test('gh-383 classify: older / equal / newer protocol', () => {
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 0 }, null), {
    compatible: false,
    reason: 'protocol-older',
  });
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, null), {
    compatible: true,
  });
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 99 }, null), {
    compatible: false,
    reason: 'protocol-newer',
  });
});

test('gh-383 classify: version-skew only when both sides known', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.1' }, '0.57.3'),
    { compatible: false, reason: 'version-skew' },
  );
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.3' }, '0.57.3'),
    { compatible: true },
  );
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, '0.57.3'), {
    compatible: true,
  });
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.1' }, null),
    { compatible: true },
  );
});
