import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenTextButton, hiddenTextUnnamedButton } from '../../../dist/qa/hidden-text.js';
import {
  elementFrame,
  join,
  type NativeNode,
  type ReactHostObservation,
  type Screen,
} from '../../../dist/qa/screen.js';
import { parsePlan, type Target } from '../../../dist/qa/plan.js';
import { walkBlock, type WalkerDeps } from '../../../dist/qa/walker.js';
import { hiddenCard } from './ios-hidden-card-captures.ts';

const quoted = (text: string): Target => ({ quoted: text, phrase: text });

test('N1: device reads tie the hidden text to the one unnamed native button by its frame', () => {
  const alpha = hiddenCard('p1-obs22-presence');
  const button = hiddenTextUnnamedButton(quoted('Alpha plan'), alpha);
  assert.equal(button?.ref, '@e25');
  assert.equal(button?.kind, 'button');
  assert.deepEqual(button && elementFrame(button), {
    x: 14,
    y: 161.66666793823242,
    width: 374,
    height: 90,
  });
  // Bravo's button has a test id, so slice 2 owns it; Charlie's has a label.
  assert.equal(hiddenTextUnnamedButton(quoted('Bravo plan'), alpha), undefined);
  assert.equal(hiddenTextUnnamedButton(quoted('36 EUR'), alpha), undefined);
  assert.equal(hiddenTextButton(quoted('Alpha plan'), alpha), undefined);
  const popup = hiddenCard('p9-obs27-presence');
  const echo = hiddenTextUnnamedButton(quoted('Echo plan'), popup);
  assert.equal(echo?.ref, '@e11');
  // Alpha sits behind the popup: its native button is not on this read, so nothing proves it.
  assert.equal(hiddenTextUnnamedButton(quoted('Alpha plan'), popup), undefined);
  assert.deepEqual(echo && elementFrame(echo), {
    x: 14,
    y: 87.66666412353516,
    width: 374,
    height: 90.00000762939453,
  });
});

test('N1: device P1 ordinary read proves no unnamed button', () => {
  assert.equal(
    hiddenTextUnnamedButton(quoted('Alpha plan'), hiddenCard('p1-obs21-ordinary')),
    undefined,
  );
});

type Rect = { x: number; y: number; width: number; height: number };
// The fifth field is a block of text, or `{ inline }`: a span inside the text host it names.
type Row = [
  Partial<ReactHostObservation>,
  number | null,
  string,
  Rect | undefined,
  (string | { inline: number })?,
];
type Presence = { status: 'observed' | 'unknown'; labelSource: 'direct' | 'none' };

const plain = { role: null, roleSource: 'none' as const, capabilities: {} };
const pressable = (testID?: string) => ({
  ...(testID ? { testID } : {}),
  role: 'button',
  roleSource: 'accessibilityRole' as const,
  capabilities: { press: true as const },
});
const CARD: Rect = { x: 14, y: 262, width: 374, height: 90 };
const TITLE: Rect = { x: 28, y: 286, width: 346, height: 21 };

// A card Pressable with neither label nor test id whose children are hidden, joined as a presence read.
function card(
  options: {
    origin?: number;
    rows?: (rows: Row[]) => Row[];
    native?: Partial<NativeNode>;
    // Extra native nodes, each with its presence; a parentIndex of 1 is the card's window.
    extra?: Array<[NativeNode, Presence?]>;
    presence?: Presence;
    authoredLabel?: 'present' | 'absent' | 'unknown';
    // The ordinary read: no React evidence and no presence.
    ordinary?: boolean;
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
      type: 'Button',
      parentIndex: 1,
      hittable: true,
      rect: { ...CARD, x: CARD.x + ox },
      ...options.native,
    },
    ...(options.extra ?? []).map(([node]) => node),
  ];
  const presence: Presence[] = [
    { status: 'observed', labelSource: 'direct' },
    { status: 'observed', labelSource: 'direct' },
    options.presence ?? { status: 'observed', labelSource: 'none' },
    ...(options.extra ?? []).map(
      ([, p]) => p ?? ({ status: 'observed', labelSource: 'none' } as const),
    ),
  ];
  const base: Row[] = [
    [plain, null, 'RCTRootView', { x: 0, y: 0, width: 402, height: 874 }],
    [pressable(), 0, 'RCTView', CARD],
    [{ ...plain, hidden: true }, 1, 'RCTView', { x: 28, y: 286, width: 346, height: 42 }],
    [{ ...plain, hidden: true }, 2, 'RCTText', TITLE, 'Plan'],
  ];
  const rows = options.rows ? options.rows(base) : base;
  if (options.ordinary)
    return join(nodes, [{ role: 'button' }], 'app', { native: 'complete', react: 'complete' });
  return join(
    nodes,
    [{ role: 'button' }],
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
          accessibility: {
            accessible: 'true',
            authoredLabel: hostIndex === 1 ? (options.authoredLabel ?? 'absent') : 'absent',
          },
          text:
            typeof text === 'object'
              ? { kind: 'inline', ownerHostIndex: text.inline }
              : text
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
    { source: 'xcui-live', nodes: presence },
    'complete',
  );
}

const native = (screen: Screen) => screen.elements.find((e) => e.ref === '@card')!;
const twin = (rect: Rect = CARD, extra: Partial<NativeNode> = {}): NativeNode => ({
  ref: '@twin',
  type: 'Button',
  parentIndex: 1,
  hittable: true,
  rect,
  ...extra,
});

test('N2: the hand-built unnamed card proves its button', () => {
  const screen = card();
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), screen), native(screen));
});

test('N2: each missing proof gives nothing', () => {
  const cases: Array<[string, Screen]> = [
    ['two unnamed native buttons with the same frame', card({ extra: [[twin()]] })],
    [
      'a labelled native button at the same frame',
      card({ extra: [[twin(CARD, { label: 'Plan' })]] }),
    ],
    [
      'an identified native button at the same frame',
      card({ extra: [[twin(CARD, { identifier: 'card' })]] }),
    ],
    [
      'a labelled native button at the same frame whose presence is unknown',
      card({
        extra: [[twin(CARD, { label: 'Other' }), { status: 'unknown', labelSource: 'none' }]],
      }),
    ],
    [
      'a native node at the same frame sharing another node’s ref',
      card({ extra: [[twin(CARD, { ref: '@app' })]] }),
    ],
    [
      'two press-capable hosts with the same frame',
      card({ rows: (r) => [...r, [pressable(), 0, 'RCTView', CARD]] }),
    ],
    [
      'a hidden pressable inside the card covering its centre',
      card({
        rows: (r) => [
          ...r,
          [
            { ...pressable(), hidden: true },
            1,
            'RCTView',
            { x: 150, y: 280, width: 100, height: 60 },
          ],
        ],
      }),
    ],
    [
      'a hidden press-capable host with the same frame',
      card({ rows: (r) => [...r, [{ ...pressable(), hidden: true }, 0, 'RCTView', CARD]] }),
    ],
    ['the native node has a label', card({ native: { label: 'Plan' } })],
    ['the native node has an identifier', card({ native: { identifier: 'card' } })],
    ['an incompatible native type', card({ native: { type: 'Image' } })],
    ['a frame off by half a point', card({ native: { rect: { ...CARD, x: CARD.x + 0.5 } } })],
    [
      'the node not observed in the presence read',
      card({ presence: { status: 'unknown', labelSource: 'none' } }),
    ],
    [
      'the text outside the button',
      card({
        rows: (r) => [...r.slice(0, 3), [r[3][0], 2, 'RCTText', { ...TITLE, y: 400 }, 'Plan']],
      }),
    ],
    [
      'two hidden texts carry the words',
      card({ rows: (r) => [...r, [{ ...plain, hidden: true }, 2, 'RCTText', TITLE, 'Plan']] }),
    ],
    [
      'the button host has a test id',
      card({ rows: (r) => [r[0], [pressable('card'), 0, 'RCTView', CARD], r[2], r[3]] }),
    ],
    ['the button host has an authored label', card({ authoredLabel: 'present' })],
    ['whether the button has a label is unknown', card({ authoredLabel: 'unknown' })],
    [
      'another press-capable host that is not hidden has no measured frame',
      card({ rows: (r) => [...r, [pressable(), 0, 'RCTView', undefined]] }),
    ],
    [
      'the same frame in a second window',
      card({
        extra: [
          [
            {
              ref: '@window2',
              type: 'Window',
              parentIndex: 0,
              rect: { x: 0, y: 0, width: 402, height: 874 },
            },
            { status: 'observed', labelSource: 'direct' },
          ],
          [twin(CARD, { parentIndex: 3 })],
        ],
      }),
    ],
  ];
  for (const [name, screen] of cases)
    assert.equal(hiddenTextUnnamedButton(quoted('Plan'), screen), undefined, name);
  const titled = card({
    rows: (r) => [
      ...r.slice(0, 3),
      [{ ...plain, hidden: true, testID: 'title' }, 2, 'RCTText', TITLE, 'Plan'],
    ],
  });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), titled), native(titled), 'by its words');
  assert.equal(
    hiddenTextUnnamedButton(quoted('title'), titled),
    undefined,
    "by a hidden child's test id",
  );
  const echoed = card({
    rows: (r) => [
      ...r.slice(0, 3),
      [{ ...plain, hidden: true, testID: 'Plan' }, 2, 'RCTText', TITLE, 'Plan'],
    ],
  });
  assert.equal(
    hiddenTextUnnamedButton(quoted('Plan'), echoed),
    native(echoed),
    'words equal to its id',
  );
  const disabled = card({
    rows: (r) => [r[0], [{ ...pressable(), disabled: true }, 0, 'RCTView', CARD], r[2], r[3]],
  });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), disabled), undefined, 'React says disabled');
  for (const [name, change] of [
    ['disabled', { enabled: false }],
    ['not hittable', { hittable: false }],
  ] as const) {
    const screen = card({ native: change });
    assert.ok(native(screen), name);
    assert.equal(hiddenTextUnnamedButton(quoted('Plan'), screen), undefined, name);
  }
  // An off-screen node is never observed in a presence read; this pins the shared eligibility alone.
  const offscreen = card();
  native(offscreen).offscreen = true;
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), offscreen), undefined, 'off screen');
});

test('N2: a pressable inside the card away from its centre keeps the proof', () => {
  const screen = card({
    rows: (r) => [
      ...r,
      [{ ...pressable(), hidden: true }, 1, 'RCTView', { x: 300, y: 270, width: 80, height: 20 }],
    ],
  });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), screen), native(screen));
});

test('N2: a second window with no unnamed button at that frame keeps the proof', () => {
  const screen = card({
    extra: [
      [
        {
          ref: '@window2',
          type: 'Window',
          parentIndex: 0,
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
        { status: 'observed', labelSource: 'direct' },
      ],
      [twin({ ...CARD, y: 500 }, { parentIndex: 3 })],
    ],
  });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), screen), native(screen));
});

test("N2: frames are compared under each window's transform, never as raw numbers", () => {
  // The window starts at x 30: the native frame is x 44, React's button x 14.
  const shifted = card({ origin: 30 });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), shifted), native(shifted));
  const raw = card({ origin: 30, native: { rect: CARD } });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), raw), undefined);
});

// Three unnamed cards of equal size in a list, each with its own hidden title; `presence` false gives
// the ordinary read, which carries no React evidence.
const TITLES = ['Kilo', 'Lima', 'Mike'];
function equalCards(presence = true): Screen {
  const at = (k: number): Rect => ({ ...CARD, y: 262 + 100 * k });
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    ...TITLES.map((_, k) => ({
      ref: `@card${k}`,
      type: 'Button',
      parentIndex: 1,
      hittable: true,
      rect: at(k),
    })),
  ];
  const rows: Row[] = [
    [plain, null, 'RCTRootView', { x: 0, y: 0, width: 402, height: 874 }],
    ...TITLES.flatMap((title, k): Row[] => [
      [pressable(), 0, 'RCTView', at(k)],
      [{ ...plain, hidden: true }, 1 + 2 * k, 'RCTText', { ...TITLE, y: at(k).y + 24 }, title],
    ]),
  ];
  return join(
    nodes,
    TITLES.map(() => ({ role: 'button' })),
    'app',
    { native: 'complete', react: 'complete' },
    presence
      ? {
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
        }
      : undefined,
    presence
      ? {
          source: 'xcui-live',
          nodes: nodes.map((_, i) => ({
            status: 'observed',
            labelSource: i < 2 ? 'direct' : 'none',
          })),
        }
      : undefined,
    'complete',
  );
}

test('N2: among equal unnamed cards each hidden title proves its own card', () => {
  const screen = equalCards();
  TITLES.forEach((title, k) =>
    assert.equal(hiddenTextUnnamedButton(quoted(title), screen)?.ref, `@card${k}`, title),
  );
  assert.equal(hiddenTextUnnamedButton(quoted('Lima'), equalCards(false)), undefined);
});

// Walks one plan line on an iOS device whose reads come from `read`; every press is proven.
async function walkOn(line: string, read: (presence: boolean) => Screen) {
  const log: string[] = [];
  let clock = 0;
  const done = { ok: true, proven: true, executed: true } as const;
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen(request) {
      log.push(request?.platformPresence ? 'presence' : 'ordinary');
      return read(!!request?.platformPresence);
    },
    async press(ref) {
      log.push(`press ${ref}`);
      return done;
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      throw new Error('unexpected scroll');
    },
    async back() {
      throw new Error('unexpected back');
    },
    async dialog() {
      throw new Error('unexpected dialog');
    },
    async hideDevMenu() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row() {},
  };
  const outcome = await walkBlock(parsePlan(line).blocks![0], deps);
  return { outcome, presses: log.filter((entry) => entry.startsWith('press')) };
}

test('N3: a Tap on the second card of equal unnamed cards presses that card only', async () => {
  const { outcome, presses } = await walkOn('1. Tap "Lima"', equalCards);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(presses, ['press @card1']);
  assert.equal(
    outcome.rows.at(-1)?.reason,
    'resolved through text hidden from accessibility; tapped the unnamed button at 14,362,374,90',
  );
});

// A pressable inline span (a nested Text with onPress) is never measured; `under` 0 is the screen
// root, 1 the card's button host.
const link =
  (under: 0 | 1, rect: Rect) =>
  (r: Row[]): Row[] => [
    ...r,
    [{ ...plain, hidden: under === 1 }, under, 'RCTText', rect, 'See terms'],
    [
      { ...pressable(), hidden: under === 1 },
      r.length,
      'RCTVirtualText',
      undefined,
      { inline: r.length },
    ],
  ];
const OUTSIDE = link(0, { x: 14, y: 600, width: 200, height: 20 });
const INSIDE = link(1, { x: 28, y: 320, width: 200, height: 20 });

test('N2: an unmeasured pressable inline text elsewhere on screen does not stop the unnamed press', async () => {
  const screen = card({ rows: OUTSIDE });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), screen), native(screen));
  const { outcome, presses } = await walkOn('1. Tap "Plan"', (presence) =>
    card({ rows: OUTSIDE, ordinary: !presence }),
  );
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(presses, ['press @card']);
});

test('N2: an unmeasured pressable inline text in a sibling overlay over the card declines it', () => {
  const overlay = card({ rows: link(0, { x: 28, y: 300, width: 200, height: 20 }) });
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), overlay), undefined);
});

test('N2: an unmeasured pressable inline text inside the card declines it with the usual refusal', async () => {
  assert.equal(hiddenTextUnnamedButton(quoted('Plan'), card({ rows: INSIDE })), undefined);
  const { outcome, presses } = await walkOn('1. Tap "Plan"', (presence) =>
    card({ rows: INSIDE, ordinary: !presence }),
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(presses, []);
  const seen = [outcome.failure?.seen ?? '']
    .flat()
    .map((part) => (typeof part === 'string' ? part : ''))
    .join('');
  assert.match(
    seen,
    /"Plan" is inside a button that hides its children from accessibility and has no accessibilityLabel \(the button at 14,262,374,90\), so no element carries it/,
  );
});
