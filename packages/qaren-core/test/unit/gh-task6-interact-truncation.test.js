// Task 6 / fail-closed truncation: interact()'s findFiber walk had a bare
// silent cap (if (findCount > 8000) return;) that unwound the recursion
// without recording WHY. On a tree whose target sits beyond the cap, interact()
// either returned "Component not found" or silently picked tier[0] from a
// PARTIAL scan and FIRED its onPress — a false action against the wrong node.
// The cap is now fail-closed: a rootsSeeded-scaled node budget + a 3s wall-clock
// guard set a `truncated` flag that forces a structured "Resolution truncated"
// error and fires NO handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Build a single-root tree with `count` filler leaves BEFORE the target so the
// target is only reachable past the node budget. Fillers carry no matching
// testID; the target carries testID 'deep-target' with a press spy.
function buildOversizedTree(count, pressSpy) {
  const fillers = [];
  for (let i = 0; i < count; i++) {
    fillers.push({ name: 'Filler', props: { testID: 'filler-' + i } });
  }
  fillers.push({
    name: 'Pressable',
    props: { testID: 'deep-target', onPress: pressSpy },
  });
  return buildFiber({ name: 'App', children: fillers });
}

test('task6: target beyond the node budget returns truncated:true and fires no press', () => {
  let pressed = false;
  // Budget for 1 root = min(40000, 8000*1) = 8000. 12000 fillers pushes the
  // target well past the cap.
  const root = buildOversizedTree(12000, () => {
    pressed = true;
  });
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sb.__QAREN.interact({ action: 'press', testID: 'deep-target' }));
  assert.equal(result.truncated, true);
  assert.equal(result.error, 'Resolution truncated');
  assert.equal(typeof result.scanned, 'number');
  assert.ok(result.scanned > 0);
  assert.match(result.hint, /increase budget or scope with a container\/anchor/);
  assert.equal(pressed, false, 'onPress must NOT fire on a truncated walk');
});

test('task6: truncation NEVER reports "Component not found" (fail-closed, not fail-missing)', () => {
  const root = buildOversizedTree(12000, () => {});
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sb.__QAREN.interact({ action: 'press', testID: 'deep-target' }));
  assert.notEqual(result.error, 'Component not found');
  assert.equal(result.truncated, true);
});

test('task6: label-match truncation does NOT pick tier[0] from a partial scan', () => {
  // Two ambiguous-looking labels, both AFTER the cap; a partial scan must not
  // collapse to a single tier[0] pick and press it.
  let pressed = false;
  const fillers = [];
  for (let i = 0; i < 12000; i++) {
    fillers.push({ name: 'Filler', props: { testID: 'f-' + i } });
  }
  fillers.push({
    name: 'Pressable',
    props: {
      accessibilityLabel: 'Continue',
      onPress: () => {
        pressed = true;
      },
    },
  });
  const root = buildFiber({ name: 'App', children: fillers });
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sb.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.truncated, true);
  assert.equal(result.error, 'Resolution truncated');
  assert.equal(pressed, false);
});

test('task6 regression: a small tree still resolves and presses normally', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Filler', props: { testID: 'a' } },
      {
        name: 'Pressable',
        props: {
          testID: 'ok-btn',
          onPress: () => {
            pressed = true;
          },
        },
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sb.__QAREN.interact({ action: 'press', testID: 'ok-btn' }));
  assert.equal(result.success, true);
  assert.equal(result.truncated, undefined);
  assert.equal(pressed, true);
});

// ── source-drift guard (mirrors gh-60-bug-5-label-matching.test.js:422-432) ──

test('source guard: findFiber no longer has a bare cap-return without a truncation flag', () => {
  // The old silent unwind: `if (findCount > 8000) return;` with no flag set.
  assert.doesNotMatch(INJECTED_HELPERS, /if \(findCount > 8000\) return;/);
});

test('source guard: interact() carries the fail-closed truncation contract', () => {
  assert.match(INJECTED_HELPERS, /Resolution truncated/);
  assert.match(INJECTED_HELPERS, /findTruncated/);
  assert.match(INJECTED_HELPERS, /increase budget or scope with a container\/anchor/);
});
