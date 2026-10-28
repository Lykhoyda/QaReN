import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import {
  changedPixels,
  cropPng,
  decodePng,
  stablePixelChange,
} from '../../../dist/qa/tap-pixels.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/tap-pixels/${name}.png`, import.meta.url));
const full = (name: string) => {
  const bytes = fixture(name),
    image = decodePng(bytes)!;
  return cropPng(bytes, { x: 0, y: 0, width: image.width / 3, height: image.height / 3 }, 3)!;
};

function png(
  width: number,
  height: number,
  channels: 3 | 4,
  raw: Uint8Array,
  depth = 8,
  interlace = 0,
) {
  const chunk = (type: string, bytes: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    const size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = channels === 3 ? 2 : 6;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodes RGB runner and RGBA simulator fixture crops', () => {
  for (const [name, width, height, channels] of [
    ['toggle1-before', 96, 96, 3],
    ['toggle1-after', 96, 96, 3],
    ['chip-before', 172, 84, 3],
    ['chip-after', 172, 84, 3],
    ['moved-before', 96, 96, 3],
    ['moved-after', 96, 96, 3],
    ['spinner-a', 120, 120, 4],
    ['spinner-b', 120, 120, 4],
    ['transition-mid', 420, 140, 4],
    ['transition-settled', 420, 140, 4],
  ] as const) {
    const image = decodePng(fixture(name));
    assert.ok(image, name);
    assert.deepEqual(
      [image.width, image.height, image.channels, image.data.length],
      [width, height, channels, width * height * channels],
    );
  }
});

test('fixture differences separate a real toggle, an unchanged chip, and unstable frames', () => {
  const toggle = full('toggle1-before'),
    checked = full('toggle1-after');
  assert.ok(changedPixels(toggle, checked)! > toggle.width * toggle.height * 0.35);
  assert.equal(stablePixelChange(toggle, checked, checked), true);
  assert.equal(changedPixels(full('chip-before'), full('chip-after')), 0);
  const moved = full('moved-before'),
    shifted = full('moved-after');
  assert.ok(changedPixels(moved, shifted)! > moved.width * moved.height * 0.07);
  for (const [a, b] of [
    ['spinner-a', 'spinner-b'],
    ['transition-mid', 'transition-settled'],
  ]) {
    assert.equal(stablePixelChange(full(a), full(a), full(b)), false);
  }
});

test('reconstructs all five PNG row filters', () => {
  const pixels = [20, 40, 60, 80, 100, 120, 30, 50, 70, 90, 110, 130];
  for (let filter = 0; filter <= 4; filter++) {
    const raw: number[] = [];
    for (let row = 0; row < 2; row++) {
      raw.push(filter);
      for (let x = 0; x < 6; x++) {
        const i = row * 6 + x;
        const a = x >= 3 ? pixels[i - 3] : 0,
          b = row ? pixels[i - 6] : 0,
          c = row && x >= 3 ? pixels[i - 9] : 0;
        const p = a + b - c;
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? Math.floor((a + b) / 2)
                  : [a, b, c].reduce((best, value) =>
                      Math.abs(p - value) < Math.abs(p - best) ? value : best,
                    );
        raw.push((pixels[i] - predictor) & 255);
      }
    }
    assert.deepEqual([...decodePng(png(2, 2, 3, Uint8Array.from(raw)))!.data], pixels);
  }
});

test('crops in scaled coordinates, rounds, clamps, and rejects empty or transparent crops', () => {
  const bytes = png(2, 1, 3, Uint8Array.from([0, 10, 20, 30, 40, 50, 60]));
  const crop = cropPng(bytes, { x: -1 / 3, y: 0, width: 1, height: 1 / 3 }, 3)!;
  assert.deepEqual(
    [crop.x, crop.y, crop.width, crop.height, ...crop.rgb],
    [0, 0, 2, 1, 10, 20, 30, 40, 50, 60],
  );
  assert.equal(cropPng(bytes, { x: 1, y: 0, width: 1, height: 1 }, 3), undefined);
  assert.equal(cropPng(bytes, { x: 0, y: 0, width: 1, height: 1 }, NaN), undefined);
  assert.equal(
    cropPng(
      png(1, 1, 4, Uint8Array.from([0, 255, 0, 0, 0])),
      { x: 0, y: 0, width: 1, height: 1 },
      1,
    ),
    undefined,
  );
});

test('derives the scale from the app root size only when both axes agree', () => {
  const bytes = png(2, 1, 3, Uint8Array.from([0, 10, 20, 30, 40, 50, 60]));
  const frame = { x: 0, y: 0, width: 1, height: 1 / 2 };
  assert.deepEqual(
    [...cropPng(bytes, frame, { width: 1, height: 1 / 2 })!.rgb],
    [10, 20, 30, 40, 50, 60],
  );
  assert.equal(cropPng(bytes, frame, { width: 1, height: 1 }), undefined);
  assert.equal(cropPng(bytes, frame, { width: 0, height: 1 / 2 }), undefined);
});

test('invalid, truncated, corrupt, unsupported and oversized PNGs offer no proof', () => {
  const bytes = fixture('toggle1-before');
  const corrupt = Buffer.from(bytes);
  corrupt[45] ^= 1;
  for (const value of [
    Buffer.from('not PNG'),
    bytes.subarray(0, bytes.length - 1),
    corrupt,
    png(1, 1, 3, Uint8Array.from([0, 0, 0, 0]), 16),
    png(1, 1, 3, Uint8Array.from([0, 0, 0, 0]), 8, 1),
    png(100000, 100000, 3, Uint8Array.from([0])),
    png(1, 1, 3, Uint8Array.from([5, 0, 0, 0])),
    png(1, 1, 3, Uint8Array.from([0])),
  ])
    assert.equal(decodePng(value), undefined);
});

test('applies RGB delta, minimum changed area, and stability thresholds', () => {
  const blank = {
    x: 0,
    y: 0,
    width: 100,
    height: 10,
    imageWidth: 100,
    imageHeight: 10,
    rgb: new Uint8Array(3000),
  };
  const changed = (count: number, delta = 25) => {
    const rgb = new Uint8Array(3000);
    for (let i = 0; i < count; i++) rgb[i * 3] = delta;
    return { ...blank, rgb };
  };
  assert.equal(changedPixels(blank, changed(20, 24)), 0);
  assert.equal(stablePixelChange(blank, changed(15), changed(15)), false);
  assert.equal(stablePixelChange(blank, changed(16), changed(16)), true);
  assert.equal(stablePixelChange(blank, changed(16), changed(17)), true);
  assert.equal(stablePixelChange(blank, changed(16), changed(18)), false);
  assert.equal(stablePixelChange(blank, changed(20), { ...changed(20), imageWidth: 101 }), false);
});
