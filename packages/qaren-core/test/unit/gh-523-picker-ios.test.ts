// GH #523 sub-3: iOS support for the dev-client picker auto-dismiss.
// The iOS short-circuit dated from the legacy agent-device daemon (D1219);
// every primitive the picker needs (snapshot -i, press @ref) now routes
// through rn-fast-runner on iOS, so the guard costs a manual session-open +
// snapshot + row tap on every relaunch (3× in one #523 session). Also covers
// the stale-server "Error loading app" dialog and entry-preference rules.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDevClientPickerIfPresent,
  parseFirstServerEntry,
  _setRunAgentDeviceForTest,
  _setHasSessionForTest,
  _resetRunAgentDeviceForTest,
  _resetHasSessionForTest,
  _setFetchCandidatesForTest,
  _resetFetchCandidatesForTest,
  _setPressCandidateForTest,
  _resetPressCandidateForTest,
} from '../../dist/handlers/dev-client-picker.js';

afterEach(() => {
  _resetRunAgentDeviceForTest();
  _resetHasSessionForTest();
  _resetFetchCandidatesForTest();
  _resetPressCandidateForTest();
});

function envelope(nodes) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes } }) }] };
}

const PICKER_NODES = [
  { label: 'Development servers', rect: { x: 0, y: 100, width: 390, height: 40 } },
  { label: '192.168.1.7:8081', rect: { x: 0, y: 140, width: 390, height: 60 } },
];

// ── entry preference rules (pure parser) ───────────────────────────────

test('parser: link-local (169.254.x) entries are deprioritized', () => {
  const out = parseFirstServerEntry('Development servers\n169.254.12.34:8081\n192.168.1.7:8081');
  assert.equal(out, '192.168.1.7:8081');
});

test('parser: entry matching the preferred Metro port wins', () => {
  const out = parseFirstServerEntry(
    'Development servers\n192.168.1.7:19000\n192.168.1.7:8081',
    8081,
  );
  assert.equal(out, '192.168.1.7:8081');
});

test('parser: preferred Metro port refuses multiple distinct endpoints', () => {
  const out = parseFirstServerEntry('Development servers\n192.168.1.7:8081\n10.0.2.2:8081', 8081);
  assert.equal(out, null);
});

test('authority helper refuses to select a picker row without an exact Metro port', async () => {
  _setHasSessionForTest(true);
  try {
    const out = await clearDevClientPickerIfPresent('ios');
    assert.equal(out?.dismissed, false);
    assert.match(out?.reason ?? '', /Exact authority-bound Metro port/);
  } finally {
    _resetHasSessionForTest();
  }
});

test('parser: link-local is still used when it is the only entry', () => {
  const out = parseFirstServerEntry('Development servers\n169.254.12.34:8081');
  assert.equal(out, '169.254.12.34:8081');
});

// ── iOS flow ───────────────────────────────────────────────────────────

test('iOS: picker is detected and dismissed (short-circuit removed)', async () => {
  _setHasSessionForTest(true);
  let tapped = false;
  const findQueries = [];
  _setFetchCandidatesForTest(async (q) => {
    findQueries.push(q);
    if (q === 'Development servers' || q === 'DEVELOPMENT SERVERS') {
      return { ok: true, candidates: tapped ? [] : [{ ref: 'r1', label: 'Development servers' }] };
    }
    if (q === '192.168.1.7:8081') {
      return { ok: true, candidates: [{ ref: 'r2', label: q }] };
    }
    return { ok: true, candidates: [] };
  });
  _setPressCandidateForTest(async () => {
    tapped = true;
    return { content: [{ type: 'text', text: '{}' }] };
  });
  _setRunAgentDeviceForTest(async () => envelope(PICKER_NODES));

  const out = await clearDevClientPickerIfPresent('ios', 8081);

  assert.equal(out.dismissed, true);
  assert.equal(out.platform, 'ios');
  assert.ok(!out.skipped, 'iOS must no longer be skipped');
  assert.ok(findQueries.includes('192.168.1.7:8081'), 'server row resolved from snapshot labels');
});

test('iOS: JSON-envelope snapshots resolve node labels, not raw-JSON fragments', async () => {
  // The envelope text contains `"y":100` before any server label — a raw-text
  // regex scan would match host "y", port 100 and tap garbage.
  _setHasSessionForTest(true);
  let tapped = false;
  const pressed = [];
  _setFetchCandidatesForTest(async (q) => {
    if (q === 'Development servers' || q === 'DEVELOPMENT SERVERS') {
      return { ok: true, candidates: tapped ? [] : [{ ref: 'r1', label: 'Development servers' }] };
    }
    return { ok: true, candidates: [{ ref: `ref:${q}`, label: q }] };
  });
  _setPressCandidateForTest(async (candidate) => {
    pressed.push(candidate.label);
    tapped = true;
    return { content: [{ type: 'text', text: '{}' }] };
  });
  _setRunAgentDeviceForTest(async () => envelope(PICKER_NODES));

  const out = await clearDevClientPickerIfPresent('ios', 8081);

  assert.equal(out.dismissed, true);
  assert.deepEqual(pressed, ['192.168.1.7:8081'], 'must tap the label, not a JSON fragment');
});

test('iOS: no active session returns null (NO_SESSION), not a skip', async () => {
  _setHasSessionForTest(false);
  const out = await clearDevClientPickerIfPresent('ios', 8081);
  assert.equal(out, null);
});

test('iOS: nothing on screen — clean not-detected result without snapshots', async () => {
  _setHasSessionForTest(true);
  const snapshots = [];
  _setRunAgentDeviceForTest(async (args) => {
    snapshots.push(args);
    return envelope([]);
  });
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));

  const out = await clearDevClientPickerIfPresent('ios', 8081);

  assert.equal(out.dismissed, false);
  assert.equal(out.platform, 'ios');
  assert.match(out.reason, /not detected/i);
  assert.equal(snapshots.length, 0, 'no snapshot when no picker/dialog is present');
});

// ── stale-server error dialog (GH #523 sub-3, second half) ─────────────

test('iOS: stale-server error dialog is dismissed, then the picker row is tapped', async () => {
  _setHasSessionForTest(true);
  let dialogGone = false;
  let serverTapped = false;
  _setFetchCandidatesForTest(async (q) => {
    if (q === 'Development servers' || q === 'DEVELOPMENT SERVERS') {
      return {
        ok: true,
        candidates:
          dialogGone && !serverTapped ? [{ ref: 'p1', label: 'Development servers' }] : [],
      };
    }
    if (q === 'Error loading app') {
      return {
        ok: true,
        candidates: dialogGone ? [] : [{ ref: 'e1', label: 'Error loading app' }],
      };
    }
    if (q === 'Dismiss') {
      return { ok: true, candidates: dialogGone ? [] : [{ ref: 'd1', label: 'Dismiss' }] };
    }
    if (q === '192.168.1.7:8081') {
      return { ok: true, candidates: [{ ref: 's1', label: q }] };
    }
    return { ok: true, candidates: [] };
  });
  _setPressCandidateForTest(async (candidate) => {
    if (candidate.ref === 'd1') dialogGone = true;
    else serverTapped = true;
    return { content: [{ type: 'text', text: '{}' }] };
  });
  _setRunAgentDeviceForTest(async () => envelope(PICKER_NODES));

  const out = await clearDevClientPickerIfPresent('ios', 8081);

  assert.equal(out.dismissed, true);
  assert.match(out.reason, /error dialog/i);
  assert.equal(serverTapped, true, 'server entry tapped after the dialog was cleared');
});

test('iOS: error dialog with no picker afterwards still reports success', async () => {
  _setHasSessionForTest(true);
  let dialogGone = false;
  _setFetchCandidatesForTest(async (q) => {
    if (q === 'Error loading app') {
      return {
        ok: true,
        candidates: dialogGone ? [] : [{ ref: 'e1', label: 'Error loading app' }],
      };
    }
    if (q === 'Dismiss') {
      return { ok: true, candidates: dialogGone ? [] : [{ ref: 'd1', label: 'Dismiss' }] };
    }
    return { ok: true, candidates: [] };
  });
  _setPressCandidateForTest(async () => {
    dialogGone = true;
    return { content: [{ type: 'text', text: '{}' }] };
  });

  const out = await clearDevClientPickerIfPresent('ios', 8081);

  assert.equal(out.dismissed, true);
  assert.match(out.reason, /error dialog/i);
});
