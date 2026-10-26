// Codex review (round 4): byRole RNTL-parity gaps.
//  #8 byRole ignored accessible={false} (the a11y opt-out) — an opted-out
//     duplicate could cause false ambiguity or get pressed.
//  #9 the REQUESTED role wasn't normalized, so byRole({role:'image'}) failed
//     to match an element whose __role normalized accessibilityRole 'image'→'img'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function ladder(sb, spec) {
  return JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify(spec)));
}

// ── #8: accessible={false} opt-out ───────────────────────────────────────
test('byRole excludes accessible={false} elements (respects the a11y opt-out)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      // a duplicate kept mounted but opted out of accessibility
      {
        name: 'Pressable',
        props: {
          accessibilityRole: 'button',
          accessibilityLabel: 'Save',
          accessible: false,
          onPress() {},
        },
      },
      // the real target
      {
        name: 'Pressable',
        props: {
          accessibilityRole: 'button',
          accessibilityLabel: 'Save',
          accessible: true,
          onPress() {},
        },
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'button', name: 'Save' });
  // only the accessible one matches → unique, not Ambiguous
  assert.equal(r.found, true, r.error || 'count=' + r.count);
});

test('byRole with all candidates accessible={false} → Component not found (fail-closed)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { accessibilityRole: 'button', accessibilityLabel: 'Save', accessible: false },
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'button', name: 'Save' });
  assert.equal(r.found, false);
  assert.equal(r.error, 'Component not found');
});

// ── #9: normalize the requested image role ───────────────────────────────
test('byRole normalizes the requested image role (image → img)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Image',
        props: { accessibilityRole: 'image', accessibilityLabel: 'Logo', accessible: true },
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { role: 'image', name: 'Logo' });
  assert.equal(r.found, true, r.error || 'count=' + r.count);
  assert.equal(r.bundle.role, 'img');
});

test('source guards: accessible opt-out + normalized requested role present', () => {
  assert.match(INJECTED_HELPERS, /function __isA11yElement\(/);
  assert.match(INJECTED_HELPERS, /normalizeRole\(spec\.role\)/);
});
