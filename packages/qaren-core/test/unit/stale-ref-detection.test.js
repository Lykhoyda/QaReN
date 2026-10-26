import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateRefMapFromFlat,
  getCachedMetadata,
  isRefStale,
  findNewRefByMetadata,
  clearRefMap,
} from '../../dist/fast-runner-ref-map.js';

// Task 5 (issue #105): stale-ref detection — after each snapshot we cache
// per-ref metadata ({type, identifier, label}) alongside the rect map.
// On the next snapshot, callers can ask:
//   isRefStale(ref, newNodes)        — does the element at this ref still match?
//   findNewRefByMetadata(oldRef, …)  — search the new snapshot for the cached id
// Powers the STALE_REF contract in §3.6 of the design spec.

const initialNodes = [
  {
    ref: '@e0',
    type: 'Application',
    rect: { x: 0, y: 0, width: 393, height: 852 },
  },
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
];

test('updateRefMapFromFlat: stores metadata per ref', () => {
  clearRefMap();
  updateRefMapFromFlat(initialNodes);
  assert.deepEqual(getCachedMetadata('@e1'), {
    type: 'Button',
    identifier: 'task-mark-all-done',
    label: 'Mark all done',
  });
  // Bare ref form (no @) also resolves
  assert.deepEqual(getCachedMetadata('e2'), {
    type: 'StaticText',
    label: 'Tasks',
  });
  // Unknown ref returns null
  assert.equal(getCachedMetadata('@e99'), null);
});

test('isRefStale: false when metadata still matches new snapshot at same ref', () => {
  clearRefMap();
  updateRefMapFromFlat(initialNodes);

  // A new snapshot where @e1 still points to the same Button (no drift)
  const newNodes = initialNodes.map((n) => ({ ...n }));
  assert.equal(isRefStale('@e1', newNodes), false);
});

test('isRefStale: true when metadata at ref differs', () => {
  clearRefMap();
  updateRefMapFromFlat(initialNodes);

  // A new snapshot where @e1 now resolves to a different element
  // (the button was removed; another element now occupies that ref slot)
  const drifted = [
    initialNodes[0],
    {
      ref: '@e1',
      type: 'StaticText',
      label: 'No tasks yet',
      rect: { x: 16, y: 200, width: 361, height: 44 },
    },
  ];
  assert.equal(isRefStale('@e1', drifted), true);

  // Also true when the ref no longer exists in the new snapshot at all
  assert.equal(isRefStale('@e2', drifted), true);
});

test('findNewRefByMetadata: returns new ref when cached identifier exists in new snapshot', () => {
  clearRefMap();
  updateRefMapFromFlat(initialNodes);

  // A new snapshot where the same Button moved to a different ref slot
  // (it now appears later in the tree, so it got @e5 instead of @e1)
  const reshuffled = [
    { ref: '@e0', type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
    { ref: '@e1', type: 'Window', rect: { x: 0, y: 0, width: 393, height: 852 } },
    {
      ref: '@e2',
      type: 'StaticText',
      label: 'Header',
      rect: { x: 0, y: 0, width: 100, height: 30 },
    },
    { ref: '@e3', type: 'View', rect: { x: 0, y: 100, width: 393, height: 100 } },
    {
      ref: '@e4',
      type: 'StaticText',
      label: 'Section',
      rect: { x: 0, y: 150, width: 100, height: 30 },
    },
    {
      ref: '@e5',
      type: 'Button',
      identifier: 'task-mark-all-done',
      label: 'Mark all done',
      rect: { x: 16, y: 400, width: 361, height: 44 },
    },
  ];
  assert.equal(findNewRefByMetadata('@e1', reshuffled), '@e5');
});

test('findNewRefByMetadata: returns null when cached identifier no longer in tree', () => {
  clearRefMap();
  updateRefMapFromFlat(initialNodes);

  // A new snapshot that doesn't contain the cached button at all
  const withoutButton = [
    { ref: '@e0', type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
    {
      ref: '@e1',
      type: 'StaticText',
      label: 'No tasks',
      rect: { x: 16, y: 60, width: 100, height: 30 },
    },
  ];
  assert.equal(findNewRefByMetadata('@e1', withoutButton), null);

  // Unknown source ref → null (we have no cached metadata for it)
  assert.equal(findNewRefByMetadata('@e99', withoutButton), null);
});

test('Android flat nodes reuse generic stale-ref detection', () => {
  clearRefMap();

  updateRefMapFromFlat([
    {
      ref: '@e1',
      type: 'android.widget.TextView',
      identifier: 'tab-home',
      label: 'Home',
      rect: { x: 0, y: 1800, width: 200, height: 100 },
    },
  ]);

  assert.equal(
    isRefStale('@e1', [
      {
        ref: '@e1',
        type: 'android.widget.TextView',
        identifier: 'tab-home',
        label: 'Home',
        rect: { x: 0, y: 1800, width: 200, height: 100 },
      },
    ]),
    false,
  );

  assert.equal(
    isRefStale('@e1', [
      {
        ref: '@e1',
        type: 'android.widget.TextView',
        identifier: 'tab-settings',
        label: 'Settings',
        rect: { x: 0, y: 1800, width: 200, height: 100 },
      },
    ]),
    true,
  );

  assert.equal(
    findNewRefByMetadata('@e1', [
      {
        ref: '@e8',
        type: 'android.widget.TextView',
        identifier: 'tab-home',
        label: 'Home',
        rect: { x: 400, y: 1800, width: 200, height: 100 },
      },
    ]),
    '@e8',
  );
});
