// GH #1057 — frontmost hidden/pointer predicates read style keys directly.
// Enumerating exotic style objects with hasOwnProperty aborted the scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function hiddenForStyle(style: unknown) {
  const root = buildFiber({ name: 'View', props: {}, children: [] }, null);
  const leaf = buildFiber({ name: 'View', props: { style }, children: [] }, root);
  root.child = leaf;
  const sandbox = createSandbox({ fiberRoot: root }) as {
    __QAREN: { __hidden: (fiber: unknown) => boolean };
  };
  return sandbox.__QAREN.__hidden(leaf);
}

test('styleValue last present array property wins, including explicit resets', () => {
  assert.equal(hiddenForStyle([{ display: 'none' }, { display: 'flex' }]), false);
  assert.equal(hiddenForStyle([{ display: 'flex' }, { display: 'none' }]), true);
  assert.equal(hiddenForStyle([{ display: 'none' }, { display: undefined }]), false);
  assert.equal(hiddenForStyle([{ display: 'none' }, { display: null }]), false);
  assert.equal(hiddenForStyle([{ display: 'none' }, {}]), true);
});

test('styleValue walks nested style arrays', () => {
  assert.equal(hiddenForStyle([[{ display: 'none' }]]), true);
  assert.equal(hiddenForStyle([[{ display: 'flex' }], { display: 'none' }]), true);
  assert.equal(hiddenForStyle([[{ display: 'none' }], { display: 'flex' }]), false);
});

test('styleValue treats a Pressable function style as undefined', () => {
  assert.equal(
    hiddenForStyle(function pressableStyle() {
      return { display: 'none' };
    }),
    false,
  );
});

test('styleValue reads display on a null-prototype style object', () => {
  const style = Object.create(null) as Record<string, unknown>;
  style.display = 'none';
  assert.equal(hiddenForStyle(style), true);
});

test('styleValue reads display on a proxy that has no hasOwnProperty', () => {
  const style = new Proxy(
    { display: 'none' },
    {
      get(target, prop, receiver) {
        if (prop === 'hasOwnProperty') throw new Error('hasOwnProperty is not a function');
        return Reflect.get(target, prop, receiver);
      },
    },
  );
  assert.equal(hiddenForStyle(style), true);
});
