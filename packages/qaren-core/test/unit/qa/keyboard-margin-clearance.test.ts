// An iOS press whose centre lies in the 48 pt margin above a visible keyboard, with nothing covering
// it, hides the keyboard once and presses; it never sends the clearance scroll.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { coverOwner } from '../../../dist/qa/resolve.js';
import {
  join,
  type NativeNode,
  type ReactHostEvidence,
  type Screen,
} from '../../../dist/qa/screen.js';
import {
  walkBlock,
  type ActResult,
  type WalkerDeps,
  type WalkerTimingDiagnostic,
} from '../../../dist/qa/walker.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

type Rect = NonNullable<NativeNode['rect']>;
const KEYBOARD: Rect = { x: 0, y: 500, width: 400, height: 300 };
// The Number pad form's edge variant: centre 20 pt above the keyboard top, 4 pt overlap.
const EDGE: Rect = { x: 20, y: 456, width: 100, height: 48 };
// Centre 60 pt above the keyboard top, outside the margin.
const ABOVE: Rect = { x: 20, y: 416, width: 100, height: 48 };
// Centre inside the keyboard frame.
const UNDER: Rect = { x: 20, y: 500, width: 100, height: 48 };
// Where the footer lands once the keyboard is hidden.
const FOOTER: Rect = { x: 20, y: 740, width: 100, height: 48 };
const OFF_SCREEN = /stayed off screen after one scroll/;
const MARGIN = /centre lies within 48 pt above the keyboard/;

interface Shape {
  // 'unknown' keeps the keyboard's frame but reports no visibility.
  keyboard?: boolean | 'unknown';
  rect?: Rect;
  // A full-width touchable toolbar outside the target's scroll area, drawn after it: a band cutter.
  overlay?: Rect;
  type?: string;
  target?: boolean;
}

function screen({
  keyboard = true,
  rect = EDGE,
  overlay,
  type = 'Button',
  target = true,
}: Shape = {}): Screen {
  const all: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    // A sibling under the same full-screen window never cuts the band, so a cutter needs its own clip.
    ...(overlay
      ? [
          {
            ref: '@list',
            type: 'ScrollView',
            parentIndex: 1,
            rect: { x: 0, y: 100, width: 400, height: 700 },
          },
        ]
      : []),
    {
      ref: '@submit',
      type,
      parentIndex: overlay ? 2 : 1,
      identifier: 'submit',
      label: 'Continue',
      hittable: true,
      rect,
    },
    ...(overlay
      ? [
          {
            ref: '@bar',
            type: 'Button',
            parentIndex: 1,
            identifier: 'bar',
            hittable: true,
            rect: overlay,
          },
        ]
      : []),
    ...(keyboard !== false
      ? [{ ref: '@keyboard', type: 'Keyboard', parentIndex: 0, rect: KEYBOARD }]
      : []),
  ];
  const nodes = all.filter((n) => target || n.ref !== '@submit');
  return {
    ...join(
      nodes,
      [],
      'app',
      { native: 'complete', react: 'complete' },
      {
        hosts: [],
        complete: true,
        typography: {
          version: 1,
          complete: true,
          durationMs: 1,
          coordinateSpace: 'window-points',
          nodes: [],
        },
      },
      {
        source: 'xcui-live',
        nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
      },
    ),
    keyboardVisible: keyboard === 'unknown' ? undefined : keyboard,
  };
}

// A capture whose React hit test runs when it carries native presence: the overlay's host takes the
// touch at the target's centre. An ordinary capture (presence false) carries no presence.
async function hitTested(overlay: Rect, keyboard = true, withPresence = true): Promise<Screen> {
  const base = nativeCapture();
  base.keyboardVisible = keyboard;
  const presence = (nodeIndex: number) => ({ ...base.nodes[1].presence, nodeIndex });
  const views = [
    { id: 'submit', label: 'Continue', rect: keyboard ? EDGE : FOOTER },
    { id: 'bar', label: 'Bar', rect: overlay },
  ];
  base.nodes = [
    { ...base.nodes[0], rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@e1',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      enabled: true,
      hittable: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
      presence: presence(1),
    },
    ...views.map((view, i) => ({
      ref: `@e${i + 2}`,
      index: i + 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      identifier: view.id,
      label: view.label,
      enabled: true,
      hittable: true,
      rect: view.rect,
      presence: presence(i + 2),
    })),
    ...(keyboard
      ? [
          {
            ref: '@e4',
            index: 4,
            depth: 1,
            parentIndex: 0,
            type: 'Keyboard',
            enabled: true,
            rect: KEYBOARD,
            presence: presence(4),
          },
        ]
      : []),
  ] as typeof base.nodes;
  if (!withPresence)
    for (const node of base.nodes) delete (node as { presence?: unknown }).presence;
  base.snapshotVerdict.nodeCount = base.nodes.length;
  const full = { x: 0, y: 0, width: 400, height: 800 };
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [
      { role: null, roleSource: 'none', capabilities: {} },
      ...views.map((view, order) => ({
        testID: view.id,
        role: null,
        roleSource: 'none' as const,
        capabilities: { press: true },
        order,
      })),
    ],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [
        {
          hostIndex: 0,
          parentHostIndex: null,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: full,
          text: { kind: 'none' },
        },
        ...views.map((view, i) => ({
          hostIndex: i + 1,
          parentHostIndex: 0,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: view.rect,
          text: { kind: 'none' as const },
        })),
      ],
    },
  };
  if (!withPresence) delete evidence.typography;
  return captureScreen({
    appId: 'com.test',
    native: async () => (withPresence ? base : { ...base, presenceCapture: undefined }),
    react: async () => ({
      interactive: [],
      hostEvidence: evidence,
      verdict: { state: 'ok', path: 'interactive', complete: true },
    }),
  });
}

function device(
  first: Screen = screen(),
  after: Screen = screen({ keyboard: false, rect: FOOTER }),
) {
  let current = first;
  let clock = 0;
  const calls: string[] = [];
  const events: WalkerTimingDiagnostic[] = [];
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen() {
      calls.push('capture');
      return current;
    },
    async dismissKeyboard(context) {
      context.authorize();
      calls.push('dismiss');
      current = after;
      return 'js';
    },
    async press(ref, context) {
      context.authorize();
      calls.push(`press ${ref}`);
      return { ok: true, proven: true } satisfies ActResult;
    },
    async fill(ref, _text, context) {
      context.authorize();
      calls.push(`fill ${ref}`);
      return { ok: true, proven: true };
    },
    async scroll(_direction, context) {
      context.authorize();
      calls.push('scroll');
      return { ok: true, proven: false };
    },
    async back() {
      throw Error('unexpected back');
    },
    async dialog(_action, context) {
      context.authorize();
      calls.push('dialog');
      return { ok: true, proven: true, executed: true };
    },
    async hideDevMenu() {
      throw Error('unexpected dev menu');
    },
    async screenshot(name) {
      return name;
    },
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    row() {},
    diagnostic: (event) => events.push(event),
  };
  return {
    deps,
    calls,
    events,
    show: (s: Screen) => {
      current = s;
    },
  };
}

const count = (f: ReturnType<typeof device>, call: string) =>
  f.calls.filter((c) => c.startsWith(call)).length;
const tap = () => parsePlan('1. Tap "submit"\n').blocks![0];
const seen = (outcome: Awaited<ReturnType<typeof walkBlock>>) =>
  JSON.stringify(outcome.failure?.seen);
const dispatched = (f: ReturnType<typeof device>) =>
  f.events
    .filter((event) => event.stage === 'dispatch' && event.code === 'COMPLETED')
    .map((event) => event.action);

test('T1: keyboard up, centre 20 pt above it, nothing on the band: one dismissal, one press, no scroll', async () => {
  const f = device();
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(
    outcome.block.outcome,
    'pass',
    JSON.stringify({ failure: outcome.failure, calls: f.calls }),
  );
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'dismiss'), 1);
  assert.deepEqual(
    f.calls.filter((c) => c.startsWith('press')),
    ['press @submit'],
  );
  assert.deepEqual(dispatched(f), ['dismiss-keyboard', 'press']);
  assert.equal(outcome.rows.at(-1)?.keyboardCleared, 'js');
});

test('T2: a real overlay cutting the band keeps the clearance scroll and its refusal', async () => {
  const f = device(screen({ overlay: { x: 0, y: 440, width: 400, height: 60 } }));
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  const covered = f.events.find((event) => event.code === 'CENTRE_COVERED');
  assert.equal(
    covered?.clearanceDiagnostic?.predicate?.cutter?.ref,
    '@bar',
    JSON.stringify(covered),
  );
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'scroll'), 1);
  assert.equal(count(f, 'press'), 0);
  assert.match(seen(outcome), OFF_SCREEN);
});

// A bar that starts inside the margin: it cuts no band edge, only the hit test can name it.
const INNER_BAR: Rect = { x: 0, y: 470, width: 400, height: 30 };

// Serves the capture mode the walker asks for; the keyboard is up until the first dismissal.
function modeAware(f: ReturnType<typeof device>, late = false, bar = INNER_BAR): boolean[] {
  const modes: boolean[] = [];
  f.deps.captureScreen = async (options) => {
    f.calls.push('capture');
    const presence = options?.platformPresence === true;
    modes.push(presence);
    const s = await hitTested(bar, count(f, 'dismiss') === 0, presence);
    if (presence && late) {
      s.coverage = { ...s.coverage!, native: 'incomplete' };
      s.captureCoverage = { ...(s.captureCoverage ?? s.coverage), native: 'incomplete' };
    }
    return s;
  };
  return modes;
}

test('T2b: an ordinary capture names no cover for a bar inside the margin; a presence capture names it', async () => {
  for (const [presence, expected] of [
    [false, 'no-native-presence'],
    [true, 'owner:bar'],
  ] as const) {
    const s = await hitTested(INNER_BAR, true, presence);
    const cover = coverOwner(s.elements.find((e) => e.testID === 'submit')!, s);
    assert.equal('gap' in cover ? cover.gap : `owner:${cover.owner.testID}`, expected);
  }
});

test('T2b: the one presence recapture names the bar: no clearance, the clearance scroll as today', async () => {
  const f = device();
  const modes = modeAware(f);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  // The margin check's recapture, then the one today's refusal takes to name its cover.
  assert.deepEqual(modes, [false, true, false, false, true]);
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'scroll'), 1);
  assert.equal(count(f, 'press'), 0);
  assert.match(seen(outcome), OFF_SCREEN);
});

test('T1: on real capture modes, the recapture proves nothing covers the centre: clearance, one press', async () => {
  const f = device();
  const modes = modeAware(f, false, { x: 0, y: 100, width: 400, height: 40 });
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(
    outcome.block.outcome,
    'pass',
    JSON.stringify({ calls: f.calls, seen: seen(outcome) }),
  );
  assert.equal(modes.filter(Boolean).length, 1, JSON.stringify(modes));
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'press'), 1);
});

test('T2b: a late presence recapture still clears the keyboard, then presses once', async () => {
  const f = device();
  const modes = modeAware(f, true);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(
    outcome.block.outcome,
    'pass',
    JSON.stringify({ calls: f.calls, seen: seen(outcome) }),
  );
  assert.equal(modes.filter(Boolean).length, 1, JSON.stringify(modes));
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'press'), 1);
});

test('T3: centre 60 pt above the keyboard is pressed plainly, with no clearance', async () => {
  const f = device(screen({ rect: ABOVE }));
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'press'), 1);
});

test('T3: a centre inside the keyboard frame keeps the keyboard branch', async () => {
  const f = device(screen({ rect: UNDER }));
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'scroll'), 1);
  assert.equal(count(f, 'press'), 0);
  assert.match(seen(outcome), OFF_SCREEN);
  assert.doesNotMatch(seen(outcome), MARGIN);
});

for (const [name, after] of [
  ['stays visible', screen()],
  ['is unknown', screen({ keyboard: 'unknown' })],
] as const) {
  test(`T4: a keyboard that ${name} after the clearance ends the step naming it, with no scroll or press`, async () => {
    const f = device(screen(), after);
    const outcome = await walkBlock(tap(), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'dismiss'), 1);
    assert.equal(count(f, 'scroll'), 0);
    assert.equal(count(f, 'press'), 0);
    assert.match(seen(outcome), MARGIN);
    assert.match(seen(outcome), /keyboard did not hide/);
  });
}

test('T4: a clearance that sends nothing ends the step naming the keyboard', async () => {
  const f = device();
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.calls.push('dismiss');
    f.show(screen({ keyboard: false, rect: FOOTER }));
    return 'none';
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'press'), 0);
  assert.match(seen(outcome), MARGIN);
  assert.match(seen(outcome), /keyboard clearance sent nothing/);
});

test('T4: with the clearance already spent on this step, the refusal names the margin; no second clearance', async () => {
  const f = device();
  // An absent target spends the allowance; a dialog then interrupts and the retry finds the margin case.
  const absent = { ...screen({ keyboard: false, target: false }), keyboardVisible: true };
  f.show(absent);
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.calls.push('dismiss');
    f.show({ ...absent, keyboardVisible: false });
    return 'js';
  };
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    if (options?.platformPresence && count(f, 'dismiss') && !f.calls.includes('dialog'))
      f.show({ ...screen({ keyboard: false }), front: 'dialog' });
    return capture(options);
  };
  const dialog = f.deps.dialog;
  f.deps.dialog = async (action, context) => {
    const act = await dialog(action, context);
    f.show(screen());
    return act;
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.ok(
    outcome.rows.some((row) => row.outcome === 'retry'),
    JSON.stringify(f.calls),
  );
  assert.equal(count(f, 'dismiss'), 1, JSON.stringify({ calls: f.calls, seen: seen(outcome) }));
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'press'), 0);
  assert.match(seen(outcome), MARGIN);
  assert.match(seen(outcome), /already used on this step/);
});

test('T5: a Fill with its centre in the margin keeps the clearance scroll', async () => {
  const f = device(screen({ type: 'TextField' }));
  const outcome = await walkBlock(parsePlan('1. Fill "submit" with "1"\n').blocks![0], f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'scroll'), 1);
  assert.equal(count(f, 'fill'), 0);
});

for (const shape of ['android', 'no keyboard guard'] as const) {
  test(`T5: ${shape} keeps the clearance scroll`, async () => {
    const f = device();
    if (shape === 'android') f.deps.platform = 'android';
    else delete f.deps.dismissKeyboard;
    const outcome = await walkBlock(tap(), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'dismiss'), 0);
    assert.equal(count(f, 'scroll'), 1);
    assert.equal(count(f, 'press'), 0);
    assert.doesNotMatch(seen(outcome), MARGIN);
  });
}

test('T5: a hidden keyboard presses the target plainly', async () => {
  const f = device(screen({ keyboard: false }));
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'scroll'), 0);
  assert.equal(count(f, 'press'), 1);
});
