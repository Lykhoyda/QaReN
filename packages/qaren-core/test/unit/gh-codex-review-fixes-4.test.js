// Codex review (round 5): byRole must gate on the FULL RNTL isAccessibilityElement
// predicate, not just exclude accessible={false}. A plain View with a role prop
// but `accessible` undefined is NOT a screen-reader element, so byRole must not
// match it. Text / TextInput / Switch (and Image with alt) are accessibility
// elements by default; everything else must opt in with accessible={true}.
//
// Verified live: real RN buttons DO expose accessible:true in their fiber
// memoizedProps (host RCTView + inner Pressable layers), so byRole still
// resolves them — only plain-View role props are excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function ladder(sb, spec) {
  return JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify(spec)));
}

test('byRole does NOT match a plain View with a role prop but accessible undefined', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { hostType: 'RCTView', props: { accessibilityRole: 'button', accessibilityLabel: 'Save' } },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'button', name: 'Save' });
  assert.equal(r.found, false);
  assert.equal(r.error, 'Component not found');
});

test('byRole matches a View that opts in with accessible={true}', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        hostType: 'RCTView',
        props: { accessibilityRole: 'button', accessibilityLabel: 'Save', accessible: true },
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'button', name: 'Save' });
  assert.equal(r.found, true, r.error || 'count=' + r.count);
});

test('byRole matches a host Switch by default (accessibility element without explicit accessible)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { hostType: 'RCTSwitch', props: { accessibilityRole: 'switch', accessibilityLabel: 'Wifi' } },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'switch', name: 'Wifi' });
  assert.equal(r.found, true, r.error || 'count=' + r.count);
});

test('byRole matches an Image with alt by default (no explicit accessible needed)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'RCTImageView', props: { accessibilityRole: 'image', alt: 'Logo' } }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'image', name: 'Logo' });
  assert.equal(r.found, true, r.error || 'count=' + r.count);
});

test('source guard: full a11y-element predicate present', () => {
  assert.match(INJECTED_HELPERS, /function __isA11yElement\(/);
});
