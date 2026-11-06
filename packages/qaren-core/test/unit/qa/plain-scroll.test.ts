import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { plainScrollBand, scrollUntilBand } from '../../../dist/qa/resolve.js';
import { scrollMotion } from '../../../dist/qa/scroll-motion.js';
import { join, screenSignature, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { walkBlock, type ActResult } from '../../../dist/qa/walker.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const WINDOW = { x: 0, y: 0, width: 400, height: 800 };
const LIST = { x: 20, y: 200, width: 360, height: 400 };
type Rect = NonNullable<NativeNode['rect']>;

type ScreenOptions = {
  list?: Rect;
  childY?: number;
  extra?: NativeNode[];
  includeList?: boolean;
  type?: string;
};

function screen(options: ScreenOptions = {}): Screen {
  return { ...join(nodesOf(options), []), coverage: { native: 'complete', react: 'complete' } };
}

// The same nodes as a platform-presence capture whose React hosts are matched by testID.
function presenceScreen(
  options: ScreenOptions,
  pointerEvents: Record<string, 'auto' | 'none' | 'box-none' | undefined>,
  hidden?: 'host' | 'ancestor',
): Promise<Screen> {
  const base = nodesOf(options);
  const depth = (node: NativeNode): number => {
    const parent = base.find((other) => other.index === node.parentIndex);
    return parent ? depth(parent) + 1 : 0;
  };
  const nodes = base.map((node) => ({
    ...node,
    depth: depth(node),
    enabled: true,
    presence: {
      captureId: 'c',
      generation: 7,
      nodeIndex: node.index,
      status: node.type === 'Application' ? 'unknown' : 'observed',
      labelSource: 'direct',
      ...(node.type === 'Application' ? {} : { observedUptimeMs: 150 }),
    },
  }));
  const ids = [...(hidden === 'ancestor' ? ['ancestor'] : []), ...Object.keys(pointerEvents)];
  const hostEvidence = {
    complete: true,
    hosts: ids.map((testID) => ({
      testID,
      role: null,
      roleSource: 'none',
      capabilities: {},
      ...((hidden === 'host' && testID === 'fixed') || testID === 'ancestor'
        ? { hidden: true }
        : {}),
      ...(pointerEvents[testID] ? { pointerEvents: pointerEvents[testID] } : {}),
    })),
    typography: {
      version: 1,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points',
      nodes: ids.map((testID, hostIndex) => ({
        hostIndex,
        parentHostIndex: hidden === 'ancestor' && testID === 'fixed' ? 0 : null,
        rootIndex: hidden === 'ancestor' && testID === 'fixed' ? 0 : hostIndex,
        hostType: 'RCTView',
        rect: nodes.find((node) => node.identifier === testID)!.rect,
        text: { kind: 'none' },
      })),
    },
  };
  return captureScreen({
    appId: 'com.test',
    native: async () => ({
      keyboardVisible: false,
      presenceCapture: {
        version: 2,
        appliedBudgetMs: 20_000,
        source: 'xcui-live',
        captureId: 'c',
        appId: 'com.test',
        generation: 7,
        startedUptimeMs: 100,
        endedUptimeMs: 200,
        enumeration: 'raw-unfiltered',
        complete: true,
      },
      nodes,
      snapshotGeneration: 7,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
    }),
    react: async () => ({
      interactive: [],
      hostEvidence,
      verdict: { state: 'ok', path: 'interactive', complete: true },
    }),
  } as never);
}

function nodesOf({
  list = LIST,
  childY = 300,
  extra = [],
  includeList = true,
  type = 'ScrollView',
}: ScreenOptions = {}): NativeNode[] {
  return [
    { index: 0, ref: '@app', type: 'Application', rect: WINDOW },
    { index: 1, parentIndex: 0, ref: '@window', type: 'Window', rect: WINDOW },
    ...(includeList
      ? [
          { index: 2, parentIndex: 1, ref: '@list', type, label: 'List', rect: list },
          {
            index: 3,
            parentIndex: 2,
            ref: '@row',
            type: 'StaticText',
            identifier: 'row',
            label: 'Row',
            rect: { x: 40, y: childY, width: 200, height: 30 },
          },
        ]
      : []),
    ...extra,
  ];
}

function overlay(rect: Rect): NativeNode {
  return {
    index: 4,
    parentIndex: 1,
    ref: '@fixed',
    type: 'Button',
    identifier: 'fixed',
    hittable: true,
    label: 'Fixed',
    rect,
  };
}

async function run(
  screens: Screen[],
  {
    act,
    singleAttempt,
    direction = 'down',
    presence,
    presenceDelayMs = 0,
  }: {
    act?: ActResult;
    singleAttempt?: boolean;
    direction?: 'up' | 'down';
    // What a platform-presence capture returns; ordinary captures keep the scripted screens.
    presence?: Screen | (() => Promise<Screen>);
    presenceDelayMs?: number;
  } = {},
) {
  const f = walker(
    screens,
    scriptedJudge(() => {
      throw new Error('unexpected model call');
    }),
    act,
  );
  const ordinary = f.deps.captureScreen;
  const presenceCaptures: number[] = [];
  f.deps.captureScreen = async (options) => {
    if (!options?.platformPresence) return ordinary(options);
    presenceCaptures.push(1);
    if (presenceDelayMs) await f.deps.sleep(presenceDelayMs);
    return typeof presence === 'function' ? presence() : (presence ?? ordinary(options));
  };
  const bands: (Rect | undefined)[] = [];
  const distances: (number | undefined)[] = [];
  f.deps.platform = 'ios';
  const dispatch = f.deps.scroll;
  f.deps.scroll = async (dir, context, clearance, band) => {
    context!.authorize();
    bands.push(band);
    distances.push(clearance);
    return dispatch(dir, context, clearance, band);
  };
  const plan = parsePlan(`1. Scroll ${direction}\n`);
  assert.ok(plan.blocks);
  const result = await walkBlock(
    plan.blocks[0],
    f.deps,
    undefined,
    undefined,
    undefined,
    undefined,
    { singleAttempt },
  );
  return { ...f, bands, distances, result, presenceCaptures: presenceCaptures.length };
}

// The executable coordinate builder is the oracle for whether a selected band really hosts a drag.
function coordinates(band: Rect | undefined, direction: 'up' | 'down' = 'down', distance?: number) {
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@window', type: 'Window', rect: WINDOW }] as never, {
    snapshotGeneration: 1,
    keyboardVisible: false,
  });
  try {
    return buildDirectionalScrollCliArgs(direction, 0.6, undefined, distance, band);
  } finally {
    clearRefMap();
  }
}

test('plain scroll chooses the largest positive band and cuts a sticky footer', async () => {
  const s = screen({
    extra: [
      overlay({ x: 0, y: 540, width: 400, height: 100 }),
      {
        index: 5,
        parentIndex: 1,
        ref: '@small',
        type: 'ScrollView',
        label: 'Small',
        rect: { x: 0, y: 50, width: 100, height: 100 },
      },
    ],
  });
  const f = await run([s]);
  assert.deepEqual(f.bands, [
    { x: 20, y: 200, width: 360, height: 336 },
    { x: 20, y: 200, width: 360, height: 336 },
  ]);
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'overlay-cut');
  const [, x, y1, , y2] = coordinates(f.bands[0]).map(Number);
  assert.equal(x, 200);
  assert.ok(y1 < 540 && y2 >= 200);
});

test('a scroll container whose centre is off-window still offers its usable top strip', async () => {
  const f = await run([screen({ list: { x: 20, y: 650, width: 360, height: 500 }, childY: 700 })]);
  assert.deepEqual(f.bands[0], { x: 20, y: 650, width: 360, height: 150 });
  assert.equal(f.result.block.outcome, 'pass');
});

test('a fixed header covering the clip centre refuses without dispatch and supplies a plan edit', async () => {
  const options = { extra: [overlay(WINDOW)] };
  const f = await run([screen(options)], {
    presence: await presenceScreen(options, { fixed: 'auto' }),
  });
  assert.equal(f.presenceCaptures, 1);
  assert.deepEqual(f.bands, []);
  assert.equal(f.result.failure?.cause, 'scroll_container_unreachable');
  assert.match(
    renderReason(f.result.failure!.seen, (s) => s),
    /^SCROLL_CONTAINER_UNREACHABLE:/,
  );
  assert.match(f.result.failure!.suggestion!, /Scroll down until <target>/);
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'unreachable');
});

test('a full-height side rail keeps the centre drag clear instead of falsely refusing', async () => {
  const f = await run([screen({ extra: [overlay({ x: 20, y: 0, width: 40, height: 800 })] })]);
  assert.equal(f.result.block.outcome, 'pass');
  assert.equal(f.bands.length, 2);
  const [, x] = coordinates(f.bands[0]).map(Number);
  assert.equal(x, 200);
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'overlay-cut');
});

test('a header leaving only a 26pt strip refuses instead of dragging the covered viewport centre', async () => {
  const options = { extra: [overlay({ x: 0, y: 0, width: 400, height: 570 })] };
  const f = await run([screen(options)], {
    presence: await presenceScreen(options, { fixed: undefined }),
  });
  assert.equal(f.presenceCaptures, 1);
  assert.deepEqual(f.bands, []);
  assert.equal(f.result.failure?.cause, 'scroll_container_unreachable');
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'unreachable');
  assert.equal(f.rows.at(-1)?.scrollDetail, undefined);
});

test('a zero-area corridor cannot hide a covered container when no positive band remains', async () => {
  const options = {
    extra: [
      overlay(WINDOW),
      {
        index: 5,
        parentIndex: 1,
        ref: '@small',
        type: 'ScrollView',
        label: 'Small',
        rect: { x: 0, y: 50, width: 100, height: 100 },
      },
      {
        index: 6,
        parentIndex: 1,
        ref: '@rail',
        type: 'Button',
        label: 'Rail',
        hittable: true,
        rect: { x: 0, y: 50, width: 48, height: 100 },
      },
    ],
  };
  const f = await run([screen(options)], {
    presence: await presenceScreen(options, { fixed: 'auto' }),
  });
  assert.deepEqual(f.bands, []);
  assert.equal(f.result.failure?.cause, 'scroll_container_unreachable');
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'unreachable');
});

test('an overlay-cut thin strip with a clear centre keeps the too-small viewport fallback', async () => {
  const f = await run([
    screen({
      extra: [
        overlay({ x: 0, y: 200, width: 400, height: 180 }),
        { ...overlay({ x: 0, y: 420, width: 400, height: 180 }), index: 5, ref: '@footer' },
      ],
    }),
  ]);
  assert.equal(f.result.block.outcome, 'pass');
  assert.deepEqual(f.bands, [undefined, undefined]);
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'too-small');
  assert.deepEqual(f.rows.at(-1)?.scrollBand?.band, { x: 20, y: 384, width: 360, height: 32 });
  assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change');
});

test('a capture without an application or window frame keeps the no-geometry fallback', () => {
  const s = {
    ...join(
      [
        { index: 0, ref: '@list', type: 'ScrollView', label: 'List', rect: LIST },
        { ...overlay(WINDOW), index: 1, parentIndex: undefined },
      ],
      [],
    ),
    coverage: { native: 'complete', react: 'complete' },
  } as Screen;
  assert.equal(plainScrollBand(s, 'down').status, 'no-geometry');
});

test('plain scroll preserves viewport travel and clamps it to a smaller selected band', async () => {
  for (const direction of ['up', 'down'] as const) {
    const full = await run([screen({ list: WINDOW })], { direction });
    assert.equal(full.distances[0], 192);
    const [, , start, , end] = coordinates(full.bands[0], direction, full.distances[0]).map(Number);
    assert.equal(Math.abs(end - start), 192);

    const small = await run([screen({ list: { ...LIST, height: 100 } })], { direction });
    assert.equal(small.distances[0], 192);
    const [, , smallStart, , smallEnd] = coordinates(
      small.bands[0],
      direction,
      small.distances[0],
    ).map(Number);
    assert.equal(Math.abs(smallEnd - smallStart), 89);
    assert.ok(smallStart >= 200 && smallStart < 300);
    assert.ok(smallEnd >= 200 && smallEnd < 300);
  }
});

test('no container and an intrinsically empty CollectionView use a no-geometry viewport fallback', async () => {
  for (const s of [
    screen({ includeList: false }),
    screen({ type: 'CollectionView', list: { ...LIST, height: 0 } }),
  ]) {
    const f = await run([s]);
    assert.equal(f.result.block.outcome, 'pass');
    assert.deepEqual(f.bands, [undefined, undefined]);
    assert.equal(f.rows.at(-1)?.scrollBand?.status, 'no-geometry');
    assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change');
  }
});

test('undersized and post-inset and rounded-travel bands fall back before the handler can refuse', async () => {
  for (const list of [
    { ...LIST, height: 40 },
    { ...LIST, y: 0, height: 50 },
    { ...LIST, y: 200.8, height: 50 },
    { ...LIST, width: 1 },
  ]) {
    const s = screen({ list });
    assert.throws(() => coordinates(list), /SCROLL_BAND_TOO_SMALL/);
    const f = await run([s]);
    assert.equal(f.result.block.outcome, 'pass');
    assert.deepEqual(f.bands, [undefined, undefined]);
    assert.equal(f.rows.at(-1)?.scrollBand?.status, 'too-small');
    assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change');
    assert.doesNotThrow(() => coordinates(f.bands[0]));
  }
});

test('frame movement inside one signature bucket passes after the first drag, including single-attempt runs', async () => {
  const before = screen();
  const after = screen({ childY: 290 });
  assert.equal(screenSignature(before), screenSignature(after));
  for (const singleAttempt of [false, true]) {
    const f = await run([before, after, after, after], { singleAttempt });
    assert.equal(f.result.block.outcome, 'pass');
    assert.equal(f.bands.length, 1);
    assert.equal(f.rows.at(-1)?.scrollDetail, undefined);
    assert.equal(f.result.rows.at(-1)?.reason, undefined);
  }
});

test('unchanged descendant frames beyond the container frame warn in either scroll direction', async () => {
  for (const [direction, childY] of [
    ['down', 620],
    ['up', 150],
  ] as const) {
    const f = await run([screen({ childY })], { direction });
    assert.equal(f.result.block.outcome, 'pass');
    assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change_content_remains');
    assert.match(
      renderReason(f.result.rows.at(-1)!.reason!, (s) => s),
      /nothing moved although content extends beyond it/,
    );
  }
});

test('overflow past the window clip alone does not claim content beyond the container', async () => {
  const f = await run([screen({ list: { ...LIST, height: 1000 }, childY: 900 })]);
  assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change');
});

test('stillness without overflow keeps the existing note', async () => {
  const f = await run([screen()]);
  assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change');
  assert.match(
    renderReason(f.result.rows.at(-1)!.reason!, (s) => s),
    /^SCROLL_NO_VISIBLE_CHANGE:/,
  );
});

test('missing or ambiguous container or descendant rebinding never strengthens stillness evidence', async () => {
  const before = screen({ childY: 620 });
  const container = plainScrollBand(before, 'down').container!;
  const ambiguous = screen({
    childY: 620,
    extra: [
      { index: 4, parentIndex: 1, ref: '@twin', type: 'ScrollView', label: 'Twin', rect: LIST },
    ],
  });
  const duplicates = screen({
    childY: 620,
    extra: [
      {
        index: 4,
        parentIndex: 2,
        ref: '@twin',
        type: 'StaticText',
        identifier: 'row',
        label: 'Row',
        rect: { x: 40, y: 620, width: 200, height: 30 },
      },
    ],
  });
  for (const after of [screen({ includeList: false }), ambiguous, duplicates]) {
    assert.equal(scrollMotion(container, before, after, 'down'), 'unknown');
  }
  const f = await run([duplicates]);
  assert.equal(f.rows.at(-1)?.scrollDetail?.status, 'no_visible_change');
});

test('dispatch error and context-change precedence survives frame movement', async () => {
  const before = screen();
  const after = screen({ childY: 290 });
  const failed = await run([before, after], {
    act: { ok: true, proven: false, error: 'settle failed' },
  });
  assert.equal(failed.result.failure?.cause, 'scroll_dispatch_failed');
  const context = await run([before, { ...after, front: 'dialog' }]);
  assert.equal(context.result.failure?.cause, 'scroll_context_changed');
  assert.equal(context.bands.length, 1);
});

test('incomplete capture keeps the viewport path and cannot use geometry to pass', async () => {
  const before = { ...screen(), coverage: { native: 'incomplete', react: 'complete' } } as Screen;
  const after = { ...screen({ childY: 290 }), coverage: before.coverage };
  const f = await run([before, after]);
  assert.equal(f.result.block.outcome, 'fail');
  assert.equal(plainScrollBand(before, 'down').status, 'no-geometry');
  assert.ok(f.bands.every((band) => band === undefined));
  assert.ok(f.rows.every((row) => row.scrollDetail === undefined));
});

test('distinct frames rebind anonymous descendants without hiding a named row movement', async () => {
  const extra: NativeNode[] = [
    {
      index: 4,
      parentIndex: 2,
      ref: '@wrapper-a',
      type: 'Other',
      rect: { x: 30, y: 210, width: 300, height: 100 },
    },
    {
      index: 5,
      parentIndex: 2,
      ref: '@wrapper-b',
      type: 'Other',
      rect: { x: 30, y: 410, width: 300, height: 100 },
    },
  ];
  const before = screen({ extra });
  const after = screen({ childY: 290, extra });
  assert.equal(screenSignature(before), screenSignature(after));
  const f = await run([before, after]);
  assert.equal(f.result.block.outcome, 'pass');
  assert.equal(f.bands.length, 1);
  assert.equal(f.rows.at(-1)?.scrollDetail, undefined);
});

test('a remaining usable strip under a tall fixed header can move the list', async () => {
  const extra = [overlay({ x: 0, y: 0, width: 400, height: 500 })];
  const before = screen({ extra });
  const after = screen({ childY: 290, extra });
  const f = await run([before, after]);
  assert.equal(f.result.block.outcome, 'pass');
  assert.deepEqual(f.bands, [{ x: 20, y: 504, width: 360, height: 96 }]);
  assert.doesNotThrow(() => coordinates(f.bands[0]));
});

test('a pointer-transparent cover proven by the presence recapture lets the drag through', async () => {
  for (const pointerEvents of ['none', 'box-none'] as const) {
    const options = { extra: [overlay(WINDOW)] };
    const f = await run([screen(options)], {
      presence: await presenceScreen(options, { fixed: pointerEvents }),
    });
    assert.ok(f.presenceCaptures >= 1, pointerEvents);
    assert.equal(f.result.failure?.cause, undefined, pointerEvents);
    assert.deepEqual(f.bands[0], LIST, pointerEvents);
    assert.equal(f.rows.at(-1)?.scrollBand?.status, 'clear', pointerEvents);
  }
});

test('accessibility-hidden hosts and ancestors still block plain scroll touches', async () => {
  for (const hidden of ['host', 'ancestor'] as const) {
    const options = {
      extra:
        hidden === 'ancestor'
          ? [
              {
                index: 4,
                parentIndex: 1,
                ref: '@ancestor',
                identifier: 'ancestor',
                type: 'Other',
                rect: WINDOW,
              },
              { ...overlay(WINDOW), index: 5, parentIndex: 4 },
            ]
          : [overlay(WINDOW)],
    };
    const presence = await presenceScreen(options, { fixed: 'auto' }, hidden);
    for (const direction of ['up', 'down'] as const) {
      const f = await run([screen(options)], { presence, direction });
      assert.equal(f.presenceCaptures, 1);
      assert.deepEqual(f.bands, []);
      assert.equal(f.result.failure?.cause, 'scroll_container_unreachable');
      assert.equal(f.rows.at(-1)?.scrollBand?.status, 'unreachable');
    }
  }
});

test('scroll-until keeps overlay cuts that plain scroll can pass through', async () => {
  for (const pointerEvents of ['none', 'box-none'] as const) {
    const s = await presenceScreen(
      { childY: 900, extra: [overlay({ x: 0, y: 500, width: 400, height: 300 })] },
      { fixed: pointerEvents },
    );
    assert.deepEqual(plainScrollBand(s, 'down').band, LIST);
    assert.equal(s.elements.find((element) => element.testID === 'row')?.offscreen, true);
    for (const direction of ['up', 'down']) {
      for (const target of ['absent', 'row']) {
        const step = parseStep(`Scroll ${direction} until "${target}"`);
        assert.ok(step && !('refuse' in step) && step.kind === 'scroll' && step.until);
        assert.deepEqual(scrollUntilBand(step.until, s), { ...LIST, height: 296 });
      }
    }
  }
});

test('a cover still unproven after the presence recapture dispatches and is judged by the result', async () => {
  const options = { extra: [overlay(WINDOW)] };
  const f = await run([screen(options)], { presence: await presenceScreen(options, {}) });
  assert.ok(f.presenceCaptures >= 1);
  assert.equal(f.result.block.outcome, 'pass');
  assert.equal(f.result.failure, undefined);
  assert.deepEqual(f.bands, [LIST, LIST]);
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'overlay-cut');
  assert.equal(f.rows.at(-1)?.scrollBand && 'unproven' in f.rows.at(-1)!.scrollBand!, false);
});

test('an incomplete presence recapture never adds a refusal and falls through to dispatch', async () => {
  const options = { extra: [overlay(WINDOW)] };
  const incomplete: Screen = {
    ...screen(options),
    coverage: { native: 'incomplete', react: 'complete' },
  };
  const f = await run([screen(options)], { presence: incomplete });
  assert.ok(f.presenceCaptures >= 1);
  assert.equal(f.result.block.outcome, 'pass');
  assert.doesNotMatch(f.result.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.deepEqual(f.bands, [LIST, LIST]);
});

test('a system dialog appearing during presence recapture blocks either scroll direction', async () => {
  const options = { extra: [overlay(WINDOW)] };
  const dialog: Screen = { ...screen(options), front: 'dialog' };
  for (const direction of ['up', 'down'] as const) {
    const f = await run([screen(options), dialog], { presence: dialog, direction });
    assert.equal(f.presenceCaptures, 1);
    assert.deepEqual(f.bands, []);
    assert.deepEqual(f.actions, []);
    assert.equal(f.result.block.outcome, 'fail');
    assert.match(
      renderReason(f.result.failure?.seen ?? '', (text) => text),
      /system dialog/,
    );
    assert.ok(f.rows.every((row) => row.scrollDetail === undefined));
  }
});

test('an explicitly hidden container cannot outrank the visible list', () => {
  const visible = { x: 0, y: 300, width: 400, height: 200 };
  const band = plainScrollBand(
    screen({
      list: visible,
      childY: 350,
      extra: [
        {
          index: 4,
          parentIndex: 1,
          ref: '@hidden',
          type: 'ScrollView',
          label: 'Hidden',
          visibleToUser: false,
          rect: WINDOW,
        },
      ],
    }),
    'down',
    'android',
  );
  assert.equal(band.container?.ref, '@list');
  assert.deepEqual(band.band, visible);
});

test('a smaller clear list wins when the largest band is a thin strip under an unproven cover', async () => {
  const small = { x: 300, y: 610, width: 50, height: 180 };
  const f = await run([
    screen({
      extra: [
        overlay({ x: 0, y: 0, width: 400, height: 570 }),
        {
          index: 5,
          parentIndex: 1,
          ref: '@small',
          type: 'ScrollView',
          label: 'Small',
          rect: small,
        },
      ],
    }),
  ]);
  assert.equal(f.presenceCaptures, 0);
  assert.deepEqual(f.bands[0], small);
  assert.equal(f.result.failure, undefined);
});

test('a drag across an unproven cover stops short of a proven opaque cover', async () => {
  const band = plainScrollBand(
    await presenceScreen(
      {
        extra: [
          overlay(WINDOW),
          {
            index: 5,
            parentIndex: 1,
            ref: '@footer',
            type: 'Button',
            identifier: 'footer',
            hittable: true,
            label: 'Footer',
            rect: { x: 0, y: 520, width: 400, height: 80 },
          },
        ],
      },
      { footer: 'auto' },
    ),
    'down',
    'ios',
  );
  assert.equal(band.unproven, true);
  assert.equal(band.container?.ref, '@list');
  assert.deepEqual(band.band, { x: 20, y: 200, width: 360, height: 316 });
});

test('complete unproven recaptures retain opaque cuts, freshness and the motion baseline', async () => {
  for (const direction of ['up', 'down'] as const) {
    const cover =
      direction === 'down'
        ? { x: 0, y: 520, width: 400, height: 80 }
        : { x: 0, y: 200, width: 400, height: 80 };
    const extra = [
      overlay(WINDOW),
      { ...overlay(cover), index: 5, ref: '@edge', identifier: 'edge' },
    ];
    for (const presenceDelayMs of [0, 12_000]) {
      let captures = 0;
      const f = await run([screen({ extra })], {
        direction,
        presenceDelayMs,
        presence: () =>
          presenceScreen({ extra, childY: captures++ === 0 ? 310 : 300 }, { edge: 'auto' }),
      });
      const expected = { ...LIST, y: direction === 'down' ? 200 : 284, height: 316 };
      assert.equal(f.result.block.outcome, 'pass');
      assert.equal(f.result.failure, undefined);
      assert.deepEqual(f.bands, [expected]);
      assert.equal(f.presenceCaptures, 2);
      assert.deepEqual(f.rows.at(-1)?.scrollBand?.band, expected);
      const [, , start, , end] = coordinates(f.bands[0], direction, f.distances[0]).map(Number);
      for (const y of [start, end]) assert.ok(y < cover.y || y >= cover.y + cover.height);
    }
  }
});
