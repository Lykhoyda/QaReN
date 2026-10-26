// Task 4: __accessibleName ports RNTL computeAccessibleName +
// computeAriaLabel + getAriaLabelledByIds + joinAccessibleNameParts
// (react-native-testing-library/src/helpers/accessibility.ts:152-318).
//
// DEVIATION from RNTL: labelledBy nativeID refs are resolved to the
// referenced node's plain TEXT CONTENT (concatenated descendant host-text
// strings), NOT by recursively computing its accessible name. This mirrors
// RNTL's computeAriaLabel using getTextContent and prevents infinite
// recursion on a malformed labelledBy cycle (A->B->A).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Build a tree, run helpers in a vm sandbox seeded with that root, and
// return the sandbox so tests can call sb.__QAREN.__accessibleName(fiber).
function mount(spec) {
  const root = buildFiber(spec, null);
  const sb = createSandbox({ fiberRoot: root });
  return { sb, root };
}

// Walk child/sibling to find the first fiber matching a predicate.
function find(fiber, pred) {
  if (!fiber) return null;
  if (pred(fiber)) return fiber;
  return find(fiber.child, pred) || find(fiber.sibling, pred);
}

// (1) accessibilityLabelledBy nativeID ref wins over same-node accessibilityLabel.
// DEVIATION: the ref resolves to the referenced node's text content. Here the
// referenced View has no text children, only accessibilityLabel — so the
// referenced node's TEXT CONTENT is empty. To exercise "ref wins", give the
// referenced node real text content.
test('labelledBy nativeID ref resolves to referenced text content (wins over same-node label)', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      {
        name: 'View',
        props: { nativeID: 'lbl' },
        children: [{ hostType: 'Text', children: [{ text: 'From ref' }] }],
      },
      {
        name: 'Pressable',
        props: { accessibilityLabelledBy: ['lbl'], accessibilityLabel: 'On node' },
      },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps.accessibilityLabelledBy);
  assert.equal(sb.__QAREN.__accessibleName(target), 'From ref');
});

// (2) labelledBy array joins multiple refs (each resolved to text) with a single space.
test('labelledBy array joins ref text content with single space', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      {
        name: 'View',
        props: { nativeID: 'a' },
        children: [{ hostType: 'Text', children: [{ text: 'Hello' }] }],
      },
      {
        name: 'View',
        props: { nativeID: 'b' },
        children: [{ hostType: 'Text', children: [{ text: 'World' }] }],
      },
      { name: 'Pressable', props: { accessibilityLabelledBy: ['a', 'b'] } },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps.accessibilityLabelledBy);
  assert.equal(sb.__QAREN.__accessibleName(target), 'Hello World');
});

// (3) aria-labelledby string form resolves the single ref to its text content.
test('aria-labelledby string form resolves to text content', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      {
        name: 'View',
        props: { nativeID: 'x' },
        children: [{ hostType: 'Text', children: [{ text: 'Labelled' }] }],
      },
      { name: 'Pressable', props: { 'aria-labelledby': 'x' } },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps['aria-labelledby']);
  assert.equal(sb.__QAREN.__accessibleName(target), 'Labelled');
});

// (4) labelledBy resolving to empty does NOT fall back is wrong — RNTL filters
// undefined ref texts out of labelTexts, so an empty ref leaves labelTexts
// empty and computeAriaLabel proceeds to the explicit accessibilityLabel branch.
test('labelledBy resolving to empty text falls through to accessibilityLabel', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      // ref target exists but has no text content -> empty -> filtered out
      { name: 'View', props: { nativeID: 'empty' } },
      {
        name: 'Pressable',
        props: { accessibilityLabelledBy: ['empty'], accessibilityLabel: 'Fallback' },
      },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps.accessibilityLabelledBy);
  assert.equal(sb.__QAREN.__accessibleName(target), 'Fallback');
});

// (5) plain accessibilityLabel / aria-label when no labelledBy
test('plain accessibilityLabel used when no labelledBy', () => {
  const { sb, root } = mount({ name: 'Pressable', props: { accessibilityLabel: 'Submit' } });
  assert.equal(sb.__QAREN.__accessibleName(root), 'Submit');
});

test('aria-label used when no labelledBy', () => {
  const { sb, root } = mount({ name: 'Pressable', props: { 'aria-label': 'Close' } });
  assert.equal(sb.__QAREN.__accessibleName(root), 'Close');
});

// (6) TextInput placeholder becomes name only at root; nested input does not leak up
test('TextInput placeholder is name at root', () => {
  const { sb, root } = mount({ hostType: 'TextInput', props: { placeholder: 'Email' } });
  assert.equal(sb.__QAREN.__accessibleName(root), 'Email');
});

test('nested TextInput placeholder does not leak to ancestor name', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [{ hostType: 'TextInput', props: { placeholder: 'Email' } }],
  });
  // root View has no label and its only child is a nested input (root:false),
  // whose placeholder is suppressed -> no parts -> empty -> undefined.
  assert.equal(sb.__QAREN.__accessibleName(root), undefined);
});

// (7) Image alt gives name
test('host image alt gives name', () => {
  const { sb, root } = mount({ hostType: 'Image', props: { alt: 'Logo' } });
  assert.equal(sb.__QAREN.__accessibleName(root), 'Logo');
});

// (8) inline-text join: two host-Text string children "Sign" + "In" -> "SignIn"
test('inline host-text string children join with empty string', () => {
  const { sb, root } = mount({
    hostType: 'Text',
    children: [
      { hostType: 'Text', children: [{ text: 'Sign' }] },
      { hostType: 'Text', children: [{ text: 'In' }] },
    ],
  });
  assert.equal(sb.__QAREN.__accessibleName(root), 'SignIn');
});

// ── DEVIATION guard: labelledBy CYCLE A->B->A returns safely (no stack overflow) ──
// Node A has nativeID 'A' and accessibilityLabelledBy ['B']; node B has
// nativeID 'B' and accessibilityLabelledBy ['A']. Because labelledBy refs
// resolve to TEXT CONTENT (not __accessibleName recursion), neither node's
// label props drive resolution of the other — text content is computed
// directly. The target's name is whatever text content the referenced node
// carries. This must not recurse infinitely.
test('labelledBy cycle A->B->A resolves safely without stack overflow', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      {
        name: 'View',
        props: { nativeID: 'A', accessibilityLabelledBy: ['B'] },
        children: [{ hostType: 'Text', children: [{ text: 'TextA' }] }],
      },
      {
        name: 'View',
        props: { nativeID: 'B', accessibilityLabelledBy: ['A'] },
        children: [{ hostType: 'Text', children: [{ text: 'TextB' }] }],
      },
      { name: 'Pressable', props: { accessibilityLabelledBy: ['A'] } },
    ],
  });
  const target = find(
    root,
    (f) =>
      f.memoizedProps &&
      f.memoizedProps.accessibilityLabelledBy &&
      f.type &&
      f.type.displayName === 'Pressable',
  );
  // Target points at A. A's TEXT CONTENT is 'TextA' (its own label-cycle ref to B
  // is irrelevant because we resolve text, not name). No infinite recursion.
  assert.doesNotThrow(() => sb.__QAREN.__accessibleName(target));
  assert.equal(sb.__QAREN.__accessibleName(target), 'TextA');
});

// ── source-drift guard ─────────────────────────────────────────────────
test('source guard: __accessibleName helper present in injected source', () => {
  assert.match(INJECTED_HELPERS, /__accessibleName:\s*__accessibleName/);
  assert.match(INJECTED_HELPERS, /function __accessibleName\(/);
  assert.match(INJECTED_HELPERS, /function __ariaLabelledByIds\(/);
  assert.match(INJECTED_HELPERS, /accessibilityLabelledBy/);
  // DEVIATION guard: a dedicated text-content helper exists (no name-recursion
  // for ref resolution).
  assert.match(INJECTED_HELPERS, /function __refTextContent\(/);
});
