import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frontFromSurface } from '../../../dist/qa/screen.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { nativeDevOverlayObservation } from '../../../dist/qa/capture.js';

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
  assert.deepEqual(
    nativeDevOverlayObservation({
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
    }),
    { state: 'shown', front: 'dev-fab' },
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

type RawTuple = [number, number | null, string, [number, number, number, number], boolean];

const ANDROID_WINDOW = rect(0, 0, 1080, 2400);
const box = ([x, y, width, height]: [number, number, number, number]) => rect(x, y, width, height);

function completeObservation(nodes: NativeNode[], surface?: string) {
  return {
    ...(surface === undefined ? {} : { surface }),
    nodes,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
  };
}

function loadAi753Fixture(name: string): NativeNode[] {
  const raw = JSON.parse(
    readFileSync(new URL(`../../fixtures/ai753/${name}`, import.meta.url), 'utf8'),
  ) as { nodes: RawTuple[] };
  return raw.nodes.map(([index, parent, type, bounds, visibleToUser]) => ({
    ref: `@e${index}`,
    index,
    ...(parent === null ? {} : { parentIndex: parent }),
    type,
    rect: box(bounds),
    visibleToUser,
  }));
}

const testAppCaptures = JSON.parse(
  readFileSync(
    new URL('../../fixtures/android-presence/test-app-captures.json', import.meta.url),
    'utf8',
  ),
) as Record<
  string,
  {
    nodes: Array<{
      index: number;
      parentIndex?: number;
      type: string;
      rect: [number, number, number, number];
      visibleToUser: boolean;
      enabled: boolean;
    }>;
  }
>;

function loadTestAppNodes(name: string): NativeNode[] {
  return testAppCaptures[name].nodes.map((n) => ({
    ref: `@e${n.index}`,
    index: n.index,
    ...(n.parentIndex === undefined ? {} : { parentIndex: n.parentIndex }),
    type: n.type,
    rect: box(n.rect),
    visibleToUser: n.visibleToUser,
    hittable: n.enabled && n.visibleToUser,
  }));
}

const frontAndroid = frontFromSurface;
const observeOverlay = nativeDevOverlayObservation;

test('H10a: Android button-off captures are classified as app', () => {
  for (const name of Object.keys(testAppCaptures)) {
    const nodes = loadTestAppNodes(name);
    assert.equal(frontAndroid(undefined, nodes, 'android'), 'app', name);
    assert.deepEqual(observeOverlay(completeObservation(nodes), 'android'), {
      state: 'clear',
      front: 'app',
    });
  }
  for (const file of ['android-off-read1.json', 'android-off-read17.json']) {
    const nodes = loadAi753Fixture(file);
    assert.equal(frontAndroid(undefined, nodes, 'android'), 'app', file);
    assert.deepEqual(observeOverlay(completeObservation(nodes), 'android'), {
      state: 'clear',
      front: 'app',
    });
  }
});

test('H10b: Android button-on captures from capture 1 are classified as dev-fab', () => {
  for (const file of ['android-on-read1.json', 'android-on-read17.json']) {
    const nodes = loadAi753Fixture(file);
    assert.equal(frontAndroid(undefined, nodes, 'android'), 'dev-fab', file);
    assert.deepEqual(
      observeOverlay(completeObservation(nodes), 'android'),
      { state: 'shown', front: 'dev-fab' },
      file,
    );
  }
});

test('H10c: invisible nodes under the button leaf and under the holder keep dev-fab', () => {
  for (const file of ['android-on-read1.json', 'android-on-read17.json']) {
    const nodes = loadAi753Fixture(file);
    const holderIndex =
      nodes.findIndex((n) => n.type === 'androidx.compose.ui.platform.ComposeView') - 1;
    const leafIndex = nodes.findIndex((n) => n.type === 'android.widget.ImageView');
    assert.equal(nodes[holderIndex]?.type, 'android.widget.LinearLayout');
    assert.ok(leafIndex > holderIndex);
    nodes.push(
      {
        ref: `@e${nodes.length}`,
        index: nodes.length,
        parentIndex: leafIndex,
        type: 'android.view.View',
        rect: ANDROID_WINDOW,
        visibleToUser: false,
      },
      {
        ref: `@e${nodes.length + 1}`,
        index: nodes.length + 1,
        parentIndex: holderIndex,
        type: 'android.view.View',
        rect: ANDROID_WINDOW,
        visibleToUser: false,
      },
    );
    assert.equal(frontAndroid(undefined, nodes, 'android'), 'dev-fab', file);
  }
});

test('H10d: a ComposeView with small content added inside React content without sibling/anchor is app', () => {
  for (const nodes of [loadTestAppNodes('home-top'), loadAi753Fixture('android-off-read17.json')]) {
    const viewGroup = nodes.findIndex(
      (n) => n.type === 'android.view.ViewGroup' && n.visibleToUser,
    );
    assert.ok(viewGroup > 0);
    const base = nodes.length;
    nodes.push(
      {
        ref: `@e${base}`,
        index: base,
        parentIndex: viewGroup,
        type: 'android.widget.FrameLayout',
        rect: ANDROID_WINDOW,
        visibleToUser: true,
      },
      {
        ref: `@e${base + 1}`,
        index: base + 1,
        parentIndex: base,
        type: 'android.widget.LinearLayout',
        rect: ANDROID_WINDOW,
        visibleToUser: true,
      },
      {
        ref: `@e${base + 2}`,
        index: base + 2,
        parentIndex: base + 1,
        type: 'androidx.compose.ui.platform.ComposeView',
        rect: ANDROID_WINDOW,
        visibleToUser: true,
      },
      {
        ref: `@e${base + 3}`,
        index: base + 3,
        parentIndex: base + 2,
        type: 'android.view.View',
        rect: ANDROID_WINDOW,
        visibleToUser: true,
      },
      {
        ref: `@e${base + 4}`,
        index: base + 4,
        parentIndex: base + 3,
        type: 'android.widget.Button',
        rect: rect(900, 140, 68, 68),
        visibleToUser: true,
      },
    );
    assert.equal(frontAndroid(undefined, nodes, 'android'), 'app');
  }
});

test('H10e: shrinking the ComposeView host rectangle below its holder and sibling is app', () => {
  const nodes = loadAi753Fixture('android-on-read1.json');
  const host = nodes.find((n) => n.type === 'androidx.compose.ui.platform.ComposeView')!;
  host.rect = rect(0, 0, 1000, 2400);
  assert.equal(frontAndroid(undefined, nodes, 'android'), 'app');
});

test('H10f: expo_dev_menu surface keeps precedence over an Android button-on capture', () => {
  const nodes = loadAi753Fixture('android-on-read1.json');
  assert.equal(frontAndroid('expo_dev_menu', nodes, 'android'), 'dev-menu');
  assert.deepEqual(observeOverlay(completeObservation(nodes, 'expo_dev_menu'), 'android'), {
    state: 'shown',
    front: 'dev-menu',
  });
});

test('H10g: a button leaf box larger than 96 px each way but within 35% of the host is dev-fab', () => {
  const nodes = loadAi753Fixture('android-on-read1.json');
  const leaf = nodes.find((n) => n.type === 'android.widget.ImageView')!;
  leaf.rect = rect(700, 140, 200, 200);
  assert.equal(frontAndroid(undefined, nodes, 'android'), 'dev-fab');
});

test('H10h: an invisible node under the host with a visible distant descendant is ignored', () => {
  const nodes = loadAi753Fixture('android-on-read1.json');
  const hostIndex = nodes.findIndex((n) => n.type === 'androidx.compose.ui.platform.ComposeView');
  const hiddenIndex = nodes.length;
  nodes.push(
    {
      ref: `@e${hiddenIndex}`,
      index: hiddenIndex,
      parentIndex: hostIndex,
      type: 'android.view.View',
      rect: ANDROID_WINDOW,
      visibleToUser: false,
    },
    {
      ref: `@e${hiddenIndex + 1}`,
      index: hiddenIndex + 1,
      parentIndex: hiddenIndex,
      type: 'android.view.View',
      rect: rect(0, 2200, 100, 100),
      visibleToUser: true,
    },
  );
  assert.equal(frontAndroid(undefined, nodes, 'android'), 'dev-fab');
});

test('H10i: an app lookalike copying the full host subtree and sibling under a React ViewGroup is app', () => {
  const on17 = loadAi753Fixture('android-on-read17.json');
  // Subtree 7..14 in android-on-read17 is fragmentHost(7) > holder(8) > ComposeView(9) > 10..14, with sibling FrameLayout(15).
  const appendLookalikeSubtree = (nodes: NativeNode[]) => {
    const viewGroup = nodes.findIndex(
      (n) => n.type === 'android.view.ViewGroup' && n.visibleToUser,
    );
    assert.ok(viewGroup > 0);
    const offset = nodes.length - 7;
    for (let src = 7; src <= 14; src++) {
      const original = on17[src];
      const index = src + offset;
      nodes.push({
        ...original,
        ref: `@e${index}`,
        index,
        parentIndex: src === 7 ? viewGroup : original.parentIndex! + offset,
        rect: { ...original.rect! },
      });
    }
    const siblingIndex = nodes.length;
    nodes.push({
      ref: `@e${siblingIndex}`,
      index: siblingIndex,
      parentIndex: 7 + offset,
      type: 'android.widget.FrameLayout',
      rect: ANDROID_WINDOW,
      visibleToUser: true,
    });
  };

  // From android-on-read17 with the real top-level button hidden and its whole host subtree copied under React ViewGroup.
  const movedFromOn17 = on17.map((n, i) =>
    i >= 11 && i <= 14 ? { ...n, visibleToUser: false } : { ...n, rect: { ...n.rect! } },
  );
  appendLookalikeSubtree(movedFromOn17);
  assert.equal(frontAndroid(undefined, movedFromOn17, 'android'), 'app');

  // Same copy placed into android-off-read17.
  const onOff17 = loadAi753Fixture('android-off-read17.json');
  appendLookalikeSubtree(onOff17);
  assert.equal(frontAndroid(undefined, onOff17, 'android'), 'app');
});

test('H10k: an invisible link in the five-layout window decor chain is app', () => {
  for (const decorIndex of [2, 3, 4, 5, 6]) {
    const nodes = loadAi753Fixture('android-on-read1.json');
    nodes[decorIndex] = { ...nodes[decorIndex], visibleToUser: false };
    assert.equal(frontAndroid(undefined, nodes, 'android'), 'app', `decor index ${decorIndex}`);
  }
});

test('H10l: inserting 12 extra FrameLayouts between Window and the decor chain is app', () => {
  const base = loadAi753Fixture('android-on-read1.json');
  const withExtraFrames = (extra: number): NativeNode[] => [
    { ...base[0] },
    { ...base[1] },
    ...Array.from({ length: extra }, (_, k) => ({
      ref: `@e${2 + k}`,
      index: 2 + k,
      parentIndex: 1 + k,
      type: 'android.widget.FrameLayout',
      rect: ANDROID_WINDOW,
      visibleToUser: true,
    })),
    ...base.slice(2).map((n) => ({
      ...n,
      ref: `@e${n.index! + extra}`,
      index: n.index! + extra,
      parentIndex: n.parentIndex === 1 ? 1 + extra : n.parentIndex! + extra,
    })),
  ];
  // Captured chain has 5 layouts; 7 extras = 12 hops (within bound), 8 extras = 13 hops, 12 extras = 17 hops.
  assert.equal(frontAndroid(undefined, withExtraFrames(7), 'android'), 'dev-fab');
  assert.equal(frontAndroid(undefined, withExtraFrames(8), 'android'), 'app');
  assert.equal(frontAndroid(undefined, withExtraFrames(12), 'android'), 'app');
});

test('H10j: two Android windows do not trigger the iOS two-window rule, while iOS stays unchanged', () => {
  const twoAndroidWindows: NativeNode[] = [
    { ref: '@e0', index: 0, type: 'Application', rect: ANDROID_WINDOW, visibleToUser: true },
    {
      ref: '@e1',
      index: 1,
      parentIndex: 0,
      type: 'Window',
      rect: ANDROID_WINDOW,
      visibleToUser: true,
    },
    {
      ref: '@e2',
      index: 2,
      parentIndex: 1,
      type: 'android.widget.FrameLayout',
      rect: ANDROID_WINDOW,
      visibleToUser: true,
    },
    {
      ref: '@e3',
      index: 3,
      parentIndex: 0,
      type: 'Window',
      rect: ANDROID_WINDOW,
      visibleToUser: true,
    },
    {
      ref: '@e4',
      index: 4,
      parentIndex: 3,
      type: 'android.view.View',
      rect: rect(900, 140, 80, 80),
      visibleToUser: true,
    },
  ];
  assert.equal(frontAndroid(undefined, twoAndroidWindows), 'dev-fab');
  assert.equal(frontAndroid(undefined, twoAndroidWindows, 'android'), 'app');
  assert.deepEqual(observeOverlay(completeObservation(twoAndroidWindows), 'android'), {
    state: 'clear',
    front: 'app',
  });
  // Existing iOS small-window cases still return dev-fab without a platform and with ios.
  assert.equal(frontAndroid(undefined, tree(appContent, fabPill)), 'dev-fab');
  assert.equal(frontAndroid(undefined, tree(appContent, fabPill), 'ios'), 'dev-fab');
});
