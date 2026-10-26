import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  surfaceKeyboardGuard,
  isKeyboardOccludedRefusal,
  healKeyboardOccludedTap,
} from '../../dist/runners/keyboard-guard.js';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function toolResult(envelope, isError = false) {
  const result = { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
  if (isError) result.isError = true;
  return result;
}

function occludedRefusal(withCode = true) {
  return toolResult(
    {
      ok: false,
      error:
        'KEYBOARD_OCCLUDED: tap (200, 780) is under the visible keyboard and this keyboard has no dismiss control, so auto-dismiss failed. keyboardGuard=dismiss_failed',
      ...(withCode ? { code: 'KEYBOARD_OCCLUDED' } : {}),
    },
    true,
  );
}

// ── surfaceKeyboardGuard hardening (#379 scope addition 1) ────────────

test('surfaceKeyboardGuard: literal "null" text is returned unchanged without throwing', () => {
  const result = { content: [{ type: 'text', text: 'null' }] };
  assert.doesNotThrow(() => surfaceKeyboardGuard(result));
  assert.equal(surfaceKeyboardGuard(result), result);
});

test('surfaceKeyboardGuard: non-object JSON scalar is returned unchanged', () => {
  const result = { content: [{ type: 'text', text: '42' }] };
  assert.equal(surfaceKeyboardGuard(result), result);
});

// ── keyboardGuardMs → meta.timings_ms.keyboardGuard (#379 scope addition 3) ──

test('surfaceKeyboardGuard: lifts data.keyboardGuardMs into meta.timings_ms.keyboardGuard', () => {
  const result = toolResult({
    ok: true,
    data: { message: 'tapped', keyboardGuard: 'not_occluded', keyboardGuardMs: 37 },
  });
  const envelope = JSON.parse(surfaceKeyboardGuard(result).content[0].text);
  assert.equal(envelope.meta.keyboardGuard, 'not_occluded');
  assert.equal(envelope.meta.timings_ms.keyboardGuard, 37);
});

test('surfaceKeyboardGuard: merges keyboardGuardMs into existing meta.timings_ms', () => {
  const result = toolResult({
    ok: true,
    data: { keyboardGuard: 'dismissed', keyboardGuardMs: 120 },
    meta: { timings_ms: { settle: 250 }, recovered: 'agent-device-runner-leak' },
  });
  const envelope = JSON.parse(surfaceKeyboardGuard(result).content[0].text);
  assert.equal(envelope.meta.timings_ms.settle, 250);
  assert.equal(envelope.meta.timings_ms.keyboardGuard, 120);
  assert.equal(envelope.meta.recovered, 'agent-device-runner-leak');
});

test('surfaceKeyboardGuard: keyboardGuardMs alone (no status string) is not lifted', () => {
  // The status string is the anchor; a bare ms value without it means the
  // envelope is not a guarded-verb result.
  const result = toolResult({ ok: true, data: { keyboardGuardMs: 5 } });
  assert.equal(surfaceKeyboardGuard(result), result);
});

// ── isKeyboardOccludedRefusal ─────────────────────────────────────────

test('isKeyboardOccludedRefusal: structured code envelope → true', () => {
  assert.equal(isKeyboardOccludedRefusal(occludedRefusal(true)), true);
});

test('isKeyboardOccludedRefusal: message-only envelope (old runner artifact) → true', () => {
  assert.equal(isKeyboardOccludedRefusal(occludedRefusal(false)), true);
});

test('isKeyboardOccludedRefusal: ok result → false', () => {
  assert.equal(
    isKeyboardOccludedRefusal(toolResult({ ok: true, data: { keyboardGuard: 'dismissed' } })),
    false,
  );
});

test('isKeyboardOccludedRefusal: unrelated error → false', () => {
  assert.equal(
    isKeyboardOccludedRefusal(toolResult({ ok: false, error: 'element not found' }, true)),
    false,
  );
});

test('isKeyboardOccludedRefusal: KEYBOARD_OCCLUDED mentioned mid-message does not match', () => {
  assert.equal(
    isKeyboardOccludedRefusal(
      toolResult({ ok: false, error: 'settle timed out after KEYBOARD_OCCLUDED retry' }, true),
    ),
    false,
  );
});

test('isKeyboardOccludedRefusal: non-JSON error content → false', () => {
  assert.equal(
    isKeyboardOccludedRefusal({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    false,
  );
});

// ── healKeyboardOccludedTap ───────────────────────────────────────────

function healDeps(overrides = {}) {
  const calls = { dismiss: 0, snapshot: 0, retry: 0 };
  const deps = {
    dismissViaJs: async () => {
      calls.dismiss++;
      return true;
    },
    refreshSnapshot: async () => {
      calls.snapshot++;
      return toolResult({ ok: true, data: { keyboardVisible: false } });
    },
    retryTap: async () => {
      calls.retry++;
      return toolResult({ ok: true, data: { message: 'tapped', keyboardGuard: 'no_keyboard' } });
    },
    ...overrides,
  };
  return { deps, calls };
}

test('heal: non-refusal result passes through untouched, no dismiss attempted', async () => {
  const { deps, calls } = healDeps();
  const ok = toolResult({ ok: true, data: { message: 'tapped' } });
  assert.equal(await healKeyboardOccludedTap(ok, deps), ok);
  assert.equal(calls.dismiss, 0);
  assert.equal(calls.retry, 0);
});

test('heal: null deps (no CDP) returns the refusal unchanged', async () => {
  const refusal = occludedRefusal();
  assert.equal(await healKeyboardOccludedTap(refusal, null), refusal);
});

test('heal: JS dismissal reports not-dismissed → original refusal, no retry', async () => {
  const { deps, calls } = healDeps({ dismissViaJs: async () => false });
  const refusal = occludedRefusal();
  assert.equal(await healKeyboardOccludedTap(refusal, deps), refusal);
  assert.equal(calls.retry, 0);
  assert.equal(calls.snapshot, 0);
});

test('heal: JS dismissal throws → original refusal, no retry', async () => {
  const { deps, calls } = healDeps({
    dismissViaJs: async () => {
      throw new Error('CDP evaluate failed');
    },
  });
  const refusal = occludedRefusal();
  assert.equal(await healKeyboardOccludedTap(refusal, deps), refusal);
  assert.equal(calls.retry, 0);
});

test('heal: happy path — dismiss, re-snapshot, retry once, tagged meta', async () => {
  const { deps, calls } = healDeps();
  const healed = await healKeyboardOccludedTap(occludedRefusal(), deps);
  assert.equal(calls.dismiss, 1);
  assert.equal(calls.snapshot, 1);
  assert.equal(calls.retry, 1);
  const envelope = JSON.parse(healed.content[0].text);
  assert.equal(envelope.meta.keyboardGuard, 'auto_dismissed');
  assert.equal(envelope.meta.keyboardAutoHeal.dismissed, true);
  assert.equal(typeof envelope.meta.keyboardAutoHeal.healMs, 'number');
});

test('heal: message-only refusal (old runner artifact) also heals', async () => {
  const { deps, calls } = healDeps();
  await healKeyboardOccludedTap(occludedRefusal(false), deps);
  assert.equal(calls.retry, 1);
});

test('heal: snapshot refresh failure cannot prove hidden state, so no tap occurs', async () => {
  const refusal = occludedRefusal();
  const { deps, calls } = healDeps({
    refreshSnapshot: async () => {
      throw new Error('snapshot infra down');
    },
  });
  const healed = await healKeyboardOccludedTap(refusal, deps);
  assert.equal(calls.retry, 0);
  assert.equal(healed, refusal);
});

test('heal: retry that refuses again is returned as-is (bounded, keyboardGuard not overwritten)', async () => {
  let retries = 0;
  const { deps } = healDeps({
    retryTap: async () => {
      retries++;
      return occludedRefusal();
    },
  });
  const healed = await healKeyboardOccludedTap(occludedRefusal(), deps);
  assert.equal(retries, 1);
  assert.equal(healed.isError, true);
  const envelope = JSON.parse(healed.content[0].text);
  assert.equal(envelope.meta.keyboardAutoHeal.dismissed, true);
  assert.notEqual(envelope.meta.keyboardGuard, 'auto_dismissed');
});

test('heal: retried result with unparseable content is returned without throwing', async () => {
  const raw = { content: [{ type: 'text', text: 'not json' }] };
  const { deps } = healDeps({ retryTap: async () => raw });
  const healed = await healKeyboardOccludedTap(occludedRefusal(), deps);
  assert.equal(healed, raw);
});

// ── injected helper: __QAREN.dismissKeyboard() ─────────────────────

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

function inputFiber({ focused }) {
  return {
    type: 'AndroidTextInput',
    stateNode: {
      _focused: focused,
      _blurred: 0,
      isFocused() {
        return this._focused;
      },
      blur() {
        this._blurred++;
        this._focused = false;
      },
    },
    child: null,
    sibling: null,
  };
}

test('dismissKeyboard: blurs the focused TextInput host instance (require-less fallback)', () => {
  const focusedInput = inputFiber({ focused: true });
  const root = { type: 'View', stateNode: null, child: focusedInput, sibling: null };
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.dismissKeyboard());
  assert.equal(result.dismissed, true);
  assert.equal(result.method, 'blur-focused-input');
  assert.equal(focusedInput.stateNode._blurred, 1);
});

test('dismissKeyboard: unfocused inputs are not blurred → dismissed:false', () => {
  const idleInput = inputFiber({ focused: false });
  const root = { type: 'View', stateNode: null, child: idleInput, sibling: null };
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.dismissKeyboard());
  assert.equal(result.dismissed, false);
  assert.equal(idleInput.stateNode._blurred, 0);
});

test('dismissKeyboard: live Bridgeless Fabric wrapper reaches canonical.publicInstance', () => {
  const publicInstance = {
    _focused: true,
    _blurred: 0,
    isFocused() {
      return this._focused;
    },
    blur() {
      this._blurred++;
      this._focused = false;
    },
  };
  const fabricInput = {
    type: 'RCTMultilineTextInputView',
    stateNode: { node: {}, canonical: { publicInstance } },
    child: null,
    sibling: null,
  };
  const root = { type: 'View', stateNode: null, child: fabricInput, sibling: null };
  const sandbox = createSandbox({ fiberRoot: root });

  const result = JSON.parse(sandbox.__QAREN.dismissKeyboard());

  assert.deepEqual(result, { dismissed: true, method: 'blur-focused-input' });
  assert.equal(publicInstance._blurred, 1);
});

test('dismissKeyboard: text host without a focus oracle uses restricted idempotent blur', () => {
  const fabricInput = {
    type: 'RCTMultilineTextInputView',
    stateNode: {
      _blurred: 0,
      blur() {
        this._blurred++;
      },
    },
    child: null,
    sibling: null,
  };
  const inertView = {
    type: 'RCTView',
    stateNode: {
      _blurred: 0,
      blur() {
        this._blurred++;
      },
    },
    child: null,
    sibling: fabricInput,
  };
  const root = { type: 'View', stateNode: null, child: inertView, sibling: null };
  const sandbox = createSandbox({ fiberRoot: root });

  const result = JSON.parse(sandbox.__QAREN.dismissKeyboard());

  assert.deepEqual(result, { dismissed: true, method: 'blur-text-input-hosts' });
  assert.equal(fabricInput.stateNode._blurred, 1);
  assert.equal(inertView.stateNode._blurred, 0, 'no-oracle blur is text-host restricted');
});

test('dismissKeyboard: prefers the RN Keyboard module when require resolves it', () => {
  let dismissCalls = 0;
  const sandbox = createSandbox({
    fiberRoot: { type: 'View', stateNode: null, child: null, sibling: null },
    globals: {
      require: (name) => {
        if (name === 'react-native') {
          return {
            Keyboard: {
              dismiss() {
                dismissCalls++;
              },
            },
          };
        }
        throw new Error('module not found: ' + name);
      },
    },
  });
  const result = JSON.parse(sandbox.__QAREN.dismissKeyboard());
  assert.equal(result.dismissed, true);
  assert.equal(result.method, 'keyboard-module');
  assert.equal(dismissCalls, 1);
});

test('dismissKeyboard: never throws when no hook/roots exist', () => {
  const sandbox = createSandbox({});
  assert.doesNotThrow(() => sandbox.__QAREN.dismissKeyboard());
  const result = JSON.parse(sandbox.__QAREN.dismissKeyboard());
  assert.equal(result.dismissed, false);
});
