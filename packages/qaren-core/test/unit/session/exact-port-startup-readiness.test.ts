import { createStop } from '../../../dist/qa/stop.js';
import { admit } from '../../../dist/qa/admission.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { CDPClient } from '../../../dist/cdp-client.js';
import {
  BundleReadinessTimeoutError,
  TargetListAttemptTimeoutError,
  TargetReadinessTimeoutError,
  TargetSelectionError,
  discoverExactPort,
  listTargetsOnExactPort,
  waitForExactPortTargets,
} from '../../../dist/cdp/discovery.js';

const managedPort = 8341;
const endpoint = `http://127.0.0.1:${managedPort}/json/list`;
const filters = {
  platform: 'ios',
  bundleId: 'com.example.app',
  preferredBundleId: 'com.example.app',
};

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: 'owned-1',
    title: 'com.example.app (iPhone)',
    description: 'React Native Bridgeless [C++ connection]',
    appId: 'com.example.app',
    type: 'node',
    deviceName: 'iPhone',
    webSocketDebuggerUrl: `ws://127.0.0.1:${managedPort}/inspector/debug?device=owned&page=1`,
    ...overrides,
  };
}

function setup(t: TestContext, respond: typeof fetch) {
  let now = 10_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  const subprocess = t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('Subprocesses are forbidden in startup readiness tests');
  });
  syncBuiltinESMExports();
  const socket = t.mock.method(Socket.prototype, 'connect', () => {
    throw new Error('Sockets are forbidden in startup readiness tests');
  });
  t.after(() => {
    subprocess.mock.restore();
    syncBuiltinESMExports();
    assert.equal(socket.mock.callCount(), 0, 'readiness and refusal must not attach');
  });
  const requested: string[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', (url, options) => {
    requested.push(String(url));
    assert.equal(String(url), endpoint, 'only the managed /json/list may be read');
    return respond(url, options);
  });
  return {
    requested,
    fetchMock,
    subprocess,
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      t.mock.timers.tick(ms);
      await setImmediate();
    },
  };
}

test('empty startup targets become selectable on the same exact port after polling', async (t) => {
  let reads = 0;
  const clock = setup(t, async () => Response.json(++reads === 1 ? [] : [target()]));
  let settled = false;
  const waiting = waitForExactPortTargets(managedPort, 30_000, 500).then(
    () => {
      settled = true;
    },
    (error: unknown) => error,
  );
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(clock.requested, [endpoint]);

  await clock.advance(499);
  assert.equal(settled, false);
  assert.equal(reads, 1);
  await clock.advance(1);
  assert.equal(await waiting, undefined);
  assert.equal(reads, 2);
  assert.equal(clock.subprocess.mock.callCount(), 0, 'readiness must not inspect devices');

  const result = await discoverExactPort(managedPort, filters);
  assert.equal(result.port, managedPort);
  assert.deepEqual(
    result.targets.map((entry) => entry.id),
    ['owned-1'],
  );
  assert.deepEqual(clock.requested, [endpoint, endpoint, endpoint]);
});

test("a sibling simulator's runtime on the shared port does not satisfy the run device's wait", async (t) => {
  const sibling = target({
    id: 'sibling-1',
    title: 'com.example.app (qaren-check)',
    deviceName: 'qaren-check',
    webSocketDebuggerUrl: `ws://127.0.0.1:${managedPort}/inspector/debug?device=sibling&page=1`,
  });
  let reads = 0;
  const clock = setup(t, async () =>
    Response.json(++reads === 1 ? [sibling] : [sibling, target()]),
  );
  let settled = false;
  const waiting = waitForExactPortTargets(managedPort, 30_000, 500, undefined, 'iPhone').then(
    () => {
      settled = true;
    },
  );
  await setImmediate();
  assert.equal(settled, false, 'only the sibling is registered');
  await clock.advance(500);
  await waiting;
  assert.equal(reads, 2);

  const result = await discoverExactPort(managedPort, { ...filters, deviceName: 'iPhone' });
  assert.deepEqual(
    result.targets.map((entry) => entry.id),
    ['owned-1'],
  );
});

test("a wait pinned to the run device times out when only a sibling's runtime registers", async (t) => {
  const clock = setup(t, async () =>
    Response.json([target({ id: 'sibling-1', deviceName: 'qaren-check' })]),
  );
  const waiting = assert.rejects(
    waitForExactPortTargets(managedPort, 1000, 500, undefined, 'iPhone'),
    /Timed out waiting for a CDP target from device "iPhone" on port 8341 after 1000ms/,
  );
  await setImmediate();
  await clock.advance(500);
  await clock.advance(500);
  await waiting;
});

test('another bundle on the selected device does not satisfy readiness until the requested bundle registers', async (t) => {
  const wrongBundle = target({
    id: 'foreign-1',
    title: 'com.foreign.app (iPhone)',
    appId: 'com.foreign.app',
  });
  const siblingSameBundle = target({
    id: 'sibling-1',
    title: 'com.example.app (qaren-check)',
    deviceName: 'qaren-check',
    webSocketDebuggerUrl: `ws://127.0.0.1:${managedPort}/inspector/debug?device=sibling&page=1`,
  });
  let reads = 0;
  const clock = setup(t, async () =>
    Response.json(
      ++reads === 1 ? [wrongBundle, siblingSameBundle] : [wrongBundle, siblingSameBundle, target()],
    ),
  );
  let settled = false;
  const waiting = waitForExactPortTargets(
    managedPort,
    30_000,
    500,
    undefined,
    'iPhone',
    'com.example.app',
  ).then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(
    settled,
    false,
    'wrong bundle on selected device and same bundle on sibling must wait',
  );
  assert.deepEqual(clock.requested, [endpoint]);
  assert.equal(clock.subprocess.mock.callCount(), 0);

  await clock.advance(499);
  assert.equal(settled, false);
  assert.equal(reads, 1);
  await clock.advance(1);
  await waiting;
  assert.equal(settled, true);
  assert.equal(reads, 2);
  assert.equal(clock.subprocess.mock.callCount(), 0);

  const result = await discoverExactPort(managedPort, { ...filters, deviceName: 'iPhone' });
  assert.deepEqual(
    result.targets.map((entry) => entry.id),
    ['owned-1'],
  );
  assert.deepEqual(clock.requested, [endpoint, endpoint, endpoint]);
});

for (const [label, candidates] of [
  [
    'wrong bundle forever on selected device',
    [target({ id: 'foreign-1', appId: 'com.foreign.app', title: 'com.foreign.app (iPhone)' })],
  ],
  [
    'requested bundle only on sibling simulator',
    [
      target({ id: 'foreign-1', appId: 'com.foreign.app', title: 'com.foreign.app (iPhone)' }),
      target({
        id: 'sibling-1',
        deviceName: 'qaren-check',
        title: 'com.example.app (qaren-check)',
      }),
    ],
  ],
  [
    'conflicting bundle metadata on selected device',
    [
      target({
        id: 'conflict-1',
        appId: 'com.example.app',
        description: 'com.foreign.app',
        title: 'com.example.app (iPhone)',
      }),
      target({
        id: 'conflict-2',
        appId: 'com.example.app',
        title: 'com.foreign.app (iPhone)',
      }),
    ],
  ],
  [
    'unknown or malformed metadata on selected device',
    [
      null,
      {},
      { deviceName: 'iPhone' },
      { deviceName: 'iPhone', appId: null, title: 42, description: 'React Native Bridgeless' },
    ],
  ],
] as const) {
  test(`a device and bundle wait times out on ${label}`, async (t) => {
    const clock = setup(t, async () => Response.json(candidates));
    const waiting = assert.rejects(
      waitForExactPortTargets(managedPort, 1000, 500, undefined, 'iPhone', 'com.example.app'),
      /Timed out waiting for a CDP target from device "iPhone" on port 8341 after 1000ms/,
    );
    await setImmediate();
    await clock.advance(500);
    await clock.advance(500);
    await waiting;
    assert.deepEqual(clock.requested, [endpoint, endpoint]);
    assert.equal(clock.subprocess.mock.callCount(), 0);
  });
}

test('cancellation interrupts a bundle-pinned wait after a wrong-bundle response', async (t) => {
  const stop = createStop();
  const reads = t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      target({ id: 'foreign-1', appId: 'com.foreign.app', title: 'com.foreign.app (iPhone)' }),
    ]),
  );
  const waiting = waitForExactPortTargets(
    managedPort,
    30_000,
    10_000,
    stop.signal,
    'iPhone',
    'com.example.app',
  );
  await setImmediate();
  stop.begin();
  await assert.rejects(waiting, /RUN_CANCELLED/);
  assert.equal(reads.mock.callCount(), 1);
});

for (const [label, deviceName, candidates, Expected] of [
  [
    'wrong bundle on selected device',
    'iPhone',
    [target({ appId: 'com.foreign.app', title: 'com.foreign.app' })],
    BundleReadinessTimeoutError,
  ],
  [
    'wrong bundle without device pin',
    undefined,
    [target({ appId: 'com.foreign.app', title: 'com.foreign.app' })],
    BundleReadinessTimeoutError,
  ],
  [
    'malformed metadata on selected device',
    'iPhone',
    [{ deviceName: 'iPhone', appId: null, title: 42 }],
    BundleReadinessTimeoutError,
  ],
  ['no targets', 'iPhone', [], TargetReadinessTimeoutError],
  [
    'requested bundle only on sibling device',
    'iPhone',
    [target({ deviceName: 'sibling' })],
    TargetReadinessTimeoutError,
  ],
] as const) {
  test(`a bundle-pinned wait exhausts with ${Expected.name}: ${label}`, async (t) => {
    const clock = setup(t, async () => Response.json(candidates));
    const waiting = assert.rejects(
      waitForExactPortTargets(managedPort, 1000, 500, undefined, deviceName, filters.bundleId),
      (error: unknown) => {
        assert.equal((error as Error).constructor, Expected);
        assert.equal(
          (error as TargetReadinessTimeoutError).state,
          Expected === BundleReadinessTimeoutError
            ? 'other_bundle'
            : candidates.length === 0
              ? 'empty'
              : 'other_device',
        );
        return true;
      },
    );
    await setImmediate();
    await clock.advance(500);
    await clock.advance(500);
    await waiting;
  });
}

test('unanswered target-list requests are not classified as an empty list', async (t) => {
  const clock = setup(
    t,
    (_url, options) =>
      new Promise<Response>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)),
      ),
  );
  const waiting = assert.rejects(
    waitForExactPortTargets(managedPort, 1000, 500),
    (error: unknown) => {
      assert.equal((error as Error).constructor, TargetListAttemptTimeoutError);
      assert.equal((error as TargetReadinessTimeoutError).state, 'list_timeout');
      return true;
    },
  );
  await setImmediate();
  await clock.advance(1000);
  await waiting;
});

test('a final read that times out keeps the wrong-bundle observation of the last answered read', async (t) => {
  let reads = 0;
  const clock = setup(t, (_url, options) =>
    ++reads === 1
      ? Promise.resolve(
          Response.json([target({ appId: 'com.foreign.app', title: 'com.foreign.app' })]),
        )
      : new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)),
        ),
  );
  const waiting = assert.rejects(
    waitForExactPortTargets(managedPort, 1000, 500, undefined, 'iPhone', filters.bundleId),
    (error: unknown) => {
      assert.equal((error as Error).constructor, BundleReadinessTimeoutError);
      return true;
    },
  );
  await setImmediate();
  await clock.advance(500);
  await clock.advance(500);
  await waiting;
  assert.equal(reads, 2);
});

function admitThroughReadiness(
  t: TestContext,
  respond: (now: number, relaunched: boolean) => unknown[],
  appAlive: boolean,
) {
  const calls: string[] = [];
  let relaunched = false;
  const clock = setup(t, async () => Response.json(respond(clock.now(), relaunched)));
  const started = clock.now();
  const budgetMs = 10_000;
  const remainingMs = () => Math.max(0, budgetMs - (clock.now() - started));
  let outcome:
    | { proof?: unknown; error?: Error & { code?: string; meta?: Record<string, unknown> } }
    | undefined;
  admit(
    {
      metroPort: managedPort,
      readinessMs: 1000,
      remainingMs,
      attach: async () => {
        calls.push('wait');
        await waitForExactPortTargets(
          managedPort,
          Math.max(1, Math.min(1000, remainingMs())),
          500,
          undefined,
          'iPhone',
          filters.bundleId,
        );
        calls.push('connect_exact');
      },
      appAlive: async () => {
        calls.push('app_alive');
        return appAlive;
      },
      relaunch: async () => {
        calls.push('relaunch');
        relaunched = true;
      },
      foreignDriver: async () => {
        calls.push('foreign_driver');
        return undefined;
      },
      open: async () => {
        calls.push('open');
      },
      prove: async () => ({
        ok: true,
        scriptURL: 'http://127.0.0.1:8341/index.bundle',
        appModules: 3,
      }),
      close: async () => {
        calls.push('close');
      },
      load: () => 1,
    },
    createStop(),
  ).then(
    (proof) => (outcome = { proof }),
    (error) => (outcome = { error }),
  );
  return {
    calls,
    elapsed: () => clock.now() - started,
    async run() {
      await setImmediate();
      while (!outcome && clock.now() - started <= budgetMs + 1000) await clock.advance(500);
      return outcome;
    },
  };
}

for (const [label, candidates] of [
  [
    'wrong bundle on selected device',
    [target({ appId: 'com.foreign.app', title: 'com.foreign.app' })],
  ],
  ['malformed metadata on selected device', [{ deviceName: 'iPhone', appId: null, title: 42 }]],
] as const) {
  test(`exhausted readiness that saw only another bundle refuses without admission recovery: ${label}`, async (t) => {
    const admission = admitThroughReadiness(t, () => [...candidates], false);
    const outcome = await admission.run();
    assert.equal(outcome?.error?.code, 'CDP_NOT_CONNECTED');
    assert.equal(outcome?.error?.meta?.inner, 'bundle_readiness_timeout');
    assert.equal(outcome?.error?.meta?.attempt, 1);
    assert.equal(outcome?.error?.meta?.relaunches, 0);
    assert.deepEqual(admission.calls, ['wait', 'close']);
    assert.equal(admission.elapsed(), 1000);
  });
}

for (const [label, missing] of [
  ['no targets', []],
  ['requested bundle only on sibling device', [target({ deviceName: 'sibling' })]],
] as const) {
  test(`exhausted readiness with no target on the device relaunches a dead app once: ${label}`, async (t) => {
    const admission = admitThroughReadiness(
      t,
      (_now, relaunched) => (relaunched ? [target()] : [...missing]),
      false,
    );
    const outcome = await admission.run();
    assert.ok(outcome?.proof, `admission refused: ${outcome?.error?.message}`);
    assert.deepEqual(admission.calls, [
      'wait',
      'foreign_driver',
      'app_alive',
      'relaunch',
      'wait',
      'connect_exact',
      'foreign_driver',
      'open',
    ]);
  });
}

test('a live app whose target registers after the readiness window survives repeated recovery probes', async (t) => {
  let registeredAt: number | undefined;
  const admission = admitThroughReadiness(
    t,
    (now) => {
      registeredAt ??= now + 3500;
      return now >= registeredAt ? [target()] : [];
    },
    true,
  );
  const outcome = await admission.run();
  assert.ok(outcome?.proof, `admission refused: ${outcome?.error?.message}`);
  assert.ok(admission.elapsed() > 3000, `admitted after ${admission.elapsed()}ms`);
  assert.ok(!admission.calls.includes('relaunch'));
  assert.equal(admission.calls.filter((call) => call === 'app_alive').length, 2);
  assert.ok(admission.calls.filter((call) => call === 'wait').length > 2);
  assert.deepEqual(admission.calls.slice(-3), ['connect_exact', 'foreign_driver', 'open']);
});

test('a non-array target response fails immediately instead of polling', async (t) => {
  const clock = setup(t, async () => Response.json({ length: 1 }));
  await assert.rejects(
    waitForExactPortTargets(managedPort, 30_000, 500),
    /Invalid CDP target list on port 8341: expected an array/,
  );
  assert.deepEqual(clock.requested, [endpoint]);
  assert.equal(clock.now(), 10_000);
  assert.equal(clock.subprocess.mock.callCount(), 0);
});

test('a zero poll interval is refused before making a request', async (t) => {
  const clock = setup(t, async () => Response.json([target()]));
  await assert.rejects(waitForExactPortTargets(managedPort, 30_000, 0), {
    name: 'RangeError',
    message: /pollMs/,
  });
  assert.deepEqual(clock.requested, []);
});

for (const [label, raw] of [
  ['expected app', [target()]],
  ['empty metadata', [{}]],
  ['null metadata', [null]],
] as const) {
  test(`an existing raw target returns immediately without inspecting ${label}`, async (t) => {
    const clock = setup(t, async () => Response.json(raw));
    assert.equal(await waitForExactPortTargets(managedPort, 30_000, 500), undefined);
    assert.equal(clock.now(), 10_000);
    assert.deepEqual(clock.requested, [endpoint]);
    assert.equal(clock.subprocess.mock.callCount(), 0);
    await clock.advance(30_000);
    assert.deepEqual(clock.requested, [endpoint], 'no background polling remains');
    assert.equal(clock.fetchMock.mock.calls[0].arguments[1]?.signal?.aborted, false);
  });
}

test('forever-empty lists stop at an absolute monotonic deadline despite wall-clock jumps', async (t) => {
  let wallTime = 1_000_000;
  t.mock.method(Date, 'now', () => wallTime);
  const clock = setup(t, async () => Response.json([]));
  let settled = false;
  const waiting = assert
    .rejects(
      waitForExactPortTargets(managedPort, 1250, 500),
      /Timed out waiting for CDP targets on port 8341 after 1250ms/,
    )
    .then(() => {
      settled = true;
    });
  await setImmediate();
  await clock.advance(500);
  wallTime += 1_000_000;
  await clock.advance(500);
  wallTime = 0;
  await clock.advance(249);
  assert.equal(settled, false);
  assert.deepEqual(clock.requested, [endpoint, endpoint, endpoint]);
  await clock.advance(1);
  await waiting;
  assert.equal(clock.now(), 11_250);
  await clock.advance(30_000);
  assert.deepEqual(clock.requested, [endpoint, endpoint, endpoint]);
  assert.equal(clock.subprocess.mock.callCount(), 0);
});

test('a delayed poll wakeup cannot start another request after the deadline', async (t) => {
  const clock = setup(t, async () => Response.json([]));
  const waiting = assert.rejects(
    waitForExactPortTargets(managedPort, 1000, 500),
    /Timed out waiting for CDP targets/,
  );
  await setImmediate();
  await clock.advance(1001);
  await waiting;
  assert.deepEqual(clock.requested, [endpoint]);
});

function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<never> {
  assert.ok(signal);
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  });
}

for (const phase of ['headers', 'body']) {
  test(`request duration and sleep reduce the next ${phase} timeout to the remaining budget`, async (t) => {
    let reads = 0;
    const clock = setup(t, async (_url, options) => {
      if (++reads === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return Response.json([]);
      }
      if (phase === 'headers') return rejectOnAbort(options?.signal);
      const response = Response.json([]);
      response.json = () => rejectOnAbort(options?.signal);
      return response;
    });
    let settled = false;
    const waiting = assert
      .rejects(
        waitForExactPortTargets(managedPort, 1000, 500),
        /Timed out waiting for CDP targets on port 8341 after 1000ms/,
      )
      .then(() => {
        settled = true;
      });
    await clock.advance(200);
    await clock.advance(499);
    assert.equal(reads, 1);
    await clock.advance(1);
    assert.equal(reads, 2);
    await clock.advance(299);
    assert.equal(settled, false);
    await clock.advance(1);
    await waiting;
    assert.equal(clock.now(), 11_000);
    assert.equal(clock.fetchMock.mock.calls[0].arguments[1]?.signal?.aborted, false);
    assert.equal(clock.fetchMock.mock.calls[1].arguments[1]?.signal?.aborted, true);
    await clock.advance(30_000);
    assert.deepEqual(clock.requested, [endpoint, endpoint], 'aborted requests are never retried');
  });
}

test('target-list attempt timeouts retry only until the readiness deadline', async (t) => {
  const clock = setup(t, async (_url, options) => rejectOnAbort(options?.signal));
  let settled = false;
  const waiting = assert
    .rejects(
      waitForExactPortTargets(managedPort, 7000, 500),
      /Timed out waiting for CDP targets on port 8341 after 7000ms/,
    )
    .then(() => {
      settled = true;
    });
  await clock.advance(3000);
  assert.equal(settled, false);
  await clock.advance(500);
  assert.equal(clock.requested.length, 2);
  await clock.advance(3000);
  assert.equal(settled, false);
  await clock.advance(500);
  await waiting;
  assert.equal(clock.now(), 17_000);
  assert.deepEqual(clock.requested, [endpoint, endpoint]);
  await clock.advance(30_000);
  assert.equal(clock.requested.length, 2, 'no requests after the deadline');
});

for (const delay of [1000, 1001]) {
  for (const phase of ['headers', 'body']) {
    test(`a nonempty ${phase} response at ${delay}ms cannot succeed at or after the deadline`, async (t) => {
      const clock = setup(t, async () => {
        const response = Response.json([target()]);
        if (phase === 'headers') {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        } else {
          response.json = async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            return [target()];
          };
        }
        return response;
      });
      const waiting = assert.rejects(
        waitForExactPortTargets(managedPort, 1000, 500),
        /Timed out waiting for CDP targets on port 8341 after 1000ms/,
      );
      await setImmediate();
      await clock.advance(delay);
      await waiting;
      assert.deepEqual(clock.requested, [endpoint]);
      assert.equal(clock.fetchMock.mock.calls[0].arguments[1]?.signal?.aborted, true);
    });
  }
}

test('transport failures propagate immediately without polling', async (t) => {
  const clock = setup(t, async () => {
    throw new Error('connection refused');
  });
  await assert.rejects(
    waitForExactPortTargets(managedPort, 30_000, 500),
    /Failed to list CDP targets on port 8341: connection refused/,
  );
  assert.equal(clock.now(), 10_000);
  await clock.advance(30_000);
  assert.deepEqual(clock.requested, [endpoint]);
});

test('a transport failure after an empty list is not treated as another empty list', async (t) => {
  let reads = 0;
  const clock = setup(t, async () => {
    if (++reads === 1) return Response.json([]);
    throw new Error('connection reset');
  });
  const waiting = assert.rejects(
    waitForExactPortTargets(managedPort, 30_000, 500),
    /Failed to list CDP targets on port 8341: connection reset/,
  );
  await setImmediate();
  await clock.advance(500);
  await waiting;
  await clock.advance(30_000);
  assert.deepEqual(clock.requested, [endpoint, endpoint]);
});

test('invalid JSON propagates immediately without polling', async (t) => {
  const clock = setup(t, async () => new Response('{'));
  await assert.rejects(
    waitForExactPortTargets(managedPort, 30_000, 500),
    /Failed to list CDP targets on port 8341:/,
  );
  assert.equal(clock.now(), 10_000);
  await clock.advance(30_000);
  assert.deepEqual(clock.requested, [endpoint]);
});

for (const raw of [null, {}, 'not an array', 1, false]) {
  test(`non-array JSON ${JSON.stringify(raw)} is refused without a retry`, async (t) => {
    const clock = setup(t, async () => Response.json(raw));
    await assert.rejects(
      waitForExactPortTargets(managedPort, 30_000, 500),
      /Invalid CDP target list on port 8341: expected an array/,
    );
    assert.equal(clock.now(), 10_000);
    await clock.advance(30_000);
    assert.deepEqual(clock.requested, [endpoint]);
  });
}

for (const [label, candidate, refusal] of [
  [
    'wrong app',
    target({ appId: 'com.foreign.app', title: 'com.foreign.app (iPhone)' }),
    /bundleId "com.example.app" not found/,
  ],
  ['wrong platform', target({ deviceName: 'Pixel 9' }), /PLATFORM_TARGET_NOT_FOUND/],
  [
    'foreign debugger port',
    target({ webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?page=1' }),
    /PLATFORM_TARGET_NOT_FOUND/,
  ],
  ['invalid metadata', {}, /PLATFORM_TARGET_NOT_FOUND/],
] as const) {
  test(`readiness returns on ${label}, but real connectExact still refuses without attachment`, async (t) => {
    const clock = setup(t, async () => Response.json([candidate]));
    const client = new CDPClient(managedPort);
    t.after(() => client.disconnect());
    assert.equal(await waitForExactPortTargets(managedPort, 30_000, 500), undefined);
    assert.equal(clock.now(), 10_000);
    assert.deepEqual(clock.requested, [endpoint]);
    assert.equal(clock.subprocess.mock.callCount(), 0, 'readiness must not inspect devices');

    await assert.rejects(client.connectExact(managedPort, filters), refusal);
    assert.equal(client.isConnected, false);
    assert.equal(client.connectedTarget, null);
    assert.equal(clock.now(), 10_000);
    assert.deepEqual(clock.requested, [endpoint, endpoint]);
  });
}

for (const [label, devicePin, candidates, connectFilters, expectedCode, refusal] of [
  [
    'ambiguous same-name device connections',
    'iPhone',
    [
      target({ id: 'conn-a-1' }),
      target({
        id: 'conn-b-1',
        webSocketDebuggerUrl: `ws://127.0.0.1:${managedPort}/inspector/debug?device=conn-b&page=1`,
      }),
    ],
    { ...filters, deviceName: 'iPhone' },
    'DEVICE_TARGET_AMBIGUOUS',
    /matches 2 live Metro device connections.*refusing an ambiguous bind/,
  ],
  [
    'wrong platform after device and bundle readiness',
    'Pixel 9',
    [target({ deviceName: 'Pixel 9', title: 'com.example.app (Pixel 9)' })],
    { ...filters, deviceName: 'Pixel 9' },
    'PLATFORM_TARGET_NOT_FOUND',
    /PLATFORM_TARGET_NOT_FOUND/,
  ],
  [
    'foreign debugger port on matching device and bundle',
    'iPhone',
    [target({ webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?page=1' })],
    { ...filters, deviceName: 'iPhone' },
    'DEVICE_TARGET_NOT_FOUND',
    /Pinned device "iPhone" has no live CDP target/,
  ],
] as const) {
  test(`device and bundle readiness is not connection authority on ${label}`, async (t) => {
    const clock = setup(t, async () => Response.json(candidates));
    const client = new CDPClient(managedPort);
    t.after(() => client.disconnect());
    assert.equal(
      await waitForExactPortTargets(
        managedPort,
        30_000,
        500,
        undefined,
        devicePin,
        'com.example.app',
      ),
      undefined,
    );
    assert.equal(clock.subprocess.mock.callCount(), 0);

    await assert.rejects(client.connectExact(managedPort, connectFilters), (error: unknown) => {
      assert.ok(error instanceof TargetSelectionError);
      assert.equal(error.code, expectedCode);
      assert.match(error.message, refusal);
      return true;
    });
    assert.equal(client.isConnected, false);
    assert.equal(client.connectedTarget, null);
  });
}

test('readiness does not cache authority when the target disappears before connectExact', async (t) => {
  let reads = 0;
  const clock = setup(t, async () => Response.json(++reads === 1 ? [target()] : []));
  const client = new CDPClient(managedPort);
  t.after(() => client.disconnect());
  await waitForExactPortTargets(managedPort, 30_000, 500);
  await assert.rejects(client.connectExact(managedPort, filters), /PLATFORM_TARGET_NOT_FOUND/);
  assert.equal(client.isConnected, false);
  assert.equal(client.connectedTarget, null);
  assert.deepEqual(clock.requested, [endpoint, endpoint]);
});

test('existing exact-port discovery and listing remain one-shot on empty targets', async (t) => {
  const clock = setup(t, async () => Response.json([]));
  const discovery = await discoverExactPort(managedPort, filters);
  assert.equal(discovery.port, managedPort);
  assert.deepEqual(discovery.targets, []);
  assert.equal(discovery.errorCode, 'PLATFORM_TARGET_NOT_FOUND');
  assert.deepEqual(await listTargetsOnExactPort(managedPort), { port: managedPort, targets: [] });
  assert.equal(clock.now(), 10_000);
  assert.deepEqual(clock.requested, [endpoint, endpoint]);
});

test('invalid ports and unsafe timer arguments are rejected before any request', async (t) => {
  const clock = setup(t, async () => Response.json([target()]));
  for (const port of [0, -1, 65536, 8341.5, NaN, Infinity]) {
    await assert.rejects(waitForExactPortTargets(port, 30_000, 500), {
      name: 'RangeError',
      message: /port/,
    });
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(waitForExactPortTargets(managedPort, value, 500), {
      name: 'RangeError',
      message: /timeoutMs/,
    });
    await assert.rejects(waitForExactPortTargets(managedPort, 30_000, value), {
      name: 'RangeError',
      message: /pollMs/,
    });
  }
  assert.deepEqual(clock.requested, []);
  assert.equal(clock.subprocess.mock.callCount(), 0);
});

test('cancellation during a pending target response prevents the attach continuation', async (t) => {
  const stop = createStop();
  let respond: (response: Response) => void = () => {};
  t.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  let connected = false;
  const waiting = (async () => {
    await waitForExactPortTargets(managedPort, 30_000, 500, stop.signal);
    connected = true;
  })();
  stop.begin();
  respond(Response.json([target()]));
  await assert.rejects(waiting, /RUN_CANCELLED/);
  assert.equal(connected, false);
});

test('cancellation aborts a pending readiness fetch and makes no later request', async (t) => {
  const stop = createStop();
  const reads = t.mock.method(
    globalThis,
    'fetch',
    (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  const waiting = waitForExactPortTargets(managedPort, 30_000, 500, stop.signal);
  stop.begin();
  await assert.rejects(waiting, /RUN_CANCELLED/);
  assert.equal(reads.mock.callCount(), 1);
});

test('cancellation interrupts the polling sleep before another readiness request', async (t) => {
  const stop = createStop();
  const reads = t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const waiting = waitForExactPortTargets(managedPort, 30_000, 10_000, stop.signal);
  await setImmediate();
  stop.begin();
  await assert.rejects(waiting, /RUN_CANCELLED/);
  assert.equal(reads.mock.callCount(), 1);
});
