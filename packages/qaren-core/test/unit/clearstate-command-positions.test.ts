import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowUsesClearState } from '../../dist/handlers/resolve-ios-app-file.js';

for (const [name, flow] of [
  ['launch arguments', '- launchApp:\n    arguments:\n      clearState: fixture-value'],
  ['argument arrays', '- launchApp:\n    arguments:\n      flags: [clearState]'],
  [
    'nested command-shaped arguments',
    '- launchApp:\n    arguments:\n      runFlow:\n        commands:\n          - clearState',
  ],
  ['header data', 'appId: com.test.app\nclearState: fixture-value\n---\n- launchApp'],
  [
    'runFlow conditions',
    '- runFlow:\n    when:\n      visible:\n        clearState: fixture-value\n    commands:\n      - launchApp',
  ],
  [
    'nested launch arguments',
    '- runFlow:\n    commands:\n      - launchApp:\n          arguments:\n            clearState: fixture-value',
  ],
]) {
  test(`reinstall detection ignores clearState in ${name}`, () => {
    assert.equal(flowUsesClearState(flow), false);
  });
}

for (const command of [
  'clearState',
  'clearState: com.test.app',
  'launchApp:\n    clearState: true',
]) {
  test(`reinstall detection finds nested ${command.split('\n')[0]}`, () => {
    const nested = command.replaceAll('\n', '\n            ');
    assert.equal(
      flowUsesClearState(
        `- runFlow:\n    commands:\n      - runFlow:\n          commands:\n            - ${nested}`,
      ),
      true,
    );
  });
}
