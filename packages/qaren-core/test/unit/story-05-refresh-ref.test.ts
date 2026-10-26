import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshRef } from '../../dist/fast-runner-ref-map.js';

const rect = (x, y) => ({ x, y, width: 100, height: 40 });
const btn = (ref, label, identifier, y) => ({
  ref,
  type: 'Button',
  ...(label !== undefined ? { label } : {}),
  ...(identifier !== undefined ? { identifier } : {}),
  rect: rect(0, y),
});
const sig = (over = {}) => ({
  type: 'Button',
  label: 'Save',
  identifier: 'save-btn',
  flatIndex: 1,
  nodeCount: 3,
  ...over,
});

test('unique: exactly one attrs-minus-bounds match, even at a new position', () => {
  const nodes = [
    btn('@e0', 'Other', 'x', 0),
    btn('@e1', 'Cancel', undefined, 50),
    btn('@e2', 'Save', 'save-btn', 400),
  ];
  const out = refreshRef(sig(), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e2');
});

test('absent: zero matches (element truly gone)', () => {
  const nodes = [btn('@e0', 'Other', 'x', 0)];
  assert.deepEqual(refreshRef(sig(), nodes), { kind: 'absent' });
});

test('label changed but testID same preserves identity', () => {
  const nodes = [btn('@e0', 'Saving…', 'save-btn', 0)];
  assert.equal(refreshRef(sig(), nodes).kind, 'unique');
});

test('testID changed but label same → absent', () => {
  const nodes = [btn('@e0', 'Save', 'save-btn-v2', 0)];
  assert.equal(refreshRef(sig(), nodes).kind, 'absent');
});

test('ambiguous: two identical siblings, tree shape changed → candidates, no guess', () => {
  const nodes = [btn('@e0', 'Save', 'save-btn', 0), btn('@e1', 'Save', 'save-btn', 50)];
  const out = refreshRef(sig({ nodeCount: 3 }), nodes); // 2 !== 3 → shape changed
  assert.equal(out.kind, 'ambiguous');
  assert.equal(out.candidates.length, 2);
});

test('identical siblings refuse even when tree shape is unchanged', () => {
  const nodes = [
    btn('@e0', 'Save', 'save-btn', 0),
    btn('@e1', 'Save', 'save-btn', 50),
    btn('@e2', 'Other', 'x', 100),
  ];
  const out = refreshRef(sig({ flatIndex: 1, nodeCount: 3 }), nodes);
  assert.equal(out.kind, 'ambiguous');
});

test('index-shift trap: shape unchanged but no candidate at cached index → ambiguous', () => {
  const nodes = [
    btn('@e0', 'Other', 'x', 0),
    btn('@e1', 'Save', 'save-btn', 50),
    btn('@e2', 'Save', 'save-btn', 100),
  ];
  const out = refreshRef(sig({ flatIndex: 0, nodeCount: 3 }), nodes);
  assert.equal(out.kind, 'ambiguous');
});

test('same id with different labels still counts two identities', () => {
  const nodes = [btn('@e0', undefined, 'save-btn', 0), btn('@e1', 'Save', 'save-btn', 50)];
  const out = refreshRef(sig({ label: undefined }), nodes);
  assert.equal(out.kind, 'ambiguous');
});

test('label-only identities count every type before eligibility', () => {
  const nodes = [
    btn('@a', 'Save', undefined, 0),
    { ...btn('@b', 'Save', undefined, 50), type: 'StaticText', hittable: false, enabled: false },
  ];
  assert.equal(refreshRef(sig({ identifier: undefined }), nodes).kind, 'ambiguous');
});

test('refresh collapses a contained text echo through the shared identity model', () => {
  const nodes = [
    { ...btn('@a', 'Save', undefined, 0), index: 0 },
    { ...btn('@b', 'Save', undefined, 0), type: 'StaticText', index: 1, parentIndex: 0 },
  ];
  const result = refreshRef(sig({ identifier: undefined }), nodes);
  assert.equal(result.kind, 'unique');
  assert.equal(result.node.ref, '@a');
});

test('refresh selects the Button through a layout echo without granting wrapper identity', () => {
  const nodes = [
    { ...btn('@a', 'Save', undefined, 0), index: 0 },
    { ...btn('@layout', 'Save', undefined, 0), type: 'Other', index: 1, parentIndex: 0 },
    { ...btn('@text', 'Save', undefined, 0), type: 'StaticText', index: 2, parentIndex: 1 },
  ];
  const result = refreshRef(sig({ identifier: undefined }), nodes);
  assert.equal(result.kind, 'unique');
  assert.equal(result.node.ref, '@a');
  assert.equal(
    refreshRef(
      sig({ identifier: undefined }),
      nodes.slice(1).map((node, index) => ({
        ...node,
        index,
        parentIndex: index === 0 ? undefined : 0,
      })),
    ).kind,
    'ambiguous',
  );
});

test('refresh collapses each echo but keeps unrelated same-label Buttons ambiguous', () => {
  const nodes = [
    { ...btn('@a', 'Save', undefined, 0), index: 0 },
    { ...btn('@text-a', 'Save', undefined, 0), type: 'StaticText', index: 1, parentIndex: 0 },
    { ...btn('@b', 'Save', undefined, 50), index: 2 },
    { ...btn('@text-b', 'Save', undefined, 50), type: 'StaticText', index: 3, parentIndex: 2 },
  ];
  const result = refreshRef(sig({ identifier: undefined }), nodes);
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(
    result.candidates.map((node) => node.ref),
    ['@a', '@b'],
  );
});

test('S11: an Android blank identifier falls back to the label, never to an empty id', () => {
  const nodes = [btn('@e0', 'Other', 'x', 0), btn('@e1', 'Save', '', 50)];
  for (const identifier of ['', '   ']) {
    const out = refreshRef(sig({ identifier }), nodes);
    assert.equal(out.kind, 'unique', identifier);
    assert.equal(out.node.ref, '@e1');
  }
  const twins = [btn('@e0', 'Save', '', 0), btn('@e1', 'Save', '', 50)];
  assert.equal(refreshRef(sig({ identifier: '' }), twins).kind, 'ambiguous');
});
