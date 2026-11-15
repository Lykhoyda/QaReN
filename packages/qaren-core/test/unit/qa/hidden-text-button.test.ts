import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenTextButton } from '../../../dist/qa/hidden-text.js';
import {
  associatedHostOf,
  join,
  type NativeNode,
  type ReactHostObservation,
  type Screen,
} from '../../../dist/qa/screen.js';
import type { Target } from '../../../dist/qa/plan.js';
import { hiddenCard } from './ios-hidden-card-captures.ts';

const quoted = (text: string): Target => ({ quoted: text, phrase: text });

test('B1: device P5 presence read ties the hidden texts to the native button qa-hidden-card-b', () => {
  const read = hiddenCard('p5-obs22-presence');
  const native = read.elements.filter(
    (e) => e.testID === 'qa-hidden-card-b' && !e.ref.startsWith('react:'),
  );
  assert.equal(native.length, 1);
  assert.equal(associatedHostOf(native[0]), 31);
  assert.equal(hiddenTextButton(quoted('Bravo plan'), read), native[0]);
  assert.equal(hiddenTextButton(quoted('qa-hidden-card-b-title'), read), native[0]);
  // Alpha's button has no test id; Charlie's has a label and no test id.
  assert.equal(hiddenTextButton(quoted('Alpha plan'), read), undefined);
  assert.equal(hiddenTextButton(quoted('36 EUR'), read), undefined);
});

test('B1: device P1 ordinary read proves no button', () => {
  assert.equal(hiddenTextButton(quoted('Bravo plan'), hiddenCard('p1-obs21-ordinary')), undefined);
});

type Rect = { x: number; y: number; width: number; height: number };
type Row = [Partial<ReactHostObservation>, number | null, string, Rect | undefined, string?];

const plain = { role: null, roleSource: 'none' as const, capabilities: {} };
const pressable = (testID?: string) => ({
  ...(testID ? { testID } : {}),
  role: 'button',
  roleSource: 'accessibilityRole' as const,
  capabilities: { press: true as const },
});
const CARD: Rect = { x: 14, y: 262, width: 374, height: 90 };
const TITLE: Rect = { x: 28, y: 286, width: 346, height: 21 };

// A card Pressable with testID "card" whose children are hidden, joined as a presence read.
function card(
  options: {
    origin?: number;
    rows?: (rows: Row[]) => Row[];
    nativeIdentifier?: string;
    nativeType?: string;
  } = {},
): Screen {
  const ox = options.origin ?? 0;
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 402 + ox, height: 874 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: ox, y: 0, width: 402, height: 874 },
    },
    {
      ref: '@card',
      type: options.nativeType ?? 'Button',
      parentIndex: 1,
      identifier: options.nativeIdentifier ?? 'card',
      hittable: true,
      rect: { ...CARD, x: CARD.x + ox },
    },
  ];
  const base: Row[] = [
    [plain, null, 'RCTRootView', { x: 0, y: 0, width: 402, height: 874 }],
    [pressable('card'), 0, 'RCTView', CARD],
    [{ ...plain, hidden: true }, 1, 'RCTView', { x: 28, y: 286, width: 346, height: 42 }],
    [{ ...plain, hidden: true }, 2, 'RCTText', TITLE, 'Plan'],
  ];
  const rows = options.rows ? options.rows(base) : base;
  return join(
    nodes,
    [{ testID: options.nativeIdentifier ?? 'card', role: 'button' }],
    'app',
    { native: 'complete', react: 'complete' },
    {
      complete: true,
      hosts: rows.map(([host]) => ({ ...plain, ...host })),
      typography: {
        version: 1,
        complete: true,
        durationMs: 1,
        coordinateSpace: 'window-points',
        nodes: rows.map(([, parentHostIndex, hostType, rect, text], hostIndex) => ({
          hostIndex,
          parentHostIndex,
          rootIndex: 0,
          hostType,
          ...(rect ? { rect } : {}),
          accessibility: { accessible: 'true', authoredLabel: 'absent' },
          text: text
            ? {
                kind: 'block',
                content: text,
                runs: [{ start: 0, end: text.length, fontSize: 17 }],
                scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
              }
            : { kind: 'none' },
        })),
      },
    },
    {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    },
    'complete',
  );
}

const native = (screen: Screen) => screen.elements.find((e) => e.ref === '@card')!;

test('B2: the hand-built card proves its button', () => {
  const screen = card();
  assert.equal(associatedHostOf(native(screen)), 1);
  assert.equal(hiddenTextButton(quoted('Plan'), screen), native(screen));
});

test('B2: each missing proof gives nothing', () => {
  const cases: Array<[string, Screen]> = [
    [
      'two candidates',
      card({ rows: (r) => [...r, [{ ...plain, hidden: true }, 2, 'RCTText', TITLE, 'Plan']] }),
    ],
    [
      "the button's test id on a second, hidden host",
      card({
        rows: (r) => [...r, [{ ...plain, hidden: true, testID: 'card' }, 0, 'RCTView', CARD]],
      }),
    ],
    [
      'the associated host is a composite wrapper, not the pressable',
      card({
        nativeIdentifier: 'card-wrapper',
        rows: ([root, , wrapper, text]) => [
          root,
          [{ ...plain, testID: 'card-wrapper' }, 0, 'RCTView', CARD],
          [pressable('card'), 1, 'RCTView', CARD],
          [wrapper[0], 2, wrapper[2], wrapper[3]],
          [text[0], 3, text[2], text[3], text[4]],
        ],
      }),
    ],
    ['no element associated with the button host', card({ nativeIdentifier: 'other' })],
    ['not a button', card({ nativeType: 'Other' })],
    [
      'the text outside the button',
      card({
        rows: (r) => [...r.slice(0, 3), [r[3][0], 2, 'RCTText', { ...TITLE, y: 400 }, 'Plan']],
      }),
    ],
    [
      'the text rect missing',
      card({ rows: (r) => [...r.slice(0, 3), [r[3][0], 2, 'RCTText', undefined, 'Plan']] }),
    ],
    [
      'the button rect missing',
      card({ rows: (r) => [r[0], [r[1][0], 0, 'RCTView', undefined], r[2], r[3]] }),
    ],
  ];
  for (const [name, screen] of cases)
    assert.equal(hiddenTextButton(quoted('Plan'), screen), undefined, name);
  for (const [name, change] of [
    [
      'disabled',
      (e: Screen['elements'][number]) => ({ semantic: { ...e.semantic!, disabled: true } }),
    ],
    ['not hittable', () => ({ hittable: false })],
    ['off screen', () => ({ offscreen: true })],
  ] as const) {
    const screen = card();
    Object.assign(native(screen), change(native(screen)));
    assert.equal(hiddenTextButton(quoted('Plan'), screen), undefined, name);
  }
});

test('B2: React rects are compared in their own space, never against the native frame', () => {
  // The window starts at x 30, so the native frame is x 44..418 and React's button is x 14..388.
  const inside = card({ origin: 30 });
  assert.equal(hiddenTextButton(quoted('Plan'), inside), native(inside));
  const outside = card({
    origin: 30,
    rows: (r) => [
      ...r.slice(0, 3),
      [r[3][0], 2, 'RCTText', { x: 390, y: 286, width: 20, height: 21 }, 'Plan'],
    ],
  });
  assert.equal(hiddenTextButton(quoted('Plan'), outside), undefined);
});
