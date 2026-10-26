// GH #126 Gap A — explicit React Hook Form fallback action.
//
// cdp_interact action="setFieldValue" walks UP from the matched testID
// fiber looking for a Provider whose memoizedProps.value duck-types as a
// UseFormReturn (has setValue + getValues + control), then calls
// value.setValue(name, value, {shouldValidate, shouldDirty}). This
// unblocks the design-system-TextField + react-hook-form pattern where
// typeText's descendant walk can't find a TextInput-shaped fiber to
// fire onChangeText on (the field's state flows through field.onChange
// → context → setValue, not via a typeable handler).
//
// These tests build synthetic fiber trees in a VM sandbox and verify
// the walk-up + duck-type detection + side-effect call all work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

/**
 * Build a sandbox + fiber root + run __QAREN.interact, returning the
 * parsed JSON result. The fiber root layout is controlled by the caller
 * (`buildFiber` returns the root fiber; `interactOpts` are forwarded to
 * the interact handler).
 */
function runInteract(buildFiber, interactOpts) {
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
  const rootFiber = buildFiber();
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([{ current: rootFiber }]),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  const out = vm.runInContext(`__QAREN.interact(${JSON.stringify(interactOpts)})`, sandbox);
  return JSON.parse(out);
}

/**
 * Link parent→child and set up `return` pointers so the walk-up works
 * the same way React's fiber tree does in production.
 */
function linkFiber(parent, child) {
  parent.child = child;
  child.return = parent;
  return child;
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — FormProvider ancestor with a duck-typed UseFormReturn
// ─────────────────────────────────────────────────────────────────────────────

test('setFieldValue: walks up to FormProvider, calls setValue with name + value + default options', () => {
  const setValueCalls = [];
  const formReturn = {
    setValue(name, value, options) {
      setValueCalls.push({ name, value, options });
    },
    getValues() {
      return {};
    },
    control: { _formValues: { email: '' } },
  };

  const result = runInteract(
    () => {
      // root → FormProvider (the value-carrying Provider) → wrapper → anchor.
      const root = {
        type: { displayName: 'App' },
        memoizedProps: {},
        child: null,
        sibling: null,
        return: null,
      };
      const provider = {
        type: { displayName: 'FormProvider' },
        memoizedProps: { value: formReturn },
        child: null,
        sibling: null,
        return: null,
      };
      const wrapper = {
        type: { displayName: 'View' },
        memoizedProps: {},
        child: null,
        sibling: null,
        return: null,
      };
      const anchor = {
        type: { displayName: 'Pressable' },
        memoizedProps: { testID: 'email-field' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, provider);
      linkFiber(provider, wrapper);
      linkFiber(wrapper, anchor);
      return root;
    },
    { action: 'setFieldValue', testID: 'email-field', name: 'email', value: 'a@b.com' },
  );

  assert.equal(result.success, true);
  assert.equal(result.action, 'setFieldValue');
  assert.equal(result.name, 'email');
  assert.equal(result.value, 'a@b.com');
  assert.equal(setValueCalls.length, 1);
  // JSON-roundtrip to coerce sandbox-side Objects to Node-side Objects,
  // so assert/strict's prototype check doesn't reject structurally-equal
  // values for not being reference-equal across the VM boundary.
  assert.deepEqual(JSON.parse(JSON.stringify(setValueCalls[0])), {
    name: 'email',
    value: 'a@b.com',
    options: { shouldValidate: true, shouldDirty: true },
  });
});

test('setFieldValue: shouldValidate=false and shouldDirty=false pass through verbatim', () => {
  const setValueCalls = [];
  const formReturn = {
    setValue(name, value, options) {
      setValueCalls.push({ name, value, options });
    },
    getValues() {
      return {};
    },
    control: { _formValues: {} },
  };
  const result = runInteract(
    () => {
      const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
      const provider = {
        type: { displayName: 'FormProvider' },
        memoizedProps: { value: formReturn },
        child: null,
        sibling: null,
        return: null,
      };
      const anchor = {
        type: {},
        memoizedProps: { testID: 'f' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, provider);
      linkFiber(provider, anchor);
      return root;
    },
    {
      action: 'setFieldValue',
      testID: 'f',
      name: 'n',
      value: 'v',
      shouldValidate: false,
      shouldDirty: false,
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(setValueCalls[0].options)), {
    shouldValidate: false,
    shouldDirty: false,
  });
});

test('setFieldValue: numeric and boolean values pass through unchanged (no coercion)', () => {
  const calls = [];
  const formReturn = {
    setValue(n, v, _o) {
      calls.push({ v, type: typeof v });
    },
    getValues() {
      return {};
    },
    control: {},
  };
  function buildTree() {
    const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
    const provider = {
      type: { displayName: 'FormProvider' },
      memoizedProps: { value: formReturn },
      child: null,
      sibling: null,
      return: null,
    };
    const anchor = {
      type: {},
      memoizedProps: { testID: 'f' },
      child: null,
      sibling: null,
      return: null,
    };
    linkFiber(root, provider);
    linkFiber(provider, anchor);
    return root;
  }
  runInteract(buildTree, { action: 'setFieldValue', testID: 'f', name: 'age', value: 42 });
  runInteract(buildTree, { action: 'setFieldValue', testID: 'f', name: 'opt-in', value: true });
  assert.deepEqual(calls, [
    { v: 42, type: 'number' },
    { v: true, type: 'boolean' },
  ]);
});

test('setFieldValue: nearest FormProvider wins (nested forms behave like React context)', () => {
  const outerCalls = [];
  const innerCalls = [];
  const outer = {
    setValue(n, v) {
      outerCalls.push({ n, v });
    },
    getValues() {
      return {};
    },
    control: {},
  };
  const inner = {
    setValue(n, v) {
      innerCalls.push({ n, v });
    },
    getValues() {
      return {};
    },
    control: {},
  };
  const result = runInteract(
    () => {
      const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
      const outerProvider = {
        type: { displayName: 'FormProvider' },
        memoizedProps: { value: outer },
        child: null,
        sibling: null,
        return: null,
      };
      const innerProvider = {
        type: { displayName: 'FormProvider' },
        memoizedProps: { value: inner },
        child: null,
        sibling: null,
        return: null,
      };
      const anchor = {
        type: {},
        memoizedProps: { testID: 'inner-field' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, outerProvider);
      linkFiber(outerProvider, innerProvider);
      linkFiber(innerProvider, anchor);
      return root;
    },
    { action: 'setFieldValue', testID: 'inner-field', name: 'x', value: '1' },
  );

  assert.equal(result.success, true);
  assert.equal(innerCalls.length, 1, 'closest provider should win');
  assert.equal(outerCalls.length, 0, 'outer provider should not see the call');
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────────────────────────────────────

test('setFieldValue: missing opts.name returns clear error (does NOT walk the tree)', () => {
  const result = runInteract(
    () => {
      const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
      const anchor = {
        type: {},
        memoizedProps: { testID: 'f' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, anchor);
      return root;
    },
    { action: 'setFieldValue', testID: 'f', value: 'x' },
  );

  assert.match(result.error, /requires opts\.name/);
  assert.equal(result.testID, 'f');
});

test('setFieldValue: no FormProvider ancestor returns actionable hint', () => {
  // A tree with no Provider whose value duck-types as UseFormReturn.
  const result = runInteract(
    () => {
      const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
      // A Provider whose value is NOT a form return — must be ignored.
      const wrongProvider = {
        type: { displayName: 'ThemeProvider' },
        memoizedProps: { value: { theme: 'dark' } },
        child: null,
        sibling: null,
        return: null,
      };
      const anchor = {
        type: {},
        memoizedProps: { testID: 'f' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, wrongProvider);
      linkFiber(wrongProvider, anchor);
      return root;
    },
    { action: 'setFieldValue', testID: 'f', name: 'email', value: 'x' },
  );

  assert.match(result.error, /no FormProvider ancestor/);
  assert.match(result.hint, /not wrapped in <FormProvider/);
});

test('setFieldValue: setValue throwing is caught + surfaced with the thrown message', () => {
  const formReturn = {
    setValue() {
      throw new Error('field does not exist on the form');
    },
    getValues() {
      return {};
    },
    control: {},
  };
  const result = runInteract(
    () => {
      const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
      const provider = {
        type: { displayName: 'FormProvider' },
        memoizedProps: { value: formReturn },
        child: null,
        sibling: null,
        return: null,
      };
      const anchor = {
        type: {},
        memoizedProps: { testID: 'f' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, provider);
      linkFiber(provider, anchor);
      return root;
    },
    { action: 'setFieldValue', testID: 'f', name: 'bogus', value: 'x' },
  );

  assert.match(result.error, /setValue threw: field does not exist/);
  assert.equal(result.name, 'bogus');
});

test('setFieldValue: duck-type rejects a Provider whose value lacks setValue (not a form return)', () => {
  // Critical: many context Providers have `value` objects with `getValues`
  // or `control` look-alike fields. The duck-type MUST require ALL three
  // (setValue + getValues + control) before assuming it's a form return.
  const partialForm = {
    // setValue missing
    getValues() {
      return {};
    },
    control: { _formValues: {} },
  };
  const result = runInteract(
    () => {
      const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
      const provider = {
        type: { displayName: 'PartialFormProvider' },
        memoizedProps: { value: partialForm },
        child: null,
        sibling: null,
        return: null,
      };
      const anchor = {
        type: {},
        memoizedProps: { testID: 'f' },
        child: null,
        sibling: null,
        return: null,
      };
      linkFiber(root, provider);
      linkFiber(provider, anchor);
      return root;
    },
    { action: 'setFieldValue', testID: 'f', name: 'x', value: 'y' },
  );

  assert.match(result.error, /no FormProvider ancestor/);
});
