import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidActionId } from '../../dist/domain/path-safety.js';

// Audit L6: the comment documented "hyphen/underscore/dot/alphanumeric" but the
// regex excluded dots, so versioned ids (v2.0-login) were rejected with an
// opaque error. Dots are now accepted; `..` stays rejected for traversal safety.

test('L6: dotted (versioned) action ids are accepted', () => {
  assert.equal(isValidActionId('v2.0-login'), true);
  assert.equal(isValidActionId('auth.flow'), true);
  assert.equal(isValidActionId('checkout.v1.2'), true);
});

test('L6: existing non-dotted ids still accepted', () => {
  assert.equal(isValidActionId('login-flow'), true);
  assert.equal(isValidActionId('add_cart_item'), true);
  assert.equal(isValidActionId('test123'), true);
});

test('L6: `..` and traversal payloads stay rejected', () => {
  assert.equal(isValidActionId('..'), false);
  assert.equal(isValidActionId('a..b'), false, 'a `..` segment is rejected even without a slash');
  assert.equal(isValidActionId('../etc/passwd'), false);
  assert.equal(isValidActionId('foo/../bar'), false);
  assert.equal(isValidActionId('foo/bar'), false);
  assert.equal(isValidActionId('.hidden'), false, 'must still start with an alphanumeric');
});
