import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createTimingObserver, formatTimingEvent } from '../../../dist/qa/timing.js';
import { readMetrics } from '../../calibration/analyze.ts';
import type { QaDispatchRefusal } from '../../../dist/domain/qa-dispatch.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

const faults = {
  expired: { endedUptimeMs: 20_100 },
  'wrong-budget': { appliedBudgetMs: 19_999 },
  'missing-budget': { appliedBudgetMs: undefined },
  'missing-version': { version: undefined },
  'missing-capture': {},
  'old-version': { version: 1 },
  incomplete: { complete: false },
};

function fixture(fault: keyof typeof faults, changed: boolean, badInitial = false) {
  let now = 0;
  let captures = 0;
  const judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  const f = walker([], judge, { ok: false, proven: false });
  f.deps.now = () => now;
  const modes: boolean[] = [];
  f.deps.captureScreen = async (options) => {
    modes.push(options?.platformPresence === true);
    captures++;
    const invalid = badInitial || captures > 1;
    const source = nativeCapture();
    if (invalid && changed) source.nodes[1].label = 'Saved';
    const observed = await captureScreen({
      appId: 'com.test',
      now: () => now,
      requirePrivateInputs: true,
      native: async () => {
        if (invalid && fault === 'expired') now += 20_000;
        return {
          ...source,
          presenceCapture:
            invalid && fault === 'missing-capture'
              ? undefined
              : { ...source.presenceCapture, ...(invalid ? faults[fault] : {}) },
        };
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { hosts: [], complete: true },
      }),
    });
    assert.equal(observed.captureCoverage?.native, 'complete');
    assert.equal(
      observed.coverage?.native,
      invalid ? (fault === 'missing-capture' ? 'unknown' : 'incomplete') : 'complete',
    );
    return observed;
  };
  return { ...f, judge, modes, captures: () => captures };
}

test('phrase readback cannot pass or retry after V2 presence admission fails', async (t) => {
  for (const fault of Object.keys(faults) as (keyof typeof faults)[]) {
    for (const changed of [false, true]) {
      await t.test(`${fault}, ${changed ? 'changed' : 'unchanged'} readback`, async () => {
        const f = fixture(fault, changed);
        const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
        assert.equal(result.verdict, 'FAIL');
        assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
        assert.deepEqual(
          result.steps.map((row) => row.outcome),
          ['fail'],
        );
        assert.deepEqual(f.actions, ['press @e1']);
        assert.deepEqual(f.modes, [true, true]);
        assert.equal(f.captures(), 2);
        assert.equal(f.judge.calls.length, 1);
      });
    }
  }
});

test('a requested presence capture is admitted before any phrase judgment or mutation', async () => {
  const f = fixture('wrong-budget', false, true);
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /NATIVE_PRESENCE_UNUSABLE/);
  assert.equal(f.captures(), 1);
  assert.equal(f.judge.calls.length, 0);
  assert.deepEqual(f.actions, []);
});

test('unique literal targeting and readback use ordinary capture', async () => {
  for (const fault of Object.keys(faults) as (keyof typeof faults)[]) {
    const f = fixture(fault, true);
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', fault);
    assert.deepEqual(f.actions, ['press @e1']);
    assert.deepEqual(f.modes, [false, false]);
    assert.equal(f.judge.calls.length, 0);
  }
});

test('a handler proof does not bypass failed presence admission on readback', async () => {
  const f = fixture('wrong-budget', false);
  f.deps.press = async (_ref, context) => {
    context.authorize();
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /NATIVE_PRESENCE_UNUSABLE/);
  assert.deepEqual(
    result.steps.map((row) => row.outcome),
    ['fail'],
  );
  assert.equal(f.captures(), 2);
});

test('under-budget native readback rejection retains only allowlisted failure diagnostics', async (t) => {
  const secret = 'PRIVATE-screen-label-input';
  const failure = { phase: 'revalidation', reason: 'read-unavailable', label: secret };
  const deadline = { phase: 'observation', read: 'first-match', edge: 'after', input: secret };
  const geometry = {
    changedMask: 1,
    beforeFiniteMask: 15,
    afterFiniteMask: 15,
    deltaFiniteMask: 15,
    dx: 0.125,
    dy: 0,
    dWidth: 0,
    dHeight: 0,
    beforeNull: false,
    afterNull: false,
    beforeInfinite: false,
    afterInfinite: false,
    beforeInvalidSize: false,
    afterInvalidSize: false,
  };
  const cases: {
    name: string;
    diagnostics: object;
    expected: string[];
    throwSink?: boolean;
    nativeMs?: number;
    preparationSamples?: number;
    preparationMs?: number;
  }[] = [
    {
      name: 'enumeration-changed',
      diagnostics: { failure: { ...failure, reason: 'enumeration-changed' } },
      expected: ['presence-failure=revalidation:enumeration-changed'],
    },
    {
      name: 'first raw mismatch in a 2513ms readback',
      nativeMs: 2513,
      diagnostics: {
        failure: {
          ...failure,
          reason: 'enumeration-changed',
          mismatch: {
            kind: 'node',
            index: 1,
            fieldMask: 20,
            beforeType: 9,
            afterType: 9,
            label: secret,
            identifier: secret,
            value: secret,
            treeHash: secret,
            geometry: { ...geometry, before: { x: secret }, after: { x: secret } },
            ancestorTypes: [1],
            ancestorsTruncated: false,
          },
        },
      },
      expected: [
        'presence-failure=revalidation:enumeration-changed',
        `presence-mismatch=kind=node,index=1,fieldMask=20,beforeType=9,afterType=9,geometry=${JSON.stringify(geometry)},ancestorTypes=[1],ancestorsTruncated=false`,
      ],
    },
    {
      name: 'read-unavailable',
      diagnostics: { failure },
      expected: ['presence-failure=revalidation:read-unavailable'],
    },
    {
      name: 'structural mismatch after the 500ms trial is terminal without refresh or replay',
      nativeMs: 1200,
      preparationSamples: 6,
      preparationMs: 500,
      diagnostics: {
        preparationQuietWindowMs: 500,
        preparationQuietElapsedMs: 500,
        preparationResets: 0,
        failure: {
          phase: 'revalidation',
          reason: 'enumeration-changed',
          mismatch: { kind: 'node', index: 1, fieldMask: 192, beforeType: 1, afterType: 1 },
        },
      },
      expected: [
        'presence-preparation-samples=6',
        'presence-preparation-quiet-window-ms=500',
        'presence-preparation-resets=0',
        'presence-preparation-quiet-elapsed-ms=500',
        'presence-failure=revalidation:enumeration-changed',
        'presence-mismatch=kind=node,index=1,fieldMask=192,beforeType=1,afterType=1',
        'presence-preparation-ms=500',
      ],
    },
    {
      name: 'preparation refusal has no refresh or replay',
      nativeMs: 250,
      preparationSamples: 3,
      preparationMs: 200,
      diagnostics: { failure: { phase: 'preparation', reason: 'read-unavailable' } },
      expected: [
        'presence-preparation-samples=3',
        'presence-failure=preparation:read-unavailable',
        'presence-preparation-ms=200',
      ],
    },
    {
      name: 'deadline',
      diagnostics: { failure: { ...failure, phase: 'observation', reason: 'deadline' }, deadline },
      expected: [
        'presence-failure=observation:deadline',
        'presence-deadline=observation:first-match:after',
      ],
    },
    ...['phase', 'reason'].map((field) => ({
      name: `private failure ${field}`,
      diagnostics: { failure: { ...failure, [field]: secret } },
      expected: [],
    })),
    ...['phase', 'read', 'edge'].map((field) => ({
      name: `private deadline ${field}`,
      diagnostics: { deadline: { ...deadline, [field]: secret } },
      expected: [],
    })),
    {
      name: 'throwing sink',
      diagnostics: { failure },
      expected: ['presence-failure=revalidation:read-unavailable'],
      throwSink: true,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let now = 0;
      let captures = 0;
      const logs: string[] = [];
      const judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
      const f = walker([], judge);
      f.deps.now = () => now;
      f.deps.timing = createTimingObserver((event) => logs.push(formatTimingEvent(event)));
      f.deps.captureScreen = (options) =>
        captureScreen({
          appId: 'com.test',
          now: () => now,
          requirePrivateInputs: true,
          timing: options?.timing,
          warn: (message) => {
            logs.push(`qaren-core: ${message}\n`);
            if (scenario.throwSink) throw new Error(secret);
          },
          native: async () => {
            const source = nativeCapture();
            if (++captures === 2) {
              now += scenario.nativeMs ?? 16_976;
              Object.assign(source.presenceCapture, {
                complete: false,
                endedUptimeMs: scenario.nativeMs === undefined ? 16_900 : 100 + scenario.nativeMs,
                diagnostics: {
                  ...scenario.diagnostics,
                  preparationSamples: scenario.preparationSamples,
                  screen: secret,
                  inputs: [secret],
                  phaseMs: {
                    preparation: scenario.preparationMs,
                    revalidation: scenario.nativeMs === undefined ? 16_000 : 83,
                    [secret]: 17,
                  },
                },
              });
              source.snapshotVerdict.state = 'failed';
              source.snapshotVerdict.refMapUpdated = false;
            }
            return source;
          },
          react: async () => ({
            interactive: [],
            verdict: { state: 'ok', path: 'interactive', complete: true },
            hostEvidence: { hosts: [], complete: true },
          }),
        });
      const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
      // A provably incomplete native tree refuses at capture; the refusal names only counts and causes.
      assert.equal(result.verdict, 'REFUSED');
      assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
      assert.match(
        'message' in result ? result.message : '',
        /native snapshot was incomplete \(nodes=\d+; causes=/,
      );
      assert.equal(captures, 2);
      assert.equal(judge.calls.length, 1);
      assert.deepEqual(f.actions, ['press @e1']);
      const events = readMetrics(logs.join(''));
      const rejected = events.find(
        (e) => e.stage === 'capture' && e.edge === 'end' && e.observation === 2,
      )!;
      assert.equal(rejected.outcome, 'failed');
      assert.equal(rejected.ms, scenario.nativeMs ?? 16_976);
      assert.equal(
        events.find((e) => e.stage === 'native-production' && e.observation === 2)?.ms,
        scenario.nativeMs ?? 16_800,
      );
      const preparation = events.find(
        (e) => e.stage === 'native-preparation' && e.observation === 2,
      );
      assert.equal(preparation?.ms, scenario.preparationMs);
      assert.equal(preparation?.count, scenario.preparationSamples);
      const causes = logs.filter((line) => line.startsWith('qaren-core: presence-'));
      assert.deepEqual(
        causes,
        scenario.expected.map((cause) => `qaren-core: ${cause}\n`),
        'only fixed-code failure causes survive rejection',
      );
      for (const cause of causes)
        assert.ok(logs.indexOf(cause) < logs.indexOf(formatTimingEvent(rejected)));
      assert.ok(!logs.join('').includes(secret));
      assert.ok(!events.some((e) => ['replay', 'refresh', 'reask'].includes(e.stage)));
    });
  }
});

test('guard refusal codes remain authoritative after swallowed invalidation and fallback', async (t) => {
  const codes: QaDispatchRefusal[] = [
    'ACTION_CONTEXT_CHANGED',
    'ACTION_OUTCOME_UNCERTAIN',
    'RUN_CANCELLED',
    'EVIDENCE_EXPIRED',
  ];
  for (const code of codes) {
    for (const authorized of code === 'EVIDENCE_EXPIRED' ? [true] : [false, true]) {
      await t.test(`${code}, ${authorized ? 'after' : 'before'} authorization`, async () => {
        const f = fixture('wrong-budget', true);
        let sends = 0;
        let shots = 0;
        f.deps.screenshot = async () => {
          shots++;
          return 'unexpected.png';
        };
        f.deps.press = async (_ref, context) => {
          if (authorized) {
            context.authorize();
            sends++;
          }
          try {
            if (code === 'ACTION_CONTEXT_CHANGED') context.invalidate();
            else context.refuse(code);
          } catch {
            /* The adapter returns success despite its guard refusing. */
          }
          assert.throws(() => context.authorize(), { code });
          return { ok: true, proven: true };
        };
        const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
        const expected = authorized && code !== 'RUN_CANCELLED' ? 'ACTION_OUTCOME_UNCERTAIN' : code;
        assert.equal(result.verdict, 'FAIL');
        assert.ok(result.steps[0].reason?.startsWith(expected));
        assert.deepEqual(
          result.steps.map((row) => row.outcome),
          ['fail'],
        );
        assert.equal(f.captures(), 1);
        assert.equal(sends, Number(authorized));
        assert.equal(shots, 0);
      });
    }
  }
});
