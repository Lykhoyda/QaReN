import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveKeyboardGuard,
  withKeyboardGuard,
  surfaceKeyboardGuard,
} from '../../dist/runners/keyboard-guard.js';

test('defaults ON when unset', () => assert.equal(resolveKeyboardGuard({}), true));

test('OFF for 0/false (case/space-insensitive)', () => {
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: '0' }), false);
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: ' False ' }), false);
});

test('ON for any other value', () =>
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: 'yes' }), true));

test('withKeyboardGuard: tap/longPress only', () => {
  assert.equal(withKeyboardGuard({ command: 'tap' }, 'tap', {}).guardKeyboard, true);
  assert.equal(
    withKeyboardGuard({ command: 'longPress' }, 'longPress', { RN_KEYBOARD_GUARD: '0' })
      .guardKeyboard,
    false,
  );
  assert.equal('guardKeyboard' in withKeyboardGuard({ command: 'swipe' }, 'swipe', {}), false);
});

function toolResult(envelope) {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

test('surfaceKeyboardGuard: iOS envelope maps data.keyboardGuard to meta.keyboardGuard', () => {
  const result = toolResult({
    ok: true,
    data: {
      message: 'tapped',
      gestureStartUptimeMs: 100,
      gestureEndUptimeMs: 140,
      x: 10,
      y: 20,
      referenceWidth: 390,
      referenceHeight: 844,
      keyboardGuard: 'dismissed',
    },
  });
  const mapped = surfaceKeyboardGuard(result);
  const envelope = JSON.parse(mapped.content[0].text);
  assert.equal(envelope.meta.keyboardGuard, 'dismissed');
  assert.equal(envelope.data.keyboardGuard, 'dismissed');
});

test('surfaceKeyboardGuard: Android envelope maps data.keyboardGuard to meta.keyboardGuard', () => {
  const result = toolResult({
    ok: true,
    data: { x: 10, y: 20, tapped: true, keyboardGuard: 'dismissed' },
  });
  const mapped = surfaceKeyboardGuard(result);
  const envelope = JSON.parse(mapped.content[0].text);
  assert.equal(envelope.meta.keyboardGuard, 'dismissed');
});

test('surfaceKeyboardGuard: preserves existing meta fields', () => {
  const result = toolResult({
    ok: true,
    data: { keyboardGuard: 'not_occluded' },
    meta: { recovered: 'agent-device-runner-leak' },
  });
  const mapped = surfaceKeyboardGuard(result);
  const envelope = JSON.parse(mapped.content[0].text);
  assert.equal(envelope.meta.keyboardGuard, 'not_occluded');
  assert.equal(envelope.meta.recovered, 'agent-device-runner-leak');
});

test('surfaceKeyboardGuard: absent field leaves result unchanged (no meta.keyboardGuard key)', () => {
  const result = toolResult({ ok: true, data: { message: 'tapped' } });
  const mapped = surfaceKeyboardGuard(result);
  assert.equal(mapped, result);
  const envelope = JSON.parse(mapped.content[0].text);
  assert.equal('meta' in envelope, false);
});

test('surfaceKeyboardGuard: non-JSON content is returned unchanged without throwing', () => {
  const result = { content: [{ type: 'text', text: 'not json' }] };
  assert.doesNotThrow(() => surfaceKeyboardGuard(result));
  const mapped = surfaceKeyboardGuard(result);
  assert.equal(mapped, result);
});
