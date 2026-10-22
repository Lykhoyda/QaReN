import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  _setCapabilitiesForTest,
  observeAppProcess,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { withCancellation } from '../../../dist/domain/cancellation.js';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import {
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { createTimingObserver, type TimingEvent } from '../../../dist/qa/timing.js';
import { nativeCapture } from '../qa/platform-presence-fixtures.ts';

afterEach(() => {
  _setFetchForTest(fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  observeAppProcess(undefined);
  resetActiveSessionInMemoryForTest();
  clearRefMap();
});

function fixture(
  options: {
    health?: (reply: Record<string, unknown>, count: number) => unknown;
    transportFailure?: boolean;
    decodeFailure?: boolean;
    unbound?: boolean;
    recoverReply?: boolean;
  } = {},
) {
  const state = {
    port: 12345,
    pid: process.pid,
    deviceId: 'qa-device',
    bundleId: 'com.test',
    startedAt: 'now',
    capability: 'PRIVATE-capability',
    instanceId: 'PRIVATE-instance',
    sessionId: 'PRIVATE-session',
    claimEpoch: 1,
  };
  _setFastRunnerStateForTest(
    options.unbound
      ? { ...state, sessionId: undefined, instanceId: undefined, claimEpoch: undefined }
      : state,
  );
  setActiveSessionInMemoryForTest({
    name: 'qa',
    platform: 'ios',
    appId: state.bundleId,
    deviceId: state.deviceId,
  });
  let now = 100;
  const events: TimingEvent[] = [];
  const requests: Record<string, unknown>[] = [];
  let healthCalls = 0;
  const qaTiming = { now: () => now, observe: createTimingObserver((e) => events.push(e)) };
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) {
      now += 3;
      const reply = {
        ok: true,
        protocolVersion: 2,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [
          ...REQUIRED_IOS_FEATURES,
          'PLATFORM_PRESENCE_V2',
          'QA_READ_ONLY_V1',
          'PRIVATE-feature',
        ],
        instanceId: state.instanceId,
        sessionId: state.sessionId,
        claimEpoch: state.claimEpoch,
        deviceId: state.deviceId,
        appId: state.bundleId,
      };
      const health = options.health ? options.health(reply, ++healthCalls) : reply;
      return health instanceof Response ? health : Response.json(health);
    }
    requests.push(JSON.parse(String(init?.body)));
    now += 7;
    if (options.transportFailure || (options.recoverReply && requests.length === 1))
      throw new Error('PRIVATE-transport');
    const request = requests.at(-1)!;
    const data =
      request.command === 'status'
        ? { commandId: request.commandId, state: 'completed' }
        : { ...nativeCapture(), appProcessIdentifier: 41 };
    const response = Response.json({ ok: true, v: 2, data });
    const json = response.json.bind(response);
    response.json = async () => {
      now += 11;
      if (options.decodeFailure) throw new Error('PRIVATE-decoder');
      return json();
    };
    return response;
  });
  return {
    qaTiming,
    events,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('the real snapshot handler forwards host-only timing through both iOS capture paths', async () => {
  for (const platformPresence of [false, true]) {
    const { qaTiming, events, requests } = fixture();
    const result = await createDeviceSnapshotHandler()({
      action: 'snapshot',
      qaReadOnly: true,
      platformPresence,
      presenceBudgetMs: 20_000,
      qaTiming,
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      events
        .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
        .map((e) => [e.count, e.ms, e.outcome, e.readinessReason]),
      platformPresence
        ? [
            [1, 3, 'ok', 'alive'],
            [2, 3, 'ok', 'alive'],
          ]
        : [[1, 3, 'ok', 'alive']],
    );
    assert.ok(
      events.every(
        (e) =>
          e.readinessReason === undefined || (e.stage === 'native-readiness' && e.edge === 'end'),
      ),
    );
    assert.equal(events.find((e) => e.stage === 'native-transport' && e.edge === 'end')?.ms, 7);
    assert.equal(events.find((e) => e.stage === 'native-decode' && e.edge === 'end')?.ms, 11);
    assert.ok(events.some((e) => e.stage === 'native-read-only-v1' && e.outcome === 'ok'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].qaReadOnly, true);
    assert.equal(requests[0].platformPresence, platformPresence || undefined);
    assert.ok(!Object.keys(requests[0]).some((key) => /timing|observe|now/i.test(key)));
    assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  }
});

test('both readiness probes retain the finite refusal category without changing dispatch', async () => {
  const cases = [
    [
      'health',
      () => {
        throw new Error('PRIVATE-health');
      },
    ],
    ['authority-mismatch', (reply) => ({ ...reply, sessionId: 'PRIVATE-foreign-session' })],
    ['legacy', (reply) => ({ ...reply, protocolVersion: undefined })],
    ['protocol-older', (reply) => ({ ...reply, protocolVersion: 0 })],
    ['protocol-newer', (reply) => ({ ...reply, protocolVersion: 99 })],
    ['version-skew', (reply) => ({ ...reply, runnerVersion: 'PRIVATE-version' })],
    ['missing-commands', (reply) => ({ ...reply, commands: [] })],
    ['missing-features', (reply) => ({ ...reply, capabilities: [] })],
  ] satisfies [string, (reply: Record<string, unknown>) => unknown][];
  for (const [reason, health] of cases) {
    for (const probe of [1, 2]) {
      const f = fixture({ health: (reply, count) => (count === probe ? health(reply) : reply) });
      const call = createDeviceSnapshotHandler()({
        action: 'snapshot',
        qaReadOnly: true,
        platformPresence: true,
        presenceBudgetMs: 20_000,
        qaTiming: f.qaTiming,
      });
      if (probe === 1) await assert.rejects(call, /ACTION_CONTEXT_CHANGED/);
      else {
        const result = await call;
        assert.equal(result.isError, true);
        const envelope = JSON.parse(result.content[0].text);
        assert.equal(
          envelope.code,
          reason === 'authority-mismatch' ? 'RUNNER_OWNERSHIP_MISMATCH' : 'RN_FAST_RUNNER_DOWN',
        );
        assert.equal(envelope.meta.runnerRelaunch, undefined);
      }
      assert.deepEqual(
        f.events
          .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
          .map((e) => [e.count, e.outcome, e.readinessReason]),
        [...(probe === 2 ? [[1, 'ok', 'alive']] : []), [probe, 'failed', reason]],
      );
      assert.equal(f.requests.length, 0);
      assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
    }
  }
});

test('missing runner state is dead while an aborted readiness probe is unknown', async () => {
  const dead = fixture();
  _setFastRunnerStateForTest(null);
  await assert.rejects(
    runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: dead.qaTiming }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.equal(
    dead.events.find((e) => e.stage === 'native-readiness' && e.edge === 'end')?.readinessReason,
    'dead',
  );
  assert.equal(dead.requests.length, 0);

  const controller = new AbortController();
  const reason = new Error('PRIVATE-abort');
  const aborted = fixture({
    health: () => {
      controller.abort(reason);
      throw reason;
    },
  });
  await assert.rejects(
    withCancellation(controller.signal, () =>
      runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: aborted.qaTiming }),
    ),
    (error) => error === reason,
  );
  assert.equal(
    aborted.events.find((e) => e.stage === 'native-readiness' && e.edge === 'end')?.readinessReason,
    'unknown',
  );
  assert.equal(aborted.requests.length, 0);
  assert.ok(!JSON.stringify(aborted.events).includes('PRIVATE'));
});

test('cached or lookalike capabilities and unbound health cannot attest read-only capture', async () => {
  for (const mode of ['missing', 'lookalike', 'unbound', 'foreign-session'] as const) {
    const f = fixture({
      unbound: mode === 'unbound',
      health: (reply) =>
        mode === 'foreign-session'
          ? { ...reply, sessionId: 'PRIVATE-foreign-session' }
          : mode === 'unbound'
            ? reply
            : {
                ...reply,
                capabilities: [
                  ...REQUIRED_IOS_FEATURES,
                  'PLATFORM_PRESENCE_V2',
                  ...(mode === 'lookalike' ? ['QA_READ_ONLY_V10'] : []),
                ],
              },
    });
    _setCapabilitiesForTest(['QA_READ_ONLY_V1']);
    const call = createDeviceSnapshotHandler()({
      action: 'snapshot',
      qaReadOnly: true,
      qaTiming: f.qaTiming,
    });
    if (mode === 'unbound') assert.equal((await call).isError, undefined);
    else await assert.rejects(call, /ACTION_CONTEXT_CHANGED/);
    assert.ok(!f.events.some((e) => e.stage === 'native-read-only-v1' && e.outcome === 'ok'));
    assert.equal(f.requests.length, mode === 'unbound' ? 1 : 0);
    assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
  }
});

test('the second real health response, not the first probe cache, supplies presence-path attestation', async () => {
  const f = fixture({
    health: (reply, count) =>
      count === 2
        ? { ...reply, capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2'] }
        : reply,
  });
  await createDeviceSnapshotHandler()({
    action: 'snapshot',
    qaReadOnly: true,
    platformPresence: true,
    presenceBudgetMs: 20_000,
    qaTiming: f.qaTiming,
  });
  assert.deepEqual(
    f.events.filter((e) => e.stage === 'native-read-only-v1').map((e) => [e.count, e.outcome]),
    [
      [1, 'ok'],
      [2, 'unknown'],
    ],
  );
  assert.equal(f.requests.length, 1, 'measurement does not change the existing readiness policy');
});

test('readiness, transport and decoding failures close the actual attempted spans without private data', async () => {
  for (const stage of ['native-readiness', 'native-transport', 'native-decode'] as const) {
    const f = fixture({
      ...(stage === 'native-readiness'
        ? {
            health: () => {
              throw new Error('PRIVATE-health');
            },
          }
        : {}),
      transportFailure: stage === 'native-transport',
      decodeFailure: stage === 'native-decode',
    });
    const call = createDeviceSnapshotHandler()({
      action: 'snapshot',
      qaReadOnly: true,
      platformPresence: true,
      presenceBudgetMs: 20_000,
      qaTiming: f.qaTiming,
    });
    if (stage === 'native-readiness') await assert.rejects(call, /ACTION_CONTEXT_CHANGED/);
    else assert.equal((await call).isError, true);
    assert.ok(
      f.events.some((e) => e.stage === stage && e.edge === 'end' && e.outcome === 'failed'),
    );
    if (stage !== 'native-decode') assert.ok(!f.events.some((e) => e.stage === 'native-decode'));
    assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
  }
});

test('native transport instrumentation stays before authorization and cannot extend its deadline', async () => {
  const f = fixture();
  const emit = f.qaTiming.observe;
  f.qaTiming.observe = (e) => {
    emit(e);
    if (e.stage === 'native-transport' && e.edge === 'start') f.advance(100);
  };
  const context = new QaDispatchContext(110, f.qaTiming.now);
  await assert.rejects(
    runIOS({
      command: 'back',
      bundleId: 'com.test',
      deviceId: 'qa-device',
      qaContext: context,
      qaTiming: f.qaTiming,
    }),
    /EVIDENCE_EXPIRED/,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(context.authorizations, 0);
});

test('a failing metric sink cannot alter adapter requests or successful capture evidence', async () => {
  const f = fixture();
  f.qaTiming.observe = () => {
    throw new Error('PRIVATE-sink');
  };
  const result = await createDeviceSnapshotHandler()({
    action: 'snapshot',
    qaReadOnly: true,
    platformPresence: true,
    presenceBudgetMs: 20_000,
    qaTiming: f.qaTiming,
  });
  assert.equal(result.isError, undefined);
  assert.equal(f.requests.length, 1);
});

test('an existing ordinary-read status probe and resend retain every transport and decoding span', async () => {
  const f = fixture({ recoverReply: true });
  const result = await createDeviceSnapshotHandler()({
    action: 'snapshot',
    qaReadOnly: true,
    qaTiming: f.qaTiming,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    f.requests.map((r) => r.command),
    ['snapshot', 'status', 'snapshot'],
  );
  assert.deepEqual(
    f.events
      .filter((e) => e.stage === 'native-transport' && e.edge === 'end')
      .map((e) => e.outcome),
    ['failed', 'ok', 'ok'],
  );
  assert.equal(f.events.filter((e) => e.stage === 'native-decode' && e.edge === 'end').length, 2);
  assert.ok(
    f.requests.every((r) => !Object.keys(r).some((key) => /timing|observe|now/i.test(key))),
  );
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
});

const failedHealth = (code: string) => () => {
  throw Object.assign(new TypeError('PRIVATE-fetch failed'), {
    cause: Object.assign(new Error('PRIVATE-connect'), { code }),
  });
};

async function readThenFail(health: (reply: Record<string, unknown>) => unknown) {
  const f = fixture({ health: (reply, count) => (count === 2 ? health(reply) : reply) });
  const snapshot = () =>
    createDeviceSnapshotHandler()({ action: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming });
  assert.equal((await snapshot()).isError, undefined);
  await assert.rejects(snapshot(), /ACTION_CONTEXT_CHANGED/);
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
  return f.events;
}

test('a failed health probe names its bounded failure kind on the readiness end row', async () => {
  const cases = [
    ['refused', failedHealth('ECONNREFUSED')],
    ['reset', failedHealth('ECONNRESET')],
    ['other', failedHealth('PRIVATE-CODE')],
    [
      'abort',
      () => {
        throw new DOMException('PRIVATE-timeout', 'AbortError');
      },
    ],
    ['http-4xx', () => new Response('PRIVATE', { status: 401 })],
    ['http-5xx', () => new Response('PRIVATE', { status: 503 })],
    ['body-not-ok', (reply) => ({ ...reply, ok: false })],
    ['wedged', () => ({ ok: false, reason: 'wedged' })],
  ] satisfies [string, (reply: Record<string, unknown>) => unknown][];
  for (const [healthDetail, health] of cases) {
    const events = await readThenFail(health);
    assert.deepEqual(
      events
        .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
        .map((e) => [e.outcome, e.readinessReason, e.healthDetail]),
      [
        ['ok', 'alive', undefined],
        ['failed', 'health', healthDetail],
      ],
    );
  }
});

test('a failed readiness probe is followed by a value-free post-mortem with app continuity', async () => {
  const cases = [
    ['same', async () => 41],
    ['changed', async () => 42],
    ['absent', async () => undefined],
    [
      'unknown',
      async () => {
        throw new Error('PRIVATE-simctl');
      },
    ],
  ] satisfies [string, () => Promise<number | undefined>][];
  for (const [appProcess, probe] of cases) {
    const lookups: number[] = [];
    observeAppProcess(async () => {
      lookups.push(1);
      return probe();
    });
    const events = await readThenFail(failedHealth('ECONNREFUSED'));
    const rows = events.filter((e) => e.stage === 'runner-post-mortem');
    assert.deepEqual(
      rows.map((e) => [e.edge, e.outcome, e.count, e.hostChild, e.appProcess]),
      [['point', 'failed', 1, 'unknown', appProcess]],
    );
    assert.equal(lookups.length, 1, 'a healthy read never looks the app process up');
    const failed = events.findIndex(
      (e) => e.stage === 'native-readiness' && e.outcome === 'failed',
    );
    assert.ok(events.indexOf(rows[0]) > failed, 'the post-mortem cannot inflate readiness timing');
  }
  observeAppProcess(undefined);
  const unobserved = await readThenFail(failedHealth('ECONNREFUSED'));
  assert.equal(unobserved.find((e) => e.stage === 'runner-post-mortem')?.appProcess, 'unknown');
});

test('a run cancelled during the app-process lookup raises the cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('PRIVATE-abort');
  observeAppProcess(async () => {
    controller.abort(reason);
    throw reason;
  });
  const f = fixture({
    health: (reply, count) => (count === 2 ? failedHealth('ECONNREFUSED')() : reply),
  });
  const snapshot = () =>
    createDeviceSnapshotHandler()({ action: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming });
  await withCancellation(controller.signal, async () => {
    assert.equal((await snapshot()).isError, undefined);
    await assert.rejects(snapshot(), (error) => error === reason);
  });
  assert.equal(f.events.filter((e) => e.stage === 'runner-post-mortem').length, 0);
});

test('default probe classifies transport timeouts and HTTP protocol errors at fetch', async () => {
  const cases = [
    ['transport-timeout', 'ETIMEDOUT'],
    ['transport-timeout', 'UND_ERR_CONNECT_TIMEOUT'],
    ['transport-timeout', 'UND_ERR_HEADERS_TIMEOUT'],
    ['http-protocol', 'HPE_INVALID_CONSTANT'],
    ['http-protocol', 'HPE_INVALID_CHUNK_SIZE'],
    ['refused', 'ECONNREFUSED'],
  ];
  for (const [healthDetail, code] of cases) {
    const events = await readThenFail(failedHealth(code));
    assert.deepEqual(
      events
        .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
        .map((e) => [e.outcome, e.readinessReason, e.healthDetail, e.readinessExceptionStage]),
      [
        ['ok', 'alive', undefined, undefined],
        ['failed', 'health', healthDetail, 'fetch'],
      ],
    );
    assert.ok(!/ECONN|ETIMEDOUT|UND_ERR|HPE_/.test(JSON.stringify(events)));
  }
});

test('default probe locates a response access exception without extra requests', async () => {
  const f = fixture();
  let healthCalls = 0,
    bodyReads = 0;
  const response = Response.json({ ok: true });
  response.json = async () => {
    bodyReads++;
    return { ok: true };
  };
  Object.defineProperty(response, 'ok', {
    get: () => {
      throw Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' });
    },
  });
  _setFetchForTest(async () => {
    healthCalls++;
    return response;
  });
  await assert.rejects(
    runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(
    f.events
      .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
      .map((e) => [e.readinessReason, e.healthDetail, e.readinessExceptionStage]),
    [['health', 'reset', 'response-access']],
  );
  assert.deepEqual([healthCalls, bodyReads, f.requests.length], [1, 0, 0]);
});

test('ordinary health refusals do not acquire an exception stage', async () => {
  const f = fixture({ health: () => ({ ok: false }) });
  await assert.rejects(
    runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming }),
    /ACTION_CONTEXT_CHANGED/,
  );
  const ends = f.events.filter((e) => e.stage === 'native-readiness' && e.edge === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].readinessReason, 'health');
  assert.equal(ends[0].readinessExceptionStage, undefined);
});

test('the existing local probe controller aborts at its unchanged 2000ms timeout', async (t) => {
  const f = fixture();
  let healthCalls = 0;
  _setFetchForTest(async () => {
    healthCalls++;
    return new Promise(() => {});
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finished = false;
  const pending = runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming }).catch(
    (error) => {
      finished = true;
      return error;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.advance(1999);
  t.mock.timers.tick(1999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  f.advance(1);
  t.mock.timers.tick(1);
  const error = await pending;
  assert.match(String(error), /ACTION_CONTEXT_CHANGED/);
  assert.deepEqual(
    f.events
      .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
      .map((e) => [e.ms, e.readinessReason, e.healthDetail, e.readinessExceptionStage]),
    [[2000, 'health', 'abort', 'fetch']],
  );
  assert.equal(healthCalls, 1);
  assert.equal(f.requests.length, 0);
});
