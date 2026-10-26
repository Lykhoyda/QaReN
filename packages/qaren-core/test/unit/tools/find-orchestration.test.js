import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInLatestSnapshot } from '../../../dist/handlers/device-interact.js';

// Task 6 (GH #105 / rn-device iOS-MVP): TS implementation of `find`.
// Pure-function search over flat-node snapshots. Used by device_find when
// the iOS path no longer rides the external CLI's fuzzy matcher.
//
// Match priority:
//   1. Exact label OR identifier (first node in traversal order wins).
//   2. Substring on label OR identifier (only if no exact match found).
// Returns null when no match; null also when exact:true + no exact hit.

const sampleNodes = [
  { ref: '@e0', type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
  {
    ref: '@e1',
    type: 'Button',
    identifier: 'task-mark-all-done',
    label: 'Mark all done',
    rect: { x: 16, y: 200, width: 361, height: 44 },
    hittable: true,
  },
  {
    ref: '@e2',
    type: 'StaticText',
    label: 'Tasks',
    rect: { x: 16, y: 60, width: 100, height: 30 },
  },
  {
    ref: '@e3',
    type: 'Button',
    identifier: 'task-delete',
    label: 'Delete task',
    rect: { x: 16, y: 250, width: 361, height: 44 },
    hittable: true,
  },
  {
    ref: '@e4',
    type: 'StaticText',
    label: 'Mark all done as completed',
    rect: { x: 16, y: 300, width: 200, height: 20 },
  },
];

test('findInLatestSnapshot: exact label match returns first node', () => {
  const found = findInLatestSnapshot(sampleNodes, 'Mark all done');
  assert.ok(found);
  assert.equal(found.ref, '@e1');
  assert.equal(found.label, 'Mark all done');
});

test('findInLatestSnapshot: exact identifier match returns the node', () => {
  const found = findInLatestSnapshot(sampleNodes, 'task-delete');
  assert.ok(found);
  assert.equal(found.ref, '@e3');
  assert.equal(found.identifier, 'task-delete');
});

test('findInLatestSnapshot: substring match falls through when no exact match', () => {
  // "Delete" is a substring of "Delete task" (label on @e3) and "task-delete"
  // (identifier on @e3). No exact match exists, so substring wins.
  const found = findInLatestSnapshot(sampleNodes, 'Delete');
  assert.ok(found);
  assert.equal(found.ref, '@e3');
});

test('findInLatestSnapshot: exact:true rejects substring match and returns null', () => {
  // "Delete" only appears as substring — no node has label === "Delete" or
  // identifier === "Delete". With exact:true the substring fallback is skipped.
  const found = findInLatestSnapshot(sampleNodes, 'Delete', { exact: true });
  assert.equal(found, null);

  // Sanity: exact:true with a literal match still works.
  const exact = findInLatestSnapshot(sampleNodes, 'Mark all done', { exact: true });
  assert.ok(exact);
  assert.equal(exact.ref, '@e1');
});

test('findInLatestSnapshot: Android testID identifier wins over text fallback', () => {
  const nodes = [
    {
      ref: '@e1',
      type: 'android.widget.TextView',
      identifier: 'tab-home',
      label: 'Home',
      rect: { x: 0, y: 0, width: 100, height: 50 },
    },
    {
      ref: '@e2',
      type: 'android.widget.TextView',
      identifier: 'tab-settings',
      label: 'Home',
      rect: { x: 100, y: 0, width: 100, height: 50 },
    },
  ];
  const found = findInLatestSnapshot(nodes, 'tab-home', { exact: true });
  assert.equal(found.ref, '@e1');
});
