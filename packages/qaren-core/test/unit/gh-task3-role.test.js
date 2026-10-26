// Task 3 / __role: port of RNTL getRole + normalizeRole
// (react-native-testing-library/src/helpers/accessibility.ts:117-146).
//
// Role order: explicit role prop → accessibilityRole (image→img) → host
// Text gives "text" → "none". Critically NOT the digest inferRole
// (injected-helpers.ts:369-380), which defaults Pressable/Touchable/Button
// and the final fall-through to "button". The last test pins that divergence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function role(spec) {
  const root = buildFiber(spec);
  const sb = createSandbox({ fiberRoot: root });
  return sb.__QAREN.__role(root);
}

test('__role: explicit accessibilityRole button gives button', () => {
  assert.equal(role({ name: 'View', props: { accessibilityRole: 'button' } }), 'button');
});

test('__role: role prop wins over accessibilityRole', () => {
  assert.equal(
    role({ name: 'View', props: { role: 'link', accessibilityRole: 'button' } }),
    'link',
  );
});

test('__role: role image gives img', () => {
  assert.equal(role({ name: 'View', props: { role: 'image' } }), 'img');
});

test('__role: host Text gives text', () => {
  assert.equal(role({ hostType: 'Text', props: {} }), 'text');
});

test('__role: plain View gives none', () => {
  assert.equal(role({ name: 'View', props: {} }), 'none');
});

// Divergence guard: digest inferRole (injected-helpers.ts:369-380) would
// return "button" for a Pressable with an onPress handler and no role.
// __role must NOT reuse it: it returns "none".
test('__role: Pressable with onPress and NO role gives none (not button)', () => {
  assert.equal(role({ name: 'Pressable', props: { onPress: function () {} } }), 'none');
});

// Source-drift guard: a refactor that drops __role fails CI.
test('source guard: __role is present in injected helpers', () => {
  assert.match(INJECTED_HELPERS, /__role: __role/);
  assert.match(INJECTED_HELPERS, /function __role\(/);
  assert.match(INJECTED_HELPERS, /return 'img';/);
});
