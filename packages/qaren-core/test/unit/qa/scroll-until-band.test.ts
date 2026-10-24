// Scroll-until band: the drag starts inside the scroll container it is meant to move.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStep } from '../../../dist/qa/plan.js';
import { KEYBOARD_EDGE_INSET, clearanceBand, scrollUntilBand } from '../../../dist/qa/resolve.js';
import { join } from '../../../dist/qa/screen.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import {
  ANDROID_LIST,
  IOS_LIST,
  androidOptionSheet,
  byRef,
  iosOptionSheet,
} from './sheet-fixtures.ts';

const SCREEN = { x: 0, y: 0, width: 1080, height: 2424 };
const LIST = { x: 64, y: 1270, width: 460, height: 504 };

function until(line: string) {
  const parsed = parseStep(line);
  assert.ok(parsed && !('refuse' in parsed) && parsed.kind === 'scroll' && parsed.until);
  return parsed.until;
}

const option20 = until('Scroll down until "qa-sheet-capture-option-20"');

function androidSheet(extra: NativeNode[] = [], list = 'android.widget.ScrollView'): Screen {
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: SCREEN },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: SCREEN },
      {
        ref: '@sheet',
        index: 2,
        parentIndex: 1,
        type: 'android.view.ViewGroup',
        rect: { x: 0, y: 1100, width: 1080, height: 1324 },
      },
      { ref: '@list', index: 3, parentIndex: 2, type: list, rect: LIST },
      ...[1, 2, 3].map((n, i) => ({
        ref: `@option-${n}`,
        index: 4 + i,
        parentIndex: 3,
        type: 'android.widget.TextView',
        identifier: `qa-sheet-capture-option-${n}`,
        label: `Option ${n}`,
        rect: { x: 64, y: 1270 + 200 * i, width: 460, height: 64 },
      })),
      ...extra,
    ],
    [],
  );
}

const keyboard = (index: number): NativeNode => ({
  ref: '@keyboard',
  index,
  parentIndex: 1,
  type: 'Keyboard',
  rect: { x: 0, y: 1500, width: 1080, height: 924 },
});

test('(a) an absent target drags inside the sheet list, not at the screen centre', () => {
  assert.deepEqual(scrollUntilBand(option20, androidSheet()), LIST);
});

test('(b) a keyboard cutting the list keeps only the part clear of its edge', () => {
  assert.deepEqual(scrollUntilBand(option20, androidSheet([keyboard(7)])), {
    ...LIST,
    height: 1500 - 48 - 1270,
  });
});

test('(aa) the keyboard-edge inset is platform-neutral and leaves a list ending above the keyboard alone', () => {
  const cut = androidSheet([{ ...keyboard(7), rect: { x: 0, y: 1541, width: 1080, height: 883 } }]);
  assert.deepEqual(scrollUntilBand(option20, cut), { ...LIST, height: 1541 - 48 - 1270 });
  assert.deepEqual(scrollUntilBand(option20, androidOptionSheet()), ANDROID_LIST);
});

test('(c) a resolved covered target drags inside its own clip band', () => {
  const screen = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: '@win',
        index: 1,
        parentIndex: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@scroll',
        index: 2,
        parentIndex: 1,
        type: 'ScrollView',
        rect: { x: 0, y: 300, width: 400, height: 500 },
      },
      {
        ref: '@target',
        index: 3,
        parentIndex: 2,
        type: 'Button',
        identifier: 'go',
        label: 'Go',
        hittable: true,
        rect: { x: 20, y: 600, width: 300, height: 44 },
      },
      {
        ref: '@keyboard',
        index: 4,
        parentIndex: 1,
        type: 'Keyboard',
        rect: { x: 0, y: 500, width: 400, height: 300 },
      },
    ],
    [],
  );
  const target = screen.elements[3];
  const band = scrollUntilBand(until('Scroll down until "go"'), screen);
  assert.deepEqual(band, clearanceBand(target, screen));
  assert.deepEqual(band, { x: 0, y: 300, width: 400, height: 500 - 48 - 300 });
});

test('(d) a screen without a scroll container keeps the band centre', () => {
  assert.equal(scrollUntilBand(option20, androidSheet([], 'android.view.ViewGroup')), undefined);
});

test('(e) a sheet list in a later window wins over a background list covering the window', () => {
  const screen = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: SCREEN },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: SCREEN },
      {
        ref: '@background',
        index: 2,
        parentIndex: 1,
        type: 'android.widget.ScrollView',
        rect: SCREEN,
      },
      { ref: '@sheet-win', index: 3, parentIndex: 0, type: 'Window', rect: SCREEN },
      { ref: '@list', index: 4, parentIndex: 3, type: 'android.widget.ScrollView', rect: LIST },
    ],
    [],
  );
  assert.deepEqual(scrollUntilBand(option20, screen), LIST);
});

test('(f) an iOS sheet list is the band', () => {
  const screen = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
      {
        ref: '@win',
        index: 1,
        parentIndex: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
      {
        ref: '@sheet',
        index: 2,
        parentIndex: 1,
        type: 'Other',
        rect: { x: 0, y: 400, width: 402, height: 474 },
      },
      {
        ref: '@list',
        index: 3,
        parentIndex: 2,
        type: 'ScrollView',
        rect: { x: 20, y: 460, width: 362, height: 300 },
      },
    ],
    [],
  );
  assert.deepEqual(scrollUntilBand(option20, screen), { x: 20, y: 460, width: 362, height: 300 });
});

test('(k) a horizontal-only container after the list never wins', () => {
  const carousel: NativeNode = {
    ref: '@carousel',
    index: 7,
    parentIndex: 2,
    type: 'android.widget.HorizontalScrollView',
    rect: { x: 0, y: 1800, width: 1080, height: 300 },
  };
  assert.deepEqual(scrollUntilBand(option20, androidSheet([carousel])), LIST);
});

test('(l) an inner vertical list beats the outer list it is nested in', () => {
  const inner: NativeNode = {
    ref: '@inner',
    index: 7,
    parentIndex: 3,
    type: 'androidx.recyclerview.widget.RecyclerView',
    rect: { x: 64, y: 1300, width: 460, height: 200 },
  };
  assert.deepEqual(scrollUntilBand(option20, androidSheet([inner])), {
    x: 64,
    y: 1300,
    width: 460,
    height: 200,
  });
});

test('a later container below the screen does not displace the visible sheet list', () => {
  const offscreen: NativeNode = {
    ref: '@offscreen-list',
    index: 7,
    parentIndex: 2,
    type: 'android.widget.ScrollView',
    rect: { x: 0, y: 2500, width: 1080, height: 500 },
  };
  const screen = androidSheet([offscreen]);
  const band = scrollUntilBand(option20, screen);
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@window', type: 'Window', rect: SCREEN }] as never, {
    snapshotGeneration: 1,
    keyboardVisible: false,
  });
  try {
    const [, x, y1, , y2] = buildDirectionalScrollCliArgs(
      'down',
      0.6,
      undefined,
      undefined,
      band,
    ).map(Number);
    assert.ok(x >= LIST.x && x < LIST.x + LIST.width, `swipe x=${x} misses list`);
    for (const y of [y1, y2]) {
      assert.ok(y >= LIST.y && y < LIST.y + LIST.height, `swipe y=${y} misses list`);
    }
    assert.deepEqual(band, LIST);
  } finally {
    clearRefMap();
  }
});

test('(m) a list running past the screen bottom drags inside its on-screen part', () => {
  const tall = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: SCREEN },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: SCREEN },
      {
        ref: '@list',
        index: 2,
        parentIndex: 1,
        type: 'android.widget.ScrollView',
        rect: { x: 64, y: 1270, width: 460, height: 1400 },
      },
    ],
    [],
  );
  assert.deepEqual(scrollUntilBand(option20, tall), { x: 64, y: 1270, width: 460, height: 1154 });
});

test('(n) a later container wholly beside the screen does not displace the sheet list', () => {
  const beside: NativeNode = {
    ref: '@beside',
    index: 7,
    parentIndex: 2,
    type: 'android.widget.ScrollView',
    rect: { x: 1200, y: 1300, width: 400, height: 400 },
  };
  assert.deepEqual(scrollUntilBand(option20, androidSheet([beside])), LIST);
});

function bandDrag(
  band: NonNullable<ReturnType<typeof scrollUntilBand>>,
  window: { width: number; height: number },
  keyboardTop: number,
  direction: 'up' | 'down' = 'down',
): number[] {
  clearRefMap();
  updateRefMapFromFlat(
    [
      { ref: '@window', type: 'Window', rect: { x: 0, y: 0, ...window } },
      {
        ref: '@keyboard',
        type: 'Keyboard',
        rect: { x: 0, y: keyboardTop, width: window.width, height: window.height - keyboardTop },
      },
    ] as never,
    { snapshotGeneration: 1, keyboardVisible: true },
  );
  try {
    return buildDirectionalScrollCliArgs(direction, 0.6, undefined, undefined, band)
      .slice(1, 5)
      .map(Number);
  } finally {
    clearRefMap();
  }
}

test('(o) a row scrolled out of the sheet list drags inside that list, whatever lies behind the sheet', () => {
  assert.deepEqual(scrollUntilBand(option20, androidOptionSheet()), ANDROID_LIST);
});

test('(p) that drag spans the visible list and cannot land as a tap', () => {
  const band = scrollUntilBand(option20, androidOptionSheet())!;
  const [x1, y1, x2, y2] = bandDrag(band, { width: 1080, height: 2424 }, 1541);
  assert.deepEqual([x1, x2], [540, 540]);
  assert.ok(y1 - y2 >= Math.floor(band.height * 0.8) - 2, `${y1} -> ${y2}`);
  for (const y of [y1, y2]) assert.ok(y > 949 && y < 1453, `${y}`);
});

test('(r) an offscreen target clears front overlays, a covered row still stops at a footer after the list', () => {
  const footer: NativeNode = {
    ref: '@footer',
    index: 31,
    parentIndex: 8,
    type: 'android.view.ViewGroup',
    hittable: true,
    rect: { x: 37, y: 1300, width: 1006, height: 153 },
  };
  const screen = androidOptionSheet(0, [footer]);
  assert.deepEqual(scrollUntilBand(option20, screen), { ...ANDROID_LIST, height: 347 });
  assert.deepEqual(clearanceBand(byRef(screen, '@option-2'), screen), {
    ...ANDROID_LIST,
    height: 1300 - 949,
  });
});

test('(v) an iOS row below a stretched list drags across the band, clear of the keyboard edge', () => {
  const screen = iosOptionSheet(1381);
  const band = scrollUntilBand(until('Scroll down until "qa-sheet-capture-option-17"'), screen)!;
  assert.deepEqual(band, { ...IOS_LIST, height: 568 - 48 - 357 });
  const [, y1, , y2] = bandDrag(band, { width: 402, height: 874 }, 568);
  assert.deepEqual([y1, y2], [504, 374]);
  assert.ok(y1 <= 568 - KEYBOARD_EDGE_INSET, `${y1}`);
});

test('a keyboard-covered target clears a floating toolbar before building the drag', () => {
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const screen = join(
    [
      { ref: '@window', index: 0, type: 'Window', rect: frame },
      {
        ref: '@list',
        index: 1,
        parentIndex: 0,
        type: 'ScrollView',
        rect: { x: 0, y: 300, width: 390, height: 500 },
      },
      {
        ref: '@target',
        index: 2,
        parentIndex: 1,
        type: 'Button',
        identifier: 'go',
        hittable: true,
        rect: { x: 20, y: 518, width: 300, height: 44 },
      },
      {
        ref: '@toolbar',
        index: 3,
        parentIndex: 0,
        type: 'Toolbar',
        hittable: true,
        rect: { x: 0, y: 425, width: 390, height: 25 },
      },
      {
        ref: '@keyboard',
        index: 4,
        parentIndex: 0,
        type: 'Keyboard',
        rect: { x: 0, y: 508, width: 390, height: 336 },
      },
    ],
    [],
  );
  const band = scrollUntilBand(until('Scroll down until "go"'), screen)!;
  assert.deepEqual(band, { x: 0, y: 300, width: 390, height: 121 });
  for (const direction of ['up', 'down'] as const) {
    const [, y1, , y2] = bandDrag(band, frame, 508, direction);
    assert.deepEqual([y1, y2], direction === 'down' ? [409, 313] : [313, 409]);
    for (const y of [y1, y2]) assert.ok(y < 425 || y > 450, `${y}`);
    assert.ok(Math.abs(y1 - y2) >= 48);
  }
});

test('a no-container fallback stays centred with a separate keyboard window', () => {
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const nodes: NativeNode[] = [
    { ref: '@window', index: 0, type: 'Window', rect: frame },
    { ref: '@keyboard-window', index: 1, type: 'Window', rect: frame },
    {
      ref: '@keyboard',
      index: 2,
      parentIndex: 1,
      type: 'Keyboard',
      rect: { x: 0, y: 508, width: 390, height: 336 },
    },
  ];
  const band = scrollUntilBand(option20, join(nodes, []));
  assert.equal(band, undefined);
  clearRefMap();
  updateRefMapFromFlat(nodes, { snapshotGeneration: 1, keyboardVisible: true });
  try {
    assert.deepEqual(buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, band), [
      'scroll',
      '195',
      '315',
      '195',
      '193',
      '300',
    ]);
    assert.deepEqual(buildDirectionalScrollCliArgs('up', 0.6, undefined, undefined, band), [
      'scroll',
      '195',
      '193',
      '195',
      '315',
      '300',
    ]);
  } finally {
    clearRefMap();
  }
});

function floatingTabScreen(barHittable: boolean): Screen {
  const frame = { x: 0, y: 0, width: 402, height: 874 };
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: frame },
      { ref: '@window', index: 1, parentIndex: 0, type: 'Window', rect: frame },
      { ref: '@list', index: 2, parentIndex: 1, type: 'ScrollView', rect: frame },
      {
        ref: '@bar',
        index: 3,
        parentIndex: 1,
        type: 'TabBar',
        hittable: barHittable,
        rect: { x: 20, y: 780, width: 362, height: 60 },
      },
      ...[0, 1].map((i) => ({
        ref: `@tab-${i}`,
        index: 4 + i,
        parentIndex: 3,
        type: 'Button',
        hittable: true,
        rect: { x: 20 + 181 * i, y: 780, width: 181, height: 60 },
      })),
    ],
    [],
  );
}

for (const [label, hittable] of [
  ['w', true],
  ['x', false],
] as const) {
  test(`(${label}) floating tab controls are outside the scroll-until band when bar hittable=${hittable}`, () => {
    const band = scrollUntilBand(option20, floatingTabScreen(hittable));
    assert.ok(band && band.height > 0);
    assert.ok(band.y + band.height <= 776, JSON.stringify(band));
  });
}

test('(y) list rows and a header drawn before the list do not cut the band', () => {
  const frame = { x: 0, y: 0, width: 402, height: 874 };
  const screen = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: frame },
      { ref: '@window', index: 1, parentIndex: 0, type: 'Window', rect: frame },
      {
        ref: '@header',
        index: 2,
        parentIndex: 1,
        type: 'Button',
        hittable: true,
        rect: { x: 0, y: 790, width: 402, height: 40 },
      },
      { ref: '@list', index: 3, parentIndex: 1, type: 'ScrollView', rect: frame },
      {
        ref: '@row',
        index: 4,
        parentIndex: 3,
        type: 'Button',
        hittable: true,
        rect: { x: 0, y: 750, width: 402, height: 60 },
      },
    ],
    [],
  );
  assert.deepEqual(scrollUntilBand(option20, screen), frame);
});

test('a fully covered list refuses instead of falling back to a window drag', () => {
  const frame = { x: 0, y: 0, width: 402, height: 874 };
  const screen = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: frame },
      { ref: '@window', index: 1, parentIndex: 0, type: 'Window', rect: frame },
      { ref: '@list', index: 2, parentIndex: 1, type: 'ScrollView', rect: frame },
      { ref: '@overlay', index: 3, parentIndex: 1, type: 'Button', hittable: true, rect: frame },
    ],
    [],
  );
  const band = scrollUntilBand(option20, screen);
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@window', type: 'Window', rect: frame }]);
  try {
    assert.throws(
      () => buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, band),
      /SCROLL_BAND_TOO_SMALL/,
    );
  } finally {
    clearRefMap();
  }
});
