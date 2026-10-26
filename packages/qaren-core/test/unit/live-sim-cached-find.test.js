// Live-sim speedup (GH #321): device_find reuses a valid snapshot cache instead
// of issuing a redundant runner snapshot — but re-snapshots once the cache is
// invalidated by a mutating verb. This verifies the BEHAVIOR end-to-end through
// fetchFindCandidates by counting runner dispatches.
//
// Uses the one-shot _setRunAgentDeviceForTest fuse, so it lives in its own file
// (node --test isolates per file) and installs the override before any dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setRunAgentDeviceForTest,
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
  cacheSnapshot,
  markSnapshotDirty,
} from '../../dist/agent-device-wrapper.js';
import { fetchFindCandidates } from '../../dist/handlers/device-interact.js';

const NODES = [
  {
    ref: '@e0',
    label: 'Continue',
    identifier: 'continue-btn',
    type: 'Button',
    hittable: true,
    rect: { x: 10, y: 20, width: 100, height: 40 },
  },
];

function envelope(nodes) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes } }) }] };
}

test('device_find serves from a valid cache without a runner snapshot; re-snapshots after a mutation', async () => {
  let snapshotDispatches = 0;
  _setRunAgentDeviceForTest((cliArgs) => {
    if (cliArgs[0] === 'snapshot') snapshotDispatches++;
    return Promise.resolve(envelope(NODES));
  });
  setActiveSessionInMemoryForTest({
    name: 't',
    platform: 'ios',
    appId: 'com.test',
    openedAt: 'now',
  });

  try {
    // Prime a clean cache (as a real snapshot would).
    cacheSnapshot('ios', NODES);

    // 1st find: cache is valid -> NO runner dispatch.
    const a = await fetchFindCandidates('Continue', false, true);
    assert.equal(a.ok, true);
    assert.equal(a.candidates[0].label, 'Continue');
    assert.deepEqual(a.provenance, {
      source: 'cache',
      originAuthority: 'not-proven',
    });
    assert.equal(snapshotDispatches, 0, 'a valid cache must not trigger a runner snapshot');

    // 2nd find: still clean -> still NO dispatch.
    await fetchFindCandidates('Continue', false, true);
    assert.equal(snapshotDispatches, 0, 'repeated finds on an unchanged screen stay cache-served');

    // A mutating verb happened -> cache is stale-by-content.
    markSnapshotDirty();

    // 3rd find: cache invalid -> exactly one fresh runner snapshot.
    const c = await fetchFindCandidates('Continue', false, true);
    assert.equal(c.ok, true);
    assert.deepEqual(c.provenance, {
      source: 'fresh',
      originAuthority: 'not-proven',
    });
    assert.equal(snapshotDispatches, 1, 'a mutation must force a fresh snapshot');
  } finally {
    _setRunAgentDeviceForTest(null);
    resetActiveSessionInMemoryForTest();
  }
});

test('device_find with allowCache=false always re-snapshots (no behavior change for non-find callers)', async () => {
  let snapshotDispatches = 0;
  _setRunAgentDeviceForTest((cliArgs) => {
    if (cliArgs[0] === 'snapshot') snapshotDispatches++;
    return Promise.resolve(envelope(NODES));
  });
  setActiveSessionInMemoryForTest({
    name: 't',
    platform: 'ios',
    appId: 'com.test',
    openedAt: 'now',
  });

  try {
    cacheSnapshot('ios', NODES); // even with a valid cache present...
    await fetchFindCandidates('Continue', false, false); // ...allowCache=false ignores it
    assert.equal(snapshotDispatches, 1, 'allowCache=false must always take a fresh snapshot');
  } finally {
    _setRunAgentDeviceForTest(null);
    resetActiveSessionInMemoryForTest();
  }
});
