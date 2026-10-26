// Second round of Codex review fixes (PR #362):
//  #5 __hostKind missed Android's `AndroidTextInput` host name → byPlaceholder /
//     byText broke for every TextInput in Android sessions.
//  #6 resolveLadder accepted a `testID` spec but had no testID matcher, so
//     resolveLadder({testID:'x'}) returned Component not found for mounted ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function ladder(sb, spec) {
  return JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify(spec)));
}

// ── #5: Android TextInput host name ──────────────────────────────────────
test('__hostKind recognizes the Android TextInput host name', () => {
  const sb = createSandbox({ fiberRoot: buildFiber({ name: 'App', children: [] }) });
  assert.equal(sb.__QAREN.__hostKind(buildFiber({ hostType: 'AndroidTextInput' })), 'textinput');
});

test('byPlaceholder resolves an AndroidTextInput (Android session)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'AndroidTextInput', props: { placeholder: 'Email', testID: 'email' } }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { placeholder: 'Email' });
  assert.equal(r.found, true, r.error);
  assert.equal(r.bundle.testID, 'email');
});

// ── #6: testID matcher in the ladder ─────────────────────────────────────
test('resolveLadder resolves a testID spec', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { testID: 'submit', onPress() {} },
        children: [{ hostType: 'RCTText', children: [{ text: 'Submit' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { testID: 'submit' });
  assert.equal(r.found, true, r.error || 'count=' + r.count);
  assert.equal(r.bundle.testID, 'submit');
});

test('resolveLadder testID: fail-closed Component not found for an absent id', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { testID: 'submit' } }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { testID: 'nope' });
  assert.equal(r.found, false);
  assert.equal(r.error, 'Component not found');
});

test('source guards: AndroidTextInput + ladder testID matcher present', () => {
  assert.match(INJECTED_HELPERS, /AndroidTextInput/);
  assert.match(INJECTED_HELPERS, /tpc\.testID === spec\.testID|tpi\.testID === spec\.testID/);
});
