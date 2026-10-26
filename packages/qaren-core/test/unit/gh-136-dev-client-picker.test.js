// GH #136 / D690+: dev-client picker reliability. Tests cover the new pure
// helpers (parsePortPatternEntry, parseFirstServerEntry) and the dismissPicker
// integration that uses them, including auto-advance race detection and the
// tightened waitForBundle cadence. Mock the agent-device wrapper via the
// underscore-prefixed test seams (_setRunAgentDeviceForTest, _setHasSessionForTest)
// so we can drive every branch deterministically without spawning a real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/handlers/dev-client-picker.js';

// ── parsePortPatternEntry: pure host:port matcher ────────────────────

test('parsePortPatternEntry: matches IPv4 LAN address with Metro port', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('192.168.1.5:8081'), '192.168.1.5:8081');
});

test('parsePortPatternEntry: matches Android emulator alias', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('10.0.2.2:8081'), '10.0.2.2:8081');
});

test('parsePortPatternEntry: matches hostname with port', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('antons-macbook.local:8081'), 'antons-macbook.local:8081');
});

test('parsePortPatternEntry: extracts entry from a noisy snapshot blob', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nqaren-test-app\n192.168.1.5:8081\nEnter URL manually';
  assert.equal(parsePortPatternEntry(snapshot), '192.168.1.5:8081');
});

test('parsePortPatternEntry: ignores non-port colons', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('Updated at 11:42 AM'), null);
  assert.equal(parsePortPatternEntry('http://example.com:443/path'), 'example.com:443');
});

test('parsePortPatternEntry: rejects ports < 80 (avoids version strings)', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('react-native:0.76'), null);
  assert.equal(parsePortPatternEntry('v1.2:34'), null);
});

test('parsePortPatternEntry: rejects ports > 65535', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('host:99999'), null);
});

test('parsePortPatternEntry: returns null on empty/null input', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry(''), null);
  assert.equal(parsePortPatternEntry(null), null);
  assert.equal(parsePortPatternEntry(undefined), null);
});

// ── parseFirstServerEntry: orchestrates matcher fallbacks ────────────

test('parseFirstServerEntry: prefers literal localhost when present', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nlocalhost\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), 'localhost');
});

test('parseFirstServerEntry: falls through to port-pattern when no literal IP', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nqaren-test-app\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), '192.168.1.5:8081');
});

test('parseFirstServerEntry: first-non-header fallback when no port-pattern match', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  // Picker variant where the URL is hidden; only the manifest name is visible.
  const snapshot = 'Development servers\nqaren-test-app\nEnter URL manually';
  assert.equal(parseFirstServerEntry(snapshot), 'qaren-test-app');
});

test('parseFirstServerEntry: returns null when no header found', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  assert.equal(parseFirstServerEntry('Welcome screen\nGet started'), null);
});

test('parseFirstServerEntry: skips footer rows in fallback', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nServer-A\nEnter URL manually\nFetch development servers';
  assert.equal(parseFirstServerEntry(snapshot), 'Server-A');
});

// ── parseFirstServerEntry: post-review hardening (Gemini + Codex review) ──

test('parseFirstServerEntry: literal-IP match is whole-line, not substring', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  // Decorative row containing "localhost" as part of a longer string must
  // NOT short-circuit to literal "localhost" — the smarter port-pattern
  // path should win. (Codex P2 / Gemini P1.)
  const snapshot = 'Development servers\nOpen localhost in browser\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), '192.168.1.5:8081');
});

test('parseFirstServerEntry: literal-IP match accepts host:port whole line', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  // A row that's literally "localhost:8081" should still match — the head
  // before the colon is a literal IP, so this is a real localhost entry.
  const snapshot = 'Development servers\nlocalhost:8081';
  assert.equal(parseFirstServerEntry(snapshot), 'localhost:8081');
});

test('parseFirstServerEntry: footer deny-list is case-insensitive', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  // Expo localization or casing change must not leak the footer through
  // the first-non-header fallback. (Codex P2 / Gemini implicit.)
  const snapshot = 'Development servers\nqaren-test-app\nENTER URL MANUALLY';
  assert.equal(parseFirstServerEntry(snapshot), 'qaren-test-app');
});

test('parsePortPatternEntry: rejects version-shape pseudo-hosts', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  // Build/version banners on the picker (e.g., "build v1.2.3:456") must
  // not be returned as tap targets. (Gemini P2.)
  assert.equal(parsePortPatternEntry('build v1.2.3:1234'), null);
  assert.equal(parsePortPatternEntry('v123:456'), null);
});

test('parsePortPatternEntry: still accepts real hostnames alongside version-shapes', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  // After the version-shape filter, a real `host:port` later in the same
  // string is still picked up.
  const text = 'build v1.2.3:1234 server 192.168.1.5:8081';
  assert.equal(parsePortPatternEntry(text), '192.168.1.5:8081');
});

// ── dismissPicker: integration with parseFirstServerEntry ────────────

test('dismissPicker: taps host:port row when picker shows LAN IP', async () => {
  const {
    _setRunAgentDeviceForTest,
    _resetRunAgentDeviceForTest,
    _setFetchCandidatesForTest,
    _resetFetchCandidatesForTest,
    _setPressCandidateForTest,
    _resetPressCandidateForTest,
    _setHasSessionForTest,
    _resetHasSessionForTest,
    dismissPicker,
  } = await import(MOD_PATH);
  _setHasSessionForTest(true);
  let pickerCheckCalls = 0;
  // snapshot still goes through runAgentDeviceFn
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'Development servers\n192.168.1.5:8081' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unhandled' }] };
  });
  // find calls now go through fetchCandidatesFn
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers') {
      pickerCheckCalls++;
      // First call: pre-tap auto-advance probe — picker still showing.
      // Subsequent: waitForBundle — picker is gone after tap.
      if (pickerCheckCalls === 1)
        return { ok: true, candidates: [{ ref: 'e1', label: 'Development servers' }] };
      return { ok: true, candidates: [] };
    }
    if (text === '192.168.1.5:8081') {
      return { ok: true, candidates: [{ ref: 'e2', label: '192.168.1.5:8081' }] };
    }
    return { ok: true, candidates: [] };
  });
  _setPressCandidateForTest(async (_candidate, _action) => {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { pressed: true } }) }],
    };
  });
  try {
    const result = await dismissPicker();
    assert.equal(result.dismissed, true);
    assert.match(result.reason, /192\.168\.1\.5:8081/);
  } finally {
    _resetRunAgentDeviceForTest();
    _resetFetchCandidatesForTest();
    _resetPressCandidateForTest();
    _resetHasSessionForTest();
  }
});

test('dismissPicker: returns dismissed:false with helpful reason when nothing matches', async () => {
  const {
    _setRunAgentDeviceForTest,
    _resetRunAgentDeviceForTest,
    _setFetchCandidatesForTest,
    _resetFetchCandidatesForTest,
    _setHasSessionForTest,
    _resetHasSessionForTest,
    dismissPicker,
  } = await import(MOD_PATH);
  _setHasSessionForTest(true);
  // snapshot goes through runAgentDeviceFn
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'No picker visible' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'no match' }] };
  });
  // find calls: auto-advance probe sees picker showing; no target found after snapshot
  _setFetchCandidatesForTest(async (_text) => {
    if (_text === 'Development servers') {
      // Auto-advance probe — picker still showing so we proceed to snapshot.
      return { ok: true, candidates: [{ ref: 'e1', label: 'Development servers' }] };
    }
    // No server entry found in snapshot text
    return { ok: true, candidates: [] };
  });
  try {
    const result = await dismissPicker();
    assert.equal(result.dismissed, false);
    assert.match(result.reason, /could not find a server entry/i);
  } finally {
    _resetRunAgentDeviceForTest();
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

// ── handleDevClientPicker: auto-advance race detection ───────────────

// ── waitForBundle: cadence — fast-then-slow polling ──────────────────

test('waitForBundle: returns within 500ms when picker dismissed quickly', async () => {
  const { _setFetchCandidatesForTest, _resetFetchCandidatesForTest, waitForBundle } = await import(
    MOD_PATH
  );
  let calls = 0;
  _setFetchCandidatesForTest(async (_text) => {
    calls++;
    // First call (~100ms in): still loading. Second call (~200ms in): bundle loaded.
    if (calls < 2) return { ok: true, candidates: [{ ref: 'e1', label: 'Development servers' }] };
    return { ok: true, candidates: [] };
  });
  try {
    const start = Date.now();
    await waitForBundle();
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 500,
      `waitForBundle should complete fast in single-server case; took ${elapsed}ms`,
    );
    assert.ok(calls >= 2, `waitForBundle should poll at least twice; saw ${calls} calls`);
  } finally {
    _resetFetchCandidatesForTest();
  }
});

test('waitForBundle: bounded by ~10s wall-clock budget', async () => {
  const { _setFetchCandidatesForTest, _resetFetchCandidatesForTest, waitForBundle } = await import(
    MOD_PATH
  );
  // Always-loading mock: picker text always present.
  _setFetchCandidatesForTest(async () => ({
    ok: true,
    candidates: [{ ref: 'e1', label: 'Development servers' }],
  }));
  try {
    const start = Date.now();
    await waitForBundle();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 12_000, `waitForBundle should give up within ~10s; took ${elapsed}ms`);
  } finally {
    _resetFetchCandidatesForTest();
  }
});

test('handleDevClientPicker: returns success without tap when picker auto-advances mid-flight', async () => {
  const {
    _setRunAgentDeviceForTest,
    _resetRunAgentDeviceForTest,
    _setFetchCandidatesForTest,
    _resetFetchCandidatesForTest,
    _setHasSessionForTest,
    _resetHasSessionForTest,
    handleDevClientPicker,
  } = await import(MOD_PATH);
  let detectCalls = 0;
  _setHasSessionForTest(true);
  // snapshot should not be reached in auto-advance case
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'No picker visible' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unexpected call' }] };
  });
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers') {
      detectCalls++;
      // First call: picker visible (handleDevClientPicker proceeds to dismissPicker).
      // Second call (re-check inside dismissPicker.isDevClientPickerShowing): picker gone.
      if (detectCalls === 1)
        return { ok: true, candidates: [{ ref: 'e1', label: 'Development servers' }] };
      return { ok: true, candidates: [] };
    }
    return { ok: true, candidates: [] };
  });
  try {
    const result = await handleDevClientPicker();
    assert.equal(result?.dismissed, true);
    assert.match(result?.reason ?? '', /auto-advanced/i);
  } finally {
    _resetRunAgentDeviceForTest();
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});
