// Story 05 (#386) final-review fix (MINOR): buildRunAndroidArgs' longpress
// case resolved `@ref` coordinates via a bare `refCenter(target)` call —
// unlike the tap/type cases in the same function (and unlike iOS), which both
// gate on `isRefMapFresh() ? refCenter(ref) : null`. An over-age Android
// longpress @ref served stale coordinates (a wrong-element long-press) instead
// of falling into the `_staleRef` → heal path the rest of the dispatch relies
// on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';

test('buildRunAndroidArgs longpress on an empty ref map heals via _staleRef, preserving durationMs', () => {
  clearRefMap();
  const args = buildRunAndroidArgs(['longpress', '@e3', '500']);
  assert.deepEqual(args, { command: 'longPress', _staleRef: '@e3', durationMs: 500 });
});

test('regression: an over-age (but still populated) ref map must NOT serve stale longpress coords', (t) => {
  updateRefMapFromFlat([
    { ref: '@e3', type: 'Button', rect: { x: 100, y: 200, width: 40, height: 40 } },
  ]);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.tick(61_000); // exceeds MAX_REF_MAP_AGE_MS (60s)
  try {
    const args = buildRunAndroidArgs(['longpress', '@e3', '500']);
    assert.deepEqual(
      args,
      { command: 'longPress', _staleRef: '@e3', durationMs: 500 },
      'an over-age ref map must be treated as stale, not served as live coordinates',
    );
  } finally {
    clearRefMap();
  }
});

test('a FRESH ref map still resolves longpress @ref to live coordinates', () => {
  updateRefMapFromFlat([
    { ref: '@e3', type: 'Button', rect: { x: 100, y: 200, width: 40, height: 40 } },
  ]);
  try {
    const args = buildRunAndroidArgs(['longpress', '@e3', '500']);
    assert.deepEqual(args, { command: 'longPress', x: 120, y: 220, durationMs: 500 });
  } finally {
    clearRefMap();
  }
});
