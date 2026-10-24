// Keyboard clearance on an Android form: the touchable band stops at overlay siblings over the clip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  centreCovered,
  clearanceBand,
  clearanceScroll,
  keyboardClearance,
  KEYBOARD_EDGE_INSET,
} from '../../../dist/qa/resolve.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { ANDROID_LIST, IOS_LIST, androidOptionSheet, iosOptionSheet } from './sheet-fixtures.ts';

const WINDOW = { x: 0, y: 0, width: 1080, height: 2400 };

// Header 0-300, a ScrollView list 300-1400 over the keyboard top, a sticky footer sibling 1150-1400.
function form(extra: NativeNode[] = [], footer = true, field7Y = 1860): Screen {
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: WINDOW },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: WINDOW },
      {
        ref: '@root',
        index: 2,
        parentIndex: 1,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: WINDOW,
      },
      {
        ref: '@header',
        index: 3,
        parentIndex: 2,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 0, y: 0, width: 1080, height: 300 },
      },
      {
        ref: '@list',
        index: 4,
        parentIndex: 2,
        type: 'android.widget.ScrollView',
        hittable: true,
        rect: { x: 0, y: 300, width: 1080, height: 1100 },
      },
      {
        ref: '@content',
        index: 5,
        parentIndex: 4,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 0, y: 300, width: 1080, height: 1700 },
      },
      {
        ref: '@field7',
        index: 6,
        parentIndex: 5,
        type: 'android.widget.EditText',
        identifier: 'qa-kb-input-7',
        hittable: true,
        rect: { x: 40, y: field7Y, width: 1000, height: 80 },
      },
      {
        ref: '@keyboard',
        index: 7,
        parentIndex: 1,
        type: 'Keyboard',
        hittable: true,
        rect: { x: 0, y: 1400, width: 1080, height: 1000 },
      },
      ...(footer
        ? [
            {
              ref: '@footer',
              index: 8,
              parentIndex: 2,
              type: 'android.view.ViewGroup',
              hittable: true,
              rect: { x: 0, y: 1150, width: 1080, height: 250 },
            },
            {
              ref: '@submit',
              index: 9,
              parentIndex: 8,
              type: 'android.widget.Button',
              label: 'Submit',
              hittable: true,
              rect: { x: 40, y: 1170, width: 1000, height: 210 },
            },
          ]
        : []),
      ...extra,
    ],
    [],
  );
}

const field7 = (screen: Screen) => screen.elements.find((e) => e.ref === '@field7')!;

test('a sticky footer over the list ends the clearance band at its top', () => {
  const screen = form();
  assert.deepEqual(clearanceBand(field7(screen), screen), {
    x: 0,
    y: 300,
    width: 1080,
    height: 850,
  });
});

test('without an overlay the band is the list clear of the keyboard edge', () => {
  const screen = form([], false);
  assert.deepEqual(clearanceBand(field7(screen), screen), {
    x: 0,
    y: 300,
    width: 1080,
    height: 1400 - KEYBOARD_EDGE_INSET - 300,
  });
});

test('the clearance distance aims at the middle of the band above the footer', () => {
  const screen = form();
  assert.equal(keyboardClearance(field7(screen), screen), 1900 - 725);
});

test("rows inside the target's own list never shrink the band", () => {
  const row = (ref: string, index: number, y: number): NativeNode => ({
    ref,
    index,
    parentIndex: 5,
    type: 'android.widget.EditText',
    hittable: true,
    rect: { x: 40, y, width: 1000, height: 80 },
  });
  for (const [y, footer, height] of [
    [1300, false, 1400 - KEYBOARD_EDGE_INSET - 300],
    [1100, true, 850],
  ] as const) {
    const screen = form([row('@field6', 10, y)], footer);
    assert.deepEqual(clearanceBand(field7(screen), screen), { x: 0, y: 300, width: 1080, height });
  }
});

test('a narrow floating button never shrinks the band', () => {
  const screen = form(
    [
      {
        ref: '@fab',
        index: 10,
        parentIndex: 2,
        type: 'android.widget.Button',
        label: 'Add',
        hittable: true,
        rect: { x: 840, y: 1200, width: 200, height: 250 },
      },
    ],
    false,
  );
  assert.deepEqual(clearanceBand(field7(screen), screen)?.height, 1400 - KEYBOARD_EDGE_INSET - 300);
});

test('a sticky header across the band top raises the band below it', () => {
  const screen = form([
    {
      ref: '@sticky',
      index: 10,
      parentIndex: 2,
      type: 'android.view.ViewGroup',
      hittable: true,
      rect: { x: 0, y: 300, width: 1080, height: 120 },
    },
  ]);
  assert.deepEqual(clearanceBand(field7(screen), screen), {
    x: 0,
    y: 420,
    width: 1080,
    height: 730,
  });
});

// iOS keyboard form in points: list clip 0-538 down to the keyboard top, sticky footer 432-538 beside it.
const IOS = { x: 0, y: 0, width: 402, height: 874 };
const K = 538;
const F = K - 106;

function iosForm(
  centre: number,
  { extra = [] as NativeNode[], footer = { y: F, height: K - F }, list = K } = {},
): Screen {
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: IOS },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: IOS },
      { ref: '@root', index: 2, parentIndex: 1, type: 'Other', rect: IOS },
      {
        ref: '@list',
        index: 3,
        parentIndex: 2,
        type: 'ScrollView',
        rect: { x: 0, y: 0, width: 402, height: list },
      },
      {
        ref: '@content',
        index: 4,
        parentIndex: 3,
        type: 'Other',
        rect: { x: 0, y: 0, width: 402, height: 1400 },
      },
      {
        ref: '@field8',
        index: 5,
        parentIndex: 4,
        type: 'TextField',
        identifier: 'qa-kb-input-8',
        hittable: true,
        rect: { x: 20, y: centre - 22, width: 362, height: 44 },
      },
      {
        ref: '@footer',
        index: 6,
        parentIndex: 2,
        type: 'Other',
        identifier: 'qa-kb-footer',
        hittable: true,
        rect: { x: 0, ...footer, width: 402 },
      },
      { ref: '@kw', index: 7, parentIndex: 0, type: 'Window', rect: IOS },
      {
        ref: '@keyboard',
        index: 8,
        parentIndex: 7,
        type: 'Keyboard',
        rect: { x: 0, y: K, width: 402, height: IOS.height - K },
      },
      {
        ref: '@return',
        index: 9,
        parentIndex: 8,
        type: 'Key',
        label: 'Return',
        hittable: true,
        rect: { x: 310, y: 780, width: 80, height: 50 },
      },
      ...extra,
    ],
    [],
  );
}

const byRef = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref)!;

test('a field parked under a sticky footer inside its list is covered and clears down to the band middle', () => {
  const centre = 480;
  const screen = iosForm(centre);
  const field8 = byRef(screen, '@field8');
  assert.equal(centreCovered(field8, screen), true);
  assert.equal(clearanceScroll(field8, screen), 'down');
  const distance = keyboardClearance(field8, screen);
  assert.equal(distance, centre - F / 2);
  const moved = iosForm(centre - distance!);
  const band = clearanceBand(byRef(moved, '@field8'), moved)!;
  assert.ok(centre - distance! >= band.y && centre - distance! < band.y + band.height);
  assert.equal(centreCovered(byRef(moved, '@field8'), moved), false);
});

test('a field already inside the band above the footer is not covered and gets no clearance', () => {
  const screen = iosForm(F - 40);
  const field8 = byRef(screen, '@field8');
  assert.equal(centreCovered(field8, screen), false);
  assert.equal(keyboardClearance(field8, screen), undefined);
});

test('a field under a sticky header inside its list is covered and clears up to the band middle', () => {
  const screen = iosForm(50, {
    extra: [
      {
        ref: '@header',
        index: 10,
        parentIndex: 2,
        type: 'Other',
        hittable: true,
        rect: { x: 0, y: 0, width: 402, height: 100 },
      },
    ],
  });
  const field8 = byRef(screen, '@field8');
  assert.deepEqual(clearanceBand(field8, screen), {
    x: 0,
    y: 100,
    width: 402,
    height: F - 100,
  });
  assert.equal(centreCovered(field8, screen), true);
  assert.equal(clearanceScroll(field8, screen), 'up');
  assert.equal(keyboardClearance(field8, screen), (100 + F) / 2 - 50);
});

test('a key on the keyboard stays exempt from footer and keyboard coverage', () => {
  const screen = iosForm(F - 40);
  assert.equal(centreCovered(byRef(screen, '@return'), screen), false);
});

test('a field under both the keyboard and the footer is covered once and clears to the band middle', () => {
  const centre = 570;
  const screen = iosForm(centre, {
    footer: { y: F, height: 600 - F },
    list: 800,
  });
  const field8 = byRef(screen, '@field8');
  let branch: string | undefined;
  assert.equal(
    centreCovered(field8, screen, (facts) => {
      branch = facts.branch;
    }),
    true,
  );
  assert.equal(branch, 'keyboard');
  assert.equal(keyboardClearance(field8, screen), centre - F / 2);
});

test('the Android field moved by its clearance rests inside the band and is no longer covered', () => {
  const screen = form();
  assert.equal(centreCovered(field7(screen), screen), true);
  const moved = form([], true, 1860 - keyboardClearance(field7(screen), screen)!);
  assert.equal(centreCovered(field7(moved), moved), false);
});

test('(q) rows of the screen behind the sheet never shrink the band of a row in the sheet list', () => {
  const screen = androidOptionSheet();
  assert.deepEqual(clearanceBand(byRef(screen, '@option-20'), screen), ANDROID_LIST);
});

// Option 17 stopped with its centre at 560, just above the keyboard top; option 20 sits at 720 under it.
const parked = () => iosOptionSheet(528);

test("(t) rows of the target's own list never shrink its band, even as direct children of the list", () => {
  const screen = parked();
  assert.deepEqual(clearanceBand(byRef(screen, '@option-20'), screen), {
    ...IOS_LIST,
    height: 568 - 48 - 357,
  });
});

// Option 20 remains beyond one clearance drag.
test('(u) one clearance swipe spans the band clear of the keyboard edge', () => {
  const screen = parked();
  const target = byRef(screen, '@option-20');
  const distance = keyboardClearance(target, screen);
  assert.equal(distance, 752 - (357 + 163 / 2));
  clearRefMap();
  updateRefMapFromFlat(
    [
      { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
      { ref: '@keyboard', type: 'Keyboard', rect: { x: 0, y: 568, width: 402, height: 306 } },
    ] as never,
    { snapshotGeneration: 1, keyboardVisible: true },
  );
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs(
      'down',
      0.6,
      undefined,
      distance,
      clearanceBand(target, screen),
    ).map(Number);
    assert.deepEqual([y1, y2], [504, 374]);
    assert.ok(y1 - y2 < 752 - 568, `${y1 - y2}`);
  } finally {
    clearRefMap();
  }
});

// A modal screen in its own window over the app: the app's full-width bar lies behind "Skip", never over it.
// A framed Application root shares an unclipped target's viewport and already excludes everything; without it the clip is the Window.
test("anything in the window behind a modal never shrinks the band of a header control in the modal's window", () => {
  for (const root of [{ rect: IOS }, {}]) {
    const screen = join(
      [
        { ref: '@app', index: 0, type: 'Application', ...root },
        { ref: '@win1', index: 1, parentIndex: 0, type: 'Window', rect: IOS },
        {
          ref: '@bar',
          index: 2,
          parentIndex: 1,
          type: 'Other',
          hittable: true,
          rect: { ...IOS, height: 120 },
        },
        { ref: '@win2', index: 3, parentIndex: 0, type: 'Window', rect: IOS },
        { ref: '@modal', index: 4, parentIndex: 3, type: 'Other', hittable: true, rect: IOS },
        {
          ref: '@skip',
          index: 5,
          parentIndex: 4,
          type: 'Button',
          label: 'Skip',
          hittable: true,
          rect: { x: 352, y: 73, width: 34, height: 24 },
        },
      ],
      [],
    );
    const skip = byRef(screen, '@skip');
    assert.equal(clearanceBand(skip, screen)?.y, 0);
    assert.equal(centreCovered(skip, screen), false);
  }
});
