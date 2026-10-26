// Task 5 / a11y ladder: __QAREN.__hidden ports RNTL isHiddenFromAccessibility
// + isSubtreeInaccessible (accessibility.ts:25-85) to live fibers — climbing
// fiber.return (not instance.parent), reading memoizedProps, and flattening
// memoizedProps.style arrays manually (no StyleSheet.flatten in-page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Build a single-child tree (root → leaf) and return { root, leaf }.
// rootProps lands on the ancestor, leafProps on the visible target.
function tree(rootProps, leafProps) {
  const root = buildFiber({ name: 'View', props: rootProps || {}, children: [] }, null);
  const leaf = buildFiber({ name: 'View', props: leafProps || {}, children: [] }, root);
  root.child = leaf;
  return { root, leaf };
}

test('__hidden: visible leaf → false', () => {
  const { root, leaf } = tree({}, {});
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), false);
});

test('__hidden: null fiber → true', () => {
  const { root } = tree({}, {});
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(null), true);
});

test('__hidden: aria-hidden on the node → true', () => {
  const { root, leaf } = tree({}, { 'aria-hidden': true });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), true);
});

test('__hidden: accessibilityElementsHidden → true', () => {
  const { root, leaf } = tree({}, { accessibilityElementsHidden: true });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), true);
});

test('__hidden: importantForAccessibility no-hide-descendants → true', () => {
  const { root, leaf } = tree({}, { importantForAccessibility: 'no-hide-descendants' });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), true);
});

test('__hidden: style {display:none} → true', () => {
  const { root, leaf } = tree({}, { style: { display: 'none' } });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), true);
});

test('__hidden: style array [{}, {display:none}] → true (flatten manually)', () => {
  const { root, leaf } = tree({}, { style: [{}, { display: 'none' }] });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), true);
});

test('__hidden: visible child under aria-hidden ancestor → true (climb .return)', () => {
  const { root, leaf } = tree({ 'aria-hidden': true }, {});
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), true);
});

test('__hidden: opacity 0 is NOT hidden → false', () => {
  const { root, leaf } = tree({}, { style: { opacity: 0 } });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hidden(leaf), false);
});

// ── source-drift guard (mirrors gh-60-bug-5-label-matching.test.js:422-432) ──
test('source guard: __hidden present in injected helpers', () => {
  assert.match(INJECTED_HELPERS, /__hidden:\s*__hidden/);
  assert.match(INJECTED_HELPERS, /function __hidden\(/);
  assert.match(INJECTED_HELPERS, /no-hide-descendants/);
});
