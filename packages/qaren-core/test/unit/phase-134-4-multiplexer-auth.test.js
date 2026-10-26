// Phase 134.4 — CDP multiplexer trust boundary. Tests the
// capability-token check that gates WebSocket upgrades against the
// CDP multiplexer.
//
// The deepsec HIGH finding: the multiplexer accepted any localhost
// connection and forwarded `Runtime.evaluate` (and every other CDP
// command) straight to the Hermes runtime, bypassing Claude Code's
// tool-permission prompts entirely. Any process that could discover
// the ephemeral port could read AsyncStorage, navigate, mutate
// store state, etc.
//
// The fix: per-multiplexer high-entropy token in the WebSocket URL
// path. verifyConsumerPath enforces the token at upgrade time using
// timingSafeEqual to avoid leaking the token via timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/cdp/multiplexer.js';

test('verifyConsumerPath: accepts exact /<token> path', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  assert.equal(verifyConsumerPath('/AbCdEf123456_token_value', 'AbCdEf123456_token_value'), true);
});

test('verifyConsumerPath: rejects wrong token', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  assert.equal(verifyConsumerPath('/wrong-token', 'right-token'), false);
});

test('verifyConsumerPath: rejects missing token (root path)', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  assert.equal(verifyConsumerPath('/', 'right-token'), false);
  assert.equal(verifyConsumerPath('', 'right-token'), false);
});

test('verifyConsumerPath: rejects length-mismatch tokens (prevents prefix-extension attacks)', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  // The legitimate token is "right-token" (11 chars). An attacker
  // appending extra characters must NOT pass — same defense as the
  // /tmp/foo vs /tmp/foo-extra prefix bug from 134.3.
  assert.equal(verifyConsumerPath('/right-token-extra', 'right-token'), false);
  assert.equal(verifyConsumerPath('/right', 'right-token'), false);
});

test('verifyConsumerPath: rejects query-style appendage', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  // The token is path-based; a query-style appendage means the request
  // didn't structure the path correctly. Reject defensively.
  assert.equal(verifyConsumerPath('/right-token?extra=foo', 'right-token'), false);
});

test('verifyConsumerPath: rejects undefined / non-string inputs', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  assert.equal(verifyConsumerPath(undefined, 'right-token'), false);
  assert.equal(verifyConsumerPath(null, 'right-token'), false);
  assert.equal(verifyConsumerPath(42, 'right-token'), false);
});

test('verifyConsumerPath: rejects empty expected token (sanity check)', async () => {
  const { verifyConsumerPath } = await import(MOD_PATH);
  // If we somehow ended up with an empty expected token, fail closed
  // — never accept a wide-open multiplexer.
  assert.equal(verifyConsumerPath('/', ''), false);
  assert.equal(verifyConsumerPath('/anything', ''), false);
});

test('generateCapabilityToken: produces a unique high-entropy token each call', async () => {
  const { generateCapabilityToken } = await import(MOD_PATH);
  const a = generateCapabilityToken();
  const b = generateCapabilityToken();
  // High-entropy: base64url-encoded 32 bytes → 43 characters, no
  // padding. Two calls should never collide.
  assert.notEqual(a, b);
  assert.equal(typeof a, 'string');
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 32, `token too short: ${a.length} chars`);
});

// ── Multiplexer instance integration ────────────────────────────────

test('CDPMultiplexer.token: per-instance unique token exposed via getter', async () => {
  const { CDPMultiplexer } = await import(MOD_PATH);
  const mux1 = new CDPMultiplexer({ hermesUrl: 'ws://127.0.0.1:0', logTag: 'test1' });
  const mux2 = new CDPMultiplexer({ hermesUrl: 'ws://127.0.0.1:0', logTag: 'test2' });
  const t1 = mux1.token;
  const t2 = mux2.token;
  assert.equal(typeof t1, 'string');
  assert.ok(t1.length >= 32);
  assert.notEqual(t1, t2, 'tokens must be unique across instances');
});
