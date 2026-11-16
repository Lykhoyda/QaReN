import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { plainScrollBand, scrollTargetCovered, scrollUntilBand } from '../../../dist/qa/resolve.js';
import { join, touchPolicy } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = NonNullable<NativeNode['rect']>;
const WINDOW = { x: 0, y: 0, width: 402, height: 874 };
const LIST = { x: 0, y: 0, width: 402, height: 791 };
const until = () => {
  const step = parseStep('Scroll down until "Open Pager QA"');
  assert.ok(step && !('refuse' in step) && step.kind === 'scroll' && step.until);
  return step.until;
};

// The Test App home on iOS 27.2 exactly as the runner returned it (run check-20261112T165237Z).
const captured = JSON.parse(
  readFileSync(new URL('../../fixtures/ios-27-2/home-walk-tree.json', import.meta.url), 'utf8'),
).data;
const real: Screen = {
  ...join(
    captured.nodes.map((node: NativeNode) => ({ ...node, ref: `@e${node.index}` })),
    [],
    'app',
    { native: 'complete', react: 'complete' },
  ),
  nativeGeneration: captured.snapshotGeneration,
  keyboardVisible: captured.keyboardVisible,
};

// The same shape in small: the content does not hang under the window node; after the list come a
// childless toolbar container, a box whose only content is parked below the screen, and the tab bar.
const TOOLBAR: NativeNode = {
  ref: '@toolbar',
  index: 0,
  parentIndex: 2,
  type: 'Toolbar',
  identifier: 'Toolbar',
  label: 'Toolbar',
  hittable: true,
  enabled: true,
  rect: WINDOW,
};
const SHEET: NativeNode[] = [
  {
    ref: '@sheet',
    index: 0,
    parentIndex: 2,
    type: 'Other',
    label: 'Bottom Sheet',
    hittable: true,
    enabled: true,
    rect: WINDOW,
  },
  {
    ref: '@sheet-body',
    index: 0,
    parentIndex: -1,
    type: 'Other',
    label: 'Bottom Sheet',
    hittable: false,
    enabled: true,
    rect: { x: 0, y: 874, width: 402, height: 24 },
  },
];
function nodes(scrolled: number, layers: NativeNode[]): NativeNode[] {
  const base: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: WINDOW },
    { ref: '@window', index: 1, parentIndex: 0, type: 'Window', rect: WINDOW },
    { ref: '@root', index: 2, parentIndex: 0, type: 'Other', rect: WINDOW },
    { ref: '@list', index: 3, parentIndex: 2, type: 'ScrollView', rect: LIST },
    {
      ref: '@next',
      index: 4,
      parentIndex: 3,
      type: 'Button',
      identifier: 'qa-native-redbox-next',
      label: 'Next',
      hittable: scrolled < 81,
      enabled: true,
      rect: { x: 14, y: 81 - scrolled, width: 374, height: 38 },
    },
    {
      ref: '@pager',
      index: 5,
      parentIndex: 3,
      type: 'Button',
      identifier: 'home-pager-qa-btn',
      label: 'Open Pager QA',
      hittable: 2131 - scrolled < 791,
      enabled: true,
      rect: { x: 14, y: 2131 - scrolled, width: 374, height: 38 },
    },
    ...layers,
    {
      ref: '@tabs',
      index: 0,
      parentIndex: 2,
      type: 'Other',
      label: 'Tabs',
      hittable: true,
      enabled: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  // A node with parentIndex -1 hangs under the node before it, -2 under the one before that.
  return base.map((node, index) => ({
    ...node,
    index,
    ...(node.parentIndex !== undefined && node.parentIndex < 0
      ? { parentIndex: index + node.parentIndex }
      : {}),
  }));
}
const home = (
  scrolled: number,
  layers: NativeNode[],
  react: Parameters<typeof join>[1] = [],
): Screen => ({
  ...join(nodes(scrolled, layers), react, 'app', { native: 'complete', react: 'complete' }),
  nativeGeneration: 1,
  keyboardVisible: false,
});
const CLEAR = { x: 0, y: 0, width: 402, height: 787 };

async function run(before: Screen, after: Screen) {
  const f = walker(
    [before],
    scriptedJudge(() => assert.fail('unexpected model call')),
  );
  let moved = false;
  let reads = 0;
  f.deps.platform = 'ios';
  f.deps.captureScreen = async () => (moved ? after : before);
  f.deps.hitProbe = async () => (reads++, 'not-hittable');
  const bands: (Rect | undefined)[] = [];
  f.deps.scroll = async (_dir, context, _clearance, band) => {
    bands.push(band);
    if (band && band.height < 50)
      return {
        ok: false,
        mutation: 'none',
        error: `SCROLL_BAND_TOO_SMALL: the ${Math.round(band.height)}px band cannot host a 48px drag`,
      } as never;
    context!.authorize();
    moved = true;
    return { ok: true, proven: true };
  };
  const result = await walkBlock(
    parsePlan('1. Scroll down until "Open Pager QA"\n').blocks![0],
    f.deps,
  );
  return { result, bands, reads: () => reads, seen: JSON.stringify(result.failure?.seen ?? '') };
}

test('L1 the recorded iOS 27.2 home: the band is the list between its real covers, and a visible row is not covered', () => {
  // The press counter badge cuts the top, the quick-add button the bottom; the full-size layers cut nothing.
  const band = scrollUntilBand(until(), real)!;
  assert.deepEqual(
    { ...band, y: Math.round(band.y), height: Math.round(band.height) },
    { x: 0, y: 87, width: 402, height: 651 },
  );
  const row = real.elements.find((element) => element.testID === 'home-qa-acceptance-btn')!;
  assert.equal(scrollTargetCovered(row, real), false);
});

// What the in-app helper itself reports for a closed sheet: the component shape of the sheet library
// (content, draggable view, animated view, host, and the handle), each marked adjustable and labelled.
async function closedSheetEntries() {
  const sheet = {
    accessible: true,
    accessibilityRole: 'adjustable',
    accessibilityLabel: 'Bottom Sheet',
  };
  const handle = {
    accessible: true,
    accessibilityRole: 'adjustable',
    accessibilityLabel: 'Bottom sheet handle',
  };
  const root = {
    current: buildFiber({
      name: 'Screen',
      children: [
        {
          name: 'BottomSheetBody',
          children: [
            {
              hostType: 'RCTView',
              props: {},
              children: [
                {
                  name: 'BottomSheetContent',
                  props: { pointerEvents: 'box-none', ...sheet },
                  children: [
                    {
                      name: 'BottomSheetDraggableView',
                      props: sheet,
                      children: [
                        {
                          name: 'Animated(View)',
                          props: sheet,
                          children: [{ hostType: 'RCTView', props: sheet }],
                        },
                      ],
                    },
                  ],
                },
                {
                  name: 'BottomSheetHandle',
                  children: [
                    {
                      name: 'View',
                      props: handle,
                      children: [{ hostType: 'RCTView', props: handle }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  };
  const sandbox = createSandbox({ fiberRoot: root.current });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  return captureQaReact({
    isConnected: true,
    async withPrivateHelperWorld(run) {
      return run(async (expression) => vm.runInContext(expression, sandbox));
    },
  });
}

test('L5 the recorded home joined with what the helper reports for the closed sheet: its box is called a button and is still a layer', async () => {
  const react = await closedSheetEntries();
  // Every entry is a bare role on a label: no handler, no testID.
  assert.ok(react.interactive!.length >= 2);
  for (const entry of react.interactive!) {
    assert.equal(entry.role, 'adjustable');
    assert.equal(entry.handlerless, true);
    assert.equal(entry.testID, undefined);
  }
  const joined: Screen = {
    ...join(
      captured.nodes.map((node: NativeNode) => ({ ...node, ref: `@e${node.index}` })),
      react.interactive!,
      'app',
      { native: 'complete', react: 'complete' },
      react.hostEvidence,
    ),
    nativeGeneration: captured.snapshotGeneration,
    keyboardVisible: captured.keyboardVisible,
  };
  const box = joined.elements.find((element) => element.ref === '@e115')!;
  assert.equal(box.kind, 'button');
  assert.equal(box.testID, undefined);
  assert.equal(Math.round(scrollUntilBand(until(), joined)!.height), 651);
});

test('G4 plain Scroll is not changed: on the recorded home it still treats the layers as unproven covers', () => {
  const plain = plainScrollBand(real, 'down', 'ios');
  assert.equal(plain.unproven, true);
  assert.deepEqual(plain.band, { x: 0, y: 0, width: 402, height: 791 });
});

test('L3 a childless toolbar container and a box with only off-screen content do not stop the scroll', async () => {
  // A toolbar container may also hold parked content.
  const parkedBar: NativeNode[] = [TOOLBAR, { ...SHEET[1], ref: '@bar-parked' }];
  for (const [name, layers] of [
    ['toolbar', [TOOLBAR]],
    ['closed sheet', SHEET],
    ['toolbar with parked content', parkedBar],
    ['both', [TOOLBAR, ...SHEET, { ...TOOLBAR, ref: '@toolbar2' }]],
  ] as const) {
    const f = await run(home(0, layers as NativeNode[]), home(1731, layers as NativeNode[]));
    assert.equal(f.result.block.outcome, 'pass', `${name}: ${f.seen}`);
    assert.deepEqual(f.bands, [CLEAR], name);
    assert.equal(f.reads(), 0, name);
  }
});

test('L4 a container whose only content lies wholly outside the list is a layer', () => {
  // A full-size box holding only something beside the list: below it like a tab bar's parent, above,
  // left or right of it.
  for (const [name, rect] of [
    ['below', { x: 0, y: 800, width: 402, height: 60 }],
    // Touching an edge of the list is still outside it.
    ['touching the bottom edge', { x: 0, y: 791, width: 402, height: 60 }],
    ['touching the top edge', { x: 0, y: -60, width: 402, height: 60 }],
    ['touching the left edge', { x: -200, y: 100, width: 200, height: 60 }],
    ['touching the right edge', { x: 402, y: 100, width: 200, height: 60 }],
    // Wider than the list, yet wholly to its right.
    ['wide, to the right', { x: 420, y: 100, width: 900, height: 60 }],
    ['above', { x: 0, y: -100, width: 402, height: 60 }],
    ['left', { x: -300, y: 100, width: 200, height: 60 }],
    ['right', { x: 500, y: 100, width: 200, height: 60 }],
  ] as const) {
    const box: NativeNode[] = [
      { ...SHEET[0], label: 'Chrome' },
      {
        ref: '@beside',
        index: 0,
        parentIndex: -1,
        type: 'Other',
        label: 'Beside',
        hittable: false,
        enabled: true,
        rect,
      },
    ];
    assert.deepEqual(scrollUntilBand(until(), home(0, box)), CLEAR, name);
  }
});

test('G1 what still erases the band: a dim layer, a box or toolbar with content over the list, a full-size control', async () => {
  const dim: NativeNode = {
    ref: '@dim',
    index: 0,
    parentIndex: 2,
    type: 'Other',
    hittable: true,
    enabled: true,
    rect: WINDOW,
  };
  const open: NativeNode[] = [
    SHEET[0],
    { ...SHEET[1], hittable: true, rect: { x: 0, y: 480, width: 402, height: 394 } },
  ];
  const bar: NativeNode[] = [
    TOOLBAR,
    {
      ref: '@bar-button',
      index: 0,
      parentIndex: -1,
      type: 'Other',
      label: 'Done',
      hittable: true,
      enabled: true,
      rect: { x: 300, y: 700, width: 80, height: 40 },
    },
  ];
  const control: NativeNode = {
    ...TOOLBAR,
    ref: '@control',
    type: 'Button',
    identifier: 'big',
    label: 'Big',
  };
  const parked: NativeNode[] = [control, { ...SHEET[1], ref: '@parked' }];
  // A body whose centre is below the screen, so the capture flags it off screen, yet it lies over the list from y 600.
  const sticking: NativeNode[] = [
    SHEET[0],
    { ...SHEET[1], rect: { x: 0, y: 600, width: 402, height: 600 } },
  ];
  // One descendant parked below the screen, one over the list.
  const mixed: NativeNode[] = [
    SHEET[0],
    SHEET[1],
    {
      ref: '@sheet-row',
      index: 0,
      parentIndex: -2,
      type: 'Other',
      label: 'Row',
      hittable: true,
      enabled: true,
      rect: { x: 0, y: 300, width: 402, height: 40 },
    },
  ];
  // A descendant with no frame proves nothing.
  const frameless: NativeNode[] = [
    SHEET[0],
    { ref: '@nowhere', index: 0, parentIndex: -1, type: 'Other', label: 'Nowhere', enabled: true },
  ];
  // The child is parked, its own child lies over the list.
  const grandchild: NativeNode[] = [
    SHEET[0],
    SHEET[1],
    {
      ref: '@sheet-grandchild',
      index: 0,
      parentIndex: -1,
      type: 'Other',
      label: 'Deep',
      hittable: true,
      enabled: true,
      rect: { x: 0, y: 300, width: 402, height: 40 },
    },
  ];
  // Controls that are not buttons: a full-size slider and a stepper, each with parked content.
  const slider: NativeNode[] = [
    { ...SHEET[0], ref: '@slider', type: 'Slider', label: 'Level' },
    SHEET[1],
  ];
  const stepper: NativeNode[] = [
    { ...SHEET[0], ref: '@stepper', type: 'Stepper', label: 'Count' },
    SHEET[1],
  ];
  for (const [name, layers] of [
    ['dim layer', [dim]],
    ['open sheet', open],
    ['toolbar with a button', bar],
    ['full-size control', [control]],
    ['full-size control with off-screen content', parked],
    ['body sticking out below the screen', sticking],
    ['one descendant over the list', mixed],
    ['descendant without a frame', frameless],
    ['grandchild over the list', grandchild],
    ['slider', slider],
    ['stepper', stepper],
  ] as const) {
    const screen = home(0, layers as NativeNode[]);
    assert.ok(
      (scrollUntilBand(until(), screen)?.height ?? 0) < 50,
      `${name}: ${JSON.stringify(scrollUntilBand(until(), screen))}`,
    );
    const f = await run(screen, home(1731, layers as NativeNode[]));
    assert.equal(f.result.block.outcome, 'fail', name);
    assert.match(f.seen, /SCROLL_BAND_TOO_SMALL/, name);
  }
});

test('G5 a native Other for which React hints at a press or a fill stays a cover, by testID or by label', () => {
  // The box has parked content, but its testID belongs to a pressable.
  const layers: NativeNode[] = [{ ...SHEET[0], identifier: 'cover' }, SHEET[1]];
  const screen = home(0, layers, [
    { role: 'button', testID: 'cover', capabilities: { press: true, fill: false } },
  ]);
  assert.equal(screen.elements.find((element) => element.testID === 'cover')?.kind, 'button');
  assert.equal(scrollUntilBand(until(), screen)?.height, 0);
  // A role on the box's own testID makes it a control even without a handler.
  const roleOnly = home(0, layers, [{ role: 'button', testID: 'cover', handlerless: true }]);
  assert.equal(roleOnly.elements.find((element) => element.testID === 'cover')?.kind, 'button');
  assert.equal(scrollUntilBand(until(), roleOnly)?.height, 0);
  // A pressable or fillable host without a role keeps the kind other; its captured handler still makes it a cover.
  for (const capabilities of [
    { press: true, fill: false },
    { press: false, fill: true },
  ]) {
    const plain = home(0, layers, [{ role: 'none', testID: 'cover', capabilities }]);
    assert.equal(
      plain.elements.find((element) => element.testID === 'cover')?.kind,
      'other',
      JSON.stringify(capabilities),
    );
    assert.equal(scrollUntilBand(until(), plain)?.height, 0, JSON.stringify(capabilities));
  }
  // The same holds for a box matched only by its label: a pressable, and one with only a long-press handler.
  const labelled: NativeNode[] = [
    { ...SHEET[0], label: 'Cover' },
    { ...SHEET[1], label: 'Parked' },
  ];
  for (const entry of [
    { role: 'button', label: 'Cover', capabilities: { press: true, fill: false } },
    { role: 'button', label: 'Cover' },
    { role: 'textinput', label: 'Cover', capabilities: { press: false, fill: true } },
    // A pressable with no role and only a long-press handler: no press capability, yet not handlerless.
    { role: 'none', label: 'Cover', capabilities: { press: false, fill: false } },
  ])
    assert.equal(
      scrollUntilBand(until(), home(0, labelled, [entry]))?.height,
      0,
      JSON.stringify(entry),
    );
  // A role alone, with no handler and no testID, is no hint: this is the closed sheet.
  assert.deepEqual(
    scrollUntilBand(
      until(),
      home(0, labelled, [{ role: 'adjustable', label: 'Cover', handlerless: true }]),
    ),
    CLEAR,
  );
  // Without the React entry the same box is a layer.
  assert.deepEqual(scrollUntilBand(until(), home(0, layers)), CLEAR);
});

test('G2 a layer that does not hold the whole list still cuts it', () => {
  for (const [name, rect, height] of [
    ['starts lower', { x: 0, y: 300, width: 402, height: 574 }, 296],
    ['narrower', { x: 0, y: 0, width: 200, height: 874 }, 0],
    ['ends higher', { x: 0, y: 0, width: 402, height: 500 }, 283],
    ['starts to the right', { x: 100, y: 0, width: 302, height: 874 }, 0],
    ['wider than the list but shifted left', { x: -100, y: 0, width: 450, height: 874 }, 0],
  ] as const) {
    const screen = home(0, [{ ...TOOLBAR, rect }]);
    assert.equal(scrollUntilBand(until(), screen)?.height, height, name);
  }
});

test('G3 a layer whose own React host takes touches still erases the band', async () => {
  // A presence capture carries the raw tree, in which the content hangs under its window.
  // Only a plain view can be matched to a React host, so the layer here is the closed sheet's box.
  const base = nodes(0, [{ ...SHEET[0], identifier: 'layer' }, SHEET[1]]).map((node) =>
    node.ref === '@root' ? { ...node, parentIndex: 1 } : node,
  );
  const depth = (node: NativeNode): number => {
    const parent = base.find((other) => other.index === node.parentIndex);
    return parent ? depth(parent) + 1 : 0;
  };
  const native = base.map((node) => ({
    ...node,
    depth: depth(node),
    enabled: true,
    presence: {
      captureId: 'c',
      generation: 1,
      nodeIndex: node.index,
      status: node.type === 'Application' ? 'unknown' : 'observed',
      labelSource: 'direct',
      ...(node.type === 'Application' ? {} : { observedUptimeMs: 150 }),
    },
  }));
  const proven = (pointerEvents: 'auto' | 'box-none', capabilities: { press?: boolean } = {}) =>
    captureScreen({
      appId: 'com.test',
      native: async () => ({
        keyboardVisible: false,
        presenceCapture: {
          version: 2,
          appliedBudgetMs: 20_000,
          source: 'xcui-live',
          captureId: 'c',
          appId: 'com.test',
          generation: 1,
          startedUptimeMs: 100,
          endedUptimeMs: 200,
          enumeration: 'raw-unfiltered',
          complete: true,
        },
        nodes: native,
        snapshotGeneration: 1,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict: {
          state: 'ok',
          nodeCount: native.length,
          refMapUpdated: true,
          reasons: [],
        },
      }),
      react: async () => ({
        interactive: [],
        hostEvidence: {
          complete: true,
          hosts: [{ testID: 'layer', role: null, roleSource: 'none', capabilities, pointerEvents }],
          typography: {
            version: 1,
            complete: true,
            durationMs: 10,
            coordinateSpace: 'window-points',
            nodes: [
              {
                hostIndex: 0,
                parentHostIndex: null,
                rootIndex: 0,
                hostType: 'RCTView',
                rect: WINDOW,
                text: { kind: 'none' },
              },
            ],
          },
        },
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    } as never);
  const opaque = await proven('auto');
  assert.equal(
    touchPolicy(opaque.elements.find((element) => element.testID === 'layer')!),
    'opaque',
  );
  assert.equal(scrollUntilBand(until(), opaque)?.height, 0);
  assert.equal(scrollUntilBand(until(), await proven('box-none'))?.height, 787);
  // A host that passes touches to its children but has a press handler of its own is a control.
  assert.equal(scrollUntilBand(until(), await proven('box-none', { press: true }))?.height, 0);
});
