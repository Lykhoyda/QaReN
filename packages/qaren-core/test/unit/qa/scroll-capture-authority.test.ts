import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

const frame = { x: 0, y: 0, width: 402, height: 874 };
type Snapshot = {
  footer?: boolean;
  tab?: string;
  title?: string;
  toolbarY?: number;
  toolbarHittable?: boolean;
  overlays?: NonNullable<NativeNode['rect']>[];
};

function fixture() {
  let drags = 0;
  let reads = 0;
  const modes: boolean[] = [];
  const endpoints: number[][] = [];
  const judge = scriptedJudge((questions, _index, state) =>
    Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { type: 'noul', noul: JSON.stringify(state).includes('Footer') ? 0.9 : 0.1 },
      ]),
    ),
  );
  const f = walker([], judge);
  let snapshot: (presence: boolean, read: number) => Promise<Snapshot> = async () => ({
    footer: drags > 0,
  });
  const read: typeof f.deps.captureScreen = async (options) => {
    const presence = options?.platformPresence === true;
    modes.push(presence);
    const state = await snapshot(presence, ++reads);
    const source = nativeCapture();
    const rawNodes: NativeNode[] = [
      { type: 'Application', rect: frame },
      { type: 'Window', parentIndex: 0, rect: frame },
      { type: 'ScrollView', parentIndex: 1, rect: frame },
      {
        type: 'StaticText',
        parentIndex: 2,
        label: state.footer ? 'Footer' : 'Loading',
        identifier: state.footer ? 'footer' : 'loading',
        rect: { x: 10, y: 200, width: 100, height: 30 },
      },
      ...(presence
        ? [
            { type: 'Window', parentIndex: 0, rect: frame },
            { type: 'Other', parentIndex: 4, rect: frame },
            { type: 'Button', parentIndex: 5, rect: frame },
          ]
        : []),
      ...(state.toolbarY === undefined
        ? []
        : [
            { type: 'Window', parentIndex: 0, rect: frame },
            {
              type: 'Button',
              parentIndex: presence ? 7 : 4,
              hittable: state.toolbarHittable ?? true,
              rect: { x: 0, y: state.toolbarY, width: 402, height: 70 },
            },
          ]),
      ...(state.overlays ?? []).map((rect) => ({ type: 'Button', parentIndex: 1, rect })),
    ];
    if (state.tab)
      rawNodes.push({
        type: 'Button',
        parentIndex: 1,
        selected: true,
        label: state.tab,
        rect: { x: 0, y: 820, width: 100, height: 40 },
      });
    if (state.title)
      rawNodes.push({
        type: 'NavigationBar',
        hittable: false,
        parentIndex: 1,
        identifier: 'main-navigation',
        label: state.title,
        rect: { x: 0, y: 0, width: 402, height: 60 },
      });
    const depth = (index: number): number => {
      const parent = rawNodes[index].parentIndex;
      return parent === undefined ? 0 : depth(parent) + 1;
    };
    const nodes = rawNodes.map((node, index) => ({
      ...node,
      ref: `@e${index}`,
      index,
      depth: depth(index),
      enabled: true,
      hittable: node.hittable ?? true,
      ...(presence ? { presence: { ...source.nodes[1].presence, nodeIndex: index } } : {}),
    }));
    updateRefMapFromFlat(nodes);
    return captureScreen({
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
  };
  f.deps.captureScreen = read;
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
  mode: 'quoted' | 'phrase' | 'replay',
) {
  const block = parsePlan(
    `1. Scroll ${direction} until ${mode === 'phrase' ? 'the footer text' : '"Footer"'}`,
  ).blocks![0];
  if (mode === 'replay') {
    const step = block.items[0];
    assert.ok(step.kind === 'scroll');
    step.until = { quoted: 'footer', phrase: 'footer', exact: 'id' };
  }
  return walkBlock(block, f.f.deps, 0, [], undefined, undefined, {
    mode: mode === 'replay' ? 'replay' : 'walk',
  });
}

for (const direction of ['up', 'down'] as const) {
  for (const mode of ['quoted', 'phrase', 'replay'] as const) {
    test(`presence wrappers cannot collapse ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 1);
        assert.deepEqual(f.endpoints, [
          direction === 'down' ? [201, 758, 201, 102] : [201, 102, 201, 758],
        ]);
        assert.deepEqual(
          f.modes,
          mode === 'phrase'
            ? [false, true, false, false, true, false]
            : mode === 'replay'
              ? [false, false, false, true, false]
              : [false, false, true, false],
        );
      } finally {
        clearRefMap();
      }
    });

    test(`capture coherence uses only the ordinary toolbar frame: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async (presence) => ({
        footer: f.drags() > 0,
        toolbarY: presence ? 900 : 730,
      }));
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 1);
        const [, start, , end] = f.endpoints[0];
        assert.ok(start < 726 && end < 726, JSON.stringify(f.endpoints));
        assert.ok(start > 0 && end > 0);
        assert.deepEqual(
          f.modes,
          mode === 'phrase'
            ? [false, true, false, false, true, false]
            : mode === 'replay'
              ? [false, false, false, true, false]
              : [false, false, true, false],
        );
      } finally {
        clearRefMap();
      }
    });

    test(`a genuine full-screen ordinary overlay still refuses: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async () => ({ overlays: [frame, frame] }));
      try {
        await assert.rejects(run(f, direction, mode), /SCROLL_BAND_TOO_SMALL/);
        assert.equal(f.drags(), 0);
        assert.deepEqual(f.endpoints, []);
      } finally {
        clearRefMap();
      }
    });

    test(`negative presence cannot replace ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async (presence) => ({ footer: !presence, toolbarY: presence ? 900 : 730 }));
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.block.outcome, 'fail');
        assert.equal(f.drags(), 6);
        for (const [, start, , end] of f.endpoints)
          assert.ok(start < 726 && end < 726, JSON.stringify(f.endpoints));
        assert.ok(result.rows.every((row) => row.outcome !== 'pass'));
        assert.deepEqual(
          f.modes,
          Array.from({ length: 7 }, () =>
            mode === 'replay' ? [false, true, false, false] : [false, true, false],
          ).flat(),
        );
      } finally {
        clearRefMap();
      }
    });

    test(`stable navigation identifier cannot mask confirmation title changes: ${direction}, ${mode}`, async () => {
      const f = fixture();
      let navigated = false;
      f.setSnapshot(async (presence) => {
        if (presence) navigated = true;
        return { footer: true, tab: 'Policies', title: navigated ? 'Claims' : 'Policies' };
      });
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.refusal?.code, 'SCROLL_NAVIGATED');
        assert.equal(result.block.outcome, 'fail');
        assert.equal(f.drags(), 0);
        assert.ok(f.f.rows.every((row) => row.outcome !== 'pass'));
      } finally {
        clearRefMap();
      }
    });

    for (const refresh of [false, true]) {
      test(`confirmation navigation precedes target acceptance: ${direction}, ${mode}, refresh=${refresh}`, async () => {
        const f = fixture();
        let navigated = false;
        f.setSnapshot(async (presence) => {
          if (presence && f.drags() > 0) {
            navigated = true;
            if (refresh) await f.f.deps.sleep(11_000);
          }
          return { footer: f.drags() > 0, tab: navigated ? 'Claims' : 'Policies' };
        });
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.refusal?.code, 'SCROLL_NAVIGATED');
          assert.equal(result.block.outcome, 'fail');
          assert.equal(f.drags(), 1);
          assert.ok(f.f.rows.every((row) => row.outcome !== 'pass'));
        } finally {
          clearRefMap();
        }
      });

      test(`negative confirmation refreshes new toolbar clearance: ${direction}, ${mode}, refresh=${refresh}`, async () => {
        const f = fixture();
        let appeared = false;
        f.setSnapshot(async (presence) => {
          if (presence) {
            appeared = true;
            if (refresh) await f.f.deps.sleep(1_000);
          }
          return { footer: !presence, toolbarY: appeared ? 730 : undefined };
        });
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.block.outcome, 'fail');
          assert.equal(f.drags(), 6);
          for (const [, start, , end] of f.endpoints)
            assert.ok(start < 726 && end < 726, JSON.stringify(f.endpoints));
        } finally {
          clearRefMap();
        }
      });
    }

    test(`confirmation reveals a new full-screen blocker: ${direction}, ${mode}`, async () => {
      const f = fixture();
      let appeared = false;
      f.setSnapshot(async (presence) => {
        if (presence) appeared = true;
        return { footer: !presence, overlays: appeared ? [frame] : [] };
      });
      try {
        await assert.rejects(run(f, direction, mode), /SCROLL_BAND_TOO_SMALL/);
        assert.equal(f.drags(), 0);
      } finally {
        clearRefMap();
      }
    });

    test(`presence confirmation cannot renew expired ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      const completed: number[] = [];
      f.setSnapshot(async (presence, read) => {
        if (read === 1) await f.f.deps.sleep(2_000);
        if (read === 2) await f.f.deps.sleep(11_000);
        completed.push(f.f.deps.now());
        return { footer: !presence || read > 2 };
      });
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 0);
        assert.deepEqual(completed.slice(0, 2), [2_000, 13_000]);
        assert.deepEqual(f.modes, [false, true, false, true, false]);
      } finally {
        clearRefMap();
      }
    });
  }
}

test('quoted confirmation is requested only after an ordinary match', async () => {
  const f = fixture();
  f.setSnapshot(async (presence) => {
    if (presence)
      assert.equal(f.drags(), 1, 'no presence read may precede the ordinary target candidate');
    return { footer: f.drags() > 0, toolbarY: presence ? 730 : undefined };
  });
  try {
    const result = await run(f, 'down', 'quoted');
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 1);
    assert.deepEqual(f.modes, [false, false, true, false]);
  } finally {
    clearRefMap();
  }
});

test('plain scroll keeps the centered window gesture and ordinary captures', async () => {
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
