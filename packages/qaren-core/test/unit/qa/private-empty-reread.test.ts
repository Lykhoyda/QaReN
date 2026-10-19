import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  captureScreen,
  NativeCaptureError,
  type NativeObservation,
} from '../../../dist/qa/capture.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import { unwrap } from '../../../dist/qa/adapt.js';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  getFastRunnerState,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  getPluginVersion,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
} from '../../../dist/runners/protocol.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

function emptyCapture(): NativeObservation {
  return {
    nodes: [],
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotVerdict: {
      state: 'degraded',
      nodeCount: 0,
      refMapUpdated: false,
      reasons: ['empty-capture'],
    },
  };
}

function clock(t: TestContext) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return {
    now: () => now,
    elapse(ms: number) {
      now += ms;
    },
    async advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    },
  };
}

test('private capture re-reads a transitional empty snapshot and admits only the populated read', async (t) => {
  const time = clock(t);
  const reads: number[] = [];
  let reactReads = 0;
  const result = captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    now: time.now,
    native: async (budget) => {
      reads.push(time.now());
      if (reads.length === 1) return emptyCapture();
      const populated = nativeCapture();
      populated.presenceCapture.appliedBudgetMs = budget;
      return populated;
    },
    react: async () => {
      reactReads++;
      return {};
    },
  }).catch((error: Error) => error);
  await nextTurn();
  await time.advance(499);
  assert.deepEqual(reads, [0]);
  await time.advance(1);
  const screen = await result;
  assert.ok(!(screen instanceof Error), String(screen));
  assert.deepEqual(reads, [0, 500]);
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.coverage?.native, 'complete');
  assert.ok(screen.elements.some((element) => element.label === 'Save'));
  assert.equal(reactReads, 1);
});

test('a persistently empty private capture refuses unchanged after the existing settle budget', async (t) => {
  const time = clock(t);
  const reads: number[] = [];
  let finished = false;
  const result = captureScreen({
    requirePrivateInputs: true,
    now: time.now,
    native: async (budget) => {
      reads.push(time.now());
      assert.ok(budget <= (reads.length === 1 ? 20_000 : 6_000 - time.now()));
      return emptyCapture();
    },
    react: async () => ({}),
  }).catch((error: Error) => {
    finished = true;
    return error;
  });
  await nextTurn();
  for (let poll = 0; poll < 11; poll++) await time.advance(500);
  assert.equal(finished, false);
  await time.advance(499);
  assert.equal(finished, false);
  await time.advance(1);
  const error = await result;
  assert.ok(error instanceof NativeSnapshotIncomplete);
  assert.equal(error.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
  assert.equal(
    error.message,
    'Private input capture could not be established safely. The native snapshot was incomplete (nodes=0; causes=verdict=degraded,ref-map-not-updated,reason=empty-capture,node-count-mismatch).',
  );
  assert.equal(reads.length, 12);
  assert.equal(reads.at(-1), 5_500);
});

test('empty re-reads share the total capture budget with the first native read', async (t) => {
  const time = clock(t);
  const reads: number[] = [];
  const budgets: number[] = [];
  const result = captureScreen({
    requirePrivateInputs: true,
    now: time.now,
    native: async (budget) => {
      reads.push(time.now());
      budgets.push(budget);
      if (reads.length === 1) time.elapse(20_900);
      return emptyCapture();
    },
    react: async () => ({}),
  }).catch((error: Error) => error);
  await nextTurn();
  await time.advance(500);
  await time.advance(500);
  await time.advance(99);
  assert.deepEqual(reads, [0, 21_400, 21_900]);
  await time.advance(1);
  assert.ok((await result) instanceof NativeSnapshotIncomplete);
  assert.deepEqual(budgets, [20_000, 600, 100]);
  assert.equal(time.now(), 22_000);
});

test('private capture refuses other incomplete snapshots immediately without polling', async (t) => {
  const time = clock(t);
  const empty = emptyCapture();
  const verdict = {
    state: 'degraded',
    nodeCount: 0,
    refMapUpdated: false,
    reasons: ['empty-capture'],
  };
  const nonempty = nativeCapture();
  const cases: NativeObservation[] = [
    { ...nonempty, snapshotVerdict: { ...nonempty.snapshotVerdict, state: 'degraded' } },
    { ...empty, truncated: true },
    { ...empty, normalizationDroppedNodes: 1 },
    { ...empty, normalizationDroppedNodes: undefined },
    { ...empty, truncated: undefined },
    { ...empty, nodes: undefined },
    { ...empty, snapshotVerdict: { ...verdict, state: 'failed' } },
    { ...empty, snapshotVerdict: { ...verdict, nodeCount: 1 } },
    { ...empty, snapshotVerdict: { ...verdict, refMapUpdated: undefined } },
    { ...empty, snapshotVerdict: { ...verdict, reasons: [] } },
    {
      ...empty,
      snapshotVerdict: { ...verdict, reasons: ['empty-capture', 'snapshot-ref-freshness-unknown'] },
    },
  ];
  for (const source of cases) {
    let reads = 0;
    await assert.rejects(
      captureScreen({
        requirePrivateInputs: true,
        now: time.now,
        native: async () => {
          reads++;
          return source;
        },
        react: async () => ({}),
      }),
      NativeSnapshotIncomplete,
    );
    assert.equal(reads, 1);
    assert.equal(time.now(), 0);
  }
});

test('an empty retry that becomes non-empty but incomplete still refuses on that read', async (t) => {
  const time = clock(t);
  let reads = 0;
  const nonempty = nativeCapture();
  const result = captureScreen({
    requirePrivateInputs: true,
    now: time.now,
    native: async () => (++reads === 1 ? emptyCapture() : { ...nonempty, truncated: true }),
    react: async () => ({}),
  }).catch((error: Error) => error);
  await nextTurn();
  await time.advance(500);
  const error = await result;
  assert.ok(error instanceof NativeSnapshotIncomplete);
  assert.equal(error.nodes, 2);
  assert.deepEqual(error.causes, ['truncated']);
  assert.equal(reads, 2);
});

test('ordinary empty capture retains its immediate incomplete result', async () => {
  let reads = 0;
  const screen = await captureScreen({
    native: async () => {
      reads++;
      return emptyCapture();
    },
    react: async () => ({}),
  });
  assert.equal(reads, 1);
  assert.equal(screen.captureCoverage?.native, 'incomplete');
});

test('canonical-empty reread reaches a second snapshot only when its real readiness probe is healthy', async (t) => {
  for (const mode of ['healthy', 'body', 'exception']) {
    const unhealthy = mode !== 'healthy';
    for (const observer of ['absent', 'present', 'throwing'] as const) {
      await t.test(`${mode} second health, ${observer} diagnostics`, async (t) => {
        const time = clock(t);
        clearRefMap();
        _setFastRunnerStateForTest({
          port: 12345,
          pid: process.pid,
          deviceId: 'qa-device',
          bundleId: 'com.test',
          startedAt: 'now',
        });
        const state = getFastRunnerState();
        t.after(() => {
          _setFetchForTest(fetch);
          _setFastRunnerStateForTest(null);
          clearRefMap();
        });
        let healthCalls = 0;
        const commands: string[] = [];
        const events: TimingEvent[] = [];
        let reactCalls = 0;
        const observe =
          observer === 'absent'
            ? undefined
            : (event: TimingEvent) => {
                if (observer === 'throwing') throw new Error('PRIVATE-sink');
                events.push(event);
              };
        _setFetchForTest(async (url, init) => {
          if (String(url).endsWith('/health')) {
            healthCalls++;
            if (mode === 'exception' && healthCalls === 2)
              throw Object.assign(new Error('PRIVATE'), { code: 'ECONNREFUSED' });
            return Response.json(
              unhealthy && healthCalls === 2
                ? { ok: false, reason: 'wedged' }
                : {
                    ok: true,
                    protocolVersion: 2,
                    runnerVersion: getPluginVersion(),
                    commands: REQUIRED_IOS_COMMANDS,
                    capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
                  },
            );
          }
          commands.push(JSON.parse(String(init?.body)).command);
          return Response.json({
            ok: true,
            v: 2,
            data:
              commands.length === 1
                ? {
                    nodes: [],
                    truncated: false,
                    keyboardVisible: false,
                    snapshotGeneration: 7,
                  }
                : nativeCapture(),
          });
        });
        const pending = captureScreen({
          requirePrivateInputs: true,
          appId: 'com.test',
          now: time.now,
          timing: observe,
          native: async () => {
            const result = unwrap<NativeObservation>(
              await runIOS({
                command: 'snapshot',
                qaReadOnly: true,
                bundleId: 'com.test',
                deviceId: 'qa-device',
                ...(observe ? { qaTiming: { now: time.now, observe } } : {}),
              }),
            );
            return { ...result.data, snapshotVerdict: result.meta?.snapshotVerdict };
          },
          react: async () => {
            reactCalls++;
            return {};
          },
        }).catch((error: Error) => error);
        await nextTurn();
        await time.advance(499);
        assert.equal(healthCalls, 1);
        assert.deepEqual(commands, ['snapshot']);
        await time.advance(1);
        const result = await pending;
        if (unhealthy) {
          assert.ok(result instanceof NativeCaptureError);
          assert.equal(result.code, 'NATIVE_CAPTURE_UNAVAILABLE');
        } else {
          assert.ok(!(result instanceof Error), String(result));
          assert.equal(result.captureCoverage?.native, 'complete');
        }
        assert.equal(healthCalls, 2);
        assert.deepEqual(commands, unhealthy ? ['snapshot'] : ['snapshot', 'snapshot']);
        assert.equal(reactCalls, unhealthy ? 0 : 1);
        assert.equal(time.now(), 500);
        assert.equal(getFastRunnerState(), state);
        if (observer === 'present') {
          assert.deepEqual(
            events
              .filter((e) => e.stage === 'native-readiness' && e.edge === 'end')
              .map((e) => [
                e.count,
                e.outcome,
                e.readinessReason,
                e.readinessExceptionStage,
                e.readinessExceptionKind,
              ]),
            [
              [1, 'ok', 'alive', undefined, undefined],
              [
                1,
                unhealthy ? 'failed' : 'ok',
                mode === 'exception' ? 'probe-exception' : unhealthy ? 'health-wedged' : 'alive',
                mode === 'exception' ? 'fetch' : undefined,
                mode === 'exception' ? 'connection-refused' : undefined,
              ],
            ],
          );
        }
        assert.ok(!JSON.stringify(events).includes('PRIVATE'));
      });
    }
  }
});
