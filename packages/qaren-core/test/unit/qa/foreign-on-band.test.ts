// AI-474 slice 3, T9: a clearance band is free only when no touchable view outside the target's list
// overlaps it, whatever its list order: in front and behind are not told apart.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as resolve from '../../../dist/qa/resolve.js';
import { containerBand } from '../../../dist/qa/resolve.js';
import { ancestorsOf, join } from '../../../dist/qa/screen.js';
import type { Element, NativeNode, Screen } from '../../../dist/qa/screen.js';

type Rect = NonNullable<NativeNode['rect']>;
type ForeignOnBand = (container: Element, band: Rect, screen: Screen) => boolean;
// Looked up at call time, so a build without the function fails these tests one by one.
const foreignOnBand: ForeignOnBand = (container, band, screen) =>
  (resolve as unknown as { foreignOnBand: ForeignOnBand }).foreignOnBand(container, band, screen);

const FULL: Rect = { x: 0, y: 0, width: 402, height: 874 };
const LIST: Rect = { x: 0, y: 100, width: 402, height: 600 };
const BAND: Rect = { x: 0, y: 100, width: 402, height: 400 };

// A node named by its parent's ref; join() links parents by array position.
type Spec = Omit<NativeNode, 'index' | 'parentIndex'> & { parent?: string };

// Window > root > (list > row), with `before` and `after` nodes listed around the list.
function screenWith(before: Spec[] = [], after: Spec[] = []): Screen {
  const specs: Spec[] = [
    { ref: '@app', type: 'Application', rect: FULL },
    { ref: '@win', parent: '@app', type: 'Window', hittable: true, rect: FULL },
    { ref: '@root', parent: '@win', type: 'Other', hittable: true, rect: FULL },
    ...before,
    { ref: '@list', parent: '@root', type: 'ScrollView', hittable: true, rect: LIST },
    {
      ref: '@row',
      parent: '@list',
      type: 'Button',
      identifier: 'row',
      hittable: true,
      rect: { x: 20, y: 300, width: 360, height: 48 },
    },
    ...after,
  ];
  const position = new Map(specs.map((spec, i) => [spec.ref, i]));
  return join(
    specs.map(({ parent, ...spec }, index) => ({
      ...spec,
      index,
      ...(parent ? { parentIndex: position.get(parent)! } : {}),
    })),
    [],
  );
}

const node = (ref: string, rect: Rect, extra: Partial<Spec> = {}): Spec => ({
  ref,
  parent: '@root',
  type: 'Other',
  hittable: true,
  rect,
  ...extra,
});
const at = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref)!;
const answer = (screen: Screen, band = BAND) => foreignOnBand(at(screen, '@list'), band, screen);

test('T9: a view listed before the list and one listed after it, each overlapping the band, answer yes', () => {
  const over = { x: 0, y: 400, width: 402, height: 200 };
  const before = screenWith([node('@before', over)]);
  assert.ok(ancestorsOf(at(before, '@row')).includes(at(before, '@list')));
  assert.equal(answer(before), true);
  assert.equal(answer(screenWith([], [node('@after', over)])), true);
});

test('T9: a layer the front-overlay band calculation treats as empty still answers yes', () => {
  // A full-screen plain view over the list whose only child lies outside the list's clip.
  const screen = screenWith(
    [],
    [
      node('@layer', FULL, { parent: '@win' }),
      node(
        '@corner',
        { x: 0, y: 800, width: 100, height: 40 },
        { parent: '@layer', type: 'Button' },
      ),
    ],
  );
  assert.ok(ancestorsOf(at(screen, '@corner')).includes(at(screen, '@layer')));
  assert.equal(containerBand(at(screen, '@list'), screen).status, 'clear');
  assert.equal(answer(screen), true);
});

test('T9: the list, a view inside it, and its ancestors answer no', () => {
  const screen = screenWith(
    [],
    [node('@cell', { x: 0, y: 200, width: 402, height: 100 }, { parent: '@list' })],
  );
  assert.equal(answer(screen), false);
});

test('T9: text, a window, an off-screen and an untouchable view answer no', () => {
  const over = { x: 0, y: 150, width: 402, height: 100 };
  const cases: [string, Spec, ((screen: Screen) => void)?][] = [
    ['text', node('@text', over, { type: 'StaticText', label: 'Hello' })],
    ['window', node('@window', FULL, { parent: '@app', type: 'Window' })],
    ['untouchable', node('@flat', over, { hittable: false })],
    ['off-screen', node('@gone', over), (s) => (at(s, '@gone').offscreen = true)],
  ];
  for (const [name, extra, edit] of cases) {
    const screen = screenWith([], [extra]);
    edit?.(screen);
    assert.equal(answer(screen), false, name);
    // The same view, touchable and on screen, would answer yes.
    if (name === 'untouchable' || name === 'off-screen')
      assert.equal(answer(screenWith([], [{ ...extra, hittable: true }])), true, name);
  }
});

test('T9: a touchable view beside the band answers no', () => {
  assert.equal(
    answer(screenWith([], [node('@below', { x: 0, y: 520, width: 402, height: 80 })])),
    false,
  );
  const narrow = { x: 0, y: 100, width: 200, height: 400 };
  const aside = screenWith([], [node('@aside', { x: 250, y: 150, width: 100, height: 80 })]);
  assert.equal(answer(aside, narrow), false);
  assert.equal(answer(aside), true);
});
