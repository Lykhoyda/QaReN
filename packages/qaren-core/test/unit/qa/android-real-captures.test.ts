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
// rects, ancestry and visibility only. React frames are the core capture's own measurements.
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
  }>;
};
const captures: Record<string, Capture> = JSON.parse(
  readFileSync(
    new URL('../../fixtures/android-presence/test-app-captures.json', import.meta.url),
    'utf8',
  ),
);

const box = ([x, y, width, height]: [number, number, number, number]) => ({ x, y, width, height });

// The runner's presence rows the probe's facts decide: a scrolled-out node is clipped, one under the
// keyboard keyboard-covered, an empty visible one empty-frame; other identified nodes are observed.
function load(name: string) {
  const capture = captures[name];
  const nodes: NativeNode[] = capture.nodes.map((n) => ({
    ...n,
    ref: `@e${n.index}`,
    rect: box(n.rect),
    hittable: n.enabled && n.visibleToUser,
  }));
  const keyboard = nodes.find((n) => n.type === 'Keyboard')?.rect;
  const presence: NativePresence = {
    source: 'android-a11y-live',
    pointScale: capture.pointScale,
    nodes: nodes.map((n) => {
      const r = n.rect!;
      if (['Application', 'Window', 'Keyboard'].includes(n.type!) || !n.identifier)
        return { status: 'unknown', labelSource: 'none' };
      if (!n.visibleToUser)
        return {
          status: 'unknown',
          labelSource: 'none',
          unknownReason:
            keyboard && r.height > 0 && r.y + r.height / 2 >= keyboard.y
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
  const associations = associateHosts(nodes, evidence, presence, diagnostics);
  const host = (testID: string) => capture.hosts.findIndex((h) => h.testID === testID);
  return {
    nodes,
    evidence,
    presence,
    associated: (testID: string) => associations.has(host(testID)),
    identity: (testID: string) => diagnostics.get(host(testID))?.identity,
    unassociatedPress: capture.hosts.filter((h, i) => h.press && !h.hidden && !associations.has(i))
      .length,
  };
}

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
