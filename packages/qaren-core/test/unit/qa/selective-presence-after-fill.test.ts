import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { join } from '../../../dist/qa/screen.js';
import { attested } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

function container(prefix: string, provenance: boolean) {
  const screen = join(
    [
      { ref: `${prefix}-app`, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: `${prefix}-parent`,
        parentIndex: 0,
        type: 'ScrollView',
        identifier: 'coverage-list',
        label: 'Your coverage, Add coverage, Details',
        hittable: true,
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: `${prefix}-card`,
        parentIndex: 1,
        type: 'Other',
        label: 'Add coverage, Details',
        hittable: true,
        rect: { x: 20, y: 300, width: 360, height: 60 },
      },
    ],
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
  if (provenance)
    screen.elements[1].semantic!.nativePresence = {
      kind: 'other',
      labelSource: 'descendant',
      structural: false,
    };
  return screen;
}

test('candidate metadata retains the privacy-admitted ordinary reference and original dispatch deadline', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted target needs no model')),
  );
  let now = 0;
  const requested: { presence: boolean; observation: number | undefined }[] = [];
  f.deps.now = () => now;
  f.deps.captureScreen = async (options) => {
    requested.push({
      presence: options?.platformPresence === true,
      observation: options?.observation,
    });
    now += 1_000;
    return container('@ordinary', false);
  };
  f.deps.readLabelProvenance = async (refs, deadline) => {
    assert.equal(deadline, 9_500);
    now += 500;
    return refs.map((ref) => ({
      ref,
      labelSource: ref === '@ordinary-parent' ? 'descendant' : 'direct',
    }));
  };
  f.deps.press = async (ref, context) => {
    assert.equal(ref, '@ordinary-card');
    assert.equal(context.deadline, 11_000);
    f.actions.push(`press ${ref}`);
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.deepEqual(requested, [
    { presence: false, observation: 1 },
    { presence: false, observation: 2 },
  ]);
  assert.deepEqual(f.actions, ['press @ordinary-card']);
});

for (const expired of ['ordinary', 'provenance'] as const) {
  test(`expired ${expired} acquisition cannot dispatch or fall back to an earlier container`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('expired evidence needs no model')),
    );
    let now = 0;
    const requests: boolean[] = [];
    f.deps.now = () => now;
    f.deps.captureScreen = async (options) => {
      const presence = options?.platformPresence === true;
      requests.push(presence);
      now += presence === (expired === 'provenance') ? 22_000 : 1;
      return container(presence ? '@new' : '@old', presence);
    };
    const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(
      JSON.stringify(result),
      expired === 'ordinary'
        ? /ACQUISITION_EXPIRED/
        : /TARGET_AMBIGUOUS: candidate label provenance was unavailable/,
    );
    assert.deepEqual(requests, expired === 'ordinary' ? [false] : [false, true]);
    assert.deepEqual(f.actions, []);
  });
}

test('unavailable candidate provenance refuses ambiguity and never uses the ordinary candidate', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('incomplete evidence needs no model')),
  );
  const requests: boolean[] = [];
  f.deps.captureScreen = async (options) => {
    requests.push(options?.platformPresence === true);
    if (options?.platformPresence)
      throw new NativeSnapshotIncomplete(121, [
        'keyboard-state-unknown',
        'presence-failure=revalidation:enumeration-changed',
        'retry-deadline',
      ]);
    return container('@old', false);
  };
  const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(
    JSON.stringify(result),
    /TARGET_AMBIGUOUS: candidate label provenance was unavailable/,
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT_CAPTURE_UNKNOWN/);
  assert.deepEqual(requests, [false, true]);
  assert.deepEqual(f.actions, []);
});

test('a private code fill and notification dismissal prove the next screen without requesting presence', async () => {
  const secret = 'selective-private-code';
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal journey needs no model')),
  );
  let filled = false;
  let dismissed = false;
  const screenshots: boolean[] = [];
  const requested: { presence: boolean; dismissed: boolean }[] = [];
  f.deps.fill = async () => {
    filled = true;
    return { ok: true, proven: true };
  };
  f.deps.press = async (ref) => {
    assert.equal(ref, '@allow');
    dismissed = true;
    return { ok: true, proven: true };
  };
  f.deps.screenshot = async () => {
    screenshots.push(dismissed);
    return 'screen.png';
  };
  f.deps.captureScreen = (options) => {
    requested.push({ presence: options?.platformPresence === true, dismissed });
    if (dismissed && options?.platformPresence)
      throw new NativeSnapshotIncomplete(121, [
        'keyboard-state-unknown',
        'presence-failure=revalidation:enumeration-changed',
        'retry-deadline',
      ]);
    return captureScreen({
      ...options,
      requirePrivateInputs: true,
      native: async () =>
        attested(
          dismissed
            ? [{ ref: '@home', type: 'StaticText', label: 'Home' }]
            : filled
              ? [
                  { ref: '@prompt', type: 'Alert', label: 'Allow notifications?' },
                  {
                    ref: '@allow',
                    parentIndex: 0,
                    type: 'Button',
                    label: 'Allow',
                    enabled: true,
                    hittable: true,
                    rect: { x: 20, y: 300, width: 200, height: 40 },
                  },
                  {
                    ref: '@behind-code',
                    parentIndex: 0,
                    type: 'TextField',
                    label: 'Code',
                    value: secret,
                    secure: true,
                    rect: { x: 20, y: 100, width: 200, height: 40 },
                  },
                ]
              : [
                  {
                    ref: '@code',
                    type: 'TextField',
                    label: 'Code',
                    enabled: true,
                    hittable: true,
                    rect: { x: 20, y: 100, width: 200, height: 40 },
                  },
                ],
        ),
      react: async () => ({}),
    });
  };
  const result = await runPlan(
    parsePlan(`1. Type "${secret}" into "Code"\n2. Tap "Allow"\n3. Wait for "Home"`).blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(dismissed, true);
  assert.ok(requested.some((read) => read.dismissed));
  assert.ok(
    requested.every((read) => !read.presence),
    JSON.stringify(requested),
  );
  assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
  assert.ok(screenshots.every(Boolean), 'no screenshot while the code may be visible');
});

for (const label of ['Skip', 'Skip, Skip']) {
  test(`equal-frame ancestor echo ${label} presses its inner control without provenance`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal target needs no model')),
    );
    f.deps.captureScreen = async () =>
      join(
        [
          {
            ref: '@outer',
            type: 'Other',
            label,
            hittable: true,
            rect: { x: 20, y: 300, width: 120, height: 44 },
          },
          {
            ref: '@inner',
            parentIndex: 0,
            type: 'Other',
            label,
            hittable: true,
            rect: { x: 20, y: 300, width: 120, height: 44 },
          },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
    let reads = 0;
    f.deps.readLabelProvenance = async () => {
      reads++;
      return undefined;
    };
    const result = await runPlan(parsePlan('1. Tap "Skip"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.equal(reads, 0);
    assert.deepEqual(f.actions, ['press @inner']);
  });
}

for (const available of [true, false]) {
  test(`different-frame card provenance ${available ? 'returns' : 'expires'} before the walker deadline`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal target needs no model')),
    );
    let now = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async () => {
      now += 1_000;
      return container('@ordinary', false);
    };
    const events: Array<{ sampleCount: number | null; outcome: string }> = [];
    f.deps.labelProvenanceDiagnostic = (event) => events.push(event);
    f.deps.readLabelProvenance = async (refs, deadline, report) => {
      assert.equal(deadline, 9_500, 'runner must leave 1.5 seconds for its reply');
      now = deadline + 100;
      report({
        requested: true,
        sampleCount: 3,
        nodeIndex: null,
        differedFields: [],
        deadlineExpired: !available,
        outcome: available ? 'available' : 'deadline',
      });
      return available
        ? refs.map((ref) => ({
            ref,
            labelSource: ref === '@ordinary-parent' ? ('descendant' as const) : ('direct' as const),
          }))
        : undefined;
    };
    const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
    assert.equal(events.length, 1);
    assert.equal(events[0].sampleCount, 3);
    if (available) {
      assert.equal(result.verdict, 'PASS', JSON.stringify(result));
      assert.deepEqual(f.actions, ['press @ordinary-card']);
    } else {
      assert.match(JSON.stringify(result), /TARGET_AMBIGUOUS/);
      assert.equal(events[0].outcome, 'deadline');
      assert.deepEqual(f.actions, []);
    }
  });
}
