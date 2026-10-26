// GH #60 Bug 7: device_find used to surface "Daemon error: daemon timeout"
// directly to the caller and force them to fall back to cdp_interact manually.
// The new fallback detects the daemon-timeout error pattern, fetches a
// snapshot, and runs a fuzzy match — recovering automatically when the
// snapshot-tier path is healthy. Tests cover the pattern detector + the
// downstream recovery shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDaemonTimeoutError } from '../../dist/handlers/device-interact.js';

// ── isDaemonTimeoutError detector ───────────────────────────────────────

test('isDaemonTimeoutError: matches "Daemon error: daemon timeout"', () => {
  assert.equal(isDaemonTimeoutError('Daemon error: daemon timeout'), true);
});

test('isDaemonTimeoutError: matches lowercase variant', () => {
  assert.equal(isDaemonTimeoutError('daemon timeout'), true);
});

test('isDaemonTimeoutError: matches "daemon timed out"', () => {
  assert.equal(isDaemonTimeoutError('AgentDeviceRunner daemon timed out after 30s'), true);
});

test('isDaemonTimeoutError: matches "daemon timeout" inside JSON envelope', () => {
  const envelope = JSON.stringify({
    ok: false,
    error: 'Daemon error: daemon timeout. Restart agent-device daemon.',
  });
  assert.equal(isDaemonTimeoutError(envelope), true);
});

test('isDaemonTimeoutError: does NOT match unrelated timeouts', () => {
  assert.equal(isDaemonTimeoutError('CDP evaluate timeout (5000ms)'), false);
  assert.equal(isDaemonTimeoutError('Request timeout'), false);
  assert.equal(isDaemonTimeoutError('softReconnect timeout'), false);
  assert.equal(isDaemonTimeoutError('force_reconnect timeout (10000ms)'), false);
});

test('isDaemonTimeoutError: handles empty/null/undefined safely', () => {
  assert.equal(isDaemonTimeoutError(''), false);
  assert.equal(isDaemonTimeoutError(null), false);
  assert.equal(isDaemonTimeoutError(undefined), false);
});

test('isDaemonTimeoutError: matches multi-line payload', () => {
  const stderr = `agent-device-runner: connecting to daemon...
Daemon error: daemon timeout
Falling back to direct CLI`;
  assert.equal(isDaemonTimeoutError(stderr), true);
});

// ── Source-grep regression guards ───────────────────────────────────────
// Task 7 (Phase 2): the legacy CLI daemon-timeout fallback path was deleted.
// device_find now requires an in-tree runner (IN_TREE_RUNNER_REQUIRED) for the
// non-exact path — there is no longer a ['find', text] dispatch to agent-device.

test('source guard: device_find handler no longer dispatches to CLI daemon (IN_TREE_RUNNER_REQUIRED)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/handlers/device-interact.js'), 'utf-8');
  // The dead CLI fallback path is gone; the in-tree-runner gate must be present.
  assert.match(src, /IN_TREE_RUNNER_REQUIRED/);
  // No ['find', ...] literal should survive into the built output.
  const findLiterals = src
    .split('\n')
    .filter((l) => l.includes("['find'") && !l.trimStart().startsWith('//'));
  assert.equal(
    findLiterals.length,
    0,
    `Found ['find' literal in device-interact.js:\n${findLiterals.join('\n')}`,
  );
});

test('source guard: isDaemonTimeoutError still exported (used by tests + future callers)', async () => {
  const { isDaemonTimeoutError } = await import('../../dist/handlers/device-interact.js');
  assert.equal(typeof isDaemonTimeoutError, 'function');
});

test('source guard: fetchFindCandidates is now exported from device-interact', async () => {
  const { fetchFindCandidates } = await import('../../dist/handlers/device-interact.js');
  assert.equal(typeof fetchFindCandidates, 'function');
});

test('source guard: pressCandidate is now exported from device-interact', async () => {
  const { pressCandidate } = await import('../../dist/handlers/device-interact.js');
  assert.equal(typeof pressCandidate, 'function');
});
