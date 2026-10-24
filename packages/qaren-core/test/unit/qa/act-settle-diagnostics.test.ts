import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { QaDispatchContext, QaDispatchError } from '../../../dist/domain/qa-dispatch.js';
import {
  runNative,
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { runInNewContext } from 'node:vm';
import { extractMutationDisposition } from '../../../dist/handlers/device-interact.js';
import { HandlerError, describeError, fillEvidence, unwrap } from '../../../dist/qa/adapt.js';
import { classifyNativeVerification } from '../../../dist/handlers/fill-verify.js';
import { isRecord } from '../../../dist/qa/questions.js';
import { recover } from '../../../dist/qa/recover.js';
import { observeTiming, type TimingContext, type TimingEvent } from '../../../dist/qa/timing.js';
import { createStop } from '../../../dist/qa/stop.js';
import type { ActResult } from '../../../dist/qa/walker.js';
import type { ToolResult } from '../../../dist/utils.js';

function fixture(throwSink = false) {
  const source = readFileSync(new URL('../../../dist/qa/walk.js', import.meta.url), 'utf8');
  const from = source.indexOf('function act(');
  const to = source.indexOf('// Attach over CDP', from);
  assert.ok(from >= 0 && to > from);
  const logs: string[] = [];
  const stop = createStop();
  // Execute the built action adapter without starting the wire, CDP, or a device session.
  const act: (
    handler: () => Promise<ToolResult>,
    proven: boolean,
    timing?: TimingContext,
  ) => Promise<ActResult> = runInNewContext(`${source.slice(from, to)}; act`, {
    observeTiming,
    QaDispatchError,
    HandlerError,
    extractMutationDisposition,
    describeError,
    fillEvidence,
    unwrap,
    isRecord,
    stop,
    log: (line: string) => {
      logs.push(line);
      if (throwSink) throw new Error('PRIVATE-log-sink');
    },
  });
  return { act, logs, stop };
}

function result(meta?: unknown, ok = true): ToolResult {
  return {
    ...(ok ? {} : { isError: true }),
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok,
          data: { label: 'PRIVATE-data', value: 'PRIVATE-input' },
          ...(ok ? {} : { code: 'TEST_FAILURE', error: 'handler failed' }),
          meta,
        }),
      },
    ],
  };
}

const unknown = {
  method: 'unknown',
  settled: 'unknown',
  hierarchyChanged: 'unknown',
  ms: 'unknown',
};

test('act exposes only existing allowlisted settle metadata before discarding it', async () => {
  for (const method of ['screen-static', 'snapshot-eq', 'window-gate', 'timeout']) {
    const f = fixture();
    let calls = 0;
    const outcome = await f.act(async () => {
      calls++;
      return result({
        settle: {
          method,
          settled: method !== 'timeout',
          hierarchyChanged: false,
          label: 'PRIVATE-label',
          hash: 'PRIVATE-hash',
        },
        timings_ms: { settle: 2513, value: 'PRIVATE-value' },
        label: 'PRIVATE-other',
      });
    }, true);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.proven, true);
    assert.equal(calls, 1);
    assert.deepEqual(f.logs, [
      `action-settle=${JSON.stringify({ method, settled: method !== 'timeout', hierarchyChanged: false, ms: 2513 })}`,
    ]);
    assert.ok(!JSON.stringify({ outcome, logs: f.logs }).includes('PRIVATE-'));
  }
});

test('missing or malformed settle metadata is unknown, never disabled or false', async () => {
  const invalid = ['PRIVATE-canary', null, [], {}, 1];
  const cases = [
    undefined,
    null,
    'PRIVATE-canary',
    [],
    {},
    ...invalid.map((settle) => ({ settle })),
    {
      settle: {
        method: 'PRIVATE-canary',
        settled: 'PRIVATE-canary',
        hierarchyChanged: 'PRIVATE-canary',
      },
      timings_ms: { settle: 'PRIVATE-canary' },
    },
    ...[-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, false, {}].map((ms) => ({
      timings_ms: { settle: ms },
    })),
  ];
  for (const meta of cases) {
    const f = fixture();
    const outcome = await f.act(async () => result(meta), false);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.proven, false);
    assert.deepEqual(f.logs, [`action-settle=${JSON.stringify(unknown)}`]);
    assert.ok(!f.logs.join('').includes('PRIVATE-'));
  }
});

test('settle reporting preserves handler errors, rejected promises, and sink failures', async () => {
  for (const throwSink of [false, true]) {
    for (const ok of [false, true]) {
      const f = fixture(throwSink);
      const outcome = await f.act(
        async () =>
          result({ settle: { method: 'timeout', settled: false }, timings_ms: { settle: 0 } }, ok),
        true,
      );
      assert.equal(outcome.ok, ok);
      assert.equal(outcome.proven, ok);
      assert.equal(outcome.error, ok ? undefined : 'TEST_FAILURE: handler failed');
      assert.deepEqual(f.logs, [
        `action-settle=${JSON.stringify({ ...unknown, method: 'timeout', settled: false, ms: 0 })}`,
      ]);
    }
    const f = fixture(throwSink);
    const outcome = await f.act(async () => {
      throw new Error('TEST_FAILURE: handler failed');
    }, false);
    assert.equal(outcome.error, 'TEST_FAILURE: handler failed');
    assert.deepEqual(f.logs, [`action-settle=${JSON.stringify(unknown)}`]);
  }
});

test('cancelled act does not dispatch or manufacture settle diagnostics', async () => {
  const f = fixture();
  f.stop.begin();
  const outcome = await f.act(async () => assert.fail('cancelled'), false);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /RUN_CANCELLED/);
  assert.deepEqual(f.logs, []);
});

test('act carries the fill evidence class of an unverified fill, never for other refusals', async () => {
  const fill = (
    native: string,
    nativeStable: boolean,
    code = 'TEXT_ENTRY_UNVERIFIED',
  ): ToolResult => ({
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code,
          error: 'device_fill typed but the retained native target could not be verified',
          meta: {
            mutation: 'possible',
            verification: classifyNativeVerification(native as never, nativeStable),
          },
        }),
      },
    ],
  });
  const cases: [ToolResult, string | undefined][] = [
    [fill('secure-masked', true), 'masked'],
    [fill('secure-masked', false), 'unavailable'],
    [fill('mismatch', true), 'mismatch'],
    [fill('secure-masked', true, 'FOCUS_TARGET_OCCLUDED'), undefined],
  ];
  for (const [toolResult, expected] of cases) {
    const outcome = await fixture().act(async () => toolResult, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.proven, false);
    assert.equal(outcome.evidence, expected);
  }
});

for (const data of [{ tapped: false }, { executed: false }, { tapped: true, executed: false }]) {
  test(`action adapter rejects non-execution ${JSON.stringify(data)}`, async () => {
    const f = fixture();
    const action = () =>
      f.act(
        async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] }),
        true,
      );
    const outcome = await action();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.proven, false);
    assert.equal(outcome.mutation, 'none');
    for (const front of ['dialog', 'dev-menu'] as const) {
      const recovery = await recover(
        { elements: [], visibleText: [], front },
        { dialog: action, hideDevMenu: action },
      );
      assert.ok(recovery && 'fail' in recovery);
    }
  });
}

test('act carries the keyboard a tap reported, on success and refusal, logged value-free', async () => {
  for (const ok of [true, false]) {
    for (const shown of [true, false]) {
      const f = fixture();
      const outcome = await f.act(async () => result({ keyboardShown: shown }, ok), false);
      assert.equal(outcome.ok, ok);
      assert.equal(outcome.keyboardShown, shown);
      assert.ok(f.logs.includes(`action-keyboard=${JSON.stringify({ shown })}`), f.logs.join());
      assert.ok(!f.logs.join('').includes('PRIVATE-'));
    }
  }
  for (const meta of [undefined, {}, { keyboardShown: 'PRIVATE-canary' }, { keyboardShown: 1 }]) {
    const f = fixture();
    const outcome = await f.act(async () => result(meta), false);
    assert.equal(outcome.keyboardShown, undefined);
    assert.deepEqual(f.logs, [`action-settle=${JSON.stringify(unknown)}`]);
  }
});

test('settle metrics survive withheld logs and preserve action outcomes when the sink throws', async () => {
  for (const throwing of [false, true]) {
    for (const ok of [false, true]) {
      const f = fixture(true);
      const events: TimingEvent[] = [];
      const outcome = await f.act(
        async () =>
          result(
            {
              settle: { method: 'timeout', settled: false, hierarchyChanged: true },
              timings_ms: { settle: 30 },
            },
            ok,
          ),
        true,
        {
          now: () => 100,
          observe: (event) => {
            events.push(event);
            if (throwing) throw Error('private-sink');
          },
        },
      );
      assert.equal(outcome.ok, ok);
      assert.deepEqual(JSON.parse(JSON.stringify(events)), [
        {
          stage: 'settle',
          edge: 'end',
          outcome: 'failed',
          at: 100,
          ms: 30,
          method: 'timeout',
          settled: false,
          hierarchyChanged: true,
        },
      ]);
    }
  }
  const events: TimingEvent[] = [];
  await fixture().act(
    async () =>
      result({
        settle: {
          method: 'private-canary',
          settled: 'private-canary',
          hierarchyChanged: 'private-canary',
        },
        timings_ms: { settle: 'private-canary' },
      }),
    true,
    { now: () => 100, observe: (event) => events.push(event) },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    {
      stage: 'settle',
      edge: 'end',
      outcome: 'unknown',
      at: 100,
      method: 'unknown',
      settled: 'unknown',
      hierarchyChanged: 'unknown',
    },
  ]);
});

test('post-settle dispatch refusal retains the measured settle metric with withheld logs', async (t) => {
  let now = 0;
  let snapshots = 0;
  const sends: string[] = [];
  const events: TimingEvent[] = [];
  t.mock.method(Date, 'now', () => now);
  setActiveSessionInMemoryForTest({
    name: 'qa',
    platform: 'ios',
    appId: 'qa.app',
    deviceId: 'qa-device',
  });
  _setFastRunnerStateForTest({
    pid: process.pid,
    port: 12345,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    capability: 'test-capability',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) {
      if (snapshots >= 2) {
        _setFastRunnerStateForTest(null);
        return Response.json({ ok: false }, { status: 503 });
      }
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: REQUIRED_IOS_FEATURES,
      });
    }
    const body = JSON.parse(String(init?.body));
    sends.push(body.command);
    if (body.command === 'snapshot') {
      snapshots++;
      now += 17;
      return Response.json({ ok: true, data: { nodes: [] } });
    }
    assert.equal(body.command, 'type');
    now += 12847;
    return Response.json({ ok: true, data: { typed: true } });
  });
  try {
    const context = new QaDispatchContext(100000, () => now);
    let thrown: unknown;
    const outcome = await fixture(true).act(
      async () => {
        try {
          return await runNative(['fill', '@field', 'private-code', '--clear-first'], {
            qaContext: context,
            qaTiming: { now: () => now, observe: (event) => events.push(event) },
            focusedType: true,
            focusedProof: async () => true,
          });
        } catch (error) {
          thrown = error;
          throw error;
        }
      },
      true,
      { now: () => 900000, observe: (event) => events.push(event) },
    );
    assert.equal(outcome.ok, false);
    assert.equal(context.authorizations, 2);
    assert.equal(thrown, context.refusal);
    assert.throws(
      () => context.assertComplete(),
      (error) => error === thrown,
    );
    assert.equal(context.authorizations, 2);
    assert.equal(context.refusalDiagnostic?.stage, 'settle');
    assert.equal(context.refusalDiagnostic?.nativeCode, null);
    assert.equal(context.refusalDiagnostic?.mutating, true);
    assert.deepEqual(sends, ['type', 'type', 'snapshot', 'snapshot']);
    assert.deepEqual(
      events.filter((event) => event.stage === 'settle'),
      [
        {
          stage: 'settle',
          edge: 'end',
          outcome: 'ok',
          at: 900000,
          ms: 34,
          method: 'snapshot-eq',
          settled: true,
          hierarchyChanged: 'unknown',
        },
      ],
    );
    assert.ok(!JSON.stringify(events).includes('private-code'));
  } finally {
    _setFastRunnerStateForTest(null);
    _setFetchForTest(fetch);
    resetActiveSessionInMemoryForTest();
  }
});

test('retained settle metadata admits only measured finite facts without replacing a refusal', async () => {
  for (const ms of [0, 12.5, Number.MAX_SAFE_INTEGER]) {
    for (const throwing of [false, true]) {
      const secret = 'private/settle-canary';
      const error = new QaDispatchError('ACTION_CONTEXT_CHANGED');
      error.retainSettle({
        settle: {
          method: 'timeout',
          settled: false,
          hierarchyChanged: true,
          label: secret,
          hash: secret,
        },
        timings_ms: { settle: ms, text: secret },
        text: secret,
      });
      const events: TimingEvent[] = [];
      const outcome = await fixture(true).act(
        async () => {
          throw error;
        },
        true,
        {
          now: () => 900000,
          observe: (event) => {
            events.push(event);
            if (throwing) throw Error(secret);
          },
        },
      );
      assert.equal(outcome.ok, false);
      assert.equal(outcome.mutation, 'possible');
      assert.deepEqual(events, [
        {
          stage: 'settle',
          edge: 'end',
          outcome: 'failed',
          at: 900000,
          ms,
          method: 'timeout',
          settled: false,
          hierarchyChanged: true,
        },
      ]);
      for (const token of [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('hex'),
        Buffer.from(secret).toString('base64'),
      ])
        assert.ok(!JSON.stringify({ events, meta: error.settleMeta }).includes(token));
    }
  }
  for (const ms of [
    undefined,
    null,
    'private-canary',
    -1,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    true,
    {},
    [],
  ]) {
    const error = new QaDispatchError('ACTION_CONTEXT_CHANGED');
    error.retainSettle({
      settle: { method: 'timeout', settled: false },
      timings_ms: { settle: ms },
    });
    assert.equal(error.settleMeta, undefined);
  }
  const error = new QaDispatchError('ACTION_CONTEXT_CHANGED');
  error.retainSettle({
    settle: {
      method: 'private-canary',
      settled: 'private-canary',
      hierarchyChanged: 'private-canary',
    },
    timings_ms: { settle: 0 },
  });
  assert.deepEqual(error.settleMeta, {
    settle: { method: null, settled: null, hierarchyChanged: null },
    timings_ms: { settle: 0 },
  });
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, 'timings_ms', {
    get() {
      getterCalls++;
      throw Error('private-canary');
    },
  });
  const unmeasured = new QaDispatchError('ACTION_CONTEXT_CHANGED');
  unmeasured.retainSettle(hostile);
  assert.equal(getterCalls, 0);
  assert.equal(unmeasured.settleMeta, undefined);
});
