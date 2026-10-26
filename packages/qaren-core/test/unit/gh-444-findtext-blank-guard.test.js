// GH #444: CommandDispatcher.kt findText used cmd.optString("text"), which
// silently defaults a missing/blank argument to "" — falling through to
// By.textContains("") and reporting an arbitrary match instead of an error.
// The dispatcher must refuse blank text with a typed INVALID_ARGUMENT before
// any selector is constructed. Instrumented tests need an emulator, so this
// is a source-parsing guard (gh-418-command-surface-sync style).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOTLIN_DISPATCHER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'rn-android-runner',
  'app',
  'src',
  'androidTest',
  'java',
  'dev',
  'lykhoyda',
  'rndevagent',
  'androidrunner',
  'CommandDispatcher.kt',
);

function findTextWhenBranch() {
  const src = readFileSync(KOTLIN_DISPATCHER, 'utf8');
  // The dispatch when-branch: from `"findText" ->` up to the next when-label
  // or the else-branch. Tolerates both expression and block bodies.
  const m = src.match(
    /"findText"\s*->\s*([\s\S]*?)(?=\n\s*(?:\/\/[^\n]*\n\s*)*(?:"\w+(?:",\s*"\w+)*"\s*->|else\s*->))/,
  );
  assert.ok(m, 'findText when-branch not found in CommandDispatcher.kt');
  return m[1];
}

test('gh-444: findText when-branch refuses blank text with INVALID_ARGUMENT', () => {
  const branch = findTextWhenBranch();
  assert.match(
    branch,
    /isBlank\(\)/,
    'findText branch must check the text argument for blank before dispatching',
  );
  assert.match(
    branch,
    /return\s+error\(\s*"INVALID_ARGUMENT"/,
    'findText branch must return a typed INVALID_ARGUMENT error envelope',
  );
});

test('gh-444: blank guard runs before the findText handler builds selectors', () => {
  const branch = findTextWhenBranch();
  const guardAt = branch.indexOf('INVALID_ARGUMENT');
  const dispatchAt = branch.indexOf('findText(cmd)');
  assert.ok(dispatchAt !== -1, 'findText branch must still dispatch to findText(cmd)');
  assert.ok(
    guardAt !== -1 && guardAt < dispatchAt,
    'INVALID_ARGUMENT guard must precede the findText(cmd) call',
  );
});
