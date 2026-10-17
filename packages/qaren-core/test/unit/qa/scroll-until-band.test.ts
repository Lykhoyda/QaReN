// Scroll-until band: the drag starts inside the scroll container it is meant to move.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStep } from '../../../dist/qa/plan.js';
import { clearanceBand, scrollUntilBand } from '../../../dist/qa/resolve.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';

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

test('(b) a keyboard cutting the list keeps only the part above it', () => {
  assert.deepEqual(scrollUntilBand(option20, androidSheet([keyboard(7)])), {
    ...LIST,
    height: 230,
  });
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
  assert.deepEqual(band, { x: 0, y: 300, width: 400, height: 200 });
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
