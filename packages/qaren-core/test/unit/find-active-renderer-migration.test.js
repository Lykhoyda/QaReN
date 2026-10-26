// B145: regression guards that scan INJECTED_HELPERS for the new
// multi-renderer walk helper and confirm every tool handler migrated
// away from single-renderer findActiveRenderer for its fiber search.
//
// The in-IIFE code runs inside Hermes and cannot be imported for unit
// testing. Instead we assert invariants on the source string — the
// same drift-guard pattern used for B135 (extractActiveRoute) and
// B143 (findAllRootFibers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

test('B145 + Issue #126: forEachRootFiber helper is defined in the IIFE', () => {
  assert.match(
    INJECTED_HELPERS,
    /function forEachRootFiber\(cb\)/,
    'forEachRootFiber helper missing',
  );
  // GH #126 Gap B Task 3 refactor: forEachRootFiber now delegates to the
  // private iterateAllRoots primitive (shared with findAllRootFibers).
  // The actual loop / try-catch / short-circuit invariants are asserted on
  // iterateAllRoots below; here we just confirm the wrapper passes cb through.
  const slice = INJECTED_HELPERS.split('function forEachRootFiber')[1]?.split('function ')[0] ?? '';
  assert.match(
    slice,
    /return iterateAllRoots\(cb\);/,
    'forEachRootFiber should delegate to iterateAllRoots',
  );
  // Cap is 20
  assert.match(
    INJECTED_HELPERS,
    /var MAX_RENDERER_IDS = 20;/,
    'MAX_RENDERER_IDS constant missing or not 20',
  );
});

test('GH #126 + #597: iterateAllRoots primitive owns the renderer-loop invariants', () => {
  // Both forEachRootFiber and findAllRootFibers delegate here. This is the
  // single source of truth for renderer iteration semantics.
  assert.match(
    INJECTED_HELPERS,
    /function iterateAllRoots\(cb(?:, bounds)?\)/,
    'iterateAllRoots primitive missing',
  );
  const slice = INJECTED_HELPERS.split('function iterateAllRoots')[1]?.split('function ')[0] ?? '';
  // GH #597: registered IDs are authoritative. Issue #126's bounded probe is
  // retained only as fallback for hook shims without an enumerable registry.
  assert.match(
    INJECTED_HELPERS,
    /function getRegisteredRendererIds\(hook\)/,
    'registered renderer ID helper missing',
  );
  assert.match(slice, /getRegisteredRendererIds\(hook\)/, 'registered IDs are not consulted');
  assert.match(slice, /fallbackId <= MAX_RENDERER_IDS/, 'bounded numeric fallback is missing');
  assert.match(
    slice,
    /for \(var rii = 0; rii < rendererIds\.length; rii\+\+\)/,
    'root loop missing',
  );
  assert.match(slice, /try \{/, 'iterateAllRoots missing try guard');
  assert.match(slice, /catch \(e\)/, 'iterateAllRoots missing per-renderer catch');
  assert.match(slice, /scanError\(ri, 'roots'/, 'iterateAllRoots missing roots-phase scanError');
  assert.match(slice, /scanError\(ri, 'walk'/, 'iterateAllRoots missing walk-phase scanError');
  // Short-circuits on truthy callback return
  assert.match(slice, /if \(result\) return result;/, 'iterateAllRoots short-circuit missing');
});

test('B145: getNavState NavigationContainer walk uses forEachRootFiber', () => {
  // The call site is `var navState = forEachRootFiber(function(rootFiber) { return findNav(rootFiber); });`
  assert.match(
    INJECTED_HELPERS,
    /var navState = forEachRootFiber\(function\(rootFiber\)\s*\{\s*return findNav\(rootFiber\);/,
    'getNavState not migrated to forEachRootFiber',
  );
});

test('B145: findNavRef walks all renderers for NavigationContainer ref', () => {
  // findNavRef's final return is a forEachRootFiber call.
  const src = INJECTED_HELPERS;
  const idx = src.indexOf('function findNavRef');
  assert.ok(idx >= 0, 'findNavRef definition missing');
  const slice = src.slice(idx, idx + 2000);
  assert.match(
    slice,
    /return forEachRootFiber\(function\(rootFiber\)/,
    'findNavRef did not migrate to forEachRootFiber',
  );
});

test('B145: getComponentState walks all renderers for the testID', () => {
  const src = INJECTED_HELPERS;
  const idx = src.indexOf('function getComponentState');
  assert.ok(idx >= 0, 'getComponentState definition missing');
  const slice = src.slice(idx, idx + 2000);
  assert.match(
    slice,
    /forEachRootFiber\(function\(rootFiber\)\s*\{[\s\S]*?findByTestID\(rootFiber\);[\s\S]*?return targetFiber;/,
    'getComponentState did not migrate to forEachRootFiber',
  );
});

test('B145: getNavGraph fiber-walk fallback iterates all roots for containers', () => {
  // Pattern: `var allRoots = findAllRootFibers(); for (var ar = 0; ar < allRoots.length; ar++) { (function findContainers(...){...})(allRoots[ar].fiber, 0); }`
  // The container walker is an IIFE invoked once per renderer root.
  const src = INJECTED_HELPERS;
  const idx = src.indexOf('function getNavGraph');
  assert.ok(idx >= 0, 'getNavGraph definition missing');
  const slice = src.slice(idx, idx + 18000);
  assert.match(
    slice,
    /var allRoots = findAllRootFibers\(\)/,
    'getNavGraph did not migrate to findAllRootFibers',
  );
  assert.match(
    slice,
    /for \(var ar = 0; ar < allRoots\.length; ar\+\+\)/,
    'getNavGraph did not loop over allRoots',
  );
  assert.match(
    slice,
    /\}\)\(allRoots\[ar\]\.fiber, 0\);/,
    'container IIFE did not pass allRoots[ar].fiber as root',
  );
});

test('B145: isReady uses findAllRootFibers().length > 0 (not findActiveRenderer short-circuit)', () => {
  // Before: return !!findActiveRenderer();
  // After:  return findAllRootFibers().length > 0;
  const src = INJECTED_HELPERS;
  const idx = src.indexOf('isReady:');
  assert.ok(idx >= 0, 'isReady method missing');
  const slice = src.slice(idx, idx + 500);
  assert.match(
    slice,
    /findAllRootFibers\(\)\.length > 0/,
    'isReady did not migrate to findAllRootFibers',
  );
});

test('B145: findActiveRenderer still exists (kept for getTree unfiltered path + semantic "is any renderer ready")', () => {
  // Intentional: B143 left the unfiltered path on findActiveRenderer because
  // the 50KB output cap would be blown by multi-renderer union. Keep the
  // helper around so the unfiltered branch still works.
  assert.match(
    INJECTED_HELPERS,
    /function findActiveRenderer\((?:bounds)?\)/,
    'findActiveRenderer helper was accidentally removed',
  );
});
