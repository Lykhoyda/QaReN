import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

const LEGACY_MESSAGE = 'Navigation state not found. Is React Navigation or Expo Router installed?';
const SPARSE_RENDERER_ID = 7;

type Fiber = {
  type?: { displayName?: string };
  memoizedState?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
};

type NavState = {
  routes: Array<{ name: string; params?: Record<string, unknown> }>;
  index: number;
};

function mountedNavFiber(): Fiber {
  const state: NavState = {
    routes: [{ name: 'Home', params: {} }],
    index: 0,
  };
  return {
    type: { displayName: 'NavigationContainer' },
    memoizedState: { memoizedState: state, next: null },
    child: null,
    sibling: null,
  };
}

function createSandbox(hook: object | undefined, metroRegistry?: unknown) {
  const sandbox: Record<string, unknown> = {
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
  };
  sandbox.globalThis = sandbox;
  if (hook !== undefined) sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  if (metroRegistry !== undefined) sandbox.__r = { getModules: () => metroRegistry };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox as Record<string, any>;
}

function hookWithSparseRoot(opts: { renderers?: unknown }) {
  const fiber = mountedNavFiber();
  const hook: Record<string, unknown> = {
    getFiberRoots: (rendererId: number) =>
      rendererId === SPARSE_RENDERER_ID ? new Set([{ current: fiber }]) : new Set(),
  };
  if ('renderers' in opts) hook.renderers = opts.renderers;
  return hook;
}

function parseNavState(sandbox: Record<string, any>) {
  return JSON.parse(sandbox.__QAREN.getNavState());
}

test('#789 malformed renderers registry + sparse root >5: legacy no-nav, never mounting', () => {
  const sandbox = createSandbox(hookWithSparseRoot({ renderers: { keys: 1 } }));
  const result = parseNavState(sandbox);
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#789 incomplete sparse scan ignores Metro navigation evidence', () => {
  const sandbox = createSandbox(
    hookWithSparseRoot({ renderers: { keys: 1 } }),
    new Map([
      [0, { verboseName: 'node_modules/react-native/index.js' }],
      [1, { verboseName: 'node_modules/@react-navigation/native/lib/module/index.js' }],
    ]),
  );
  const result = parseNavState(sandbox);
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
  assert.equal(result.frameworkDetected, undefined);
});

test('#789 missing renderers registry + sparse root >5: legacy no-nav, never mounting', () => {
  const sandbox = createSandbox(hookWithSparseRoot({}));
  const result = parseNavState(sandbox);
  assert.equal(result.error, LEGACY_MESSAGE);
  assert.notEqual(result.mounting, true);
});

test('#789 complete empty scan with a usable registry still reports mounting', () => {
  const sandbox = createSandbox({
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set(),
  });
  const result = parseNavState(sandbox);
  assert.match(result.error, /App is still mounting[\s\S]*[Rr]etry in ~2s/);
  assert.equal(result.mounting, true);
  assert.doesNotMatch(result.error, /Is React Navigation or Expo Router installed/);
});

test('#789 usable registry still discovers a sparse renderer ID above 5', () => {
  const sandbox = createSandbox(
    hookWithSparseRoot({
      renderers: new Map([
        [1, {}],
        [SPARSE_RENDERER_ID, {}],
      ]),
    }),
  );
  const result = parseNavState(sandbox);
  assert.equal(result.error, undefined);
  assert.equal(result.routeName, 'Home');
  assert.notEqual(result.mounting, true);
});
