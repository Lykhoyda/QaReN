import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import {
  ACT,
  CHECK,
  decideScreen,
  judgeCheck,
  prepareTarget,
  prepareDeclaredPress,
  resolveTarget,
  targetVisible,
  visibleSelector,
} from '../../../dist/qa/resolve.js';
import { join as joinScreen } from '../../../dist/qa/screen.js';
import type { NativeNode, ReactHostEvidence, Screen } from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { associateHosts } from '../../../dist/qa/host-association.js';
import { JevError, confidentChoice } from '../../../dist/qa/questions.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  choice,
  element,
  screen,
  scriptedJudge,
  walker,
  joinedGapScreen,
} from './judgment-fixtures.ts';

function step(line: string) {
  const parsed = parseStep(line);
  assert.ok(parsed && !('refuse' in parsed));
  return parsed;
}
const save = screen([element('@save', 'Save'), element('@draft', 'Save draft')]);
const target = step('Tap the Save button');
const check = { kind: 'check' as const, text: 'The profile was saved', literal: false };

test('declared support refusals classify the same joined observation without exposing host values', () => {
  const pair = {
    target: { quoted: 'private-gap-primary', phrase: 'private-gap-primary', exact: 'id' as const },
    alternative: {
      quoted: 'private-gap-label',
      phrase: 'private-gap-label',
      exact: 'text' as const,
    },
  };
  for (const category of [
    'missing-host-evidence',
    'incomplete-host-evidence',
    'unassociated-hosts',
  ] as const) {
    for (const presence of [true, false, 'unknown'] as const) {
      for (const typographyComplete of [true, false]) {
        const observed = joinedGapScreen(category, presence, typographyComplete);
        const prepared = prepareDeclaredPress(pair, observed, 10);
        assert.ok('refuse' in prepared.resolution);
        assert.equal(prepared.resolution.refuse, 'TARGET_UNSUPPORTED');
        const support = prepared.targeting.evaluated[0].pressSupport!;
        assert.equal(support.pressEvidenceGap, true);
        assert.equal(support.semanticPress, 'supported');
        assert.deepEqual(support.gap, {
          category,
          hostEvidencePresent: category !== 'missing-host-evidence',
          hostEvidenceComplete: category === 'unassociated-hosts',
          typographyComplete: category !== 'missing-host-evidence' && typographyComplete,
          nativePresenceAvailable: presence === true,
          pressGapCount: category === 'missing-host-evidence' ? 0 : 10,
          ...(category === 'unassociated-hosts'
            ? {
                gapHosts: {
                  total: 10,
                  truncated: true,
                  rows: Array.from({ length: 8 }, (_, hostOrdinal) => ({
                    hostOrdinal,
                    hostKind: 'view',
                    capabilities: { press: true, fill: false },
                    pressGap: true,
                    association: {
                      identity:
                        presence === true && typographyComplete
                          ? 'native-id-count'
                          : 'evidence-unavailable',
                      nativeIdentityCandidateCount:
                        presence === true && typographyComplete ? 0 : null,
                      compatibleCount: null,
                      sameFrameCount: null,
                      presenceProofCount: null,
                      ancestorPath:
                        presence === true && typographyComplete
                          ? 'self-anchor-missing'
                          : 'not-evaluated',
                      collisions: null,
                    },
                  })),
                },
              }
            : {}),
        });
        assert.equal(prepared.targeting.evaluated[0].observation, 10);
        assert.equal(prepared.targeting.evaluated.length, 1);
        assert.equal(prepared.targeting.dispatchCount, 0);
      }
    }
  }
});

test('declared support refusals retain both guard operands on their observation', () => {
  const pair = {
    target: { quoted: 'primary', phrase: 'primary', exact: 'id' as const },
    alternative: { quoted: 'Visible control', phrase: 'Visible control', exact: 'text' as const },
  };
  for (const pressEvidenceGap of [false, true]) {
    for (const press of ['supported', 'unsupported', 'unknown', undefined] as const) {
      const observed = screen([
        element('@primary', 'Primary', {
          testID: 'primary',
          semantic:
            press === undefined
              ? undefined
              : {
                  press,
                  fill: 'unsupported',
                  visibility: 'visible',
                },
        }),
        element('@alternate', 'Visible control'),
      ]);
      if (pressEvidenceGap) observed.pressEvidenceGap = 'private-gap-canary';
      const prepared = prepareDeclaredPress(pair, observed, 10);
      if (!pressEvidenceGap && press === 'supported') {
        assert.ok('ref' in prepared.resolution);
        assert.equal(prepared.targeting.evaluated[0].pressSupport, undefined);
        continue;
      }
      assert.ok('refuse' in prepared.resolution);
      assert.equal(prepared.resolution.refuse, 'TARGET_UNSUPPORTED');
      assert.deepEqual(prepared.targeting.evaluated, [
        {
          method: 'id',
          observation: 10,
          count: 1,
          match: 'id',
          outcome: 'ineligible',
          pressSupport: { pressEvidenceGap, semanticPress: press ?? 'absent' },
        },
      ]);
      assert.equal(prepared.targeting.dispatchCount, 0);
      assert.equal(prepared.targeting.originalMissing, undefined);
    }
  }
});

test('declared resolution counts the complete domain and never evades a present primary', () => {
  const target = { quoted: 'primary', phrase: 'primary', exact: 'id' as const };
  const alternative = {
    quoted: 'Visible control',
    phrase: 'Visible control',
    exact: 'text' as const,
  };
  const alternate = element('@alternate', 'Visible control');
  for (const extra of [
    { disabled: true },
    { offscreen: true },
    { hittable: false },
    { ref: 'react:primary', offscreen: true, hittable: false },
    {
      semantic: {
        press: 'unknown' as const,
        fill: 'unsupported' as const,
        visibility: 'unknown' as const,
      },
    },
    { visibilityEvidence: 'unresolved' as const },
  ]) {
    const primary = element('@primary', 'Primary', { testID: 'primary', ...extra });
    const observed = screen([primary, alternate]);
    const resolved = prepareDeclaredPress({ target, alternative }, observed, 9);
    assert.ok('refuse' in resolved.resolution, JSON.stringify(extra));
    assert.equal(resolved.targeting.evaluated.length, 1);
    assert.equal(resolved.targeting.evaluated[0].count, 1);
    assert.equal(resolved.targeting.originalMissing, undefined);
    const ambiguous = prepareDeclaredPress(
      { target, alternative },
      screen([element('@eligible', 'Primary', { testID: 'primary' }), primary, alternate]),
      10,
    );
    assert.ok(
      'refuse' in ambiguous.resolution && ambiguous.resolution.refuse === 'TARGET_AMBIGUOUS',
    );
    assert.equal(ambiguous.targeting.evaluated[0].count, 2);
  }
  const primary = element('@primary', 'Primary', { testID: 'primary' });
  const selected = prepareDeclaredPress({ target, alternative }, screen([primary, alternate]), 11);
  assert.ok('ref' in selected.resolution && selected.resolution.ref === '@primary');
  assert.equal(selected.targeting.evaluated.length, 1);
  assert.equal(selected.targeting.selected, 'id');
});

test('declared alternatives require complete native and React acquisition', () => {
  const pair = step('Tap id "primary" || label "Visible control"');
  for (const native of ['complete', 'incomplete', 'unknown'] as const) {
    for (const react of ['complete', 'incomplete', 'unknown'] as const) {
      const observed = screen([element('@alternate', 'Visible control')]);
      observed.captureCoverage = { native, react };
      const resolved = prepareTarget(pair, observed);
      assert.equal('ref' in resolved, native === 'complete' && react === 'complete');
    }
  }
  const observed = screen([element('@alternate', 'Visible control')]);
  delete observed.coverage;
  const resolved = prepareTarget(pair, observed);
  assert.ok('refuse' in resolved && resolved.refuse === 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('declared label matches keep full-field precedence and reject substring and segment twins', () => {
  const pair = step('Tap id "missing" || label "Card"');
  for (const label of ['Cardinal', 'A Card', 'Cards, Status', 'Card-like']) {
    const resolved = prepareTarget(pair, screen([element('@lookalike', label)]));
    assert.ok('refuse' in resolved && resolved.refuse === 'ALTERNATIVES_EXHAUSTED');
  }
  const card = element('@card', 'Card, Status');
  assert.ok('ref' in prepareTarget(pair, screen([card])));
  for (const extra of [
    { disabled: true },
    { offscreen: true },
    { hittable: false },
    { ref: 'react:twin' },
  ]) {
    const twin = element('@twin', 'Card, Other', extra);
    const resolved = prepareTarget(pair, screen([card, twin]));
    assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS');
  }
  const disabledExact = element('@exact', 'Card', { disabled: true });
  const resolved = prepareTarget(pair, screen([disabledExact, card]));
  assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_INELIGIBLE');
});

test('declared alternatives refuse a clipped or keyboard-covered native carrier without scrolling', async () => {
  for (const keyboard of [false, true]) {
    const rect = { x: 20, y: keyboard ? 700 : 900, width: 300, height: 44 };
    const nodes: NativeNode[] = [
      {
        ref: '@app',
        index: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@win',
        index: 1,
        parentIndex: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@alternate',
        index: 2,
        parentIndex: 1,
        type: 'Button',
        identifier: 'alternate',
        label: 'Alternate',
        hittable: true,
        rect,
      },
      ...(keyboard
        ? [
            {
              ref: '@keyboard',
              index: 3,
              parentIndex: 1,
              type: 'Keyboard',
              rect: { x: 0, y: 600, width: 400, height: 200 },
            },
          ]
        : []),
    ];
    const hostEvidence: ReactHostEvidence = {
      complete: true,
      hosts: [
        {
          testID: 'alternate',
          role: 'button',
          roleSource: 'role',
          capabilities: { press: true, fill: false },
        },
      ],
      typography: {
        version: 1,
        complete: true,
        durationMs: 1,
        coordinateSpace: 'window-points',
        nodes: [
          {
            hostIndex: 0,
            parentHostIndex: null,
            rootIndex: 0,
            hostType: 'RCTView',
            rect,
            text: { kind: 'none' },
          },
        ],
      },
    };
    const presence: NativePresence = {
      source: 'xcui-live',
      nodes: nodes.map((_, index) =>
        index === 2
          ? keyboard
            ? { status: 'observed', labelSource: 'direct' }
            : { status: 'unknown', labelSource: 'direct', unknownReason: 'clipped' }
          : { status: 'unknown', labelSource: 'none' },
      ),
    };
    const observed = joinScreen(
      nodes,
      [{ role: 'button', testID: 'alternate', capabilities: { press: true, fill: false } }],
      'app',
      { native: 'complete', react: 'complete' },
      hostEvidence,
      presence,
    );
    observed.captureCoverage = { native: 'complete', react: 'complete' };
    assert.equal(associateHosts(nodes, hostEvidence, presence).get(0)?.nativeIndex, 2);
    assert.equal(observed.pressEvidenceGap, undefined);
    assert.equal(
      observed.elements.find((e) => e.testID === 'alternate')?.semantic?.press,
      'supported',
    );
    const resolved = prepareTarget(step('Tap id "missing" || label "Alternate"'), observed);
    assert.ok(
      'refuse' in resolved && resolved.refuse === 'TARGET_INELIGIBLE',
      JSON.stringify(resolved),
    );
    const judge = scriptedJudge(() => assert.fail('geometry refusal must not ask Jev'));
    const f = walker([observed], judge);
    const result = await runPlan(
      parsePlan('1. Tap id "missing" || label "Alternate"').blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
    assert.equal(result.recoveries, 0);
    assert.equal(judge.calls.length, 0);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].attempt, 1);
    const fact = result.steps[0].targeting!;
    assert.deepEqual(
      fact.evaluated.map((e) => e.count),
      [0, 1],
    );
    assert.equal(fact.originalMissing, 'TARGET_NOT_FOUND');
    assert.equal(fact.selected, undefined);
    assert.equal(fact.preSelectionAuthorizations, 0);
    assert.equal(fact.dispatchAttempted, false);
    assert.equal(fact.dispatchCount, 0);
    assert.equal(fact.code, 'TARGET_INELIGIBLE');
  }
});

test('declared alternatives retain the missing-host evidence refusal before geometry', () => {
  const observed = joinScreen(
    [
      { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: '@win',
        index: 1,
        parentIndex: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@alternate',
        index: 2,
        parentIndex: 1,
        type: 'Button',
        identifier: 'alternate',
        label: 'Alternate',
        hittable: true,
        rect: { x: 20, y: 100, width: 300, height: 44 },
      },
    ],
    [{ role: 'button', testID: 'alternate', capabilities: { press: true, fill: false } }],
    'app',
    { native: 'complete', react: 'complete' },
  );
  observed.captureCoverage = { native: 'complete', react: 'complete' };
  assert.equal(observed.pressEvidenceGap, 'React host evidence missing');
  assert.equal(observed.elements[2].semantic?.press, 'supported');
  const resolved = prepareTarget(step('Tap id "missing" || label "Alternate"'), observed);
  assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_UNSUPPORTED');
});

for (const type of ['StaticText', 'Button']) {
  test(`text waits save and replay only uncovered ${type} identities`, () => {
    const observed = (covered: boolean, duplicate = true) =>
      joinScreen(
        [
          {
            ref: '@app',
            index: 0,
            type: 'Application',
            rect: { x: 0, y: 0, width: 400, height: 800 },
          },
          {
            ref: '@win',
            index: 1,
            parentIndex: 0,
            type: 'Window',
            rect: { x: 0, y: 0, width: 400, height: 800 },
          },
          {
            ref: '@a',
            index: 2,
            parentIndex: 1,
            type,
            label: 'Done',
            hittable: true,
            rect: { x: 20, y: 100, width: 100, height: 44 },
          },
          ...(duplicate
            ? [
                {
                  ref: '@b',
                  index: 3,
                  parentIndex: 1,
                  type,
                  label: 'Done',
                  hittable: true,
                  rect: { x: 20, y: covered ? 650 : 300, width: 100, height: 44 },
                },
              ]
            : []),
          {
            ref: '@kb',
            index: duplicate ? 4 : 3,
            parentIndex: 1,
            type: 'Keyboard',
            rect: { x: 0, y: 500, width: 400, height: 300 },
          },
        ],
        [],
      );
    const target = { phrase: 'Done', quoted: 'Done' };
    const saved = visibleSelector(target, observed(false, false));
    assert.deepEqual(saved, { text: 'Done' });
    assert.deepEqual(visibleSelector(target, observed(true)), saved);
    assert.equal(targetVisible({ ...target, exact: 'text' }, observed(true)), true);
    const identified = observed(true);
    identified.elements.find((e) => e.ref === '@a')!.testID = 'uncovered-done';
    assert.deepEqual(visibleSelector(target, identified), { id: 'uncovered-done' });
    assert.equal(visibleSelector(target, observed(false)), undefined);
    assert.throws(
      () => targetVisible({ ...target, exact: 'text' }, observed(false)),
      /TARGET_AMBIGUOUS/,
    );
    if (type === 'Button') {
      const action = prepareTarget({ kind: 'press', target }, observed(true));
      assert.equal('refuse' in action && action.refuse, 'TARGET_AMBIGUOUS');
    }
  });
}

test('act uses the full map, inclusive minimum and margin, never the confidence summary', async () => {
  assert.deepEqual(ACT, { min: 0.55, margin: 0.2 });
  for (const [probabilities, expected] of [
    [{ e0: 0.55, e1: 0.35, none: 0.1 }, '@save'],
    [{ e0: 0.549, e1: 0.3, none: 0.151 }, 'TARGET_UNSURE'],
    [{ e0: 0.55, e1: 0.36, none: 0.09 }, 'TARGET_UNSURE'],
    [{ e0: 0.1, e1: 0.1, none: 0.8 }, 'TARGET_NOT_FOUND'],
  ] as const) {
    const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0, top, probabilities) }));
    const result = await resolveTarget(target, save, judge);
    assert.equal(
      'ref' in result ? result.ref : 'refuse' in result ? result.refuse : result.scroll,
      expected,
    );
  }
});

test('malformed, partial, nonfinite, out-of-range and inconsistent probability maps never act', () => {
  const prepared = prepareTarget(target, save);
  assert.ok('question' in prepared);
  const good = choice(prepared.question);
  for (const answer of [
    undefined,
    null,
    {},
    { type: 'noul', noul: 1 },
    { ...good, probabilities: { e0: 1 } },
    { ...good, probabilities: { e0: 1, e1: 0, none: 0, injected: 0 } },
    { ...good, probabilities: { e0: NaN, e1: 0, none: 0 } },
    { ...good, probabilities: { e0: Infinity, e1: 0, none: 0 } },
    { ...good, probabilities: { e0: 1.1, e1: -0.1, none: 0 } },
    { ...good, probabilities: { e0: 0.6, e1: 0, none: 0 } },
    { ...good, probabilities: { e0: '1', e1: 0, none: 0 } },
    { ...good, choice: 'outside' },
    { ...good, choice: 'e1' },
    { ...good, confidence: 2 },
  ])
    assert.throws(() => confidentChoice(prepared.question, answer), /JEV_RESPONSE_INVALID/);
});

test('unique quoted targets and literal assertions are model-free', async () => {
  const judge = scriptedJudge(() => assert.fail('literal resolution must not ask Jev'));
  assert.equal((await resolveTarget(step('Tap "Save"'), save, judge)).ref, '@save');
  assert.equal(judgeCheck({ ...check, text: 'Save', literal: true }, save), 'pass');
  assert.equal(judge.requests.length, 0);
});

test('ambiguous quoted press and fill targets refuse locally without asking or acting', async () => {
  for (const line of ['Tap "Save"', 'Type "x" into "Save"', 'Fill "Save" with "x"']) {
    for (const identity of ['label', 'testID', 'placeholder'] as const) {
      if (line.startsWith('Tap') && identity === 'placeholder') continue;
      for (const visibility of ['onscreen', 'offscreen', 'mixed']) {
        const observed = screen(
          ['@top', '@bottom'].map((ref, i) =>
            element(ref, '', {
              kind: line.startsWith('Tap') ? 'button' : 'input',
              [identity]: 'Save',
              offscreen: visibility === 'offscreen' || (visibility === 'mixed' && i === 1),
              hittable: visibility === 'onscreen' || (visibility === 'mixed' && i === 0),
            }),
          ),
        );
        const judge = scriptedJudge(() => assert.fail('ambiguous quotes must not ask Jev'));
        const result = await resolveTarget(step(line), observed, judge);
        assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS');
        assert.match(result.reason, /multiple elements/);
        const f = walker([observed], judge);
        const ledger = await runPlan(parsePlan(`1. ${line}\n✓ "Save"`).blocks!, f.deps);
        assert.equal(ledger.verdict, 'FAIL');
        assert.match(ledger.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
        assert.equal(ledger.jev.calls, 0);
        assert.deepEqual(f.actions, []);
        assert.equal(judge.requests.length, 0);
      }
    }
  }
});

test('offscreen selections and none with offscreen evidence request a scroll, never a React ref press', async () => {
  const before = screen([
    element('@a', 'Header'),
    element('react:more', 'Load more', { offscreen: true, hittable: false }),
  ]);
  for (const chosen of ['e1', 'none']) {
    const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0, chosen) }));
    assert.deepEqual(await resolveTarget(step('Tap Load more'), before, judge), { scroll: 'down' });
  }
});

test('candidate coverage is bounded, disabled/hidden candidates excluded, fill only selects inputs', async () => {
  const limit = screen(Array.from({ length: 30 }, (_, i) => element(`@${i}`, `button ${i}`)));
  const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0) }));
  assert.equal((await resolveTarget(target, limit, judge)).ref, '@0');
  assert.equal(Object.keys(judge.requests[0].questions.target_0.criteria!).length, 31);
  const overflow = prepareTarget(target, screen([...limit.elements, element('@31', 'another')]));
  assert.ok('refuse' in overflow && overflow.refuse === 'CANDIDATE_LIMIT');
  const fill = step('Type "sensitive" into the email field');
  const mixed = screen([
    element('@text', 'Email'),
    element('@disabled', 'Email', { kind: 'input', disabled: true, offscreen: true }),
    element('@covered', 'Email', {
      kind: 'input',
      hittable: false,
      semantic: { press: 'unsupported', fill: 'supported', visibility: 'hidden' },
    }),
    element('@input', 'Email', { kind: 'input' }),
  ]);
  assert.equal((await resolveTarget(fill, mixed, judge)).ref, '@input');
  assert.equal(Object.keys(judge.requests[1].questions.target_0.criteria!).length, 2);
  assert.equal(judge.requests.length, 2, 'overflow does not silently omit candidates');
});

test('a supported non-hittable control without hidden or offscreen evidence is not silently excluded', async () => {
  const observed = screen([
    element('@blocked', 'Email', { kind: 'input', hittable: false }),
    element('@input', 'Email', { kind: 'input' }),
  ]);
  const judge = scriptedJudge(() => assert.fail('incomplete evidence must not reach Jev'));
  const result = await resolveTarget(
    step('Type "sensitive" into the email field'),
    observed,
    judge,
  );
  assert.ok('refuse' in result && result.refuse === 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(judge.requests.length, 0);
});

test('noul bars are inclusive and invalid answers fail closed', () => {
  assert.deepEqual(CHECK, { pass: 0.7, fail: 0.3, reasks: 1 });
  for (const [noul, expected] of [
    [0.7, 'pass'],
    [0.3, 'fail'],
    [0.5, 'unsure'],
  ] as const)
    assert.equal(judgeCheck(check, save, { type: 'noul', noul }), expected);
  for (const noul of [NaN, Infinity, -0.1, 1.1])
    assert.throws(() => judgeCheck(check, save, { type: 'noul', noul }), /JEV_RESPONSE_INVALID/);
});

test('check k and target k+1 share one fresh screen request and the target is consumed without a resnapshot', async () => {
  const judge = scriptedJudge((q) => ({
    check_1: { type: 'noul', noul: 0.9 },
    target_2: choice(q.target_2),
  }));
  const f = walker([save], judge);
  const ledger = await runPlan(parsePlan('✓ The profile is visible\n1. Tap Save').blocks!, f.deps, [
    { scope: 'preflight', questionIds: ['preflight'], inputTokens: 5, ms: 10, outcome: 'ok' },
  ]);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['check_1', 'target_2']);
  assert.equal(judge.requests.length, 1);
  assert.equal(f.captures(), 2, 'one decision capture, one mutation read-back');
  assert.deepEqual(f.actions, ['press @save']);
  assert.deepEqual(
    ledger.steps.map((r) => r.resolvedBy),
    ['jev', 'jev'],
  );
  assert.equal(ledger.jev.calls, 2);
  assert.equal(ledger.jev.medianMs, 15);
  assert.equal(ledger.jev.inputTokens, 15);
});

test('uncertain checks re-snapshot once and discard old target refs; a second unsure never acts', async () => {
  for (const second of [0.9, 0.5, 0.2]) {
    const judge = scriptedJudge((q, i) => ({
      check_1: { type: 'noul', noul: i ? second : 0.5 },
      target_2: choice(q.target_2),
    }));
    const fresh = screen([element('@fresh', 'Save')]);
    const f = walker([save, fresh, fresh], judge);
    const ledger = await runPlan(parsePlan('✓ Profile ready\n1. Tap Save').blocks!, f.deps);
    assert.equal(judge.requests.length, 2);
    assert.equal(ledger.verdict, second === 0.9 ? 'PASS' : 'FAIL');
    assert.deepEqual(f.actions, second === 0.9 ? ['press @fresh'] : []);
    assert.ok(!JSON.stringify(f.actions).includes('@save'));
    if (second === 0.5) assert.match(ledger.failure?.seen ?? '', /CHECK_UNSURE/);
  }
});

test('a failed check does not act on the batched next target', async () => {
  const judge = scriptedJudge((q) => ({
    check_1: { type: 'noul', noul: 0.2 },
    target_2: choice(q.target_2),
  }));
  const f = walker([save], judge);
  assert.equal((await runPlan(parsePlan('✓ Ready\n1. Tap Save').blocks!, f.deps)).verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.length, 1);
});

test('preliminary scrolling requires a fresh target question before any press', async () => {
  const before = screen([element('react:save', 'Save', { offscreen: true, hittable: false })]);
  const after = screen([element('@native-save', 'Save')]);
  const judge = scriptedJudge((q) =>
    Object.fromEntries(
      Object.entries(q).map(([id, question]) => [
        id,
        question.type === 'noul' ? { type: 'noul', noul: 0.9 } : choice(question),
      ]),
    ),
  );
  const f = walker([before, after, after], judge);
  const ledger = await runPlan(parsePlan('✓ Ready\n1. Tap Save').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(f.actions, ['scroll down', 'press @native-save']);
  assert.deepEqual(
    judge.calls.map((c) => c.questionIds),
    [['check_1', 'target_2'], ['target_2']],
  );
});

test('phrase mutation retries obey the unchanged-screen rule, never a timeout alone', async () => {
  for (const changed of [true, false]) {
    const judge = scriptedJudge((q) =>
      Object.fromEntries(Object.entries(q).map(([id, question]) => [id, choice(question)])),
    );
    const f = walker(changed ? [save, screen([element('@next', 'Profile')])] : [save], judge, {
      ok: false,
      proven: false,
      error: 'timed out',
    });
    const ledger = await runPlan(parsePlan('1. Tap Save').blocks!, f.deps);
    assert.equal(ledger.verdict, changed ? 'PASS' : 'FAIL');
    assert.equal(f.actions.length, changed ? 1 : 2);
    assert.equal(judge.requests.length, changed ? 1 : 2);
    assert.equal(ledger.recoveries, 0);
    assert.equal(ledger.escapes, 0);
  }
});

test('typed and secure values are masked in all projected questions and screens, not mutation arguments', async () => {
  const secret = 'private-fill-text';
  const secureValue = 'protected-password';
  const input = screen(
    [
      element('@input', 'Name', { kind: 'input', value: secret }),
      element('@secure', 'Password', { kind: 'input', secure: true, value: secureValue }),
    ],
    [`Name: ${secret}`, `Password: ${secureValue}`],
  );
  const judge = scriptedJudge((q) =>
    Object.fromEntries(
      Object.entries(q).map(([id, question]) => [
        id,
        question.type === 'noul' ? { type: 'noul', noul: 0.9 } : choice(question),
      ]),
    ),
  );
  const f = walker([input], judge);
  const ledger = await runPlan(
    parsePlan(`1. Type "${secret}" into the name field\n✓ The name field is filled`).blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(f.actions, [`fill @input ${secret}`]);
  const dump = JSON.stringify({ requests: judge.requests, ledger });
  assert.ok(!dump.includes(secret), dump);
  assert.ok(!dump.includes(secureValue), dump);
});

test('Jev unavailable is a line-attributed failure, with no mutation or recovery', async () => {
  const judge = scriptedJudge(() => {
    throw new JevError('JEV_UNAVAILABLE');
  });
  const f = walker([save], judge);
  const ledger = await runPlan(parsePlan('1. Tap Save').blocks!, f.deps);
  assert.match(ledger.failure?.seen ?? '', /JEV_UNAVAILABLE/);
  assert.equal(ledger.failure?.step, 1);
  assert.equal(ledger.jev.calls, 1);
  assert.deepEqual(f.actions, []);
  assert.equal(ledger.llmTurns, 0);
});

test('phrase waits and explicit scroll-until ask a presence predicate without selecting or pressing a ref', async () => {
  const before = screen([element('@loading', 'Loading')]);
  const after = screen([element('@footer', 'Footer', { kind: 'text', hittable: false })]);
  for (const line of ['1. Wait for the footer', '1. Scroll down until the footer']) {
    const judge = scriptedJudge((q, i) => {
      assert.deepEqual(Object.keys(q), ['visibility_1']);
      assert.equal(q.visibility_1.type, 'noul');
      return { visibility_1: { type: 'noul', noul: i ? 0.9 : 0.1 } };
    });
    const f = walker([before, after], judge);
    const ledger = await runPlan(parsePlan(line).blocks!, f.deps);
    assert.equal(ledger.verdict, 'PASS');
    assert.deepEqual(f.actions, line.includes('Scroll') ? ['scroll down'] : []);
    assert.equal(judge.requests.length, 2);
  }
});

test('literal walk makes no model calls beyond the accounted preflight', async () => {
  const judge = scriptedJudge(() => {
    throw new Error('unexpected model call');
  });
  const f = walker([save], judge);
  const ledger = await runPlan(parsePlan('1. Tap "Save"\n✓ "Save"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.jev.calls, 0);
  assert.deepEqual(
    ledger.steps.map((r) => r.resolvedBy),
    ['exact', 'exact'],
  );
});

test('quoted visibility remains model-free even with duplicate labels in a batched check', async () => {
  const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.9 } }));
  const f = walker([screen([element('@a', 'Save'), element('@b', 'Save')])], judge);
  const ledger = await runPlan(parsePlan('✓ Ready\n1. Wait for "Save"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(judge.calls[0].questionIds, ['check_1']);
  assert.equal(judge.calls.length, 1);
  assert.equal(ledger.steps[1].resolvedBy, 'exact');
});

test('uncertain whole-claim visibility names the resolution refusal within the evidence bound', async () => {
  for (const line of ['1. Wait for Save', '1. Scroll until Save']) {
    for (const observed of [
      save,
      screen(Array.from({ length: 30 }, (_, i) => element(`@${i}`, `entry${i}`))),
    ]) {
      const judge = scriptedJudge((q) => {
        assert.deepEqual(Object.keys(q), ['visibility_1']);
        assert.equal(q.visibility_1.type, 'noul');
        return { visibility_1: { type: 'noul', noul: 0.5 } };
      });
      const f = walker([observed], judge);
      const ledger = await runPlan(parsePlan(line).blocks!, f.deps);
      assert.equal(ledger.verdict, 'FAIL');
      assert.match(ledger.failure?.seen ?? '', /VISIBILITY_UNSURE/);
      assert.deepEqual(f.actions, []);
      assert.equal(judge.requests.length, 2);
      assert.equal(f.captures(), 2);
    }
  }
});

test('whole-claim assertions refuse more than 30 contributions instead of splitting or truncating', async () => {
  for (const count of [31, 65]) {
    for (const line of ['✓ There are Save controls', '1. Wait for Save', '1. Scroll until Save']) {
      const judge = scriptedJudge(() => assert.fail('overflow must not reach the model'));
      const f = walker(
        [screen(Array.from({ length: count }, (_, i) => element(`@${i}`, 'Save')))],
        judge,
      );
      const result = await runPlan(parsePlan(line).blocks!, f.deps);
      assert.equal(result.verdict, 'FAIL');
      assert.match(result.steps[0].reason!, /^CANDIDATE_LIMIT:/);
      assert.equal(f.captures(), 1);
      assert.equal(judge.requests.length, 0);
      assert.deepEqual(f.actions, []);
    }
  }
});

test('30 contributions support one whole-claim judgment, never an OR of fragment judgments', async () => {
  const entries = screen(Array.from({ length: 30 }, (_, i) => element(`@${i}`, `entry${i}`)));
  for (const [noul, verdict] of [
    [0.99, 'present'],
    [0.01, 'absent'],
  ] as const) {
    const judge = scriptedJudge((questions, _index, state) => {
      assert.deepEqual(Object.keys(questions), ['visibility_1']);
      assert.match(
        questions.visibility_1.instructions,
        /WHOLE expectation: both entry0 and entry29/,
      );
      assert.ok(state && typeof state === 'object' && 'assertionEvidence' in state);
      const evidence = state.assertionEvidence as { observed: string[]; unknown: unknown[] };
      assert.equal(evidence.observed.length, 30);
      assert.equal(new Set(evidence.observed).size, 30);
      assert.deepEqual(evidence.unknown, []);
      assert.equal(evidence.observed[0], 'Button "entry0"');
      assert.equal(evidence.observed[29], 'Button "entry29"');
      assert.ok(!('visibilityEvidenceGroups' in state));
      return { visibility_1: { type: 'noul', noul } };
    });
    const wait = { kind: 'wait' as const, target: { phrase: 'both entry0 and entry29' }, line: 1 };
    assert.deepEqual((await decideScreen(entries, judge, undefined, wait)).visibility, { verdict });
    assert.equal(judge.requests.length, 1);
  }
});

test('a mixed check evaluates its entire expectation rather than passing on the quoted fragment', async () => {
  const payload = 'The screen shows "Welcome" and no error is visible';
  const judge = scriptedJudge((questions) => {
    assert.ok(questions.check_1.instructions.includes(payload));
    return { check_1: { type: 'noul', noul: 0.1 } };
  });
  const f = walker([screen([element('@welcome', 'Welcome'), element('@error', 'Error')])], judge);
  const ledger = await runPlan(parsePlan(`✓ ${payload}`).blocks!, f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(judge.requests.length, 1);
  assert.deepEqual(f.actions, []);
});

test('an exact id target ignores an element whose label equals the id', () => {
  const tap = (quoted: string, exact: 'id' | 'text') =>
    ({ kind: 'press', target: { quoted, phrase: quoted, exact } }) as const;
  const decoy = screen([
    element('@decoy', 'onboarding-done'),
    element('@done', 'Done', { testID: 'onboarding-done' }),
  ]);
  assert.deepEqual(prepareTarget(tap('onboarding-done', 'id'), decoy), {
    ref: '@done',
    element: decoy.elements[1],
  });
  assert.deepEqual(prepareTarget(tap('Done', 'text'), decoy), {
    ref: '@done',
    element: decoy.elements[1],
  });
  const missing = prepareTarget(
    tap('onboarding-done', 'id'),
    screen([element('@x', 'onboarding-done')]),
  );
  assert.equal('refuse' in missing && missing.refuse, 'REPLAY_SELECTOR');
  const offscreen = screen([element('@far', 'Far', { testID: 'far', offscreen: true })]);
  assert.deepEqual(prepareTarget(tap('far', 'id'), offscreen), { scroll: 'down' });
});

test('two exact matches refuse TARGET_AMBIGUOUS terminally without asking Jev', async () => {
  const judge = scriptedJudge(() => assert.fail('replay must never ask Jev'));
  const twins = screen([
    element('@a', 'Save', { testID: 'save' }),
    element('@b', 'Save', { testID: 'save' }),
  ]);
  for (const exact of ['id', 'text'] as const) {
    const quoted = exact === 'id' ? 'save' : 'Save';
    const result = await resolveTarget(
      { kind: 'press', target: { quoted, phrase: quoted, exact } },
      twins,
      judge,
    );
    assert.equal('refuse' in result && result.refuse, 'TARGET_AMBIGUOUS');
  }
  assert.equal(judge.calls.length, 0);
});

// Native nodes under one window, joined by the product screen builder.
function painted(nodes: Array<Omit<NativeNode, 'index'>>): Screen {
  const window = { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } };
  return joinScreen(
    [window, ...nodes].map((n, index) => ({ parentIndex: index ? 0 : undefined, ...n, index })),
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
}
const node = (type: string, label: string, y: number, extra: Partial<NativeNode> = {}) => ({
  ref: `@${type}${y}`,
  type,
  label,
  rect: { x: 16, y, width: 200, height: 20 },
  ...extra,
});
const exactText = (quoted: string) => ({ quoted, phrase: quoted, exact: 'text' as const });
const exactId = (quoted: string) => ({ quoted, phrase: quoted, exact: 'id' as const });
const containerEcho = painted([
  ...[1, 2, 3, 4].map((parentIndex) =>
    node('Other', 'Welcome', 100 + parentIndex, { parentIndex: parentIndex - 1 || 0 }),
  ),
  node('StaticText', 'Welcome', 120, { parentIndex: 4 }),
]);
const realMultiple = painted([
  node('StaticText', 'Welcome', 100),
  node('StaticText', 'Body', 200),
  node('StaticText', 'Welcome', 300),
]);

test('adjacent equal painted text refuses ambiguous replay and discovery', () => {
  const joined = painted([node('StaticText', 'Welcome', 100), node('StaticText', 'Welcome', 140)]);
  assert.deepEqual(joined.visibleText, ['Welcome']);
  assert.deepEqual(joined.paintedText, ['Welcome', 'Welcome']);
  assert.throws(
    () => targetVisible(exactText('Welcome'), joined),
    /TARGET_AMBIGUOUS: 2 identities match the stored text "Welcome"/,
  );
  assert.equal(visibleSelector({ quoted: 'Welcome', phrase: 'Welcome' }, joined), undefined);
});

test('equal painted buttons at different horizontal positions remain ambiguous', () => {
  const joined = painted([
    node('Button', 'Delete', 100),
    node('Button', 'Delete', 100, {
      ref: '@delete-right',
      rect: { x: 230, y: 100, width: 100, height: 20 },
    }),
  ]);
  assert.deepEqual(joined.visibleText, ['Delete']);
  assert.deepEqual(joined.paintedText, ['Delete', 'Delete']);
  assert.throws(
    () => targetVisible(exactText('Delete'), joined),
    /TARGET_AMBIGUOUS: 2 identities match the stored text "Delete"/,
  );
  assert.equal(visibleSelector({ quoted: 'Delete', phrase: 'Delete' }, joined), undefined);
});

test('a presence-less XCUI parent and child twin contributes one painted identity', () => {
  const joined = painted([
    node('StaticText', 'Welcome', 100),
    node('StaticText', 'Welcome', 100, { ref: '@welcome-child', parentIndex: 1 }),
  ]);
  assert.deepEqual(joined.visibleText, ['Welcome']);
  assert.deepEqual(joined.paintedText, ['Welcome']);
  assert.equal(targetVisible(exactText('Welcome'), joined), true);
  assert.deepEqual(visibleSelector({ quoted: 'Welcome', phrase: 'Welcome' }, joined), {
    text: 'Welcome',
  });
});

test('keyboard text replay preserves ancestor-echo deduplication and real occurrences', () => {
  const observed = (keyboard: boolean, y = 100, twin = false) =>
    painted([
      node('StaticText', 'Welcome', y),
      node('Other', '', y, { parentIndex: 1 }),
      node('StaticText', 'Welcome', y, { ref: '@echo', parentIndex: 2 }),
      ...(twin ? [node('StaticText', 'Welcome', 200, { ref: '@twin' })] : []),
      ...(keyboard
        ? [
            node('Keyboard', '', 500, {
              rect: { x: 0, y: 500, width: 390, height: 344 },
            }),
          ]
        : []),
    ]);
  const target = { quoted: 'Welcome', phrase: 'Welcome' };
  const saved = visibleSelector(target, observed(false));
  assert.deepEqual(saved, { text: 'Welcome' });
  const uncovered = observed(true);
  assert.deepEqual(uncovered.uncoveredText, ['Welcome']);
  assert.equal(targetVisible(exactText('Welcome'), uncovered), true);
  assert.deepEqual(visibleSelector(target, uncovered), saved);
  const covered = observed(true, 650);
  assert.deepEqual(covered.uncoveredText, []);
  assert.equal(visibleSelector(target, covered), undefined);
  assert.throws(() => targetVisible(exactText('Welcome'), covered), /REPLAY_SELECTOR/);
  const multiple = observed(true, 100, true);
  assert.deepEqual(multiple.uncoveredText, ['Welcome', 'Welcome']);
  assert.equal(visibleSelector(target, multiple), undefined);
  assert.throws(() => targetVisible(exactText('Welcome'), multiple), /TARGET_AMBIGUOUS/);
});

test('four container ancestors echoing one text contribute one painted identity', () => {
  assert.deepEqual(containerEcho.visibleText, ['Welcome']);
  assert.deepEqual(containerEcho.paintedText, ['Welcome']);
  assert.equal(targetVisible(exactText('Welcome'), containerEcho), true);
  assert.deepEqual(visibleSelector({ quoted: 'Welcome', phrase: 'Welcome' }, containerEcho), {
    text: 'Welcome',
  });
});

test('a stored text echoed by its container labels is one identity', () => {
  assert.equal(targetVisible(exactText('Welcome'), containerEcho), true);
  const sheet = painted([
    { ...node('Other', 'Sheet title', 400), rect: { x: 0, y: 400, width: 386, height: 395 } },
    node('StaticText', 'Sheet title', 420, { parentIndex: 1 }),
  ]);
  assert.equal(targetVisible(exactText('Sheet title'), sheet), true);
});

test('real visible multiples, zero matches and an offscreen twin keep their replay counts', () => {
  assert.throws(
    () => targetVisible(exactText('Welcome'), realMultiple),
    /TARGET_AMBIGUOUS: 2 identities match the stored text "Welcome"/,
  );
  assert.throws(
    () => targetVisible(exactText('Welcome'), painted([node('StaticText', 'Body', 100)])),
    /REPLAY_SELECTOR: 0 identities match the stored text "Welcome"/,
  );
  const twin = painted([node('StaticText', 'Welcome', 100), node('StaticText', 'Welcome', 1000)]);
  assert.equal(twin.elements.filter((e) => e.offscreen).length, 1);
  assert.equal(targetVisible(exactText('Welcome'), twin), true);
});

test('an onscreen carrier without a painted line still identifies its text', () => {
  const carrier = (y: number) => node('Other', 'Continue', y, { hittable: true });
  assert.deepEqual(painted([carrier(100)]).visibleText, []);
  assert.equal(targetVisible(exactText('Continue'), painted([carrier(100)])), true);
  assert.throws(
    () => targetVisible(exactText('Continue'), painted([carrier(100), carrier(200)])),
    /TARGET_AMBIGUOUS: 2 identities/,
  );
  assert.equal(
    targetVisible(exactText('Continue'), painted([node('Button', 'Continue', 100)])),
    true,
  );
  assert.throws(
    () =>
      targetVisible(
        exactText('Continue'),
        painted([
          node('Button', 'Continue', 100),
          node('StaticText', 'Body', 200),
          node('Button', 'Continue', 300),
        ]),
      ),
    /TARGET_AMBIGUOUS: 2 identities/,
  );
});

test('stored testIDs keep counting every element that carries them', () => {
  assert.throws(
    () =>
      targetVisible(
        exactId('save'),
        painted([
          node('Button', 'Save', 100, { identifier: 'save' }),
          node('Button', 'Save draft', 200, { identifier: 'save' }),
        ]),
      ),
    /TARGET_AMBIGUOUS: 2 identities match the stored id "save"/,
  );
  const far = painted([node('Button', 'Save', 1000, { identifier: 'save' })]);
  assert.equal(targetVisible(exactId('save'), far), false);
});

test('a visible text is stored only when replay would find exactly one identity', () => {
  const welcome = { quoted: 'Welcome', phrase: 'Welcome' };
  assert.deepEqual(visibleSelector(welcome, containerEcho), { text: 'Welcome' });
  assert.equal(visibleSelector(welcome, realMultiple), undefined);
  assert.deepEqual(
    visibleSelector(
      welcome,
      painted([node('StaticText', 'Welcome', 100, { identifier: 'home-title' })]),
    ),
    { id: 'home-title' },
  );
});

test('a visible label stores its testID only when no other identity shares it', () => {
  const sibling = { quoted: 'Sibling A', phrase: 'Sibling A' };
  const shared = painted([
    node('Button', 'Sibling A', 100, { identifier: 'qa-replay-siblings' }),
    node('Button', 'Sibling B', 200, { identifier: 'qa-replay-siblings' }),
  ]);
  assert.deepEqual(visibleSelector(sibling, shared), { text: 'Sibling A' });
  const sharedId = { quoted: 'qa-replay-siblings', phrase: 'qa-replay-siblings' };
  assert.equal(visibleSelector(sharedId, shared), undefined);
  assert.equal(targetVisible(exactText('Sibling A'), shared), true);
  const unique = painted([
    node('Button', 'Sibling A', 100, { identifier: 'qa-replay-a' }),
    node('Button', 'Sibling B', 200, { identifier: 'qa-replay-b' }),
  ]);
  assert.deepEqual(visibleSelector(sibling, unique), { id: 'qa-replay-a' });
});

test('native offscreen target frames choose up above the viewport and down otherwise', async () => {
  for (const [y, expected] of [
    [-50, 'up'],
    [900, 'down'],
    [-10, 'down'],
  ] as const) {
    const observed = joinScreen(
      [
        { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
        {
          ref: '@button',
          type: 'Button',
          identifier: 'save',
          label: 'Save',
          hittable: false,
          rect: { x: y === -10 ? -150 : 20, y, width: 100, height: 30 },
        },
      ],
      [],
      'app',
      { native: 'complete', react: 'complete' },
      undefined,
      {
        source: 'xcui-live',
        nodes: [
          { status: 'unknown', labelSource: 'none', unknownReason: 'not-hittable' },
          { status: 'unknown', labelSource: 'direct', unknownReason: 'clipped' },
        ],
      },
    );
    for (const target of [
      { phrase: 'Save', quoted: 'Save' },
      { phrase: 'save', quoted: 'save', exact: 'id' as const },
      { phrase: 'the Save button' },
    ]) {
      const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0) }));
      assert.deepEqual(await resolveTarget({ kind: 'press', target }, observed, judge), {
        scroll: expected,
      });
    }
  }
});
