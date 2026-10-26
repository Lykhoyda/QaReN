import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGracefulShutdown } from '../../dist/lifecycle/graceful-shutdown.js';

// Build a minimal mock client — only disconnect() is called by shutdown.
function mockClient(disconnectImpl = async () => {}) {
  const calls = { disconnect: 0 };
  return {
    client: {
      disconnect: async () => {
        calls.disconnect += 1;
        return disconnectImpl();
      },
    },
    calls,
  };
}

function captureExit() {
  const exits = [];
  const exitFn = (code) => {
    exits.push(code);
    // Do NOT actually exit — return undefined cast to never for type compat
    return undefined;
  };
  return { exits, exitFn };
}

// ── B76 / D644: graceful shutdown factory ──────────────────────────────

test('gracefulShutdown: calls disconnect then stopFastRunner then exit with correct code (B76/D644)', async () => {
  const { client, calls } = mockClient();
  let stopFastRunnerCalls = 0;
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {
      stopFastRunnerCalls += 1;
    },
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(0);

  assert.equal(calls.disconnect, 1, 'disconnect called once');
  assert.equal(stopFastRunnerCalls, 1, 'stopFastRunner called once');
  assert.deepEqual(exits, [0], 'exit called with code 0');
});

test('gracefulShutdown: passes through non-zero exit code (B76/D644)', async () => {
  const { client } = mockClient();
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {},
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(1);
  assert.deepEqual(exits, [1], 'exit called with code 1 (SIGUSR1 crash-restart intent)');
});

test('gracefulShutdown: idempotent — second call is a no-op (B76/D644)', async () => {
  const { client, calls } = mockClient();
  let stopFastRunnerCalls = 0;
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {
      stopFastRunnerCalls += 1;
    },
    exitFn,
    timeoutMs: 1000,
  });

  await Promise.all([shutdown(0), shutdown(0), shutdown(0)]);

  assert.equal(calls.disconnect, 1, 'disconnect called exactly once despite 3 shutdowns');
  assert.equal(stopFastRunnerCalls, 1, 'stopFastRunner called exactly once');
  assert.equal(exits.length, 1, 'exit called exactly once');
});

test('gracefulShutdown: disconnect throw is non-fatal (B76/D644)', async () => {
  const { client } = mockClient(async () => {
    throw new Error('boom');
  });
  let stopFastRunnerCalls = 0;
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {
      stopFastRunnerCalls += 1;
    },
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(0);

  assert.equal(stopFastRunnerCalls, 1, 'stopFastRunner still called after disconnect throws');
  assert.deepEqual(exits, [0], 'exit still called');
});

test('gracefulShutdown: stopFastRunner throw is non-fatal (B76/D644)', async () => {
  const { client, calls } = mockClient();
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {
      throw new Error('fastrunner boom');
    },
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(0);

  assert.equal(calls.disconnect, 1, 'disconnect was called');
  assert.deepEqual(exits, [0], 'exit still called despite stopFastRunner throw');
});

// ── GH #182 zombie class (observe-mirror follow-up): stopMirrorFn wiring ──

test('gracefulShutdown: calls stopMirrorFn during cleanup (GH #182 mirror zombie)', async () => {
  const { client } = mockClient();
  let stopMirrorCalls = 0;
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {},
    stopMirrorFn: () => {
      stopMirrorCalls += 1;
    },
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(0);

  assert.equal(stopMirrorCalls, 1, 'stopMirrorFn called once during cleanup');
  assert.deepEqual(exits, [0], 'exit still called');
});

test('gracefulShutdown: omitted stopMirrorFn is a no-op (mirror config-disabled)', async () => {
  const { client, calls } = mockClient();
  const { exits, exitFn } = captureExit();

  // No stopMirrorFn passed — mirrors the config-disabled case where
  // `mirrorManager` is undefined and `stopMirrorFn: () => mirrorManager?.shutdown()`
  // is never wired at the call site either.
  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {},
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(0);

  assert.equal(calls.disconnect, 1, 'disconnect still called');
  assert.deepEqual(exits, [0], 'exit still called without stopMirrorFn');
});

test('gracefulShutdown: stopMirrorFn throw is non-fatal (GH #182 mirror zombie)', async () => {
  const { client, calls } = mockClient();
  let stopFastRunnerCalls = 0;
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {
      stopFastRunnerCalls += 1;
    },
    stopMirrorFn: () => {
      throw new Error('mirror boom');
    },
    exitFn,
    timeoutMs: 1000,
  });

  await shutdown(0);

  assert.equal(calls.disconnect, 1, 'disconnect was called');
  assert.equal(stopFastRunnerCalls, 1, 'stopFastRunner still called despite stopMirrorFn throw');
  assert.deepEqual(exits, [0], 'exit still called despite stopMirrorFn throw');
});

test('gracefulShutdown: timeout forces exit if cleanup hangs (B76/D644)', async () => {
  // disconnect() never resolves — simulates a stuck cleanup path. The shutdown's
  // setTimeout is NOT unref'd in production code, so it keeps the event loop alive
  // long enough to fire, settle Promise.race, and force exit. This test would have
  // caught the .unref() bug that slipped through the first CI run.
  const { client } = mockClient(() => new Promise(() => {}));
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {},
    exitFn,
    timeoutMs: 50,
  });

  const start = Date.now();
  await shutdown(0);
  const elapsed = Date.now() - start;

  assert.deepEqual(exits, [0], 'exit forced via timeout');
  assert.ok(elapsed >= 40 && elapsed < 500, `timeout respected: ${elapsed}ms`);
});

test('gracefulShutdown: concurrent calls during slow disconnect share one cleanup (B76/D644 race)', async () => {
  // Simulates the cdp_restart-mid-flight + SIGTERM race the idempotency guard is for.
  let disconnectResolve;
  const { client, calls } = mockClient(
    () =>
      new Promise((r) => {
        disconnectResolve = r;
      }),
  );
  let stopFastRunnerCalls = 0;
  const { exits, exitFn } = captureExit();

  const shutdown = buildGracefulShutdown({
    getClient: () => client,
    stopFastRunnerFn: () => {
      stopFastRunnerCalls += 1;
    },
    exitFn,
    timeoutMs: 5000,
  });

  // Fire 3 parallel shutdowns while disconnect() is pending
  const p1 = shutdown(0);
  const p2 = shutdown(0);
  const p3 = shutdown(1);

  // Give the microtask queue a tick to ensure the first shutdown has entered its body
  await new Promise((r) => setImmediate(r));
  assert.equal(
    calls.disconnect,
    1,
    'disconnect called exactly once despite 3 concurrent shutdowns',
  );

  // Resolve the slow disconnect → cleanup completes → exit fires
  disconnectResolve();
  await Promise.all([p1, p2, p3]);

  assert.equal(stopFastRunnerCalls, 1, 'stopFastRunner called exactly once');
  assert.equal(exits.length, 1, 'exit called exactly once');
  assert.deepEqual(exits, [0], 'first shutdown wins — its exit code is used');
});
