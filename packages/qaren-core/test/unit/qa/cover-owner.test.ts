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

// The header-inset sticky case: a row in its scroll list, then a box-none layout holding the sticky
// cover, then the pointer-transparent full-screen and inset views drawn last.
const sticky = (cover: PointerEvents = 'auto'): View[] => [
  { id: '', type: 'ScrollView', rect: { x: 0, y: 206, width: 402, height: 668 } },
  { id: 'qa-hi-row-1', type: 'Button', rect: ROW, parent: 0, label: 'Row 1' },
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
    parent: 2,
    pointerEvents: cover,
    label: 'Cover control',
  },
  { id: 'qa-hi-later-full-1', type: 'Other', rect: FULL, pointerEvents: 'none' },
  { id: 'qa-hi-later-inset', type: 'Other', rect: INSET, pointerEvents: 'none' },
];

async function capture(
  views: View[],
  // presence: false is an ordinary capture, which carries no native presence and no React typography.
  options: { hosts?: boolean; order?: boolean; presence?: boolean; secondRoot?: boolean } = {},
): Promise<Screen> {
  const {
    hosts = true,
    order = true,
    presence: platformPresence = true,
    secondRoot = false,
  } = options;
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
  // Native nodes follow the React nesting, in capture order.
  views.forEach((view, i) => {
    const parentIndex = view.parent === undefined ? 1 : view.parent + 2;
    nodes.push({
      ref: `@e${i + 2}`,
      index: i + 2,
      depth: (nodes[parentIndex].depth as number) + 1,
      parentIndex,
      type: view.type,
      identifier: view.id,
      ...(view.label ? { label: view.label } : {}),
      enabled: true,
      hittable: true,
      rect: view.rect,
      presence: presence(i + 2),
    });
  });
  if (!platformPresence) for (const node of nodes) delete node.presence;
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
  // A second React root (an overlay surface, say) has no paint order against the screen's.
  if (secondRoot) {
    evidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    evidence.typography!.nodes.push({
      hostIndex: evidence.hosts.length - 1,
      parentHostIndex: null,
      rootIndex: 1,
      hostType: 'RCTView',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      text: { kind: 'none' },
    });
  }
  if (!platformPresence) delete evidence.typography;
  return captureScreen({
    appId: 'com.test',
    native: async () => (platformPresence ? base : { ...base, presenceCapture: undefined }),
    react: async () => ({
      interactive: [],
      ...(hosts ? { hostEvidence: evidence } : {}),
      verdict: { state: 'ok', path: 'interactive', complete: hosts },
    }),
  });
}

const row = (screen: Screen) => screen.elements.find((e) => e.testID === 'qa-hi-row-1')!;
// Who takes a touch at row 1's centre (201, 283): a testID, 'none' or the evidence gap.
const touched = (screen: Screen) => {
  const hit = touchOwnerAt(screen, 201, 283);
  return typeof hit === 'object' ? hit.testID : hit;
};

test('the sticky cover is named, not the pointer-transparent inset view drawn after it', async () => {
  const screen = await capture(sticky());
  const cover = coverOwner(row(screen), screen);
  assert.equal('owner' in cover && cover.owner.testID, 'qa-hi-cover', JSON.stringify(cover));
});

test('a pointer-transparent cover is no cover: the touch reaches the row', async () => {
  const screen = await capture(sticky('none'));
  // The hit test ran and gave the row its own touch, so nothing covers it.
  assert.equal(touched(screen), 'qa-hi-row-1');
  assert.deepEqual(coverOwner(row(screen), screen), { gap: 'reaches-target' });
});

test('without proof of who takes the touch, nothing is named and the gap says why', async () => {
  for (const [options, expected] of [
    [{ presence: false }, 'no-native-presence'],
    [{ hosts: false }, 'react-evidence-incomplete'],
    [{ order: false }, 'unordered-siblings'],
    [{ secondRoot: true }, 'separate-roots'],
  ] as const) {
    const screen = await capture(sticky(), options);
    assert.equal(touched(screen), expected, JSON.stringify(options));
    assert.deepEqual(coverOwner(row(screen), screen), { gap: expected }, JSON.stringify(options));
  }
});

// Device C1: a quoted tap takes an ordinary capture, which cannot associate React hosts with native
// nodes, so the refusal names no cover and says which evidence was missing.
test('a quoted tap on an ordinary capture names no cover and records the missing evidence', async () => {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('exact targets are model-free')),
  );
  w.deps.platform = 'ios';
  const modes: boolean[] = [];
  w.deps.captureScreen = async (options) => {
    modes.push(options?.platformPresence === true);
    const screen = await capture(sticky(), { presence: options?.platformPresence === true });
    screen.nativeGeneration = 7;
    return screen;
  };
  const diagnostics: Record<string, unknown>[] = [];
  w.deps.diagnostic = (event) => diagnostics.push(event as unknown as Record<string, unknown>);
  w.deps.hitProbe = async () => 'not-hittable';
  w.deps.press = async () => ({
    ok: false,
    proven: false,
    mutation: 'none',
    error: 'LIVE_HIT_UNPROVEN: LIVE_HIT_UNPROVEN: not-hittable; no tap was performed.',
  });
  const result = await runPlan(parsePlan('1. Tap "qa-hi-row-1"').blocks!, w.deps);
  const row = ('steps' in result ? result.steps : []).filter((r) => r.line === 1).at(-1);
  assert.ok(modes.length && !modes.includes(true), 'every capture of a quoted tap is ordinary');
  assert.equal(row?.outcome, 'fail', JSON.stringify(row));
  assert.equal(row?.coveredBy, undefined, JSON.stringify(row));
  assert.match(String(row?.reason), /no cover named \(no-native-presence\)/);
  assert.doesNotMatch(String(row?.reason), /covered by \w+ at/);
  const covered = diagnostics.filter((event) => event.code === 'CENTRE_COVERED');
  assert.deepEqual(
    covered.map((event) => (event.clearanceDiagnostic as { coverGap?: unknown }).coverGap),
    covered.map(() => 'no-native-presence'),
  );
  assert.ok(covered.length, JSON.stringify(diagnostics.map((event) => event.code)));
});

test('a hit on a host with no native node of its own names nothing', async () => {
  // The cover's own testID is gone, so its host cannot be tied to a native node.
  const views = sticky().map((view) => (view.id === 'qa-hi-cover' ? { ...view, id: '' } : view));
  const screen = await capture(views);
  assert.equal(touched(screen), 'unassociated-host');
  assert.deepEqual(coverOwner(row(screen), screen), { gap: 'unassociated-host' });
});

test('scroll clipping withholds a named owner outside every viewport edge', async () => {
  const viewport = { x: 100, y: 200, width: 200, height: 500 };
  for (const [x, y] of [
    [201, 100],
    [201, 700],
    [99, 300],
    [300, 300],
  ]) {
    const frame = { x: x - 10, y: y - 10, width: 20, height: 20 };
    const screen = await capture([
      { id: 'target', type: 'Button', rect: frame },
      { id: '', type: 'ScrollView', rect: viewport },
      { id: 'clipped-row', type: 'Button', rect: frame, parent: 1 },
    ]);
    assert.equal(touchOwnerAt(screen, x, y), 'clipped', `${x},${y}`);
    assert.deepEqual(coverOwner(screen.elements.find((e) => e.testID === 'target')!, screen), {
      gap: 'clipped',
    });
  }
});

test('partially clipped owners use the touch point within all nested viewports', async () => {
  const screen = await capture([
    { id: '', type: 'ScrollView', rect: { x: 100, y: 200, width: 200, height: 500 } },
    { id: '', type: 'ScrollView', rect: { x: 50, y: 250, width: 200, height: 500 }, parent: 0 },
    {
      id: 'partial-row',
      type: 'Button',
      rect: { x: 50, y: 200, width: 250, height: 550 },
      parent: 1,
    },
  ]);
  for (const [x, y] of [
    [99, 300],
    [250, 300],
    [150, 249],
    [150, 700],
  ])
    assert.equal(touchOwnerAt(screen, x, y), 'clipped', `${x},${y}`);
  for (const [x, y] of [
    [100, 250],
    [249, 699],
  ]) {
    const owner = touchOwnerAt(screen, x, y);
    assert.equal(typeof owner === 'object' ? owner.testID : owner, 'partial-row', `${x},${y}`);
  }
});
