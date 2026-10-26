import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../../dist/ring-buffer.js';

// ── constructor ───────────────────────────────────────────────────────

test('new RingBuffer has size 0', () => {
  const buf = new RingBuffer(5);
  assert.equal(buf.size, 0);
});

test('getLast(n) on empty buffer returns []', () => {
  const buf = new RingBuffer(5);
  assert.deepEqual(buf.getLast(3), []);
});

// ── push + getLast ────────────────────────────────────────────────────

test('push items and getLast retrieves in insertion order', () => {
  const buf = new RingBuffer(5);
  buf.push('a');
  buf.push('b');
  buf.push('c');
  assert.deepEqual(buf.getLast(3), ['a', 'b', 'c']);
  assert.equal(buf.size, 3);
});

test('getLast(n) where n > count returns all items', () => {
  const buf = new RingBuffer(5);
  buf.push('a');
  buf.push('b');
  assert.deepEqual(buf.getLast(10), ['a', 'b']);
});

test('getLast(0) returns empty array', () => {
  const buf = new RingBuffer(5);
  buf.push('a');
  assert.deepEqual(buf.getLast(0), []);
});

// ── overflow (circular wrap) ──────────────────────────────────────────

test('push beyond capacity evicts oldest items', () => {
  const buf = new RingBuffer(3);
  buf.push('a');
  buf.push('b');
  buf.push('c');
  buf.push('d'); // evicts 'a'
  assert.equal(buf.size, 3);
  assert.deepEqual(buf.getLast(3), ['b', 'c', 'd']);
});

test('double wrap-around preserves order', () => {
  const buf = new RingBuffer(3);
  for (let i = 0; i < 9; i++) buf.push(i);
  assert.deepEqual(buf.getLast(3), [6, 7, 8]);
  assert.equal(buf.size, 3);
});

test('capacity 1 always holds the last item', () => {
  const buf = new RingBuffer(1);
  buf.push('a');
  buf.push('b');
  buf.push('c');
  assert.equal(buf.size, 1);
  assert.deepEqual(buf.getLast(1), ['c']);
});

// ── filter ────────────────────────────────────────────────────────────

test('filter returns matching items in order', () => {
  const buf = new RingBuffer(10);
  buf.push({ level: 'error', msg: 'fail' });
  buf.push({ level: 'info', msg: 'ok' });
  buf.push({ level: 'error', msg: 'crash' });
  const errors = buf.filter((e) => e.level === 'error');
  assert.deepEqual(errors, [
    { level: 'error', msg: 'fail' },
    { level: 'error', msg: 'crash' },
  ]);
});

test('filter returns [] when nothing matches', () => {
  const buf = new RingBuffer(5);
  buf.push(1);
  buf.push(2);
  assert.deepEqual(
    buf.filter((x) => x > 10),
    [],
  );
});

// ── findLast ──────────────────────────────────────────────────────────

test('findLast returns most recent match', () => {
  const buf = new RingBuffer(10);
  buf.push({ id: 1, status: 200 });
  buf.push({ id: 2, status: 404 });
  buf.push({ id: 3, status: 200 });
  const found = buf.findLast((e) => e.status === 200);
  assert.deepEqual(found, { id: 3, status: 200 });
});

test('findLast returns undefined when nothing matches', () => {
  const buf = new RingBuffer(5);
  buf.push('a');
  buf.push('b');
  assert.equal(
    buf.findLast((x) => x === 'z'),
    undefined,
  );
});

test('findLast on empty buffer returns undefined', () => {
  const buf = new RingBuffer(5);
  assert.equal(
    buf.findLast(() => true),
    undefined,
  );
});

// ── clear ─────────────────────────────────────────────────────────────

test('clear resets size to 0', () => {
  const buf = new RingBuffer(5);
  buf.push('a');
  buf.push('b');
  buf.clear();
  assert.equal(buf.size, 0);
  assert.deepEqual(buf.getLast(5), []);
});

test('push after clear works correctly', () => {
  const buf = new RingBuffer(3);
  buf.push('a');
  buf.push('b');
  buf.clear();
  buf.push('x');
  assert.equal(buf.size, 1);
  assert.deepEqual(buf.getLast(3), ['x']);
});

// ── indexKey (D632, S2) ──────────────────────────────────────────────

test('getByKey returns undefined when no indexKey is configured', () => {
  const buf = new RingBuffer(5);
  buf.push({ id: 'a' });
  assert.equal(buf.getByKey('a'), undefined);
});

test('getByKey returns the item when indexKey matches', () => {
  const buf = new RingBuffer(5, { indexKey: (e) => e.id });
  const item = { id: 'req1', url: '/a' };
  buf.push(item);
  assert.equal(buf.getByKey('req1'), item);
});

test('getByKey returns undefined for unknown key', () => {
  const buf = new RingBuffer(5, { indexKey: (e) => e.id });
  buf.push({ id: 'req1' });
  assert.equal(buf.getByKey('missing'), undefined);
});

test('getByKey returns undefined for evicted entries after overwrite', () => {
  const buf = new RingBuffer(3, { indexKey: (e) => e.id });
  buf.push({ id: 'a' });
  buf.push({ id: 'b' });
  buf.push({ id: 'c' });
  buf.push({ id: 'd' }); // evicts 'a'
  assert.equal(buf.getByKey('a'), undefined);
  assert.equal(buf.getByKey('b').id, 'b');
  assert.equal(buf.getByKey('d').id, 'd');
});

test('getByKey returns latest entry when key is reused', () => {
  const buf = new RingBuffer(5, { indexKey: (e) => e.id });
  const first = { id: 'x', n: 1 };
  const second = { id: 'x', n: 2 };
  buf.push(first);
  buf.push(second);
  assert.equal(buf.getByKey('x'), second);
});

test('clear wipes the index', () => {
  const buf = new RingBuffer(5, { indexKey: (e) => e.id });
  buf.push({ id: 'a' });
  buf.clear();
  assert.equal(buf.getByKey('a'), undefined);
});

test('indexKey returning undefined is ignored', () => {
  const buf = new RingBuffer(5, { indexKey: (e) => e.id });
  buf.push({ url: '/no-id' });
  buf.push({ id: 'has-id' });
  assert.equal(buf.getByKey('has-id').id, 'has-id');
  assert.equal(buf.size, 2);
});
