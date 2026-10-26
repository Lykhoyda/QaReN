import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS, REACT_READY_PROBE_JS } from '../../dist/injected-helpers.js';

/**
 * Create a VM sandbox with mock React DevTools globals.
 * The INJECTED_HELPERS IIFE reads from globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__
 * to find the fiber root, and from globalThis for store/nav globals.
 */
function createSandbox(opts = {}) {
  const sandbox = {
    globalThis: {},
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Error,
    Date,
    parseInt,
    parseFloat,
    typeof: undefined,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
  };
  // Share the globalThis reference
  sandbox.globalThis = sandbox;

  // Set up React DevTools hook with a mock fiber root
  if (opts.hook) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  } else if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: opts.fiberRoot }]),
    };
  }

  // Copy any extra globals
  if (opts.globals) {
    Object.assign(sandbox, opts.globals);
  }

  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

// ── B3: Navigation state hook walker ─────────────────────────────────

test('getNavState: finds nav state in first hook position', () => {
  const navState = { routes: [{ name: 'Home' }], index: 0, routeNames: ['Home'] };
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: navState,
      next: null,
    },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getNavState());
  assert.equal(result.routeName, 'Home');
  assert.deepEqual(result.stack, ['Home']);
});

test('getNavState: finds nav state in third hook position (B3 regression)', () => {
  const navState = {
    routes: [{ name: 'Profile' }, { name: 'Settings' }],
    index: 1,
    routeNames: ['Profile', 'Settings'],
  };
  // Simulate: useState, useRef, then useReducer with nav state
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: 'not-nav-state', // useState
      next: {
        memoizedState: { current: null }, // useRef
        next: {
          memoizedState: navState, // nav state in 3rd position
          next: null,
        },
      },
    },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getNavState());
  assert.equal(result.routeName, 'Settings');
  assert.equal(result.index, 1);
});

test('getNavState: finds nav state in queue.lastRenderedState', () => {
  const navState = { routes: [{ name: 'Dashboard' }], index: 0, routeNames: ['Dashboard'] };
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: null,
      queue: { lastRenderedState: navState },
      next: null,
    },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getNavState());
  assert.equal(result.routeName, 'Dashboard');
});

test('getNavState: finds nav state via ExpoRoot fiber name', () => {
  const navState = { routes: [{ name: 'Index' }], index: 0, routeNames: ['Index'] };
  const fiber = {
    type: { name: 'ExpoRoot' },
    memoizedState: { memoizedState: navState, next: null },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getNavState());
  assert.equal(result.routeName, 'Index');
});

test('getNavState: returns error when no nav state in hooks', () => {
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: {
      memoizedState: 'just a string',
      next: { memoizedState: 42, next: null },
    },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getNavState());
  assert.ok(result.error, 'Should return an error when no nav state found');
});

// ── B4: Jotai store detection ────────────────────────────────────────

test('getStoreState: reads Jotai atoms via __JOTAI_STORE__ + __JOTAI_ATOMS__', () => {
  const countAtom = { __brand: 'countAtom' };
  const userAtom = { __brand: 'userAtom' };
  const atomValues = new Map([
    [countAtom, 42],
    [userAtom, { name: 'Alice' }],
  ]);

  const sandbox = createSandbox({
    globals: {
      __JOTAI_STORE__: { get: (atom) => atomValues.get(atom) },
      __JOTAI_ATOMS__: { count: countAtom, user: userAtom },
    },
  });
  const result = JSON.parse(sandbox.__QAREN.getStoreState(undefined, 'jotai'));
  assert.equal(result.type, 'jotai');
  assert.equal(result.state.count, 42);
  assert.deepEqual(result.state.user, { name: 'Alice' });
});

test('getStoreState: handles Jotai atom that throws', () => {
  const goodAtom = { __brand: 'good' };
  const badAtom = { __brand: 'bad' };

  const sandbox = createSandbox({
    globals: {
      __JOTAI_STORE__: {
        get: (atom) => {
          if (atom === badAtom) throw new Error('derived atom not ready');
          return 'ok';
        },
      },
      __JOTAI_ATOMS__: { good: goodAtom, bad: badAtom },
    },
  });
  const result = JSON.parse(sandbox.__QAREN.getStoreState(undefined, 'jotai'));
  assert.equal(result.type, 'jotai');
  assert.equal(result.state.good, 'ok');
  assert.match(result.state.bad, /error.*derived atom not ready/);
});

test('getStoreState: skips Jotai when store lacks get function', () => {
  const sandbox = createSandbox({
    globals: {
      __JOTAI_STORE__: { noGetMethod: true },
      __JOTAI_ATOMS__: { count: {} },
    },
  });
  const result = JSON.parse(sandbox.__QAREN.getStoreState());
  assert.ok(result.__agent_error, 'Should return no-store error when Jotai store lacks get()');
});

test('getStoreState: no-store error includes Jotai hint', () => {
  const sandbox = createSandbox({});
  const result = JSON.parse(sandbox.__QAREN.getStoreState());
  assert.ok(result.hint3, 'hint3 should exist for Jotai');
  assert.match(result.hint3, /JOTAI_STORE/);
});

// ── M8: findActiveRenderer 1..5 probe ────────────────────────────────
// Proves the probe finds fiber roots regardless of hook.renderers population state.

test('M8: findActiveRenderer finds root at renderer ID 1 (happy path, no regression)', () => {
  const fiber = { type: { name: 'App' }, child: null, sibling: null };
  const hook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id) => (id === 1 ? new Set([{ current: fiber }]) : new Set()),
  };
  const sandbox = createSandbox({ hook });
  assert.equal(sandbox.__QAREN.isReady(), true);
});

test('M8: findActiveRenderer probes past empty IDs to renderer 4', () => {
  const fiber = { type: { name: 'App' }, child: null, sibling: null };
  const hook = {
    renderers: new Map(),
    getFiberRoots: (id) => (id === 4 ? new Set([{ current: fiber }]) : new Set()),
  };
  const sandbox = createSandbox({ hook });
  assert.equal(sandbox.__QAREN.isReady(), true);
});

test('M8: findActiveRenderer succeeds when hook.renderers is empty (story repro)', () => {
  const fiber = { type: { name: 'App' }, child: null, sibling: null };
  const hook = {
    renderers: new Map(),
    getFiberRoots: (id) => (id === 1 ? new Set([{ current: fiber }]) : new Set()),
  };
  const sandbox = createSandbox({ hook });
  assert.equal(sandbox.__QAREN.isReady(), true);
});

test('M8: findActiveRenderer returns null when no renderer 1..5 has roots', () => {
  const hook = {
    renderers: new Map(),
    getFiberRoots: () => new Set(),
  };
  const sandbox = createSandbox({ hook });
  assert.equal(sandbox.__QAREN.isReady(), false);
});

test('M8: findActiveRenderer returns null when hook.getFiberRoots is missing', () => {
  const sandbox = createSandbox({ hook: { renderers: new Map() } });
  assert.equal(sandbox.__QAREN.isReady(), false);
});

// ── M8 + GH #597: REACT_READY_PROBE_JS for waitForReact ────────────
// Uses registered renderer IDs when available, with M8's numeric fallback for
// hook shims whose renderer registry is empty or malformed.

function evalProbe(hook) {
  const sandbox = { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return vm.runInContext(REACT_READY_PROBE_JS, sandbox);
}

test('M8 probe: returns true when fiber roots exist at renderer ID 1', () => {
  assert.equal(
    evalProbe({
      renderers: new Map(),
      getFiberRoots: (i) => (i === 1 ? new Set([{}]) : new Set()),
    }),
    true,
  );
});

test('M8 probe: returns true when fiber roots only at renderer ID 4 (renderers map empty)', () => {
  assert.equal(
    evalProbe({
      renderers: new Map(),
      getFiberRoots: (i) => (i === 4 ? new Set([{}]) : new Set()),
    }),
    true,
  );
});

test('GH #597 probe: returns true for a registered renderer above the numeric fallback cap', () => {
  assert.equal(
    evalProbe({
      renderers: new Map([
        [1, {}],
        [21, {}],
      ]),
      getFiberRoots: (i) => (i === 21 ? new Set([{}]) : new Set()),
    }),
    true,
  );
});

test('GH #597 probe: a partial renderer registry retains numeric-probe coverage', () => {
  assert.equal(
    evalProbe({
      renderers: new Map([[1, {}]]),
      getFiberRoots: (i) => (i === 2 ? new Set([{}]) : new Set()),
    }),
    true,
  );
});

test('GH #597 probe: a throwing registered renderer does not mask a later live renderer', () => {
  assert.equal(
    evalProbe({
      renderers: new Map([
        [1, {}],
        [2, {}],
      ]),
      getFiberRoots(i) {
        if (i === 1) throw new Error('renderer teardown');
        return i === 2 ? new Set([{}]) : new Set();
      },
    }),
    true,
  );
});

test('M8 probe: returns false when no renderer has fiber roots', () => {
  assert.equal(
    evalProbe({
      renderers: new Map(),
      getFiberRoots: () => new Set(),
    }),
    false,
  );
});

test('M8 probe: returns false when hook.getFiberRoots is missing', () => {
  assert.equal(evalProbe({ renderers: new Map() }), false);
});

test('M8 probe: returns false when hook itself is absent', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  assert.equal(vm.runInContext(REACT_READY_PROBE_JS, sandbox), false);
});

// ── M10: architecture detection in getAppInfo ─────────────────────────
// Fabric-wins on "both present" (transient interop state during migration).
// `__fbBatchedBridge` alone → classic bridge. Neither → unknown.

function appInfoFrom(globals) {
  const sandbox = createSandbox({ globals });
  return JSON.parse(sandbox.__QAREN.getAppInfo());
}

test('M10: getAppInfo returns architecture=new when nativeFabricUIManager present', () => {
  const info = appInfoFrom({
    nativeFabricUIManager: {
      /* Fabric object */
    },
  });
  assert.equal(info.architecture, 'new');
});

test('M10: getAppInfo returns architecture=old when __fbBatchedBridge present and Fabric absent', () => {
  const info = appInfoFrom({ __fbBatchedBridge: { getCallableModule: () => null } });
  assert.equal(info.architecture, 'old');
});

test('M10: getAppInfo returns architecture=unknown when neither signal present', () => {
  const info = appInfoFrom({});
  assert.equal(info.architecture, 'unknown');
});

test('M10: getAppInfo returns architecture=new when BOTH Fabric and bridge present (Fabric wins)', () => {
  const info = appInfoFrom({
    nativeFabricUIManager: {
      /* Fabric */
    },
    __fbBatchedBridge: { getCallableModule: () => null },
  });
  assert.equal(info.architecture, 'new');
});

test('M10: getAppInfo returns architecture=unknown when nativeFabricUIManager is null (guard works)', () => {
  // Only __fbBatchedBridge falsy too → unknown
  const info = appInfoFrom({ nativeFabricUIManager: null });
  assert.equal(info.architecture, 'unknown');
});

test('#321: helpers bundle embeds HELPERS_VERSION (value-agnostic; feature branches bump it freely above the 26 baseline)', () => {
  assert.match(INJECTED_HELPERS, /__HELPERS_VERSION__\s*=\s*\d+/);
});
