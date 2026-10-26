import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateRefMapFromFlat,
  clearRefMap,
  getCachedSignature,
  getCachedMetadata,
  getLastSnapshotHash,
  invalidateLastSnapshotHash,
  lookupRef,
} from '../../dist/fast-runner-ref-map.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';

const rect = (x = 0, y = 0) => ({ x, y, width: 100, height: 40 });
const nodes = [
  { ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn', rect: rect(0, 0) },
  { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(0, 50) },
  { ref: '@e2', type: 'TextField', identifier: 'name-input', rect: rect(0, 100) },
];

beforeEach(() => clearRefMap());

test('getCachedSignature returns identity attributes', () => {
  updateRefMapFromFlat(nodes);
  assert.deepEqual(getCachedSignature('@e1'), {
    type: 'Button',
    label: 'Cancel',
  });
  assert.deepEqual(getCachedSignature('e0'), {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
  });
});

test('getCachedSignature returns null for unknown ref and after clear', () => {
  updateRefMapFromFlat(nodes);
  assert.equal(getCachedSignature('@e99'), null);
  clearRefMap();
  assert.equal(getCachedSignature('@e0'), null);
});

test('getCachedMetadata keeps its exact legacy 3-field shape', () => {
  updateRefMapFromFlat(nodes);
  assert.deepEqual(getCachedMetadata('@e0'), {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
  });
});

test('getLastSnapshotHash matches hashSnapshotNodes of the fed nodes; null after clear', () => {
  assert.equal(getLastSnapshotHash(), null);
  updateRefMapFromFlat(nodes);
  assert.equal(getLastSnapshotHash(), hashSnapshotNodes(nodes));
  clearRefMap();
  assert.equal(getLastSnapshotHash(), null);
});

test('invalidateLastSnapshotHash nulls the baseline without touching refs', () => {
  updateRefMapFromFlat(nodes);
  invalidateLastSnapshotHash();
  assert.equal(getLastSnapshotHash(), null);
  assert.notEqual(getCachedSignature('@e0'), null); // refs still resolvable
});

// Story 05 acceptance (re-render case): a settle-refresh REPLACES the ref map,
// but ids absent from the new snapshot are positional and cannot collide — their
// signatures must survive so a later stale tap can still heal by identity.
test('retains signatures for non-colliding ids across updates', () => {
  updateRefMapFromFlat(nodes); // gen 1: @e0..@e2, nodeCount 3
  const sparse = [{ ref: '@e0', type: 'Other', label: 'Header', rect: rect(0, 0) }];
  updateRefMapFromFlat(sparse); // gen 2: only @e0, nodeCount 1

  assert.deepEqual(getCachedSignature('@e2'), {
    type: 'TextField',
    identifier: 'name-input',
  });
  assert.deepEqual(getCachedSignature('@e0'), {
    type: 'Other',
    label: 'Header',
  });
  // Coordinates are NOT retained — only the CURRENT snapshot is tappable
  assert.equal(lookupRef('@e2'), null);
  // Hash baseline tracks the newest update
  assert.equal(getLastSnapshotHash(), hashSnapshotNodes(sparse));
});

test('clearRefMap drops retained signatures too', () => {
  updateRefMapFromFlat(nodes);
  updateRefMapFromFlat([{ ref: '@e0', type: 'Other', label: 'Header', rect: rect(0, 0) }]);
  clearRefMap();
  assert.equal(getCachedSignature('@e2'), null); // retained entry gone
  assert.equal(getCachedSignature('@e0'), null); // current entry gone
});

test('malformed entries do not replace valid signatures or break hashing', () => {
  const withMalformed = [
    { ref: '@e0', type: 'Button', label: 'Save', rect: rect(0, 0) },
    { ref: '', type: 'Other', rect: undefined },
    { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(0, 50) },
  ];
  updateRefMapFromFlat(withMalformed);
  assert.equal(getCachedSignature('@e1').label, 'Cancel');
  assert.equal(typeof getLastSnapshotHash(), 'string'); // hash of the two valid nodes, no throw
});
