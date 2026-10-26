import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSession, okResult } from '../../dist/utils.js';
import { parseEnvelope } from '../helpers/result-helpers.js';

// withSession depends on hasActiveSession() from agent-device-wrapper.
// Since we can't easily mock ESM imports, we test the behavior by importing
// the session management functions and controlling state directly.
import { setActiveSession, clearActiveSession } from '../../dist/agent-device-wrapper.js';

// ── withSession guard ─────────────────────────────────────────────────

test('withSession returns failResult when no active session', async () => {
  clearActiveSession();
  const handler = withSession(async () => okResult({ done: true }));
  const result = await handler({});
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error, /No device session open/);
});

test('withSession calls handler when session is active', async () => {
  setActiveSession({
    name: 'test-session',
    platform: 'ios',
    openedAt: new Date().toISOString(),
  });
  try {
    const handler = withSession(async () => okResult({ success: true }));
    const result = await handler({});
    const env = parseEnvelope(result);
    assert.equal(env.ok, true);
    assert.equal(env.data.success, true);
  } finally {
    clearActiveSession();
  }
});

test('withSession passes args through to handler', async () => {
  setActiveSession({
    name: 'test-session',
    platform: 'android',
    openedAt: new Date().toISOString(),
  });
  try {
    let receivedArgs;
    const handler = withSession(async (args) => {
      receivedArgs = args;
      return okResult({ ok: true });
    });
    await handler({ text: 'hello', ref: '@1' });
    assert.deepEqual(receivedArgs, { text: 'hello', ref: '@1' });
  } finally {
    clearActiveSession();
  }
});

test('withSession propagates handler errors', async () => {
  setActiveSession({
    name: 'test-session',
    platform: 'ios',
    openedAt: new Date().toISOString(),
  });
  try {
    const handler = withSession(async () => {
      throw new Error('handler exploded');
    });
    await assert.rejects(() => handler({}), /handler exploded/);
  } finally {
    clearActiveSession();
  }
});
