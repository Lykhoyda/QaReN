// GH #418: the runner command surface exists in THREE places — the Swift
// CommandType enum (iOS), the Kotlin SUPPORTED_COMMANDS list (Android, which
// must itself match the dispatcher when-branches), and the TS REQUIRED_*
// lists the liveness gate enforces. Source-parsing guard, gh-383-sync style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(BRIDGE_ROOT, '..', '..');

// Parse the REQUIRED lists from protocol.ts SOURCE (not dist) — same rationale
// as gh-383-protocol-sync: a stale dist must not mask source drift.
function requiredCommandsFromSource(name) {
  const src = readFileSync(join(BRIDGE_ROOT, 'src', 'runners', 'protocol.ts'), 'utf8');
  const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`));
  assert.ok(m, `${name} not found in protocol.ts`);
  const list = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  assert.ok(list.length > 0, `${name} parsed empty`);
  return list;
}

const REQUIRED_IOS_COMMANDS = requiredCommandsFromSource('REQUIRED_IOS_COMMANDS');
const REQUIRED_ANDROID_COMMANDS = requiredCommandsFromSource('REQUIRED_ANDROID_COMMANDS');
const SWIFT_MODELS = join(
  REPO_ROOT,
  'packages',
  'rn-fast-runner',
  'RnFastRunner',
  'RnFastRunnerUITests',
  'RnFastRunnerTests+Models.swift',
);
const KOTLIN_DISPATCHER = join(
  REPO_ROOT,
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

function swiftEnumRawValues() {
  const src = readFileSync(SWIFT_MODELS, 'utf8');
  const block = src.match(/enum CommandType[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'CommandType enum block not found in Models.swift');
  // /health advertises .rawValue, so parse explicit raw values
  // (`case foo = "bar"` → "bar"), falling back to the case name.
  return [...block[1].matchAll(/case (\w+)(?:\s*=\s*"([^"]+)")?/g)].map((m) => m[2] ?? m[1]);
}

function kotlinSupportedList() {
  const src = readFileSync(KOTLIN_DISPATCHER, 'utf8');
  const m = src.match(/val SUPPORTED_COMMANDS = listOf\(([\s\S]*?)\)/);
  assert.ok(m, 'SUPPORTED_COMMANDS not found in CommandDispatcher.kt');
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

function kotlinWhenLabels() {
  const src = readFileSync(KOTLIN_DISPATCHER, 'utf8');
  const labels = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*((?:"\w+",\s*)*"\w+")\s*->/);
    if (m) labels.push(...[...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));
  }
  assert.ok(labels.length > 0, 'no dispatch when-labels found in CommandDispatcher.kt');
  return labels;
}

test('gh-418 sync: Swift CommandType raw values cover REQUIRED_IOS_COMMANDS', () => {
  const rawValues = new Set(swiftEnumRawValues());
  const missing = REQUIRED_IOS_COMMANDS.filter((c) => !rawValues.has(c));
  assert.deepEqual(missing, [], `Swift enum missing: ${missing.join(', ')}`);
});

test('gh-418 sync: Kotlin SUPPORTED_COMMANDS == dispatch when-labels', () => {
  assert.deepEqual(
    [...new Set(kotlinSupportedList())].sort(),
    [...new Set(kotlinWhenLabels())].sort(),
  );
});

test('gh-418 sync: Kotlin SUPPORTED_COMMANDS covers REQUIRED_ANDROID_COMMANDS', () => {
  const supported = new Set(kotlinSupportedList());
  const missing = REQUIRED_ANDROID_COMMANDS.filter((c) => !supported.has(c));
  assert.deepEqual(missing, [], `Kotlin list missing: ${missing.join(', ')}`);
});

test('gh-418 sync: REQUIRED lists have no duplicates', () => {
  for (const list of [REQUIRED_IOS_COMMANDS, REQUIRED_ANDROID_COMMANDS]) {
    assert.equal(new Set(list).size, list.length);
  }
});
