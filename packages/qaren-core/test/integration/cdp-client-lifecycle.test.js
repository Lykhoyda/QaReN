import { before, after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeCDP } from '../helpers/fake-cdp-server.js';
import { CDPClient } from '../../dist/cdp-client.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdp-test-'));
process.env.TMPDIR = tmpDir;

async function poll(fn, timeoutMs = 12000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe('CDPClient lifecycle', () => {
  let server;

  before(async () => {
    server = await startFakeCDP();
  });

  after(async () => {
    await server.close();
  });

  test('autoConnect discovers target and connects', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);
      assert.equal(client.isConnected, true);
    } finally {
      await client.disconnect();
    }
  });

  test('evaluate sends message and receives response', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);

      server.setResponse('Runtime.evaluate', (_params) => ({
        result: { type: 'number', value: 42 },
      }));

      const result = await client.evaluate('1+1');
      assert.equal(result.value, 42);
    } finally {
      server.removeResponse('Runtime.evaluate');
      await client.disconnect();
    }
  });

  test('disconnect sets isConnected to false', async () => {
    const client = new CDPClient(server.port);
    await client.autoConnect(server.port);
    assert.equal(client.isConnected, true);
    await client.disconnect();
    assert.equal(client.isConnected, false);
  });

  test('reconnect after server drops connection', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);
      assert.equal(client.isConnected, true);

      server.disconnectAll();

      const reconnected = await poll(() => client.isConnected, 15000, 300);
      assert.equal(reconnected, true, 'Client should reconnect after server drops connection');
    } finally {
      await client.disconnect();
    }
  });

  test('falls back to hook mode when Network.enable fires no events (B1)', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);
      // The probe fires a fetch via evaluate, but fake server doesn't emit
      // Network.requestWillBeSent, so the probe times out and falls back to hooks
      const ok = await poll(() => client.helpersInjected, 15000, 300);
      assert.ok(ok, 'Helpers should be injected');
      assert.equal(
        client.networkMode,
        'hook',
        'Network mode should be "hook" — probe got no CDP events from fake server',
      );
    } finally {
      await client.disconnect();
    }
  });

  // GH #577: the empty-Metro cases must own their entire discovery surface.
  // RN_CDP_DISCOVERY_PORTS replaces the built-in default ports (8081/8082/…),
  // so a developer's live Metro on a default port can never leak into these
  // tests — neither as a false connect nor as pending reconnect work.
  async function startEmptyMetro() {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }
      if (req.url === '/json/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve, reject) => {
      srv.listen(0, '127.0.0.1', () => resolve(undefined));
      srv.once('error', reject);
    });

    return srv;
  }

  async function withEnv(overrides, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test('empty Metro rejects deterministically when discovery is isolated (GH #577)', async () => {
    const srv = await startEmptyMetro();
    const { port: emptyPort } = srv.address();
    // Hostile condition: simulate a developer's live Metro with an attached
    // target on a "default" port (the shared fake CDP server). The isolation
    // override must make it invisible to discovery.
    await withEnv({ RN_CDP_DISCOVERY_PORTS: '', RN_METRO_PORT: String(server.port) }, async () => {
      const client = new CDPClient(emptyPort);
      try {
        await assert.rejects(
          client.autoConnect(emptyPort),
          // GH #208 (RC2): the hinted Metro is up with 0 targets, so the only
          // correct outcome is the typed AppDetachedError. "Metro not found"
          // would mean discovery failed to probe the hinted server at all —
          // exactly the regression class this test exists to catch.
          (err) => err instanceof Error && err.name === 'AppDetachedError',
          'isolated discovery must reject with AppDetachedError — it may never select a host-environment Metro',
        );
        assert.equal(client.isConnected, false, 'failed connect must leave the client down');
      } finally {
        await client.disconnect();
      }
    }).finally(() => new Promise((resolve) => srv.close(resolve)));
  });

  test('attached Metro on a default port is preferred over an empty hinted Metro (GH #303 via #577 seam)', async () => {
    const srv = await startEmptyMetro();
    const { port: emptyPort } = srv.address();
    // Deterministic re-creation of the GH #303 scenario the old tolerant test
    // could only observe by accident: the "default" list contains a live,
    // attached Metro (the fake CDP server), which must win over the empty hint.
    await withEnv({ RN_CDP_DISCOVERY_PORTS: String(server.port) }, async () => {
      const client = new CDPClient(emptyPort);
      try {
        const message = await client.autoConnect(emptyPort);
        assert.equal(
          client.metroPort,
          server.port,
          'discovery must select the attached default-port Metro',
        );
        assert.match(message, /Connected to/);
      } finally {
        await client.disconnect();
      }
    }).finally(() => new Promise((resolve) => srv.close(resolve)));
  });
});
