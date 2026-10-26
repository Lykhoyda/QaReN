import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontFromSurface } from '../../../dist/qa/screen.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { nativeDevOverlayUncleared } from '../../../dist/qa/capture.js';

// Value-free shapes inferred from expo-dev-menu 55/56 source (DevMenuFABWindow, DevMenuFABView),
// not recorded from a device: QA returns the recorded window list.
const SCREEN = { x: 0, y: 0, width: 402, height: 874 };
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function tree(
  ...windows: Array<Array<Omit<NativeNode, 'ref' | 'parentIndex'> & { parent?: number }>>
) {
  const nodes: NativeNode[] = [{ ref: 'e0', index: 0, type: 'Application', rect: SCREEN }];
  for (const children of windows) {
    const window = nodes.length;
    nodes.push({ ref: `e${window}`, index: window, parentIndex: 0, type: 'Window', rect: SCREEN });
    for (const { parent, ...child } of children)
      nodes.push({
        ref: `e${nodes.length}`,
        index: nodes.length,
        parentIndex: parent === undefined ? window : window + parent,
        ...child,
      });
  }
  return nodes;
}

const appContent = [
  { type: 'Other', rect: SCREEN },
  { type: 'StaticText', rect: rect(16, 120, 220, 24), parent: 1 },
  { type: 'Button', rect: rect(16, 780, 370, 48), parent: 1 },
];
const fabPill = [
  { type: 'Other', rect: SCREEN },
  { type: 'Other', rect: rect(314, 700, 72, 94), parent: 1 },
  { type: 'Image', rect: rect(328, 708, 44, 44), parent: 2 },
  { type: 'StaticText', rect: rect(330, 760, 40, 18), parent: 2 },
];

test('a full-screen pass-through window holding only the gear pill is the dev-menu button', () => {
  const nodes = tree(appContent, fabPill);
  assert.equal(frontFromSurface(undefined, nodes), 'dev-fab');
  assert.equal(
    nativeDevOverlayUncleared({
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
    }),
    true,
  );
});

test('the pill without its transient label is still the dev-menu button', () => {
  assert.equal(frontFromSurface(undefined, tree(appContent, fabPill.slice(0, 3))), 'dev-fab');
});

test('a small window with a button (the plan shape) is the dev-menu button', () => {
  const nodes = tree(appContent, [{ type: 'Button', rect: rect(320, 700, 60, 60) }]);
  nodes[nodes.length - 2].rect = rect(316, 696, 72, 72);
  assert.equal(frontFromSurface(undefined, nodes), 'dev-fab');
});

test('the app window alone is the app, even when its only content is small', () => {
  assert.equal(frontFromSurface(undefined, tree(appContent)), 'app');
  assert.equal(
    frontFromSurface(
      undefined,
      tree([{ type: 'ActivityIndicator', rect: rect(182, 418, 37, 37) }]),
    ),
    'app',
  );
});

test('a keyboard window is never the dev-menu button', () => {
  const keyboard = [
    { type: 'Keyboard', rect: rect(0, 538, 402, 336) },
    { type: 'Key', rect: rect(4, 548, 36, 46), parent: 0 },
  ];
  assert.equal(frontFromSurface(undefined, tree(appContent, keyboard)), 'app');
  assert.equal(
    frontFromSurface(undefined, tree(appContent, [{ type: 'Key', rect: rect(4, 548, 36, 46) }])),
    'app',
  );
});

test('a second window with an input or wide content is not the dev-menu button', () => {
  assert.equal(
    frontFromSurface(
      undefined,
      tree(appContent, [{ type: 'TextField', rect: rect(320, 700, 60, 40) }]),
    ),
    'app',
  );
  assert.equal(
    frontFromSurface(
      undefined,
      tree(appContent, [{ type: 'StaticText', rect: rect(16, 700, 370, 40) }]),
    ),
    'app',
  );
});

test('an empty second window is not the dev-menu button', () => {
  assert.equal(
    frontFromSurface(undefined, tree(appContent, [{ type: 'Other', rect: SCREEN }])),
    'app',
  );
});

test('an alert and a dev-menu surface keep their precedence over the button', () => {
  const alert = tree(appContent, fabPill);
  alert[0] = { ...alert[0], type: 'Alert' };
  assert.equal(frontFromSurface(undefined, alert), 'dialog');
  assert.equal(frontFromSurface('expo_dev_menu', tree(appContent, fabPill)), 'dev-menu');
});

test('Android nodes have no Window type and are never the dev-menu button', () => {
  const nodes: NativeNode[] = [
    { ref: 'e0', index: 0, type: 'android.widget.FrameLayout', rect: rect(0, 0, 1080, 2400) },
    {
      ref: 'e1',
      index: 1,
      parentIndex: 0,
      type: 'android.widget.ImageView',
      rect: rect(900, 2000, 96, 96),
    },
  ];
  assert.equal(frontFromSurface(undefined, nodes), 'app');
});

test('a second window with unmeasured content is not proven to be the dev-menu button', () => {
  const nodes = tree(appContent, [
    { type: 'Image', rect: rect(328, 708, 44, 44) },
    { type: 'StaticText' },
  ]);
  assert.equal(frontFromSurface(undefined, nodes), 'app');
});
