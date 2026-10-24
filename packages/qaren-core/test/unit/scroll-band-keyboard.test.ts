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
  assert.deepEqual(swipeYs([WINDOW, KEYBOARD], true), [193, 315, 315, 193]);
  for (const y of swipeYs([WINDOW, KEYBOARD], true)) assert.ok(y < KEYBOARD.rect.y, `${y}`);
});

test('a plain scroll with no container uses a centred drag despite the cached screen origin', () => {
  clearRefMap();
  updateRefMapFromFlat([{ ...WINDOW, rect: { x: 0, y: 0, width: 402, height: 874 } }] as never, {
    snapshotGeneration: 1,
    keyboardVisible: false,
  });
  try {
    assert.deepEqual(buildDirectionalScrollCliArgs('down'), [
      'scroll',
      '201',
      '525',
      '201',
      '349',
      '300',
    ]);
    assert.deepEqual(buildDirectionalScrollCliArgs('down', 0.6), [
      'scroll',
      '201',
      '542',
      '201',
      '332',
      '300',
    ]);
    assert.deepEqual(buildDirectionalScrollCliArgs('down', 0.6, undefined, 5000), [
      'scroll',
      '201',
      '699',
      '201',
      '175',
      '300',
    ]);
  } finally {
    clearRefMap();
  }
});

test('without a keyboard an explicit container band keeps its dead zone', () => {
  clearRefMap();
  updateRefMapFromFlat([WINDOW] as never, { snapshotGeneration: 1, keyboardVisible: false });
  try {
    assert.deepEqual(
      buildDirectionalScrollCliArgs('down', 0.6, undefined, undefined, {
        x: 20,
        y: 100,
        width: 360,
        height: 600,
      }),
      ['scroll', '200', '640', '200', '160', '300'],
    );
  } finally {
    clearRefMap();
  }
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
test('a clearance distance inside a named band keeps its dead zone', () => {
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
    assert.ok(Math.abs(y1 - 1065) <= 1 && Math.abs(y2 - 385) <= 1, `${y1} ${y2}`);
    assert.ok(y1 - y2 >= 680, `${y1 - y2}`);
  } finally {
    clearRefMap();
  }
});

test('a clearance distance without a named band keeps the window cap', () => {
  const [y1, y2] = clearanceSwipe(5000);
  assert.ok(Math.abs(y1 - y2 - Math.round(KEYBOARD.rect.y * 0.6)) <= 1, `${y1 - y2}`);
});

// The keyboard form's band ends at its sticky footer's first row; a drag starting there lands on the footer.
function bandDragYs(direction: 'up' | 'down', band: { y: number; height: number }): number[] {
  clearRefMap();
  updateRefMapFromFlat(
    [
      { ...WINDOW, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ...KEYBOARD, rect: { x: 0, y: 1517, width: 1080, height: 883 } },
    ] as never,
    { snapshotGeneration: 1, keyboardVisible: true },
  );
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs(direction, 0.6, undefined, 1290, {
      x: 0,
      width: 1080,
      ...band,
    }).map(Number);
    return [y1, y2];
  } finally {
    clearRefMap();
  }
}

for (const height of [1045, 1044]) {
  test(`a clearance drag over a ${height}px band starts and ends strictly inside it`, () => {
    const band = { y: 283, height };
    for (const direction of ['down', 'up'] as const) {
      const ys = bandDragYs(direction, band);
      assert.ok(Math.max(...ys) <= band.y + height - 1, `${direction} ${ys}`);
      assert.ok(Math.min(...ys) >= band.y + 1, `${direction} ${ys}`);
      assert.ok(Math.abs(ys[0] - ys[1]) >= Math.floor(height * 0.8) - 2, `${direction} ${ys}`);
    }
  });
}

function bandedYs(band: { y: number; height: number }, distance?: number): number[] {
  clearRefMap();
  updateRefMapFromFlat([WINDOW, KEYBOARD] as never, {
    snapshotGeneration: 1,
    keyboardVisible: true,
  });
  try {
    const [, , y1, , y2] = buildDirectionalScrollCliArgs('down', 0.6, undefined, distance, {
      x: 0,
      width: 390,
      ...band,
    }).map(Number);
    return [y1, y2];
  } finally {
    clearRefMap();
  }
}

test('(w1) a scroll without a distance spans its named band above the keyboard', () => {
  assert.deepEqual(bandedYs({ y: 300, height: 500 }), [487, 321]);
});

test('(w2) a band too short for a real drag refuses before anything is built', () => {
  assert.throws(() => bandedYs({ y: 300, height: 49 }), /SCROLL_BAND_TOO_SMALL/);
  const [y1, y2] = bandedYs({ y: 300, height: 50 });
  assert.equal(y1 - y2, 48);
});

test('(w3) a clearance distance shorter than a real drag drags the minimum', () => {
  const [y1, y2] = bandedYs({ y: 300, height: 100 }, 10);
  assert.equal(y1 - y2, 48);
});

for (const direction of ['up', 'down'] as const) {
  for (const distance of [undefined, 10, 5000]) {
    test(`no-band ${direction} preserves centered travel with a 160px keyboard-safe height and distance=${distance}`, () => {
      clearRefMap();
      updateRefMapFromFlat([
        WINDOW,
        { ...KEYBOARD, rect: { ...KEYBOARD.rect, y: 160 } },
      ], { snapshotGeneration: 1, keyboardVisible: true });
      try {
        const half = distance === undefined ? 19 : distance === 10 ? 5 : 48;
        const ys = direction === 'down' ? [80 + half, 80 - half] : [80 - half, 80 + half];
        assert.deepEqual(buildDirectionalScrollCliArgs(direction, 0.6, undefined, distance),
          ['scroll', '195', String(ys[0]), '195', String(ys[1]), '300']);
      } finally {
        clearRefMap();
      }
    });
  }
}
