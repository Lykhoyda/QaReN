import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('both Android keyboard aliases use visibility-checked dismissal instead of unconditional BACK', () => {
  const source = readFileSync(
    new URL(
      '../../../rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(source, /"dismissKeyboard", "keyboard" -> dismissKeyboard\(appPackage\)/);
  assert.match(source, /KeyboardGuard\.dismiss\(/);
  assert.match(source, /executeShellCommand\("dumpsys input_method"\)/);
});
