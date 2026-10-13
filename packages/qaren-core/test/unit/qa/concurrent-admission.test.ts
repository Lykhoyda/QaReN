import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForExactPortTargets } from '../../../dist/cdp/discovery.js';
import { admit } from '../../../dist/qa/admission.js';
import { createStop } from '../../../dist/qa/stop.js';
import { CDPClient } from '../../../dist/cdp-client.js';
import { NO_REPLY, startFakeCDP } from '../../helpers/fake-cdp-server.js';
import { prove, SCRIPT_URL_EXPRESSION, MODULE_NAMES_EXPRESSION } from '../../../dist/qa/prove.js';

const worktree = fileURLToPath(new URL('../../../', import.meta.url));

test('concurrent exact-port admission survives a slow target-list attempt at low load', async (t) => {
  const ports = [8791, 8792];
  const reads = new Map<number, number>();
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    const port = Number(new URL(url).port);
    assert.ok(ports.includes(port), 'only the two managed ports may be read');
    assert.equal(new URL(url).pathname, '/json/list');
    const count = (reads.get(port) ?? 0) + 1;
    reads.set(port, count);
    if (port === ports[0] && count === 1) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(options?.signal?.reason);
        };
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', abort);
          resolve();
        }, 3500);
        options?.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return Response.json([{ id: `page-${port}` }]);
  });
  const results = await Promise.allSettled(
    ports.map((port) => {
      const deadline = performance.now() + 30_000;
      return admit(
        {
          metroPort: port,
          readinessMs: 30_000,
          remainingMs: () => deadline - performance.now(),
          attach: () => waitForExactPortTargets(port, 30_000, 500),
          foreignDriver: async () => undefined,
          open: async () => {},
          prove: async () => ({
            ok: true,
            scriptURL: `http://127.0.0.1:${port}/index.bundle`,
            appModules: 3,
          }),
          close: async () => {},
          load: () => 3,
        },
        createStop(),
      );
    }),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.ok((reads.get(ports[0]) ?? 0) >= 2, 'the stalled lane must retry its own port');
  assert.equal(reads.get(ports[1]), 1, 'the ready lane does not wait on its sibling');
});

test('a never-responsive native page exhausts one admission deadline and closes the socket', async (t) => {
  const fake = await startFakeCDP(0, {
    targets: [
      {
        id: 'owned',
        title: 'com.example.app (Pixel 9)',
        appId: 'com.example.app',
        type: 'node',
        deviceName: 'Pixel 9',
        description: 'React Native Bridgeless [C++ connection]',
      },
    ],
  });
  const client = new CDPClient(fake.port);
  t.after(async () => {
    await client.disconnect();
    await fake.close();
  });
  let probes = 0;
  let opened = false;
  fake.setResponse('Runtime.evaluate', (params: { expression?: string }) => {
    if (params.expression === '1+1') {
      probes++;
      return NO_REPLY;
    }
    return { result: { type: 'boolean', value: true } };
  });
  const started = performance.now();
  const deadline = started + 4500;
  await assert.rejects(
    admit(
      {
        metroPort: fake.port,
        readinessMs: 30_000,
        remainingMs: () => deadline - performance.now(),
        attach: (attachDeadline) =>
          client
            .connectExact(
              fake.port,
              { platform: 'android', bundleId: 'com.example.app' },
              'default',
              1,
              undefined,
              attachDeadline,
            )
            .then(() => {}),
        foreignDriver: async () => undefined,
        open: async () => {
          opened = true;
        },
        prove: async () => ({
          ok: true,
          scriptURL: `http://127.0.0.1:${fake.port}/index.bundle`,
          appModules: 3,
        }),
        close: () => client.disconnect(),
        load: () => 3,
      },
      createStop(),
    ),
    { code: 'CDP_NOT_CONNECTED' },
  );
  assert.ok(performance.now() - started < 8000, 'retries must not renew the admission deadline');
  assert.ok(probes >= 1, 'the native page received a readiness probe');
  assert.equal(opened, false);
  assert.equal(client.isConnected, false);
  assert.equal(client.connectedTarget, null);
});

test('two exact sessions admit when a native page answers beyond the five-probe window', async (t) => {
  const appId = 'com.example.app';
  const readyAt = performance.now() + 17_000;
  const lanes = await Promise.all(
    (['ios', 'android'] as const).map(async (platform) => {
      const target = {
        id: `old-${platform}`,
        title: `${appId} (${platform === 'ios' ? 'iPhone' : 'Pixel 9'})`,
        description: 'React Native Bridgeless [C++ connection]',
        appId,
        type: 'node',
        deviceName: platform === 'ios' ? 'iPhone' : 'Pixel 9',
      };
      const fake = await startFakeCDP(0, { targets: [target] });
      const client = new CDPClient(fake.port);
      t.after(async () => {
        await client.disconnect();
        await fake.close();
      });
      let probes = 0;
      fake.setResponse('Runtime.evaluate', (params: { expression?: string }) => {
        if (params.expression === '1+1') {
          probes++;
          target.id = `ready-${platform}`;
          if (probes === 1) fake.disconnectAll();
          if (performance.now() < readyAt) return NO_REPLY;
        }
        if (params.expression === SCRIPT_URL_EXPRESSION)
          return {
            result: { type: 'string', value: `http://127.0.0.1:${fake.port}/index.bundle` },
          };
        if (params.expression === MODULE_NAMES_EXPRESSION)
          return {
            result: {
              type: 'string',
              value: JSON.stringify({
                count: 1,
                names: ['test/unit/qa/concurrent-admission.test.ts'],
              }),
            },
          };
        return { result: { type: 'boolean', value: true } };
      });
      const deadline = performance.now() + 30_000;
      return {
        platform,
        client,
        probes: () => probes,
        run: () =>
          admit(
            {
              metroPort: fake.port,
              readinessMs: 30_000,
              remainingMs: () => deadline - performance.now(),
              attach: async (attachDeadline) => {
                await waitForExactPortTargets(fake.port, 30_000, 500);
                await client.connectExact(
                  fake.port,
                  {
                    platform,
                    bundleId: appId,
                    ...(platform === 'ios' ? { deviceName: 'iPhone' } : {}),
                  },
                  'default',
                  1,
                  undefined,
                  attachDeadline,
                );
              },
              foreignDriver: async () => undefined,
              open: async () => {},
              prove: () =>
                prove(
                  { evaluate: (expression) => client.evaluate(expression) },
                  { metroPort: fake.port, worktree },
                ),
              close: () => client.disconnect(),
              load: () => 3,
            },
            createStop(),
          ),
      };
    }),
  );
  const results = await Promise.allSettled(lanes.map((lane) => lane.run()));
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  for (const lane of lanes) {
    assert.ok(lane.probes() > 5, 'a probe count cannot end the readiness opportunity');
    assert.equal(
      lane.client.connectedTarget?.id,
      `ready-${lane.platform}`,
      'page identities are rediscovered',
    );
    assert.equal(lane.client.connectedTarget?.appId, appId);
  }
});
