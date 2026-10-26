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
  const navigated: string[] = [];
  const state: NavigationState = {
    routes: [{ name: 'Home' }, { name: 'Profile' }],
    routeNames: ['Home', 'Profile'],
    index: 0,
  };
  const ref: NavigationRef = {
    navigate: (screen) => navigated.push(screen),
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
  return { fiber, navigated };
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
          navigateTo: (screen: string) => string;
          getNavState: () => string;
          getTree: (opts?: object) => string;
          getNavGraph: () => string;
        }
      | undefined,
  };
  const context = Object.assign(sandbox, { globalThis: sandbox });
  vm.createContext(context);
  vm.runInContext(INJECTED_HELPERS, context);
  return context.__QAREN!;
}

function assertNavigationDiscovered(hook: RendererHook, navigated: string[]) {
  const agent = createSandbox(hook);
  const navigationResult = JSON.parse(agent.navigateTo('Profile'));
  const stateResult = JSON.parse(agent.getNavState());

  assert.equal(navigationResult.navigated, true);
  assert.deepEqual(navigated, ['Profile']);
  assert.equal(stateResult.routeName, 'Home');
  assert.deepEqual(stateResult.stack, ['Home', 'Profile']);
}

test('GH #597: empty renderer 1 does not mask the live navigation tree in renderer 2', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: registered renderer IDs are used instead of a bounded numeric guess', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [21, {}],
    ]),
    getFiberRoots: (rendererId) => (rendererId === 21 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: a partial renderer registry retains numeric-probe coverage', () => {
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: an unusable renderer does not abort a later live renderer', () => {
  const { fiber, navigated } = createNavigationFixture();
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

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: a non-navigation tree in the first live renderer does not mask a later one', () => {
  const { fiber, navigated } = createNavigationFixture();
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

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: a renderers iterator that never reports done degrades to the numeric probe', () => {
  // The endless value (999) is outside the numeric probe and empty, and the
  // live root sits at a different probe ID (2): only an implementation that
  // discards the overflowing registry and falls back to the bounded numeric
  // probe can discover it.
  const { fiber, navigated } = createNavigationFixture();
  const hook = {
    renderers: {
      keys: () => ({ next: () => ({ done: false, value: 999 }) }),
    },
    getFiberRoots: (rendererId: number) =>
      rendererId === 2 ? new Set([{ current: fiber }]) : new Set<{ current: Fiber }>(),
  } as unknown as RendererHook;

  assertNavigationDiscovered(hook, navigated);
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
  const { fiber, navigated } = createNavigationFixture();
  const hook: RendererHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId) => (rendererId === 1 ? new Set([{ current: fiber }]) : new Set()),
  };

  assertNavigationDiscovered(hook, navigated);
});

test('GH #597: forwardRef-wrapped NavigationContainer on a later renderer is discovered', () => {
  // Live shape from React Navigation 7.x + React 19 (bridgeless): fiber.type is
  // the forwardRef wrapper object — displayName/name live only on type.render.
  const { fiber, navigated } = createNavigationFixture();
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

  assertNavigationDiscovered(hook, navigated);
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

  const agent = createSandbox(hook);
  const navigationResult = JSON.parse(agent.navigateTo('Profile'));
  const stateResult = JSON.parse(agent.getNavState());

  assert.equal(navigationResult.navigated, undefined);
  assert.match(String(navigationResult.__agent_error), /^Navigation ref not found\./);
  assert.match(String(stateResult.error), /^Navigation state not found\./);
});

test('GH #597: nav graph resolves a forwardRef-named container fiber on a later renderer', () => {
  const { fiber } = createNavigationFixture();
  const forwardRefFiber = {
    ...fiber,
    type: {
      $$typeof: Symbol.for('react.forward_ref'),
      render: function NavigationContainer() {},
    },
    ref: null,
  } as unknown as Fiber;
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (rendererId) =>
      rendererId === 2 ? new Set([{ current: forwardRefFiber }]) : new Set(),
  };

  const graph = JSON.parse(createSandbox(hook).getNavGraph());

  assert.equal(graph.error, undefined);
  assert.equal(graph.containers_found, 1);
  assert.equal(graph.library, 'react-navigation');
  assert.deepEqual(
    graph.navigators[0].routes.map((route: { name: string }) => route.name),
    ['Home', 'Profile'],
  );
});

test('GH #597: nav graph falls back to nav-ref discovery for NavigationContainerInner', () => {
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

  const graph = JSON.parse(createSandbox(hook).getNavGraph());

  assert.equal(graph.error, undefined);
  assert.equal(graph.library, 'react-navigation');
  assert.deepEqual(
    graph.navigators[0].routes.map((route: { name: string }) => route.name),
    ['Home', 'Profile'],
  );
});

test('GH #597: nav graph no-match control keeps its exact error semantics', () => {
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
    getFiberRoots: (rendererId) => (rendererId === 2 ? new Set([{ current: shell }]) : new Set()),
  };

  const graph = JSON.parse(createSandbox(hook).getNavGraph());

  assert.match(String(graph.error), /^No navigation state found\./);
});
