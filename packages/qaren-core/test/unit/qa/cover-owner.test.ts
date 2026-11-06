// Device QA C1: the cover a refusal names is the view React Native's own hit test gives the touch to,
// never a pointer-transparent view the inferred band cutter happens to pick.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { coverOwner } from '../../../dist/qa/resolve.js';
import { touchOwnerAt } from '../../../dist/qa/screen.js';
import type { ReactHostEvidence, Screen } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = { x: number; y: number; width: number; height: number };
type PointerEvents = 'auto' | 'none' | 'box-none' | 'box-only';
interface View {
  id: string;
  type: string;
  rect: Rect;
  // Index of the parent React view; absent is the screen root.
  parent?: number;
  pointerEvents?: PointerEvents;
  label?: string;
}

const ROW: Rect = { x: 21, y: 255, width: 360, height: 56 };
const COVER: Rect = { x: 0, y: 110, width: 402, height: 201 };
const INSET: Rect = { x: 0, y: 116, width: 402, height: 758 };
const FULL: Rect = { x: 0, y: 0, width: 402, height: 874 };

// The header-inset sticky case: rows, then a box-none layout holding the sticky cover, then the
// pointer-transparent full-screen and inset views drawn last.
const sticky = (cover: PointerEvents = 'auto'): View[] => [
  { id: 'qa-hi-row-1', type: 'Button', rect: ROW, label: 'Row 1' },
  {
    id: 'qa-hi-layout',
    type: 'Other',
    rect: { x: 0, y: 110, width: 402, height: 764 },
    pointerEvents: 'box-none',
  },
  {
    id: 'qa-hi-cover',
    type: 'Button',
    rect: COVER,
    parent: 1,
    pointerEvents: cover,
    label: 'Cover control',
  },
  { id: 'qa-hi-later-full-1', type: 'Other', rect: FULL, pointerEvents: 'none' },
  { id: 'qa-hi-later-inset', type: 'Other', rect: INSET, pointerEvents: 'none' },
];

async function capture(
  views: View[],
  options: { hosts?: boolean; order?: boolean } = {},
): Promise<Screen> {
  const { hosts = true, order = true } = options;
  const base = nativeCapture();
  const presence = (index: number) => ({ ...base.nodes[1].presence, nodeIndex: index });
  const nodes: Record<string, unknown>[] = [
    { ...base.nodes[0], rect: FULL },
    {
      ref: '@e1',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      enabled: true,
      hittable: true,
      rect: FULL,
      presence: presence(1),
    },
  ];
  // Native accessibility lists every view flat under the window, in capture order.
  views.forEach((view, i) =>
    nodes.push({
      ref: `@e${i + 2}`,
      index: i + 2,
      depth: 2,
      parentIndex: 1,
      type: view.type,
      identifier: view.id,
      ...(view.label ? { label: view.label } : {}),
      enabled: true,
      hittable: true,
      rect: view.rect,
      presence: presence(i + 2),
    }),
  );
  base.nodes = nodes as typeof base.nodes;
  base.snapshotVerdict.nodeCount = nodes.length;
  // Host 0 is the screen root; view i is host i + 1, ranked among its siblings in fiber order.
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [{ role: null, roleSource: 'none', capabilities: {} }],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [
        {
          hostIndex: 0,
          parentHostIndex: null,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: FULL,
          text: { kind: 'none' },
        },
      ],
    },
  };
  const siblings = new Map<number, number>();
  views.forEach((view, i) => {
    const parent = view.parent === undefined ? 0 : view.parent + 1;
    const rank = siblings.get(parent) ?? 0;
    siblings.set(parent, rank + 1);
    evidence.hosts.push({
      testID: view.id,
      role: null,
      roleSource: 'none',
      capabilities: view.type === 'Button' ? { press: true } : {},
      ...(view.pointerEvents ? { pointerEvents: view.pointerEvents } : {}),
      ...(order ? { order: rank } : {}),
    });
    evidence.typography!.nodes.push({
      hostIndex: i + 1,
      parentHostIndex: parent,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: view.rect,
      text: { kind: 'none' },
    });
  });
  return captureScreen({
    appId: 'com.test',
    native: async () => base,
    react: async () => ({
      interactive: [],
      ...(hosts ? { hostEvidence: evidence } : {}),
      verdict: { state: 'ok', path: 'interactive', complete: hosts },
    }),
  });
}

const row = (screen: Screen) => screen.elements.find((e) => e.testID === 'qa-hi-row-1')!;
// Who takes a touch at row 1's centre (201, 283): a testID, 'none', 'unresolved' or no evidence.
const touched = (screen: Screen) => {
  const hit = touchOwnerAt(screen, 201, 283);
  return typeof hit === 'object' ? hit.testID : hit;
};

test('the sticky cover is named, not the pointer-transparent inset view drawn after it', async () => {
  const screen = await capture(sticky());
  assert.equal(coverOwner(row(screen), screen)?.testID, 'qa-hi-cover');
});

test('a pointer-transparent cover is no cover: the touch reaches the row', async () => {
  const screen = await capture(sticky('none'));
  // The hit test ran and gave the row its own touch, so nothing covers it.
  assert.equal(touched(screen), 'qa-hi-row-1');
  assert.equal(coverOwner(row(screen), screen), undefined);
});

test('without proof of who takes the touch, nothing is named', async () => {
  for (const [options, expected] of [
    [{ hosts: false }, undefined],
    [{ order: false }, 'unresolved'],
  ] as const) {
    const screen = await capture(sticky(), options);
    assert.equal(touched(screen), expected, JSON.stringify(options));
    assert.equal(coverOwner(row(screen), screen), undefined, JSON.stringify(options));
  }
});

test('the walked tap records the sticky cover on its row and never names the inset view', async () => {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('exact targets are model-free')),
  );
  w.deps.platform = 'ios';
  w.deps.captureScreen = async () => {
    const screen = await capture(sticky());
    screen.nativeGeneration = 7;
    return screen;
  };
  w.deps.hitProbe = async () => 'not-hittable';
  w.deps.press = async () => ({
    ok: false,
    proven: false,
    mutation: 'none',
    error: 'LIVE_HIT_UNPROVEN: LIVE_HIT_UNPROVEN: not-hittable; no tap was performed.',
  });
  const result = await runPlan(parsePlan('1. Tap "qa-hi-row-1"').blocks!, w.deps);
  const row = ('steps' in result ? result.steps : []).find((r) => r.line === 1);
  assert.deepEqual(
    row?.coveredBy,
    { ref: '@e4', kind: 'button', frame: COVER },
    JSON.stringify(row),
  );
  assert.deepEqual(w.rows.at(-1)?.coveredBy, row?.coveredBy, 'the streamed row carries it too');
  assert.doesNotMatch(String(row?.reason), /covered by \w+ at 0,116,402,758/);
});

test('a hit on a host with no native node of its own names nothing', async () => {
  // The cover's own testID is gone, so its host cannot be tied to a native node.
  const views = sticky().map((view) => (view.id === 'qa-hi-cover' ? { ...view, id: '' } : view));
  const screen = await capture(views);
  assert.equal(touched(screen), 'unresolved');
  assert.equal(coverOwner(row(screen), screen), undefined);
});
