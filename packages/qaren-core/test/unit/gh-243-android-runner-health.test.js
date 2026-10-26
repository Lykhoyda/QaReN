import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForAndroidRunnerHealth,
  runAndroid,
  isAndroidConnectionFailure,
  _setFetchForTest,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';

afterEach(() => {
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
});

test('#243 waitForAndroidRunnerHealth resolves true once /health returns {ok:true}', async () => {
  _setFetchForTest(async (url) => {
    assert.match(String(url), /\/health$/);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(healthy, true);
});

test('#243 waitForAndroidRunnerHealth keeps polling until healthy (no premature ready off a dead port)', async () => {
  let n = 0;
  _setFetchForTest(async () => {
    n += 1;
    if (n < 3) throw new Error('fetch failed'); // server socket not bound yet
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(healthy, true);
  assert.ok(n >= 3, 'must keep polling until /health actually succeeds');
});

test('#243 waitForAndroidRunnerHealth returns false on timeout (never throws)', async () => {
  _setFetchForTest(async () => {
    throw new Error('fetch failed');
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 60, intervalMs: 10 });
  assert.equal(healthy, false);
});

// Proves the classifier recognizes BOTH failure origins — postCommand ("fetch failed")
// AND startAndroidRunner ("did not become ready") — so the structured RN_ANDROID_RUNNER_DOWN
// path is covered regardless of which call in the try{} rejects. RUNNER_TIMEOUT (a bound but
// wedged instrument) must NOT classify as a connection failure (it is rethrown).
test('#243 isAndroidConnectionFailure matches both startAndroidRunner + postCommand shapes, not RUNNER_TIMEOUT', () => {
  assert.equal(isAndroidConnectionFailure('fetch failed'), true);
  assert.equal(
    isAndroidConnectionFailure(
      'Android runner did not become ready within 30s (no /health on port 22089)',
    ),
    true,
  );
  assert.equal(isAndroidConnectionFailure('connect ECONNREFUSED 127.0.0.1:22089'), true);
  assert.equal(isAndroidConnectionFailure('rn-android-runner not started'), true);
  assert.equal(
    isAndroidConnectionFailure(
      'RUNNER_TIMEOUT: rn-android-runner did not respond to "snapshot" within 10000ms',
    ),
    false,
  );
  // scoped to OUR client's message — a runner-side phrase like "app not started" must not classify down
  assert.equal(isAndroidConnectionFailure('app not started'), false);
});

// B191: startAndroidRunner has two MORE rejection shapes — instrumentation exiting before
// readiness (app not installed, am instrument crash) and spawn failure (adb missing). Both
// are runner-down conditions thrown inside runAndroid's try{} and must classify into the
// structured RN_ANDROID_RUNNER_DOWN path, not escape as raw exceptions.
test('#243/B191 isAndroidConnectionFailure matches startAndroidRunner startup-failure shapes', () => {
  assert.equal(
    isAndroidConnectionFailure(
      'Android runner instrumentation exited before readiness (code 1)\nINSTRUMENTATION_FAILED: dev.lykhoyda.rnandroidrunner.test',
    ),
    true,
  );
  assert.equal(
    isAndroidConnectionFailure('Failed to spawn Android runner instrumentation: spawn adb ENOENT'),
    true,
  );
});

test('#243 runAndroid returns RN_ANDROID_RUNNER_DOWN (not bare "fetch failed") on connection failure', async () => {
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid, // alive → startAndroidRunner short-circuits, no real adb spawn
    deviceId: 'emulator-5554',
    bundleId: 'com.example',
    startedAt: '2026-06-09T00:00:00.000Z',
  });
  // GH #383: the reuse gate probes GET /health first — answer it healthy +
  // compatible so the live injected runner is reused (no reap/real adb), then
  // fail the /command POST to exercise the connection-failure → RN_ANDROID_RUNNER_DOWN map.
  // GH #418: compatible now also requires the full advertised command surface.
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          protocolVersion: 1,
          commands: [...REQUIRED_ANDROID_COMMANDS],
          capabilities: [...REQUIRED_ANDROID_FEATURES],
        }),
      };
    }
    throw new Error('fetch failed');
  });

  const result = await runAndroid({ command: 'snapshot', bundleId: 'com.example' });

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /RN_ANDROID_RUNNER_DOWN/);
  assert.match(text, /not reachable/);
});
