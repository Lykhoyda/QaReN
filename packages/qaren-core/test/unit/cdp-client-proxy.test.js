import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CDPClient } from '../../dist/cdp-client.js';
import { makeMockHermes } from '../helpers/mock-hermes.js';

// M1b (Phase 100+): CDPClient proxy lifecycle tests.
//
// The guard-path tests (throws, idempotency, disconnect cleanup) use planted
// state and do not spin up real sockets. The softReconnect rollback and
// concurrency tests use a real mock Hermes so the multiplexer actually starts
// against a live WS endpoint, and stub only `softReconnect` to control the
// success/failure of the post-allocation step.

test('CDPClient.isProxyActive defaults to false before startProxy is called', () => {
  const client = new CDPClient();
  assert.equal(client.isProxyActive, false);
  assert.equal(client.proxyUrl, null);
  assert.equal(client.proxyMultiplexer, null);
});

test('CDPClient.startProxy throws when no target is connected', async () => {
  const client = new CDPClient();
  await assert.rejects(() => client.startProxy(), /startProxy requires an active CDP connection/);
  // No state drift after failed guard
  assert.equal(client.isProxyActive, false);
  assert.equal(client.proxyUrl, null);
});

test('CDPClient.stopProxy is a no-op when no proxy is active', async () => {
  const client = new CDPClient();
  // Should resolve cleanly without reaching softReconnect (guarded by _proxyUrl null)
  await client.stopProxy();
  assert.equal(client.isProxyActive, false);
});

test('CDPClient.startProxy is idempotent — second call returns existing URL without double-starting', async () => {
  const client = new CDPClient();

  // Plant a fake already-active state. Skips the multiplexer-start path entirely,
  // exercising the idempotent early-return.
  // Private-field access is intentional in tests — JS sees all fields as public.
  client._proxyUrl = 'ws://127.0.0.1:45678';
  client._multiplexer = { port: 45678, stop: async () => {}, isRunning: true, consumerCount: 0 };

  const returned = await client.startProxy();
  assert.equal(
    returned,
    'ws://127.0.0.1:45678',
    'returns existing URL, does not allocate new port',
  );
  assert.equal(client.proxyUrl, 'ws://127.0.0.1:45678', 'state unchanged');
});

test('CDPClient.disconnect tears down the multiplexer and clears proxy state (graceful shutdown)', async () => {
  const client = new CDPClient();

  let stopCalled = false;
  // Plant a fake active multiplexer. disconnect() must invoke stop() on it AND
  // clear _proxyUrl/_multiplexer — this is the SIGTERM → disconnect path.
  client._proxyUrl = 'ws://127.0.0.1:45999';
  client._multiplexer = {
    port: 45999,
    isRunning: true,
    consumerCount: 0,
    stop: async () => {
      stopCalled = true;
    },
  };

  await client.disconnect();

  assert.equal(stopCalled, true, 'multiplexer.stop was called during disconnect');
  assert.equal(client.isProxyActive, false, 'proxy state cleared');
  assert.equal(client.proxyUrl, null);
  assert.equal(client.proxyMultiplexer, null);
});

test('CDPClient.disconnect is idempotent — safe to call twice (graceful shutdown race)', async () => {
  const client = new CDPClient();

  let stopCalls = 0;
  client._proxyUrl = 'ws://127.0.0.1:45000';
  client._multiplexer = {
    port: 45000,
    isRunning: true,
    consumerCount: 0,
    stop: async () => {
      stopCalls++;
    },
  };

  await client.disconnect();
  await client.disconnect(); // Second call — must not re-stop

  assert.equal(stopCalls, 1, 'multiplexer.stop called exactly once across two disconnects');
});

test('CDPClient.disconnect tolerates multiplexer.stop() rejecting (best-effort cleanup)', async () => {
  const client = new CDPClient();

  client._proxyUrl = 'ws://127.0.0.1:45111';
  client._multiplexer = {
    port: 45111,
    isRunning: true,
    consumerCount: 0,
    stop: async () => {
      throw new Error('multiplexer cleanup failed');
    },
  };

  // disconnect() must still complete — proxy cleanup is best-effort, not a hard requirement.
  await client.disconnect();

  assert.equal(client.isProxyActive, false, 'proxy state cleared despite stop() rejecting');
});

// D661 regression rationale: https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/DECISIONS.md?plain=1#L3040

function plantConnectedTarget(client, hermesUrl) {
  client._connectedTarget = {
    id: 'page1',
    title: 'Mock',
    vm: 'Hermes',
    webSocketDebuggerUrl: hermesUrl,
    platform: 'ios',
  };
}

test('CDPClient.startProxy rolls back multiplexer when softReconnect throws', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  // Stub softReconnect to simulate the "connection landed, but the full session
  // re-setup failed" path. This is the only branch that triggers rollback.
  client._softReconnectDirect = async () => {
    throw new Error('simulated reconnect failure');
  };

  await assert.rejects(() => client.startProxy(), /simulated reconnect failure/);

  // Rollback assertions: both fields null, multiplexer stopped (its port freed).
  assert.equal(client.isProxyActive, false, 'proxy state rolled back after softReconnect failure');
  assert.equal(client.proxyUrl, null, '_proxyUrl cleared');
  assert.equal(client.proxyMultiplexer, null, '_multiplexer cleared');

  // A fresh startProxy must succeed (state genuinely reset, not just nulled out).
  let reconnects = 0;
  client._softReconnectDirect = async () => {
    reconnects++;
  };
  const url = await client.startProxy();
  assert.match(
    url,
    /^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/,
    'fresh startProxy succeeds after rollback',
  );
  assert.equal(reconnects, 1);

  await client.disconnect();
  await hermes.stop();
});

test('CDPClient.startProxy is concurrency-safe — parallel callers share one multiplexer', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  // Stub softReconnect with a small delay so both callers definitely race through
  // the guard during the multiplexer.start() await window.
  client._softReconnectDirect = async () => {
    await new Promise((r) => setTimeout(r, 30));
  };

  const [u1, u2, u3] = await Promise.all([
    client.startProxy(),
    client.startProxy(),
    client.startProxy(),
  ]);

  assert.equal(u1, u2, 'first and second callers get identical URL');
  assert.equal(u2, u3, 'third caller also joins the same in-flight');
  assert.match(u1, /^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/);
  assert.ok(client.proxyMultiplexer, 'exactly one multiplexer stored');
  assert.equal(client.proxyUrl, u1);

  // Second (post-resolved) call takes the already-active early return.
  const u4 = await client.startProxy();
  assert.equal(u4, u1, 'post-resolved calls return existing URL without re-allocating');

  await client.disconnect();
  await hermes.stop();
});

test('CDPClient.startProxy clears in-flight guard after failure so the next call retries', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  let attempts = 0;
  client._softReconnectDirect = async () => {
    attempts++;
    if (attempts === 1) throw new Error('first attempt fails');
  };

  // First call rejects → rollback path → _startProxyInFlight cleared.
  await assert.rejects(() => client.startProxy(), /first attempt fails/);

  // Second call must create a NEW multiplexer (previous one was torn down).
  const url = await client.startProxy();
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/);
  assert.equal(attempts, 2, 'second attempt ran (in-flight cache did not poison retry)');

  await client.disconnect();
  await hermes.stop();
});

// ── B132 auto-suspend / auto-resume across reconnect ──

test('B132: _suspendProxy clears _proxyUrl synchronously, preserves _proxyDesired', async () => {
  const client = new CDPClient();

  // Plant active-proxy state.
  client._proxyUrl = 'ws://127.0.0.1:45678';
  client._multiplexer = {
    port: 45678,
    isRunning: true,
    consumerCount: 0,
    stop: async () => {},
  };
  client._proxyDesired = true;

  const suspendPromise = client._suspendProxy();

  // Synchronous post-condition: _proxyUrl and _multiplexer cleared BEFORE the await.
  // This is critical — the handleClose hook relies on this so the reconnect loop
  // observes cleared state without waiting for multiplexer.stop() to complete.
  assert.equal(client._proxyUrl, null, '_proxyUrl cleared synchronously');
  assert.equal(client._multiplexer, null, '_multiplexer cleared synchronously');
  assert.equal(
    client._proxyDesired,
    true,
    '_proxyDesired preserved — resume hook should re-allocate',
  );

  await suspendPromise;
});

test('B132: _resumeProxy no-ops when _proxyDesired=false', async () => {
  const client = new CDPClient();
  // Plant a target so the "no connected target" guard doesn't trigger.
  plantConnectedTarget(client, 'ws://127.0.0.1:99999/will-not-use');

  assert.equal(client._proxyDesired, false, 'default desired=false');

  // Track whether startProxy fires.
  let startCalls = 0;
  const originalStartProxy = client.startProxy.bind(client);
  client.startProxy = async (...args) => {
    startCalls++;
    return originalStartProxy(...args);
  };

  await client._resumeProxy();
  assert.equal(startCalls, 0, '_resumeProxy skipped — no desired intent');
});

test('B132: _resumeProxy no-ops when _proxyUrl already set (already active)', async () => {
  const client = new CDPClient();
  plantConnectedTarget(client, 'ws://127.0.0.1:99999/existing');
  client._proxyDesired = true;
  client._proxyUrl = 'ws://127.0.0.1:45678'; // Already active

  let startCalls = 0;
  const originalStartProxy = client.startProxy.bind(client);
  client.startProxy = async (...args) => {
    startCalls++;
    return originalStartProxy(...args);
  };

  await client._resumeProxy();
  assert.equal(startCalls, 0, '_resumeProxy skipped — proxy already active');
});

test('B132: _resumeProxy failure clears _proxyDesired (predictable one-shot policy)', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);
  client._proxyDesired = true;

  // Stub _softReconnectDirect to fail — startProxy rollback fires, resume fails.
  client._softReconnectDirect = async () => {
    throw new Error('resume softReconnect failed');
  };

  await client._resumeProxy();

  // Failure policy: clear desired so we don't silently retry on every subsequent
  // reconnect. User sees the log warning + can re-invoke cdp_open_devtools.
  assert.equal(client._proxyDesired, false, '_proxyDesired cleared after resume failure');
  assert.equal(client._proxyUrl, null, 'no live proxy after failed resume');

  await hermes.stop();
});

test('B132: softReconnect wrapper suspends + resumes the proxy across reconnect', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  // First startProxy via the direct path — plants _proxyUrl + _proxyDesired=true.
  client._softReconnectDirect = async () => {}; // no-op reconnect
  const _originalUrl = await client.startProxy();
  assert.ok(client._proxyDesired, '_proxyDesired set after successful startProxy');

  const firstMux = client._multiplexer;

  // Now invoke the PUBLIC softReconnect — which should wrap with suspend→resume.
  // After this returns, _proxyUrl should be populated with a FRESH URL (new mux),
  // and the old mux should have been stopped.
  let firstMuxStopped = false;
  const origStop = firstMux.stop.bind(firstMux);
  firstMux.stop = async () => {
    firstMuxStopped = true;
    return origStop();
  };

  await client.softReconnect();

  assert.equal(firstMuxStopped, true, 'suspend stopped the original multiplexer');
  assert.ok(client._proxyUrl, 'resume allocated a new proxy URL');
  assert.notEqual(client._multiplexer, firstMux, 'new multiplexer allocated');

  await client.disconnect();
  await hermes.stop();
});

test('B132: softReconnect wrapper does NOT suspend/resume when proxy was inactive', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  assert.equal(client._proxyUrl, null, 'precondition: proxy inactive');

  let directCalls = 0;
  client._softReconnectDirect = async () => {
    directCalls++;
  };

  await client.softReconnect();

  assert.equal(directCalls, 1, 'softReconnect ran exactly once — no suspend/resume path');
  assert.equal(client._proxyUrl, null, 'proxy still inactive');
  assert.equal(client._proxyDesired, false, 'desired stays false');

  await hermes.stop();
});

test('B132: stopProxy clears _proxyDesired so post-stop reconnect does not re-allocate', async () => {
  const hermes = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermes.url);

  client._softReconnectDirect = async () => {};
  await client.startProxy();
  assert.equal(client._proxyDesired, true);

  await client.stopProxy();
  assert.equal(client._proxyDesired, false, 'stopProxy cleared desired intent');
  assert.equal(client._proxyUrl, null);

  // A subsequent softReconnect should NOT re-allocate a proxy.
  await client.softReconnect();
  assert.equal(client._proxyUrl, null, 'no proxy after explicit stop + reconnect');

  await client.disconnect();
  await hermes.stop();
});

test('B132: disconnect clears _proxyDesired (no zombie desired-flag across sessions)', async () => {
  const client = new CDPClient();
  client._proxyDesired = true;

  await client.disconnect();
  assert.equal(client._proxyDesired, false, 'disconnect clears desired flag');
});

test('B132: afterReconnect path — _resumeProxy picks up the new target URL (reconnect-loop trigger)', async () => {
  // This test complements the softReconnect-wrapper end-to-end below by exercising
  // the OTHER production trigger: the `handleClose → reconnect() → afterReconnect`
  // path. Instead of wiring up a fake WS close event, we directly simulate the
  // post-reconnect state: proxy suspended, _connectedTarget mutated to a new URL,
  // then `_resumeProxy()` invoked (which is what buildReconnectCtx's afterReconnect
  // callback does).
  const hermesA = await makeMockHermes();
  const hermesB = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermesA.url);

  // Initial proxy start against hermesA.
  client._softReconnectDirect = async () => {};
  await client.startProxy();
  const muxA = client._multiplexer;
  assert.equal(muxA.opts ? muxA.opts.hermesUrl : undefined, hermesA.url);

  // Simulate handleClose fire-and-forget: suspend the proxy synchronously.
  // (handleClose itself does this via `void this._suspendProxy()`.)
  await client._suspendProxy();
  assert.equal(client.proxyUrl, null);
  assert.equal(client.proxyMultiplexer, null);
  assert.equal(client._proxyDesired, true, 'desired flag preserved across suspend');

  // Simulate reconnect loop: discoverAndConnect picked a refreshed target.
  client._connectedTarget = {
    id: 'page1',
    title: 'Mock',
    vm: 'Hermes',
    webSocketDebuggerUrl: hermesB.url,
    platform: 'ios',
  };

  // afterReconnect hook fires → _resumeProxy() (this is what buildReconnectCtx wires up).
  await client._resumeProxy();

  const muxB = client._multiplexer;
  assert.notEqual(muxB, muxA, 'fresh multiplexer allocated via afterReconnect path');
  assert.equal(
    muxB.opts ? muxB.opts.hermesUrl : undefined,
    hermesB.url,
    'new proxy points at hermes B',
  );

  await client.disconnect();
  await hermesA.stop();
  await hermesB.stop();
});

test('B132: end-to-end — proxy rehydrates against a NEW target URL after reconnect', async () => {
  // Two mock Hermes instances simulate "target got a new URL after reload".
  const hermesA = await makeMockHermes();
  const hermesB = await makeMockHermes();
  const client = new CDPClient();
  plantConnectedTarget(client, hermesA.url);

  client._softReconnectDirect = async () => {};
  const urlA = await client.startProxy();
  const muxA = client._multiplexer;
  assert.equal(
    muxA.opts ? muxA.opts.hermesUrl : undefined,
    hermesA.url,
    'proxy A points at hermes A',
  );

  // Simulate a reconnect where the target's URL changed. In production, the
  // reconnect loop would update _connectedTarget via discoverAndConnect; here
  // we simulate that by mutating the target before softReconnect.
  client._softReconnectDirect = async () => {
    // Discovery picked a "refreshed" target with the same ID but a new URL.
    client._connectedTarget = {
      id: 'page1',
      title: 'Mock',
      vm: 'Hermes',
      webSocketDebuggerUrl: hermesB.url,
      platform: 'ios',
    };
  };

  await client.softReconnect();

  const muxB = client._multiplexer;
  assert.notEqual(muxB, muxA, 'new multiplexer allocated on resume');
  assert.equal(
    muxB.opts ? muxB.opts.hermesUrl : undefined,
    hermesB.url,
    'new proxy points at hermes B — this is the B132 fix',
  );
  assert.notEqual(client._proxyUrl, urlA, 'proxy URL changed (new ephemeral port)');

  await client.disconnect();
  await hermesA.stop();
  await hermesB.stop();
});
