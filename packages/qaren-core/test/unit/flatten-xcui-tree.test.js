import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXCUITree } from '../../dist/fast-runner-ref-map.js';

// Task 4 (issue #105): flattenXCUITree() — depth-first walk over an XCUI
// tree dict, emitting a flat FlatNode[] with stable @eN refs + a Map<ref,
// rect> for cached coord lookup. Pure function, no I/O, deterministic.

const sampleTree = {
  type: 'Application',
  frame: { x: 0, y: 0, width: 393, height: 852 },
  enabled: true,
  hittable: false,
  children: [
    {
      type: 'Window',
      frame: { x: 0, y: 0, width: 393, height: 852 },
      enabled: true,
      hittable: false,
      children: [
        {
          type: 'Button',
          identifier: 'task-mark-all-done',
          label: 'Mark all done',
          frame: { x: 16, y: 200, width: 361, height: 44 },
          enabled: true,
          hittable: true,
        },
        {
          type: 'StaticText',
          label: 'Tasks',
          frame: { x: 16, y: 60, width: 100, height: 30 },
          enabled: true,
          hittable: false,
        },
      ],
    },
  ],
};

test('flattenXCUITree: produces FlatNode array with stable refs', () => {
  const { nodes } = flattenXCUITree(sampleTree);
  // Depth-first: Application(@e0) → Window(@e1) → Button(@e2) → StaticText(@e3)
  assert.equal(nodes.length, 4);
  assert.deepEqual(
    nodes.map((n) => n.ref),
    ['@e0', '@e1', '@e2', '@e3'],
  );
  assert.equal(nodes[0].type, 'Application');
  assert.equal(nodes[1].type, 'Window');
  assert.equal(nodes[2].type, 'Button');
  assert.equal(nodes[2].identifier, 'task-mark-all-done');
  assert.equal(nodes[2].label, 'Mark all done');
  assert.equal(nodes[2].hittable, true);
  assert.equal(nodes[3].type, 'StaticText');
  assert.equal(nodes[3].label, 'Tasks');
});

test('flattenXCUITree: builds refMap keyed by ref → rect', () => {
  const { refMap } = flattenXCUITree(sampleTree);
  assert.equal(refMap.size, 4);
  // refMap is keyed by the bare id (no @ prefix) to match updateRefMap convention
  assert.deepEqual(refMap.get('e2'), { x: 16, y: 200, width: 361, height: 44 });
  assert.deepEqual(refMap.get('e3'), { x: 16, y: 60, width: 100, height: 30 });
});

test('flattenXCUITree: empty tree returns empty arrays', () => {
  const { nodes, refMap } = flattenXCUITree({});
  assert.equal(nodes.length, 0);
  assert.equal(refMap.size, 0);
});

test('flattenXCUITree: skips nodes without frame', () => {
  const treeWithMissingFrame = {
    type: 'Application',
    frame: { x: 0, y: 0, width: 393, height: 852 },
    children: [
      {
        // No frame — should be skipped, but children still descended
        type: 'Group',
        children: [
          {
            type: 'Button',
            label: 'Submit',
            frame: { x: 10, y: 10, width: 80, height: 40 },
          },
        ],
      },
      {
        type: 'StaticText',
        label: 'After',
        frame: { x: 0, y: 100, width: 50, height: 20 },
      },
    ],
  };
  const { nodes } = flattenXCUITree(treeWithMissingFrame);
  // Application + Button + StaticText (Group has no frame, skipped)
  assert.equal(nodes.length, 3);
  assert.deepEqual(
    nodes.map((n) => n.type),
    ['Application', 'Button', 'StaticText'],
  );
  // Refs remain @e0/@e1/@e2 (frame-less nodes don't consume a ref slot)
  assert.deepEqual(
    nodes.map((n) => n.ref),
    ['@e0', '@e1', '@e2'],
  );
});
