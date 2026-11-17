// A list's ground is free of plain layers (empty full-band views outside the list holding nothing but
// such views) only when a named element inside the list is natively hittable. These rows pin the pure
// part on the real reads of the unnamed-cards list: which views are plain, and the band without them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  containerBand,
  foreignOnBand,
  groundWitnesses,
  plainLayersOn,
  probeIdentifiable,
} from '../../../dist/qa/resolve.js';
import { elementFrame, join } from '../../../dist/qa/screen.js';
import type { Element, NativeNode, Screen } from '../../../dist/qa/screen.js';
import { addNode, CARDS, unnamedCards } from './free-ground-reads.ts';
import type { JoinArgs, UnnamedCardsRead } from './free-ground-reads.ts';

type Rect = NonNullable<NativeNode['rect']>;
const NINE = ['@e11', '@e22', '@e45', '@e46', '@e47', '@e48', '@e49', '@e51', '@e52'];
const CLIP: Rect = { x: 0, y: 224.66666412353516, width: 402, height: 649.3333333333333 };

const listOf = (screen: Screen, read: UnnamedCardsRead) =>
  screen.elements.find((e) => e.ref === `@e${CARDS[read].list}`)!;
const refs = (elements: Element[]) => elements.map((e) => e.ref).sort();

test('G1: the real presence read: the nine empty full-screen views are plain, and without them the band is free', () => {
  const screen = unnamedCards('presence');
  const list = listOf(screen, 'presence');
  assert.deepEqual(elementFrame(list), CLIP);
  // Release 2.2.1: both rules find no free ground.
  assert.equal(foreignOnBand(list, CLIP, screen), true);
  assert.deepEqual(containerBand(list, screen), {
    status: 'overlay-cut',
    band: { ...CLIP, height: 0 },
  });
  const plain = plainLayersOn(list, CLIP, screen);
  assert.deepEqual(refs(plain), [...NINE].sort());
  const leaveOut = new Set(plain);
  assert.deepEqual(containerBand(list, screen, undefined, false, leaveOut), {
    status: 'clear',
    band: CLIP,
  });
  assert.equal(foreignOnBand(list, CLIP, screen, leaveOut), false);
  // Absent a leave-out set, each rule answers as today.
  assert.equal(foreignOnBand(list, CLIP, screen), true);
  assert.equal(containerBand(list, screen).band?.height, 0);
});

test('G2: the real ordinary read: app-root alone is plain', () => {
  const screen = unnamedCards('ordinary');
  const list = listOf(screen, 'ordinary');
  assert.equal(foreignOnBand(list, CLIP, screen), true);
  const plain = plainLayersOn(list, CLIP, screen);
  assert.deepEqual(refs(plain), ['@e3']);
  assert.equal(plain[0].testID, 'app-root');
  assert.equal(foreignOnBand(list, CLIP, screen, new Set(plain)), false);
});

// A full-screen wrapper beside the nine views, appended last in the window, holding one child whose frame
// lies outside the band (above the list).
const WRAPPER: Rect = { x: 0, y: 0, width: 402, height: 874 };
const ABOVE_BAND: Rect = { x: 14, y: 120, width: 374, height: 44 };
function wrapped(child: 'Button' | 'Other'): { screen: Screen; wrapper: Element; child: Element } {
  let wrapperIndex = 0;
  let childIndex = 0;
  const screen = unnamedCards('presence', (a: JoinArgs) => {
    wrapperIndex = addNode(1, { type: 'Other', rect: WRAPPER })(a);
    childIndex = addNode(wrapperIndex, {
      type: child,
      rect: ABOVE_BAND,
      ...(child === 'Button' ? { label: 'Add' } : {}),
    })(a);
  });
  const at = (index: number) => screen.elements.find((e) => e.ref === `@e${index}`)!;
  return { screen, wrapper: at(wrapperIndex), child: at(childIndex) };
}

test('G7b: a full-screen wrapper holding a button outside the band is solid', () => {
  const { screen, wrapper, child } = wrapped('Button');
  const list = listOf(screen, 'presence');
  assert.equal(elementFrame(child)!.y + elementFrame(child)!.height < CLIP.y, true);
  const plain = plainLayersOn(list, CLIP, screen);
  assert.ok(!plain.includes(wrapper), 'the wrapper is not plain');
  assert.ok(!plain.includes(child));
  assert.deepEqual(refs(plain), [...NINE].sort());
  // With only the plain layers left out, the wrapper still lies on the band.
  assert.equal(foreignOnBand(list, CLIP, screen, new Set(plain)), true);
});

test('G7c: a full-screen wrapper holding an empty view outside the band is solid', () => {
  const { screen, wrapper, child } = wrapped('Other');
  const list = listOf(screen, 'presence');
  const plain = plainLayersOn(list, CLIP, screen);
  assert.ok(!plain.includes(wrapper), 'every view under a plain layer must contain the band');
  assert.ok(!plain.includes(child));
  assert.deepEqual(refs(plain), [...NINE].sort());
  assert.equal(foreignOnBand(list, CLIP, screen, new Set(plain)), true);
});

// A node named by its parent's ref; join() links parents by array position.
type Spec = Omit<NativeNode, 'index' | 'parentIndex'> & { parent?: string };
const LIST: Rect = { x: 0, y: 100, width: 402, height: 600 };
const BAND: Rect = { x: 0, y: 100, width: 402, height: 400 };
const row = (ref: string, y: number, extra: Partial<Spec> = {}): Spec => ({
  ref,
  parent: '@list',
  type: 'Button',
  identifier: ref.slice(1),
  hittable: true,
  rect: { x: 20, y, width: 360, height: 48 },
  ...extra,
});
function listScreen(rows: Spec[]): Screen {
  const specs: Spec[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@win',
      parent: '@app',
      type: 'Window',
      hittable: true,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    { ref: '@list', parent: '@win', type: 'ScrollView', hittable: true, rect: LIST },
    ...rows,
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
const at = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref)!;
const witnessesOf = (screen: Screen, target?: string) =>
  refs(groundWitnesses(at(screen, '@list'), BAND, screen, target ? at(screen, target) : undefined));

test('G6: a named row wholly inside the band is a witness', () => {
  assert.deepEqual(witnessesOf(listScreen([row('@w', 300)])), ['@w']);
});

test('G6: what may never be a witness', () => {
  const cases: [string, Spec[], string?][] = [
    [
      'a row of a scroll view nested in the list',
      [
        {
          ref: '@inner',
          parent: '@list',
          type: 'ScrollView',
          hittable: true,
          rect: { x: 0, y: 200, width: 402, height: 200 },
        },
        row('@w', 250, { parent: '@inner' }),
      ],
    ],
    ['an element outside the list', [row('@w', 300, { parent: '@win' })]],
    ['the target', [row('@w', 300)], '@w'],
    [
      "the target's ancestor",
      [row('@w', 300, { type: 'Cell' }), row('@t', 300, { parent: '@w' })],
      '@t',
    ],
    ["the target's descendant", [row('@t', 300), row('@w', 300, { parent: '@t' })], '@t'],
    ["an element crossing the band's edge", [row('@w', 480)]],
    [
      'one of two elements with the same label and kind',
      [
        row('@w', 300, { identifier: undefined, label: 'Plan' }),
        row('@v', 400, { identifier: undefined, label: 'Plan' }),
      ],
    ],
    ['an element of kind other', [row('@w', 300, { type: 'Other' })]],
  ];
  for (const [name, rows, target] of cases) {
    const screen = listScreen(rows);
    assert.deepEqual(
      witnessesOf(screen, target).filter((ref) => ref === '@w'),
      [],
      name,
    );
  }
  const off = listScreen([row('@w', 300)]);
  at(off, '@w').offscreen = true;
  assert.deepEqual(witnessesOf(off), [], 'an element off screen');
  // An element known only to React has no native node for the runner to find.
  const screen = listScreen([row('@w', 300)]);
  const reactOnly = { ...at(screen, '@w'), ref: 'react:w' };
  screen.elements.push(reactOnly);
  assert.ok(!groundWitnesses(at(screen, '@list'), BAND, screen).includes(reactOnly), 'React only');
});

test("G6: the real ordinary read's scroll bars, of kind other, are no witness", () => {
  const screen = unnamedCards('ordinary');
  const list = listOf(screen, 'ordinary');
  const bars = screen.elements.filter((e) => e.label?.includes('scroll bar'));
  assert.equal(bars.length, 2);
  assert.ok(bars.every((bar) => bar.kind === 'other' && probeIdentifiable(bar, screen)));
  assert.deepEqual(groundWitnesses(list, CLIP, screen), []);
});
