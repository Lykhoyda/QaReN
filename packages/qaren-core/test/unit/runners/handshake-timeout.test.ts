import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type WebSocket from 'ws';
import {
  connectWebSocket,
  CDPHandshakeTimeoutError,
  type ConnectContext,
} from '../../../dist/cdp/connect.js';

function context(): ConnectContext {
  return {
    isDisposed: () => false,
    setWs: () => {},
    setState: () => {},
    handleMessage: () => {},
    getWs: () => null,
    rejectAllPending: () => {},
    setHelpersInjected: () => {},
  } as ConnectContext;
}

test('the handshake backstop preserves a typed timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let terminated = false;
  const socket = Object.assign(new EventEmitter(), {
    terminate: () => {
      terminated = true;
    },
  });
  const pending = connectWebSocket(
    context(),
    'ws://localhost/handshake',
    () => socket as WebSocket,
  );
  const refused = assert.rejects(pending, CDPHandshakeTimeoutError);
  t.mock.timers.tick(7000);
  await refused;
  assert.equal(terminated, true);
});

test('WebSocket library handshake timeout stays typed, while deterministic errors retain identity', async () => {
  for (const error of [
    new Error('Opening handshake has timed out'),
    new Error('Unexpected server response: 403'),
  ]) {
    const socket = Object.assign(new EventEmitter(), { terminate: () => {} });
    const pending = connectWebSocket(
      context(),
      'ws://localhost/handshake',
      () => socket as WebSocket,
    );
    const refused = assert.rejects(pending, (observed) =>
      error.message === 'Opening handshake has timed out'
        ? observed instanceof CDPHandshakeTimeoutError
        : observed === error,
    );
    await setImmediate();
    socket.emit('error', error);
    await refused;
  }
});
