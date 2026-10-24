import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { EVIDENCE_USE_MS } from '../../../dist/qa/timing.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

const frame = { x: 0, y: 0, width: 402, height: 874 };
type Snapshot = {
  footer?: boolean;
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
  f.deps.captureOrdinaryScreen = (options) => read({ ...options, platformPresence: false });
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
    test(`ordinary geometry completing at 2s stays expired at 13s: ${direction}, ${mode}`, async () => {
      const f = fixture();
      const completed: number[] = [];
      f.setSnapshot(async (_presence, read) => {
        if (read === 1) await f.f.deps.sleep(2_000);
        if (read === 3) await f.f.deps.sleep(11_000);
        completed.push(f.f.deps.now());
        return { footer: read > 3 };
      });
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 0, 'expired ordinary geometry must refresh before dispatch');
        assert.deepEqual(completed.slice(0, 3), [2_000, 2_000, 13_000]);
        assert.deepEqual(f.modes, [true, false, true, true, false, true]);
      } finally {
        clearRefMap();
      }
    });

    for (const change of ['appeared', 'moved', 'became-hittable'] as const) {
      test(`a toolbar changing during final presence prevents the old endpoint: ${direction}, ${mode}, ${change}`, async () => {
        const f = fixture();
        f.setSnapshot(async (_presence, read) => ({
          toolbarY:
            read === 3 ? 730 : change === 'appeared' ? undefined : change === 'moved' ? 900 : 730,
          toolbarHittable: read === 3 || change !== 'became-hittable',
        }));
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.block.outcome, 'fail');
          assert.match(
            renderReason(result.failure?.seen ?? '', (text) => text),
            /SCREEN_EVIDENCE_INCOMPLETE: SCROLL_CLEARANCE_CHANGED/,
          );
          assert.equal(f.drags(), 0);
          assert.deepEqual(f.endpoints, []);
          assert.deepEqual(f.modes, [true, false, true]);
        } finally {
          clearRefMap();
        }
      });
    }

    for (const targetVisible of [false, true]) {
      test(`a new full-screen overlay sharing a wrapper rectangle stops before target acceptance: ${direction}, ${mode}, target visible=${targetVisible}`, async () => {
        const f = fixture();
        f.setSnapshot(async (_presence, read) => ({
          footer: read === 3 && targetVisible,
          overlays: read === 3 ? [frame] : [],
        }));
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.block.outcome, 'fail');
          assert.match(
            renderReason(result.failure?.seen ?? '', (text) => text),
            /SCREEN_EVIDENCE_INCOMPLETE: SCROLL_CLEARANCE_CHANGED/,
          );
          assert.equal(f.drags(), 0);
          assert.deepEqual(f.endpoints, []);
          assert.deepEqual(f.modes, [true, false, true]);
          assert.equal(
            f.f.deps.judge.calls.length,
            0,
            'clearance must be checked before target judgment',
          );
          assert.ok(result.rows.every((row) => row.outcome !== 'pass'));
        } finally {
          clearRefMap();
        }
      });
    }

    test(`overlay ordering does not change clearance: ${direction}, ${mode}`, async () => {
      const f = fixture();
      const top = { x: 0, y: 50, width: 402, height: 20 };
      const bottom = { x: 0, y: 730, width: 402, height: 70 };
      f.setSnapshot(async (_presence, read) => ({
        footer: f.drags() > 0,
        overlays: read % 3 === 0 ? [bottom, top] : [top, bottom],
      }));
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 1);
      } finally {
        clearRefMap();
      }
    });

    test(`stable raw presence wrappers preserve ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(f.drags(), 1);
        assert.deepEqual(f.endpoints, [
          direction === 'down' ? [201, 758, 201, 102] : [201, 102, 201, 758],
        ]);
      } finally {
        clearRefMap();
      }
    });
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const refresh of ['reask', 'decision-expiry', 'dispatch-expiry'] as const) {
    for (const overlay of ['toolbar', 'coincident'] as const) {
      test(`changed ${overlay} clearance refuses before target evaluation during ${refresh}: ${direction}`, async () => {
        const f = fixture();
        f.setSnapshot(async (_presence, read) => ({
          toolbarY: overlay === 'toolbar' && read === 9 ? 730 : undefined,
          overlays: overlay === 'coincident' && read === 9 ? [frame] : [],
          footer: read === 9,
        }));
        let now = 0;
        f.f.deps.now = () => now;
        f.f.deps.sleep = async (ms) => {
          now += ms;
        };
        f.f.deps.judge = scriptedJudge((questions, index) => {
          if (index === 1 && refresh === 'decision-expiry') now += EVIDENCE_USE_MS;
          return Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              {
                type: 'noul',
                noul: index === 1 && refresh === 'reask' ? 0.5 : 0.1,
              },
            ]),
          );
        });
        const scroll = f.f.deps.scroll;
        f.f.deps.scroll = async (...args) => {
          if (f.drags() === 1 && refresh === 'dispatch-expiry') {
            await f.f.deps.sleep(EVIDENCE_USE_MS);
            args[1]!.check();
            assert.fail('expired dispatch must refresh');
          }
          return scroll(...args);
        };
        try {
          const result = await run(f, direction, 'phrase');
          assert.equal(result.block.outcome, 'fail');
          assert.match(
            renderReason(result.failure?.seen ?? '', (text) => text),
            /SCREEN_EVIDENCE_INCOMPLETE: SCROLL_CLEARANCE_CHANGED/,
          );
          assert.equal(f.drags(), 1);
          assert.equal(
            f.f.deps.judge.calls.length,
            2,
            'changed clearance must precede another judgment',
          );
        } finally {
          clearRefMap();
        }
      });
    }
  }
}
