// matchDeepestOnly (found by live-simulator testing of Phase 1): a real RN
// element renders as a COMPOSITE fiber (Text/TextInput) AND its child HOST
// fiber (RCTText/RCTSinglelineTextInputView). Both pass hostKind/byText/
// byPlaceholder, so every element matched twice and fail-closed as Ambiguous
// on a live device. The vm tests missed it because buildFiber made one node
// per element. resolveLadder must collapse a composite+host pair (drop the
// ancestor, keep the deepest), while leaving genuinely-distinct siblings
// ambiguous. Mirrors RNTL's matchDeepestOnly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function ladder(sb, spec) {
  return JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify(spec)));
}

test('byText: composite Text + host RCTText (one element) resolves to ONE, not Ambiguous', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Text', children: [{ hostType: 'RCTText', children: [{ text: 'Hello' }] }] },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { text: 'Hello' });
  assert.equal(r.found, true, r.error ? r.error + ' count=' + r.count : 'should resolve uniquely');
  assert.equal(r.bundle.accessibleName, 'Hello');
});

test('byPlaceholder: composite TextInput + host input (one element) resolves to ONE', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'TextInput',
        props: { placeholder: 'Find', testID: 'q' },
        children: [
          { hostType: 'RCTSinglelineTextInputView', props: { placeholder: 'Find', testID: 'q' } },
        ],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { placeholder: 'Find' });
  assert.equal(r.found, true, r.error ? r.error + ' count=' + r.count : 'should resolve uniquely');
  assert.equal(r.bundle.testID, 'q');
});

test('byText: distinct sibling matches are NOT collapsed — still Ambiguous (fail-closed)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { hostType: 'RCTText', children: [{ text: 'Dup' }] },
      { hostType: 'RCTText', children: [{ text: 'Dup' }] },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { text: 'Dup' });
  assert.equal(r.found, false);
  assert.equal(r.error, 'Ambiguous component match');
  assert.equal(r.count, 2);
});

test('source guard: resolveLadder applies matchDeepestOnly', () => {
  assert.match(INJECTED_HELPERS_SRC, /function __deepestOnly\(/);
});

// imported lazily to keep the guard near the tests
import { INJECTED_HELPERS as INJECTED_HELPERS_SRC } from '../../dist/injected-helpers.js';
