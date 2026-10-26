// Task 2 / FIXED INTERFACES: __QAREN.__hostKind(fiber) classifies a live host
// fiber into text|textinput|image|switch|scrollview|modal|null. Ports RNTL
// host-component-names.ts (isHostText/isHostTextInput/...), widened to native
// view names (RCTText, RCTSinglelineTextInputView, RCTImageView, RCTModalHostView,
// ...) because live fibers carry the platform view name, not the JS name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Helper: wrap one host/component child under an App root so createSandbox has a
// fiberRoot to mount, then hand the child fiber straight to __hostKind.
function kindOf(childSpec) {
  const root = buildFiber({ name: 'App', children: [childSpec] });
  const sb = createSandbox({ fiberRoot: root });
  return sb.__QAREN.__hostKind(root.child);
}

test('__hostKind: host Text (string type) → "text"', () => {
  assert.equal(kindOf({ hostType: 'Text' }), 'text');
});

test('__hostKind: native RCTText → "text"', () => {
  assert.equal(kindOf({ hostType: 'RCTText' }), 'text');
});

test('__hostKind: host TextInput → "textinput"', () => {
  assert.equal(kindOf({ hostType: 'TextInput' }), 'textinput');
});

test('__hostKind: native RCTSinglelineTextInputView → "textinput"', () => {
  assert.equal(kindOf({ hostType: 'RCTSinglelineTextInputView' }), 'textinput');
});

test('__hostKind: host Image → "image"', () => {
  assert.equal(kindOf({ hostType: 'Image' }), 'image');
});

test('__hostKind: native RCTImageView → "image"', () => {
  assert.equal(kindOf({ hostType: 'RCTImageView' }), 'image');
});

test('__hostKind: host Switch → "switch"', () => {
  assert.equal(kindOf({ hostType: 'Switch' }), 'switch');
});

test('__hostKind: native RCTScrollView → "scrollview"', () => {
  assert.equal(kindOf({ hostType: 'RCTScrollView' }), 'scrollview');
});

test('__hostKind: native RCTModalHostView → "modal"', () => {
  assert.equal(kindOf({ hostType: 'RCTModalHostView' }), 'modal');
});

test('__hostKind: plain host View → null', () => {
  assert.equal(kindOf({ hostType: 'View' }), null);
});

test('__hostKind: user component MyButton → null', () => {
  assert.equal(kindOf({ name: 'MyButton' }), null);
});

test('__hostKind: fiber with null type → null', () => {
  const root = buildFiber({ name: 'App', children: [{ name: 'MyButton' }] });
  const sb = createSandbox({ fiberRoot: root });
  // App root's own type is {displayName:'App'} — a component, not a host kind.
  assert.equal(sb.__QAREN.__hostKind({ type: null, memoizedProps: {} }), null);
});

test('__hostKind: text node (tag 6, string memoizedProps) → null', () => {
  const root = buildFiber({ name: 'App', children: [{ text: 'hello' }] });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hostKind(root.child), null);
});

test('__hostKind: undefined fiber → null (defensive)', () => {
  const root = buildFiber({ name: 'App', children: [{ hostType: 'Text' }] });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__QAREN.__hostKind(undefined), null);
});

// ── source-drift guard: a refactor that drops __hostKind fails CI ──────────
// Mirrors gh-60-bug-5-label-matching.test.js:422-432.
test('source guard: __hostKind is defined and exported on the surface', () => {
  assert.match(INJECTED_HELPERS, /function hostKind\(fiber\)/);
  assert.match(INJECTED_HELPERS, /__hostKind: hostKind/);
  assert.match(INJECTED_HELPERS, /RCTSinglelineTextInputView/);
  assert.match(INJECTED_HELPERS, /RCTModalHostView/);
});
