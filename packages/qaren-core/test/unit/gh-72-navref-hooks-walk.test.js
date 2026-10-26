import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

// GH #72: findNavRef() must discover React Navigation's internal ref from the
// useNavigationContainerRef() hook chain when the host app renders
// <NavigationContainer> without a ref prop. Apps using Expo Router or
// minimalist setups commonly omit the ref. Without this, cdp_navigate fails
// with "Navigation ref not found" even though navigation is fully working.

function makeNavRefShape(extra = {}) {
  // The 3-method match required by the strict guard.
  return {
    navigate: () => {},
    dispatch: () => {},
    getRootState: () => ({ routes: [{ name: 'Home' }], index: 0, routeNames: ['Home'] }),
    ...extra,
  };
}

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
  sandbox.globalThis = sandbox;

  if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: opts.fiberRoot }]),
    };
  }
  if (opts.globals) Object.assign(sandbox, opts.globals);

  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

// Helper: invoke __QAREN.navigateTo and parse the JSON response.
function navigate(sandbox, screen, params) {
  const result = sandbox.globalThis.__QAREN.navigateTo(screen, params);
  return JSON.parse(result);
}

// ── Hooks-chain discovery (GH #72 core fix) ──

test('findNavRef: discovers ref from hooks chain when fiber.ref is absent (GH #72)', () => {
  const navRef = makeNavRefShape();
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: null,
    stateNode: null,
    memoizedState: {
      // The internal ref from useNavigationContainerRef() lives on the
      // hooks linked list. RN puts it in a hook with `.memoizedState.current`.
      memoizedState: { current: navRef },
      next: null,
    },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = navigate(sandbox, 'Home');
  assert.equal(result.navigated, true, 'should successfully navigate via hooks-chain ref');
  assert.equal(result.__agent_error, undefined, 'no error should surface when ref is found');
});

test('findNavRef: walks past unrelated hooks to find the nav ref', () => {
  const navRef = makeNavRefShape();
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: null,
    stateNode: null,
    memoizedState: {
      memoizedState: { value: 0 }, // useState hook
      next: {
        memoizedState: { tag: 'effect' }, // useEffect hook
        next: {
          memoizedState: { current: navRef }, // the nav ref hook
          next: null,
        },
      },
    },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = navigate(sandbox, 'Home');
  assert.equal(result.navigated, true);
});

test('findNavRef: rejects hook with .current.navigate but missing dispatch (strict match)', () => {
  // Strict match avoids picking up unrelated refs in apps with multiple
  // navigation libraries (e.g. react-navigation + react-native-navigation).
  const partial = { current: { navigate: () => {} } }; // missing dispatch + getRootState
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: null,
    stateNode: null,
    memoizedState: { memoizedState: partial, next: null },
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = navigate(sandbox, 'Home');
  assert.equal(result.navigated, undefined);
  assert.match(result.__agent_error || '', /Navigation ref not found/);
});

test('findNavRef: existing fiber.ref path still works (no regression)', () => {
  const navRef = makeNavRefShape();
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: { current: navRef }, // ref-prop path — pre-#72 behavior
    stateNode: null,
    memoizedState: null,
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = navigate(sandbox, 'Home');
  assert.equal(result.navigated, true);
});

test('findNavRef: globals path still wins over fiber walk (no regression)', () => {
  // __NAV_REF__ takes precedence — fiber walk is the fallback only.
  const globalRef = makeNavRefShape({
    getRootState: () => ({ routes: [{ name: 'GLOBAL' }], index: 0, routeNames: ['GLOBAL'] }),
  });
  const fiberRef = makeNavRefShape({
    getRootState: () => ({ routes: [{ name: 'FIBER' }], index: 0, routeNames: ['FIBER'] }),
  });
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: { current: fiberRef },
    memoizedState: null,
    child: null,
    sibling: null,
  };
  let navigatedTo = null;
  globalRef.navigate = (s) => {
    navigatedTo = `global:${s}`;
  };
  fiberRef.navigate = (s) => {
    navigatedTo = `fiber:${s}`;
  };
  const sandbox = createSandbox({
    fiberRoot: fiber,
    globals: { __NAV_REF__: globalRef },
  });
  navigate(sandbox, 'GLOBAL');
  assert.equal(navigatedTo, 'global:GLOBAL', '__NAV_REF__ must beat fiber walk');
});

test('findNavRef: error message lists all discovery paths (GH #72 step 3)', () => {
  // No fiber, no globals — error message should be informative.
  const sandbox = createSandbox({ fiberRoot: null });
  const result = navigate(sandbox, 'Home');
  assert.match(result.__agent_error || '', /Navigation ref not found/);
  assert.match(result.__agent_error || '', /__NAV_REF__/);
  assert.match(result.__agent_error || '', /useNavigationContainerRef|hooks/i);
});

test('findNavRef: hopGuard prevents infinite loop on circular hooks chain', () => {
  // Pathological: a hook whose .next points back to itself. Should not hang.
  const partial = { current: { unrelated: true } };
  const hookA = { memoizedState: partial, next: null };
  hookA.next = hookA; // circular
  const fiber = {
    type: { displayName: 'NavigationContainer' },
    memoizedState: hookA,
    child: null,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: fiber });
  const start = Date.now();
  const result = navigate(sandbox, 'Home');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `must terminate quickly, took ${elapsed}ms`);
  assert.match(result.__agent_error || '', /Navigation ref not found/);
});
