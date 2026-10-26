// Fixes for the Codex review on PR #362 (Phase 1 discovery resolver):
//  #2 resolveLadder's own walk had a silent 8000-fiber cap → could return
//     found:1 on a truncated tree (a duplicate past the cap stays uncounted).
//     Now fail-closed: {truncated:true}.
//  #3 byText matched __accessibleName (accessibilityLabel precedence) instead
//     of the visible text content.
//  #4 the ladder interact() branch pressed regardless of the requested action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function ladder(sb, spec) {
  return JSON.parse(sb.__QAREN.resolveLadder(JSON.stringify(spec)));
}

// ── #2: fail-closed truncation in resolveLadder ──────────────────────────
test('resolveLadder fails closed (truncated) when the walk exceeds its budget', () => {
  const fillers = [];
  for (let i = 0; i < 12000; i++) fillers.push({ hostType: 'RCTView' });
  fillers.push({ hostType: 'RCTText', children: [{ text: 'DeepTarget' }] }); // beyond the 8000 cap
  const root = buildFiber({ name: 'App', children: fillers });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { text: 'DeepTarget' });
  assert.equal(r.found, false);
  assert.equal(r.truncated, true);
  assert.equal(r.error, 'Resolution truncated');
});

test('resolveLadder resolves normally on a small (under-budget) tree', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'RCTText', children: [{ text: 'Small' }] }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = ladder(sb, { text: 'Small' });
  assert.equal(r.found, true, r.error);
  assert.notEqual(r.truncated, true);
});

// ── #3: byText matches visible text content, not accessibilityLabel ───────
test('byText matches the visible text content, NOT accessibilityLabel', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { hostType: 'RCTText', props: { accessibilityLabel: 'AX' }, children: [{ text: 'Visible' }] },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const byVisible = ladder(sb, { text: 'Visible' });
  assert.equal(byVisible.found, true, byVisible.error || 'count=' + byVisible.count);
  assert.equal(byVisible.bundle.text, 'Visible');
  const byLabel = ladder(sb, { text: 'AX' });
  assert.equal(byLabel.found, false);
  assert.equal(byLabel.error, 'Component not found');
});

// ── #4: ladder interact() rejects non-press actions (fail-closed) ─────────
test('ladder interact rejects unsupported actions instead of silently pressing', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'RCTText', children: [{ text: 'Hello' }] }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = JSON.parse(sb.__QAREN.interact({ action: 'longPress', text: 'Hello' }));
  assert.match(r.error, /support press/);
  assert.equal(r.requestedAction, 'longPress');
});

test('ladder interact with action:press passes the action guard (reaches resolution)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'RCTText', children: [{ text: 'Hello' }] }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const r = JSON.parse(sb.__QAREN.interact({ action: 'press', text: 'NoSuchText9z' }));
  // press is allowed through the guard and reaches resolution.
  assert.doesNotMatch(JSON.stringify(r), /support press/);
});
