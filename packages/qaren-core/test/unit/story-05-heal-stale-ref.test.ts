import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { healStaleRef, selfHealEnabled } from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { okResult, failResult } from '../../dist/utils.js';

const rect = (y) => ({ x: 0, y, width: 100, height: 40 });
const oldNodes = [
  { ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn', rect: rect(0) },
  { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(50) },
];
// Replicates the real runIOS/runAndroid snapshot side effect: the snapshot
// REPLACES the ref-map before healStaleRef sees the nodes. This makes the
// capture-signature/metadata-BEFORE-snapshot ordering load-bearing in these
// tests — a swapped implementation would read the fresh map and fail them.
const snapshotOf = (nodes) => async () => {
  updateRefMapFromFlat(nodes);
  return okResult({ nodes });
};
const parse = (r) => JSON.parse(r.content[0].text);

beforeEach(() => clearRefMap());

test('selfHealEnabled: default on, RN_SELF_HEAL=0/false off', () => {
  assert.equal(selfHealEnabled({}), true);
  assert.equal(selfHealEnabled({ RN_SELF_HEAL: '1' }), true);
  assert.equal(selfHealEnabled({ RN_SELF_HEAL: '0' }), false);
  assert.equal(selfHealEnabled({ RN_SELF_HEAL: 'false' }), false);
});

test('unique re-resolution → healed with recomputed center + new ref', async () => {
  updateRefMapFromFlat(oldNodes);
  const fresh = [
    { ref: '@e0', type: 'Other', label: 'Header', rect: rect(0) },
    {
      ref: '@e1',
      type: 'Button',
      label: 'Save',
      identifier: 'save-btn',
      rect: { x: 20, y: 300, width: 100, height: 40 },
    },
  ];
  const out = await healStaleRef('@e0', snapshotOf(fresh));
  assert.equal(out.kind, 'healed');
  assert.equal(out.x, 70); // 20 + 100/2
  assert.equal(out.y, 320); // 300 + 40/2
  assert.equal(out.newRef, '@e1');
  assert.equal(typeof out.ms, 'number');
});

test('ambiguous → failed TARGET_AMBIGUOUS with candidates (≤5) and pre-snapshot cachedMetadata', async () => {
  updateRefMapFromFlat(oldNodes);
  const dupe = (ref, y) => ({
    ref,
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
    rect: rect(y),
  });
  // Fresh @e0 has a DIFFERENT identity than the old @e0 so the cachedMetadata
  // assertion below proves pre-snapshot capture: read after the snapshot's
  // ref-map replacement, it would be Other/Header and deepEqual would fail.
  const fresh = [
    { ref: '@e0', type: 'Other', label: 'Header', rect: rect(0) },
    dupe('@e1', 50),
    dupe('@e2', 100),
    dupe('@e3', 150),
    dupe('@e4', 200),
    dupe('@e5', 250),
    dupe('@e6', 300),
  ];
  const out = await healStaleRef('@e0', snapshotOf(fresh));
  assert.equal(out.kind, 'failed');
  const env = parse(out.result);
  // Envelope shape (src/utils.ts failResult): { ok:false, error, code, meta }.
  // reResolution/candidates/cachedMetadata live under meta, not data.
  assert.equal(env.code, 'TARGET_AMBIGUOUS');
  assert.equal(env.meta.reResolution, 'ambiguous');
  assert.equal(env.meta.candidates.length, 5);
  assert.deepEqual(env.meta.cachedMetadata, {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
  });
});

test('absent → failed STALE_REF with empty candidates', async () => {
  updateRefMapFromFlat(oldNodes);
  const out = await healStaleRef('@e0', snapshotOf([{ ref: '@e0', type: 'Other', rect: rect(0) }]));
  assert.equal(out.kind, 'failed');
  const env = parse(out.result);
  assert.equal(env.code, 'STALE_REF');
  assert.equal(env.meta.reResolution, 'absent');
  assert.deepEqual(env.meta.candidates, []);
});

test('no cached signature → failed no-signature without calling snapshot', async () => {
  let called = false;
  const out = await healStaleRef('@e9', async () => {
    called = true;
    return okResult({ nodes: [] });
  });
  assert.equal(out.kind, 'failed');
  assert.equal(called, false);
  assert.equal(parse(out.result).meta.reResolution, 'no-signature');
});

test('snapshot infra failure → failed snapshot-failed (does not mask as absent)', async () => {
  updateRefMapFromFlat(oldNodes);
  const out = await healStaleRef('@e0', async () =>
    failResult('runner gone', 'RN_FAST_RUNNER_DOWN'),
  );
  assert.equal(out.kind, 'failed');
  assert.equal(parse(out.result).meta.reResolution, 'snapshot-failed');
});

test('snapshot closure rejection (throws) → failed snapshot-failed, never propagates', async () => {
  updateRefMapFromFlat(oldNodes);
  const out = await healStaleRef('@e0', async () => {
    throw new Error('runner exploded mid-snapshot');
  });
  assert.equal(out.kind, 'failed');
  assert.equal(parse(out.result).meta.reResolution, 'snapshot-failed');
});
