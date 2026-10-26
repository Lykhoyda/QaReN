import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenAndroidAccessibilityTree } from '../../dist/fast-runner-ref-map.js';

test('flattenAndroidAccessibilityTree passes flat nodes through unchanged', () => {
  const nodes = [
    { ref: '@e0', type: 'FrameLayout', rect: { x: 0, y: 0, width: 1080, height: 1920 } },
    {
      ref: '@e1',
      type: 'TextView',
      identifier: 'tab-home',
      label: 'Home',
      rect: { x: 0, y: 1800, width: 200, height: 100 },
      hittable: true,
    },
  ];
  const out = flattenAndroidAccessibilityTree(nodes);
  assert.equal(out.nodes, nodes);
  assert.deepEqual(out.refMap.get('e1'), { x: 0, y: 1800, width: 200, height: 100 });
});
