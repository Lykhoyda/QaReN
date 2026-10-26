// Task 7: resolveLadder() composes __match/__role/__accessibleName/__hidden
// into a byRole/byText/byPlaceholder ladder, and interact() routes role/name/
// text/placeholder specs through it, pressing the resolved fiber or its nearest
// onPress ancestor. Collect-all (no early return); 0 → not found, >1 → ambiguous,
// 1 → bundle. Hidden excluded unless includeHidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// ── byRole + name → single match, bundle.role/accessibleName ────────────
test('resolveLadder: byRole button + name resolves a Pressable wrapping Text', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityRole: 'button',
          accessible: true,
          testID: 'go-dash',
          onPress: () => {},
        },
        children: [{ hostType: 'Text', children: [{ text: 'Go to Dashboard' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(
    sb.__QAREN.resolveLadder(JSON.stringify({ role: 'button', name: 'Go to Dashboard' })),
  );
  assert.equal(res.found, true);
  assert.equal(res.bundle.role, 'button');
  assert.equal(res.bundle.accessibleName, 'Go to Dashboard');
  assert.equal(res.bundle.testID, 'go-dash');
});

// ── two identically-named un-testID Pressables → ambiguous, count 2 ─────
test('resolveLadder: two Continue buttons → Ambiguous component match, count 2', () => {
  const mk = () => ({
    name: 'Pressable',
    props: { accessibilityRole: 'button', accessible: true, onPress: () => {} },
    children: [{ hostType: 'Text', children: [{ text: 'Continue' }] }],
  });
  const root = buildFiber({ name: 'App', children: [mk(), mk()] });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(
    sb.__QAREN.resolveLadder(JSON.stringify({ role: 'button', name: 'Continue' })),
  );
  assert.equal(res.found, false);
  assert.equal(res.error, 'Ambiguous component match');
  assert.equal(res.count, 2);
  assert.equal(res.matches.length, 2);
  assert.match(res.hint, /testID/);
});

// ── aria-hidden match excluded → not found unless includeHidden ─────────
test('resolveLadder: aria-hidden match excluded → Component not found', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'View',
        props: { 'aria-hidden': true },
        children: [
          {
            name: 'Pressable',
            props: { accessibilityRole: 'button', accessible: true, onPress: () => {} },
            children: [{ hostType: 'Text', children: [{ text: 'Hidden Action' }] }],
          },
        ],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const hidden = JSON.parse(
    sb.__QAREN.resolveLadder(JSON.stringify({ role: 'button', name: 'Hidden Action' })),
  );
  assert.equal(hidden.found, false);
  assert.equal(hidden.error, 'Component not found');

  const shown = JSON.parse(
    sb.__QAREN.resolveLadder(
      JSON.stringify({ role: 'button', name: 'Hidden Action', includeHidden: true }),
    ),
  );
  assert.equal(shown.found, true);
  assert.equal(shown.bundle.accessibleName, 'Hidden Action');
});

// ── byText: host-Text whose content __match-es ──────────────────────────
test('resolveLadder: byText matches a host-Text node', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'Text', testID: 'greeting', children: [{ text: 'Welcome back' }] }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify({ text: 'Welcome back' })));
  assert.equal(res.found, true);
  assert.equal(res.bundle.role, 'text');
  assert.equal(res.bundle.text, 'Welcome back');
});

// ── byPlaceholder: host TextInput placeholder ───────────────────────────
test('resolveLadder: byPlaceholder matches a host TextInput', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'TextInput', props: { placeholder: 'Email address' } }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(
    sb.__QAREN.resolveLadder(JSON.stringify({ placeholder: 'Email address' })),
  );
  assert.equal(res.found, true);
  assert.equal(res.bundle.placeholder, 'Email address');
});

// ── interact() routes a ladder spec and presses the nearest onPress ──────
test('interact: role/name spec routes through resolveLadder and fires onPress', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityRole: 'button',
          accessible: true,
          onPress: () => {
            pressed = true;
          },
        },
        children: [{ hostType: 'Text', children: [{ text: 'Go to Dashboard' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(
    sb.__QAREN.interact({ action: 'press', role: 'button', name: 'Go to Dashboard' }),
  );
  assert.equal(res.success, true);
  assert.equal(pressed, true);
});

test('interact: byText spec presses the nearest onPress ancestor (walks .return)', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          onPress: () => {
            pressed = true;
          },
        },
        children: [{ hostType: 'Text', children: [{ text: 'Tap me' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__QAREN.interact({ action: 'press', text: 'Tap me' }));
  assert.equal(res.success, true);
  assert.equal(pressed, true);
});

test('interact: ambiguous ladder spec surfaces the resolveLadder error verbatim', () => {
  const mk = () => ({
    name: 'Pressable',
    props: { accessibilityRole: 'button', accessible: true, onPress: () => {} },
    children: [{ hostType: 'Text', children: [{ text: 'Continue' }] }],
  });
  const root = buildFiber({ name: 'App', children: [mk(), mk()] });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(
    sb.__QAREN.interact({ action: 'press', role: 'button', name: 'Continue' }),
  );
  assert.equal(res.error, 'Ambiguous component match');
  assert.equal(res.count, 2);
});

// ── source-drift guard (mirror gh-60-bug-5:422-432) ─────────────────────
test('source guard: resolveLadder is defined and attached', () => {
  assert.match(INJECTED_HELPERS, /function resolveLadder\(/);
  assert.match(INJECTED_HELPERS, /resolveLadder: resolveLadder/);
  assert.match(INJECTED_HELPERS, /Ambiguous component match/);
  assert.match(INJECTED_HELPERS, /Component not found/);
});
