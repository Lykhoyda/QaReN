import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrollArgs } from '../../../dist/qa/walk.js';

test('a keyboard clearance scroll passes the overlap distance to the shared handler', () => {
  assert.deepEqual(scrollArgs('down', 300), { direction: 'down', amount: 0.6, distance: 300 });
});

test('a keyboard clearance scroll passes the visible band of the target clip', () => {
  const within = { x: 0, y: 300, width: 400, height: 200 };
  assert.deepEqual(scrollArgs('down', 300, within), {
    direction: 'down',
    amount: 0.6,
    distance: 300,
    within,
  });
});

test('a scroll without keyboard clearance keeps the fixed amount and omits distance', () => {
  assert.deepEqual(scrollArgs('down'), { direction: 'down', amount: 0.6 });
});
