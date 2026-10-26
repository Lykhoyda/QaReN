// B143: cdp_component_tree must walk ALL registered React renderers, not
// just the first one with roots. findActiveRenderer returns early on the
// first non-empty rendererID, which on apps with Bridgeless + Reanimated
// (or main + LogBox split) is usually the tiny LogBox shell, not the
// main app tree. The filter BFS now seeds its queue from every renderer.
//
// This test exercises the TS mirror `findAllRootFibersForTest`; a
// regression guard at the bottom scans the injected JS string for the
// multi-renderer-loop tokens so drift between the two copies fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { findAllRootFibersForTest, INJECTED_HELPERS } from '../../dist/injected-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeRootsMap(fibers) {
  const items = fibers.map((f) => ({ current: f }));
  return {
    size: items.length,
    values() {
      let i = 0;
      return {
        next() {
          if (i >= items.length) return { done: true, value: undefined };
          return { done: false, value: items[i++] };
        },
      };
    },
  };
}

function makeHook(rendererMap) {
  return {
    getFiberRoots(ri) {
      return rendererMap[ri] ?? null;
    },
  };
}

test('B143: no hook returns empty array', () => {
  assert.deepEqual(findAllRootFibersForTest(null), []);
  assert.deepEqual(findAllRootFibersForTest(undefined), []);
  assert.deepEqual(findAllRootFibersForTest({}), []);
});

test('B143: hook without getFiberRoots returns empty', () => {
  assert.deepEqual(findAllRootFibersForTest({ other: 'prop' }), []);
});

test('B143: single renderer with single root returns one entry', () => {
  const fiber = { tag: 'root1' };
  const hook = makeHook({ 1: makeRootsMap([fiber]) });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].rendererId, 1);
  assert.equal(result[0].fiber, fiber);
});

test('B143: single renderer with multiple roots returns all roots', () => {
  const f1 = { tag: 'root1-a' };
  const f2 = { tag: 'root1-b' };
  const hook = makeHook({ 1: makeRootsMap([f1, f2]) });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.rendererId),
    [1, 1],
  );
  assert.deepEqual(
    result.map((r) => r.fiber),
    [f1, f2],
  );
});

test('B143: multi-renderer (1 + 2) returns union — the B143 core case', () => {
  const logboxFiber = { tag: 'logbox-shell' };
  const appFiber1 = { tag: 'app-main' };
  const appFiber2 = { tag: 'app-secondary' };
  const hook = makeHook({
    1: makeRootsMap([logboxFiber]),
    2: makeRootsMap([appFiber1, appFiber2]),
  });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((r) => r.rendererId),
    [1, 2, 2],
  );
  assert.deepEqual(
    result.map((r) => r.fiber),
    [logboxFiber, appFiber1, appFiber2],
  );
});

test('B143: sparse rendererIDs (1, 4) both included', () => {
  const f1 = { tag: 'r1' };
  const f4 = { tag: 'r4' };
  const hook = makeHook({ 1: makeRootsMap([f1]), 4: makeRootsMap([f4]) });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.rendererId),
    [1, 4],
  );
});

test('B143: empty renderer IDs are skipped', () => {
  const f2 = { tag: 'r2' };
  const hook = {
    getFiberRoots(ri) {
      if (ri === 2) return makeRootsMap([f2]);
      if (ri === 3) return { size: 0, values: () => ({ next: () => ({ done: true }) }) };
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].rendererId, 2);
});

test('B143: null root in the map is filtered out', () => {
  // Edge: getFiberRoots can hand back a Set where .values().next() returns
  // null/undefined values in pathological cases. Don't push them.
  const hook = {
    getFiberRoots(ri) {
      if (ri === 1) {
        return {
          size: 2,
          values() {
            let i = 0;
            return {
              next() {
                if (i === 0) {
                  i++;
                  return { done: false, value: null };
                }
                if (i === 1) {
                  i++;
                  return { done: false, value: { current: { tag: 'ok' } } };
                }
                return { done: true };
              },
            };
          },
        };
      }
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].fiber.tag, 'ok');
});

test('B143: root without .current is filtered out', () => {
  const hook = {
    getFiberRoots(ri) {
      if (ri === 1) {
        return {
          size: 2,
          values() {
            let i = 0;
            return {
              next() {
                if (i === 0) {
                  i++;
                  return {
                    done: false,
                    value: {
                      /* no current */
                    },
                  };
                }
                if (i === 1) {
                  i++;
                  return { done: false, value: { current: { tag: 'real' } } };
                }
                return { done: true };
              },
            };
          },
        };
      }
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].fiber.tag, 'real');
});

test('B143 A3 (Gemini 80) + Issue #126: per-renderer throw does NOT poison the union — TS mirror hardened', () => {
  // Issue #126: TS mirror was hardened to add per-renderer try/catch
  // (matching the IIFE behavior, B143 A3). A throwing renderer is treated
  // as empty for that ID and counts toward the early-exit-after-3-empty
  // streak. This test now asserts partial-results rather than throw.
  const hook = {
    getFiberRoots(ri) {
      if (ri === 2) throw new Error('boom');
      if (ri === 1) {
        return {
          size: 1,
          values() {
            let sent = false;
            return {
              next() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: { current: { tag: 'real' } } };
              },
            };
          },
        };
      }
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].rendererId, 1);
});

// ── Regression guard against IIFE/TS-mirror drift ─────────────────────

test('B143 + GH #597: injected root iteration prefers registered renderer IDs', () => {
  const src = INJECTED_HELPERS;
  assert.match(
    src,
    /function findAllRootFibers\((?:bounds)?\)/,
    'findAllRootFibers function missing from injected helpers',
  );
  // findAllRootFibers delegates to iterateAllRoots. The shared primitive
  // enumerates the DevTools renderer registry first, while retaining bounded
  // numeric probing for older hook shims that do not expose renderers.keys().
  assert.match(
    src,
    /function iterateAllRoots\(cb(?:, bounds)?\)/,
    'iterateAllRoots primitive missing — findAllRootFibers depends on it',
  );
  assert.match(
    src,
    /function getRegisteredRendererIds\(hook\)/,
    'registered renderer ID enumeration missing',
  );
  assert.match(
    src,
    /hook\.renderers\.keys\(\)/,
    'renderer IDs are not sourced from the DevTools registry',
  );
  assert.match(src, /fallbackId <= MAX_RENDERER_IDS/, 'legacy MAX_RENDERER_IDS fallback missing');
  assert.match(src, /var MAX_RENDERER_IDS = 20;/, 'MAX_RENDERER_IDS constant missing or not 20');
  assert.match(src, /hook\.getFiberRoots\(ri\)/, 'hook.getFiberRoots(ri) iteration missing');
  // findAllRootFibers cb pushes {rendererId, fiber} into the output array.
  const findAllSlice = src.split('function findAllRootFibers')[1]?.split('function ')[0] ?? '';
  assert.match(
    findAllSlice,
    /out\.push\(\{ rendererId: rendererId, fiber: rootFiber(?:, root: root)? \}\)/,
    'findAllRootFibers collector cb drifted from {rendererId, fiber} shape',
  );
});

test('B143: filter path in getTree uses findAllRootFibers (no single-root short-circuit)', () => {
  const src = INJECTED_HELPERS;
  // The filter branch must populate its BFS queue from allRoots, not from
  // the first renderer's first root.
  assert.match(
    src,
    /var allRoots = findAllRootFibers\(\);/,
    'filter path did not switch to findAllRootFibers',
  );
  assert.match(
    src,
    /for \(var qi = 0; qi < allRoots\.length; qi\+\+\) queue\.push\(allRoots\[qi\]\.fiber\);/,
    'filter path queue init drifted',
  );
  // And the result payload exposes rootsSeeded for observability.
  assert.match(
    src,
    /rootsSeeded: allRoots\.length/,
    'rootsSeeded metric missing from filter response',
  );
});

test('B143 A1 (Gemini 85): hasErrorOverlay check runs across all renderers', () => {
  // Pre-A1 this only checked the first renderer's root. An Error Boundary
  // mounted on a later renderer would be missed.
  const src = INJECTED_HELPERS;
  assert.match(
    src,
    /var overlayRoots = findAllRootFibers\((?:typography)?\);/,
    'error-overlay check did not switch to findAllRootFibers',
  );
  assert.match(
    src,
    /hasErrorOverlay\(overlayRoots\[oi\]\.fiber\)/,
    'error-overlay loop did not walk each renderer root',
  );
});

test('B143 A3 (Gemini 80): IIFE wraps per-renderer getFiberRoots in try/catch', () => {
  // Guards against teardown / HMR / worklet-init races on a single renderer
  // throwing and poisoning the whole union.
  // GH #126 Gap B Task 3 refactor: the try/catch now lives in iterateAllRoots,
  // the shared primitive that findAllRootFibers delegates to.
  const src = INJECTED_HELPERS;
  const slice = src.split('function iterateAllRoots')[1]?.split('function ')[0] ?? '';
  assert.match(slice, /try \{/, 'iterateAllRoots missing try guard around getFiberRoots');
  assert.match(slice, /catch \(e\)/, 'iterateAllRoots missing per-renderer catch');
  assert.match(slice, /scanError\(ri, 'roots'/, 'iterateAllRoots missing roots-phase scanError');
  assert.match(slice, /scanError\(ri, 'walk'/, 'iterateAllRoots missing walk-phase scanError');
});

test('GH #597: a renderers iterator that never reports done falls back to the numeric probe', () => {
  const f1 = { tag: 'r1' };
  const hook = {
    renderers: {
      keys: () => ({ next: () => ({ done: false, value: 1 }) }),
    },
    getFiberRoots(ri) {
      return ri === 1 ? makeRootsMap([f1]) : null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].rendererId, 1);
  assert.equal(result[0].fiber, f1);
});

test('B143 Codex #1 (conf 82): scan budget scales with rootsSeeded count', () => {
  // With N roots, budget = min(5000, 2000 * N) so later renderers don't
  // starve when renderer 1 has a deep/wide subtree.
  const src = INJECTED_HELPERS;
  assert.match(
    src,
    /var scanBudget = Math\.min\(5000, 2000 \* Math\.max\(1, allRoots\.length\)\)/,
    'scan budget scaling missing or drifted',
  );
  assert.match(src, /scanned < scanBudget/, 'BFS loop did not switch to scanBudget variable');
});
