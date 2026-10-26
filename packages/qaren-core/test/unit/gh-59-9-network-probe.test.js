import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeNetworkDomain } from '../../dist/cdp/setup.js';

// GH #59 #9: D626 network-mode probe was a single 500ms check — false-negatives
// happened after platform switches when the fresh Hermes context needed longer
// to flush the probe fetch. Bug surfaced as cdp_network_log returning
// mode:'hook' with zero entries despite traffic. Fix: probe twice (500ms then
// 1500ms) before declaring RN<0.83 fallback.

function createNetworkManager(deviceKey, schedule) {
  // Schedule: array of { onProbe: (attempt) => grew?: boolean }
  // simulates the buffer growing in response to the Nth probe.
  let probeCount = 0;
  let size = 0;
  return {
    size: () => size,
    // The handler injects an event into the buffer in lock-step with the
    // attempt counter so the wait completes deterministically.
    advance: () => {
      probeCount++;
      const decision = schedule[probeCount - 1];
      if (decision?.grew) size += 1;
    },
    getProbeCount: () => probeCount,
    getDeviceKey: () => deviceKey,
  };
}

test('probeNetworkDomain: returns cdp when first probe sees a buffer event', async () => {
  const mgr = createNetworkManager('test-key', [{ grew: true }]);
  let evalCount = 0;
  const evaluate = async () => {
    evalCount++;
    mgr.advance();
    return { value: undefined };
  };

  const mode = await probeNetworkDomain({
    evaluate,
    port: 8081,
    networkManager: { size: mgr.size },
    getDeviceKey: mgr.getDeviceKey,
    waits: [1, 1],
  });

  assert.equal(mode, 'cdp');
  assert.equal(evalCount, 1, 'should not retry when first probe succeeds');
});

test('probeNetworkDomain: retries and returns cdp when only second probe sees event', async () => {
  // First probe: no event. Second probe: event fires. This is the real GH #59 #9
  // failure mode — fresh context needed extra time after platform switch.
  const mgr = createNetworkManager('test-key', [{ grew: false }, { grew: true }]);
  let evalCount = 0;
  const evaluate = async () => {
    evalCount++;
    mgr.advance();
    return { value: undefined };
  };

  const mode = await probeNetworkDomain({
    evaluate,
    port: 8081,
    networkManager: { size: mgr.size },
    getDeviceKey: mgr.getDeviceKey,
    waits: [1, 1],
  });

  assert.equal(mode, 'cdp', 'second probe success should keep CDP mode');
  assert.equal(evalCount, 2, 'should retry exactly once');
});

test('probeNetworkDomain: returns none after all probes fail', async () => {
  const mgr = createNetworkManager('test-key', [{ grew: false }, { grew: false }]);
  let evalCount = 0;
  const evaluate = async () => {
    evalCount++;
    mgr.advance();
    return { value: undefined };
  };

  const mode = await probeNetworkDomain({
    evaluate,
    port: 8081,
    networkManager: { size: mgr.size },
    getDeviceKey: mgr.getDeviceKey,
    waits: [1, 1],
  });

  assert.equal(mode, 'none', 'genuine RN<0.83: both probes fail → fallback');
  assert.equal(evalCount, 2, 'all attempts should be tried before giving up');
});

test('probeNetworkDomain: respects custom waits length (single attempt)', async () => {
  const mgr = createNetworkManager('test-key', [{ grew: false }]);
  let evalCount = 0;
  const evaluate = async () => {
    evalCount++;
    mgr.advance();
    return { value: undefined };
  };

  const mode = await probeNetworkDomain({
    evaluate,
    port: 8081,
    networkManager: { size: mgr.size },
    getDeviceKey: mgr.getDeviceKey,
    waits: [1],
  });

  assert.equal(mode, 'none');
  assert.equal(evalCount, 1, 'waits.length controls attempt count');
});

test('probeNetworkDomain: uses provided port in fetch URL', async () => {
  const captured = [];
  const evaluate = async (expr) => {
    captured.push(expr);
    return { value: undefined };
  };

  await probeNetworkDomain({
    evaluate,
    port: 19000,
    networkManager: { size: () => 0 },
    getDeviceKey: () => 'k',
    waits: [1],
  });

  assert.equal(captured.length, 1);
  assert.match(captured[0], /http:\/\/localhost:19000\/status/);
});

test('probeNetworkDomain: defaults waits to [500, 1500] when omitted', async () => {
  // Smoke test that omitting `waits` doesn't crash. We don't assert exact
  // timings — just that the call completes without error and returns a valid mode.
  let evalCount = 0;
  const evaluate = async () => {
    evalCount++;
    return { value: undefined };
  };
  const start = Date.now();
  const mode = await probeNetworkDomain({
    evaluate,
    port: 8081,
    networkManager: { size: () => 0 },
    getDeviceKey: () => 'k',
  });
  const elapsed = Date.now() - start;
  assert.equal(mode, 'none', 'no events → none');
  assert.equal(evalCount, 2, 'default schedule has 2 attempts');
  assert.ok(elapsed >= 1900, `should wait ~2s in default mode, got ${elapsed}ms`);
});
