import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

type Fiber = {
  type?: { displayName?: string };
  ref?: { current: NavigationRef } | null;
  memoizedState?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
};

type NavigationState = {
  routes: Array<{ name: string }>;
  routeNames: string[];
  index: number;
};

type NavigationRef = {
  navigate: (screen: string) => void;
  dispatch: () => void;
  getRootState: () => NavigationState;
};

type RendererHook = {
  renderers: Map<number, object>;
  getFiberRoots: (rendererId: number) => Set<{ current: Fiber }> | null;
};

function createNavigationFixture() {
  const state: NavigationState = {
    routes: [{ name: 'Home' }, { name: 'Profile' }],
    routeNames: ['Home', 'Profile'],
    index: 0,
  };
  const ref: NavigationRef = {
    navigate: () => {},
    dispatch: () => {},
    getRootState: () => state,
  };
  const fiber: Fiber = {
    type: { displayName: 'NavigationContainer' },
    ref: { current: ref },
    memoizedState: { memoizedState: state, next: null },
    child: null,
    sibling: null,
  };
  return { fiber };
}

function createSandbox(hook: RendererHook) {
  const sandbox = {
    Array,
    Object,
    JSON,
    Map,
    Set,
    WeakSet,
    Error,
    Date,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    __QAREN: undefined as
      | {
          getNavState: () => string;
          getTree: (opts?: object) => string;
        }
      | undefined,
  };
  const context = Object.assign(sandbox, { globalThis: sandbox });
  vm.createContext(context);
  vm.runInContext(INJECTED_HELPERS, context);
  return context.__QAREN!;
}

// Hook-held state first, then the nav-ref fallback (findNavRef) once the hooks are cleared.
function assertNavigationDiscovered(hook: RendererHook, fiber: Fiber) {
  for (const source of ['hooks', 'nav ref']) {
    if (source === 'nav ref') fiber.memoizedState = null;
    const stateResult = JSON.parse(createSandbox(hook).getNavState());
    assert.equal(stateResult.routeName, 'Home', source);
    assert.deepEqual(stateResult.stack, ['Home', 'Profile'], source);
  }
}

test('GH #597: empty renderer 1 does not mask the live navigation tree in renderer 2', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: registered renderer IDs are used instead of a bounded numeric guess', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [21, {}],
    ]),
    getFiberRoots: (rendererId) => (rendererId === 21 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: a partial renderer registry retains numeric-probe coverage', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: an unusable renderer does not abort a later live renderer', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots(rendererId) {
      if (rendererId === 1) throw new Error('renderer is tearing down');
      return rendererId === 2 ? new Set([{ current: fiber }]) : null;
    },
  };

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: a non-navigation tree in the first live renderer does not mask a later one', () => {
  const { fiber } = createNavigationFixture();
  const shell: Fiber = {
    type: { displayName: 'LogBox' },
    child: null,
    sibling: null,
  };
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots(rendererId) {
      if (rendererId === 1) return new Set([{ current: shell }]);
      return rendererId === 2 ? new Set([{ current: fiber }]) : null;
    },
  };

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: a renderers iterator that never reports done degrades to the numeric probe', () => {
  // The endless value (999) is outside the numeric probe and empty, and the
  // live root sits at a different probe ID (2): only an implementation that
  // discards the overflowing registry and falls back to the bounded numeric
  // probe can discover it.
  const { fiber } = createNavigationFixture();
  const hook = {
    renderers: {
      keys: () => ({ next: () => ({ done: false, value: 999 }) }),
    },
    getFiberRoots: (rendererId: number) =>
      rendererId === 2 ? new Set([{ current: fiber }]) : new Set<{ current: Fiber }>(),
  } as unknown as RendererHook;

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: getTree readiness gate honors a high registered renderer after empty low IDs', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[21, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 21 ? new Set([{ current: fiber }]) : new Set()),
  };

  const agent = createSandbox(hook);
  const treeResult = JSON.parse(agent.getTree());

  assert.equal(treeResult.error, undefined);
  assert.equal(treeResult.rootsSeeded, 1);
  assert.equal(treeResult.tree?.component, 'NavigationContainer');
});

test('GH #597: getTree readiness gate keeps numeric-probe coverage for a partial registry', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: fiber }]) : new Set()),
  };

  const agent = createSandbox(hook);
  const treeResult = JSON.parse(agent.getTree());

  assert.equal(treeResult.error, undefined);
  assert.equal(treeResult.rootsSeeded, 1);
  assert.equal(treeResult.tree?.component, 'NavigationContainer');
});

test('GH #597: the proven single-renderer navigation path remains supported', () => {
  const { fiber } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 1 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, fiber);
});

test('GH #597: forwardRef-wrapped NavigationContainer on a later renderer is discovered', () => {
  // Live shape from React Navigation 7.x + React 19 (bridgeless): fiber.type is
  // the forwardRef wrapper object — displayName/name live only on type.render.
  const { fiber } = createNavigationFixture();
  const forwardRefFiber = {
    ...fiber,
    type: {
      $$typeof: Symbol.for('react.forward_ref'),
      render: function NavigationContainerInner() {},
    },
  } as unknown as Fiber;
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (rendererId) =>
      rendererId === 2 ? new Set([{ current: forwardRefFiber }]) : new Set(),
  };

  assertNavigationDiscovered(hook, forwardRefFiber);
});

test('GH #597: no-match control — scanning every renderer never fabricates a ref', () => {
  // Mounted app content, not a LogBox shell: getNavState reads a shell-only
  // tree as mid-mount (GH #525), which would mask this control's no-match case.
  const shell: Fiber = {
    type: { displayName: 'MountedAppRoot' },
    child: null,
    sibling: null,
  };
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots(rendererId) {
      if (rendererId === 2) return new Set([{ current: shell }]);
      return new Set();
    },
  };

  const stateResult = JSON.parse(createSandbox(hook).getNavState());

  assert.match(String(stateResult.error), /^Navigation state not found\./);
});
