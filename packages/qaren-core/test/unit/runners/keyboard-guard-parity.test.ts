// The walker's pre-tap keyboard clearance reads its tier from the shared dismissal chain.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissKeyboardWithParity, dismissalTier } from '../../../dist/runners/keyboard-guard.js';

const result = (envelope: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  ...(isError ? { isError: true } : {}),
});
const snapshot = (keyboardVisible: boolean) => async () =>
  result({ ok: true, data: { nodes: [], keyboardVisible } });

test('a native control that hid the keyboard is the native-control tier', async () => {
  let js = 0;
  const outcome = await dismissKeyboardWithParity({
    nativeDismiss: async () =>
      result({ ok: true, data: { wasVisible: true, dismissed: true, visible: false } }),
    dismissViaJs: async () => (js++, true),
    refreshSnapshot: snapshot(false),
  });
  assert.equal(dismissalTier(outcome), 'native-control');
  assert.equal(js, 0);
});

test('an iPhone keyboard without a hide control falls through to the JS tier', async () => {
  const outcome = await dismissKeyboardWithParity({
    nativeDismiss: async () =>
      result(
        { ok: false, code: 'KEYBOARD_DISMISS_FAILED', error: 'KEYBOARD_DISMISS_FAILED' },
        true,
      ),
    dismissViaJs: async () => true,
    refreshSnapshot: snapshot(false),
  });
  assert.equal(dismissalTier(outcome), 'js');
});

test('no tier proving the keyboard hidden, or no keyboard at all, is none', async () => {
  const failed = await dismissKeyboardWithParity({
    nativeDismiss: async () => result({ ok: false, code: 'KEYBOARD_DISMISS_FAILED' }, true),
    dismissViaJs: async () => true,
    refreshSnapshot: snapshot(true),
  });
  assert.equal(dismissalTier(failed), 'none');
  const absent = await dismissKeyboardWithParity({
    nativeDismiss: async () => result({ ok: true, data: { wasVisible: false, visible: false } }),
    refreshSnapshot: snapshot(false),
  });
  assert.equal(dismissalTier(absent), 'none');
  assert.equal(dismissalTier({ content: [{ type: 'text', text: 'not json' }] }), 'none');
});
