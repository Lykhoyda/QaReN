import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../../dist/injected-helpers.js';

export { INJECTED_HELPERS };

// Runs the injected IIFE in an isolated vm context with a minimal global
// whitelist (mirrors gh-60-bug-5-label-matching.test.js). When opts.fiberRoot
// is given, exposes a one-renderer DevTools hook so the IIFE's
// findAllRootFibers() discovers the fake tree.
export function createSandbox(opts = {}) {
  const sandbox = {
    Array,
    Object,
    JSON,
    Map,
    Set,
    WeakSet,
    WeakMap,
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
  if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id) => (id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set()),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

// Build a fake fiber tree. spec:
//   { name }      → composite component (type = { displayName: name })
//   { hostType }  → host node       (type = "RCTText" etc., a string)
//   { text }      → text node       (memoizedProps = the raw string)
//   { props, children }
export function buildFiber(spec, parent = null) {
  const isText = typeof spec.text === 'string';
  const fiber = {
    type: spec.name ? { displayName: spec.name } : spec.hostType != null ? spec.hostType : null,
    memoizedProps: isText ? spec.text : spec.props || {},
    return: parent,
    child: null,
    sibling: null,
    stateNode: spec.stateNode || null,
  };
  if (spec.children && spec.children.length) {
    let prev = null;
    for (const c of spec.children) {
      const child = buildFiber(c, fiber);
      if (!fiber.child) fiber.child = child;
      else prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}
