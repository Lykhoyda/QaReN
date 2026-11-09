import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  dismissCandidate,
  soleDecline,
  targetBehindInterruption,
} from '../../../dist/qa/recover.js';
import type {
  InterruptionDiagnostic,
  InterruptionProof,
  RecoveryTarget,
} from '../../../dist/qa/recover.js';
import {
  behindPresentedModal,
  hostAssociationIdentity,
  join,
  type Screen,
} from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';
import { NATIVE_PRESENCE_BUDGET_MS } from '../../../dist/qa/timing.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

// Device-captured modal evidence; header variants add the duplicate control to those join() inputs.
function capture(name: string, header?: 'native' | 'react-only'): Screen {
  const { joinArgs: a } = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-promo-modal/${name}.json`, import.meta.url), 'utf8'),
  );
  if (header) {
    a.digest.find((entry) => entry.testID === 'qa-promo-home-target').text = 'Close';
    if (header === 'native') {
      const index = a.nodes.length;
      a.nodes.push({
        ref: `@e${index}`,
        index,
        parentIndex: 1,
        type: 'Button',
        label: 'Close',
        identifier: 'qa-promo-home-target',
        rect: { x: 20, y: 60, width: 80, height: 44 },
        enabled: true,
        hittable: true,
      });
      a.nativePresence?.nodes.push({ status: 'observed', labelSource: 'direct' });
    }
  }
  const screen = join(
    a.nodes,
    a.digest,
    a.front,
    a.coverage,
    a.reactHostEvidence,
    a.nativePresence,
    a.nativeAcquisition,
  );
  screen.captureCoverage = { ...a.coverage, native: a.nativeAcquisition };
  return screen;
}

const target = (
  quoted: string,
  kind: RecoveryTarget['kind'],
  line: number,
  extra: Partial<RecoveryTarget> = {},
): RecoveryTarget => ({ phrase: quoted, quoted, kind, line, ...extra });

const decide = (screen: Screen, targets: RecoveryTarget[], proof?: InterruptionProof) => {
  const records: InterruptionDiagnostic[] = [];
  return {
    result: dismissCandidate(screen, targets, (record) => records.push(record), proof),
    records,
  };
};

for (const name of ['wait-first-presence', 'check-first-presence']) {
  test(`device ${name}: the Close inside the presented modal associates despite covered React ancestors`, () => {
    const screen = capture(name);
    const close = screen.elements.find((e) => e.testID === 'qa-promo-close')!;
    assert.equal(hostAssociationIdentity(close), 'matched');
    assert.equal(screen.pressGapCount, 0);
    assert.equal(screen.pressEvidenceGap, undefined);
    assert.equal(soleDecline(screen), true);
  });
}

test('device wait-first: a React-only target behind the promo is proven covered and Close is chosen', () => {
  const screen = capture('wait-first-presence');
  const wait = target('qa-promo-home-target', 'wait', 12, { exact: 'id' });
  assert.equal(targetBehindInterruption(screen, wait), true);
  const { result, records } = decide(screen, [wait], 'covered-target');
  assert.deepEqual(result, { label: 'Close' });
  assert.deepEqual(records, []);
});

test('device promo: a missing target behind the presented modal may still close it', () => {
  const { result } = decide(
    capture('wait-first-presence'),
    [target('qa-not-mounted', 'press', 12, { exact: 'id' })],
    'surface',
  );
  assert.deepEqual(result, { label: 'Close' });
});

test('device check-first: a later tap matching the promo copy no longer keeps the sole Close up', () => {
  const { result, records } = decide(capture('check-first-presence'), [
    target('Target taps: 0', 'check', 11),
    target('qa-promo-home-target', 'press', 12),
    target('See Pro offers', 'press', 13),
  ]);
  assert.deepEqual(result, { label: 'Close' });
  assert.deepEqual(records, []);
});

test('device wait-first: a target that is not mounted is never treated as covered', () => {
  const screen = capture('wait-first-presence');
  const { result, records } = decide(
    screen,
    [target('qa-promo-form-submit', 'wait', 19, { exact: 'id' })],
    'covered-target',
  );
  assert.equal(result, undefined);
  assert.equal(records[0].veto, 'uncovered-target');
});

test('device tap-first: the ordinary press capture carries no association to prove the cover', () => {
  const screen = capture('tap-first-press');
  assert.equal(
    targetBehindInterruption(screen, target('qa-promo-home-target', 'press', 11, { exact: 'id' })),
    false,
  );
});

const tapClose = { kind: 'press' as const, target: { phrase: 'Close', quoted: 'Close' } };

function ambiguousClose() {
  const ordinary = capture('tap-first-press', 'native');
  const detailed = capture('wait-first-presence', 'native');
  const f = walker(
    [ordinary],
    scriptedJudge(() => assert.fail('quoted taps are model-free')),
  );
  f.deps.platform = 'ios';
  const modes: boolean[] = [];
  const budgets: Array<number | undefined> = [];
  f.deps.captureScreen = async (options) => {
    if (!f.actions.length) {
      modes.push(options?.platformPresence === true);
      budgets.push(options?.budgetMs);
    }
    return options?.platformPresence ? detailed : ordinary;
  };
  return { ...f, ordinary, detailed, modes, budgets };
}

test('an ambiguous quoted Close recaptures once and taps the sheet control over the native header', async () => {
  const f = ambiguousClose();
  const initial = prepareTarget(tapClose, f.ordinary);
  assert.ok('refuse' in initial && initial.refuse === 'TARGET_AMBIGUOUS');
  const header = f.detailed.elements.find((e) => e.testID === 'qa-promo-home-target')!;
  assert.equal(behindPresentedModal(f.detailed, header), true);
  const result = await runPlan(parsePlan('1. Tap "Close"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.deepEqual(f.actions, ['press @e13']);
  assert.equal(f.modes.filter(Boolean).length, 1);
  assert.equal(f.modes[0], false);
  assert.equal(f.budgets[f.modes.indexOf(true)], NATIVE_PRESENCE_BUDGET_MS);
  const exclusions = [
    {
      ref: '@e17',
      kind: 'button',
      frame: { x: 20, y: 60, width: 80, height: 44 },
      reason: 'behind-presented-modal',
    },
  ];
  assert.deepEqual(result.steps[0].candidateExclusions, exclusions);
  assert.deepEqual(f.rows[0].candidateExclusions, exclusions);
  assert.equal(JSON.stringify(exclusions).includes('Close'), false);
  assert.equal(JSON.stringify(f.rows).includes('qa-promo-home-target'), false);
});

for (const failure of ['refused', 'incomplete', 'late', 'unproven'] as const) {
  test(`a ${failure} detailed recapture keeps the ambiguity and dispatches nothing`, async () => {
    const f = ambiguousClose();
    const captureScreen = f.deps.captureScreen;
    let now = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async (options) => {
      const screen = await captureScreen(options);
      if (!options?.platformPresence) return screen;
      if (failure === 'refused') throw new Error('native presence refused');
      if (failure === 'incomplete')
        return { ...screen, coverage: { native: 'partial', react: 'complete' } };
      if (failure === 'late') now += NATIVE_PRESENCE_BUDGET_MS;
      return failure === 'unproven' ? f.ordinary : screen;
    };
    const result = await runPlan(parsePlan('1. Tap "Close"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
    assert.deepEqual(f.actions, []);
    assert.equal(f.modes.filter(Boolean).length, 1);
  });
}

test('React-only duplicates behind a sheet remain in contention and out of exclusions', async () => {
  const detailed = capture('wait-first-presence', 'react-only');
  const header = detailed.elements.find((e) => e.testID === 'qa-promo-home-target')!;
  assert.ok(header.ref.startsWith('react:'));
  assert.equal(behindPresentedModal(detailed, header), true);
  header.label = 'Close';
  const result = prepareTarget(tapClose, detailed);
  assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS', JSON.stringify(result));
  assert.equal(result.candidateExclusions, undefined);
});

test('all native duplicates proven behind the sheet stay not found, listing each exclusion', () => {
  const detailed = capture('wait-first-presence', 'native');
  detailed.elements.find((e) => e.testID === 'qa-promo-close')!.testID = 'qa-promo-home-target';
  const result = prepareTarget(tapClose, detailed);
  assert.ok('refuse' in result && result.refuse === 'TARGET_NOT_FOUND', JSON.stringify(result));
  assert.equal(result.candidateExclusions?.length, 2);
  assert.equal(result.reason.match(/\(behind-presented-modal\)/g)?.length, 2);
});

test('Android ambiguous quoted presses and Fill do not take a detailed recapture', async () => {
  for (const kind of ['android-press', 'fill']) {
    const f = ambiguousClose();
    if (kind === 'android-press') f.deps.platform = 'android';
    const plan = kind === 'fill' ? '1. Fill "Close" with "synthetic"' : '1. Tap "Close"';
    const parsed = parsePlan(plan);
    assert.ok(parsed.blocks, JSON.stringify(parsed));
    const result = await runPlan(parsed.blocks, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
    assert.equal(f.modes.filter(Boolean).length, 0);
  }
});

test('cancellation during the detailed recapture still aborts', async () => {
  const f = ambiguousClose();
  const captureScreen = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    const screen = await captureScreen(options);
    if (options?.platformPresence) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    return screen;
  };
  await assert.rejects(runPlan(parsePlan('1. Tap "Close"').blocks!, f.deps), {
    name: 'AbortError',
  });
  assert.deepEqual(f.actions, []);
});

test('an item retry never repeats the bounded ambiguity recapture', async () => {
  const f = ambiguousClose();
  const captureScreen = f.deps.captureScreen;
  let recaptures = 0;
  f.deps.captureScreen = async (options) => {
    if (options?.platformPresence && options.budgetMs !== undefined) recaptures++;
    return captureScreen(options);
  };
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    return { ok: false, proven: false, mutation: 'none', error: 'not dispatched' };
  };
  const result = await runPlan(parsePlan('1. Tap "Close"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
  assert.equal(recaptures, 1);
  assert.deepEqual(f.actions, ['press @e13']);
});
