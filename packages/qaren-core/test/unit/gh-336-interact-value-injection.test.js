// GH #336 — cdp_interact value-injection must not corrupt Controller-wrapped
// inputs: setFieldValue keeps a string a string for string-typed fields, and
// press passes a value (not a synthetic event) to value-bearing controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

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

function linkFiber(parent, child) {
  parent.child = child;
  child.return = parent;
  return child;
}

// Form tree: root → FormProvider(value=formReturn) → anchor(testID 'f').
function buildFormTree(formReturn) {
  return function () {
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
  };
}

function recordingForm(getValuesImpl) {
  const calls = [];
  return {
    calls,
    form: {
      setValue(n, v) {
        calls.push({ v, type: typeof v });
      },
      getValues: getValuesImpl,
      control: {},
    },
  };
}

test('#336 setFieldValue: number into a string-typed field coerces to string', () => {
  const { calls, form } = recordingForm((name) => (name === 'phone' ? '' : undefined));
  const res = runInteract(buildFormTree(form), {
    action: 'setFieldValue',
    testID: 'f',
    name: 'phone',
    value: 15112345678,
  });
  assert.deepEqual(calls, [{ v: '15112345678', type: 'string' }]);
  assert.equal(res.coercedToString, true);
});

test('#336 setFieldValue: number into a non-string field stays a number (gh-126 preserved)', () => {
  const { calls, form } = recordingForm(() => undefined);
  const res = runInteract(buildFormTree(form), {
    action: 'setFieldValue',
    testID: 'f',
    name: 'age',
    value: 42,
  });
  assert.deepEqual(calls, [{ v: 42, type: 'number' }]);
  assert.ok(!res.coercedToString);
});

test('#336 setFieldValue: getValues throwing does not coerce (number passes through)', () => {
  const { calls, form } = recordingForm(() => {
    throw new Error('not ready');
  });
  runInteract(buildFormTree(form), {
    action: 'setFieldValue',
    testID: 'f',
    name: 'phone',
    value: 15112345678,
  });
  assert.deepEqual(calls, [{ v: 15112345678, type: 'number' }]);
});

test('#336 setFieldValue: a string value into a string field is unchanged', () => {
  const { calls, form } = recordingForm(() => '');
  runInteract(buildFormTree(form), {
    action: 'setFieldValue',
    testID: 'f',
    name: 'phone',
    value: 'abc',
  });
  assert.deepEqual(calls, [{ v: 'abc', type: 'string' }]);
});

// Press tree: root → control(testID, onPress?) — onPress records its arg into
// an outer-context array (same cross-VM capture gh-126 uses for setValue).
function buildPressTree(testID, withOnPress) {
  const calls = [];
  const build = function () {
    const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
    const props = { testID: testID };
    if (withOnPress)
      props.onPress = (arg) => {
        calls.push(arg);
      };
    const control = {
      type: { displayName: 'RadioOption' },
      memoizedProps: props,
      child: null,
      sibling: null,
      return: null,
    };
    linkFiber(root, control);
    return root;
  };
  return { build, calls };
}

test('#336 press: with value, onPress receives the value (not an event object)', () => {
  const { build, calls } = buildPressTree('opt-male', true);
  const res = runInteract(build, { action: 'press', testID: 'opt-male', value: 'male' });
  assert.deepEqual(calls, ['male']);
  assert.equal(res.success, true);
  assert.equal(res.value, 'male');
});

test('#336 press: without value, onPress receives a synthetic event (unchanged)', () => {
  const { build, calls } = buildPressTree('btn', true);
  const res = runInteract(build, { action: 'press', testID: 'btn' });
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0], 'object');
  assert.ok(calls[0] && 'nativeEvent' in calls[0]);
  assert.equal(res.success, true);
  assert.equal('value' in res, false);
});

test('#336 press: no onPress handler still returns the existing error', () => {
  const { build } = buildPressTree('btn', false);
  const res = runInteract(build, { action: 'press', testID: 'btn', value: 'x' });
  assert.ok(res.error && /onPress/i.test(res.error));
});
