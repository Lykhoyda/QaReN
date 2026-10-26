import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { associateHosts } from '../../../dist/qa/host-association.js';
import type { HostAssociationDiagnostic } from '../../../dist/qa/host-association.js';
import {
  join,
  semanticActionView,
  validateReactHostEvidence,
  type NativeNode,
} from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';

// Seven Test App captures from the S3P-0 probe on an API 37 emulator, value-free: classes, testIDs,
// rects, ancestry and visibility only. React frames are the core capture's own measurements;
// pointerEvents and zIndex come from the S3P-b-0 live Home read, mapped onto shared subtrees. They
// predate the fiber-order fact, so they carry no `order` and serve association rows only.
// The `live-*` captures are Home, Home scrolled to the Pager button and the keyboard form, exported
// by this capture code and runner on the same emulator: the runner's own presence verdicts and the
// React hosts' pointerEvents, zIndex and order exactly as captured.
type Presence = NativePresence['nodes'][number];
type Capture = {
  pointScale: number;
  nodes: Array<{
    index: number;
    depth: number;
    parentIndex?: number;
    type: string;
    identifier?: string;
    rect: [number, number, number, number];
    visibleToUser: boolean;
    enabled: boolean;
    presence?: Presence;
  }>;
  hosts: Array<{
    hostType: string;
    parent: number | null;
    rect?: [number, number, number, number];
    testID?: string;
    role?: string;
    press?: true;
    fill?: true;
    hidden?: true;
    pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
    zIndex?: number;
    order?: number;
  }>;
};
const captures: Record<string, Capture> = JSON.parse(
  readFileSync(
    new URL('../../fixtures/android-presence/test-app-captures.json', import.meta.url),
    'utf8',
  ),
);

const box = ([x, y, width, height]: [number, number, number, number]) => ({ x, y, width, height });

// A live capture carries the runner's presence; for the S3P-0 ones, the probe's facts decide it: a
// scrolled-out node is clipped, one under the keyboard keyboard-covered, an empty visible one
// empty-frame, other identified nodes observed. [scrolledOut] reads those nodes as clipped instead.
function load(name: string, extraHosts: Capture['hosts'] = [], scrolledOut: string[] = []) {
  const capture = { ...captures[name], hosts: [...captures[name].hosts, ...extraHosts] };
  const nodes: NativeNode[] = capture.nodes.map(({ presence: _, ...n }) => ({
    ...n,
    ref: `@e${n.index}`,
    rect: box(n.rect),
    hittable: n.enabled && n.visibleToUser,
  }));
  const keyboard = nodes.find((n) => n.type === 'Keyboard')?.rect;
  const presence: NativePresence = {
    source: 'android-a11y-live',
    pointScale: capture.pointScale,
    nodes: nodes.map((n, i): Presence => {
      const live = capture.nodes[i].presence;
      if (live)
        return scrolledOut.includes(n.identifier!)
          ? { status: 'unknown', labelSource: live.labelSource, unknownReason: 'clipped' }
          : live;
      const r = n.rect!;
      if (['Application', 'Window', 'Keyboard'].includes(n.type!) || !n.identifier)
        return { status: 'unknown', labelSource: 'none' };
      if (!n.visibleToUser)
        return {
          status: 'unknown',
          labelSource: 'none',
          unknownReason:
            keyboard &&
            r.height > 0 &&
            r.y + r.height / 2 >= keyboard.y &&
            !scrolledOut.includes(n.identifier)
              ? 'keyboard-covered'
              : 'clipped',
        };
      if (r.width === 0 || r.height === 0)
        return { status: 'unknown', labelSource: 'none', unknownReason: 'empty-frame' };
      return { status: 'observed', labelSource: 'none' };
    }),
  };
  const evidence = validateReactHostEvidence({
    complete: true,
    hosts: capture.hosts.map((h) => ({
      role: h.role ?? null,
      roleSource: h.role ? 'role' : 'none',
      capabilities: { ...(h.press ? { press: true } : {}), ...(h.fill ? { fill: true } : {}) },
      ...(h.testID ? { testID: h.testID } : {}),
      ...(h.hidden ? { hidden: true } : {}),
      ...(h.pointerEvents ? { pointerEvents: h.pointerEvents } : {}),
      ...(h.zIndex === undefined ? {} : { zIndex: h.zIndex }),
      ...(h.order === undefined ? {} : { order: h.order }),
    })),
    typography: {
      version: 1,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points',
      nodes: capture.hosts.map((h, hostIndex) => ({
        hostIndex,
        parentHostIndex: h.parent,
        rootIndex: 0,
        hostType: h.hostType,
        ...(h.rect ? { rect: box(h.rect) } : {}),
        text: { kind: 'none' },
      })),
    },
  });
  assert.ok(evidence, `${name} host evidence`);
  const diagnostics = new Map<number, HostAssociationDiagnostic>();
  const reactCovered = new Set<number>();
  const associations = associateHosts(nodes, evidence, presence, diagnostics, reactCovered);
  const host = (testID: string) => capture.hosts.findIndex((h) => h.testID === testID);
  const native = (testID: string) => nodes.findIndex((n) => n.identifier === testID);
  return {
    nodes,
    evidence,
    presence,
    reactCovered,
    native,
    covered: (testID: string) => reactCovered.has(native(testID)),
    screen: () =>
      join(nodes, [], 'app', { native: 'complete', react: 'complete' }, evidence, presence),
    associated: (testID: string) => associations.has(host(testID)),
    identity: (testID: string) => diagnostics.get(host(testID))?.identity,
    unassociatedPress: capture.hosts.filter((h, i) => h.press && !h.hidden && !associations.has(i))
      .length,
  };
}

test('Covered base associates its safe-area root and both Pressables on Android', () => {
  // Keep the captured frames: associateHosts calibrates their origin at the real device scale.
  const covered = load('covered-base');
  assert.equal(covered.presence.source, 'android-a11y-live');
  assert.equal(covered.presence.pointScale, 2.625);
  assert.equal(covered.identity('qa-covered-base-screen'), 'matched');
  assert.ok(covered.associated('qa-covered-base-screen'));
  for (const button of ['qa-covered-base-action', 'qa-covered-push-top']) {
    assert.equal(covered.identity(button), 'matched', button);
    assert.ok(covered.associated(button), button);
  }
  assert.equal(covered.unassociatedPress, 0);
});

test('Home top associates every interactive host, the 24 scrolled out of view included', () => {
  const home = load('home-top');
  assert.equal(home.unassociatedPress, 0);
  for (const below of [
    'home-pager-qa-btn',
    'home-keyboard-form-qa-btn',
    'home-input-libraries-btn',
  ])
    assert.ok(home.associated(below), below);
});

test('a control the scroll view shortens associates through its clip', () => {
  const home = load('home-top');
  const otp = home.nodes.find((n) => n.identifier === 'home-otp-qa-btn')!;
  assert.equal(otp.rect!.height, 81, 'the fixture keeps the clipped rect');
  assert.ok(home.associated('home-otp-qa-btn'));
});

test('an empty clipped rect associates below the fold at its own top and above it at the clip edge', () => {
  const top = load('home-top');
  assert.equal(top.nodes.find((n) => n.identifier === 'home-pager-qa-btn')!.rect!.height, 0);
  assert.ok(top.associated('home-pager-qa-btn'));
  const scrolled = load('home-mid');
  assert.deepEqual(scrolled.nodes.find((n) => n.identifier === 'qa-open-capture-size')!.rect, {
    x: 37,
    y: 0,
    width: 1006,
    height: 0,
  });
  assert.ok(scrolled.associated('qa-open-capture-size'));
  assert.equal(scrolled.unassociatedPress, 0);
});

test('a free-standing control with a shortened rect is still a frame mismatch', () => {
  const capture = captures['home-top'];
  const index = capture.nodes.findIndex((n) => n.identifier === 'quick-add-fab');
  const fab = capture.nodes[index];
  const saved = fab.rect;
  fab.rect = [saved[0], saved[1], saved[2], saved[3] - 20];
  try {
    const home = load('home-top');
    assert.equal(home.associated('quick-add-fab'), false);
    assert.equal(home.identity('quick-add-fab'), 'frame-mismatch');
  } finally {
    fab.rect = saved;
  }
});

test("the parked bottom sheet's sliders are plain views: Home projects press and fill", () => {
  const home = load('home-top');
  const screen = join(
    home.nodes,
    [],
    'app',
    { native: 'complete', react: 'complete' },
    home.evidence,
    home.presence,
  );
  const sliders = screen.elements.filter(
    (e, i) => home.nodes[i]?.type === 'android.widget.SeekBar',
  );
  assert.equal(sliders.length, 3);
  for (const slider of sliders) {
    assert.equal(slider.semantic?.press, 'unsupported');
    assert.equal(slider.semantic?.fill, 'unsupported');
  }
  const press = semanticActionView(screen, 'press');
  assert.ok('elements' in press, JSON.stringify(press));
  assert.ok(!press.elements.some((e) => sliders.includes(e)));
  assert.ok('elements' in semanticActionView(screen, 'fill'));
});

test('a mounted Modal leaves its capture without host association', () => {
  const modal = load('modal');
  assert.equal(modal.identity('qa-sheet'), 'window-count');
  assert.equal(modal.associated('qa-sheet'), false);
});

test('keyboard-covered inputs do not anchor their hosts, as on iOS', () => {
  const form = load('kb-up');
  assert.ok(form.associated('qa-kb-input-1'));
  for (const covered of ['qa-kb-input-5', 'qa-kb-input-8']) {
    assert.equal(form.associated(covered), false, covered);
    assert.equal(form.identity(covered), 'matched');
  }
});

// A visible control: a natively visible, identified node whose host offers a press or a fill.
function visibleControls(capture: ReturnType<typeof load>, name: string) {
  return captures[name].hosts.flatMap((h) => {
    if (!h.testID || !(h.press || h.fill) || h.hidden) return [];
    const n = capture.nodes[capture.native(h.testID)];
    return n?.visibleToUser && n.rect!.width > 0 && n.rect!.height > 0 ? [h.testID] : [];
  });
}

const COUNTERS = ['tab-home-press-counters', 'tab-home-handler-count', 'tab-home-tabpress-count'];

test('live Home: every host carries its exported fiber order and every visible control is observed', () => {
  assert.equal(
    captures['live-home-top'].hosts.filter((h) => h.order === undefined).length,
    0,
    'the export ranks every host, dev-frozen styles included',
  );
  const home = load('live-home-top');
  const controls = visibleControls(home, 'live-home-top');
  assert.equal(controls.length, 12);
  const screen = home.screen();
  for (const id of controls) {
    assert.equal(home.covered(id), false, id);
    assert.equal(screen.elements[home.native(id)].semantic?.visibility, 'visible', id);
  }
  // Only the touch-transparent counters (pointerEvents none) lose their touch, to what lies beneath.
  assert.deepEqual(
    [...home.reactCovered].map((i) => home.nodes[i].identifier).sort(),
    [...COUNTERS].sort(),
  );
  const press = semanticActionView(screen, 'press');
  assert.ok('elements' in press, JSON.stringify(press));
  for (const id of controls)
    assert.ok(
      press.elements.some((e) => e.testID === id),
      `${id} is a press candidate`,
    );
  assert.ok('elements' in semanticActionView(screen, 'fill'));
});

test('live Home scrolled: the Pager button is observed and pressable once in view', () => {
  const home = load('live-home-pager');
  const screen = home.screen();
  const pager = screen.elements[home.native('home-pager-qa-btn')];
  assert.equal(home.covered('home-pager-qa-btn'), false);
  assert.equal(pager.semantic?.visibility, 'visible');
  assert.equal(pager.semantic?.press, 'supported');
  assert.deepEqual(
    [...home.reactCovered].map((i) => home.nodes[i].identifier).sort(),
    [...COUNTERS].sort(),
  );
  // The one control the status bar's window covers stays the runner's not-hittable, not a React cover.
  for (const id of visibleControls(home, 'live-home-pager')) {
    const observed = screen.elements[home.native(id)].semantic?.visibility === 'visible';
    assert.equal(observed, id !== 'home-sheet-rows-btn', id);
  }
  assert.equal(
    home.presence.nodes[home.native('home-sheet-rows-btn')].unknownReason,
    'not-hittable',
  );
});

// A transparent full-screen view over Home, drawn last: with pointerEvents auto it takes every touch.
const overlay = (name: string, pointerEvents?: 'none'): Capture['hosts'][number] => ({
  hostType: 'RCTView',
  parent: 0,
  rect: [0, -136 / 2.625, 1080 / 2.625, 2400 / 2.625],
  zIndex: 10000,
  order: captures[name].hosts.filter((h) => h.parent === 0).length,
  ...(pointerEvents ? { pointerEvents } : {}),
});

for (const name of ['live-home-top', 'live-home-pager'])
  test(`${name}: a transparent auto overlay covers every visible control and leaves no visible press candidate`, () => {
    const home = load(name, [overlay(name)]);
    const controls = visibleControls(home, name).filter((id) => id !== 'home-sheet-rows-btn');
    for (const id of controls) assert.ok(home.covered(id), id);
    const screen = home.screen();
    for (const id of controls) {
      const element = screen.elements[home.native(id)];
      assert.equal(element.semantic?.visibility, 'unknown', id);
      assert.equal(element.semantic?.press, 'unsupported', id);
      assert.equal(element.semantic?.fill, 'unsupported', id);
    }
    const press = semanticActionView(screen, 'press');
    const visible =
      'elements' in press
        ? press.elements.filter((e) => e.semantic?.visibility !== 'offscreen')
        : [];
    assert.deepEqual(
      visible.map((e) => e.ref),
      [],
    );
  });

test('live Home: the same overlay with pointerEvents none leaves Home exactly as without it', () => {
  const plain = load('live-home-top');
  const none = load('live-home-top', [overlay('live-home-top', 'none')]);
  assert.deepEqual([...none.reactCovered], [...plain.reactCovered]);
  const refs = (capture: ReturnType<typeof load>) => {
    const press = semanticActionView(capture.screen(), 'press');
    assert.ok('elements' in press);
    return press.elements.map((e) => e.ref);
  };
  assert.deepEqual(refs(none), refs(plain));
});

test('live kb-up: the sticky footer covers input 4, which stays anchored but offers no press or fill', () => {
  const form = load('live-kb-up');
  for (const id of ['qa-kb-input-1', 'qa-kb-input-2', 'qa-kb-input-3']) {
    assert.equal(form.covered(id), false, id);
    assert.ok(form.associated(id), id);
  }
  assert.ok(form.covered('qa-kb-input-4'));
  assert.ok(form.associated('qa-kb-input-4'), 'react-covered keeps the anchor');
  assert.equal(form.identity('qa-kb-input-4'), 'matched');
  const screen = form.screen();
  assert.equal(screen.elements[form.native('qa-kb-input-1')].semantic?.visibility, 'visible');
  const input4 = screen.elements[form.native('qa-kb-input-4')];
  assert.equal(input4.semantic?.visibility, 'unknown');
  assert.equal(input4.semantic?.press, 'unsupported');
  assert.equal(input4.semantic?.fill, 'unsupported');
  // Inputs 5-8 under the keyboard are still screen-wide gaps (keyboard-covered is not anchor proof).
  for (const [kind, gaps] of [
    ['press', 'pressGapCount'],
    ['fill', 'fillGapCount'],
  ] as const) {
    const refused = semanticActionView(screen, kind);
    assert.ok('refuse' in refused, kind);
    assert.equal(refused.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.equal(
      refused.reason,
      `an observation has unknown ${kind} capability (@e2, other${kind === 'press' ? '; 4 interactive React hosts unassociated' : ''})`,
    );
    assert.equal(refused.diagnostic?.[gaps], 4, kind);
    assert.equal(refused.diagnostic?.reactCoveredCount, 2, kind);
    assert.deepEqual(
      refused.diagnostic?.gapHosts?.rows.map(
        (row) => captures['live-kb-up'].hosts[row.hostOrdinal].testID,
      ),
      ['qa-kb-input-5', 'qa-kb-input-6', 'qa-kb-input-7', 'qa-kb-input-8'],
    );
  }
});

test('live kb-up: input 4 alone refuses no fill step; input 1 stays a fill candidate', () => {
  // The same capture with inputs 5-8 scrolled out instead of under the keyboard: no gap remains.
  const fill = semanticActionView(
    load(
      'live-kb-up',
      [],
      ['qa-kb-input-5', 'qa-kb-input-6', 'qa-kb-input-7', 'qa-kb-input-8'],
    ).screen(),
    'fill',
  );
  assert.ok('elements' in fill, JSON.stringify(fill));
  const ids = fill.elements.map((e) => e.testID);
  assert.ok(ids.includes('qa-kb-input-1'));
  assert.ok(!ids.includes('qa-kb-input-4'));
});
