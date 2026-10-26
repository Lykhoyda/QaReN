import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { JevError } from '../../../dist/qa/questions.js';
import { join } from '../../../dist/qa/screen.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import type { WalkerTimingDiagnostic } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const refusal = 'SCREEN_EVIDENCE_INCOMPLETE: no established assertion contribution is available';

function captured(unknown = false) {
  return join(
    [
      ...(unknown ? [] : [{ ref: '@save', type: 'Button', label: 'Save', hittable: true }]),
      ...(unknown ? [{ ref: 'PRIVATE-ref', type: 'StaticText', label: 'PRIVATE-label' }] : []),
    ],
    [],
    'app',
    { native: 'complete', react: 'complete' },
    { complete: true, hosts: [] },
    {
      source: 'xcui-live',
      nodes: [{ status: unknown ? 'unknown' : 'observed', labelSource: 'direct' }],
    },
  );
}

function positiveTargets(checkProbability = 0.9) {
  return scriptedJudge((questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'choice'
          ? choice(question)
          : { type: 'noul', noul: id === 'check_1' ? checkProbability : 0.9 },
      ]),
    ),
  );
}

test('a semantic check refusal stops before screenshots, re-asks, scrolling or batched actions', async () => {
  for (const next of ['', 'Back', 'Tap "Save"', 'Tap the save button', 'Scroll until "Save"']) {
    const judge = positiveTargets();
    const f = walker([captured()], judge);
    let shots = 0;
    f.deps.screenshot = async (name) => {
      shots++;
      return name;
    };
    const result = await runPlan(
      parsePlan(`✓ The save button is red${next ? `\n1. ${next}` : ''}`).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL', next);
    assert.equal(result.steps.length, 1);
    assert.equal(
      result.steps[0].reason,
      'VISIBILITY_UNSUPPORTED: assertion requires unsupported visual styling evidence',
    );
    assert.equal(result.steps[0].screenshot, undefined);
    assert.equal(result.failure?.screenshot, undefined);
    assert.equal(shots, 0);
    assert.equal(f.captures(), 1);
    assert.equal(f.deps.now(), 0);
    assert.deepEqual(f.actions, []);
    assert.equal(judge.requests.length, 0);
  }
});

test('a local check refusal precedes a failing speculative model request', async () => {
  for (const code of ['JEV_UNAVAILABLE', 'JEV_AUTH_FAILED', 'JEV_RESPONSE_INVALID'] as const) {
    const judge = scriptedJudge(() => {
      throw new JevError(code);
    });
    const f = walker([captured()], judge);
    let shots = 0;
    f.deps.screenshot = async (name) => {
      shots++;
      return name;
    };
    const result = await runPlan(
      parsePlan('✓ The save button is red\n1. Tap the save button').blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL');
    assert.equal(
      result.steps[0].reason,
      'VISIBILITY_UNSUPPORTED: assertion requires unsupported visual styling evidence',
    );
    assert.equal(shots, 0);
    assert.equal(judge.requests.length, 0);
    assert.equal(f.captures(), 1);
    assert.deepEqual(f.actions, []);
  }
});

test('check refusal emits the existing safe blocker diagnostic without changing the outcome', async () => {
  const plan = parsePlan('✓ The save button is visible\n1. Tap "Save"').blocks!;
  const baseline = walker([captured(true)], positiveTargets());
  const expected = await runPlan(plan, baseline.deps);
  for (const throws of [false, true]) {
    const f = walker([captured(true)], positiveTargets());
    const events: WalkerTimingDiagnostic[] = [];
    f.deps.diagnostic = (event) => {
      events.push(event);
      if (throws) throw new Error('PRIVATE-sink-error');
    };
    const actual = await runPlan(plan, f.deps);
    assert.deepEqual(actual, expected);
    assert.equal(actual.steps[0].reason, refusal);
    const blockers = events.filter((event) => event.visibilityBlocker);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].line, 1);
    assert.equal(blockers[0].observation, 1);
    assert.equal(blockers[0].stage, 'decision');
    assert.equal(blockers[0].code, 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.equal(blockers[0].visibilityBlocker?.ordinal, 0);
    assert.equal(blockers[0].visibilityBlocker?.nativeStatus, 'unknown');
    assert.equal(blockers[0].visibilityBlocker?.visibility, 'unknown');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE-/);
    assert.doesNotMatch(JSON.stringify(actual), /visibilityBlocker|PRIVATE-sink-error/);
    assert.deepEqual(f.actions, []);
  }
});

test('a refusal on the fresh re-ask cannot dispatch an earlier positive batched target', async () => {
  const judge = positiveTargets(0.5);
  const f = walker([captured(), captured(true)], judge);
  let shots = 0;
  f.deps.screenshot = async (name) => {
    shots++;
    return name;
  };
  const result = await runPlan(
    parsePlan('✓ The save button is visible\n1. Tap the save button').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].reason, refusal);
  assert.equal(f.captures(), 2);
  assert.equal(f.deps.now(), WAIT_POLL_MS);
  assert.equal(shots, 0);
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.filter(({ questions }) => 'check_1' in questions).length, 1);
});

test('failed and uncertain checks never execute their positive batched target or visibility', async () => {
  for (const probability of [0.1, 0.5]) {
    for (const next of ['Tap the save button', 'Scroll until the save button']) {
      const judge = positiveTargets(probability);
      const f = walker([captured()], judge);
      const result = await runPlan(
        parsePlan(`✓ The save button is visible\n1. ${next}`).blocks!,
        f.deps,
      );
      assert.equal(result.verdict, 'FAIL');
      assert.equal(result.steps.length, 1);
      assert.match(
        result.steps[0].reason!,
        probability === 0.5 ? /^CHECK_UNSURE:/ : /is not satisfied on screen/,
      );
      assert.equal(result.failure?.kind, probability === 0.5 ? undefined : 'step');
      assert.equal(f.captures(), probability === 0.5 ? 2 : 1);
      assert.equal(f.deps.now(), probability === 0.5 ? WAIT_POLL_MS : 0);
      assert.deepEqual(f.actions, []);
    }
  }
});

test('a check left uncertain by a private input is not a step failure', async () => {
  const judge = scriptedJudge(() => ({}));
  const f = walker([screen([element('@pw', 'Password', { kind: 'input', secure: true })])], judge);
  const result = await runPlan(parsePlan('✓ The Password field is filled').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /^CHECK_UNSURE:/);
  assert.equal(result.failure?.kind, undefined);
  assert.equal(judge.requests.length, 0);
});
