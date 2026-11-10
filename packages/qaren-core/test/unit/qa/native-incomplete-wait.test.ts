import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { CaptureDeadline, captureScreen } from '../../../dist/qa/capture.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import {
  NativeSnapshotIncomplete,
  ReactCaptureIncomplete,
} from '../../../dist/qa/private-input.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan, WAIT_BUDGET_MS } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const causes = ['verdict=degraded', 'ref-map-not-updated', 'retry-deadline'];
const incomplete = () => new NativeSnapshotIncomplete(121, causes);
const toast = () => screen([element('@toast', 'Request failed', { kind: 'text' })]);
const target = () => screen([element('@x', 'x', { testID: 'x' })]);

test('T1: an always-incomplete native Wait uses its deadline and names the observation failure', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  let reads = 0;
  f.deps.captureScreen = async () => {
    reads++;
    throw incomplete();
  };
  const result = await runPlan(parsePlan('1. Wait for "x"').blocks!, f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal('code' in result && result.code, 'NATIVE_SNAPSHOT_INCOMPLETE');
  assert.equal(f.deps.now(), WAIT_BUDGET_MS);
  assert.ok(reads > 1);
  assert.equal(
    'message' in result && result.message,
    `The native snapshot was incomplete (nodes=121; causes=${causes.join(',')}); read ${reads} times over ${WAIT_BUDGET_MS} ms.`,
  );
  assert.equal(result.steps.at(-1)?.block, 'private-input-capture');
  assert.equal(result.videoPublication, 'unknown');
  assert.equal(result.nonStrictPublication, undefined);
  assert.deepEqual(f.actions, []);
});

test('T2: a recovered native Wait with no target reports the last screen and keeps media unknown', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  let reads = 0;
  f.deps.captureScreen = async () => {
    if (++reads <= 2) throw incomplete();
    return toast();
  };
  let shots = 0;
  f.deps.screenshot = async () => {
    shots++;
    return 'failure.png';
  };
  const result = await runPlan(parsePlan('1. Wait for "x"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.subreason, 'absent');
  assert.match(result.failure?.seen ?? '', /did not appear within 15s/);
  assert.match(result.failure?.seen ?? '', /Request failed/);
  assert.equal(f.deps.now(), WAIT_BUDGET_MS);
  assert.equal(result.videoPublication, 'unknown');
  assert.equal(result.nonStrictPublication, undefined);
  assert.equal(shots, 0);
  assert.equal(result.failure?.screenshot, undefined);
  assert.ok(result.steps.every((step) => step.screenshot === undefined));
  assert.ok(f.rows.every((row) => row.screenshot === undefined));
  assert.deepEqual(f.actions, []);
});

test('an incomplete recovery read preserves observed Wait absence after the deadline', async () => {
  for (const policy of ['strict', 'non-strict', 'undeclared'] as const) {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal wait is model-free')),
    );
    f.deps.videoPolicy = policy;
    f.deps.hideDevMenu = async () => assert.fail('no overlay was observed');
    let reads = 0;
    let completeReads = 0;
    let recoveryReads = 0;
    f.deps.captureScreen = async (options) => {
      if (++reads === 1) throw incomplete();
      if (options?.platformPresence) {
        recoveryReads++;
        assert.equal(f.deps.now(), WAIT_BUDGET_MS);
        throw incomplete();
      }
      completeReads++;
      return toast();
    };
    f.deps.screenshot = async () => assert.fail('incomplete reads withhold screenshots');
    const result = await runPlan(parsePlan('1. Wait for "x"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL', policy);
    assert.equal(result.failure?.subreason, 'absent');
    assert.match(result.failure?.seen ?? '', /"x" did not appear within 15s/);
    assert.match(result.failure?.seen ?? '', /Request failed/);
    assert.ok(completeReads >= 2);
    assert.equal(recoveryReads, 1);
    assert.equal(f.deps.now(), WAIT_BUDGET_MS);
    assert.equal(result.videoPublication, 'unknown', policy);
    assert.equal(result.nonStrictPublication, undefined);
    assert.equal(result.failure?.screenshot, undefined);
    assert.ok(result.steps.every((step) => step.screenshot === undefined));
    assert.ok(f.rows.every((row) => row.screenshot === undefined));
    assert.deepEqual(f.actions, []);
  }
});

test('T3b: the visibility probe absorbs an incomplete recapture', async () => {
  const judge = scriptedJudge((_, index) => ({
    visibility_1: { type: 'noul', noul: index === 0 ? 0.5 : 0.99 },
  }));
  const f = walker([], judge);
  let reads = 0;
  f.deps.captureScreen = async () => {
    if (++reads === 2) throw incomplete();
    return target();
  };
  const result = await runPlan(parsePlan('1. Wait for the x button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(reads, 3);
  assert.equal(judge.requests.length, 2);
  assert.equal(result.videoPublication, 'unknown');
});

test('a phrase Wait admits the completed read after more than 22 seconds of incompleteness', async () => {
  const judge = scriptedJudge(() => ({ visibility_1: { type: 'noul', noul: 0.99 } }));
  const f = walker([], judge);
  let reads = 0;
  f.deps.captureScreen = async () => {
    reads++;
    if (f.deps.now() < 23_000) throw incomplete();
    return target();
  };
  const result = await runPlan(parsePlan('1. Wait for the x button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.ok(reads > 1);
  assert.equal(f.deps.now(), 23_000);
  assert.equal(result.videoPublication, 'unknown');
  assert.equal(result.nonStrictPublication, undefined);
  assert.deepEqual(f.actions, []);
});

test('T3b: an incomplete read takes precedence over a later capture deadline', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  let reads = 0;
  f.deps.captureScreen = async (options) => {
    if (++reads === 1) throw incomplete();
    await f.deps.sleep(options!.budgetMs!);
    throw new CaptureDeadline();
  };
  const result = await runPlan(parsePlan('1. Wait for "x"').blocks!, f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal('code' in result && result.code, 'NATIVE_SNAPSHOT_INCOMPLETE');
  assert.match(result.failure?.seen ?? '', /read 2 times over 15000 ms/);
  assert.equal(f.deps.now(), WAIT_BUDGET_MS);
  assert.equal(reads, 2);
});

test('T3b: cancellation stops the incomplete-read loop before another read', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  let reads = 0;
  f.deps.captureScreen = async () => {
    reads++;
    throw incomplete();
  };
  f.deps.cancelled = () => f.deps.now() > 0;
  const result = await runPlan(parsePlan('1. Wait for "x"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /RUN_CANCELLED/);
  assert.equal(reads, 1);
  assert.ok(f.deps.now() < WAIT_BUDGET_MS);
  assert.equal(result.videoPublication, 'unknown');
});

test('T3d: native refusal fields are rebuilt without contaminated text or counters', async () => {
  for (const counters of [
    [2, 50],
    [-1, 0.5],
    [Infinity, Number.MAX_SAFE_INTEGER + 1],
  ]) {
    const error = incomplete();
    error.message = 'synthetic-app-text-canary';
    Reflect.set(error, 'code', 'synthetic-app-text-canary');
    Reflect.set(error, 'nodes', -1);
    Reflect.set(error, 'causes', [...causes, 'synthetic-app-text-canary']);
    Reflect.set(error, 'reads', counters[0]);
    Reflect.set(error, 'elapsedMs', counters[1]);
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('capture refuses before judgment')),
    );
    f.deps.captureScreen = async () => {
      throw error;
    };
    const result = await runPlan(parsePlan('1. Tap "x"').blocks!, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal('code' in result && result.code, 'NATIVE_SNAPSHOT_INCOMPLETE');
    assert.equal(
      'message' in result && result.message,
      new NativeSnapshotIncomplete(0, causes).withReads(counters[0], counters[1]).message,
    );
    assert.doesNotMatch(JSON.stringify({ result, rows: f.rows }), /synthetic-app-text-canary/);
  }
});

test('T4: Fill with a declared input refuses native incompleteness immediately', async () => {
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs({ FIXTURE: 'synthetic-fill' }, ['FIXTURE'], privacy);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('capture refuses before judgment')),
  );
  f.deps.privacy = privacy;
  let reads = 0;
  f.deps.captureScreen = async () => {
    reads++;
    throw incomplete();
  };
  const result = await withInputs(inputs, () =>
    runPlan(parsePlan('1. Fill "x" with input FIXTURE').blocks!, f.deps),
  );
  assert.equal(result.verdict, 'REFUSED');
  assert.equal('code' in result && result.code, 'NATIVE_SNAPSHOT_INCOMPLETE');
  assert.equal(reads, 1);
  assert.equal(f.deps.now(), 0);
  assert.equal(result.videoPublication, 'unknown');
  assert.equal(result.nonStrictPublication, undefined);
  assert.deepEqual(f.actions, []);
});

test('T5: a React-incomplete Wait retains its privacy refusal without re-reading', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('capture refuses before judgment')),
  );
  let reads = 0;
  f.deps.captureScreen = async () => {
    reads++;
    throw new ReactCaptureIncomplete('deadline');
  };
  const result = await runPlan(parsePlan('1. Wait for "x"').blocks!, f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
  assert.equal(reads, 1);
  assert.equal(f.deps.now(), 0);
  assert.equal(result.videoPublication, 'unknown');
});

test('captureScreen preserves native incompleteness outside its generic privacy wrapper', async () => {
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [], truncated: true }),
      react: async () => ({}),
    }),
    (error) =>
      error instanceof NativeSnapshotIncomplete && error.code === 'NATIVE_SNAPSHOT_INCOMPLETE',
  );
});

test('T3: a native Wait recovers to its target with sticky unknown media under every policy', async () => {
  for (const policy of ['strict', 'non-strict', 'undeclared'] as const) {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal wait is model-free')),
    );
    f.deps.videoPolicy = policy;
    let reads = 0;
    f.deps.captureScreen = async () => {
      if (++reads === 1) throw incomplete();
      return target();
    };
    let shots = 0;
    f.deps.screenshot = async () => {
      shots++;
      return 'success.png';
    };
    const result = await runPlan(parsePlan('1. Wait for "x"\n2. Wait for "x"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', policy);
    assert.equal(result.videoPublication, 'unknown', policy);
    assert.equal(result.nonStrictPublication, undefined, policy);
    assert.equal(reads, 3);
    assert.equal(shots, 0, policy);
    assert.equal(result.steps.length, 2);
    assert.ok(
      result.steps.every((step) => step.screenshot === undefined),
      policy,
    );
    assert.ok(
      f.rows.every((row) => row.screenshot === undefined),
      policy,
    );
    assert.ok(f.deps.now() < WAIT_BUDGET_MS);
    assert.deepEqual(f.actions, []);
  }
});
