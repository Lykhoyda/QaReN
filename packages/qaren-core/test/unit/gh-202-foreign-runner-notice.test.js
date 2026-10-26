import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignRunnerNotice } from '../../dist/runners/external-runner-detect.js';

const detection = {
  platform: 'ios',
  code: 'IOS_XCUITEST_COMPETITOR',
  message: 'A foreign maestro/WebDriverAgent automation session is driving this simulator.',
  processLines: ['18225 /Devices/FC78.../maestro-driver-iosUITests-Runner'],
};

test('foreignRunnerNotice: builds notice when foreign present and no flow lease', () => {
  const n = foreignRunnerNotice(detection, false);
  assert.ok(n);
  assert.equal(n.meta.foreignRunner.code, 'IOS_XCUITEST_COMPETITOR');
  assert.deepEqual(n.meta.foreignRunner.processLines, [
    '18225 /Devices/FC78.../maestro-driver-iosUITests-Runner',
  ]);
  assert.match(n.warning, /^FOREIGN_RUNNER_ACTIVE:/);
});

test('foreignRunnerNotice: null when WE hold the flow lease (the driver is ours)', () => {
  assert.equal(foreignRunnerNotice(detection, true), null);
});

test('foreignRunnerNotice: null when no foreign process detected', () => {
  assert.equal(foreignRunnerNotice(null, false), null);
});
