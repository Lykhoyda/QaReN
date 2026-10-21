import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  captureScreen,
  NativeCaptureError,
  type NativeObservation,
} from '../../../dist/qa/capture.js';
import { HandlerError } from '../../../dist/qa/adapt.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
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

test('private capture does not retry runner failures outside relaunch recovery', async (t) => {
  const time = clock(t);
  for (const error of [
    new HandlerError('RN_FAST_RUNNER_DOWN', 'unavailable'),
    new HandlerError('RUNNER_OWNERSHIP_MISMATCH', 'unavailable', { runnerRelaunch: true }),
    new HandlerError('RN_FAST_RUNNER_STALE', 'unavailable', { runnerRelaunch: true }),
  ]) {
    let reads = 0;
    await assert.rejects(
      captureScreen({
        requirePrivateInputs: true,
        now: time.now,
        native: async () => {
          reads++;
          throw error;
        },
        react: async () => ({}),
      }),
      NativeCaptureError,
    );
    assert.equal(reads, 1);
    assert.equal(time.now(), 0);
  }
});

test('reader relaunch retries share the total capture deadline', async (t) => {
  const time = clock(t);
  const budgets: number[] = [];
  const result = captureScreen({
    requirePrivateInputs: true,
    now: time.now,
    native: async (budget) => {
      budgets.push(budget);
      if (budgets.length === 1) time.elapse(20_900);
      throw new HandlerError('RN_FAST_RUNNER_DOWN', 'unavailable', {
        runnerRelaunch: true,
      });
    },
    react: async () => ({}),
  }).catch((error: Error) => error);
  await nextTurn();
  await time.advance(500);
  await time.advance(500);
  await time.advance(100);
  assert.ok((await result) instanceof NativeCaptureError);
  assert.deepEqual(budgets, [20_000, 600, 100]);
  assert.equal(time.now(), 22_000);
});
