import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSnapshotNodes } from '../../dist/handlers/device-interact.js';

// GH #59 #4: AMBIGUOUS_MATCH from device_find returned candidates in
// arbitrary order — agents had to trial-and-error pick the right ref.
// rankSnapshotNodes orders candidates so the most-likely tap target sits
// at index 0. Reporter's case: iOS share sheet "Copy" matched 5 elements
// (ScrollView, Cell, Other, Other, StaticText), all hittable: false; the
// actual tap target was the Cell. Ranking should surface Cell first.

const node = (overrides = {}) => ({
  ref: 'r1',
  type: 'Other',
  hittable: false,
  ...overrides,
});

// ── Type priority is primary; hittable breaks ties (#519 review) ──
// Post-#395, iOS hittable means "enabled AND center-on-screen" — an inert
// on-screen StaticText is legitimately hittable, so a dominant hittable bonus
// would steer taps to body text over a real control half-scrolled off-screen.

test('type priority beats hittable across types', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'a', type: 'Cell', hittable: false }),
    node({ ref: 'b', type: 'StaticText', hittable: true }),
  ]);
  assert.equal(ranked[0].ref, 'a', 'non-hittable Cell beats hittable StaticText');
});

test('#519 review scenario: half-visible Button beats on-screen label text', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'label', type: 'StaticText', hittable: true }),
    node({ ref: 'submit', type: 'Button', hittable: false }),
  ]);
  assert.equal(ranked[0].ref, 'submit', 'real control outranks matching inert text');
});

test('same type: hittable breaks the tie', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'offscreen', type: 'Button', hittable: false }),
    node({ ref: 'onscreen', type: 'Button', hittable: true }),
  ]);
  assert.deepEqual(
    ranked.map((n) => n.ref),
    ['onscreen', 'offscreen'],
    'on-screen Button first among same-type candidates',
  );
});

test('all hittable: ordered by type priority', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'a', type: 'StaticText', hittable: true }),
    node({ ref: 'b', type: 'Button', hittable: true }),
    node({ ref: 'c', type: 'Cell', hittable: true }),
  ]);
  assert.deepEqual(
    ranked.map((n) => n.ref),
    ['b', 'c', 'a'],
    'Button > Cell > StaticText when all hittable',
  );
});

// ── Type priority when nothing is hittable (the reporter's case) ──

test('reporter scenario: iOS share-sheet Copy candidates, none hittable', () => {
  // Order in input is the same as agent-device returned them.
  const ranked = rankSnapshotNodes([
    node({ ref: '1', type: 'ScrollView', hittable: false }),
    node({ ref: '2', type: 'Cell', hittable: false }),
    node({ ref: '3', type: 'Other', hittable: false }),
    node({ ref: '4', type: 'Other', hittable: false }),
    node({ ref: '5', type: 'StaticText', hittable: false }),
  ]);
  // Cell should come first (highest tap-intent score among non-hittable types).
  assert.equal(ranked[0].ref, '2', 'Cell ranked first among non-hittable mix');
  assert.equal(ranked[ranked.length - 1].ref, '1', 'ScrollView (lowest priority) ranked last');
});

test('Other > StaticText > ScrollView', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'st', type: 'StaticText' }),
    node({ ref: 'sv', type: 'ScrollView' }),
    node({ ref: 'o', type: 'Other' }),
  ]);
  assert.deepEqual(
    ranked.map((n) => n.ref),
    ['o', 'st', 'sv'],
  );
});

// ── Stable for equal scores ──

test('equal-score nodes preserve original order (stable sort)', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'a', type: 'Other' }),
    node({ ref: 'b', type: 'Other' }),
    node({ ref: 'c', type: 'Other' }),
  ]);
  assert.deepEqual(
    ranked.map((n) => n.ref),
    ['a', 'b', 'c'],
  );
});

// ── Rect dedupe ──

test('dedupes by rect — keeps higher-scored node when bounds match', () => {
  // Cell wrapping a StaticText with identical bounds.
  const sharedRect = { x: 100, y: 200, width: 80, height: 40 };
  const ranked = rankSnapshotNodes([
    node({ ref: 'inner', type: 'StaticText', rect: sharedRect }),
    node({ ref: 'outer', type: 'Cell', rect: { ...sharedRect } }),
  ]);
  assert.equal(ranked.length, 1, 'duplicate-rect collapses to one entry');
  assert.equal(ranked[0].ref, 'outer', 'higher-scored Cell survives dedupe');
});

test('dedupe ignores sub-pixel rect drift via Math.round', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'a', type: 'StaticText', rect: { x: 100.1, y: 200.0, width: 80.4, height: 40.0 } }),
    node({ ref: 'b', type: 'Cell', rect: { x: 100.0, y: 199.9, width: 80.2, height: 40.4 } }),
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].ref, 'b');
});

test('different rects are kept separately', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'a', type: 'Cell', rect: { x: 0, y: 0, width: 100, height: 50 } }),
    node({ ref: 'b', type: 'Cell', rect: { x: 0, y: 100, width: 100, height: 50 } }),
  ]);
  assert.equal(ranked.length, 2);
});

test('nodes without rect are not deduped against each other', () => {
  // Without a rect, we cannot tell if two nodes overlap — keep both.
  const ranked = rankSnapshotNodes([
    node({ ref: 'a', type: 'Cell' }),
    node({ ref: 'b', type: 'Cell' }),
  ]);
  assert.equal(ranked.length, 2);
});

// ── Edge cases ──

test('empty input returns empty array', () => {
  assert.deepEqual(rankSnapshotNodes([]), []);
});

test('unknown type falls in mid-tier', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'sv', type: 'ScrollView' }),
    node({ ref: 'unknown', type: 'WeirdNewType' }),
    node({ ref: 'st', type: 'StaticText' }),
  ]);
  // Unknown gets default 50, StaticText is 30, ScrollView is 10
  assert.deepEqual(
    ranked.map((n) => n.ref),
    ['unknown', 'st', 'sv'],
  );
});

test('missing type field falls in mid-tier (same as unknown)', () => {
  const ranked = rankSnapshotNodes([
    node({ ref: 'noType', type: undefined }),
    node({ ref: 'sv', type: 'ScrollView' }),
  ]);
  assert.equal(ranked[0].ref, 'noType', 'missing type beats explicitly low-priority types');
});
