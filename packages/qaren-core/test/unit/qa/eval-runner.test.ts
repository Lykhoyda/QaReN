import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { evaluateCase, evaluateSyntheticCase, type EvalCase } from '../../jev-evals/run.ts';
import { choice, element, screen, scriptedJudge } from './judgment-fixtures.ts';

const missingCheckCoverage = new Set([
  'failed-check.json',
  'protected-greeting-other-value.json',
  'protected-name-equal.json',
  'protected-name-property.json',
  'protected-name-unequal.json',
  'protected-pin-equal.json',
  'saved-check.json',
]);
const overBoundHeadings = new Set([
  'home-injected-title.json',
  'home-settings-heading.json',
  'home-welcome-heading.json',
  'home-wrong-title.json',
]);

function frozenAssertionRefusal(name: string) {
  if (missingCheckCoverage.has(name))
    return { kind: 'check', refuse: 'SCREEN_EVIDENCE_INCOMPLETE' };
  if (overBoundHeadings.has(name)) return { kind: 'visibility', refuse: 'CANDIDATE_LIMIT' };
  return undefined;
}

test('frozen Screens preserve quoted targeting but refuse missing assertion coverage and oversized evidence', async () => {
  const root = new URL('../../jev-evals/cases/', import.meta.url);
  const names = readdirSync(root).filter((n) => n.endsWith('.json'));
  const awaitingProvenance = new Set([
    'fill-name.json',
    'navigate-settings-tab.json',
    'no-match.json',
    'offscreen-load-more.json',
    'profile-target.json',
    'verb-fallback.json',
  ]);
  assert.equal(names.length, 18);
  assert.equal(missingCheckCoverage.size, 7);
  assert.equal(overBoundHeadings.size, 4);
  for (const name of [...missingCheckCoverage, ...overBoundHeadings])
    assert.ok(names.includes(name), name);
  for (const name of awaitingProvenance) assert.ok(names.includes(name), name);
  for (const name of names) {
    const fixture: EvalCase = JSON.parse(readFileSync(new URL(name, root), 'utf8'));
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (id.startsWith('verb')) return [id, choice(q, 'press')];
          if (q.type === 'noul')
            return [
              id,
              {
                type: 'noul',
                noul:
                  (fixture.expected.kind === 'check' && fixture.expected.verdict === 'pass') ||
                  (fixture.expected.kind === 'visibility' && fixture.expected.verdict === 'present')
                    ? 0.9
                    : 0.1,
              },
            ];
          const expected = fixture.expected;
          const candidates = fixture.screen.elements.filter(
            (e) => !fixture.line.startsWith('Type') || e.kind === 'input',
          );
          const index =
            expected.kind === 'target' && 'ref' in expected
              ? candidates.findIndex((e) => e.ref === expected.ref)
              : expected.kind === 'target' && 'scroll' in expected
                ? candidates.findIndex((e) => e.offscreen)
                : -1;
          return [id, choice(q, index < 0 ? 'none' : `e${index}`)];
        }),
      ),
    );
    const result = await evaluateCase(fixture, judge);
    const assertionRefusal = frozenAssertionRefusal(name);
    if (awaitingProvenance.has(name)) {
      assert.deepEqual(
        result,
        { pass: false, actual: { kind: 'target', refuse: 'SCREEN_EVIDENCE_INCOMPLETE' } },
        name,
      );
      assert.ok(
        judge.requests.every((request) =>
          Object.keys(request.questions).every((id) => id.startsWith('verb_')),
        ),
        `${name}: only verb parsing may call Jev before screen provenance is established`,
      );
    } else if (assertionRefusal) {
      assert.deepEqual(result, { pass: false, actual: assertionRefusal }, name);
      assert.equal(judge.requests.length, 0, name);
    } else {
      assert.equal(name, 'ambiguous-save.json');
      assert.deepEqual(result, { pass: true, actual: fixture.expected }, name);
      assert.equal(judge.requests.length, 0);
    }
    for (const value of fixture.typedValues ?? [])
      assert.ok(!JSON.stringify(judge.requests).includes(value), name);
  }
});

test('synthetic authored targets do not grant frozen assertions provenance or bypass the whole-claim bound', async () => {
  const root = new URL('../../jev-evals/cases/', import.meta.url);
  const names = readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.equal(names.length, 18);
  for (const name of names) {
    const fixture: EvalCase = JSON.parse(readFileSync(new URL(name, root), 'utf8'));
    const before = structuredClone(fixture.screen);
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (id.startsWith('verb_')) return [id, choice(q, 'press')];
          if (q.type === 'noul')
            return [
              id,
              {
                type: 'noul',
                noul:
                  (fixture.expected.kind === 'check' && fixture.expected.verdict === 'pass') ||
                  (fixture.expected.kind === 'visibility' && fixture.expected.verdict === 'present')
                    ? 0.9
                    : 0.1,
              },
            ];
          const expected = fixture.expected;
          const candidates = fixture.screen.elements.filter(
            (element) =>
              element.semantic?.visibility !== 'offscreen' &&
              (!fixture.line.startsWith('Type') || element.kind === 'input'),
          );
          const index =
            expected.kind === 'target' && 'ref' in expected
              ? candidates.findIndex((element) => element.ref === expected.ref)
              : -1;
          return [id, choice(q, index < 0 ? 'none' : `e${index}`)];
        }),
      ),
    );
    assert.deepEqual(
      await evaluateSyntheticCase(fixture, judge),
      frozenAssertionRefusal(name)
        ? { pass: false, actual: frozenAssertionRefusal(name) }
        : { pass: true, actual: fixture.expected },
      name,
    );
    assert.deepEqual(fixture.screen, before, `${name}: synthetic evaluation must not add evidence`);
    if (name === 'ambiguous-save.json') assert.equal(judge.requests.length, 0, name);
    if (
      [
        'fill-name.json',
        'navigate-settings-tab.json',
        'no-match.json',
        'offscreen-load-more.json',
        'profile-target.json',
        'verb-fallback.json',
      ].includes(name)
    ) {
      assert.ok(
        judge.requests.some(({ questions }) => Object.keys(questions).includes('target_1')),
        name,
      );
      assert.equal(fixture.screen.coverage, undefined, name);
    }
    const outbound = JSON.stringify(judge.requests);
    for (const value of fixture.typedValues ?? []) assert.ok(!outbound.includes(value), name);
    if (name === 'fill-name.json') {
      assert.ok(!outbound.includes('Sample Person'), name);
    }
  }
});

test('synthetic model questions mask private values appearing in authored descriptions', async () => {
  const fixture: EvalCase = {
    screen: screen([
      element('@name', 'Name', { kind: 'input', value: 'Sample Person' }),
      element('@email', 'Email', { kind: 'input', value: 'someone@example.com' }),
    ]),
    line: 'Type "Sample Person" into the name field',
    expected: { kind: 'target', ref: '@name' },
  };
  const judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  assert.deepEqual(await evaluateSyntheticCase(fixture, judge), {
    pass: true,
    actual: fixture.expected,
  });
  const outbound = JSON.stringify(judge.requests);
  assert.ok(!outbound.includes('Sample Person'));
  assert.ok(!outbound.includes('someone@example.com'));
  assert.match(outbound, /\[QAREN_VALUE_1\]/);
  assert.match(outbound, /\[QAREN_VALUE_2\]/);
});

test('synthetic phrase choices expose descriptions and none, scroll offscreen, and refuse unsure answers', async () => {
  const fixture: EvalCase = {
    screen: {
      front: 'app',
      elements: [
        element('@save', 'Save'),
        element('react:more', 'Load more', { offscreen: true, hittable: false }),
      ],
      visibleText: [],
    },
    line: 'Tap the load more control',
    expected: { kind: 'target', scroll: 'down' },
  };
  const scrollJudge = scriptedJudge((questions) => ({
    target_1: choice(questions.target_1, 'none'),
  }));
  assert.deepEqual(await evaluateSyntheticCase(fixture, scrollJudge), {
    pass: true,
    actual: fixture.expected,
  });
  const { state, questions } = scrollJudge.requests[0];
  assert.deepEqual(Object.keys(questions.target_1.criteria!), ['e0', 'none']);
  assert.deepEqual(state, {
    front: 'app',
    elements: ['Button "Save"'],
  });

  const unsureJudge = scriptedJudge((questions) => ({
    target_1: choice(questions.target_1, 'none', { e0: 0.5, none: 0.5 }),
  }));
  assert.deepEqual(await evaluateSyntheticCase(fixture, unsureJudge), {
    pass: false,
    actual: { kind: 'target', refuse: 'TARGET_UNSURE' },
  });
  const narrowJudge = scriptedJudge((questions) => ({
    target_1: choice(questions.target_1, 'none', { e0: 0.43, none: 0.57 }),
  }));
  assert.deepEqual(await evaluateSyntheticCase(fixture, narrowJudge), {
    pass: false,
    actual: { kind: 'target', refuse: 'TARGET_UNSURE' },
  });
  const noMatch: EvalCase = {
    ...fixture,
    screen: screen([element('@save', 'Save')]),
    expected: { kind: 'target', refuse: 'TARGET_NOT_FOUND' },
  };
  const noneJudge = scriptedJudge((questions) => ({
    target_1: choice(questions.target_1, 'none'),
  }));
  assert.deepEqual(await evaluateSyntheticCase(noMatch, noneJudge), {
    pass: true,
    actual: noMatch.expected,
  });
  const emptyJudge = scriptedJudge(() => {
    throw new Error('no eligible candidate should skip the model');
  });
  assert.deepEqual(await evaluateSyntheticCase({ ...noMatch, screen: screen([]) }, emptyJudge), {
    pass: true,
    actual: noMatch.expected,
  });
});

test('explicit synthetic evidence exercises semantic eval targets, fills, scrolling, no-match and verb fallback', async () => {
  const tabs = screen([element('@home', 'Home'), element('@profile', 'Profile')]);
  const cases: { fixture: EvalCase; selected: string }[] = [
    {
      fixture: {
        screen: tabs,
        line: 'Open the profile tab',
        expected: { kind: 'target', ref: '@profile' },
      },
      selected: 'e1',
    },
    {
      fixture: {
        screen: screen([
          element('@name', 'Full name', { kind: 'input' }),
          element('@email', 'Email address', { kind: 'input' }),
        ]),
        line: 'Type "private-fill-value" into the name field',
        typedValues: ['private-fill-value'],
        expected: { kind: 'target', ref: '@name' },
      },
      selected: 'e0',
    },
    {
      fixture: {
        screen: screen([
          element('@back', 'Back'),
          element('react:more', 'Load more', { offscreen: true, hittable: false }),
        ]),
        line: 'Tap the load more control',
        expected: { kind: 'target', scroll: 'down' },
      },
      selected: 'none',
    },
    {
      fixture: {
        screen: screen([element('@cancel', 'Cancel'), element('@help', 'Help')]),
        line: 'Tap the save button',
        expected: { kind: 'target', refuse: 'TARGET_NOT_FOUND' },
      },
      selected: 'none',
    },
    {
      fixture: {
        screen: tabs,
        line: 'Visit the profile tab',
        expected: { kind: 'target', refuse: 'TARGET_NOT_FOUND' },
      },
      selected: 'e1',
    },
  ];
  for (const { fixture, selected } of cases) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          choice(q, id.startsWith('verb_') ? 'press' : selected),
        ]),
      ),
    );
    assert.deepEqual(await evaluateCase(fixture, judge), { pass: true, actual: fixture.expected });
    assert.deepEqual(
      judge.calls.map((call) => call.questionIds),
      fixture.line.startsWith('Visit') ? [['verb_1'], ['target_1']] : [['target_1']],
    );
    for (const value of fixture.typedValues ?? [])
      assert.ok(!JSON.stringify(judge.requests).includes(value), fixture.line);
  }
});

test('eval mismatches are failures and a complete empty-screen check is re-asked only once', async () => {
  const fixture: EvalCase = {
    screen: screen([]),
    line: '✓ Ready',
    expected: { kind: 'check', verdict: 'pass' },
  };
  const judge = scriptedJudge((q) =>
    Object.fromEntries(Object.keys(q).map((id) => [id, { type: 'noul', noul: 0.5 }])),
  );
  assert.deepEqual(await evaluateCase(fixture, judge), {
    pass: false,
    actual: { kind: 'check', verdict: 'unsure' },
  });
  assert.equal(judge.requests.length, 2);
});

test('bounded qualified-heading evals compare the wait verdict and re-ask uncertainty once', async () => {
  const fixture: EvalCase = {
    screen: screen([
      element('@title', 'Welcome', {
        kind: 'text',
        semantic: {
          press: 'unsupported',
          fill: 'unsupported',
          visibility: 'visible',
          nativePresence: { kind: 'text', labelSource: 'direct', structural: false },
          heading: { kind: 'declared-heading', hostIndex: 0, anchorRef: '@title', bodyRefs: [] },
        },
      }),
    ]),
    line: 'Wait for the welcome heading',
    expected: { kind: 'visibility', verdict: 'present' },
  };
  const answering = (nouls: number[]) => {
    let call = 0;
    return scriptedJudge((questions) =>
      Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul', noul: nouls[call++] ?? 0.5 }]),
      ),
    );
  };
  assert.deepEqual(await evaluateCase(fixture, answering([0.9])), {
    pass: true,
    actual: { kind: 'visibility', verdict: 'present' },
  });
  assert.deepEqual(await evaluateCase(fixture, answering([0.1])), {
    pass: false,
    actual: { kind: 'visibility', verdict: 'pending' },
  });
  const unsure = answering([0.5, 0.9]);
  assert.deepEqual(await evaluateCase(fixture, unsure), {
    pass: true,
    actual: { kind: 'visibility', verdict: 'present' },
  });
  assert.equal(unsure.requests.length, 2);
});

test('eval check refusals stay refusals rather than becoming verdict objects or model re-asks', async () => {
  const fixture: EvalCase = {
    screen: { front: 'app', elements: [], visibleText: [] },
    line: '✓ Ready',
    expected: { kind: 'check', verdict: 'pass' },
  };
  const judge = scriptedJudge(() => assert.fail('missing coverage cannot reach the model'));
  assert.deepEqual(await evaluateCase(fixture, judge), {
    pass: false,
    actual: { kind: 'check', refuse: 'SCREEN_EVIDENCE_INCOMPLETE' },
  });
  assert.equal(judge.requests.length, 0);
});
