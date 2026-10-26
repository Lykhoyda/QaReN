// Task 8 — Anchor capture into resolveLadder's bundle.
// A no-testID host Text nested under a Pressable testID="task-row-3" under a
// View must yield bundle.anchors nearest-first with the Pressable at index 0,
// provenance "authored-testID". Ancestors with neither testID nor accessible
// name are skipped. provenance falls back to "text" (via __accessibleName or
// host text) when the ancestor has no testID/nativeID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Buy milk (host Text, no testID) < Pressable testID=task-row-3 < View
function buildTaskRow() {
  return buildFiber({
    name: 'View',
    children: [
      {
        name: 'Pressable',
        props: { testID: 'task-row-3' },
        children: [{ hostType: 'Text', children: [{ text: 'Buy milk' }] }],
      },
    ],
  });
}

// Returns the deepest fiber (the matched leaf) by walking child-first.
function deepestChild(fiber) {
  let cur = fiber;
  while (cur && cur.child) cur = cur.child;
  return cur;
}

test('__collectAnchors: nearest authored testID ancestor at index 0', () => {
  const root = buildTaskRow();
  const sb = createSandbox({ fiberRoot: root });
  const leaf = deepestChild(root); // the raw "Buy milk" text fiber
  const anchors = sb.__QAREN.__collectAnchors(leaf);

  assert.ok(Array.isArray(anchors));
  assert.ok(anchors.length >= 1);
  // Nearest authored anchor (the Pressable) is first.
  assert.equal(anchors[0].testID, 'task-row-3');
  assert.equal(anchors[0].provenance, 'authored-testID');
  assert.equal(anchors[0].relation, 'childOf');
  assert.equal(typeof anchors[0].depth, 'number');
  assert.ok(anchors[0].depth >= 1);
});

test('resolveLadder: bundle.anchors[0] is the authored-testID Pressable', () => {
  const root = buildTaskRow();
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify({ text: 'Buy milk' })));
  assert.equal(res.found, true);
  assert.ok(Array.isArray(res.bundle.anchors));
  assert.equal(res.bundle.anchors[0].testID, 'task-row-3');
  assert.equal(res.bundle.anchors[0].provenance, 'authored-testID');
  assert.equal(res.bundle.anchors[0].relation, 'childOf');
});

test('__collectAnchors: text-provenance ancestor when no testID/nativeID', () => {
  // Inner host Text "Done" < Pressable (accessibilityLabel, NO testID) < View
  const root = buildFiber({
    name: 'View',
    children: [
      {
        name: 'Pressable',
        props: { accessibilityLabel: 'Complete task' },
        children: [{ hostType: 'Text', children: [{ text: 'Done' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const leaf = deepestChild(root);
  const anchors = sb.__QAREN.__collectAnchors(leaf);
  const labelled = anchors.find((a) => a.text === 'Complete task');
  assert.ok(labelled, 'expected a text-provenance anchor for the labelled Pressable');
  assert.equal(labelled.provenance, 'text');
  assert.equal(labelled.testID, undefined);
});

test('__collectAnchors: skips ancestors with neither testID nor accessible name', () => {
  // Plain wrapper Views (no testID, no label, no host text) must not appear.
  const root = buildFiber({
    name: 'View',
    children: [
      {
        name: 'View', // bare wrapper — must be skipped
        children: [
          {
            name: 'Pressable',
            props: { testID: 'row' },
            children: [{ hostType: 'Text', children: [{ text: 'Hi' }] }],
          },
        ],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const leaf = deepestChild(root);
  const anchors = sb.__QAREN.__collectAnchors(leaf);
  // Only the Pressable qualifies; bare Views are absent.
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].testID, 'row');
});

// ── source-drift guard ────────────────────────────────────────────────────
test('source guard: __collectAnchors + anchors wired into bundle', () => {
  assert.match(INJECTED_HELPERS, /function __collectAnchors\(/);
  assert.match(INJECTED_HELPERS, /relation: 'childOf'/);
  assert.match(INJECTED_HELPERS, /authored-testID/);
  assert.match(INJECTED_HELPERS, /__collectAnchors: __collectAnchors/);
  assert.match(INJECTED_HELPERS, /anchors: __collectAnchors\(/);
});
