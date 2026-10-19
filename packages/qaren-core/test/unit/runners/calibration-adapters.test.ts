import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, test } from 'node:test';
import {
  _setFastRunnerStateForTest,
  getFastRunnerState,
  _setFetchForTest,
  _setCapabilitiesForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { withCancellation } from '../../../dist/domain/cancellation.js';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
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
  let healthBodyReads = 0;
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
      healthCalls++;
      const body = options.health ? options.health(reply, healthCalls) : reply;
      const response = body instanceof Response ? body : Response.json(body);
      const json = response.json.bind(response);
      response.json = async () => {
        healthBodyReads++;
        return json();
      };
      return response;
    }
    requests.push(JSON.parse(String(init?.body)));
    now += 7;
    if (options.transportFailure || (options.recoverReply && requests.length === 1))
      throw new Error('PRIVATE-transport');
    const request = requests.at(-1)!;
    const data =
      request.command === 'status'
        ? { commandId: request.commandId, state: 'completed' }
        : nativeCapture();
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
    healthCalls: () => healthCalls,
    healthBodyReads: () => healthBodyReads,
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
        .map((e) => [e.count, e.ms, e.outcome]),
      platformPresence
        ? [
            [1, 3, 'ok'],
            [2, 3, 'ok'],
          ]
        : [[1, 3, 'ok']],
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

test('absent, present and throwing diagnostics preserve both adapters and refusal counts', async () => {
  for (const platformPresence of [false, true]) {
    for (const unhealthy of [false, true]) {
      const outcomes: unknown[] = [];
      for (const observer of ['absent', 'present', 'throwing']) {
        const f = fixture(unhealthy ? { health: () => ({ ok: false, reason: 'PRIVATE' }) } : {});
        if (observer === 'throwing')
          f.qaTiming.observe = () => {
            throw new Error('PRIVATE-sink');
          };
        const call = runIOS({
          command: 'snapshot',
          qaReadOnly: true,
          platformPresence,
          presenceBudgetMs: 20_000,
          bundleId: 'com.test',
          deviceId: 'qa-device',
          ...(observer === 'absent' ? {} : { qaTiming: f.qaTiming }),
        });
        if (unhealthy) await assert.rejects(call, /ACTION_CONTEXT_CHANGED/);
        else outcomes.push(await call);
        assert.equal(f.healthCalls(), !unhealthy && platformPresence ? 2 : 1);
        assert.equal(f.requests.length, unhealthy ? 0 : 1);
        assert.ok(
          f.requests.every(
            (request) => request.command === 'snapshot' && request.qaReadOnly === true,
          ),
        );
      }
      if (!unhealthy) {
        assert.deepEqual(outcomes[0], outcomes[1]);
        assert.deepEqual(outcomes[0], outcomes[2]);
      }
    }
  }
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

test('default health parsing emits a finite readiness end reason without changing probe policy', async () => {
  const cases: [string, (reply: Record<string, unknown>) => unknown, number?][] = [
    ['alive', (reply) => reply],
    ['health-unauthorized', () => new Response('PRIVATE', { status: 401 }), 0],
    ['health-http-rejected', () => new Response('PRIVATE', { status: 503 }), 0],
    ['health-http-rejected', (reply) => Response.json(reply, { status: 201 })],
    ['health-body-unreadable', () => new Response('{PRIVATE')],
    ['health-body-unreadable', () => null],
    [
      'health-body-unreadable',
      () => {
        const response = Response.json({});
        response.json = async () => {
          throw new Error('PRIVATE-body');
        };
        return response;
      },
    ],
    ['health-wedged', () => ({ ok: false, reason: 'wedged' })],
    ['health-body-not-ok', () => ({ ok: false, reason: 'PRIVATE' })],
    ['health-body-not-ok', () => ({ reason: 'wedged' })],
    ['health-body-not-ok', () => ({ ok: 'false', reason: 'wedged' })],
    ['authority-mismatch', (reply) => ({ ...reply, sessionId: 'PRIVATE-other' })],
    [
      'probe-exception',
      () => {
        throw new Error('PRIVATE-fetch');
      },
    ],
  ];
  for (const [reason, health, bodyReads = 1] of cases) {
    for (const platformPresence of [false, true]) {
      const f = fixture({ health });
      const call = runIOS({
        command: 'snapshot',
        qaReadOnly: true,
        platformPresence,
        presenceBudgetMs: 20_000,
        bundleId: 'com.test',
        deviceId: 'qa-device',
        qaTiming: f.qaTiming,
      });
      if (reason === 'alive') assert.equal((await call).isError, undefined);
      else await assert.rejects(call, /ACTION_CONTEXT_CHANGED/);
      assert.deepEqual(
        f.events
          .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
          .map((e) => [e.count, e.outcome, e.readinessReason]),
        reason === 'alive' && platformPresence
          ? [
              [1, 'ok', 'alive'],
              [2, 'ok', 'alive'],
            ]
          : [[1, reason === 'alive' ? 'ok' : 'failed', reason]],
      );
      assert.equal(f.healthCalls(), reason === 'alive' && platformPresence ? 2 : 1);
      assert.equal(
        f.healthBodyReads(),
        reason === 'probe-exception'
          ? 0
          : bodyReads * (reason === 'alive' && platformPresence ? 2 : 1),
      );
      assert.equal(f.requests.length, reason === 'alive' ? 1 : 0);
      assert.ok(
        f.events.filter((e) => e.edge !== 'end').every((e) => e.readinessReason === undefined),
      );
      if (reason !== 'probe-exception')
        assert.ok(
          f.events.every(
            (e) =>
              e.readinessExceptionStage === undefined && e.readinessExceptionKind === undefined,
          ),
        );
      assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
    }
  }
});

test('readiness end diagnoses ambient cancellation and preserves the original thrown object', async () => {
  const controller = new AbortController();
  const original = new Error('PRIVATE-cancel');
  const f = fixture({
    health: () => {
      controller.abort(original);
      throw new Error('PRIVATE-fetch');
    },
  });
  await assert.rejects(
    withCancellation(controller.signal, () =>
      runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming }),
    ),
    (caught) => caught === original,
  );
  assert.deepEqual(
    f.events
      .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
      .map((e) => [e.outcome, e.readinessReason]),
    [['failed', 'cancelled-context']],
  );
  assert.equal(f.healthCalls(), 1);
  assert.equal(f.requests.length, 0);
  assert.ok(
    f.events.every(
      (e) => e.readinessExceptionStage === undefined && e.readinessExceptionKind === undefined,
    ),
  );
});

test('an uncancelled thrown probe keeps its identity even when named AbortError', async () => {
  const f = fixture();
  const original = new Error('PRIVATE-probe');
  original.name = 'AbortError';
  Object.defineProperty(getFastRunnerState()!, 'pid', {
    get: () => {
      throw original;
    },
  });
  await assert.rejects(
    runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming }),
    (caught) => caught === original,
  );
  assert.deepEqual(
    f.events
      .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
      .map((e) => [e.outcome, e.readinessReason]),
    [['failed', 'probe-threw']],
  );
  assert.equal(f.healthCalls(), 0);
  assert.equal(f.requests.length, 0);
});

test('default probe reports only bounded own data codes and never invokes error accessors', async () => {
  const codes: [string, string][] = [
    ['ECONNREFUSED', 'connection-refused'],
    ['ECONNRESET', 'connection-reset'],
    ['UND_ERR_SOCKET', 'socket-closed'],
    ['ETIMEDOUT', 'transport-timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'transport-timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'transport-timeout'],
    ['HPE_INVALID_CONSTANT', 'http-protocol'],
    ['HPE_INVALID_HEADER_TOKEN', 'http-protocol'],
    ['HPE_INVALID_CONTENT_LENGTH', 'http-protocol'],
    ['HPE_UNEXPECTED_CONTENT_LENGTH', 'http-protocol'],
    ['HPE_INVALID_CHUNK_SIZE', 'http-protocol'],
  ];
  let getterCalls = 0;
  let descriptorCalls = 0;
  const errors: [unknown, string][] = codes.flatMap(([code, kind]) => [
    [{ code, message: 'PRIVATE', cause: undefined }, kind],
    [{ cause: { code, message: 'PRIVATE' } }, kind],
  ]);
  const accessor = {
    get code() {
      getterCalls++;
      throw new Error('PRIVATE');
    },
    get cause() {
      getterCalls++;
      throw new Error('PRIVATE');
    },
  };
  errors.push(
    [new Error('PRIVATE'), 'other'],
    ['PRIVATE', 'other'],
    [null, 'other'],
    [Object.assign(new Error('PRIVATE'), { name: 'AbortError' }), 'other'],
    [Object.create({ code: 'ECONNREFUSED' }), 'other'],
    [accessor, 'other'],
    [
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            descriptorCalls++;
            throw Error('PRIVATE');
          },
        },
      ),
      'other',
    ],
    [
      {
        cause: new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              descriptorCalls++;
              throw Error('PRIVATE');
            },
          },
        ),
      },
      'other',
    ],
    [{ code: 'ECONNRESET', cause: { code: 'ECONNREFUSED' } }, 'other'],
    [{ code: 'ETIMEDOUT', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'other'],
    [{ code: 'PRIVATE', cause: { code: 'ECONNREFUSED' } }, 'connection-refused'],
    [{ code: 'ECONNRESET', cause: { code: 'ECONNRESET' } }, 'connection-reset'],
    [{ cause: { cause: { code: 'ECONNREFUSED' } } }, 'other'],
  );
  for (const [error, kind] of errors) {
    for (const observer of ['absent', 'present', 'throwing']) {
      const f = fixture({
        health: () => {
          throw error;
        },
      });
      if (observer === 'throwing')
        f.qaTiming.observe = () => {
          throw Error('PRIVATE-observer');
        };
      await assert.rejects(
        runIOS({
          command: 'snapshot',
          qaReadOnly: true,
          ...(observer === 'absent' ? {} : { qaTiming: f.qaTiming }),
        }),
        /ACTION_CONTEXT_CHANGED/,
      );
      if (observer === 'present') {
        assert.deepEqual(
          f.events
            .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
            .map((e) => [e.readinessReason, e.readinessExceptionStage, e.readinessExceptionKind]),
          [['probe-exception', 'fetch', kind]],
        );
        assert.ok(!/PRIVATE|ECONN|UND_ERR|HPE_/.test(JSON.stringify(f.events)));
      }
      assert.deepEqual([f.healthCalls(), f.healthBodyReads(), f.requests.length], [1, 0, 0]);
    }
  }
  assert.equal(getterCalls, 0);
  assert.equal(descriptorCalls, 6, 'one guarded descriptor failure per proxy and observation mode');
});

test('default probe distinguishes setup, response access and cleanup exceptions at their existing seams', async (t) => {
  for (const stage of ['http-setup', 'response-access', 'http-cleanup']) {
    const original = Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' });
    const f = fixture({
      health: (reply) => {
        const response = Response.json(reply);
        if (stage === 'response-access')
          Object.defineProperty(response, 'ok', {
            get: () => {
              throw original;
            },
          });
        return response;
      },
    });
    if (stage === 'http-setup')
      Object.defineProperty(getFastRunnerState()!, 'capability', {
        get: () => {
          throw original;
        },
      });
    const clear = globalThis.clearTimeout;
    const mockedClear =
      stage === 'http-cleanup'
        ? t.mock.method(globalThis, 'clearTimeout', (handle) => {
            clear(handle);
            throw original;
          })
        : undefined;
    try {
      await assert.rejects(
        runIOS({ command: 'snapshot', qaReadOnly: true, qaTiming: f.qaTiming }),
        /ACTION_CONTEXT_CHANGED/,
      );
    } finally {
      mockedClear?.mock.restore();
    }
    assert.deepEqual(
      f.events
        .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
        .map((e) => [e.readinessReason, e.readinessExceptionStage, e.readinessExceptionKind]),
      [['probe-exception', stage, 'connection-reset']],
    );
    assert.equal(f.healthCalls(), stage === 'http-setup' ? 0 : 1);
    assert.equal(f.healthBodyReads(), stage === 'http-cleanup' ? 1 : 0);
    assert.equal(f.requests.length, 0);
  }
});

test('the existing local probe controller is classified at its unchanged 2000ms timeout', async (t) => {
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
  await nextTurn();
  f.advance(1999);
  t.mock.timers.tick(1999);
  await nextTurn();
  assert.equal(finished, false);
  f.advance(1);
  t.mock.timers.tick(1);
  const error = await pending;
  assert.match(String(error), /ACTION_CONTEXT_CHANGED/);
  assert.deepEqual(
    f.events
      .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
      .map((e) => [e.ms, e.readinessReason, e.readinessExceptionStage, e.readinessExceptionKind]),
    [[2000, 'probe-exception', 'fetch', 'local-signal-aborted']],
  );
  assert.equal(healthCalls, 1);
  assert.equal(f.requests.length, 0);
});
