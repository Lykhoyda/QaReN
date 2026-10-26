// Codex review (round 3): __deepestOnly must collapse ONLY composite+host
// duplicates of the SAME element. Two DISTINCT nested components that both
// match the selector (e.g. an outer card button and an inner button both named
// "Settings") must stay AMBIGUOUS — not collapse to the inner one and silently
// press it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function ladder(sb, spec) {
  return JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify(spec)));
}

test('distinct nested role matches stay Ambiguous (outer card button + inner button)', () => {
  const inner = {
    name: 'Pressable',
    props: { accessibilityRole: 'button', accessibilityLabel: 'Settings', onPress() {} },
    children: [
      {
        hostType: 'RCTView',
        props: { accessibilityRole: 'button', accessibilityLabel: 'Settings', accessible: true },
      },
    ],
  };
  const outer = {
    name: 'Pressable',
    props: { accessibilityRole: 'button', accessibilityLabel: 'Settings', onPress() {} },
    children: [
      {
        hostType: 'RCTView',
        props: { accessibilityRole: 'button', accessibilityLabel: 'Settings', accessible: true },
        children: [inner],
      },
    ],
  };
  const root = buildFiber({ name: 'App', children: [outer] });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'button', name: 'Settings' });
  assert.equal(r.found, false);
  assert.equal(r.error, 'Ambiguous component match');
  assert.equal(r.count, 2);
});

test('composite+host of the SAME element still collapses to one (regression)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Text', children: [{ hostType: 'RCTText', children: [{ text: 'Hello' }] }] },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { text: 'Hello' });
  assert.equal(r.found, true, r.error || 'count=' + r.count);
});
