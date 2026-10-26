// GH #126 Gap B — extra fiber roots for portal modal support.
//
// Tests cover (1) the extractFiberFromInstance helper in isolation,
// (2) the iterateAllRoots primitive's extra-roots step exercised via
// the findAllRootFibers wrapper, (3) the forEachRootFiber wrapper's
// delegation preserves short-circuit semantics through to extra-roots,
// and (4) end-to-end: cdp_interact press testID inside an extra-root
// subtree fires the component's onPress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

/**
 * Build a fresh VM sandbox with the INJECTED_HELPERS IIFE evaluated.
 * `opts.hook` overrides the React DevTools hook (default: provides
 * one renderer at ID 1 with the given `rootFiber`). `opts.extraRoots`
 * sets `globalThis.__QAREN_EXTRA_ROOTS__` to the given function.
 * Returns the populated sandbox so tests can call __QAREN methods.
 */
function makeSandbox(opts = {}) {
  const sandbox = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Set,
    Error,
    Date,
    RegExp,
    Symbol,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  if (opts.hook) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  } else if (opts.rootFiber) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id) => (id === 1 ? new Set([{ current: opts.rootFiber }]) : new Set()),
    };
  } else {
    // No native renderer roots — tests that ONLY care about extra-roots.
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      getFiberRoots: () => new Set(),
    };
  }
  if (typeof opts.extraRoots === 'function') {
    sandbox.__QAREN_EXTRA_ROOTS__ = opts.extraRoots;
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

/**
 * Link parent→child and back-pointer so the synthetic tree behaves
 * like a real React fiber tree (walk-up via .return, walk-down via .child).
 */
function linkFiber(parent, child) {
  parent.child = child;
  child.return = parent;
  return child;
}

/**
 * Minimal fiber stub. Tests extend `memoizedProps` as needed; the stub
 * does NOT include stateNode/tag/flags/lanes — add per-test if a downstream
 * consumer (e.g. interact()) probes them.
 */
function fiber(props) {
  return {
    type: { displayName: (props && props.displayName) || 'View' },
    memoizedProps: (props && props.memoizedProps) || {},
    child: null,
    sibling: null,
    return: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractFiberFromInstance — exposed via __QAREN.__extractFiberFromInstance
// for testing (otherwise it's an inner closure, unreachable from VM tests).
// ─────────────────────────────────────────────────────────────────────────────

test('extractFiberFromInstance: instance with _reactInternals returns the fiber', () => {
  const sandbox = makeSandbox({});
  const f = fiber({ displayName: 'MySheet' });
  const instance = { _reactInternals: f };
  // Pass the instance through a function call so the sandbox can use it.
  const got = vm.runInContext(
    '(function(inst) { return __QAREN.__extractFiberFromInstance(inst); })',
    sandbox,
  )(instance);
  assert.equal(got, f, 'should extract the fiber via _reactInternals');
});

test('extractFiberFromInstance: instance with _reactInternalFiber returns the fiber (legacy React)', () => {
  const sandbox = makeSandbox({});
  const f = fiber({ displayName: 'LegacyModal' });
  const instance = { _reactInternalFiber: f };
  const got = vm.runInContext(
    '(function(inst) { return __QAREN.__extractFiberFromInstance(inst); })',
    sandbox,
  )(instance);
  assert.equal(got, f);
});

test('extractFiberFromInstance: already-a-fiber input passes through; generator-like with only .return is rejected', () => {
  const sandbox = makeSandbox({});
  const realFiber = fiber({ displayName: 'PortalRoot' });
  const generatorLike = { return: function () {} }; // has .return but no .child
  const extract = vm.runInContext(
    '(function(inst) { return __QAREN.__extractFiberFromInstance(inst); })',
    sandbox,
  );
  assert.equal(extract(realFiber), realFiber, 'fiber-shaped input returned as-is');
  assert.equal(extract(generatorLike), null, 'partial key (return only) is rejected');
  assert.equal(extract(null), null, 'null returns null');
  assert.equal(extract(undefined), null, 'undefined returns null');
  assert.equal(extract('not-an-object'), null, 'non-object returns null');
});

// ─────────────────────────────────────────────────────────────────────────────
// iterateAllRoots extra-roots integration — exercised via findAllRootFibers.
// Each test seeds a tiny synthetic renderer root + an extra-roots resolver,
// then calls __QAREN.__findAllRootFibers() to read them. iterateAllRoots
// itself is private; we test through its closest public wrapper.
// ─────────────────────────────────────────────────────────────────────────────

function callFindAllRootFibers(sandbox) {
  return vm.runInContext('__QAREN.__findAllRootFibers()', sandbox);
}

test('iterateAllRoots: instance with neither _reactInternals nor _reactInternalFiber → that entry skipped, others succeed', () => {
  const goodFiber = fiber({ displayName: 'GoodPortal' });
  const sandbox = makeSandbox({
    extraRoots: () => [
      { notAFiber: true }, // skipped — no extraction path
      { _reactInternals: goodFiber }, // included
    ],
  });
  const all = callFindAllRootFibers(sandbox);
  const extras = all.filter((r) => r.rendererId === -1);
  assert.equal(extras.length, 1, 'only the well-formed instance should be added');
  assert.equal(extras[0].fiber, goodFiber);
});

test('iterateAllRoots: mixed array with null items → nulls skipped, valid ones added', () => {
  const goodFiber = fiber({ displayName: 'GoodPortal' });
  const sandbox = makeSandbox({
    extraRoots: () => [null, { _reactInternals: goodFiber }, undefined, null].filter(Boolean),
  });
  const extras = callFindAllRootFibers(sandbox).filter((r) => r.rendererId === -1);
  assert.equal(extras.length, 1, 'filter(Boolean) idiom should work cleanly');
  assert.equal(extras[0].fiber, goodFiber);
});

test('iterateAllRoots: resolver throws → renderer roots remain in output, extra-roots step skipped', () => {
  const rendererRoot = fiber({ displayName: 'MainApp' });
  const sandbox = makeSandbox({
    rootFiber: rendererRoot,
    extraRoots: () => {
      throw new Error('user bug in resolver');
    },
  });
  const all = callFindAllRootFibers(sandbox);
  const renderers = all.filter((r) => r.rendererId === 1);
  const extras = all.filter((r) => r.rendererId === -1);
  assert.equal(renderers.length, 1, 'renderer roots survive a thrown resolver');
  assert.equal(renderers[0].fiber, rendererRoot);
  assert.equal(extras.length, 0, 'no extras when resolver throws');
});

test('iterateAllRoots: resolver returns non-array → skipped silently, renderer roots still in output', () => {
  const rendererRoot = fiber({ displayName: 'MainApp' });
  const sandbox = makeSandbox({
    rootFiber: rendererRoot,
    extraRoots: () => ({ not: 'an-array' }),
  });
  const all = callFindAllRootFibers(sandbox);
  assert.equal(all.filter((r) => r.rendererId === -1).length, 0);
  assert.equal(all.filter((r) => r.rendererId === 1).length, 1);
});

test('iterateAllRoots: __QAREN_EXTRA_ROOTS__ undefined → output equals pre-PR baseline (backward compat)', () => {
  const rendererRoot = fiber({ displayName: 'MainApp' });
  const sandbox = makeSandbox({ rootFiber: rendererRoot });
  // Note: extraRoots NOT passed — __QAREN_EXTRA_ROOTS__ is undefined.
  const all = callFindAllRootFibers(sandbox);
  assert.equal(all.length, 1, 'only the renderer root, no synthetic extras');
  assert.equal(all[0].rendererId, 1);
  assert.equal(all[0].fiber, rendererRoot);
});

// ─────────────────────────────────────────────────────────────────────────────
// forEachRootFiber wrapper — must preserve truthy short-circuit through
// to extra-roots. A future refactor that breaks delegation (e.g., always
// returns null after the renderer loop) would silently lose the ability
// to find a target in an extra-root subtree. This test pins it.
// ─────────────────────────────────────────────────────────────────────────────

test('forEachRootFiber: cb returning truthy on an extra-root short-circuits iteration', () => {
  const rendererRoot = fiber({ displayName: 'MainApp' });
  const extraRoot = fiber({ displayName: 'PortalRoot' });
  let cbCalls = 0;
  const sandbox = makeSandbox({
    rootFiber: rendererRoot,
    extraRoots: () => [{ _reactInternals: extraRoot }],
  });
  const result = vm.runInContext(
    '(function(cb) { return __QAREN.__forEachRootFiber(cb); })',
    sandbox,
  )((rootFiber, rendererId) => {
    cbCalls++;
    // Match only the extra-root (rendererId === -1). Returning truthy
    // must immediately short-circuit iteration.
    return rendererId === -1 ? rootFiber : null;
  });
  assert.equal(result, extraRoot, 'extra-root fiber returned via short-circuit');
  assert.equal(
    cbCalls,
    2,
    'cb called for renderer root (no match), then extra root (match) — no further calls',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Two additional regression-coverage tests folded in from Task 4's code
// review — they pin behavior the original 5 tests didn't discriminate.
// ─────────────────────────────────────────────────────────────────────────────

test('iterateAllRoots: sparse array (holes) — holes treated as undefined and skipped', () => {
  // A resolver returning `Array(N)` produces an array with `length === N`
  // but no own indices. instances[i] reads undefined for each hole. The
  // for-loop must skip them via extractFiberFromInstance's null-return,
  // not iterate forever or throw.
  const goodFiber = fiber({ displayName: 'GoodPortal' });
  const sandbox = makeSandbox({
    extraRoots: () => {
      const arr = Array.from({ length: 5 });
      arr[2] = { _reactInternals: goodFiber };
      return arr;
    },
  });
  const extras = callFindAllRootFibers(sandbox).filter((r) => r.rendererId === -1);
  assert.equal(extras.length, 1, 'only the populated index should yield a fiber');
  assert.equal(extras[0].fiber, goodFiber);
});

test('iterateAllRoots: non-function resolver (e.g., array assigned directly) — typeof guard skips silently', () => {
  // Users will plausibly try `__QAREN_EXTRA_ROOTS__ = [ref.current]`
  // (an array) instead of `() => [ref.current]` (a function). The
  // `typeof extraResolver === 'function'` guard MUST treat non-functions
  // as no-op rather than throwing or partially executing.
  const rendererRoot = fiber({ displayName: 'MainApp' });
  // Manually set a non-function value, bypassing makeSandbox's auto-cast.
  const sandbox = makeSandbox({ rootFiber: rendererRoot });
  vm.runInContext('__QAREN_EXTRA_ROOTS__ = [{ _reactInternals: {} }];', sandbox);
  const all = callFindAllRootFibers(sandbox);
  assert.equal(all.length, 1, 'only the renderer root — non-function resolver must be ignored');
  assert.equal(all[0].rendererId, 1);
  assert.equal(all[0].fiber, rendererRoot);
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: cdp_interact press testID flows through the real interact()
// entry point in injected-helpers, which uses forEachRootFiber → iterateAllRoots
// → extra-roots step → extractFiberFromInstance. If the entire chain works,
// onPress fires on a component that lives ONLY in an extra-root subtree —
// proving the user-visible bug from GH #126 Gap B is actually fixed.
// ─────────────────────────────────────────────────────────────────────────────

test('end-to-end: cdp_interact press testID resolves to component inside extra-root subtree, onPress fires', () => {
  let onPressFired = false;
  const buttonFiber = fiber({
    displayName: 'Pressable',
    memoizedProps: {
      testID: 'modal-confirm-btn',
      onPress: () => {
        onPressFired = true;
      },
    },
  });
  // Modal root → Pressable child. The Pressable carries the testID.
  const modalRoot = fiber({ displayName: 'SheetProvider' });
  linkFiber(modalRoot, buttonFiber);

  // No renderer roots — the modal-rooted Pressable is ONLY reachable via
  // the extra-roots channel, mimicking the GH #126 reporter's setup.
  const sandbox = makeSandbox({
    extraRoots: () => [{ _reactInternals: modalRoot }],
  });

  const result = JSON.parse(
    vm.runInContext("__QAREN.interact({ action: 'press', testID: 'modal-confirm-btn' })", sandbox),
  );

  assert.equal(result.success, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.action, 'press');
  assert.equal(result.testID, 'modal-confirm-btn');
  assert.equal(onPressFired, true, 'onPress must fire on the matched component');
});
