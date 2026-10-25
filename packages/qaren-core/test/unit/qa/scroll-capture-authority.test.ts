import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, refCenter, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

const frame = { x: 0, y: 0, width: 402, height: 874 };
type Snapshot = {
  footer?: boolean;
  footerY?: number;
  footerHeight?: number;
  footerLabel?: string;
  footerType?: NativeNode['type'];
  footerRect?: NonNullable<NativeNode['rect']>;
  listID?: string;
  listFrame?: NonNullable<NativeNode['rect']>;
  tab?: string;
  title?: string;
  overlays?: NonNullable<NativeNode['rect']>[];
};

function fixture(established = false) {
  let drags = 0;
  const modes: boolean[] = [];
  const endpoints: number[][] = [];
  const f = walker(
    [],
    scriptedJudge((questions, _index, state) =>
      Object.fromEntries(
        Object.keys(questions).map((id) => [
          id,
          {
            type: 'noul',
            noul: JSON.stringify(state).includes('Footer') ? 0.9 : 0.1,
          },
        ]),
      ),
    ),
  );
  let snapshot: (presence: boolean) => Promise<Snapshot> = async () => ({ footer: drags > 0 });
  f.deps.captureScreen = async (options) => {
    const presence = options?.platformPresence === true;
    modes.push(presence);
    const state = await snapshot(presence);
    const source = nativeCapture();
    const raw: NativeNode[] = [
      { type: 'Application', rect: frame },
      { type: 'Window', parentIndex: 0, rect: frame },
      {
        type: 'ScrollView',
        parentIndex: 1,
        identifier: state.listID,
        rect: state.listFrame ?? frame,
      },
      {
        type: state.footerType ?? (state.footerLabel ? 'Other' : 'StaticText'),
        parentIndex: 2,
        identifier: state.footer ? 'footer' : 'loading',
        label: state.footer ? (state.footerLabel ?? 'Footer') : 'Loading',
        rect: state.footerRect ?? {
          x: 10,
          y: state.footerY ?? 200,
          width: 100,
          height: state.footerHeight ?? 30,
        },
      },
      ...(state.overlays ?? []).map((rect) => ({ type: 'Button', parentIndex: 1, rect })),
    ];
    if (state.tab)
      raw.push({
        type: 'Button',
        parentIndex: 1,
        selected: true,
        label: state.tab,
        rect: { x: 0, y: 820, width: 100, height: 40 },
      });
    if (state.title)
      raw.push({
        type: 'NavigationBar',
        parentIndex: 1,
        hittable: false,
        label: state.title,
        rect: { x: 0, y: 0, width: 402, height: 60 },
      });
    const depth = (i: number): number =>
      raw[i].parentIndex === undefined ? 0 : depth(raw[i].parentIndex!) + 1;
    const nodes = raw.map((node, index) => ({
      ...node,
      ref: `@e${index}`,
      index,
      depth: depth(index),
      enabled: true,
      hittable: node.hittable ?? true,
      ...(presence ? { presence: { ...source.nodes[1].presence, nodeIndex: index } } : {}),
    }));
    updateRefMapFromFlat(nodes);
    const screen = await captureScreen({
      appId: 'com.test',
      platformPresence: presence,
      now: f.deps.now,
      native: async () => ({
        ...attested(nodes),
        snapshotGeneration: source.snapshotGeneration,
        ...(presence ? { presenceCapture: source.presenceCapture } : {}),
      }),
      react: async () => ({
        interactive: [],
        hostEvidence: { complete: true, hosts: [] },
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    });
    if (established)
      for (const element of screen.elements) {
        element.semantic = {
          ...element.semantic!,
          visibility: 'visible',
          nativePresence: {
            kind: element.kind,
            labelSource: 'direct',
            structural: !['text', 'button'].includes(element.kind),
          },
        };
      }
    return screen;
  };
  f.deps.scroll = async (direction, context, _distance, band) => {
    context!.authorize();
    endpoints.push(
      buildDirectionalScrollCliArgs(direction, 0.6, undefined, undefined, band)
        .slice(1, 5)
        .map(Number),
    );
    drags += 1;
    return { ok: true, proven: true };
  };
  return {
    f,
    modes,
    endpoints,
    drags: () => drags,
    setSnapshot: (next: typeof snapshot) => {
      snapshot = next;
    },
  };
}

async function run(
  f: ReturnType<typeof fixture>,
  direction: 'up' | 'down',
  mode: 'quoted' | 'phrase' | 'aggregate' | 'replay' | 'text-replay',
  phrase = 'the footer text',
) {
  const block = parsePlan(`1. Scroll ${direction} until ${mode === 'phrase' ? phrase : '"Footer"'}`)
    .blocks![0];
  if (mode === 'replay' || mode === 'text-replay') {
    const step = block.items[0];
    assert.ok(step.kind === 'scroll');
    step.until =
      mode === 'replay'
        ? { quoted: 'footer', phrase: 'footer', exact: 'id' }
        : { quoted: 'Footer', phrase: 'Footer', exact: 'text' };
  }
  return walkBlock(block, f.f.deps, 0, [], undefined, undefined, {
    mode: mode === 'replay' || mode === 'text-replay' ? 'replay' : 'walk',
  });
}

test('Home button partly overlapped by Quick add is reached and tapped after two drags', async () => {
  const f = fixture();
  const quickAdd = { x: 318, y: 730, width: 64, height: 64 };
  f.setSnapshot(async () => ({
    footer: f.drags() >= 2,
    footerType: 'Button',
    footerLabel: 'Input Libraries',
    footerRect: { x: 20, y: 744, width: 360, height: 48 },
    listID: 'home',
    tab: 'Home',
    overlays: [quickAdd],
  }));
  const press = f.f.deps.press;
  f.f.deps.press = async (ref, context) => {
    assert.equal(f.drags(), 2);
    assert.deepEqual(refCenter(ref), { x: 200, y: 768 });
    context!.authorize();
    return press(ref, context);
  };
  try {
    const result = await walkBlock(
      parsePlan('1. Scroll down until "Input Libraries"\n2. Tap "Input Libraries"').blocks![0],
      f.f.deps,
    );
    assert.equal(result.failure, undefined);
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 2);
    assert.deepEqual(f.f.actions, ['press @e3']);
    assert.ok(f.modes.every((presence) => !presence));
    assert.ok(f.endpoints.every(([, start, , end]) => start < 726 && end < 726));
  } finally {
    clearRefMap();
  }
});

test('sixth-drag target confirmation uses ordinary captures within the item deadline', async () => {
  const f = fixture();
  const scroll = f.f.deps.scroll;
  f.f.deps.scroll = async (...args) => {
    await f.f.deps.sleep(5_000);
    return scroll(...args);
  };
  f.setSnapshot(async (presence) => {
    await f.f.deps.sleep(presence ? (f.drags() === 5 ? 16_300 : 12_700) : 700);
    return {
      footer: f.drags() >= 5,
      footerY: f.drags() === 5 ? 818.7 : 200,
      footerHeight: 64,
      listID: 'feed',
      tab: 'A',
      listFrame: { x: 0, y: 106.67, width: 402, height: 767.33 },
      overlays: [{ x: 21, y: 791, width: 360, height: 70 }],
    };
  });
  try {
    const result = await run(f, 'down', 'quoted');
    assert.equal(result.failure, undefined);
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 6);
    assert.ok(f.modes.every((presence) => !presence));
  } finally {
    clearRefMap();
  }
});

test('row 58 under the floating tab bar is tapped only after the sixth drag clears its tap point', async () => {
  const f = fixture();
  f.setSnapshot(async () => ({
    footer: f.drags() >= 5,
    footerType: 'Button',
    footerRect: { x: 20, y: f.drags() === 5 ? 818.7 : 200, width: 360, height: 64 },
    listID: 'feed',
    tab: 'A',
    overlays: [{ x: 21, y: 791, width: 360, height: 70 }],
  }));
  const press = f.f.deps.press;
  f.f.deps.press = async (ref, context) => {
    assert.equal(f.drags(), 6);
    assert.deepEqual(refCenter(ref), { x: 200, y: 232 });
    context!.authorize();
    return press(ref, context);
  };
  try {
    const result = await walkBlock(
      parsePlan('1. Scroll down until "Footer"\n2. Tap "Footer"').blocks![0],
      f.f.deps,
    );
    assert.equal(result.failure, undefined);
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 6);
    assert.deepEqual(f.f.actions, ['press @e3']);
    assert.ok(f.modes.every((presence) => !presence));
    assert.ok(f.endpoints.every(([, start, , end]) => start < 787 && end < 787));
  } finally {
    clearRefMap();
  }
});

for (const direction of ['up', 'down'] as const) {
  for (const mode of ['quoted', 'phrase', 'aggregate', 'replay', 'text-replay'] as const) {
    for (const partial of [false, true]) {
      test(`overlapping target scrolls until its tap point is clear: ${direction}, ${mode}, partial=${partial}`, async () => {
        const f = fixture(mode === 'phrase');
        const overlay = { x: 21, y: direction === 'down' ? 791 : 80, width: 360, height: 70 };
        f.setSnapshot(async () => ({
          footer: mode === 'text-replay' || f.drags() > 0,
          footerLabel: mode === 'aggregate' ? 'Summary, Footer, Details' : undefined,
          footerY:
            f.drags() === 1 || (mode === 'text-replay' && f.drags() === 0)
              ? direction === 'down'
                ? partial
                  ? 770
                  : 800
                : partial
                  ? 145
                  : 100
              : 200,
          listID: 'feed',
          tab: 'A',
          overlays: [overlay],
        }));
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.failure, undefined);
          assert.equal(result.block.outcome, 'pass');
          assert.equal(f.drags(), partial ? (mode === 'text-replay' ? 0 : 1) : 2);
          assert.ok(f.modes.every((presence) => presence === (mode === 'phrase')));
          assert.ok(
            f.endpoints.every(([, start, , end]) =>
              direction === 'down'
                ? start < overlay.y - 4 && end < overlay.y - 4
                : start > overlay.y + overlay.height + 4 && end > overlay.y + overlay.height + 4,
            ),
          );
        } finally {
          clearRefMap();
        }
      });
    }
  }
  for (const refresh of ['reask', 'expired'] as const) {
    for (const navigation of ['tab', 'list'] as const) {
      test(`initial phrase ${refresh} refuses changed ${navigation} before scrolling: ${direction}`, async () => {
        const f = fixture(true);
        let captures = 0;
        f.setSnapshot(async () => ({
          footer: ++captures > 1,
          tab: navigation === 'tab' && captures > 1 ? 'B' : 'A',
          listID: navigation === 'list' && captures > 1 ? 'destination' : 'feed',
        }));
        f.f.deps.judge = scriptedJudge((questions, index) => {
          if (index === 0 && refresh === 'expired') void f.f.deps.sleep(10_001);
          return Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'noul', noul: index === 0 ? 0.5 : 0.9 },
            ]),
          );
        });
        try {
          const result = await run(f, direction, 'phrase');
          assert.equal(result.refusal?.code, 'SCROLL_NAVIGATED', JSON.stringify(result));
          assert.equal(f.drags(), 0);
          assert.equal(captures, 2);
        } finally {
          clearRefMap();
        }
      });
    }
  }
  test(`native title changes do not interrupt scrolling: ${direction}`, async () => {
    const f = fixture();
    f.setSnapshot(async () => ({
      footer: f.drags() > 0,
      title: f.drags() ? 'Claims' : 'Policies',
      tab: 'A',
      listID: 'feed',
    }));
    try {
      const result = await run(f, direction, 'quoted');
      assert.equal(result.block.outcome, 'pass');
      assert.equal(f.drags(), 1);
      assert.ok(f.modes.every((presence) => !presence));
    } finally {
      clearRefMap();
    }
  });
  test(`no clear band refuses before dispatch: ${direction}`, async () => {
    const f = fixture();
    f.setSnapshot(async () => ({ overlays: [frame, frame] }));
    try {
      await assert.rejects(run(f, direction, 'quoted'), /SCROLL_BAND_TOO_SMALL/);
      assert.equal(f.drags(), 0);
    } finally {
      clearRefMap();
    }
  });
}

test('under-bar continuation retains the six-drag bound', async () => {
  const f = fixture();
  f.setSnapshot(async () => ({
    footer: true,
    footerY: 800,
    listID: 'feed',
    overlays: [{ x: 21, y: 791, width: 360, height: 70 }],
  }));
  try {
    const result = await run(f, 'down', 'quoted');
    assert.equal(result.block.outcome, 'fail');
    assert.match(JSON.stringify(result.failure), /did not come into view after 6 scrolls/);
    assert.equal(f.drags(), 6);
    assert.ok(f.modes.every((presence) => !presence));
  } finally {
    clearRefMap();
  }
});

test('plain scroll retains its centered gesture and ordinary capture', async () => {
  const f = fixture();
  try {
    const result = await walkBlock(parsePlan('1. Scroll down').blocks![0], f.f.deps);
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 1);
    assert.deepEqual(f.endpoints, [[201, 542, 201, 332]]);
    assert.ok(f.modes.every((presence) => !presence));
  } finally {
    clearRefMap();
  }
});
