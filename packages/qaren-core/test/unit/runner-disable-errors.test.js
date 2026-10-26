// Phase 2 Task 9: RN_ANDROID_RUNNER=0 must produce an explicit RUNNER_DISABLED
// error (not fall through to NO_NATIVE_ROUTE). Source-regex asserts over the
// TS source so the gate is enforced at the dispatch level, not just in docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../src/agent-device-wrapper.ts'), 'utf-8');
const typesSrc = readFileSync(join(__dirname, '../../src/types.ts'), 'utf-8');

// ── RUNNER_DISABLED must be in the ToolErrorCode union ──────────────────────

test('RUNNER_DISABLED is a member of the ToolErrorCode union in types.ts', () => {
  assert.match(
    typesSrc,
    /['"]?RUNNER_DISABLED['"]?/,
    "ToolErrorCode union in types.ts must include 'RUNNER_DISABLED'",
  );
});

// ── Dispatcher must have an explicit RUNNER_DISABLED branch ─────────────────

test('runNative has an explicit RUNNER_DISABLED branch for RN_ANDROID_RUNNER=0', () => {
  assert.match(
    src,
    /RUNNER_DISABLED/,
    'agent-device-wrapper.ts must contain a RUNNER_DISABLED error branch',
  );
});

test("RUNNER_DISABLED branch is gated on RN_ANDROID_RUNNER === '0'", () => {
  // The branch must check for the env var being exactly '0'
  assert.match(
    src,
    /process\.env\.RN_ANDROID_RUNNER\s*===\s*['"]0['"]/,
    'The RUNNER_DISABLED gate must check process.env.RN_ANDROID_RUNNER === "0"',
  );
});

test('RUNNER_DISABLED branch is scoped to Android platform and runner commands', () => {
  // Ensure the branch is platform-scoped (android) and command-set-scoped
  assert.match(
    src,
    /targetPlatform\s*===\s*['"]android['"]/,
    'The dispatcher must be platform-scoped to "android"',
  );
  assert.match(
    src,
    /RN_ANDROID_RUNNER_COMMANDS\.has\(cliArgs\[0\]\)/,
    'The RUNNER_DISABLED gate must check RN_ANDROID_RUNNER_COMMANDS',
  );
});

test("RUNNER_DISABLED branch appears BEFORE the enabled short-circuit (RN_ANDROID_RUNNER !== '0')", () => {
  const normalized = src.replace(/'/g, '"');
  const disabledIdx = normalized.indexOf('RN_ANDROID_RUNNER === "0"');
  const enabledIdx = normalized.indexOf('RN_ANDROID_RUNNER !== "0"');
  assert.ok(disabledIdx !== -1, 'Could not find RN_ANDROID_RUNNER === "0" gate');
  assert.ok(enabledIdx !== -1, 'Could not find RN_ANDROID_RUNNER !== "0" gate');
  assert.ok(
    disabledIdx < enabledIdx,
    `RUNNER_DISABLED gate (pos ${disabledIdx}) must appear before the enabled gate (pos ${enabledIdx})`,
  );
});
