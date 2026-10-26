import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectionalScrollCliArgs } from '../../dist/handlers/device-interact.js';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';

// Audit H2/H3: a direction-form scroll must be dispatched as the COORDINATE
// form. The arg builders map scroll → a 4-coordinate drag and throw on the
// direction form, so the old ['scroll', direction] shape crashed device_scroll
// on Android and device_batch scroll on both platforms.

test('H2/H3: buildDirectionalScrollCliArgs emits the coordinate form', () => {
  const args = buildDirectionalScrollCliArgs('down');
  assert.equal(args[0], 'scroll');
  assert.equal(args.length, 6, "['scroll', x1, y1, x2, y2, duration]");
  for (const n of args.slice(1)) {
    assert.ok(/^\d+$/.test(n), `expected numeric coordinate, got "${n}"`);
  }
});

test('H2/H3: the emitted scroll args pass through buildRunAndroidArgs without throwing', () => {
  const args = buildDirectionalScrollCliArgs('up');
  const out = buildRunAndroidArgs(args, 'com.example.app');
  assert.equal(out.command, 'drag');
  assert.equal(typeof out.x1, 'number');
});

test('H2/H3: the emitted scroll args pass through buildRunIOSArgs without throwing', () => {
  const args = buildDirectionalScrollCliArgs('left');
  const out = buildRunIOSArgs(args, 'com.example.app');
  assert.equal(out.command, 'drag');
  assert.equal(typeof out.x, 'number');
});

test('H2/H3 regression: the OLD direction form still throws (proves the builders reject it)', () => {
  assert.throws(() => buildRunAndroidArgs(['scroll', 'down'], 'app'), /four numeric coordinates/);
  assert.throws(() => buildRunIOSArgs(['scroll', 'down'], 'app'), /four numeric coordinates/);
});

test('H2/H3: scroll direction is inverted vs swipe (scroll down = finger up)', () => {
  const down = buildDirectionalScrollCliArgs('down'); // [scroll, x1, y1, x2, y2, dur]
  const y1 = Number(down[2]);
  const y2 = Number(down[4]);
  assert.ok(y1 > y2, 'scroll down should move the finger upward (y1 > y2)');
});

// Audit M7: a coordinate swipe with --count but no durationMs must not let the
// count value leak into the duration slot on iOS.
test('M7: --count value does not corrupt iOS swipe durationMs', () => {
  // canUseFastRunner is false when count is set, so this argv reaches buildRunIOSArgs.
  const cli = ['swipe', '100', '200', '100', '400', '--count', '3'];
  const out = buildRunIOSArgs(cli, 'com.example.app');
  assert.equal(out.command, 'drag');
  assert.equal(out.x, 100);
  assert.equal(out.y, 200);
  assert.equal(out.x2, 100);
  assert.equal(out.y2, 400);
  // The '3' from --count must NOT have been parsed as a 3ms duration.
  assert.notEqual(out.durationMs, 3, '--count value leaked into durationMs (3ms flick)');
  assert.equal(out.durationMs, undefined, 'no durationMs was supplied, so none should be set');
});

test('M7: an explicit durationMs IS still honored alongside --count', () => {
  const cli = ['swipe', '100', '200', '100', '400', '500', '--count', '3'];
  const out = buildRunIOSArgs(cli, 'com.example.app');
  assert.equal(out.durationMs, 500, 'the real duration positional must survive flag stripping');
});
