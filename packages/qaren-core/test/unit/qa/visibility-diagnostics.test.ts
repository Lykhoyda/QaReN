import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, semanticActionView, visibilityView } from '../../../dist/qa/screen.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { WalkerTimingDiagnostic } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const refusal = {
  refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
  reason: 'no established assertion contribution is available',
};
const wait = { kind: 'wait' as const, target: { phrase: 'the heading' }, line: 1 };

function joined(unknownReason?: string) {
  return join(
    [
      { ref: 'PRIVATE-root-ref', type: 'Application' },
      {
        ref: 'PRIVATE-blocker-ref',
        type: 'Other',
        identifier: 'PRIVATE-id',
        label: 'PRIVATE-label',
        value: 'PRIVATE-native-value',
        rect: { x: 123456, y: 234567, width: 345678, height: 456789 },
      },
      { ref: 'PRIVATE-later-ref', type: 'Button', label: 'PRIVATE-later-label' },
    ],
    [
      {
        role: 'button',
        testID: 'PRIVATE-id',
        value: 'PRIVATE-digest-value',
        placeholder: 'PRIVATE-placeholder',
      },
    ],
    'app',
    { native: 'complete', react: 'complete' },
    {
      complete: true,
      hosts: [
        {
          nativeID: 'PRIVATE-host-id',
          role: null,
          roleSource: 'none',
          capabilities: { press: true, fill: true },
        },
      ],
    },
    {
      source: 'xcui-live',
      nodes: [
        { status: 'unknown', labelSource: 'none' },
        Object.assign(
          { status: 'unknown' as const, labelSource: 'direct' as const },
          { unknownReason },
        ),
        { status: 'unknown', labelSource: 'direct' },
      ],
    },
  );
}

test('join → resolve → walker reports only the first visibility blocker without changing the refusal', async () => {
  const screen = joined();
  const before = JSON.stringify(screen);
  const judge = scriptedJudge(() => assert.fail('incomplete visibility must not reach Jev'));
  assert.deepEqual(visibilityView(screen), {
    elements: [],
    unknown: screen.elements.slice(1).map((element) => ({ element, reason: 'visibility' })),
    unassociatedReact: 0,
  });
  for (const operation of ['press', 'fill'] as const) {
    const action = semanticActionView(screen, operation);
    assert.ok('refuse' in action);
    assert.equal(action.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  }
  assert.deepEqual((await decideScreen(screen, judge, undefined, wait)).visibility, refusal);
  const baseline = walker([screen], judge);
  const expected = await runPlan(parsePlan('1. Wait for the heading').blocks!, baseline.deps);
  const events: WalkerTimingDiagnostic[] = [];
  const f = walker([{ ...screen }], judge);
  f.deps.diagnostic = (event) => events.push(event);
  const actual = await runPlan(parsePlan('1. Wait for the heading').blocks!, f.deps);
  assert.deepEqual(actual, expected);
  assert.equal(actual.verdict, 'FAIL');
  assert.equal(actual.steps[0].reason, `${refusal.refuse}: ${refusal.reason}`);
  assert.deepEqual(f.actions, []);
  assert.equal(f.captures(), 1);
  assert.equal(judge.requests.length, 0);
  const blockers = events.filter((event) => event.visibilityBlocker !== undefined);
  assert.equal(blockers.length, 1);
  assert.deepEqual(blockers[0], {
    line: 1,
    observation: 1,
    stage: 'decision',
    code: 'SCREEN_EVIDENCE_INCOMPLETE',
    at: 0,
    acquisitionMs: 0,
    observationAgeMs: 0,
    visibilityBlocker: {
      ordinal: 1,
      kind: 'other',
      nativePresence: true,
      nativeStatus: 'unknown',
      visibility: 'unknown',
      press: 'unknown',
      fill: 'unknown',
      labelSource: 'direct',
      structural: false,
      fields: {
        label: { defined: true, nonempty: true },
        value: { defined: true, nonempty: true },
        placeholder: { defined: true, nonempty: true },
        identifier: { defined: true, nonempty: true },
      },
      semanticUnassociatedReact: 0,
      pressGapCount: 1,
      fillGapCount: 1,
      gapHosts: {
        total: 1,
        truncated: false,
        rows: [
          {
            hostOrdinal: 0,
            hostKind: 'unknown',
            capabilities: { press: true, fill: true },
            roleCategory: 'none',
            testIDPresent: false,
            nativeIDPresent: true,
            hidden: false,
            rectStatus: 'unknown',
            pressGap: true,
            fillGap: true,
            association: {
              identity: 'evidence-unavailable',
              nativeIdentityCandidateCount: null,
              compatibleCount: null,
              sameFrameCount: null,
              presenceProofCount: null,
              ancestorPath: 'not-evaluated',
              collisions: null,
            },
          },
        ],
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|123456|234567|345678|456789/);
  assert.doesNotMatch(JSON.stringify(actual), /visibilityBlocker|pressGapCount|fillGapCount/);
  assert.equal(JSON.stringify(screen), before);
});

test('optional resolver diagnostics distinguish absent, empty and nonempty joined fields', async () => {
  for (const value of [undefined, '', ' \t', 'PRIVATE-content']) {
    const screen = joined();
    Object.assign(screen.elements[1], { label: value, value, placeholder: value, testID: value });
    const judge = scriptedJudge(() => assert.fail('refusal must not ask'));
    const decision = await decideScreen(
      screen,
      judge,
      undefined,
      wait,
      [],
      undefined,
      undefined,
      true,
    );
    assert.ok(decision.visibility && 'refuse' in decision.visibility);
    assert.equal(decision.visibility.reason, refusal.reason);
    const flags = { defined: value !== undefined, nonempty: value === 'PRIVATE-content' };
    assert.deepEqual(decision.visibility.diagnostic?.fields, {
      label: flags,
      value: flags,
      placeholder: flags,
      identifier: flags,
    });
    assert.equal(judge.requests.length, 0);
    assert.doesNotMatch(JSON.stringify(decision), /PRIVATE-/);
  }
});

test('native unknown reasons reach only the existing blocker diagnostic without changing refusal', async () => {
  const judge = scriptedJudge(() => assert.fail('unknown presence must not ask Jev'));
  const baseline = walker([joined()], judge);
  const plan = parsePlan('1. Wait for the heading').blocks!;
  const expected = await runPlan(plan, baseline.deps);
  for (const reason of [
    'empty-frame',
    'clipped',
    'ambiguous-descriptor',
    'not-hittable',
    'read-unavailable',
    'match-count-mismatch',
    'post-hit-mismatch',
    'PRIVATE-reason',
  ]) {
    const screen = joined(reason);
    assert.doesNotMatch(JSON.stringify(screen), /unknownReason|nativeUnknownReason/);
    assert.deepEqual(visibilityView(screen), {
      elements: [],
      unknown: screen.elements.slice(1).map((element) => ({ element, reason: 'visibility' })),
      unassociatedReact: 0,
    });
    const events: WalkerTimingDiagnostic[] = [];
    const f = walker([screen], judge);
    f.deps.diagnostic = (event) => events.push(event);
    const result = await runPlan(plan, f.deps);
    assert.deepEqual(result, expected);
    assert.deepEqual(f.actions, []);
    assert.equal(f.captures(), 1);
    assert.equal(judge.requests.length, 0);
    const blocker = events.find((event) => event.visibilityBlocker)!.visibilityBlocker!;
    assert.equal(blocker.nativeUnknownReason, reason === 'PRIVATE-reason' ? undefined : reason);
    assert.equal(blocker.nativeStatus, 'unknown');
    assert.equal(blocker.visibility, 'unknown');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE-/);
    assert.doesNotMatch(JSON.stringify(result), /unknownReason|nativeUnknownReason/);
  }
});

test('diagnostics allowlist enum facts and never serialize arbitrary observation properties', async () => {
  const screen = joined();
  const element = screen.elements[1];
  Object.assign(element, {
    kind: 'PRIVATE-kind',
    componentName: 'PRIVATE-component',
    hash: 'PRIVATE-hash',
  });
  Object.assign(element.semantic!, {
    visibility: 'PRIVATE-visibility',
    press: 'PRIVATE-press',
    fill: 'PRIVATE-fill',
  });
  Object.assign(element.semantic!.nativePresence!, {
    labelSource: 'PRIVATE-source',
  });
  Object.assign(screen, { semanticUnassociatedReact: 'PRIVATE-count' });
  const judge = scriptedJudge(() => assert.fail('refusal must not ask'));
  const events: WalkerTimingDiagnostic[] = [];
  const f = walker([screen], judge);
  f.deps.diagnostic = (event) => events.push(event);
  const result = await runPlan(parsePlan('1. Wait for the heading').blocks!, f.deps);
  assert.equal(result.steps[0].reason, `${refusal.refuse}: ${refusal.reason}`);
  const diagnostic = events.find((event) => event.visibilityBlocker)?.visibilityBlocker;
  assert.ok(diagnostic);
  for (const key of ['kind', 'visibility', 'press', 'fill', 'labelSource'] as const)
    assert.equal(diagnostic[key], 'unknown');
  assert.equal(diagnostic.structural, false);
  assert.equal(diagnostic.semanticUnassociatedReact, undefined);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-/);
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.length, 0);
});

test('throwing diagnostic sinks cannot change the walker refusal or leak the exception', async () => {
  const screen = joined();
  const judge = scriptedJudge(() => assert.fail('refusal must not ask'));
  const baseline = walker([screen], judge);
  const expected = await runPlan(parsePlan('1. Wait for the heading').blocks!, baseline.deps);
  const f = walker([screen], judge);
  let witnesses = 0;
  f.deps.diagnostic = (event) => {
    if (event.visibilityBlocker) witnesses++;
    throw new Error('PRIVATE-sink-error');
  };
  const actual = await runPlan(parsePlan('1. Wait for the heading').blocks!, f.deps);
  assert.deepEqual(actual, expected);
  assert.equal(witnesses, 1);
  assert.deepEqual(f.actions, []);
  assert.equal(f.captures(), 1);
  assert.equal(judge.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE-sink-error/);
});

test('diagnostic construction failure preserves the original assertion contributions', () => {
  const screen = joined();
  Object.defineProperty(screen.elements[1], 'kind', {
    get() {
      throw new Error('PRIVATE-diagnostic-error');
    },
  });
  assert.deepEqual(visibilityView(screen, true), {
    elements: [],
    unknown: screen.elements.slice(1).map((element) => ({ element, reason: 'visibility' })),
    unassociatedReact: 0,
  });
});

test('coverage refuses without a diagnostic while other evidence gaps retain their first witness', async () => {
  const coverage = joined();
  coverage.coverage!.react = 'incomplete';
  const unassociated = joined();
  unassociated.semanticUnassociatedReact = 1;
  const derived = joined();
  derived.elements[1].semantic!.visibility = 'visible';
  derived.elements[1].semantic!.nativePresence!.labelSource = 'value';
  for (const screen of [coverage, unassociated, derived]) {
    const judge = scriptedJudge(() => assert.fail('refusal must not ask'));
    const events: WalkerTimingDiagnostic[] = [];
    const f = walker([screen], judge);
    f.deps.diagnostic = (event) => events.push(event);
    const result = await runPlan(parsePlan('1. Wait for the heading').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    const projected = visibilityView(screen, true);
    if (screen === coverage) {
      assert.ok('refuse' in projected);
      assert.notEqual(result.steps[0].reason, `${refusal.refuse}: ${refusal.reason}`);
      assert.ok(events.every((event) => event.visibilityBlocker === undefined));
    } else {
      assert.ok('elements' in projected);
      assert.deepEqual(projected.elements, []);
      assert.deepEqual(projected.unknown, [
        {
          element: screen.elements[1],
          reason: screen === derived ? 'name-provenance' : 'visibility',
        },
        { element: screen.elements[2], reason: 'visibility' },
      ]);
      assert.equal(projected.unassociatedReact, screen === unassociated ? 1 : 0);
      assert.equal(result.steps[0].reason, `${refusal.refuse}: ${refusal.reason}`);
      const blockers = events.filter((event) => event.visibilityBlocker);
      assert.equal(blockers.length, 1);
      assert.deepEqual(blockers[0].visibilityBlocker, projected.diagnostic);
      assert.equal(projected.diagnostic?.ordinal, 1);
      assert.equal(projected.diagnostic?.visibility, screen === derived ? 'visible' : 'unknown');
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE-/);
    }
    assert.deepEqual(f.actions, []);
    assert.equal(judge.requests.length, 0);
  }
});

test('successful presence keeps diagnostic facts and capture gap counts out of the model and public rows', async () => {
  const screen = join(
    [{ ref: '@e0', type: 'Button', label: 'Continue' }],
    [],
    'app',
    { native: 'complete', react: 'complete' },
    { complete: true, hosts: [] },
    { source: 'xcui-live', nodes: [{ status: 'observed', labelSource: 'direct' }] },
  );
  const before = JSON.stringify(screen);
  const judge = scriptedJudge((questions, _index, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.deepEqual(state, {
      front: 'app',
      assertionEvidence: {
        observed: ['Button "Continue" (native accessibility name; platform-observed presence)'],
        unknown: [],
        unassociatedReact: 0,
        qualifiedHeadings: [],
      },
    });
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  const events: WalkerTimingDiagnostic[] = [];
  const f = walker([screen], judge);
  f.deps.diagnostic = (event) => events.push(event);
  const result = await runPlan(parsePlan('1. Wait for the continue control').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(judge.requests.length, 1);
  assert.ok(events.every((event) => event.visibilityBlocker === undefined));
  assert.equal(JSON.stringify(screen), before);
  assert.equal(screen.pressGapCount, 0);
  assert.equal(screen.fillGapCount, 0);
  assert.doesNotMatch(before, /diagnostic|nativeStatus/);
  assert.doesNotMatch(
    JSON.stringify({ result, rows: f.rows }),
    /pressGapCount|fillGapCount|diagnostic|nativeStatus/,
  );
  assert.deepEqual(f.actions, []);
});

test('an established witness admits unknown labels but never their values, frames or diagnostics to the model', async () => {
  for (const reason of ['visibility', 'name-provenance', 'content'] as const) {
    const screen = joined('not-hittable');
    screen.elements[2].label = 'Continue';
    screen.elements[2].semantic!.visibility = 'visible';
    if (reason !== 'visibility') screen.elements[1].semantic!.visibility = 'visible';
    if (reason === 'name-provenance')
      screen.elements[1].semantic!.nativePresence!.labelSource = 'value';
    const projection = visibilityView(screen, true);
    assert.ok('elements' in projection);
    assert.deepEqual(projection.elements, [screen.elements[2]]);
    assert.deepEqual(projection.unknown, [{ element: screen.elements[1], reason }]);
    assert.equal(projection.unassociatedReact, 0);
    assert.equal(projection.diagnostic?.ordinal, 1);
    const action = semanticActionView(screen, 'press');
    assert.ok('refuse' in action);
    assert.equal(action.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
    const judge = scriptedJudge((questions, _, state) => {
      assert.deepEqual(Object.keys(questions), ['check_1', 'visibility_2']);
      assert.deepEqual(state, {
        front: 'app',
        assertionEvidence: {
          observed: ['Button "Continue" (native accessibility name; platform-observed presence)'],
          unknown: [
            {
              description:
                reason === 'name-provenance'
                  ? 'Other [testID PRIVATE-id]'
                  : 'Other "PRIVATE-label" [testID PRIVATE-id]',
              reason,
            },
          ],
          unassociatedReact: 0,
          qualifiedHeadings: [],
        },
      });
      assert.doesNotMatch(
        JSON.stringify({ questions, state }),
        /PRIVATE-(?:native-value|digest-value|placeholder|blocker-ref|host-id)|123456|234567|345678|456789|diagnostic|gapHosts|not-hittable/,
      );
      return { check_1: { type: 'noul', noul: 0.99 }, visibility_2: { type: 'noul', noul: 0.99 } };
    });
    const result = await decideScreen(
      screen,
      judge,
      { kind: 'check', literal: false, text: 'Continue is visible', line: 1 },
      { kind: 'wait', target: { phrase: 'Continue' }, line: 2 },
      [],
      undefined,
      undefined,
      true,
    );
    assert.equal(result.check, 'pass');
    assert.deepEqual(result.visibility, { verdict: 'present' });
    assert.equal(judge.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /diagnostic|gapHosts|PRIVATE-/);
  }
});
