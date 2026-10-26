import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { waitForExactPortTargets } from '../../../dist/cdp/discovery.js';
import { admit, awaitBundleReady, createBundleReload } from '../../../dist/qa/admission.js';
import { INJECTED_HELPERS, REACT_READY_PROBE_JS } from '../../../dist/injected-helpers.js';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createStop } from '../../../dist/qa/stop.js';
import { CDPClient } from '../../../dist/cdp-client.js';
import { NO_REPLY, startFakeCDP } from '../../helpers/fake-cdp-server.js';
import { prove, SCRIPT_URL_EXPRESSION, MODULE_NAMES_EXPRESSION } from '../../../dist/qa/prove.js';

const worktree = fileURLToPath(new URL('../../../', import.meta.url));

test('Android reloads recover from slow CDP reads and replacement pages on their own ports', async (t) => {
  const lanes = await Promise.all(
    ['helpers', 'proof', 'page', 'origin-page'].map(async (slow) => {
      const target = {
        id: slow,
        title: 'com.example.app (Pixel 9)',
        appId: 'com.example.app',
        type: 'node',
        deviceName: 'Pixel 9',
        description: 'React Native Bridgeless [C++ connection]',
      };
      const fake = await startFakeCDP(0, {
        targets: [target],
      });
      const client = new CDPClient(fake.port);
      t.after(async () => {
        await client.disconnect();
        await fake.close();
      });
      await client.connectExact(fake.port, { platform: 'android', bundleId: 'com.example.app' });
      let runtime: Record<string, unknown> = {};
      let helpers = 0;
      let proofs = 0;
      fake.setResponse('Runtime.evaluate', (params: { expression: string }) => {
        const expression = params.expression;
        if (expression === INJECTED_HELPERS && ++helpers === 1) {
          if (slow === 'helpers') return NO_REPLY;
          if (slow === 'page') {
            target.id = 'replacement-page';
            fake.disconnectAll();
            return NO_REPLY;
          }
        }
        if (expression === SCRIPT_URL_EXPRESSION) {
          if (++proofs === 1 && slow === 'proof') return NO_REPLY;
          if (proofs === 1 && slow === 'origin-page') {
            target.id = 'replacement-origin-page';
            fake.disconnectAll();
            return NO_REPLY;
          }
          return { result: { value: `http://127.0.0.1:${fake.port}/index.bundle` } };
        }
        if (expression === MODULE_NAMES_EXPRESSION)
          return {
            result: {
              value: JSON.stringify({
                count: 1,
                names: ['test/unit/qa/concurrent-admission.test.ts'],
              }),
            },
          };
        if (expression.includes('__QAREN_BUNDLE_MARK'))
          return { result: { value: runInNewContext(expression, runtime) } };
        return { result: { value: true } };
      });
      const reload = createBundleReload({
        evaluate: (expression) => client.evaluate(expression),
        reinjectHelpers: (waitMs) => client.reinjectHelpers(waitMs, true),
        prove: () =>
          prove(
            { evaluate: (expression) => client.evaluate(expression) },
            {
              metroPort: fake.port,
              worktree,
            },
          ),
        remainingMs: () => 30_000,
        pollMs: 1,
      });
      await reload.mark();
      runtime = {};
      fake.emitEvent('Runtime.executionContextsCleared', {});
      // A round-trip ensures the context-clear event invalidated helper evidence before reinjection.
      await client.evaluate(REACT_READY_PROBE_JS);
      const defaultWaiter = slow === 'helpers' ? client.reinjectHelpers(0) : Promise.resolve(false);
      return {
        reload,
        client,
        port: fake.port,
        slow,
        helpers: () => helpers,
        proofs: () => proofs,
        defaultWaiter,
      };
    }),
  );
  const results = await Promise.allSettled(lanes.map((lane) => lane.reload.settled()));
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
  );
  for (const lane of lanes) {
    assert.equal(
      await lane.defaultWaiter,
      false,
      'ordinary reinjection keeps its boolean contract',
    );
    assert.equal(
      lane.client.connectedTarget?.id,
      lane.slow.endsWith('page') ? `replacement-${lane.slow}` : lane.slow,
    );
    assert.equal(
      new URL(lane.client.connectedTarget!.webSocketDebuggerUrl).port,
      String(lane.port),
    );
    assert.ok(
      (lane.slow === 'helpers' || lane.slow === 'page' ? lane.helpers() : lane.proofs()) >= 2,
    );
  }
});

for (const method of ['Network.enable', 'Log.enable', 'Profiler.enable', 'HeapProfiler.enable']) {
  test(`a page closing during ${method} returns to admission for exact-port rediscovery`, async (t) => {
    const target = {
      id: 'old',
      title: 'com.example.app (iPhone)',
      appId: 'com.example.app',
      type: 'node',
      deviceName: 'iPhone',
      description: 'React Native Bridgeless [C++ connection]',
    };
    const fake = await startFakeCDP(0, { targets: [target] });
    const client = new CDPClient(fake.port);
    t.after(async () => {
      await client.disconnect();
      await fake.close();
    });
    let closes = 0;
    fake.setResponse(method, () => {
      if (++closes === 1) {
        target.id = 'replacement';
        fake.disconnectAll();
      }
      return {};
    });
    const deadline = performance.now() + 30_000;
    await admit(
      {
        metroPort: fake.port,
        readinessMs: 30_000,
        remainingMs: () => deadline - performance.now(),
        attach: async (attachDeadline) => {
          await client.connectExact(
            fake.port,
            { platform: 'ios', bundleId: 'com.example.app', deviceName: 'iPhone' },
            'default',
            1,
            undefined,
            attachDeadline,
          );
        },
        foreignDriver: async () => undefined,
        open: async () => {},
        prove: async () => ({
          ok: true,
          scriptURL: `http://127.0.0.1:${fake.port}/index.bundle`,
          appModules: 3,
        }),
        close: () => client.disconnect(),
        load: () => 3,
      },
      createStop(),
    );
    assert.equal(client.connectedTarget?.id, 'replacement');
    assert.ok(closes >= 2, 'the replacement page must complete setup');
  });
}

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
  const stop = createStop();
  let admitted: Promise<unknown> | undefined;
  t.after(async () => {
    stop.begin();
    await admitted;
    await client.disconnect();
    await fake.close();
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => now);
  let probes = 0;
  let opened = false;
  let settled = false;
  const deadlines: number[] = [];
  const firstAttachFailed = Promise.withResolvers<void>();
  const retryProbed = Promise.withResolvers<void>();
  fake.setResponse('Runtime.evaluate', (params: { expression?: string }) => {
    if (params.expression === '1+1') {
      probes++;
      if (probes === 1) fake.disconnectAll();
      else retryProbed.resolve();
      return NO_REPLY;
    }
    return { result: { type: 'boolean', value: true } };
  });
  const deadline = 4500;
  admitted = admit(
    {
      metroPort: fake.port,
      readinessMs: 30_000,
      remainingMs: () => deadline - performance.now(),
      attach: async (attachDeadline) => {
        deadlines.push(attachDeadline);
        try {
          await client.connectExact(
            fake.port,
            { platform: 'android', bundleId: 'com.example.app' },
            'default',
            1,
            undefined,
            attachDeadline,
          );
        } catch (error) {
          firstAttachFailed.resolve();
          throw error;
        }
      },
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
    stop,
  )
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await firstAttachFailed.promise;
  await nextTurn();
  now = 500;
  t.mock.timers.tick(500);
  await retryProbed.promise;
  assert.deepEqual(
    deadlines,
    [deadline, deadline],
    'retries must not renew the admission deadline',
  );
  now = deadline - 1;
  t.mock.timers.tick(deadline - 501);
  await nextTurn();
  assert.equal(settled, false, 'the never-responsive page retains its full admission budget');
  now = deadline;
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(settled, true, 'the never-responsive page must hit the admission deadline');
  const error = await admitted;
  assert.ok(error instanceof Error && 'code' in error);
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  assert.equal(probes, 2, 'both native pages received a readiness probe');
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

for (const phase of ['first probe', 'bundle readiness', 'origin proof']) {
  test(`a cold socket closing before its ${phase} rediscovers its exact app within admission`, async (t) => {
    const target = {
      id: 'cold-page',
      title: 'com.example.app (iPhone)',
      appId: 'com.example.app',
      type: 'node',
      deviceName: 'iPhone',
      description: 'React Native Bridgeless [C++ connection]',
    };
    const fake = await startFakeCDP(0, { targets: [target] });
    const client = new CDPClient(fake.port);
    t.after(async () => {
      await client.disconnect();
      await fake.close();
    });
    const emit = WebSocket.prototype.emit;
    let sockets = 0;
    let closeFirstSocket: () => void;
    t.mock.method(WebSocket.prototype, 'emit', function (event, ...args) {
      const emitted = emit.call(this, event, ...args);
      if (event === 'open' && ++sockets === 1) {
        closeFirstSocket = () => this.close();
        if (phase === 'first probe') {
          target.id = 'ready-page';
          this.close();
        }
      }
      return emitted;
    });
    fake.setResponse('Runtime.evaluate', ({ expression }) => {
      if (expression === SCRIPT_URL_EXPRESSION)
        return { result: { value: `http://127.0.0.1:${fake.port}/index.bundle` } };
      if (expression === MODULE_NAMES_EXPRESSION)
        return {
          result: {
            value: JSON.stringify({
              count: 1,
              names: ['test/unit/qa/concurrent-admission.test.ts'],
            }),
          },
        };
      return { result: { value: true } };
    });
    const deadline = performance.now() + 90_000;
    const proof = await client.withAttachDeadline(deadline, () =>
      admit(
        {
          metroPort: fake.port,
          readinessMs: 30_000,
          remainingMs: () => deadline - performance.now(),
          attach: async (attachDeadline) => {
            await client.connectExact(
              fake.port,
              { platform: 'ios', bundleId: target.appId, deviceName: target.deviceName },
              'default',
              1,
              undefined,
              attachDeadline,
            );
            if (phase === 'bundle readiness') {
              target.id = 'ready-page';
              closeFirstSocket();
            }
          },
          bundleReady: (attachDeadline) =>
            awaitBundleReady((expression) => client.evaluate(expression), attachDeadline),
          foreignDriver: async () => undefined,
          open: async () => {
            if (phase === 'origin proof') {
              target.id = 'ready-page';
              closeFirstSocket();
            }
          },
          prove: () =>
            prove(
              { evaluate: (expression) => client.evaluate(expression) },
              { metroPort: fake.port, worktree },
            ),
          close: () => client.disconnect(),
        },
        createStop(),
      ),
    );
    assert.equal(proof.ok, true);
    assert.equal(client.connectedTarget?.id, 'ready-page');
    assert.equal(client.connectedTarget?.appId, target.appId);
  });
}
