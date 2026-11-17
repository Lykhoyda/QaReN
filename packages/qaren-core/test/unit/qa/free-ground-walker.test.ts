// A covered iOS press on the real unnamed-cards list: release 2.2.1 counted the screen's empty
// full-screen views as covers and withheld the clearance drag. A drag is sent across them only when a
// named element inside the list reads natively hittable on a presence read; anything solid keeps
// today's refusal and costs no hit read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type {
  DigestEntry,
  NativeNode,
  ReactHostEvidence,
  Screen,
} from '../../../dist/qa/screen.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { HitProbeResult } from '../../../dist/qa/live-hit.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import {
  addNode,
  CARDS,
  edits,
  insertNode,
  nameCard,
  shiftContent,
  unnamedCards,
} from './free-ground-reads.ts';
import { scrollUntilBand } from '../../../dist/qa/resolve.js';
import type { JoinArgs, UnnamedCardsRead } from './free-ground-reads.ts';

type Rect = NonNullable<NativeNode['rect']>;
const OCCLUDED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error: 'FOCUS_TARGET_OCCLUDED: the focus or tap point is covered by another element',
};
const TARGET = 'qa-ground-target';
const WITNESS = 'qa-ground-witness';
const CLIP_TOP = 224.66666412353516;
const SCREEN_BOTTOM = 874;

// The list scrolled 100 points less, so cards 2 and 3 lie wholly in its clip. Card 2 is the target,
// named in its native node only: its React host stays unassociated, as on the device, so the cover
// lookup answers `unassociated-host`. Card 3 is the witness, named in its native node and its host.
const named = (read: UnnamedCardsRead, ...more: ((a: JoinArgs) => unknown)[]) =>
  edits(
    shiftContent(read, 100),
    (args) => (args.nodes[CARDS[read].cards[1]].identifier = TARGET),
    nameCard(read, 2, WITNESS),
    ...more,
  );

// A childless view over the lower half of the list, listed after it, as in the presence read only.
const LOWER_HALF: Rect = {
  x: 0,
  y: CLIP_TOP + (SCREEN_BOTTOM - CLIP_TOP) / 2,
  width: 402,
  height: (SCREEN_BOTTOM - CLIP_TOP) / 2,
};
const hiddenOverLowerHalf = addNode(21, { type: 'Other', rect: LOWER_HALF });

interface Scenario {
  // Each read the walker asks for, before or after the one drag: a presence read, or an ordinary one.
  ordinary: (dragged: boolean) => Screen;
  presence: (dragged: boolean) => Screen;
  // The runner's hit read; `clock.ms` may be moved forward to make the read slow.
  hit?: (ref: string, clock: { ms: number }) => HitProbeResult;
  step?: string;
  kind?: 'press' | 'fill';
  platform?: WalkerDeps['platform'];
  setup?: (deps: WalkerDeps) => void;
}

async function walk(s: Scenario) {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('exact targets are model-free')),
  );
  w.deps.platform = s.platform ?? 'ios';
  const clock = { ms: 0 };
  w.deps.now = () => clock.ms;
  w.deps.sleep = async (ms) => {
    clock.ms += ms;
  };
  const log: string[] = [];
  const bands: (Rect | undefined)[] = [];
  const hits: string[] = [];
  // As on the device: the press or fill is refused until a drag has moved the target clear.
  let dragged = false;
  w.deps.captureScreen = async (request) => {
    const presence = request?.platformPresence === true;
    log.push(presence ? 'presence' : 'capture');
    return presence ? s.presence(dragged) : s.ordinary(dragged);
  };
  const dispatch = (name: string) => async (ref: string) => {
    log.push(`${name} ${ref}`);
    return dragged ? { ok: true, proven: true } : OCCLUDED;
  };
  w.deps.press = dispatch('press') as WalkerDeps['press'];
  w.deps.fill = dispatch('fill') as WalkerDeps['fill'];
  w.deps.scroll = async (direction, _context, _distance, band) => {
    dragged = true;
    log.push(`scroll ${direction}`);
    bands.push(band);
    return { ok: true, proven: false, executed: true };
  };
  w.deps.hitProbe = async (ref) => {
    hits.push(ref);
    log.push(`hit ${ref}`);
    return s.hit ? s.hit(ref, clock) : 'hittable';
  };
  s.setup?.(w.deps);
  const step =
    s.step ?? (s.kind === 'fill' ? `1. Fill "${TARGET}" with "x"` : `1. Tap "${TARGET}"`);
  const result = await runPlan(parsePlan(step).blocks!, w.deps);
  const reason = renderReason(result.failure?.seen ?? '', (text) => text);
  const row = w.rows.filter((r) => r.line === 1).at(-1);
  return { result, reason, log, bands, hits, row };
}

const scrolls = (log: string[]) => log.filter((a) => a.startsWith('scroll'));
const presses = (log: string[]) => log.filter((a) => a.startsWith('press') || a.startsWith('fill'));
const NO_FREE_PART =
  /stayed covered; no part of its scroll area is free of what lies in front or behind, so nothing was scrolled/;

test("G2, G2b: a decision on an ordinary read, the hidden view absent, proves nothing: no hit read, today's refusal", async () => {
  // The ordinary read carries the presence facts, so the cover lookup needs no presence recapture and
  // the clearance decision runs on the ordinary observation. A witness lies in the band.
  const r = await walk({
    ordinary: () => unnamedCards('presence', named('presence')),
    presence: () => assert.fail('no presence recapture is taken'),
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
  assert.equal(presses(r.log).length, 2, r.log.join(','));
  assert.match(r.reason, NO_FREE_PART);
});

test('G2b: a view over the lower half of the list in the presence read: the drag starts above it', async () => {
  const r = await walk({
    ordinary: () => unnamedCards('ordinary', named('ordinary')),
    presence: () => unnamedCards('presence', named('presence', hiddenOverLowerHalf)),
  });
  assert.equal(r.result.verdict, 'PASS', r.reason);
  assert.deepEqual(r.hits, ['@e36'], r.log.join(','));
  assert.deepEqual(scrolls(r.log), ['scroll up']);
  const [band] = r.bands;
  assert.ok(band, 'the drag names its band');
  assert.equal(band.y, CLIP_TOP);
  // The band ends above the hidden view, and the witness lies wholly inside it.
  assert.ok(band.y + band.height <= LOWER_HALF.y, JSON.stringify(band));
  assert.ok(371.33333587646484 + 90 <= band.y + band.height, JSON.stringify(band));
  assert.equal(presses(r.log).length, 2);
});

// A full-screen wrapper beside the nine views, appended last in the window, holding one child whose
// frame lies outside the band, above the list.
const ABOVE_BAND: Rect = { x: 14, y: 120, width: 374, height: 44 };
const wrapper =
  (child: 'Button' | 'Other') =>
  (a: JoinArgs): void => {
    const index = addNode(1, { type: 'Other', rect: { x: 0, y: 0, width: 402, height: 874 } })(a);
    addNode(index, {
      type: child,
      rect: ABOVE_BAND,
      ...(child === 'Button' ? { label: 'Add' } : {}),
    })(a);
  };

for (const [row, child] of [
  ['G7b', 'Button'],
  ['G7c', 'Other'],
] as const)
  test(`${row}: a wrapper holding ${child === 'Button' ? 'a button' : 'an empty view'} outside the band is solid: no hit read, today's refusal`, async () => {
    const r = await walk({
      ordinary: () => unnamedCards('ordinary', named('ordinary')),
      presence: () => unnamedCards('presence', named('presence', wrapper(child))),
    });
    assert.equal(r.result.verdict, 'FAIL');
    assert.deepEqual(r.hits, []);
    assert.deepEqual(scrolls(r.log), []);
    assert.equal(presses(r.log).length, 2, r.log.join(','));
    assert.match(r.reason, NO_FREE_PART);
  });

// The target as an input for a Fill, in both reads.
const asInput =
  (read: UnnamedCardsRead) =>
  (a: JoinArgs): void => {
    a.nodes[CARDS[read].cards[1]].type = 'TextField';
  };
const LIST_CLIP: Rect = { x: 0, y: CLIP_TOP, width: 402, height: 649.3333333333333 };

const refOf = (screen: Screen, id: string) => screen.elements.find((e) => e.testID === id)!.ref;

for (const kind of ['press', 'fill'] as const)
  test(`G3: a covered ${kind === 'press' ? 'Tap' : 'Fill'} on the real reads: one witness read, one drag inside the list, pass`, async () => {
    const extra = (read: UnnamedCardsRead) => (kind === 'fill' ? [asInput(read)] : []);
    const ordinary = () => unnamedCards('ordinary', named('ordinary', ...extra('ordinary')));
    const presence = () => unnamedCards('presence', named('presence', ...extra('presence')));
    const r = await walk({ kind, ordinary, presence });
    assert.equal(r.result.verdict, 'PASS', r.reason);
    const target = refOf(ordinary(), TARGET);
    const witness = refOf(presence(), WITNESS);
    // The refusal, one presence read, one witness read, one drag, then the second dispatch.
    assert.deepEqual(r.log.slice(0, 5), [
      'capture',
      `${kind} ${target}`,
      'presence',
      `hit ${witness}`,
      'scroll up',
    ]);
    assert.equal(r.log.filter((entry) => entry === 'presence').length, 1);
    assert.deepEqual(r.hits, [witness]);
    assert.deepEqual(presses(r.log), [`${kind} ${target}`, `${kind} ${target}`]);
    assert.deepEqual(r.bands, [LIST_CLIP]);
    // Proven by the witness, not by the touch reaching the target.
    assert.deepEqual(r.row?.groundProof, { status: 'proven', ref: witness, kind: 'button' });
  });

const covered = { ordinary: () => unnamedCards('ordinary', named('ordinary')) };
const presenceWith =
  (...more: ((a: JoinArgs) => unknown)[]) =>
  () =>
    unnamedCards('presence', named('presence', ...more));

for (const [answer, proof] of [
  ['not-hittable', { status: 'witness-not-hittable', count: 1 }],
  ['moved', { status: 'witness-unavailable' }],
  ['unavailable', { status: 'witness-unavailable' }],
] as const)
  test(`G4: a witness read answering ${answer} proves nothing: no drag, today's refusal`, async () => {
    const r = await walk({ ...covered, presence: presenceWith(), hit: () => answer });
    assert.equal(r.result.verdict, 'FAIL');
    assert.equal(r.hits.length, 1);
    assert.deepEqual(scrolls(r.log), []);
    assert.match(r.reason, NO_FREE_PART);
    assert.deepEqual(r.row?.groundProof, proof);
  });

test('G4: a hittable answer that arrives after the observation expired proves nothing', async () => {
  const r = await walk({
    ...covered,
    presence: presenceWith(),
    hit: (_ref, clock) => {
      clock.ms += 10_001;
      return 'hittable';
    },
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(scrolls(r.log), []);
  assert.deepEqual(r.row?.groundProof, { status: 'witness-unavailable' });
});

test('G4: without a hit probe nothing is proven', async () => {
  const r = await walk({
    ...covered,
    presence: presenceWith(),
    setup: (deps) => delete deps.hitProbe,
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
  assert.match(r.reason, NO_FREE_PART);
  assert.deepEqual(r.row?.groundProof, { status: 'witness-unavailable' });
});

test('G4: on Android no witness is read and no proof is recorded', async () => {
  const r = await walk({ ...covered, presence: presenceWith(), platform: 'android' });
  assert.deepEqual(r.hits, []);
  assert.equal(r.row?.groundProof, undefined);
});

test("G5: the real reads as saved hold no named element in the band: no witness, today's refusal", async () => {
  // Only the target is named, in its native node: card 3, the one card wholly in the list's clip.
  const target = (read: UnnamedCardsRead) => (a: JoinArgs) => {
    a.nodes[CARDS[read].cards[2]].identifier = TARGET;
  };
  const r = await walk({
    ordinary: () => unnamedCards('ordinary', target('ordinary')),
    presence: () => unnamedCards('presence', target('presence')),
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
  assert.match(r.reason, NO_FREE_PART);
  assert.deepEqual(r.row?.groundProof, { status: 'no-witness' });
});

test("G7: a text under one of the empty views keeps that layer solid: no hit read, today's refusal", async () => {
  // A text inside the second window's innermost empty view, over the list.
  const text = addNode(52, {
    type: 'StaticText',
    label: 'Saved',
    rect: { x: 14, y: 600, width: 374, height: 21 },
  });
  const r = await walk({ ...covered, presence: presenceWith(text) });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
  assert.match(r.reason, NO_FREE_PART);
  assert.equal(r.row?.groundProof?.status, 'band-too-small');
});

test('G7: an empty view over half the band listed before the list is solid: no hit read', async () => {
  const half = insertNode(28, 21, { type: 'Other', rect: LOWER_HALF });
  const r = await walk({ ...covered, presence: presenceWith(half) });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
  assert.match(r.reason, NO_FREE_PART);
  assert.deepEqual(r.row?.groundProof, {
    status: 'solid-view',
    ref: '@e28',
    kind: 'other',
    frame: LOWER_HALF,
  });
});

test('G8: plain layers in a second window listed before the list are left out only with a hittable witness', async () => {
  const before = edits(
    insertNode(1, 0, { type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } }),
    insertNode(2, 1, { type: 'Other', rect: { x: 0, y: 0, width: 402, height: 874 } }),
  );
  for (const [answer, verdict] of [
    ['hittable', 'PASS'],
    ['not-hittable', 'FAIL'],
  ] as const) {
    const r = await walk({ ...covered, presence: presenceWith(before), hit: () => answer });
    assert.equal(r.result.verdict, verdict, r.reason);
    assert.equal(r.hits.length, 1);
    assert.deepEqual(scrolls(r.log), answer === 'hittable' ? ['scroll up'] : []);
  }
});

test("G9: Scroll until on the real presence read keeps today's band and makes no hit read", async () => {
  const screen = presenceWith()();
  const missing = { quoted: 'qa-ground-missing', phrase: 'qa-ground-missing' };
  // The target-miss path reads the same function, unchanged without a leave-out set.
  assert.equal(scrollUntilBand(missing, screen)?.height, 0);
  const r = await walk({
    ordinary: presenceWith(),
    presence: presenceWith(),
    step: '1. Scroll down until "qa-ground-missing"',
  });
  assert.deepEqual(r.hits, []);
  assert.ok(r.bands.length > 0);
  for (const band of r.bands) assert.deepEqual(band, scrollUntilBand(missing, screen));
  assert.equal(r.row?.groundProof, undefined);
});

test('G9: Wait on the real presence read makes no hit read', async () => {
  const r = await walk({
    ordinary: presenceWith(),
    presence: presenceWith(),
    step: '1. Wait for "qa-ground-missing"',
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
});

test('G9: with the keyboard shown no witness is read', async () => {
  const keyboard = (screen: Screen): Screen => ({
    ...screen,
    keyboardVisible: true,
    keyboardFrame: { x: 0, y: 700, width: 402, height: 174 },
  });
  const r = await walk({
    ordinary: () => keyboard(covered.ordinary()),
    presence: () => keyboard(presenceWith()()),
  });
  assert.deepEqual(r.hits, []);
  assert.notEqual(r.row?.groundProof?.status, 'proven');
});

test('G11: a witness under a solid bar is not used', async () => {
  // A bar over the witness card: the cut band ends above it, and nothing named lies in what is left.
  const bar = addNode(21, { type: 'Other', rect: { x: 0, y: 365, width: 402, height: 509 } });
  const r = await walk({ ...covered, presence: presenceWith(bar) });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(scrolls(r.log), []);
  assert.deepEqual(r.row?.groundProof, { status: 'no-witness' });
});

// Four more named rows in the band, nearer its centre than the witness card.
const ROWS = [480, 530, 580, 630];
const rows = (a: JoinArgs) => {
  for (const [i, y] of ROWS.entries())
    addNode(CARDS.presence.content, {
      type: 'Button',
      identifier: `qa-ground-row-${i}`,
      rect: { x: 14, y, width: 374, height: 40 },
    })(a);
};

test("G12: at most four witness reads, nearest the band's centre first", async () => {
  const r = await walk({ ...covered, presence: presenceWith(rows), hit: () => 'not-hittable' });
  const screen = presenceWith(rows)();
  assert.deepEqual(
    r.hits,
    ['qa-ground-row-1', 'qa-ground-row-0', 'qa-ground-row-2', 'qa-ground-row-3'].map((id) =>
      refOf(screen, id),
    ),
  );
  assert.deepEqual(r.row?.groundProof, { status: 'witness-not-hittable', count: 4 });
  assert.deepEqual(scrolls(r.log), []);
});

test('G12: no read after the first hittable answer', async () => {
  let answers = 0;
  const r = await walk({
    ...covered,
    presence: presenceWith(rows),
    hit: () => (answers++ === 0 ? 'not-hittable' : 'hittable'),
  });
  assert.equal(r.result.verdict, 'PASS', r.reason);
  assert.equal(r.hits.length, 2);
  assert.equal(r.row?.groundProof?.status, 'proven');
});

test('G12: no read starts with less than 300 ms of the observation left', async () => {
  const r = await walk({
    ...covered,
    presence: presenceWith(rows),
    hit: (_ref, clock) => {
      clock.ms += 9_750;
      return 'not-hittable';
    },
  });
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.row?.groundProof, { status: 'witness-not-hittable', count: 1 });
});

// A list whose far row React lays out below the fold, with no native element yet; one empty view over
// the whole screen, listed after the list; one named native row in the list. After the drag the far row
// has its native element.
const WINDOW: Rect = { x: 0, y: 0, width: 402, height: 874 };
const SCROLL: Rect = { x: 0, y: 100, width: 402, height: 900 };
function farRow(presence: boolean, scrolled: boolean): Screen {
  const nodes: NativeNode[] = [
    { ref: '@w', index: 0, type: 'Window', rect: WINDOW },
    {
      ref: '@s',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'list-scroll',
      rect: SCROLL,
    },
    {
      ref: '@row',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      identifier: WITNESS,
      hittable: true,
      rect: { x: 16, y: 200, width: 370, height: 44 },
    },
    { ref: '@layer', index: 3, parentIndex: 0, type: 'Other', hittable: true, rect: WINDOW },
  ];
  if (scrolled)
    nodes.push({
      ref: '@far',
      index: 4,
      parentIndex: 1,
      type: 'Button',
      identifier: 'far-btn',
      label: 'Far row',
      hittable: true,
      rect: { x: 16, y: 300, width: 370, height: 44 },
    });
  const host: ReactHostEvidence = {
    complete: true,
    hosts: [
      { testID: 'list-scroll', role: null, roleSource: 'none', capabilities: {} },
      { testID: 'far-btn', role: 'button', roleSource: 'role', capabilities: { press: true } },
    ],
    ...(presence
      ? {
          typography: {
            version: 1,
            complete: true,
            durationMs: 5,
            coordinateSpace: 'window-points',
            nodes: [
              {
                hostIndex: 0,
                parentHostIndex: null,
                rootIndex: 0,
                hostType: 'RCTScrollView',
                rect: SCROLL,
                text: { kind: 'none' },
              },
              {
                hostIndex: 1,
                parentHostIndex: 0,
                rootIndex: 0,
                hostType: 'RCTView',
                rect: { x: 16, y: scrolled ? 300 : 900, width: 370, height: 44 },
                text: { kind: 'none' },
              },
            ],
          },
        }
      : {}),
  };
  const digest: DigestEntry[] = [
    {
      role: 'button',
      testID: 'far-btn',
      label: 'Far row',
      capabilities: { press: true, fill: false },
    },
  ];
  return {
    ...join(
      nodes,
      digest,
      'app',
      { native: 'complete', react: 'complete' },
      host,
      presence
        ? {
            source: 'xcui-live',
            nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
          }
        : undefined,
    ),
    keyboardVisible: false,
    nativeGeneration: 7,
  };
}

test('G10: a target known only to React, under an empty full-screen view: one witness read, one drag inside the list', async () => {
  const r = await walk({
    step: '1. Tap "far-btn"',
    ordinary: (dragged) => farRow(false, dragged),
    presence: (dragged) => farRow(true, dragged),
  });
  assert.equal(r.result.verdict, 'PASS', r.reason);
  assert.deepEqual(r.hits, ['@row']);
  assert.deepEqual(scrolls(r.log), ['scroll down']);
  assert.deepEqual(r.bands, [{ x: 0, y: 100, width: 402, height: 774 }]);
  assert.deepEqual(r.row?.groundProof, { status: 'proven', ref: '@row', kind: 'button' });
});

test("G10: the same target with the witness not hittable keeps today's refusal", async () => {
  const r = await walk({
    step: '1. Tap "far-btn"',
    ordinary: (dragged) => farRow(false, dragged),
    presence: (dragged) => farRow(true, dragged),
    hit: () => 'not-hittable',
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(scrolls(r.log), []);
  assert.match(
    r.reason,
    /no part of its scroll area is free of what lies in front, so nothing was scrolled/,
  );
  assert.deepEqual(r.row?.groundProof, { status: 'witness-not-hittable', count: 1 });
});
