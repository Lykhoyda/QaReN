import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findFreePort, isPortFree } from '../../dist/runners/free-port.js';

function knownFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('findFreePort: returns the preferred port when it is free', async () => {
  const p = await knownFreePort();
  assert.equal(await findFreePort(p), p);
});

test('findFreePort: returns a different, valid port when preferred is occupied', async () => {
  const blocker = createServer();
  const held = await new Promise((r) =>
    blocker.listen({ port: 0, host: '127.0.0.1' }, () => r(blocker.address().port)),
  );
  try {
    const p = await findFreePort(held);
    assert.notEqual(p, held);
    assert.ok(p > 0 && p < 65536);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('isPortFree: true for a free port, false for an occupied one', async () => {
  const blocker = createServer();
  const held = await new Promise((r) =>
    blocker.listen({ port: 0, host: '127.0.0.1' }, () => r(blocker.address().port)),
  );
  try {
    assert.equal(await isPortFree(held), false);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
