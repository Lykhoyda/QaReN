// GH #383 (Task 8 carry-forwards): RUNNER_PROTOCOL_MISMATCH and the transparent
// upgrade note must surface on EVERY entry path, not just runNative. The
// These source-text invariants ensure the default open path and its injectable
// test seam preserve the same upgrade behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/handlers/device-session.ts'), 'utf8');
const wrapperSrc = readFileSync(resolve(__dirname, '../../src/agent-device-wrapper.ts'), 'utf8');
const maestroRunSrc = readFileSync(resolve(__dirname, '../../src/handlers/maestro-run.ts'), 'utf8');

test('gh-383: iOS open path propagates ready.code (RUNNER_PROTOCOL_MISMATCH) instead of hard-coding RN_FAST_RUNNER_DOWN', () => {
  assert.match(sessionSrc, /failResult\(ready\.message, ready\.code \?\? 'RN_FAST_RUNNER_DOWN'\)/);
  assert.ok(
    !sessionSrc.includes("failResult(ready.message, 'RN_FAST_RUNNER_DOWN')"),
    'the hard-coded RN_FAST_RUNNER_DOWN mapping must be gone',
  );
});

test('gh-383: open success carries the upgrade note (iOS ready.note, Android pending note) via attachMetaNote', () => {
  assert.match(sessionSrc, /upgradeNote = ready\.note/);
  assert.match(sessionSrc, /upgradeNote = consumePendingAndroidUpgradeNote\(\)/);
  assert.match(sessionSrc, /upgradeNote \? attachMetaNote\(result, upgradeNote\) : result/);
});

test('gh-383: Android note is consumed immediately after startAndroidRunner succeeds (never left pending)', () => {
  // GH #418: the default dependency still enables the one allowed open-path
  // rebuild, and the caller consumes the note immediately after that dependency.
  assert.match(
    sessionSrc,
    /startAndroidRunner\(deviceId, appId, undefined, \{ allowArtifactRebuild: true \}\)/,
  );
  assert.match(
    sessionSrc,
    /await startAndroidRunnerFn\(deviceId, appId\);\s*\n\s*upgradeNote = consumePendingAndroidUpgradeNote\(\);/,
  );
});

test('gh-383: open catch surfaces RUNNER_PROTOCOL_MISMATCH before the generic runner-down mapping', () => {
  const catchBlock = sessionSrc.slice(
    sessionSrc.indexOf('// Ensure runner + launch.'),
    sessionSrc.indexOf('// Set session LAST'),
  );
  assert.ok(catchBlock.length > 0, 'open try/catch block must be locatable');
  const mismatch = catchBlock.indexOf("msg.startsWith('RUNNER_PROTOCOL_MISMATCH')");
  const generic = catchBlock.indexOf("'RN_ANDROID_RUNNER_DOWN'");
  assert.ok(mismatch !== -1, 'catch must check for RUNNER_PROTOCOL_MISMATCH');
  assert.ok(generic !== -1, 'catch must keep the generic runner-down mapping');
  assert.ok(mismatch < generic, 'mismatch check must run BEFORE the generic mapping');
});

test('Android open preserves runner ownership mismatch after rebuild', () => {
  const catchBlock = sessionSrc.slice(
    sessionSrc.indexOf('// Ensure runner + launch.'),
    sessionSrc.indexOf('// Set session LAST'),
  );
  const ownership = catchBlock.indexOf("msg.startsWith('RUNNER_OWNERSHIP_MISMATCH')");
  const generic = catchBlock.indexOf("'RN_ANDROID_RUNNER_DOWN'");

  assert.ok(ownership !== -1);
  assert.ok(generic === -1 || ownership < generic);
});

test('gh-383: open catch discards a pending Android upgrade note before the mismatch check (non-mismatch failures must not leak a stale note)', () => {
  const section = sessionSrc.slice(
    sessionSrc.indexOf('// Ensure runner + launch.'),
    sessionSrc.indexOf('// Set session LAST'),
  );
  assert.ok(section.length > 0, 'open try/catch block must be locatable');
  // Anchor at the catch itself — the try body also calls
  // consumePendingAndroidUpgradeNote() on the Android success path (line
  // ~283), so slicing from the section start would let that unrelated call
  // satisfy the assertion even if the catch-path discard were removed.
  const catchStart = section.indexOf('catch (err)');
  assert.ok(catchStart !== -1, 'catch block must be locatable');
  const catchBlock = section.slice(catchStart);
  const discard = catchBlock.indexOf('consumePendingAndroidUpgradeNote();');
  const mismatch = catchBlock.indexOf("msg.startsWith('RUNNER_PROTOCOL_MISMATCH')");
  assert.ok(discard !== -1, 'catch must discard the pending upgrade note');
  assert.ok(mismatch !== -1, 'catch must check for RUNNER_PROTOCOL_MISMATCH');
  assert.ok(discard < mismatch, 'the discard call must run BEFORE the mismatch check');
});

test('gh-383: runFlowParked passes deviceId to stopFastRunner so iOS park works after an adoption-only (post-respawn) state', () => {
  assert.match(
    maestroRunSrc,
    /\(opts\.stopFastRunner \?\? defaultStopFastRunner\)\(opts\.deviceId\);/,
  );
  assert.ok(
    !maestroRunSrc.includes('(opts.stopFastRunner ?? defaultStopFastRunner)();'),
    'the bare (no-deviceId) park call must be gone — it silently no-ops after a bridge-worker respawn',
  );
});

test('gh-383: runNative Android pre-flight failure consumes (discards) the pending upgrade note', () => {
  const preflight = wrapperSrc.slice(
    wrapperSrc.indexOf('await startAndroidRunner(serial, appId);'),
    wrapperSrc.indexOf('rn-android-runner did not start'),
  );
  assert.ok(preflight.length > 0, 'pre-flight catch must be locatable');
  assert.ok(
    preflight.includes('consumePendingAndroidUpgradeNote();'),
    'the failed-start path must discard the pending note so it cannot attach to a later result',
  );
});
