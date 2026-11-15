import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type {
  DigestEntry,
  NativeNode,
  ReactHostEvidence,
  Screen,
} from '../../../dist/qa/screen.js';
import { scrollUntilBand } from '../../../dist/qa/resolve.js';
import { targetBehindInterruption } from '../../../dist/qa/recover.js';
import { CaptureDeadline } from '../../../dist/qa/capture.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = NonNullable<NativeNode['rect']>;

// Real iOS reads of the Test App (row K3b): an action sheet presented over the input-libraries
// screen, whose "open-repo-actions-sheet-btn" stays in React's tree behind it. Rebuilt through
// join() from the device's join inputs, so the modal cover table is filled as on the device.
function k3b(name: 'tap-first-ordinary' | 'tap-first-presence'): Screen {
  const a = JSON.parse(
    readFileSync(
      new URL(`../../fixtures/ios-k3b-action-sheet/${name}.json`, import.meta.url),
      'utf8',
    ),
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
    // The capture's own acquisition verdict, as capture.ts keeps it beside the join.
    captureCoverage: { native: a.nativeAcquisition, react: a.coverage.react },
  };
}

const SHEET_TARGET = 'open-repo-actions-sheet-btn';

test('K1: the real K3b presence read proves the target is behind the presented sheet', () => {
  const target = { phrase: SHEET_TARGET, quoted: SHEET_TARGET, kind: 'press' as const, line: 1 };
  assert.equal(targetBehindInterruption(k3b('tap-first-presence'), target), true);
  // The ordinary read the step decides on carries no such proof.
  assert.equal(targetBehindInterruption(k3b('tap-first-ordinary'), target), false);
});

test('K1: a tap behind the real action sheet refuses without dragging the sheet away', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted tap is model-free')),
  );
  f.deps.platform = 'ios';
  let sheetUp = true;
  const modes: boolean[] = [];
  // The screen behind the sheet once a drag has closed it: the target is native and hittable.
  const behind = screen([element('@open', 'Open actions', { testID: SHEET_TARGET })]);
  f.deps.captureScreen = async (request) => {
    modes.push(request?.platformPresence === true);
    if (!sheetUp) return behind;
    return k3b(request?.platformPresence ? 'tap-first-presence' : 'tap-first-ordinary');
  };
  f.deps.scroll = async (direction) => {
    f.actions.push(`scroll ${direction}`);
    sheetUp = false;
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(parsePlan(`1. Tap "${SHEET_TARGET}"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL', `actions: ${f.actions.join(', ')}`);
  assert.match(
    result.failure?.seen ?? '',
    /^"open-repo-actions-sheet-btn" is mounted behind a presented modal; it was not scrolled/,
  );
  assert.deepEqual(f.actions, []);
  assert.ok(sheetUp, 'the sheet is still open');
  assert.equal(modes[0], false);
  assert.equal(modes[1], true);
});

// A list screen: a scroll view from y 100 running past the bottom of a 402x874 window, and one
// button in it that React lays out at targetY. Without a native element the button is known only
// through React. Without `container` the same view is a plain one, not a scroll view.
interface List {
  targetY?: number;
  container?: boolean;
  nativeTarget?: boolean;
  // A native target outside the window: found by name off screen.
  nativeOffscreen?: boolean;
  decline?: boolean;
  // A system dialog in front of the app.
  dialog?: boolean;
  cover?: Rect;
  siblingContainer?: boolean;
}

const WINDOW: Rect = { x: 0, y: 0, width: 402, height: 874 };
const SCROLL: Rect = { x: 0, y: 100, width: 402, height: 900 };
// What the user sees of the scroll view: the window clips it at 874.
const CLIPPED: Rect = { x: 0, y: 100, width: 402, height: 774 };

function list(presence: boolean, l: List = {}): Screen {
  const { targetY = 900, container = true } = l;
  const nodes: NativeNode[] = [
    { ref: '@w', index: 0, type: 'Window', rect: WINDOW },
    {
      ref: '@s',
      index: 1,
      parentIndex: 0,
      type: container ? 'ScrollView' : 'Other',
      identifier: 'list-scroll',
      rect: SCROLL,
    },
  ];
  if (l.nativeTarget || l.nativeOffscreen)
    nodes.push({
      ref: '@far',
      index: nodes.length,
      parentIndex: 1,
      type: 'Button',
      identifier: 'far-btn',
      label: 'Far row',
      hittable: !l.nativeOffscreen,
      rect: { x: 16, y: l.nativeOffscreen ? 950 : 300, width: 370, height: 44 },
    });
  if (l.decline)
    nodes.push({
      ref: '@cancel',
      index: nodes.length,
      parentIndex: 0,
      type: 'Button',
      identifier: 'list-cancel',
      label: 'Cancel',
      hittable: true,
      rect: { x: 16, y: 800, width: 370, height: 44 },
    });
  if (l.cover)
    nodes.push({
      ref: '@cover',
      index: nodes.length,
      parentIndex: 0,
      type: 'Other',
      identifier: 'app-sheet',
      hittable: true,
      rect: l.cover,
    });
  if (l.siblingContainer)
    nodes.push({
      ref: '@other-scroll',
      index: nodes.length,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'other-scroll',
      rect: SCROLL,
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
                hostType: container ? 'RCTScrollView' : 'RCTView',
                rect: SCROLL,
                text: { kind: 'none' },
              },
              {
                hostIndex: 1,
                parentHostIndex: 0,
                rootIndex: 0,
                hostType: 'RCTView',
                rect: { x: 16, y: targetY, width: 370, height: 44 },
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
  return join(
    nodes,
    digest,
    l.dialog ? 'dialog' : 'app',
    { native: 'complete', react: 'complete' },
    host,
    presence
      ? {
          source: 'xcui-live',
          nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
        }
      : undefined,
  );
}

type Scroll = { direction: string; band: Rect | undefined };

// Captures follow `reads`: each read is built for the presence the walker asked for; the last repeats.
async function tap(
  reads: List[],
  options: {
    platform?: WalkerDeps['platform'];
    presence?: (request: Parameters<WalkerDeps['captureScreen']>[0]) => Promise<Screen>;
  } = {},
) {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted tap is model-free')),
  );
  // An explicitly unset platform stays unset: it must keep today's path like Android.
  f.deps.platform = 'platform' in options ? options.platform : 'ios';
  const modes: boolean[] = [];
  const scrolls: Scroll[] = [];
  let read = 0;
  f.deps.captureScreen = async (request) => {
    const presence = request?.platformPresence === true;
    modes.push(presence);
    const shape = reads[Math.min(read, reads.length - 1)];
    if (presence && options.presence) return options.presence(request);
    return list(presence, shape);
  };
  f.deps.scroll = async (direction, _context, _distance, band) => {
    f.actions.push(`scroll ${direction}`);
    scrolls.push({ direction, band });
    read += 1;
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap "far-btn"').blocks!, f.deps);
  return { result, modes, scrolls, actions: f.actions };
}

const seen = (r: { result: { failure?: { seen?: string } } }) => r.result.failure?.seen ?? '';

test('K2: a React-only target below its scroll container drags down inside its visible part', async () => {
  const r = await tap([{ targetY: 900 }, { nativeTarget: true }]);
  assert.equal(r.result.verdict, 'PASS', seen(r));
  assert.deepEqual(r.actions, ['scroll down', 'press @far']);
  assert.deepEqual(
    r.scrolls[0].band,
    scrollUntilBand({ phrase: 'far-btn', quoted: 'far-btn' }, list(true)),
  );
  // One presence read before the one drag.
  assert.deepEqual(r.modes.slice(0, 2), [false, true]);
  assert.equal(r.modes.filter(Boolean).length, 1);
});

test('K2: a React-only target above its scroll container drags up inside its visible part', async () => {
  const r = await tap([{ targetY: 20 }, { nativeTarget: true }]);
  assert.equal(r.result.verdict, 'PASS', seen(r));
  assert.deepEqual(r.actions, ['scroll up', 'press @far']);
  assert.deepEqual(
    r.scrolls[0].band,
    scrollUntilBand({ phrase: 'far-btn', quoted: 'far-btn' }, list(true)),
  );
});

for (const [targetY, direction] of [
  [20, 'up'],
  [900, 'down'],
] as const) {
  test(`K2b: a full app cover refuses the ${direction} drag`, async () => {
    const r = await tap([{ targetY, cover: CLIPPED }]);
    assert.equal(r.result.verdict, 'FAIL');
    assert.ok(
      seen(r).includes(
        '"far-btn" is known to React but has no element on the visible screen; no part of its scroll area is free of what lies in front, so nothing was scrolled',
      ),
      seen(r),
    );
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.modes, [false, true]);
    assert.equal(r.result.recoveries, 0);
  });

  test(`K2b: a lower-half app cover confines the ${direction} drag to the free part`, async () => {
    const shape = { targetY, cover: { ...CLIPPED, y: 487, height: 387 } };
    const r = await tap([shape, { nativeTarget: true }]);
    assert.equal(r.result.verdict, 'PASS', seen(r));
    assert.deepEqual(r.actions, [`scroll ${direction}`, 'press @far']);
    const band = r.scrolls[0].band;
    assert.deepEqual(band, { x: 0, y: 100, width: 402, height: 383 });
    assert.deepEqual(
      band,
      scrollUntilBand({ phrase: 'far-btn', quoted: 'far-btn' }, list(true, shape)),
    );
  });

  test(`K2b: a mismatched scroll container refuses the ${direction} drag`, async () => {
    const r = await tap([{ targetY, siblingContainer: true }]);
    assert.equal(r.result.verdict, 'FAIL');
    assert.match(seen(r), /no scroll area on screen holds it, so nothing was scrolled/);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.modes, [false, true]);
  });
}

for (const [name, shape, text] of [
  [
    'inside its scroll area',
    { targetY: 300 },
    'it lies inside the visible part of its scroll area and is not exposed there, so scrolling cannot help and nothing was scrolled',
  ],
  [
    'partly past the visible edge of its scroll area',
    { targetY: 850 },
    'its place could not be read, so nothing was scrolled',
  ],
  [
    'below the window with no scroll area',
    { targetY: 900, container: false },
    'no scroll area on screen holds it, so nothing was scrolled',
  ],
] as const) {
  test(`K3: a React-only target ${name} is refused without a drag or a recovery read`, async () => {
    const r = await tap([shape]);
    assert.equal(r.result.verdict, 'FAIL');
    assert.ok(
      seen(r).includes(
        `"far-btn" is known to React but has no element on the visible screen; ${text}`,
      ),
      seen(r),
    );
    assert.deepEqual(r.actions, []);
    // The ordinary read, then the presence read; nothing after it.
    assert.deepEqual(r.modes, [false, true]);
    assert.equal(r.result.recoveries, 0);
  });

  for (const platform of ['android', undefined] as const)
    test(`K6: on ${platform ?? 'an unset platform'} a React-only target ${name} keeps today's one blind drag`, async () => {
      const r = await tap([shape], { platform });
      assert.equal(r.result.verdict, 'FAIL');
      assert.deepEqual(r.actions, ['scroll down']);
      assert.equal(r.scrolls[0].band, undefined);
      assert.ok(
        r.modes.every((presence) => !presence),
        'no presence read is added',
      );
      assert.match(seen(r), /stayed off screen after one scroll/);
    });
}

const LATE = 'the read that would place it was late or incomplete, so nothing was scrolled';

for (const [name, presence] of [
  [
    'late',
    async () => {
      throw new CaptureDeadline();
    },
  ],
  [
    'incomplete',
    async () => ({
      ...list(true),
      coverage: { native: 'incomplete' as const, react: 'complete' as const },
    }),
  ],
] as const) {
  test(`K4: a ${name} presence read refuses at once, with no drag and no other capture`, async () => {
    const r = await tap([{ targetY: 900 }], { presence });
    assert.equal(r.result.verdict, 'FAIL');
    assert.ok(
      seen(r).includes(
        `"far-btn" is known to React but has no element on the visible screen; ${LATE}`,
      ),
      seen(r),
    );
    assert.doesNotMatch(seen(r), /a decline control was visible/);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.modes, [false, true]);
    assert.equal(r.result.recoveries, 0);
  });

  test(`K4: a ${name} presence read with a decline visible keeps the decline clause`, async () => {
    const r = await tap([{ targetY: 900, decline: true }], { presence });
    assert.equal(r.result.verdict, 'FAIL');
    assert.ok(seen(r).includes(LATE), seen(r));
    assert.match(
      seen(r),
      /a decline control was visible, but the presence read for it was late or incomplete/,
    );
    assert.deepEqual(r.actions, []);
  });
}

test('K5: a target still React-only after its one drag gets no second read and no second drag', async () => {
  const r = await tap([{ targetY: 900 }]);
  assert.equal(r.result.verdict, 'FAIL');
  assert.deepEqual(r.actions, ['scroll down']);
  assert.deepEqual(
    r.scrolls[0].band,
    scrollUntilBand({ phrase: 'far-btn', quoted: 'far-btn' }, list(true)),
  );
  assert.equal(r.modes.filter(Boolean).length, 1);
  assert.match(seen(r), /"far-btn" stayed off screen after one scroll/);
});

test("G1: a native target off screen keeps today's drag with no presence read", async () => {
  const ios = await tap([{ nativeOffscreen: true }, { nativeTarget: true }]);
  const base = await tap([{ nativeOffscreen: true }, { nativeTarget: true }], {
    platform: 'android',
  });
  assert.equal(ios.result.verdict, 'PASS', seen(ios));
  // The fixture really goes through the scroll branch: one drag, then the press.
  assert.deepEqual(ios.actions, ['scroll down', 'press @far']);
  assert.deepEqual(ios.actions, base.actions);
  assert.deepEqual(ios.scrolls, base.scrolls);
  assert.ok(
    ios.modes.every((presence) => !presence),
    'no presence read is added',
  );
});

test('G1: a native target on screen is pressed with no presence read', async () => {
  const r = await tap([{ nativeTarget: true }]);
  assert.equal(r.result.verdict, 'PASS', seen(r));
  assert.deepEqual(r.actions, ['press @far']);
  assert.ok(r.modes.every((presence) => !presence));
});

test('G1: with a system dialog in front, a React-only target keeps the dialog path', async () => {
  const ios = await tap([{ targetY: 300, dialog: true }]);
  const base = await tap([{ targetY: 300, dialog: true }], { platform: 'android' });
  assert.match(seen(ios), /"far-btn" is behind a system dialog/);
  assert.doesNotMatch(seen(ios), /is known to React but has no element/);
  assert.deepEqual(ios.actions, base.actions);
  assert.deepEqual(ios.modes, base.modes);
});
