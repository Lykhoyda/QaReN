import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CDPClient, discoverAuthoritativeTarget } from '../../../dist/cdp-client.js';
import { discoverExactPort, listTargetsOnExactPort } from '../../../dist/cdp/discovery.js';

const managedPort = 8341;
const ambientPort = 8081;

function bridgelessTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'managed-target',
    title: 'com.example.app (Owned Simulator)',
    description: 'React Native Bridgeless [C++ connection]',
    appId: 'com.example.app',
    type: 'node',
    webSocketDebuggerUrl: `ws://127.0.0.1:${managedPort}/inspector/debug?device=owned&page=1`,
    deviceName: 'Owned Simulator',
    ...overrides,
  };
}

test('exact-port discovery recognizes modern Bridgeless Hermes metadata without probing ambient Metro', async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return {
      json: async () => [bridgelessTarget()],
    } as Response;
  }) as typeof fetch;
  try {
    const result = await discoverExactPort(managedPort, {
      bundleId: 'com.example.app',
      targetId: 'managed-target',
    });
    assert.equal(result.port, managedPort);
    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0]?.vm, undefined);
    assert.deepEqual(requested, [`http://127.0.0.1:${managedPort}/json/list`]);
    assert.equal(
      requested.some((url) => url.includes(`:${ambientPort}/`)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exact-port listing rejects a target whose debugger URL escapes the managed Metro port', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    json: async () => [
      bridgelessTarget({
        webSocketDebuggerUrl: `ws://127.0.0.1:${ambientPort}/inspector/debug?page=1`,
      }),
    ],
  })) as typeof fetch;
  try {
    const result = await listTargetsOnExactPort(managedPort);
    assert.deepEqual(result, { port: managedPort, targets: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exact-port discovery survives reconnects and ordinary entry points for the client lifetime', async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = String(url);
    requested.push(requestUrl);
    if (requestUrl.endsWith('/status')) {
      return { text: async () => 'packager-status:running' } as Response;
    }
    return { json: async () => [] } as unknown as Response;
  }) as typeof fetch;
  const client = new CDPClient(managedPort);
  try {
    const filters = { bundleId: 'com.example.app', targetId: 'managed-target' };
    await assert.rejects(client.connectExact(managedPort, filters));

    requested.length = 0;
    await assert.rejects(client.softReconnect());
    assert.deepEqual(requested, [`http://127.0.0.1:${managedPort}/json/list`]);

    requested.length = 0;
    await assert.rejects(client.autoConnect(ambientPort, filters));
    assert.deepEqual(requested, [`http://127.0.0.1:${managedPort}/json/list`]);
  } finally {
    await client.disconnect();
    globalThis.fetch = originalFetch;
  }
});

test("a later bare autoConnect keeps the exact attach's device pin instead of binding a sibling", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    json: async () => [bridgelessTarget({ id: 'sibling-1', deviceName: 'qaren-check' })],
  })) as unknown as typeof fetch;
  const client = new CDPClient(managedPort);
  const pinned = /Pinned device "Owned Simulator" has no live CDP target/;
  try {
    await assert.rejects(
      client.connectExact(managedPort, {
        platform: 'ios',
        bundleId: 'com.example.app',
        deviceName: 'Owned Simulator',
      }),
      pinned,
    );
    await assert.rejects(client.autoConnect(), pinned);
  } finally {
    await client.disconnect();
    globalThis.fetch = originalFetch;
  }
});

test('authoritative discovery re-resolves rotated target IDs from the managed port', async () => {
  const requestedFilters: Record<string, unknown>[] = [];
  const selected = await discoverAuthoritativeTarget(
    {
      port: managedPort,
      filters: { platform: 'ios', bundleId: 'com.example.app' },
      resolveTargetId: async (targets) => targets[0]!.id,
      verifyAndReconcile: async () => {},
    },
    { targetId: 'stale-target', platform: 'android', bundleId: 'com.foreign.app' },
    async (port, filters) => {
      requestedFilters.push(filters as Record<string, unknown>);
      return { port, targets: [bridgelessTarget({ id: 'rotated-target' })] };
    },
  );

  assert.equal(selected.port, managedPort);
  assert.equal(selected.targets[0]?.id, 'rotated-target');
  assert.deepEqual(requestedFilters, [
    {
      targetId: undefined,
      platform: 'ios',
      bundleId: 'com.example.app',
      preferredBundleId: undefined,
      deviceName: undefined,
    },
  ]);
});

test('replacement clients retain exact-port policy across ordinary entry points', async () => {
  const client = new CDPClient(ambientPort);
  client.setAuthoritativeSessionPolicy({
    port: managedPort,
    filters: { platform: 'ios', bundleId: 'com.example.app' },
    resolveTargetId: async () => 'managed-target',
    verifyAndReconcile: async () => {
      throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: signed marker rejected');
    },
  });
  const replacement = client.createReplacement(ambientPort);
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return { json: async () => [] } as unknown as Response;
  }) as typeof fetch;
  try {
    await replacement.listTargets(ambientPort);
    assert.deepEqual(requested, [`http://127.0.0.1:${managedPort}/json/list`]);
    await assert.rejects(replacement.autoConnect(ambientPort), /PLATFORM_TARGET_NOT_FOUND/);
    assert.equal(replacement.isConnected, false);
  } finally {
    await client.disconnect();
    await replacement.disconnect();
    globalThis.fetch = originalFetch;
  }
});

test('only the matching persisted exact-session policy is recoverable', async () => {
  const client = new CDPClient(ambientPort);
  assert.equal(
    client.matchesAuthoritativeSessionPolicy(managedPort, {
      platform: 'ios',
      bundleId: 'com.example.app',
    }),
    false,
  );
  client.setAuthoritativeSessionPolicy({
    port: managedPort,
    filters: { platform: 'ios', bundleId: 'com.example.app' },
    resolveTargetId: async () => 'managed-target',
    verifyAndReconcile: async () => {},
  });

  assert.equal(
    client.matchesAuthoritativeSessionPolicy(managedPort, {
      platform: 'ios',
      bundleId: 'COM.EXAMPLE.APP',
    }),
    true,
  );
  assert.equal(
    client.matchesAuthoritativeSessionPolicy(ambientPort, {
      platform: 'ios',
      bundleId: 'com.example.app',
    }),
    false,
  );
  assert.equal(
    client.matchesAuthoritativeSessionPolicy(managedPort, {
      platform: 'android',
      bundleId: 'com.example.app',
    }),
    false,
  );
  await client.disconnect();
});

test('an ambient policy can be suspended for a staged attempt and restored on failure', async () => {
  const client = new CDPClient(ambientPort);
  const policy = {
    port: managedPort,
    filters: { platform: 'android' as const, bundleId: 'com.example.app' },
    resolveTargetId: async () => 'managed-target',
    verifyAndReconcile: async () => {
      throw new Error('ambient reconciliation must stay suspended');
    },
  };
  client.setAuthoritativeSessionPolicy(policy);
  assert.equal(client.authoritativeSessionPolicy, policy);

  client.clearAuthoritativeSessionPolicy();
  assert.equal(client.authoritativeSessionPolicy, undefined);
  assert.equal(
    client.matchesAuthoritativeSessionPolicy(managedPort, {
      platform: 'android',
      bundleId: 'com.example.app',
    }),
    false,
  );

  client.setAuthoritativeSessionPolicy(policy);
  assert.equal(client.authoritativeSessionPolicy, policy);
  assert.equal(
    client.matchesAuthoritativeSessionPolicy(managedPort, {
      platform: 'android',
      bundleId: 'com.example.app',
    }),
    true,
  );
  await client.disconnect();
});
