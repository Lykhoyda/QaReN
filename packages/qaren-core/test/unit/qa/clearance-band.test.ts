// Keyboard clearance on an Android form: the touchable band stops at overlay siblings over the clip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearanceBand, keyboardClearance } from '../../../dist/qa/resolve.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';

const WINDOW = { x: 0, y: 0, width: 1080, height: 2400 };

// Header 0-300, a ScrollView list 300-1400 over the keyboard top, a sticky footer sibling 1150-1400.
function form(extra: NativeNode[] = [], footer = true): Screen {
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
        rect: { x: 40, y: 1860, width: 1000, height: 80 },
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

test('without an overlay the band is the list above the keyboard', () => {
  const screen = form([], false);
  assert.deepEqual(clearanceBand(field7(screen), screen), {
    x: 0,
    y: 300,
    width: 1080,
    height: 1100,
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
    [1300, false, 1100],
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
  assert.deepEqual(clearanceBand(field7(screen), screen)?.height, 1100);
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
