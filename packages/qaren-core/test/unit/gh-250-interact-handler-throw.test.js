// GH#250/B194: when the app's own handler (onPress/onChangeText/...) THROWS, the
// interact dispatch catch returned { success: true, action_executed: true } and the
// TS layer mapped it to warnResult (envelope ok: true) — a real app-side exception
// read as a successful interaction, so agents proceeded against a screen that may
// be in an error state. Truthful contract: success: false at the helper layer,
// failResult (isError) at the tool layer, with action_executed kept to distinguish
// "dispatched but handler threw" from "couldn't dispatch".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectFail } from '../helpers/result-helpers.js';
import { createInteractHandler } from '../../dist/handlers/interact.js';

function createSandbox(opts = {}) {
  const sandbox = {
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
      getFiberRoots: (id) => (id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set()),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

function buildFiber(spec, parent = null) {
  const fiber = {
    type: spec.name ? { displayName: spec.name } : null,
    memoizedProps: spec.props || {},
    return: parent,
    child: null,
    sibling: null,
    stateNode: spec.stateNode || null,
  };
  if (spec.children && spec.children.length > 0) {
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

test('#250 helper: a throwing onPress reports success:false with action_executed + handler_error', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          testID: 'crash-btn',
          onPress: () => {
            throw new Error('Cannot update unmounted component');
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.interact({ action: 'press', testID: 'crash-btn' }));
  assert.equal(result.success, false);
  assert.equal(result.action_executed, true);
  assert.match(result.handler_error, /unmounted component/);
});

test('#250 helper: a non-throwing onPress still reports success:true (regression guard)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { testID: 'ok-btn', onPress: () => {} } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.interact({ action: 'press', testID: 'ok-btn' }));
  assert.equal(result.success, true);
});

test('#250 tool layer: action_executed + handler_error maps to failResult, not warnResult', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({
        success: false,
        action_executed: true,
        handler_error: 'onPress threw an error',
        testID: 'crash-btn',
      }),
    }),
  });
  const handler = createInteractHandler(() => client);
  const result = await handler({ action: 'press', testID: 'crash-btn', animated: false });
  assert.equal(result.isError, true);
  const error = expectFail(result);
  assert.match(error, /handler threw/);
  // the envelope must still carry the "it DID dispatch" distinction
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.meta?.actionExecuted, true);
});
