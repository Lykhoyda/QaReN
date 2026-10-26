import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';

test('ambient cancellation refuses initial port binding and occupied-port retries', async (t) => {
  const controller = new AbortController();
  const servers: Array<EventEmitter & { listen: () => void }> = [];
  t.mock.method(net, 'createServer', () => {
    const server = Object.assign(new EventEmitter(), { listen: () => {} });
    servers.push(server);
    return server;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { findFreePort, isPortFree } = await import('../../../dist/runners/free-port.js');
  const { withCancellation, RunCancelledError } =
    await import('../../../dist/domain/cancellation.js');
  const pending = withCancellation(controller.signal, () => findFreePort(22089));
  const reason = new RunCancelledError();
  const rejected = assert.rejects(pending, (error) => error === reason);
  assert.equal(servers.length, 1);
  controller.abort(reason);
  servers[0].emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
  await rejected;
  await setImmediate();
  assert.equal(servers.length, 1);
  for (const allocate of [() => findFreePort(0), () => isPortFree(22089)]) {
    await assert.rejects(
      withCancellation(controller.signal, allocate),
      (error) => error === reason,
    );
  }
  assert.equal(servers.length, 1);
});
