import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clippingViewport,
  outsideViewport,
  validateNativePresence,
  viewportDiagnostic,
} from '../../../dist/qa/native-presence.js';
import type { NativeNode } from '../../../dist/qa/screen.js';

import { androidPresenceCapture, nativeCapture } from './platform-presence-fixtures.ts';

test('native presence requires a complete app/generation-bound unfiltered observation interval', () => {
  const source = nativeCapture();
  const valid = validateNativePresence(source.presenceCapture, source.nodes, 7, 'com.test', 20_000);
  assert.ok(valid);
  assert.equal(valid.nodes[1].status, 'observed');
  assert.equal(valid.nodes[0].status, 'unknown');
  for (const patch of [
    { version: 1 },
    { source: 'geometry' },
    { enumeration: 'filtered' },
    { complete: false },
    { appId: 'other.app' },
    { generation: 8 },
    { generation: 7.5 },
    { captureId: '' },
    { startedUptimeMs: -1 },
    { endedUptimeMs: 99 },
    { endedUptimeMs: 20_100 },
    { endedUptimeMs: Infinity },
  ])
    assert.equal(
      validateNativePresence(
        { ...source.presenceCapture, ...patch },
        source.nodes,
        7,
        'com.test',
        20_000,
      ),
      undefined,
    );
  for (const generation of [undefined, '7', 8])
    assert.equal(
      validateNativePresence(source.presenceCapture, source.nodes, generation, 'com.test', 20_000),
      undefined,
    );
  assert.equal(
    validateNativePresence(source.presenceCapture, source.nodes, 7, undefined, 20_000),
    undefined,
  );
});

test('node evidence cannot be reused for a different capture, generation, index or observation time', () => {
  const source = nativeCapture();
  for (const patch of [
    { captureId: 'old' },
    { generation: 6 },
    { nodeIndex: 0 },
    { status: 'visible' },
    { status: true },
    { labelSource: 'inferred' },
    { observedUptimeMs: undefined },
    { observedUptimeMs: 99 },
    { observedUptimeMs: 201 },
    { observedUptimeMs: NaN },
    { status: 'unknown', observedUptimeMs: 150 },
  ]) {
    const nodes = [
      source.nodes[0],
      { ...source.nodes[1], presence: { ...source.nodes[1].presence, ...patch } },
    ];
    assert.equal(
      validateNativePresence(source.presenceCapture, nodes, 7, 'com.test', 20_000),
      undefined,
    );
  }
});

test('complete native enumeration rejects lost hierarchy, bad geometry and duplicate references', () => {
  const source = nativeCapture();
  for (const nodes of [
    [],
    [source.nodes[1]],
    [source.nodes[0], source.nodes[0]],
    [source.nodes[0], { ...source.nodes[1], index: undefined }],
    [source.nodes[0], { ...source.nodes[1], parentIndex: undefined }],
    [source.nodes[0], { ...source.nodes[1], parentIndex: 1 }],
    [source.nodes[0], { ...source.nodes[1], depth: 2 }],
    [source.nodes[0], { ...source.nodes[1], ref: '@e0' }],
    [source.nodes[0], { ...source.nodes[1], rect: { x: NaN, y: 0, width: 1, height: 1 } }],
    [source.nodes[0], { ...source.nodes[1], rect: { x: 0, y: 0, width: 0, height: 1 } }],
    [source.nodes[0], { ...source.nodes[1], presence: undefined }],
  ])
    assert.equal(
      validateNativePresence(source.presenceCapture, nodes, 7, 'com.test', 20_000),
      undefined,
    );
});

test('negative or unavailable native hittability is retained as unknown, never absence', () => {
  const source = nativeCapture();
  const { observedUptimeMs: _observedUptimeMs, ...observation } = source.nodes[1].presence;
  const nodes = [
    source.nodes[0],
    { ...source.nodes[1], presence: { ...observation, status: 'unknown' } },
  ];
  const valid = validateNativePresence(source.presenceCapture, nodes, 7, 'com.test', 20_000);
  assert.ok(valid);
  assert.equal(valid.nodes[1].status, 'unknown');
});

test('unknown reasons are allowlisted diagnostics, not visibility evidence', () => {
  for (const reason of [
    'empty-frame',
    'clipped',
    'ambiguous-descriptor',
    'not-hittable',
    'read-unavailable',
    'match-count-mismatch',
    'post-hit-mismatch',
  ]) {
    const source = nativeCapture();
    Object.assign(source.nodes[0].presence, { unknownReason: reason });
    Object.assign(source.nodes[1].presence, { unknownReason: reason });
    const valid = validateNativePresence(
      source.presenceCapture,
      source.nodes,
      7,
      'com.test',
      20_000,
    )!;
    assert.deepEqual(valid.nodes[0], {
      status: 'unknown',
      labelSource: 'direct',
      unknownReason: reason,
    });
    assert.deepEqual(valid.nodes[1], { status: 'observed', labelSource: 'direct' });
  }
  for (const unknownReason of [undefined, null, 42, {}, 'PRIVATE-reason']) {
    const source = nativeCapture();
    Object.assign(source.nodes[0].presence, { unknownReason });
    const valid = validateNativePresence(
      source.presenceCapture,
      source.nodes,
      7,
      'com.test',
      20_000,
    )!;
    assert.deepEqual(valid.nodes[0], { status: 'unknown', labelSource: 'direct' });
    assert.doesNotMatch(JSON.stringify(valid), /PRIVATE-/);
  }
});

type Spec = { type: string; parent?: number; rect: NonNullable<NativeNode['rect']> };

function tree(specs: Spec[]): NativeNode[] {
  return specs.map((spec, index) => ({
    ref: `@e${index}`,
    index,
    type: spec.type,
    ...(spec.parent === undefined ? {} : { parentIndex: spec.parent }),
    rect: spec.rect,
  }));
}

const androidScreen = { x: 0, y: 0, width: 1080, height: 2424 };
const list = { x: 64, y: 1270, width: 460, height: 504 };
const rowBelowList = { x: 64, y: 1800, width: 460, height: 64 };
const rowInList = { x: 64, y: 1300, width: 460, height: 64 };

// Application, app Window, a container, then one row under it.
function androidList(container: string, row: Spec['rect']): NativeNode[] {
  return tree([
    { type: 'Application', rect: androidScreen },
    { type: 'Window', parent: 0, rect: androidScreen },
    { type: container, parent: 1, rect: list },
    { type: 'android.widget.TextView', parent: 2, rect: row },
  ]);
}

const exclusionOf = (nodes: NativeNode[], offscreen: Set<number>, index: number) => {
  const line = JSON.parse(
    viewportDiagnostic(nodes, offscreen).slice('viewport-diagnostic '.length),
  );
  return line.excluded.find((entry: unknown[]) => entry[0] === index);
};

// The row lies wholly below the list, inside the window.
function assertScrollClipped(container: string) {
  const nodes = androidList(container, rowBelowList);
  const offscreen = outsideViewport(nodes);
  assert.deepEqual([...offscreen], [3], container);
  assert.deepEqual(clippingViewport(offscreen, 3), list, container);
  assert.deepEqual(
    exclusionOf(nodes, offscreen, 3),
    [3, 'Other', 'scroll', 2, 'Other', 64, 1270, 460, 504],
    container,
  );
}

test('an Android row scrolled out of its ScrollView is offscreen, clipped to the ScrollView', () => {
  assertScrollClipped('android.widget.ScrollView');
});

test('Android list, recycler, nested-scroll and pager containers clip their rows', () => {
  for (const container of [
    'androidx.recyclerview.widget.RecyclerView',
    'androidx.core.widget.NestedScrollView',
    'android.widget.ListView',
    'android.widget.ExpandableListView',
    'android.widget.GridView',
    'android.widget.HorizontalScrollView',
    'androidx.viewpager.widget.ViewPager',
    'androidx.viewpager2.widget.ViewPager2',
  ])
    assertScrollClipped(container);
});

test('an Android row under a plain view group keeps the window as its clip', () => {
  const nodes = androidList('android.view.ViewGroup', rowBelowList);
  const offscreen = outsideViewport(nodes);
  assert.deepEqual([...offscreen], []);
  assert.deepEqual(clippingViewport(offscreen, 3), androidScreen);
});

test('an Android row inside its scroll container stays on screen', () => {
  const nodes = androidList('androidx.recyclerview.widget.RecyclerView', rowInList);
  assert.deepEqual([...outsideViewport(nodes)], []);
});

test('a row overlapping the list edge is offscreen once its centre leaves the list', () => {
  const bottom = list.y + list.height;
  for (const [y, excluded] of [
    [bottom - 33, false],
    [bottom - 32, true],
    [bottom - 1, true],
    [bottom, true],
  ] as const) {
    const nodes = androidList('androidx.recyclerview.widget.RecyclerView', {
      ...rowBelowList,
      y,
    });
    const offscreen = outsideViewport(nodes);
    assert.equal(offscreen.has(3), excluded);
    assert.deepEqual(clippingViewport(offscreen, 3), list);
  }
});

test('iOS list clips include centres on the top and left edges and exclude bottom and right edges', () => {
  for (const [x, y, excluded] of [
    [31, 1300, true],
    [32, 1300, false],
    [491, 1300, false],
    [492, 1300, true],
    [64, 1237, true],
    [64, 1238, false],
    [64, 1741, false],
    [64, 1742, true],
    [64, 1800, true],
  ] as const) {
    const nodes = tree([
      { type: 'Application', rect: androidScreen },
      { type: 'Window', parent: 0, rect: androidScreen },
      { type: 'ScrollView', parent: 1, rect: list },
      { type: 'Button', parent: 2, rect: { x, y, width: 64, height: 64 } },
    ]);
    const offscreen = outsideViewport(nodes);
    assert.equal(offscreen.has(3), excluded, `${x},${y}`);
    assert.deepEqual(clippingViewport(offscreen, 3), list);
  }
});

test('iOS scroll containers still clip by exact type and other types do not', () => {
  const ios = (container: string) =>
    tree([
      { type: 'Application', rect: androidScreen },
      { type: 'Window', parent: 0, rect: androidScreen },
      { type: container, parent: 1, rect: list },
      { type: 'StaticText', parent: 2, rect: rowBelowList },
    ]);
  for (const container of ['ScrollView', 'Table', 'CollectionView']) {
    const offscreen = outsideViewport(ios(container));
    assert.deepEqual([...offscreen], [3], container);
    assert.deepEqual(clippingViewport(offscreen, 3), list, container);
  }
  const offscreen = outsideViewport(ios('Other'));
  assert.deepEqual([...offscreen], []);
  assert.deepEqual(clippingViewport(offscreen, 3), androidScreen);
});

function androidNodes() {
  const { data } = androidPresenceCapture();
  return {
    capture: data.presenceCapture,
    nodes: data.nodes.map((node) => ({ ...node, ref: `@e${node.index}` })) as NativeNode[],
  };
}

test('an Android capture is accepted with its density, and only as the Android source and enumeration pair', () => {
  const { capture, nodes } = androidNodes();
  const valid = validateNativePresence(capture, nodes, 4, 'com.test', 20_000);
  assert.equal(valid?.source, 'android-a11y-live');
  assert.equal(valid?.pointScale, 2.625);
  assert.equal(valid?.nodes[3].status, 'observed');
  for (const patch of [
    { enumeration: 'raw-unfiltered' },
    { source: 'xcui-live' },
    { pointScale: undefined },
    { pointScale: 0 },
    { pointScale: -2.625 },
    { pointScale: Infinity },
    { pointScale: '2.625' },
    { generation: 3 },
    { complete: false },
    { endedUptimeMs: 20_100 },
  ])
    assert.equal(
      validateNativePresence({ ...capture, ...patch }, nodes, 4, 'com.test', 20_000),
      undefined,
      JSON.stringify(patch),
    );
  assert.equal(validateNativePresence(capture, nodes, 5, 'com.test', 20_000), undefined);
  const stale = nodes.map((node, i) =>
    i === 3 ? { ...node, presence: { ...(node.presence as object), generation: 3 } } : node,
  );
  assert.equal(validateNativePresence(capture, stale, 4, 'com.test', 20_000), undefined);
});

test('only an Android capture may say the keyboard covers a node', () => {
  const { capture, nodes } = androidNodes();
  const covered = (reason: string) =>
    nodes.map((node, i) =>
      i === 3
        ? {
            ...node,
            presence: {
              captureId: capture.captureId,
              generation: 4,
              nodeIndex: 3,
              status: 'unknown',
              labelSource: 'direct',
              unknownReason: reason,
            },
          }
        : node,
    );
  assert.equal(
    validateNativePresence(capture, covered('keyboard-covered'), 4, 'com.test', 20_000)?.nodes[3]
      .unknownReason,
    'keyboard-covered',
  );
  // react-covered is the core's own React hit-test verdict; a runner cannot claim it.
  const claimed = validateNativePresence(capture, covered('react-covered'), 4, 'com.test', 20_000);
  assert.equal(claimed?.nodes[3].status, 'unknown');
  assert.equal(claimed?.nodes[3].unknownReason, undefined);
  const ios = nativeCapture();
  ios.nodes[1].presence = {
    ...ios.nodes[1].presence,
    status: 'unknown',
    unknownReason: 'keyboard-covered',
  } as (typeof ios.nodes)[1]['presence'];
  delete (ios.nodes[1].presence as { observedUptimeMs?: number }).observedUptimeMs;
  const read = validateNativePresence(ios.presenceCapture, ios.nodes, 7, 'com.test', 20_000);
  assert.equal(read?.nodes[1].status, 'unknown');
  assert.equal(read?.nodes[1].unknownReason, undefined);
});
