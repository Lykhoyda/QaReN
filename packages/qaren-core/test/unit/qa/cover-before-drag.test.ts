// AI-474 slice 3: after the iOS runner refuses a press or fill as covered, the walker proves the cover
// first and drags only on a free part of the target's own list; otherwise it keeps the one retry and
// refuses naming the cover, with no drag of any origin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { captureScreen, CaptureDeadline } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import {
  centreCovered,
  clearanceBand,
  coverOwner,
  scrollUntilBand,
  scrollUntilContainer,
} from '../../../dist/qa/resolve.js';
import { ancestorsOf, isScrollContainer, join } from '../../../dist/qa/screen.js';
import type { NativeNode, ReactHostEvidence, Screen } from '../../../dist/qa/screen.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = NonNullable<NativeNode['rect']>;
type PointerEvents = 'auto' | 'none' | 'box-none' | 'box-only';
interface View {
  id: string;
  type: string;
  rect: Rect;
  // Index of the parent view in the list; absent is the window.
  parent?: number;
  pointerEvents?: PointerEvents;
  label?: string;
}

const FULL: Rect = { x: 0, y: 0, width: 402, height: 874 };
const LIST: Rect = { x: 0, y: 100, width: 402, height: 700 };
const IN_LIST: Rect = { x: 21, y: 700, width: 360, height: 48 };
// Narrower than half the list: the list-order band cutter ignores it, so the press is dispatched.
const BAR: Rect = { x: 100, y: 690, width: 200, height: 110 };
const SHEET: Rect = { x: 0, y: 437, width: 402, height: 437 };
const ON_SCREEN: Rect = { x: 24, y: 706, width: 354, height: 48 };

const OCCLUDED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error: 'FOCUS_TARGET_OCCLUDED: the focus or tap point is covered by another element',
};

// `parent` null puts the target straight in the window, in no scroll area.
const target = (type = 'Button', rect = IN_LIST, parent: number | null = 0): View => ({
  id: 'go',
  type,
  rect,
  parent: parent ?? undefined,
  label: 'Go',
});
const list = (): View => ({ id: '', type: 'ScrollView', rect: LIST });
// A target in its own list, a fixed bar over it at the list's lower edge, free room above.
const barred = (bar: Partial<View> = {}): View[] => [
  list(),
  target(),
  { id: 'qa-bar', type: 'Other', rect: BAR, ...bar },
];
// A target in no scroll area, and a sheet the app draws over it.
const sheeted = (sheet: Partial<View> = {}): View[] => [
  target('Button', ON_SCREEN, null),
  { id: 'qa-sheet', type: 'Other', rect: SHEET, ...sheet },
];

interface CaptureOptions {
  presence?: boolean;
  hosts?: boolean;
  typography?: boolean;
  keyboard?: boolean | 'unknown';
}

// A capture of these views through production capture and join: native nodes follow the React nesting.
async function capture(views: View[], options: CaptureOptions = {}): Promise<Screen> {
  const { presence = true, hosts = true, typography = true, keyboard = false } = options;
  const base = nativeCapture() as ReturnType<typeof nativeCapture> & { keyboardVisible?: boolean };
  const nodePresence = (index: number) => ({ ...base.nodes[1].presence, nodeIndex: index });
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
      presence: nodePresence(1),
    },
  ];
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
      presence: nodePresence(i + 2),
    });
  });
  if (!presence) for (const node of nodes) delete node.presence;
  base.nodes = nodes as typeof base.nodes;
  base.snapshotVerdict.nodeCount = nodes.length;
  if (keyboard === 'unknown') delete base.keyboardVisible;
  else base.keyboardVisible = keyboard;
  const evidence: ReactHostEvidence = {
    complete: true,
    // The screen root takes no touch itself, so a touch that no view takes is owned by nothing.
    hosts: [{ role: null, roleSource: 'none', capabilities: {}, pointerEvents: 'box-none' }],
    typography: {
      version: 1,
      complete: typography,
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
      capabilities:
        view.type === 'Button' ? { press: true } : view.type === 'TextField' ? { fill: true } : {},
      ...(view.pointerEvents ? { pointerEvents: view.pointerEvents } : {}),
      order: rank,
    });
    evidence.typography!.nodes.push({
      hostIndex: i + 1,
      parentHostIndex: parent,
      rootIndex: 0,
      hostType: view.type === 'TextField' ? 'RCTSinglelineTextInputView' : 'RCTView',
      rect: view.rect,
      text: { kind: 'none' },
    });
  });
  if (!presence) delete evidence.typography;
  const screen = await captureScreen({
    appId: 'com.test',
    native: async () => (presence ? base : { ...base, presenceCapture: undefined }),
    react: async () => ({
      interactive: [],
      ...(hosts ? { hostEvidence: evidence } : {}),
      verdict: { state: 'ok', path: 'interactive', complete: hosts },
    }),
  });
  screen.nativeGeneration = 7;
  return screen;
}

const byId = (screen: Screen, id: string) => screen.elements.find((e) => e.testID === id)!;
const targetOf = { quoted: 'go', phrase: 'go' };
const ownList = (screen: Screen) => ancestorsOf(byId(screen, 'go')).find(isScrollContainer);

interface PresenceRead {
  hosts?: boolean;
  typography?: boolean;
  // The covering views' testIDs are missing, so their hosts cannot be tied to native nodes.
  anonymous?: boolean;
}

interface Scenario {
  // `views` answers every read until the first refusal is proven; `retry` answers the later reads.
  views: View[];
  proofViews?: View[];
  retry?: View[] | ((dispatched: number, read: number) => View[]);
  kind?: 'press' | 'fill';
  step?: string;
  platform?: WalkerDeps['platform'] | 'unset';
  keyboard?: boolean | 'unknown';
  retryKeyboard?: boolean;
  // How each presence read answers: a screen, a deadline, or incomplete native coverage.
  presenceRead?: 'late' | 'incomplete' | PresenceRead;
  // Every read carries native presence, so the first refusal already records its gap.
  presenceEverywhere?: PresenceRead;
  dispatches?: ActResult[];
  setup?: (deps: WalkerDeps) => void;
  edit?: (screen: Screen) => void;
}

const anonymize = (views: View[]) =>
  views.map((v) => (v.id.startsWith('qa-') ? { ...v, id: '' } : v));

async function walk(s: Scenario) {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('exact targets are model-free')),
  );
  if (s.platform !== 'unset') w.deps.platform = s.platform ?? 'ios';
  const log: string[] = [];
  const bands: (Rect | undefined)[] = [];
  let dispatched = 0;
  let retryReads = 0;
  const viewsNow = (presence: boolean) => {
    if (presence && dispatched === 1 && s.proofViews) return s.proofViews;
    // The proof of the first refusal reads the screen that refused it.
    if (!s.retry || dispatched === 0 || (presence && dispatched === 1)) return s.views;
    retryReads += 1;
    return typeof s.retry === 'function' ? s.retry(dispatched, retryReads) : s.retry;
  };
  w.deps.captureScreen = async (request) => {
    const presence = request?.platformPresence === true;
    log.push(presence ? 'presence' : 'capture');
    const keyboard =
      dispatched && s.retry ? (s.retryKeyboard ?? s.keyboard ?? false) : (s.keyboard ?? false);
    if (presence && s.presenceRead === 'late') throw new CaptureDeadline();
    const views = viewsNow(presence);
    if (s.presenceEverywhere)
      return capture(s.presenceEverywhere.anonymous ? anonymize(views) : views, {
        ...s.presenceEverywhere,
        keyboard,
        presence: true,
      });
    const read = presence && typeof s.presenceRead === 'object' ? s.presenceRead : {};
    const screen = await capture(read.anonymous ? anonymize(views) : views, {
      ...read,
      keyboard,
      presence,
    });
    if (presence && s.presenceRead === 'incomplete') {
      screen.coverage = { ...screen.coverage!, native: 'incomplete' };
      screen.captureCoverage = {
        ...(screen.captureCoverage ?? screen.coverage),
        native: 'incomplete',
      };
    }
    s.edit?.(screen);
    return screen;
  };
  const results = [...(s.dispatches ?? [])];
  const dispatch =
    (name: string) =>
    async (ref: string, ...rest: unknown[]) => {
      const live = rest.some(
        (arg) => typeof arg === 'object' && arg !== null && 'requireLiveHit' in arg,
      );
      log.push(`${name} ${ref}${live ? ' live' : ''}`);
      dispatched += 1;
      return results.shift() ?? OCCLUDED;
    };
  w.deps.press = dispatch('press') as WalkerDeps['press'];
  w.deps.fill = dispatch('fill') as WalkerDeps['fill'];
  w.deps.scroll = async (direction, _context, _distance, band) => {
    log.push(`scroll ${direction}`);
    bands.push(band);
    return { ok: true, proven: false, executed: true };
  };
  s.setup?.(w.deps);
  const step = s.step ?? (s.kind === 'fill' ? '1. Fill "go" with "x"' : '1. Tap "go"');
  const result = await runPlan(parsePlan(step).blocks!, w.deps);
  const reason = renderReason(result.failure?.seen ?? '', (text) => text);
  const acts = log.filter((entry) => !entry.startsWith('capture') && entry !== 'presence');
  return { result, reason, log, acts, bands, rows: w.rows };
}

const scrolls = (acts: string[]) => acts.filter((a) => a.startsWith('scroll'));
const dispatches = (acts: string[]) =>
  acts.filter((a) => a.startsWith('press') || a.startsWith('fill'));

// T1: row S4, rebuilt through join() from the device's join inputs, as capture.ts builds them.
function s4(name: string): Screen {
  const a = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-drawn-sheet/${name}.json`, import.meta.url), 'utf8'),
  );
  return {
    ...join(
      a.nodes,
      a.digest,
      a.front,
      a.coverage,
      a.reactHostEvidence,
      a.nativePresence,
      a.nativeAcquisition,
    ),
    // Beside the join, the capture keeps its acquisition verdict, the keyboard state and the generation.
    captureCoverage: { native: a.nativeAcquisition, react: a.coverage.react },
    keyboardVisible: false,
    nativeGeneration: 7,
  };
}

const SCREEN_CONFIRM = 'qa-drawn-sheet-screen-confirm';
const SHEET_CONFIRM = 'qa-drawn-sheet-sheet-confirm';

test('T1: the real S4 presence read names the drawn sheet as the screen Confirm cover', () => {
  const screen = s4('S4-line13-obs30-platform-presence');
  const cover = coverOwner(byId(screen, SCREEN_CONFIRM), screen);
  assert.ok('owner' in cover, JSON.stringify(cover));
  assert.equal(cover.owner.testID, 'qa-drawn-sheet');
  assert.deepEqual(cover.frame, { x: 0, y: 437, width: 402, height: 437 });
});

test('T1: a covered tap under the real drawn sheet is pressed twice and never dragged', async () => {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted tap is model-free')),
  );
  w.deps.platform = 'ios';
  w.deps.captureScreen = async (request) =>
    s4(
      request?.platformPresence ? 'S4-line13-obs30-platform-presence' : 'S4-line13-obs29-ordinary',
    );
  w.deps.press = async (ref) => {
    w.actions.push(`press ${ref}`);
    return OCCLUDED;
  };
  w.deps.scroll = async (direction) => {
    w.actions.push(`scroll ${direction}`);
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(parsePlan(`1. Tap "${SCREEN_CONFIRM}"`).blocks!, w.deps);
  const reason = renderReason(result.failure?.seen ?? '', (text) => text);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(scrolls(w.actions), [], `actions: ${w.actions.join(', ')}`);
  assert.equal(dispatches(w.actions).length, 2, `actions: ${w.actions.join(', ')}`);
  assert.match(reason, /^FOCUS_TARGET_OCCLUDED: /);
  assert.match(reason, /"qa-drawn-sheet-screen-confirm" stayed covered; /);
  assert.match(reason, /nothing was scrolled/);
  assert.match(reason, /covered by other at 0,437,402,437/);
  assert.doesNotMatch(reason, /after one scroll/);
  // The receipt keeps the base's subreason: the target is there, but cannot be used.
  assert.equal(result.failure?.subreason, 'present-but-unavailable');
});

test('T7: same label from the real S2 read: the live hit read sets the covered Confirm aside', async () => {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted tap is model-free')),
  );
  w.deps.platform = 'ios';
  const screen = () => s4('S2-line13-obs28-ordinary');
  w.deps.captureScreen = async () => screen();
  const covered = byId(screen(), SCREEN_CONFIRM).ref;
  w.deps.hitProbe = async (ref) => (ref === covered ? 'not-hittable' : 'hittable');
  const result = await runPlan(parsePlan('1. Tap "Confirm"').blocks!, w.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.deepEqual(w.actions, [`press ${byId(screen(), SHEET_CONFIRM).ref}`]);
  const row = w.rows.filter((r) => r.line === 1).at(-1);
  assert.deepEqual(
    row?.candidateExclusions?.map((exclusion) => [exclusion.ref, exclusion.reason]),
    [[covered, 'not-hittable']],
  );
});

for (const kind of ['press', 'fill'] as const) {
  const type = kind === 'press' ? 'Button' : 'TextField';
  const typed = (views: View[]) => views.map((v) => (v.id === 'go' ? { ...v, type } : v));
  const cleared = typed([
    list(),
    target(type, { ...IN_LIST, y: 300 }),
    { id: 'qa-bar', type: 'Other', rect: BAR },
  ]);

  test(`T2: a named bar at the list's edge with free room above: one drag in the free band (${kind})`, async () => {
    const ordinary = await capture(typed(barred()), { presence: false });
    const go = byId(ordinary, 'go');
    // The press is the runner's refusal, not the pre-dispatch cover test.
    assert.equal(centreCovered(go, ordinary), false);
    const presence = await capture(typed(barred()));
    const cover = coverOwner(byId(presence, 'go'), presence);
    assert.equal('owner' in cover && cover.owner.testID, 'qa-bar', JSON.stringify(cover));
    const band = scrollUntilBand(targetOf, ordinary)!;
    assert.ok(band.height > 0 && band.y + band.height <= BAR.y);
    const r = await walk({
      views: typed(barred()),
      retry: cleared,
      kind,
      dispatches: [OCCLUDED, { ok: true, proven: true }],
    });
    assert.equal(r.result.verdict, 'PASS', r.reason);
    assert.deepEqual(scrolls(r.acts), ['scroll down']);
    assert.deepEqual(r.bands, [band]);
    assert.equal(dispatches(r.acts).length, 2);
    // The cover is proven before the drag.
    assert.ok(r.log.indexOf('presence') < r.log.indexOf('scroll down'), r.log.join(','));
  });

  test(`T8: after an allowed drag a second refusal keeps today's text (${kind})`, async () => {
    const r = await walk({ views: typed(barred()), kind });
    assert.equal(r.result.verdict, 'FAIL');
    assert.equal(scrolls(r.acts).length, 1);
    assert.equal(dispatches(r.acts).length, 2);
    assert.match(
      r.reason,
      /"go" stayed off screen after one scroll; covered by other at 100,690,200,110/,
    );
  });

  test(`proof geometry: a shrinking list bounds the drag (${kind})`, async () => {
    const r = await walk({
      views: typed(barred()),
      proofViews: typed([{ ...list(), rect: { ...LIST, height: 300 } }, ...barred().slice(1)]),
      retry: cleared,
      kind,
      dispatches: [OCCLUDED, { ok: true, proven: true }],
    });
    assert.equal(r.result.verdict, 'PASS', r.reason);
    assert.deepEqual(scrolls(r.acts), ['scroll down']);
    const band = r.bands[0]!;
    assert.ok(band.y >= 100 && band.y + band.height <= 400, JSON.stringify(band));
  });

  test(`proof geometry: a moved target changes the drag direction (${kind})`, async () => {
    const r = await walk({
      views: typed(barred()),
      proofViews: typed([
        list(),
        target(type, { ...IN_LIST, y: 150 }),
        { id: 'qa-bar', type: 'Other', rect: { ...BAR, y: 140, height: 60 } },
      ]),
      retry: cleared,
      kind,
      dispatches: [OCCLUDED, { ok: true, proven: true }],
    });
    assert.equal(r.result.verdict, 'PASS', r.reason);
    assert.deepEqual(scrolls(r.acts), ['scroll up']);
    assert.ok(r.bands[0]!.y >= 200, JSON.stringify(r.bands));
  });

  for (const [name, proofViews] of [
    ['target missing', [list(), { id: 'qa-bar', type: 'Other', rect: BAR }]],
    ['target no longer in a list', [list(), target(type, IN_LIST, null), ...barred().slice(2)]],
    [
      'new foreign view behind the list',
      [
        { id: 'qa-backdrop', type: 'Other', rect: FULL },
        list(),
        target(type, IN_LIST, 1),
        ...barred().slice(2),
      ],
    ],
  ] as const) {
    test(`proof geometry: ${name} withholds the drag (${kind})`, async () => {
      const r = await walk({ views: typed(barred()), proofViews: typed([...proofViews]), kind });
      assert.equal(r.result.verdict, 'FAIL');
      assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
      assert.equal(dispatches(r.acts).length, 2, r.log.join(','));
    });
  }

  for (const [name, views, text, precondition] of [
    [
      'a named sheet over a target in no scroll area',
      sheeted(),
      'it is in no scroll area',
      (s: Screen) => assert.equal(ownList(s), undefined),
    ],
    [
      'a list that is not the scroll-until list of the target',
      [
        list(),
        target(),
        { id: 'qa-bar', type: 'Other', rect: BAR },
        { id: '', type: 'ScrollView', rect: { x: 0, y: 820, width: 402, height: 40 } },
        // An off-screen twin of the name: never a press candidate, still a scroll-until match.
        {
          id: '',
          type: 'StaticText',
          label: 'go',
          rect: { x: 0, y: 900, width: 60, height: 20 },
          parent: 3,
        },
      ],
      'it is in no scroll area',
      (s: Screen) => {
        assert.ok(ownList(s));
        assert.notEqual(scrollUntilContainer(targetOf, s), ownList(s));
      },
    ],
    [
      'a front view that leaves no part of the list free',
      [
        list(),
        target(),
        { id: 'qa-over', type: 'Other', rect: { x: 100, y: 90, width: 200, height: 720 } },
      ],
      'no part of its scroll area is free of what lies in front or behind',
      (s: Screen) => assert.ok(!(scrollUntilBand(targetOf, s)?.height ?? 0)),
    ],
    [
      'a touchable full-screen backdrop listed before the list, a named sheet over the target',
      [
        { id: 'qa-backdrop', type: 'Other', rect: FULL },
        { ...list(), id: '' },
        target('Button', IN_LIST, 1),
        { id: 'qa-sheet', type: 'Other', rect: { x: 100, y: 600, width: 200, height: 200 } },
      ],
      'no part of its scroll area is free of what lies in front or behind',
      (s: Screen) => {
        const band = scrollUntilBand(targetOf, s);
        assert.ok(band && band.height > 0 && band.y + band.height <= 600, JSON.stringify(band));
      },
    ],
    [
      'a band that overlaps the named cover',
      [
        list(),
        target(),
        {
          id: 'qa-sticky',
          type: 'Other',
          rect: { x: 0, y: 690, width: 402, height: 70 },
          parent: 0,
        },
      ],
      'no part of its scroll area is free of what lies in front or behind',
      (s: Screen) => {
        const band = scrollUntilBand(targetOf, s);
        assert.ok(band && band.y + band.height > 690, JSON.stringify(band));
      },
    ],
  ] as const) {
    test(`T3: ${name}: no drag, two dispatches, the reason (${kind})`, async () => {
      const ordinary = await capture(typed([...views]), { presence: false });
      assert.equal(centreCovered(byId(ordinary, 'go'), ordinary), false);
      precondition(ordinary);
      const presence = await capture(typed([...views]));
      assert.ok('owner' in coverOwner(byId(presence, 'go'), presence));
      const r = await walk({ views: typed([...views]), kind });
      assert.equal(r.result.verdict, 'FAIL');
      assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
      assert.equal(dispatches(r.acts).length, 2, r.log.join(','));
      assert.match(r.reason, /^FOCUS_TARGET_OCCLUDED: /);
      assert.ok(
        r.reason.includes(
          `"go" stayed covered; ${text}, so nothing was scrolled; covered by other at `,
        ),
        r.reason,
      );
      assert.doesNotMatch(r.reason, /after (one|a) scroll/);
    });
  }

  for (const read of ['late', 'incomplete'] as const) {
    test(`T4: a ${read} presence read withholds the drag although the older read shows a free band (${kind})`, async () => {
      const ordinary = await capture(typed(barred()), { presence: false });
      assert.ok(scrollUntilBand(targetOf, ordinary)!.height > 0);
      const r = await walk({ views: typed(barred()), kind, presenceRead: read });
      assert.equal(r.result.verdict, 'FAIL');
      assert.deepEqual(scrolls(r.acts), []);
      assert.equal(dispatches(r.acts).length, 2);
      assert.ok(
        r.reason.includes(
          '"go" stayed covered; the read that would name what covers it was late or incomplete, so nothing was scrolled; no cover named (presence-recapture-incomplete)',
        ),
        r.reason,
      );
    });
  }

  for (const [gap, presenceRead] of [
    ['react-evidence-incomplete', { hosts: false }],
    ['typography-incomplete', { typography: false }],
    ['unassociated-host', { anonymous: true }],
  ] as const) {
    test(`T4: gap ${gap} and no scroll area: no drag, the no-scroll-area reason (${kind})`, async () => {
      const r = await walk({ views: typed(sheeted()), kind, presenceRead });
      assert.equal(r.result.verdict, 'FAIL');
      assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
      assert.equal(dispatches(r.acts).length, 2);
      assert.ok(
        r.reason.includes(
          `"go" stayed covered; it is in no scroll area, so nothing was scrolled; no cover named (${gap})`,
        ),
        r.reason,
      );
    });

    test(`T4: gap ${gap} with a free band in its own list: one drag in that band (${kind})`, async () => {
      const views = typed(barred());
      const ordinary = await capture(views, { presence: false });
      const band = scrollUntilBand(targetOf, ordinary)!;
      assert.notDeepEqual(band, clearanceBand(byId(ordinary, 'go'), ordinary));
      const r = await walk({ views, kind, presenceRead });
      assert.deepEqual(scrolls(r.acts), ['scroll down'], r.log.join(','));
      assert.deepEqual(r.bands, [band]);
    });
  }

  test(`T4: a gap recorded before the proof: no presence read, no drag, the no-scroll-area reason (${kind})`, async () => {
    const r = await walk({ views: typed(sheeted()), kind, presenceEverywhere: { hosts: false } });
    assert.equal(r.log.filter((entry) => entry === 'presence').length, 0);
    assert.deepEqual(scrolls(r.acts), []);
    assert.equal(dispatches(r.acts).length, 2);
    assert.ok(
      r.reason.includes(
        '"go" stayed covered; it is in no scroll area, so nothing was scrolled; no cover named (react-evidence-incomplete)',
      ),
      r.reason,
    );
  });

  for (const [gap, views] of [
    ['reaches-target', barred({ pointerEvents: 'none' })],
    [
      'none',
      [
        { ...list(), pointerEvents: 'box-none' as const },
        { ...target(), pointerEvents: 'none' as const },
        { id: 'qa-bar', type: 'Other', rect: BAR, pointerEvents: 'none' as const },
      ],
    ],
  ] as const) {
    test(`T5: a complete read whose gap is ${gap}: today's one drag in today's band (${kind})`, async () => {
      const presence = await capture(typed([...views]));
      assert.deepEqual(coverOwner(byId(presence, 'go'), presence), { gap });
      const ordinary = await capture(typed([...views]), { presence: false });
      const r = await walk({ views: typed([...views]), kind });
      assert.deepEqual(scrolls(r.acts), ['scroll down'], r.log.join(','));
      assert.deepEqual(r.bands, [clearanceBand(byId(ordinary, 'go'), ordinary)]);
      assert.equal(dispatches(r.acts).length, 2);
    });
  }

  for (const [name, scenario] of [
    ['the keyboard visible', { keyboard: true }],
    ['the keyboard state unknown', { keyboard: 'unknown' }],
    ['android', { platform: 'android' }],
    ['no platform', { platform: 'unset' }],
  ] as const) {
    test(`T6: ${name}: today's commands and capture modes (${kind})`, async () => {
      const views = typed(sheeted());
      const ordinary = await capture(views, { presence: false });
      const r = await walk({ views, kind, ...(scenario as Partial<Scenario>) });
      assert.deepEqual(scrolls(r.acts), ['scroll down'], r.log.join(','));
      assert.deepEqual(r.bands, [clearanceBand(byId(ordinary, 'go'), ordinary)]);
      assert.equal(dispatches(r.acts).length, 2);
      // No presence read is added before the drag.
      const drag = r.log.indexOf('scroll down');
      assert.ok(!r.log.slice(0, drag).includes('presence'), r.log.join(','));
      assert.match(r.reason, /stayed off screen after one scroll/);
    });
  }

  test(`T8(a): the cover is gone on the settled read: the retry passes with no drag (${kind})`, async () => {
    const r = await walk({
      views: typed(sheeted()),
      retry: typed([target('Button', ON_SCREEN, null)]),
      kind,
      dispatches: [OCCLUDED, { ok: true, proven: true }],
    });
    assert.equal(r.result.verdict, 'PASS', r.reason);
    assert.deepEqual(scrolls(r.acts), []);
    assert.equal(dispatches(r.acts).length, 2);
  });

  test(`T8(d): the re-bound target is off screen on the retry read: no drag, the withheld reason (${kind})`, async () => {
    const r = await walk({
      views: typed(sheeted()),
      retry: typed([list(), target(type, { ...IN_LIST, y: 1200 })]),
      kind,
    });
    assert.equal(r.result.verdict, 'FAIL');
    assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
    assert.equal(dispatches(r.acts).length, 1);
    assert.ok(
      r.reason.includes('"go" stayed covered; it is in no scroll area, so nothing was scrolled'),
      r.reason,
    );
    assert.doesNotMatch(r.reason, /after (one|a) scroll/);
  });

  test(`T8(g): the retry is refused as moved and the target never settles: no drag (${kind})`, async () => {
    const moved: ActResult = {
      ok: false,
      proven: false,
      mutation: 'none',
      error:
        'TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch; no tap or typing was performed',
    };
    const r = await walk({
      views: typed(sheeted()),
      // Once the retry is refused as moved, the target sits somewhere else on every read.
      retry: (sent, n) =>
        sent < 2
          ? typed(sheeted())
          : typed([target('Button', { ...ON_SCREEN, y: 100 + 10 * n }, null)]),
      kind,
      dispatches: [OCCLUDED, moved],
    });
    assert.equal(r.result.verdict, 'FAIL');
    assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
    assert.equal(dispatches(r.acts).length, 2);
    assert.match(r.reason, /TARGET_MOVED_BEFORE_DISPATCH.*did not settle/);
  });
}

// The retry read for T8(b) and (c): the target in a list whose lower part a full-width bar covers,
// an overlay inferred from list order alone.
const inferred = (): View[] => [
  list(),
  target('Button', { ...IN_LIST, y: 720 }),
  { id: 'qa-bar', type: 'Other', rect: { x: 0, y: 690, width: 402, height: 110 } },
];

test('T8(b): an inferred overlay on the retry read: the retry needs the live hit read; refused, no drag', async () => {
  const r = await walk({
    views: sheeted(),
    retry: inferred(),
    dispatches: [
      OCCLUDED,
      {
        ok: false,
        proven: false,
        mutation: 'none',
        error: 'LIVE_HIT_UNPROVEN: LIVE_HIT_UNPROVEN: not-hittable; no tap was performed.',
      },
    ],
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
  assert.deepEqual(
    dispatches(r.acts).map((a) => a.endsWith(' live')),
    [false, true],
  );
  assert.ok(
    r.reason.includes('"go" stayed covered; it is in no scroll area, so nothing was scrolled'),
    r.reason,
  );
  assert.match(r.reason, /the live hit read refused the press \(not-hittable\)/);
  assert.doesNotMatch(r.reason, /after (one|a) scroll/);
});

test('T8(c): a covered centre outside the inferred-overlay case on the retry read: no drag', async () => {
  const r = await walk({
    views: sheeted(),
    retry: inferred(),
    retryKeyboard: true,
    keyboard: false,
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
  assert.equal(dispatches(r.acts).length, 1);
  assert.ok(
    r.reason.includes('"go" stayed covered; it is in no scroll area, so nothing was scrolled'),
    r.reason,
  );
  assert.doesNotMatch(r.reason, /after (one|a) scroll/);
});

for (const noTap of [false, true]) {
  test(`T8(e): a fill whose retry finds no text input: the keyboard fallback sends no drag (${noTap ? 'no tap' : 'covered tap'})`, async () => {
    // A field React lists as a text input whose native node is a plain view: the runner refuses to type.
    const wrapper = (views: View[]) =>
      views.map((v) => (v.id === 'go' ? { ...v, type: 'Other' } : v));
    let fills = 0;
    const r = await walk({
      views: wrapper(sheeted()),
      retry: (dispatched) => wrapper(noTap && dispatched === 2 ? inferred() : sheeted()),
      kind: 'fill',
      edit: (screen) => {
        const field = screen.elements.find((e) => e.testID === 'go');
        if (field) field.kind = 'input';
        if (noTap && fills === 2) {
          screen.keyboardVisible = true;
        }
      },
      dispatches: [
        OCCLUDED,
        { ok: false, proven: false, mutation: 'none', error: 'NO_TEXT_INPUT_TARGET: refused' },
        OCCLUDED,
      ],
      setup: (deps) => {
        const fill = deps.fill;
        deps.fill = async (...args) => {
          fills += 1;
          return fill(...args);
        };
        deps.reactFocused = async () => false;
        deps.typeFocused = async () => assert.fail('nothing is typed under the cover');
      },
    });
    assert.equal(r.result.verdict, 'FAIL');
    assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
    assert.deepEqual(r.acts, noTap ? ['fill @e2', 'fill @e2'] : ['fill @e2', 'fill @e2', 'press @e2']);
    assert.ok(
      r.reason.includes('"go" stayed covered; it is in no scroll area, so nothing was scrolled'),
      r.reason,
    );
    assert.match(
      r.reason,
      noTap ? /covered by other at 0,690,402,110/ : /covered by other at 0,437,402,437/,
    );
    assert.doesNotMatch(r.reason, /after (one|a) scroll/);
  });
}

test('T8(f): a target with a label and no test id: one press, the withheld reason', async () => {
  const unnamed = sheeted().map((v) => (v.id === 'go' ? { ...v, id: '' } : v));
  const r = await walk({ views: unnamed, step: '1. Tap "Go"' });
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(scrolls(r.acts), [], r.log.join(','));
  assert.equal(dispatches(r.acts).length, 1);
  assert.ok(
    r.reason.includes(
      'the refused target identity no longer resolves uniquely; "Go" stayed covered; it is in no scroll area, so nothing was scrolled',
    ),
    r.reason,
  );
  assert.doesNotMatch(r.reason, /after (one|a) scroll/);
});
