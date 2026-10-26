import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const swiftDir = join(
  repoRoot,
  'packages',
  'rn-fast-runner',
  'RnFastRunner',
  'RnFastRunnerUITests',
);

// Drop // line comments so a commented-out token can never satisfy a match.
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function swiftEnumRawValues() {
  const src = readFileSync(join(swiftDir, 'RnFastRunnerTests+Models.swift'), 'utf-8');
  const body = src.match(/enum CommandType[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const out = [];
  for (const m of body.matchAll(/case (\w+)(?:\s*=\s*"([^"]+)")?/g)) out.push(m[2] ?? m[1]);
  return out;
}

test('story-04 iOS: CommandType enumerates isScreenStatic', () => {
  assert.ok(swiftEnumRawValues().includes('isScreenStatic'));
});

test('story-04 iOS: /health capabilities construction references SCREEN_STATIC', () => {
  const src = stripLineComments(
    readFileSync(join(swiftDir, 'RnFastRunnerTests+Transport.swift'), 'utf-8'),
  );
  // Source-parse guard only: SCREEN_STATIC must appear inside the capabilities:
  // argument (bounded window, comments stripped, so a stray or commented token
  // can't satisfy it). Unconditional-ness is a semantic property regex can't pin
  // without baking in one expression shape — it is covered by implementation
  // review + the Swift CommandSurfaceTests pin.
  assert.match(src, /capabilities:[\s\S]{0,200}?"SCREEN_STATIC"/);
});

test('story-04 iOS: isScreenStatic is a case label in isRunnerLifecycleCommand', () => {
  const src = stripLineComments(
    readFileSync(join(swiftDir, 'RnFastRunnerTests+Lifecycle.swift'), 'utf-8'),
  );
  const fn = src.match(/func isRunnerLifecycleCommand[\s\S]*?\n\}/)?.[0] ?? '';
  // Case-label shape, comments stripped: a mention in a comment or dead string
  // cannot satisfy this — only `case ... .isScreenStatic ... :`.
  assert.match(fn, /case[^:{]*\.isScreenStatic[^:{]*:/);
});

const kotlinDir = join(
  repoRoot,
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
);

test('story-04 Android: SUPPORTED_COMMANDS and dispatch both know isWindowUpdating', () => {
  const src = stripLineComments(readFileSync(join(kotlinDir, 'CommandDispatcher.kt'), 'utf-8'));
  const list = src.match(/val SUPPORTED_COMMANDS = listOf\(([\s\S]*?)\)/)?.[1] ?? '';
  assert.ok(list.includes('"isWindowUpdating"'), 'missing from SUPPORTED_COMMANDS');
  assert.match(src, /"isWindowUpdating"\s*->/);
  assert.match(src, /waitForWindowUpdate/);
});

test('story-04 Android: /health capabilities construction includes WINDOW_UPDATE', () => {
  const src = stripLineComments(readFileSync(join(kotlinDir, 'CommandServer.kt'), 'utf-8'));
  // Match WINDOW_UPDATE inside the capabilities put (bounded window, comments
  // stripped) without baking in one JSONArray construction shape.
  assert.match(src, /put\("capabilities",[\s\S]{0,200}?"WINDOW_UPDATE"/);
});
