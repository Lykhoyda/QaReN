import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { plainScrollBand } from '../../../dist/qa/resolve.js';
import { scrollMotion } from '../../../dist/qa/scroll-motion.js';
import { join, screenSignature, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { walkBlock, type ActResult } from '../../../dist/qa/walker.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const WINDOW = { x: 0, y: 0, width: 400, height: 800 };
const LIST = { x: 20, y: 200, width: 360, height: 400 };
type Rect = NonNullable<NativeNode['rect']>;

function screen({
  list = LIST,
  childY = 300,
  extra = [],
  includeList = true,
  type = 'ScrollView',
}: {
  list?: Rect;
  childY?: number;
  extra?: NativeNode[];
  includeList?: boolean;
  type?: string;
} = {}): Screen {
  const nodes: NativeNode[] = [
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
  return { ...join(nodes, []), coverage: { native: 'complete', react: 'complete' } };
}

function overlay(rect: Rect): NativeNode {
  return {
    index: 4,
    parentIndex: 1,
    ref: '@fixed',
    type: 'Button',
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
  }: { act?: ActResult; singleAttempt?: boolean; direction?: 'up' | 'down' } = {},
) {
  const f = walker(
    screens,
    scriptedJudge(() => {
      throw new Error('unexpected model call');
    }),
    act,
  );
  const bands: (Rect | undefined)[] = [];
  const distances: (number | undefined)[] = [];
  f.deps.platform = 'ios';
  const dispatch = f.deps.scroll;
  f.deps.scroll = async (dir, context, clearance, band) => {
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
  return { ...f, bands, distances, result };
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
  const f = await run([screen({ extra: [overlay(WINDOW)] })]);
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
  const f = await run([screen({ extra: [overlay({ x: 0, y: 0, width: 400, height: 570 })] })]);
  assert.deepEqual(f.bands, []);
  assert.equal(f.result.failure?.cause, 'scroll_container_unreachable');
  assert.equal(f.rows.at(-1)?.scrollBand?.status, 'unreachable');
  assert.equal(f.rows.at(-1)?.scrollDetail, undefined);
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
