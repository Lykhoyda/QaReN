import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reactHitTest, touchReaches } from '../../../dist/qa/react-hit-test.js';
import { validateReactHostEvidence } from '../../../dist/qa/screen.js';

type Rect = { x: number; y: number; width: number; height: number };
type Host = {
  parent: number | null;
  rect?: Rect;
  order?: number;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  zIndex?: number;
  hidden?: true;
};

const full = { x: 0, y: 0, width: 100, height: 100 };
const button = { x: 10, y: 10, width: 80, height: 20 };

// Host indices are the capture's breadth-first order; `order` is the fiber (paint) order among siblings.
function evidence(hosts: Host[]) {
  const value = validateReactHostEvidence({
    complete: true,
    hosts: hosts.map((h) => ({
      role: null,
      roleSource: 'none',
      capabilities: {},
      ...(h.order === undefined ? {} : { order: h.order }),
      ...(h.pointerEvents ? { pointerEvents: h.pointerEvents } : {}),
      ...(h.zIndex === undefined ? {} : { zIndex: h.zIndex }),
      ...(h.hidden ? { hidden: true } : {}),
    })),
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: hosts.map((h, hostIndex) => ({
        hostIndex,
        parentHostIndex: h.parent,
        rootIndex: 0,
        hostType: 'RCTView',
        ...(h.rect ? { rect: h.rect } : {}),
        text: { kind: 'none' },
      })),
    },
  });
  assert.ok(value);
  return value;
}

function reaches(hosts: Host[], target: number, x = 50, y = 20) {
  const e = evidence(hosts);
  const hit = reactHitTest(e, (rect) => rect)(x, y);
  return { hit, reaches: touchReaches(e, target, hit) };
}

test('a shallower overlay drawn after a composed button covers it, whatever the breadth-first index says', () => {
  // <Root><ComposedButton/> (host 2, two composites deep) <View absoluteFill/> (host 1)</Root>
  const result = reaches(
    [
      { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
      { parent: 0, rect: full, order: 1 },
      { parent: 0, rect: button, order: 0 },
    ],
    2,
  );
  assert.deepEqual(result, { hit: 1, reaches: false });
});

test('the reverse shape: a composed overlay drawn before a shallower button leaves the touch on the button', () => {
  const result = reaches(
    [
      { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
      { parent: 0, rect: button, order: 1 },
      { parent: 0, rect: full, order: 0 },
    ],
    1,
  );
  assert.deepEqual(result, { hit: 1, reaches: true });
});

test('a missing or repeated sibling order leaves the hit unresolved, which never reaches the target', () => {
  for (const orders of [
    [undefined, 0],
    [0, 0],
  ]) {
    const result = reaches(
      [
        { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
        { parent: 0, rect: button, order: orders[0] },
        { parent: 0, rect: { x: 0, y: 60, width: 100, height: 40 }, order: orders[1] },
      ],
      1,
    );
    assert.deepEqual(result, { hit: 'unresolved', reaches: false }, JSON.stringify(orders));
  }
});

test('an order-unknown sibling that cannot take the touch does not block the hit', () => {
  // A row elsewhere whose style could not be read: it is nowhere near the point.
  const result = reaches(
    [
      { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
      { parent: 0, rect: button, order: 0 },
      { parent: 0, rect: { x: 0, y: 60, width: 100, height: 40 }, order: undefined },
      { parent: 2, rect: { x: 0, y: 70, width: 100, height: 10 }, order: 0 },
    ],
    1,
  );
  assert.deepEqual(result, { hit: 1, reaches: true });
});

test('an order-unknown sibling whose subtree holds a frame over the point leaves the hit unresolved', () => {
  for (const [rect, child] of [
    [full, undefined],
    [{ x: 0, y: 60, width: 100, height: 40 }, full],
  ] as const) {
    const result = reaches(
      [
        { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
        { parent: 0, rect: button, order: 0 },
        { parent: 0, rect, order: undefined },
        ...(child ? [{ parent: 2, rect: child, order: 0 } as Host] : []),
      ],
      1,
    );
    assert.deepEqual(
      result,
      { hit: 'unresolved', reaches: false },
      JSON.stringify({ rect, child }),
    );
  }
});

test('zIndex outranks fiber order among siblings; equal zIndex keeps fiber order', () => {
  const hosts = (zIndex: number): Host[] => [
    { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
    { parent: 0, rect: button, order: 0, zIndex },
    { parent: 0, rect: full, order: 1, zIndex: 1 },
  ];
  assert.deepEqual(reaches(hosts(2), 1), { hit: 1, reaches: true });
  assert.deepEqual(reaches(hosts(1), 1), { hit: 2, reaches: false });
});

test('pointerEvents none and box-none let the touch through; box-only and auto take it', () => {
  const over = (pointerEvents: Host['pointerEvents'], child = false): Host[] => [
    { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
    { parent: 0, rect: button, order: 0 },
    { parent: 0, rect: full, order: 1, pointerEvents },
    ...(child ? [{ parent: 2, rect: full, order: 0 } as Host] : []),
  ];
  assert.equal(reaches(over('none', true), 1).reaches, true);
  assert.equal(reaches(over('box-none'), 1).reaches, true);
  assert.deepEqual(reaches(over('box-none', true), 1), { hit: 3, reaches: false });
  assert.deepEqual(reaches(over('box-only', true), 1), { hit: 2, reaches: false });
  assert.deepEqual(reaches(over('auto'), 1), { hit: 2, reaches: false });
  assert.deepEqual(reaches(over(undefined), 1), { hit: 2, reaches: false });
});

test('an accessibility-hidden overlay is pruned with its subtree', () => {
  const result = reaches(
    [
      { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
      { parent: 0, rect: button, order: 0 },
      { parent: 0, rect: full, order: 1, hidden: true },
      { parent: 2, rect: full, order: 0, hidden: true },
    ],
    1,
  );
  assert.deepEqual(result, { hit: 1, reaches: true });
});

test("the target's own lineage reaches it; a sibling, nothing or a second root does not", () => {
  const tree: Host[] = [
    { parent: null, rect: full, order: 0 },
    { parent: 0, rect: button, order: 0 },
    { parent: 1, rect: { x: 20, y: 12, width: 20, height: 10 }, order: 0 },
  ];
  assert.deepEqual(reaches(tree, 1, 25, 15), { hit: 2, reaches: true }, 'a descendant');
  assert.deepEqual(reaches(tree, 1, 80, 15), { hit: 1, reaches: true }, 'the target');
  assert.deepEqual(reaches(tree, 2, 80, 15), { hit: 1, reaches: true }, 'an ancestor');
  assert.deepEqual(reaches(tree, 1, 50, 60), { hit: 0, reaches: true }, 'the root ancestor');
  const untouchable: Host[] = [{ ...tree[0], pointerEvents: 'box-none' }, tree[1]];
  assert.deepEqual(reaches(untouchable, 1, 50, 60), { hit: 'none', reaches: false });
  const twoRoots: Host[] = [...tree, { parent: null, rect: full, order: 1 }];
  assert.deepEqual(reaches(twoRoots, 1), { hit: 'unresolved', reaches: false });
});

test('frames are compared in native pixels through the given transform', () => {
  const e = evidence([
    { parent: null, rect: full, order: 0, pointerEvents: 'box-none' },
    { parent: 0, rect: button, order: 0 },
  ]);
  const hit = reactHitTest(e, (r) => ({
    x: r.x * 2,
    y: r.y * 2 + 100,
    width: r.width * 2,
    height: r.height * 2,
  }));
  assert.equal(hit(100, 140), 1);
  assert.equal(hit(100, 40), 'none');
});
