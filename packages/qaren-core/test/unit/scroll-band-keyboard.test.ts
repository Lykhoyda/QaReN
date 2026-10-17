// A directional scroll never starts or ends on a visible keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildDirectionalScrollCliArgs } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');

const WINDOW = {
  ref: '@e0',
  type: 'Window',
  hittable: true,
  rect: { x: 0, y: 0, width: 390, height: 844 },
};
const KEYBOARD = { ref: '@e1', type: 'Keyboard', rect: { x: 0, y: 508, width: 390, height: 336 } };

function swipeYs(nodes: unknown[], keyboardVisible: boolean): number[] {
  clearRefMap();
  updateRefMapFromFlat(nodes as never, { snapshotGeneration: 1, keyboardVisible });
  try {
    return ['up', 'down'].flatMap((direction) => {
      const [, , y1, , y2] = buildDirectionalScrollCliArgs(direction as 'up', 0.6);
      return [Number(y1), Number(y2)];
    });
  } finally {
    clearRefMap();
  }
}

test('with the keyboard up, the scroll band stays above it', () => {
  for (const y of swipeYs([WINDOW, KEYBOARD], true)) assert.ok(y < KEYBOARD.rect.y, `${y}`);
});

test('without a keyboard the band is the full screen as before', () => {
  assert.ok(swipeYs([WINDOW], false).some((y) => y > KEYBOARD.rect.y));
});

function clearanceSwipe(distance: number): number[] {
  clearRefMap();
  updateRefMapFromFlat([WINDOW, KEYBOARD] as never, {
    snapshotGeneration: 1,
    keyboardVisible: true,
  });
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs('down', 0.6, undefined, distance);
    return [Number(y1), Number(y2)];
  } finally {
    clearRefMap();
  }
}

test('a clearance distance sizes the swipe, inside the band above the keyboard', () => {
  const [y1, y2] = clearanceSwipe(300);
  assert.equal(y1 - y2, 300);
  assert.ok(y1 < KEYBOARD.rect.y && y2 >= 0, `${y1} ${y2}`);
});

test('a clearance swipe longer than the band keeps clear of the band edges', () => {
  // Chrome above the keyboard and the top bar sit at the band edges, outside the scrolled content.
  const [y1, y2] = clearanceSwipe(5000);
  assert.ok(y1 <= KEYBOARD.rect.y * 0.8 + 1 && y2 >= KEYBOARD.rect.y * 0.2 - 1, `${y1} ${y2}`);
  assert.ok(y1 - y2 >= KEYBOARD.rect.y * 0.6 - 2, `${y1 - y2}`);
});

test('a clearance scroll inside a named band starts and ends inside that band above the keyboard', () => {
  clearRefMap();
  updateRefMapFromFlat([WINDOW, KEYBOARD] as never, {
    snapshotGeneration: 1,
    keyboardVisible: true,
  });
  try {
    const [, x1, y1, , y2] = buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, {
      x: 0,
      y: 300,
      width: 390,
      height: 500,
    }).map(Number);
    assert.equal(x1, 195);
    for (const y of [y1, y2]) assert.ok(y >= 300 && y < KEYBOARD.rect.y, `${y}`);
    assert.ok(y1 > y2, `${y1} ${y2}`);
  } finally {
    clearRefMap();
  }
});

// An Android form: the walker's band is the list above its sticky footer (y 300-1150).
test('a clearance distance inside a named band spans the whole band, a pixel inside each edge', () => {
  clearRefMap();
  updateRefMapFromFlat(
    [
      { ...WINDOW, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ...KEYBOARD, rect: { x: 0, y: 1400, width: 1080, height: 1000 } },
    ] as never,
    { snapshotGeneration: 1, keyboardVisible: true },
  );
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs('down', 0.6, undefined, 1175, {
      x: 0,
      y: 300,
      width: 1080,
      height: 850,
    }).map(Number);
    assert.ok(Math.abs(y1 - 1149) <= 1 && Math.abs(y2 - 301) <= 1, `${y1} ${y2}`);
    assert.ok(y1 - y2 >= 800, `${y1 - y2}`);
  } finally {
    clearRefMap();
  }
});

test('a clearance distance without a named band keeps the window cap', () => {
  const [y1, y2] = clearanceSwipe(5000);
  assert.ok(Math.abs(y1 - y2 - Math.round(KEYBOARD.rect.y * 0.6)) <= 1, `${y1 - y2}`);
});
