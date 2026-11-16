import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
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
}

const card = (k: number, offset: number): Rect => ({
  x: 14,
  y: 200 + 100 * k - offset,
  width: 374,
  height: 90,
});

function list(o: ListOptions, presence = true): Screen {
  const row = o.row ?? { x: 0, y: 60, width: 402, height: 60 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    { ref: '@list', type: o.noList ? 'Other' : 'ScrollView', parentIndex: 1, rect: LIST },
    ...TITLES.map((_, k) => ({
      ref: `@card${k}`,
      type: 'Button',
      parentIndex: o.noList ? 1 : 2,
      hittable: k === 1 ? (o.lima?.hittable ?? true) : true,
      ...(k === 1 && o.limaDisabled ? { enabled: false } : {}),
      rect: card(k, o.offset),
    })),
    { ref: '@row', type: 'Other', parentIndex: 1, hittable: true, label: 'Header', rect: row },
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
      ? [{ ref: '@twin', type: 'Button', parentIndex: 2, hittable: true, rect: card(1, o.offset) }]
      : []),
    ...(o.extraNodes ?? []),
  ].filter((node) => !(o.limaAbsent && node.ref === '@card1'));
  const rows: Row[] = [
    [plain, null, 'RCTRootView', { x: 0, y: 0, width: 402, height: 874 }],
    [plain, 0, 'RCTScrollView', LIST],
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
    [plain, 0, 'RCTView', row],
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
  options: { acts?: Act[]; scrollResult?: Act; screenshots?: boolean; line?: string } = {},
) {
  const log: string[] = [];
  const bands: unknown[] = [];
  let state = start;
  let clock = 0;
  const acts = [...(options.acts ?? [])];
  let presenceReads = 0;
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen(request) {
      const presence = !!request?.platformPresence;
      log.push(presence ? 'presence' : 'ordinary');
      const screen = list(state, presence);
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
    async scroll(direction, _context, _distance, band) {
      log.push(`scroll ${direction}`);
      bands.push(band);
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
    reason: seen.split('; last observed on screen: ')[0],
  };
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
  const withheld = await walkList({ ...CUT, bar: true }, { offset: 159 });
  assert.deepEqual(withheld.scrolls, [], withheld.log.join());
  assert.deepEqual(withheld.presses, []);
  assert.ok(
    withheld.reason.startsWith(`TARGET_NOT_FOUND: ${CUT_OFF('14,41,374,90')}`),
    withheld.reason,
  );
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
  assert.match(run.reason, /was tapped once through that text and the tap showed no change/);
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

test('a partially clipped hittable button still needs its one scroll before pressing', async () => {
  const run = await walkList({ offset: 205 }, { offset: 105 });
  assert.equal(run.outcome.block.outcome, 'pass', run.reason);
  assert.equal(run.scrolls.length, 1, run.log.join());
  assert.equal(run.presses.length, 1, run.log.join());
  pressedFromLastRead(run.log);
});
