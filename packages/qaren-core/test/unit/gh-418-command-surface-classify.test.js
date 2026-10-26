// GH #418: classifier matrix for the command-surface check. Strict on absence:
// a runner not advertising `commands` (every pre-#418 artifact) is
// 'missing-commands' with the full required list as `missing`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRunnerCompatibility,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

const FULL = [...REQUIRED_IOS_COMMANDS];

test('gh-418 classify: commands ⊇ required → compatible', () => {
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, commands: FULL },
      null,
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: true },
  );
});

test('gh-418 classify: extra advertised commands are fine', () => {
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, commands: [...FULL, 'rotate', 'alert'] },
      null,
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: true },
  );
});

test('gh-418 classify: one missing verb → missing-commands naming it', () => {
  const withoutKeyboard = FULL.filter((c) => c !== 'keyboardDismiss');
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, commands: withoutKeyboard },
      null,
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: false, reason: 'missing-commands', missing: ['keyboardDismiss'] },
  );
});

test('gh-418 classify: absent commands field → missing-commands with full list (strict)', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1 }, null, REQUIRED_IOS_COMMANDS),
    { compatible: false, reason: 'missing-commands', missing: FULL },
  );
});

test('gh-418 classify: no requiredCommands param → commands not enforced (back-compat)', () => {
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, null), {
    compatible: true,
  });
});

test('gh-418 classify: protocol/skew reasons win over missing-commands', () => {
  assert.deepEqual(classifyRunnerCompatibility({}, null, REQUIRED_IOS_COMMANDS), {
    compatible: false,
    reason: 'legacy',
  });
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, runnerVersion: '0.0.1' },
      '0.99.0',
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: false, reason: 'version-skew' },
  );
});

test('gh-418: REQUIRED lists cover both platforms, non-empty, keyboard verbs differ', () => {
  assert.ok(REQUIRED_IOS_COMMANDS.includes('keyboardDismiss'));
  assert.ok(!REQUIRED_IOS_COMMANDS.includes('dismissKeyboard'));
  assert.ok(REQUIRED_ANDROID_COMMANDS.includes('dismissKeyboard'));
  assert.ok(REQUIRED_IOS_COMMANDS.length >= 9 && REQUIRED_ANDROID_COMMANDS.length >= 9);
});
