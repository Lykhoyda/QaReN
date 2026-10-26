import { test } from 'node:test';
import assert from 'node:assert/strict';

import { metroOrigin } from '../../dist/ws-origin.js';

/**
 * B177 + B178: the Metro inspector proxy has two origin gates and Node's `ws`
 * sends no Origin by default. (1) @react-native/dev-middleware 401s non-loopback
 * origins; (2) Expo SDK 56 createDebugMiddleware force-closes (1006) any origin
 * whose host != serverBaseUrl host (127.0.0.1). metroOrigin must emit 127.0.0.1
 * (not localhost) so it clears BOTH gates.
 */

test('metroOrigin: emits a 127.0.0.1 loopback origin carrying the ws URL port', () => {
  assert.equal(
    metroOrigin('ws://localhost:8081/inspector/debug?device=abc&page=2'),
    'http://127.0.0.1:8081',
  );
});

test('metroOrigin: forces the 127.0.0.1 host even when the ws URL is a LAN IP', () => {
  assert.equal(
    metroOrigin('ws://192.168.18.51:8082/inspector/debug?device=abc&page=1'),
    'http://127.0.0.1:8082',
  );
});

test('metroOrigin: falls back to :8081 when the ws URL has no explicit port', () => {
  assert.equal(metroOrigin('ws://localhost/inspector/debug'), 'http://127.0.0.1:8081');
});

test('metroOrigin: falls back to a safe default on an unparseable input', () => {
  assert.equal(metroOrigin('not a url'), 'http://127.0.0.1:8081');
});
