// GH #184: cdp_status must fail fast (not hang ~33.5s) when the Dev Client
// picker blocks the bundle. A status-scoped bounded React-reachability probe
// runs before setup()'s 30s waitForReact; on timeout against a non-Hermes
// (stale C++) target it throws PickerBlockingBundleError.
//
// connectToTarget opens a real WebSocket, so — following the repo convention
// for formatConnectFailureMessage/stickyPlatformFilters — the decision logic is
// extracted into pure helpers tested here without spinning a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeReactReachable } from '../../dist/cdp/setup.js';
import { shouldRunPickerProbe, PickerBlockingBundleError } from '../../dist/cdp/connect.js';

const hermes = { id: 'a', title: 'X', vm: 'Hermes', webSocketDebuggerUrl: 'ws://x' };
const cpp = {
  id: 'b',
  title: 'React Native Bridgeless [C++ connection]',
  vm: "don't know",
  webSocketDebuggerUrl: 'ws://y',
};

// ── probeReactReachable ─────────────────────────────────────────────────

test('probeReactReachable returns true as soon as React reports ready', async () => {
  let calls = 0;
  const evaluate = async () => {
    calls++;
    return { value: calls >= 2 };
  };
  const ok = await probeReactReachable(evaluate, 1000, 5);
  assert.equal(ok, true);
  assert.ok(calls >= 2);
});

test('probeReactReachable returns false when React never readies within budget', async () => {
  const start = Date.now();
  const ok = await probeReactReachable(async () => ({ value: false }), 80, 10);
  assert.equal(ok, false);
  assert.ok(Date.now() - start >= 80, 'waited at least the budget');
  assert.ok(Date.now() - start < 2000, 'returned promptly, not after the 30s setup wait');
});

test('probeReactReachable tolerates a throwing evaluate then success', async () => {
  let calls = 0;
  const evaluate = async () => {
    calls++;
    if (calls < 2) throw new Error('not ready');
    return { value: true };
  };
  assert.equal(await probeReactReachable(evaluate, 1000, 5), true);
});

// ── shouldRunPickerProbe (the vm/intent gate) ───────────────────────────

test('shouldRunPickerProbe only fires for status intent on a non-Hermes target', () => {
  assert.equal(shouldRunPickerProbe('status', cpp), true, 'status + non-Hermes → probe');
  assert.equal(
    shouldRunPickerProbe('status', hermes),
    false,
    'status + Hermes → skip (legit slow build)',
  );
  assert.equal(shouldRunPickerProbe('default', cpp), false, 'default intent → never probe');
  assert.equal(shouldRunPickerProbe('default', hermes), false);
});

// ── PickerBlockingBundleError shape ─────────────────────────────────────

test('PickerBlockingBundleError is an Error carrying the target + an actionable message', () => {
  const err = new PickerBlockingBundleError(cpp);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'PickerBlockingBundleError');
  assert.equal(err.target, cpp);
  assert.match(err.message, /picker/i);
  assert.match(err.message, /Metro|select|retry/i);
});
