import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';
import { targetMissDiagnostic } from '../../../dist/qa/target-miss.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { createWriter } from '../../../dist/qa/wire.js';
import { exactIdentities } from '../../../dist/qa/identity.js';

const frame = { x: 0, y: 0, width: 402, height: 874 };
const target = { phrase: 'Add coverage', quoted: 'Add coverage' };

function nodes(android: boolean, siblings = 1): NativeNode[] {
  return [
    { ref: '@app', type: 'Application', rect: frame },
    { ref: '@win', parentIndex: 0, type: 'Window', rect: frame },
    {
      ref: '@scroll',
      parentIndex: 1,
      type: android ? 'android.widget.ScrollView' : 'ScrollView',
      identifier: 'coverage-list',
      label: 'Your coverage, Add coverage, Details',
      hittable: true,
      rect: frame,
    },
    ...Array.from({ length: siblings }, (_, i) => ({
      ref: `@card${i}`,
      parentIndex: 2,
      type: android ? 'android.view.ViewGroup' : 'Other',
      label: 'Add coverage, Details',
      hittable: true,
      rect: { x: 21, y: 311 + i * 100, width: 360, height: 64 },
    })),
  ];
}

function aggregate(screen: Screen): Screen {
  screen.elements[2].semantic!.nativePresence = {
    kind: 'other',
    labelSource: 'descendant',
    structural: false,
  };
  return screen;
}

for (const android of [false, true]) {
  const platform = android ? 'Android' : 'iOS';
  for (const labelSource of ['descendant', 'direct', 'none'] as const) {
    test(`${platform}: runPlan acquires ${labelSource} label provenance for a quoted press`, async () => {
      const f = walker(
        [],
        scriptedJudge(() => assert.fail('quoted target must be model-free')),
      );
      const requested: boolean[] = [];
      f.deps.captureScreen = (options) =>
        captureScreen({
          appId: 'com.test',
          requirePrivateInputs: true,
          platformPresence: options?.platformPresence,
          now: () => 0,
          native: async (presenceBudgetMs) => {
            requested.push(options?.platformPresence === true);
            const tree = nodes(android).map((node, index) => ({
              ...node,
              ...(android && index === 2 && labelSource === 'descendant' ? { label: '' } : {}),
              index,
              depth: index,
              enabled: true,
              presence: {
                captureId: 'capture-7',
                generation: 7,
                nodeIndex: index,
                status: 'observed',
                observedUptimeMs: 150,
                labelSource: index === 2 ? labelSource : 'direct',
              },
            }));
            return {
              ...attested(tree),
              ...(options?.platformPresence
                ? {
                    snapshotGeneration: 7,
                    presenceCapture: {
                      ...nativeCapture().presenceCapture,
                      appliedBudgetMs: presenceBudgetMs,
                      ...(android
                        ? {
                            source: 'android-a11y-live',
                            enumeration: 'app-windows',
                            pointScale: 1,
                          }
                        : {}),
                    },
                  }
                : {}),
            };
          },
          react: async () => ({ interactive: [] }),
        }).then((screen) => {
          if (android && labelSource === 'descendant' && options?.platformPresence)
            assert.equal(screen.elements[2].label, 'Add coverage, Details');
          return screen;
        });
      const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
      assert.ok(requested.length > 0);
      assert.equal(requested[0], false);
      assert.ok(requested.includes(true), 'the container candidate must request provenance');
      if (labelSource === 'descendant') {
        assert.equal(result.verdict, 'PASS', result.failure?.seen);
        assert.deepEqual(f.actions, ['press @card0']);
      } else {
        assert.notEqual(result.verdict, 'PASS');
        assert.match(result.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
        assert.deepEqual(f.actions, []);
      }
    });
  }
  for (const scroll of [false, true]) {
    for (const identified of [false, true]) {
      for (const quoted of [target.quoted, 'Add coverage, Details']) {
        test(`${platform}: unknown parent provenance preserves ambiguity, scroll=${scroll}, identified=${identified}, target=${quoted}`, () => {
          const tree = nodes(android);
          if (!scroll) tree[2].type = android ? 'android.view.ViewGroup' : 'Other';
          if (!identified) delete tree[2].identifier;
          tree[2].label = tree[3].label;
          tree[3].type = android ? 'android.widget.Button' : 'Button';
          const screen = join(tree, []);
          const named = { phrase: quoted, quoted };
          for (const purpose of ['action', 'refresh'] as const)
            assert.equal(exactIdentities(screen, named, 'press', purpose).length, 2);
          const result = prepareTarget({ kind: 'press', target: named }, screen);
          assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS');
        });
      }
    }
  }
  test(`${platform}: an identified aggregated scroll container does not compete with its unidentified card`, () => {
    const result = prepareTarget({ kind: 'press', target }, aggregate(join(nodes(android), [])));
    assert.ok('ref' in result, JSON.stringify(result));
    assert.equal(result.ref, '@card0');
  });

  test(`${platform}: two distinct cards still refuse as ambiguous`, () => {
    const result = prepareTarget({ kind: 'press', target }, aggregate(join(nodes(android, 2), [])));
    assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS', JSON.stringify(result));
  });

  for (const quoted of [target.quoted, 'Add coverage, Details']) {
    for (const identified of [false, true]) {
      test(`${platform}: directly labelled parent and child stay ambiguous for ${quoted}, identified=${identified}`, () => {
        const tree = nodes(android);
        tree[2].type = android ? 'android.view.ViewGroup' : 'Other';
        tree[2].label = tree[3].label;
        if (!identified) delete tree[2].identifier;
        tree[3].type = android ? 'android.widget.Button' : 'Button';
        const screen = join(tree, []);
        screen.elements[2].semantic!.nativePresence = {
          kind: 'other',
          labelSource: 'direct',
          structural: false,
        };
        const named = { phrase: quoted, quoted };
        for (const purpose of ['action', 'refresh'] as const)
          assert.equal(exactIdentities(screen, named, 'press', purpose).length, 2);
        const result = prepareTarget({ kind: 'press', target: named }, screen);
        assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS');
      });
    }
  }

  test(`${platform}: an unidentified label source on an ordinary parent cannot prove aggregation`, () => {
    const tree = nodes(android);
    tree[2].type = android ? 'android.view.ViewGroup' : 'Other';
    tree[2].label = tree[3].label;
    tree[3].type = android ? 'android.widget.Button' : 'Button';
    const result = prepareTarget({ kind: 'press', target }, join(tree, []));
    assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS');
  });

  for (const scroll of [false, true]) {
    for (const labelSource of ['direct', 'descendant'] as const) {
      test(`${platform}: ${labelSource} provenance governs suppression with scroll=${scroll}`, () => {
        const tree = nodes(android);
        if (!scroll) tree[2].type = android ? 'android.view.ViewGroup' : 'Other';
        const screen = join(tree, []);
        screen.elements[2].semantic!.nativePresence = {
          kind: 'other',
          labelSource,
          structural: false,
        };
        const result = prepareTarget({ kind: 'press', target }, screen);
        if (labelSource === 'descendant') {
          assert.ok('ref' in result);
          assert.equal(result.ref, '@card0');
        } else {
          assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS');
        }
      });
    }
  }

  test(`${platform}: the innermost bare card wins when both full labels equal the target`, () => {
    const tree = nodes(android);
    tree[2].label = tree[3].label = target.quoted;
    const result = prepareTarget({ kind: 'press', target }, aggregate(join(tree, [])));
    assert.ok('ref' in result, JSON.stringify(result));
    assert.equal(result.ref, '@card0');
  });

  test(`${platform}: explicit scroll identifiers remain selectable`, () => {
    const result = prepareTarget(
      { kind: 'press', target: { phrase: 'coverage-list', quoted: 'coverage-list', exact: 'id' } },
      join(nodes(android), []),
    );
    assert.ok('ref' in result);
    assert.equal(result.ref, '@scroll');
  });

  for (const shape of [
    'sibling',
    'outside',
    'unhittable',
    'missing-frame',
    'invalid-frame',
  ] as const) {
    test(`${platform}: ${shape} evidence cannot prove a container echo`, () => {
      const tree = nodes(android);
      if (shape === 'sibling') tree[3].parentIndex = 1;
      if (shape === 'outside') tree[3].rect!.x = 450;
      if (shape === 'unhittable') tree[3].hittable = false;
      if (shape === 'missing-frame') delete tree[3].rect;
      if (shape === 'invalid-frame') tree[3].rect!.width = NaN;
      const result = prepareTarget({ kind: 'press', target }, aggregate(join(tree, [])));
      assert.ok(!('ref' in result) || result.ref !== '@card0', JSON.stringify(result));
      if (shape === 'sibling')
        assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS');
    });
  }

  test(`${platform}: failed scroll distinguishes a target only inside a larger label`, async () => {
    const screen = join(nodes(android), []);
    const f = walker(
      [screen],
      scriptedJudge(() => assert.fail('quoted target must be model-free')),
    );
    const diagnostics: unknown[] = [];
    f.deps.targetMiss = (event) => diagnostics.push(event);
    f.deps.captureScreen = () =>
      captureScreen({
        requirePrivateInputs: true,
        now: () => 0,
        native: async () => attested(nodes(android)),
        react: async () => ({ interactive: [] }),
      });
    const result = await runPlan(parsePlan('1. Scroll down until "Add coverage"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(JSON.stringify(result), /only-in-aggregated-label/);
    assert.equal(diagnostics.length, 1);
    assert.match(JSON.stringify(diagnostics), /Your coverage, Add coverage, Details/);
    assert.doesNotMatch(JSON.stringify(result), /Your coverage, Add coverage, Details/);
  });

  for (const kind of ['wait', 'scroll'] as const) {
    for (const expected of ['absent', 'not-scrollable', 'only-in-aggregated-label'] as const) {
      if (kind === 'wait' && expected === 'not-scrollable') continue;
      test(`${platform}: failed ${kind} classifies ${expected}`, async () => {
        const tree = nodes(android);
        if (expected !== 'only-in-aggregated-label')
          tree.forEach((node) => {
            delete node.label;
          });
        if (expected === 'not-scrollable')
          tree[2].type = android ? 'android.view.ViewGroup' : 'Other';
        const f = walker(
          [],
          scriptedJudge(() => assert.fail('quoted target must be model-free')),
        );
        const diagnostics: unknown[] = [];
        f.deps.targetMiss = (event) => diagnostics.push(event);
        f.deps.captureScreen = () =>
          captureScreen({
            requirePrivateInputs: true,
            now: () => 0,
            native: async () => attested(tree),
            react: async () => ({ interactive: [] }),
          });
        const result = await runPlan(
          parsePlan(
            kind === 'wait' ? '1. Wait for "Add coverage"' : '1. Scroll down until "Add coverage"',
          ).blocks!,
          f.deps,
        );
        assert.equal(result.verdict, 'FAIL');
        assert.equal(diagnostics.length, 1);
        assert.equal((diagnostics[0] as { reason: string }).reason, expected);
        assert.match(JSON.stringify(result), new RegExp(`target visibility: ${expected}`));
      });
    }
  }
}

for (const [label, match, reason, aggregated] of [
  ['Policy 12, Details', 'near', 'absent', false],
  ['policy-12, Details', 'near', 'absent', false],
  ['Policy-12, Details', 'inside-label', 'only-in-aggregated-label', true],
  ['Policy-12', 'exact', 'present-but-unavailable', false],
] as const) {
  test(`target miss classification preserves literal punctuation and case: ${label}`, () => {
    const query = 'Policy-12';
    const tree = nodes(false);
    delete tree[2].label;
    tree[3].label = label;
    const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
    for (const exact of [undefined, 'text', 'id'] as const) {
      for (const scrolling of [false, true]) {
        const diagnostic = targetMissDiagnostic(
          { phrase: query, quoted: query, exact },
          screen,
          1,
          scrolling,
          new ObservedPrivacy(),
        );
        assert.equal(diagnostic.truncated, false);
        if (exact === 'id') {
          assert.equal(diagnostic.reason, 'absent');
          assert.deepEqual(diagnostic.candidates, []);
          continue;
        }
        assert.equal(diagnostic.reason, reason);
        assert.deepEqual(diagnostic.candidates, [{ label, match, aggregated }]);
      }
    }
  });
}

for (const exact of ['id', 'text'] as const) {
  for (const relation of ['equal', 'contained', 'near'] as const) {
    test(`exact ${exact} miss ignores ${relation} evidence from the other selector domain`, () => {
      const query = 'coverage card';
      const other =
        relation === 'equal'
          ? query
          : relation === 'contained'
            ? `${query} details`
            : 'coverage details';
      const tree = nodes(false);
      tree.forEach((node) => {
        delete node.label;
        delete node.identifier;
      });
      if (exact === 'id') tree[3].label = other;
      else tree[3].identifier = other;
      const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
      const selected = { phrase: query, quoted: query, exact };
      const miss = targetMissDiagnostic(selected, screen, 1, false, new ObservedPrivacy());
      assert.equal(miss.reason, 'absent');
      assert.deepEqual(miss.candidates, []);
      const ordinary = targetMissDiagnostic(
        { phrase: query, quoted: query },
        screen,
        1,
        false,
        new ObservedPrivacy(),
      );
      assert.equal(ordinary.candidates.length, 1);
      if (exact === 'id') screen.elements[3].testID = query;
      else screen.elements[3].label = query;
      const present = targetMissDiagnostic(selected, screen, 1, false, new ObservedPrivacy());
      assert.equal(present.reason, 'present-but-unavailable');
      assert.equal(present.candidates[0].match, 'exact');
      assert.equal(present.candidates[0].aggregated, false);
    });
  }
}

test('unresolved matches prevent conclusive misses in the selected domain', () => {
  for (const exact of [undefined, 'id', 'text'] as const) {
    for (const relation of ['equal', 'contained', 'near'] as const) {
      for (const offscreen of [false, true]) {
        for (const scrolling of [false, true]) {
          const tree = nodes(false);
          tree.forEach((node) => {
            delete node.label;
            delete node.identifier;
          });
          const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
          const element = screen.elements[3];
          const query = 'coverage card';
          const value =
            relation === 'equal'
              ? query
              : relation === 'contained'
                ? `${query}, details`
                : 'coverage details';
          element.label = exact === 'id' ? query : value;
          element.testID = exact === 'id' ? value : query;
          element.visibilityEvidence = 'unresolved';
          element.offscreen = offscreen;
          const diagnostic = targetMissDiagnostic(
            { phrase: query, quoted: query, exact },
            screen,
            1,
            scrolling,
            new ObservedPrivacy(),
          );
          const matches =
            exact === undefined ||
            relation === 'equal' ||
            (exact === 'text' && relation === 'contained');
          assert.equal(diagnostic.reason, matches ? 'evidence-incomplete' : 'absent');
          assert.equal(diagnostic.truncated, false);
          assert.deepEqual(diagnostic.candidates, []);
        }
      }
    }
  }
});

test('exact identifier diagnostics do not describe identifier matches as aggregated labels', () => {
  const screen = aggregate(
    join(nodes(false), [], 'app', { native: 'complete', react: 'complete' }),
  );
  const diagnostic = targetMissDiagnostic(
    { phrase: 'coverage-list', quoted: 'coverage-list', exact: 'id' },
    screen,
    1,
    false,
    new ObservedPrivacy(),
  );
  assert.equal(diagnostic.reason, 'present-but-unavailable');
  assert.equal(diagnostic.candidates[0].match, 'exact');
  assert.equal(diagnostic.candidates[0].aggregated, false);
});

test('private miss candidates mask runtime inputs and observed input values before truncation', () => {
  const secret = 'synthetic-sensitive-name';
  const observedValue = 'synthetic-observed-value';
  const tree = nodes(false);
  tree[3].label = `Add coverage, ${secret}, ${observedValue}, ${'x'.repeat(500)}`;
  tree[3].identifier = `card-${secret}`;
  tree.push({
    ref: '@input',
    parentIndex: 1,
    type: 'TextField',
    value: observedValue,
    rect: { x: 0, y: 0, width: 40, height: 20 },
  });
  const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
  const privacy = new ObservedPrivacy();
  privacy.classifyInputs([secret]);
  privacy.observe(screen);
  const diagnostic = targetMissDiagnostic(target, screen, 1, true, privacy);
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(`${secret}|${observedValue}`));
  assert.ok(diagnostic.candidates.every((candidate) => (candidate.label?.length ?? 0) <= 256));
  assert.match(JSON.stringify(diagnostic), /•••/);
});

test('miss diagnostics bound candidates and never infer absence after a truncated scan', () => {
  const tree = nodes(false);
  for (let i = 0; i < 2100; i++)
    tree.push({ ...tree[3], ref: `@extra${i}`, label: 'Add another coverage' });
  const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
  const diagnostic = targetMissDiagnostic(target, screen, 1, true, new ObservedPrivacy());
  assert.equal(diagnostic.candidates.length, 20);
  assert.equal(diagnostic.truncated, true);
  assert.equal(
    diagnostic.reason,
    'evidence-incomplete',
    'an exact label could be outside the scan',
  );
  const missing = targetMissDiagnostic(
    { phrase: 'Missing', quoted: 'Missing' },
    screen,
    1,
    true,
    new ObservedPrivacy(),
  );
  assert.equal(missing.reason, 'evidence-incomplete');
});

test('target miss diagnostics use the private wire even without runtime inputs and reject unbounded fields', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'check-1');
  const diagnostic = {
    kind: 'target-miss',
    line: 1,
    reason: 'absent',
    truncated: false,
    candidates: [
      { identifier: 'card', label: 'Coverage details', match: 'near', aggregated: false },
    ],
  };
  writer.diagnostic(diagnostic);
  writer.diagnostic({
    ...diagnostic,
    candidates: [{ ...diagnostic.candidates[0], value: 'unallowed' }],
  });
  writer.diagnostic({ ...diagnostic, candidates: Array(21).fill(diagnostic.candidates[0]) });
  writer.diagnostic({
    ...diagnostic,
    candidates: [{ ...diagnostic.candidates[0], label: 'x'.repeat(257) }],
  });
  writer.diagnostic({ ...diagnostic, reason: 'unallowed' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).payload, diagnostic);
});

test('bounded diagnostic labels remain well-formed at a surrogate boundary', () => {
  const tree = nodes(false);
  tree[3].label = `Add coverage ${'x'.repeat(242)}😀`;
  const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
  const diagnostic = targetMissDiagnostic(target, screen, 1, true, new ObservedPrivacy());
  const label = diagnostic.candidates[1].label!;
  assert.equal(label.length, 256);
  assert.doesNotMatch(label, /[\uD800-\uDFFF]/u);
});

test('a secure screen withholds diagnostic labels and oversized targets cannot match only a prefix', () => {
  const tree = nodes(false);
  tree.push({
    ref: '@secret',
    parentIndex: 1,
    type: 'SecureTextField',
    secure: true,
    label: 'sensitive',
    rect: { x: 0, y: 0, width: 40, height: 20 },
  });
  const screen = join(tree, [], 'app', { native: 'complete', react: 'complete' });
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  const diagnostic = targetMissDiagnostic(target, screen, 1, true, privacy);
  assert.ok(diagnostic.candidates.every((candidate) => candidate.label === '•••'));
  const oversized = {
    phrase: 'Add coverage',
    quoted: 'Add coverage' + ' '.repeat(4100) + 'missing',
  };
  assert.equal(
    targetMissDiagnostic(oversized, screen, 1, true, privacy).reason,
    'evidence-incomplete',
  );
});

test('a successful wait emits no target miss diagnostic', async () => {
  const tree = nodes(false);
  tree[2].label = undefined;
  tree[3].type = 'StaticText';
  tree[3].label = 'Add coverage';
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted target must be model-free')),
  );
  const diagnostics: unknown[] = [];
  f.deps.targetMiss = (event) => diagnostics.push(event);
  f.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      now: () => 0,
      native: async () => attested(tree),
      react: async () => ({ interactive: [] }),
    });
  assert.equal(
    (await runPlan(parsePlan('1. Wait for "Add coverage"').blocks!, f.deps)).verdict,
    'PASS',
  );
  assert.deepEqual(diagnostics, []);
});
