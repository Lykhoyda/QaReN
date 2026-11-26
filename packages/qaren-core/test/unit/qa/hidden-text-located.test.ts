import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeScrollFromDirection } from '../../../dist/domain/scroll-gesture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { hiddenCard, type HiddenCardRead } from './ios-hidden-card-captures.ts';
import { walkBlock, type WalkerDeps } from '../../../dist/qa/walker.js';
import {
  join,
  type NativeNode,
  type ReactHostObservation,
  type Screen,
} from '../../../dist/qa/screen.js';

// Three equal unnamed cards in a scrolling list under a fixed header row, as on the device's equal-cards
// screen after a scroll. Card k's top is 200 + 100k - offset; the list shows y 100 to 700.
type Rect = { x: number; y: number; width: number; height: number };
type Presence = { status: 'observed' | 'unknown'; labelSource: 'direct' | 'none' };
type Row = [Partial<ReactHostObservation>, number | null, string, Rect | undefined, string?];

const TITLES = ['Kilo', 'Lima', 'Mike'];
const LIST: Rect = { x: 0, y: 100, width: 402, height: 600 };
const plain = { role: null, roleSource: 'none' as const, capabilities: {} };
const pressable = {
  role: 'button',
  roleSource: 'accessibilityRole' as const,
  capabilities: { press: true as const },
};

interface ListOptions {
  offset: number;
  // The fixed header row over the list's top edge.
  row?: Rect;
  // Card 1 (Lima) as the runner reports it.
  lima?: { hittable?: boolean; presence?: Presence };
  // Cards hang straight from the window: no scroll area holds them.
  noList?: boolean;
  // A wide touchable bar lying on the list, outside it, so no part of the list is free.
  bar?: boolean;
  extraRows?: Row[];
  extraNodes?: NativeNode[];
  twinButton?: boolean;
  limaDisabled?: boolean;
  limaAbsent?: boolean;
  titleOutside?: boolean;
  // The list's clip, when not LIST.
  listRect?: Rect;
  // The fixed row precedes the list in the native element order, as a layout sibling above it.
  rowFirst?: boolean;
  // React paints the fixed row before the list, so the list is drawn over it.
  rowUnder?: boolean;
  // Window children listed before the list, after the fixed row when that comes first.
  extraBefore?: NativeNode[];
}

const card = (k: number, offset: number): Rect => ({
  x: 14,
  y: 200 + 100 * k - offset,
  width: 374,
  height: 90,
});

function list(o: ListOptions, presence = true): Screen {
  const row = o.row ?? { x: 0, y: 60, width: 402, height: 60 };
  const listRect = o.listRect ?? LIST;
  const rowNode: NativeNode = {
    ref: '@row',
    type: 'Other',
    parentIndex: 1,
    hittable: true,
    label: 'Header',
    rect: row,
  };
  const before = [...(o.rowFirst ? [rowNode] : []), ...(o.extraBefore ?? [])];
  const listIndex = 2 + before.length;
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    ...before,
    { ref: '@list', type: o.noList ? 'Other' : 'ScrollView', parentIndex: 1, rect: listRect },
    ...TITLES.map((_, k) => ({
      ref: `@card${k}`,
      type: 'Button',
      parentIndex: o.noList ? 1 : listIndex,
      hittable: k === 1 ? (o.lima?.hittable ?? true) : true,
      ...(k === 1 && o.limaDisabled ? { enabled: false } : {}),
      rect: card(k, o.offset),
    })),
    ...(o.rowFirst ? [] : [rowNode]),
    ...(o.bar
      ? [
          {
            ref: '@bar',
            type: 'Other',
            parentIndex: 1,
            hittable: true,
            label: 'Bar',
            rect: { x: 0, y: 300, width: 402, height: 300 },
          },
        ]
      : []),
    ...(o.twinButton
      ? [
          {
            ref: '@twin',
            type: 'Button',
            parentIndex: listIndex,
            hittable: true,
            rect: card(1, o.offset),
          },
        ]
      : []),
    ...(o.extraNodes ?? []),
  ].filter((node) => !(o.limaAbsent && node.ref === '@card1'));
  const rows: Row[] = [
    [plain, null, 'RCTRootView', { x: 0, y: 0, width: 402, height: 874 }],
    [plain, 0, 'RCTScrollView', listRect],
    ...TITLES.flatMap((title, k): Row[] => {
      const c = card(k, o.offset);
      return [
        [k === 1 && o.limaDisabled ? { ...pressable, disabled: true } : pressable, 1, 'RCTView', c],
        [
          { ...plain, hidden: true },
          2 + 2 * k,
          'RCTText',
          { x: 28, y: k === 1 && o.titleOutside ? c.y + 200 : c.y + 24, width: 300, height: 21 },
          title,
        ],
      ];
    }),
    [o.rowUnder ? { ...plain, order: -1 } : plain, 0, 'RCTView', row],
    ...(o.extraRows ?? []),
  ];
  if (!presence)
    return join(
      nodes,
      TITLES.map(() => ({ role: 'button' })),
      'app',
      {
        native: 'complete',
        react: 'complete',
      },
    );
  return join(
    nodes,
    TITLES.map(() => ({ role: 'button' })),
    'app',
    { native: 'complete', react: 'complete' },
    {
      complete: true,
      // Paint order follows the rows: the header row is drawn over the list.
      hosts: rows.map(([host], order) => ({ ...plain, order, ...host })),
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
      nodes: nodes.map((node) =>
        node.ref === '@card1' && o.lima?.presence
          ? o.lima.presence
          : { status: 'observed', labelSource: node.label ? 'direct' : 'none' },
      ),
    },
    'complete',
  );
}

type Act = Awaited<ReturnType<WalkerDeps['press']>>;
const executed: Act = { ok: true, proven: true, executed: true };
const refused = (error: string): Act => ({
  ok: false,
  proven: false,
  executed: false,
  mutation: 'none',
  error,
});

// Lima starts cut off by the list's top edge with its centre under the header row, as in row G5.
const CUT: ListOptions = {
  offset: 259,
  lima: { hittable: false, presence: { status: 'unknown', labelSource: 'none' } },
};

// Walks one Tap on a device whose list moves to `after` on a scroll; reads and dispatches are logged.
async function walkList(
  start: ListOptions,
  after: ListOptions | undefined,
  options: {
    acts?: Act[];
    scrollResult?: Act;
    screenshots?: boolean;
    line?: string;
    // A device's own reads instead of the list.
    read?: (presence: boolean) => Screen;
  } = {},
) {
  const log: string[] = [];
  const bands: unknown[] = [];
  const distances: unknown[] = [];
  const notes: string[] = [];
  let state = start;
  let clock = 0;
  const acts = [...(options.acts ?? [])];
  let presenceReads = 0;
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen(request) {
      const presence = !!request?.platformPresence;
      log.push(presence ? 'presence' : 'ordinary');
      const screen = options.read ? options.read(presence) : list(state, presence);
      // Each presence read names Lima's element afresh, so a press shows which read it came from.
      if (presence) {
        presenceReads += 1;
        const lima = screen.elements.find((e) => e.ref === '@card1');
        if (lima) lima.ref = `@card1-${presenceReads}`;
      }
      return screen;
    },
    async press(ref) {
      log.push(`press ${ref}`);
      return acts.shift() ?? executed;
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll(direction, _context, distance, band) {
      log.push(`scroll ${direction}`);
      bands.push(band);
      distances.push(distance);
      if (after) state = after;
      return options.scrollResult ?? { ok: true, proven: false, executed: true };
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
      log.push('screenshot');
      return name;
    },
    ...(options.screenshots
      ? {
          comparisonScreenshot: async () => {
            log.push('comparison');
            return new Uint8Array([1]);
          },
        }
      : {}),
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row() {},
    note: (message) => notes.push(message),
  };
  const outcome = await walkBlock(parsePlan(options.line ?? '1. Tap "Lima"').blocks![0], deps);
  const seen = [outcome.failure?.seen ?? '']
    .flat()
    .map((part) => (typeof part === 'string' ? part : ''))
    .join('');
  return {
    outcome,
    log,
    presses: log.filter((entry) => entry.startsWith('press')),
    scrolls: log.filter((entry) => entry.startsWith('scroll')),
    bands,
    distances,
    notes,
    reason: seen.split('; last observed on screen: ')[0],
  };
}

// Walks one Tap over a device's saved reads: one for presence reads, one for ordinary reads.
const walkReads = (presence: HiddenCardRead, ordinary: HiddenCardRead, line: string) =>
  walkList({ offset: 0 }, undefined, {
    line,
    read: (platformPresence) => hiddenCard(platformPresence ? presence : ordinary),
  });

// The one located-clearance decision a walk recorded.
function locatedNote(notes: string[]) {
  const note = notes.find((entry) => entry.startsWith('located-clearance '));
  assert.ok(note, notes.join('\n'));
  return JSON.parse(note.slice('located-clearance '.length));
}

// The read just before each press is a presence read, and the press is that read's own element.
function pressedFromLastRead(log: string[]) {
  for (const [i, entry] of log.entries()) {
    if (!entry.startsWith('press')) continue;
    assert.equal(log[i - 1], 'presence', log.join());
    const read = log.slice(0, i).filter((e) => e === 'presence').length;
    assert.equal(entry, `press @card1-${read}`, log.join());
  }
}

const CUT_OFF = (frame: string, after = '') =>
  `"Lima" is text hidden from accessibility; its unnamed button at ${frame} is cut off by its scroll area${after}, so nothing was tapped. Scroll it fully into view before this step, or give the button an accessibilityLabel`;
const UNDER = (frame: string, after = '') =>
  `"Lima" is text hidden from accessibility; the centre of its unnamed button at ${frame} is under another element${after}, so nothing was tapped. Scroll it clear before this step, or give the button an accessibilityLabel`;

test('Q1: a cut-off unnamed button is scrolled once, proven again on a presence read, and pressed once', async () => {
  const run = await walkList(CUT, { offset: 159 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.equal(run.scrolls.length, 1, run.log.join());
  // The drag runs on the card's own list, below the fixed header row that cuts its top.
  assert.deepEqual(run.bands, [{ x: 0, y: 120, width: 402, height: 580 }]);
  assert.deepEqual(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
  const pass = run.outcome.rows.at(-1)!;
  assert.equal(
    pass.reason,
    'resolved through text hidden from accessibility; tapped the unnamed button at 14,141,374,90',
  );
  assert.equal(pass.selector, undefined);
  assert.equal(pass.attempt, 1);
  assert.deepEqual(run.log, [
    'ordinary',
    'presence',
    'presence',
    'scroll up',
    'presence',
    'presence',
    'press @card1-4',
    'presence',
    // The pass row's own screenshot, after the readback.
    'screenshot',
  ]);
});

test('Q1: the offscreen decision records the header cut while scrolling and pressing once', async () => {
  const run = await walkList(CUT, { offset: 159 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.deepEqual(locatedNote(run.notes), {
    line: 1,
    located: true,
    cutOff: true,
    covered: true,
    path: 'offscreen',
    container: true,
    band: { x: 0, y: 120, width: 402, height: 580 },
    direction: 'up',
    trimmedBy: [{ kind: 'other', frame: { x: 0, y: 60, width: 402, height: 60 } }],
    withheld: null,
  });
  assert.deepEqual(run.bands, [{ x: 0, y: 120, width: 402, height: 580 }]);
  assert.deepEqual(run.scrolls, ['scroll up']);
  assert.deepEqual(run.presses, ['press @card1-4']);
  pressedFromLastRead(run.log);
});

test('Q2: when the one scroll does not bring the button clear nothing is pressed and the cause is named', async () => {
  const run = await walkList(CUT, CUT);
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.deepEqual(run.presses, []);
  assert.ok(
    run.reason.startsWith(`TARGET_NOT_FOUND: ${CUT_OFF('14,41,374,90', ' after one scroll')}`),
    run.reason,
  );
});

test('Q2: when the read after the scroll no longer locates one button nothing is pressed', async () => {
  // A second unnamed button appears at the frame on the read that would have proven it.
  const run = await walkList(CUT, { offset: 159, twinButton: true });
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.deepEqual(run.presses, []);
  assert.ok(
    run.reason.startsWith(
      'TARGET_NOT_FOUND: "Lima" is text hidden from accessibility; its unnamed button no longer resolved to exactly one element on the next read after one scroll, so nothing was tapped',
    ),
    run.reason,
  );
});

// Lima fully inside the list, its centre under a deeper header row that straddles the list's top edge.
const COVERED: ListOptions = { offset: 159, row: { x: 0, y: 60, width: 402, height: 140 } };

test('Q3: a button whose centre is under another element is scrolled clear once and pressed once', async () => {
  const run = await walkList(COVERED, { ...COVERED, offset: 59 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.equal(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
});

test('Q3: when the cover stays over the centre after the one scroll, nothing is pressed and the cause is named', async () => {
  const run = await walkList(COVERED, COVERED);
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.deepEqual(run.presses, []);
  assert.ok(
    run.reason.startsWith(`TARGET_NOT_FOUND: ${UNDER('14,141,374,90', ' after one scroll')}`),
    run.reason,
  );
});

test('Q4: located relaxes nothing else: each other failed proof scrolls nothing and taps nothing', async () => {
  const cases: Array<[string, ListOptions]> = [
    ['two unnamed buttons at the frame', { ...CUT, twinButton: true }],
    [
      'two press-capable hosts at the frame',
      { ...CUT, extraRows: [[pressable, 1, 'RCTView', card(1, CUT.offset)]] },
    ],
    [
      'a non-inline press-capable host without a rect',
      { ...CUT, extraRows: [[pressable, 0, 'RCTView', undefined]] },
    ],
    ['the text outside the button', { ...CUT, titleOutside: true }],
    ['the button absent from the native list', { ...CUT, limaAbsent: true }],
    ['the button disabled', { ...CUT, limaDisabled: true }],
  ];
  for (const [name, start] of cases) {
    const run = await walkList(start, { offset: 159 });
    assert.equal(run.outcome.block.outcome, 'fail', name);
    assert.deepEqual(run.scrolls, [], `${name}: ${run.log.join()}`);
    assert.deepEqual(run.presses, [], name);
    assert.doesNotMatch(run.reason, /cut off by its scroll area|is under another element/, name);
  }
});

test('Q5: when a scroll is not allowed nothing is scrolled or pressed, and the cause is named without "after one scroll"', async () => {
  // On the covered path a bar across the middle of the band is never trimmed away: the free-ground rule
  // still withholds.
  const withheld = await walkList({ ...COVERED, bar: true }, { ...COVERED, offset: 59 });
  assert.deepEqual(withheld.scrolls, [], withheld.log.join());
  assert.deepEqual(withheld.presses, []);
  assert.ok(
    withheld.reason.startsWith(
      'TARGET_NOT_FOUND: "Lima" is text hidden from accessibility; the centre of its unnamed button at 14,141,374,90 is under another element, and no part of its scroll area is free of what lies in front or behind, so nothing was tapped',
    ),
    withheld.reason,
  );
  assert.deepEqual(locatedNote(withheld.notes), {
    line: 1,
    located: true,
    cutOff: false,
    covered: true,
    path: 'covered',
    container: true,
    band: { x: 0, y: 200, width: 402, height: 500 },
    direction: null,
    trimmedBy: [{ kind: 'other', frame: COVERED.row }],
    withheld: 'no-free-part',
  });
  const unheld = await walkList({ ...CUT, noList: true }, { offset: 159 });
  assert.deepEqual(unheld.scrolls, [], unheld.log.join());
  assert.deepEqual(unheld.presses, []);
  assert.ok(
    unheld.reason.startsWith(
      // No scroll area clips it, so the cause the read shows is the row over its centre.
      'TARGET_NOT_FOUND: "Lima" is text hidden from accessibility; the centre of its unnamed button at 14,41,374,90 is under another element, and no scroll area holds it, so nothing was tapped',
    ),
    unheld.reason,
  );
});

test('Q6: a button proven on the recovery read is pressed with no scroll', async () => {
  const run = await walkList({ offset: 159 }, undefined);
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.deepEqual(run.scrolls, []);
  assert.equal(run.presses.length, 1);
});

test('Q7: after the scroll, an executed tap that changes nothing is never repeated', async () => {
  const run = await walkList(
    CUT,
    { offset: 159 },
    { acts: [{ ok: true, proven: false, executed: true }] },
  );
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.equal(run.presses.length, 1, run.log.join());
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.match(run.reason, /The original action may have taken effect/);
});

test('Q7: a runner refusal of the press after the scroll ends the step with no second scroll or press', async () => {
  const run = await walkList(
    CUT,
    { offset: 159 },
    {
      acts: [refused('FOCUS_TARGET_OCCLUDED: covered'), executed],
    },
  );
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.equal(run.presses.length, 1, run.log.join());
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.match(
    run.reason,
    /; its unnamed button at 14,141,374,90 was not tapped: the runner refused the press: FOCUS_TARGET_OCCLUDED: covered/,
  );
});

test('Q8: on the scroll path no ordinary read or pixel baseline lies between the last proof and the press', async () => {
  const run = await walkList(CUT, { offset: 159 }, { screenshots: true });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  const press = run.log.findIndex((entry) => entry.startsWith('press'));
  const scroll = run.log.findIndex((entry) => entry.startsWith('scroll'));
  assert.ok(press > scroll && scroll >= 0, run.log.join());
  assert.ok(
    run.log.slice(scroll + 1, press).every((entry) => entry === 'presence'),
    run.log.join(),
  );
  pressedFromLastRead(run.log);
});

test('a refused unchanged clearance scroll names centre coverage after one scroll', async () => {
  const run = await walkList(COVERED, COVERED, { scrollResult: refused('drag refused') });
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.deepEqual(run.presses, []);
  assert.ok(
    run.reason.startsWith(`TARGET_NOT_FOUND: ${UNDER('14,141,374,90', ' after one scroll')}`),
    run.reason,
  );
});

test('fully visible unnamed buttons need proven presence and a resolved centre hit', async () => {
  const cases: Array<[string, ListOptions]> = [
    [
      'unknown presence',
      { offset: 159, lima: { presence: { status: 'unknown', labelSource: 'none' } } },
    ],
    [
      'unresolved hit',
      { offset: 159, extraRows: [[{ ...plain, order: undefined }, 0, 'RCTView', card(1, 159)]] },
    ],
    ['not hittable without a cause', { offset: 159, lima: { hittable: false } }],
  ];
  for (const [name, start] of cases) {
    const run = await walkList(start, { offset: 59 });
    assert.equal(run.outcome.block.outcome, 'fail', name);
    assert.deepEqual(run.scrolls, [], name);
    assert.deepEqual(run.presses, [], name);
    assert.doesNotMatch(run.reason, /cut off by its scroll area|is under another element/, name);
  }
});

test('an unmeasured plain view painted over a visible unnamed card leaves its centre hit unresolved: nothing is pressed', async () => {
  // A plain sibling with no measured frame, painted last, could lie over the centre unseen.
  const overlay: ListOptions = { offset: 159, extraRows: [[plain, 0, 'RCTView', undefined]] };
  const run = await walkList(overlay, { offset: 59 });
  assert.equal(run.outcome.block.outcome, 'fail', run.reason);
  assert.deepEqual(run.scrolls, [], run.log.join());
  assert.deepEqual(run.presses, [], run.log.join());
  assert.doesNotMatch(run.reason, /cut off by its scroll area|is under another element/);
});

test('a partially clipped observed hittable button with a clear centre is pressed without scrolling', async () => {
  const run = await walkList({ offset: 205 }, undefined);
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.deepEqual(run.scrolls, []);
  assert.equal(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
});

// Row G5's shape: the list's clip runs from 224.67 to 840 under fixed rows listed before it. Lima at
// 14,170.7,374,90 is hittable, 54 pt above the clip, its centre (215.7) outside the clip.
const ROWS: Rect = { x: 0, y: 120, width: 402, height: 110 };
const G5: ListOptions = {
  offset: 129.3,
  listRect: { x: 0, y: 224.67, width: 402, height: 615.33 },
  row: ROWS,
  rowFirst: true,
};

// Listed before the list either way; React paints the rows before it or over it. Painted over it, the
// centre is outside the clip AND covered: "centre outside its clip" is judged first, so the offscreen
// path still wins.
for (const rowUnder of [true, false])
  test(`Q9: a card whose centre lies above its clip (rows painted ${rowUnder ? 'before the list' : 'over it, so also covered'}) takes a named target's offscreen scroll, then one press`, async () => {
    const run = await walkList({ ...G5, rowUnder }, { ...G5, rowUnder, offset: -100 });
    assert.equal(run.outcome.block.outcome, 'pass', run.reason);
    assert.deepEqual(run.scrolls, ['scroll up'], run.log.join());
    // The clip's own band, as for a named target: no free-ground trim.
    assert.deepEqual(run.bands, [G5.listRect]);
    // The runner's drag starts inside the band, below the rows.
    const drag = computeScrollFromDirection(
      'up',
      0.6,
      run.bands[0] as Rect,
      run.distances[0] as number,
    )!;
    for (const y of [drag.y1, drag.y2]) assert.ok(y >= ROWS.y + ROWS.height, `${y}`);
    assert.equal(run.presses.length, 1, run.log.join());
    pressedFromLastRead(run.log);
    assert.deepEqual(locatedNote(run.notes), {
      line: 1,
      located: true,
      cutOff: true,
      covered: !rowUnder,
      path: 'offscreen',
      container: true,
      band: G5.listRect,
      direction: 'up',
      trimmedBy: [],
      withheld: null,
    });
  });

// The lane's own reads of the failed G5 at 56f60259f: obs27 is the last presence read of the Tap line,
// obs25 an ordinary read. No read after a scroll exists, so the screen stays as read.
test('Q9 (device read): the cut-off Lima card on the real G5 screen gets one offscreen scroll', async () => {
  const run = await walkReads('g5-obs27-presence', 'g5-obs25-ordinary', '1. Tap "Lima plan"');
  assert.deepEqual(run.scrolls, ['scroll up'], run.log.join());
  assert.deepEqual(run.bands, [
    { x: 0, y: 224.66666412353516, width: 402, height: 649.3333333333333 },
  ]);
  assert.deepEqual(run.presses, []);
  assert.ok(
    run.reason.startsWith(
      'TARGET_NOT_FOUND: "Lima plan" is text hidden from accessibility; its unnamed button at 14,170.7,374,90 is cut off by its scroll area after one scroll, so nothing was tapped',
    ),
    run.reason,
  );
  assert.equal(locatedNote(run.notes).path, 'offscreen');
});

// The covered path: rows listed before the list reach 35 pt into its clip, over Lima's centre (240),
// which lies inside the clip. Free-ground trimming leaves the band below the rows.
const DEEP_ROWS: Rect = { x: 0, y: 120, width: 402, height: 140 };
const IN_CLIP: ListOptions = { ...G5, row: DEEP_ROWS, offset: 105 };
const TRIMMED: Rect = { x: 0, y: 260, width: 402, height: 580 };

// Painted over the centre: rows painted under the list leave the centre to the card, which the strict
// proof then presses with no scroll.
test('Q9 covered path: rows reaching into the clip over the centre are trimmed off the band: one drag on free ground, then one press', async () => {
  const run = await walkList(IN_CLIP, { ...IN_CLIP, offset: -100 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.deepEqual(run.bands, [TRIMMED]);
  const drag = computeScrollFromDirection(
    run.scrolls[0] === 'scroll up' ? 'up' : 'down',
    0.6,
    run.bands[0] as Rect,
    run.distances[0] as number,
  )!;
  for (const y of [drag.y1, drag.y2])
    assert.ok(y > TRIMMED.y && y < TRIMMED.y + TRIMMED.height, `${y}`);
  assert.equal(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
  const note = locatedNote(run.notes);
  assert.equal(note.path, 'covered');
  assert.deepEqual(note.trimmedBy, [{ kind: 'other', frame: DEEP_ROWS }]);
});

// The cover at the centre is a caption text the free-ground count leaves out, not hittable, reaching
// into the band's top edge over Lima's centre inside the clip: the cover gets the same edge rule.
const CAPTION: Rect = { x: 0, y: 190, width: 402, height: 70 };
const CAPTIONED: ListOptions = {
  ...IN_CLIP,
  row: { x: 0, y: 20, width: 402, height: 20 },
  extraBefore: [
    {
      ref: '@caption',
      type: 'StaticText',
      parentIndex: 1,
      identifier: 'qa-caption',
      label: 'Caption',
      rect: CAPTION,
    },
  ],
  extraRows: [[{ ...plain, testID: 'qa-caption' }, 0, 'RCTText', CAPTION, 'Caption']],
};

test('Q9b: a text cover reaching into the band top is trimmed off like a counted view: one drag, one press', async () => {
  const run = await walkList(CAPTIONED, { ...CAPTIONED, offset: -100 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.deepEqual(run.scrolls, ['scroll up'], run.log.join());
  assert.deepEqual(run.bands, [TRIMMED]);
  assert.equal(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
  assert.deepEqual(locatedNote(run.notes).trimmedBy, [{ kind: 'text', frame: CAPTION }]);
});

test('Q9b: a hidden middle cover withholds even when another cover trims the top edge', async () => {
  const edge = { x: 0, y: 190, width: 402, height: 320 };
  const middle = { x: 0, y: 470, width: 402, height: 60 };
  const shape: ListOptions = {
    ...CAPTIONED,
    offset: -155,
    extraBefore: CAPTIONED.extraBefore!.map((node) => ({ ...node, rect: edge })),
    extraRows: [
      [{ ...plain, testID: 'qa-caption' }, 0, 'RCTText', edge, 'Caption'],
      [{ ...plain, hidden: true }, 0, 'RCTText', middle, 'Hidden caption'],
    ],
  };
  const run = await walkList(shape, { ...shape, offset: -100 });
  assert.equal(run.outcome.block.outcome, 'fail', run.reason);
  assert.deepEqual(run.scrolls, [], run.log.join());
  assert.deepEqual(run.presses, []);
  assert.ok(
    run.reason.startsWith(
      'TARGET_NOT_FOUND: "Lima" is text hidden from accessibility; the centre of its unnamed button at 14,455,374,90 is under another element, and no part of its scroll area is free of what lies in front or behind, so nothing was tapped',
    ),
    run.reason,
  );
  const note = run.notes.find((note) => note.startsWith('located-clearance '));
  assert.ok(note);
  assert.deepEqual(JSON.parse(note.slice('located-clearance '.length)), {
    line: 1,
    located: true,
    cutOff: false,
    covered: true,
    path: 'covered',
    container: true,
    band: { x: 0, y: 510, width: 402, height: 330 },
    direction: null,
    trimmedBy: [{ kind: 'text', frame: edge }],
    withheld: 'no-free-part',
  });
});

for (const hidden of [false, true]) {
  const caption = (rect: Rect): ListOptions => ({
    ...CAPTIONED,
    extraBefore: CAPTIONED.extraBefore!.map(({ identifier: _, ...node }) => ({ ...node, rect })),
    extraRows: [[{ ...plain, hidden }, 0, 'RCTText', rect, 'Caption']],
  });

  test(`Q9b: a text cover without an identifier (accessibility hidden: ${hidden}) trims the top edge`, async () => {
    const shape = caption(CAPTION);
    const run = await walkList(shape, { ...shape, offset: -100 });
    assert.equal(run.outcome.block.outcome, 'pass', run.reason);
    assert.deepEqual(run.scrolls, ['scroll up'], run.log.join());
    assert.deepEqual(run.bands, [TRIMMED]);
    assert.equal(run.presses.length, 1, run.log.join());
    pressedFromLastRead(run.log);
    assert.ok(
      run.notes.some((note) =>
        note.includes(`"trimmedBy":[{"kind":"react-cover","frame":${JSON.stringify(CAPTION)}}]`),
      ),
      run.notes.join('\n'),
    );
  });

  test(`Q9b: a text cover without an identifier (accessibility hidden: ${hidden}) across the middle withholds`, async () => {
    const rect = { x: 0, y: 470, width: 402, height: 60 };
    const shape = { ...caption(rect), offset: -155 };
    const run = await walkList(shape, { ...shape, offset: -100 });
    assert.equal(run.outcome.block.outcome, 'fail', run.reason);
    assert.deepEqual(run.scrolls, [], run.log.join());
    assert.deepEqual(run.presses, []);
    assert.ok(
      run.reason.startsWith(
        'TARGET_NOT_FOUND: "Lima" is text hidden from accessibility; the centre of its unnamed button at 14,455,374,90 is under another element, and no part of its scroll area is free of what lies in front or behind, so nothing was tapped',
      ),
      run.reason,
    );
    const note = run.notes.find((note) => note.startsWith('located-clearance '));
    assert.ok(note);
    assert.deepEqual(JSON.parse(note.slice('located-clearance '.length)), {
      line: 1,
      located: true,
      cutOff: false,
      covered: true,
      path: 'covered',
      container: true,
      band: G5.listRect,
      direction: null,
      trimmedBy: [],
      withheld: 'no-free-part',
    });
  });
}

test('Q9c: two fixed rows stacked above the list, both reaching into it: the band starts under the lower', async () => {
  const stacked: ListOptions = {
    ...IN_CLIP,
    extraBefore: [
      {
        ref: '@row2',
        type: 'Other',
        parentIndex: 1,
        hittable: true,
        label: 'Second',
        rect: { x: 0, y: 150, width: 402, height: 115 },
      },
    ],
  };
  const run = await walkList(stacked, { ...stacked, offset: -100 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.deepEqual(run.bands, [{ x: 0, y: 265, width: 402, height: 575 }]);
  assert.equal(run.presses.length, 1, run.log.join());
});

test('located-clearance records shared top cuts and local bottom trims without changing the drag', async () => {
  // COVERED's header row is listed after the list, so the shared band already starts under it.
  const footer = { x: 0, y: 650, width: 402, height: 100 };
  const shape: ListOptions = {
    ...COVERED,
    extraBefore: [{ ref: '@footer', type: 'Other', parentIndex: 1, hittable: true, rect: footer }],
  };
  const run = await walkList(shape, { ...shape, offset: 59 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.deepEqual(run.scrolls, ['scroll up'], run.log.join());
  assert.deepEqual(run.bands, [{ x: 0, y: 200, width: 402, height: 450 }]);
  assert.deepEqual(run.distances, [239]);
  assert.equal(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
  assert.deepEqual(locatedNote(run.notes), {
    line: 1,
    located: true,
    cutOff: false,
    covered: true,
    path: 'covered',
    container: true,
    band: { x: 0, y: 200, width: 402, height: 450 },
    direction: 'up',
    trimmedBy: [
      { kind: 'other', frame: COVERED.row },
      { kind: 'other', frame: footer },
    ],
    withheld: null,
  });
});

test('Q9d: a view across the whole band, or a band trimmed below 50 pt, withholds the scroll and names no free part', async () => {
  const cases: Array<[string, Rect]> = [
    ['a view across both edges', { x: 0, y: 200, width: 402, height: 700 }],
    // With the rows trimming the top to 260, a footer from 309 leaves a 49 pt band.
    ['a 49 pt band', { x: 0, y: 309, width: 402, height: 700 }],
  ];
  for (const [name, rect] of cases) {
    const shape: ListOptions = {
      ...IN_CLIP,
      extraBefore: [{ ref: '@sheet', type: 'Other', parentIndex: 1, hittable: true, rect }],
    };
    const run = await walkList(shape, { ...shape, offset: -100 });
    assert.equal(run.outcome.block.outcome, 'fail', name);
    assert.deepEqual(run.scrolls, [], `${name}: ${run.log.join()}`);
    assert.deepEqual(run.presses, [], name);
    assert.ok(
      run.reason.startsWith(
        'TARGET_NOT_FOUND: "Lima" is text hidden from accessibility; its unnamed button at 14,195,374,90 is cut off by its scroll area, and no part of its scroll area is free of what lies in front or behind, so nothing was tapped',
      ),
      `${name}: ${run.reason}`,
    );
    assert.deepEqual(
      locatedNote(run.notes),
      {
        line: 1,
        located: true,
        cutOff: true,
        covered: true,
        path: 'covered',
        container: true,
        band: name === 'a 49 pt band' ? { x: 0, y: 260, width: 402, height: 49 } : G5.listRect,
        direction: null,
        trimmedBy: [
          { kind: 'other', frame: DEEP_ROWS },
          { kind: 'other', frame: rect },
        ],
        withheld: 'no-free-part',
      },
      name,
    );
  }
});

// Row G5c on the device: after three scrolls the first card is at 14,-627.3,374,90, wholly above its clip.
test('G5c: a card wholly above its clip is located from geometry, scrolled once, and refused after one scroll', async () => {
  const G5C: ListOptions = { ...G5, offset: 827.3 };
  const run = await walkList(G5C, G5C, { line: '1. Tap "Kilo"' });
  assert.equal(run.outcome.block.outcome, 'fail');
  assert.deepEqual(run.scrolls, ['scroll up'], run.log.join());
  // The offscreen path: the clip's own band, as for a named target.
  assert.deepEqual(run.bands, [G5.listRect]);
  assert.deepEqual(run.presses, []);
  assert.equal(locatedNote(run.notes).path, 'offscreen');
  assert.ok(
    run.reason.startsWith(
      'TARGET_NOT_FOUND: "Kilo" is text hidden from accessibility; its unnamed button at 14,-627.3,374,90 is cut off by its scroll area after one scroll, so nothing was tapped',
    ),
    run.reason,
  );
});
