// GH #105 / B154: tests for formatConnectFailureMessage — the pure helper
// that decides which final error string to surface after a failed CDP
// connection attempt loop. The previous unconditional "Failed to connect
// after 5 attempts." hid the distinction between (a) Metro / handshake
// being unreachable and (b) Metro reachable + JS thread paused (app
// backgrounded). The latter is the most common cause of CDP wedges during
// agent-device runs and deserves a specific, actionable recovery hint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConnectFailureMessage } from '../../dist/cdp/connect.js';

test('connect: every handshake fails → generic "Failed to connect after N" (B154)', () => {
  const msg = formatConnectFailureMessage(
    5,
    [
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
    ],
    'com.example.app',
    'WebSocket handshake failed',
  );
  assert.match(msg, /Failed to connect after 5 attempts/);
  // The probe-timeout-specific recovery hint MUST NOT appear when no
  // handshake ever succeeded — would confuse users into restarting an app
  // that never was reachable in the first place.
  assert.doesNotMatch(msg, /JS thread paused/);
  assert.doesNotMatch(msg, /simctl terminate/);
});

test('connect: every handshake ok but probe timed out → JS-thread-paused message (B154)', () => {
  const msg = formatConnectFailureMessage(
    5,
    [
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
    ],
    'com.rndevagent.testapp',
    'Target failed pre-flight probe (1+1) — likely a dead JS context',
  );
  assert.match(msg, /CDP probe timeout after 5 attempts/);
  assert.match(msg, /WebSocket handshake succeeded/);
  assert.match(msg, /JS thread paused/);
  assert.match(msg, /target app is most likely backgrounded/);
  // The recovery command must mention the actual bundleId so the user can
  // copy-paste it. simctl terminate + launch is the only reliable way to
  // unwedge Hermes once the JS thread has paused.
  assert.match(msg, /simctl terminate booted com\.rndevagent\.testapp/);
  assert.match(msg, /simctl launch booted com\.rndevagent\.testapp/);
});

test('connect: mixed (some handshakes fail, some probe ok) → fall back to generic message (B154)', () => {
  // If even one attempt couldn't handshake, the persistent state isn't
  // "JS paused" — Metro / inspector connectivity itself was flaky.
  const msg = formatConnectFailureMessage(
    5,
    [
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
    ],
    'com.example.app',
    'Target failed pre-flight probe (1+1) — likely a dead JS context',
  );
  assert.match(msg, /Failed to connect after 5 attempts/);
  assert.doesNotMatch(msg, /simctl terminate/);
});

test('connect: 1006 close code adds the "another debugger" hint to generic message (existing behavior preserved)', () => {
  const msg = formatConnectFailureMessage(
    5,
    [
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
      { handshakeOk: false, probeTimedOut: false },
    ],
    null,
    'WebSocket closed with code 1006',
  );
  assert.match(msg, /Failed to connect after 5 attempts/);
  assert.match(msg, /Another debugger may be connected/);
});

test('connect: probe-timeout with null bundleId falls back to "<bundleId>" placeholder', () => {
  const msg = formatConnectFailureMessage(
    5,
    [
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
      { handshakeOk: true, probeTimedOut: true },
    ],
    null,
    'pre-flight probe',
  );
  // No bundle in the target.description → still produce an actionable hint
  // shape, but with a placeholder users can edit.
  assert.match(msg, /simctl terminate booted <bundleId>/);
  assert.match(msg, /CDP probe timeout/);
});

test('connect: zero attempts (defensive) → generic message, no false probe-timeout claim', () => {
  // attempts.length === 0 would mean the loop short-circuited before any
  // iteration ran (caller error). Helper must not claim "all handshakes
  // succeeded" in that degenerate case.
  const msg = formatConnectFailureMessage(0, [], 'com.example.app', null);
  assert.match(msg, /Failed to connect after 0 attempts/);
  assert.doesNotMatch(msg, /simctl/);
});
