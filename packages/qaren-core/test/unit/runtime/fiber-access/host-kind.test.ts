import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOST_KIND_LOOKUP,
  hostKind,
  isHostFiber,
} from '../../../../dist/runtime/fiber-access/host-kind.js';
import { INPUT_HOST_TYPES } from '../../../../dist/qa/input-host-types.js';
import { base, outcome } from './base-implementation.ts';

const FIBERS: unknown[] = [
  undefined,
  null,
  0,
  {},
  { type: null },
  { type: '' },
  { tag: 5 },
  { tag: 5, type: null },
  { tag: 6, type: 'RCTText' },
  { tag: 6, type: { displayName: 'Text' } },
  { type: 'RCTText' },
  { type: 'RCTView' },
  { type: 'constructor' },
  { type: '__proto__' },
  { type: 'hasOwnProperty' },
  { type: { displayName: 'Image' } },
  { type: { displayName: '', name: 'Switch' } },
  { type: { displayName: 5 } },
  { type: { name: 'Modal' } },
  { type: { displayName: 'MyButton', name: 'Text' } },
  { type: 7 },
  { type: true },
  ...INPUT_HOST_TYPES.map((type) => ({ tag: 5, type })),
];

test('G: hostKind and isHostFiber classify every corpus fiber as the base program did', () => {
  for (const [index, fiber] of FIBERS.entries()) {
    assert.deepEqual(
      outcome(() => hostKind(fiber as never)),
      outcome(() => base.hostKind!(fiber)),
      `hostKind ${index}`,
    );
    assert.deepEqual(
      outcome(() => isHostFiber(fiber as never)),
      outcome(() => base.isHostFiber!(fiber)),
      `isHostFiber ${index}`,
    );
  }
});

test('G: the lookup table maps the same platform names in the same order', () => {
  assert.deepEqual(Object.entries(HOST_KIND_LOOKUP), Object.entries(base.HOST_KIND_LOOKUP));
  assert.equal(Object.getPrototypeOf(HOST_KIND_LOOKUP), Object.prototype);
});
