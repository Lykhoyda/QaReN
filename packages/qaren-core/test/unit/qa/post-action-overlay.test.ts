import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { join, insideAlert } from '../../../dist/qa/screen.js';
import { selectionPressCandidate } from '../../../dist/qa/selection-press.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { element, screen } from './judgment-fixtures.ts';

const plan = (next = '2. Wait for "question-2"') => parsePlan(`1. Tap "Next"\n${next}`).blocks!;
const destination = () => screen([element('@question', 'Question', { testID: 'question-2' })]);
const overlay = (): Screen => ({
  ...screen([element('@dismiss', 'Dismiss'), element('@stack', 'CANARY_OVERLAY')]),
  front: 'dev-redbox',
  devError: { variant: 'redbox', dismissRef: '@dismiss' },
});

function fixture(
  options: {
    before?: Screen;
    after?: Screen;
    overlay?: Screen;
    act?: ActResult;
  } = {},
) {
  let current = options.before ?? screen([element('@next', 'Next')]);
  let clock = 0;
  let cancelled = false;
  const actions: string[] = [];
  const shots: string[] = [];
  const rows: LedgerRow[] = [];
  const captures: Screen[] = [];
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen() {
      captures.push(current);
      return current;
    },
    async press(ref, context) {
      context!.authorize();
      actions.push(ref);
      current =
        ref === '@dismiss' ? (options.after ?? destination()) : (options.overlay ?? overlay());
      return ref === '@dismiss'
        ? { ok: true, proven: false, executed: true }
        : (options.act ?? { ok: true, proven: false, executed: true });
    },
    async fill() {
      assert.fail('unexpected fill');
    },
    async scroll() {
      assert.fail('unexpected scroll');
    },
    async back() {
      assert.fail('unexpected back');
    },
    async dialog() {
      assert.fail('unexpected dialog');
    },
    async hideDevMenu() {
      assert.fail('unexpected dev menu');
    },
    async screenshot(name) {
      shots.push(name);
      return name;
    },
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    row: (row) => rows.push(row),
    cancelled: () => cancelled,
  };
  return {
    deps,
    actions,
    shots,
    rows,
    captures,
    cancel: () => {
      cancelled = true;
    },
  };
}

test('a dispatched navigation dismisses once and passes only with the next native test ID', async () => {
  const f = fixture();
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
  assert.deepEqual(
    result.steps.map((row) => row.outcome),
    ['pass', 'pass'],
  );
  const warning = {
    variant: 'redbox',
    dismissal: 1,
    afterAction: true,
    proof: 'next-test-id-appeared',
  };
  assert.deepEqual(result.steps[0].devError, warning);
  assert.deepEqual(f.rows[0].devError, warning);
  assert.match(result.steps[0].reason!, /development.*overlay.*warning/i);
  assert.equal(f.captures.filter((capture) => capture.front === 'app').length, 2);
  assert.ok(!JSON.stringify([result, f.rows]).includes('CANARY'));
  assert.equal(result.steps[0].screenshot, undefined, 'overlay screenshot remains withheld');
});

for (const [name, options] of Object.entries({
  absent: { after: screen([]) },
  'already present': { before: screen([element('@next', 'Next'), ...destination().elements]) },
  'React only': {
    after: screen([element('react:question', 'Question', { testID: 'question-2' })]),
  },
  'label only': { after: screen([element('@question', 'question-2')]) },
})) {
  test(`completion stays uncertain when the next test ID is ${name}`, async () => {
    const f = fixture(options);
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    assert.match(result.message, /dismissed once to check the next screen/);
    assert.deepEqual(f.actions, ['@next', '@dismiss']);
    assert.ok(!JSON.stringify(result).includes('CANARY'));
  });
}

for (const act of [
  { ok: true, proven: false, mutation: 'none' },
  { ok: true, proven: false, executed: false },
  { ok: false, proven: false, executed: true },
] satisfies ActResult[]) {
  test(`an ineligible dispatch refuses without dismissal: ${JSON.stringify(act)}`, async () => {
    const f = fixture({ act });
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    assert.deepEqual(f.actions, ['@next']);
  });
}

for (const excluded of ['android', 'logbox', 'no-dismiss', 'selection', 'alert'] as const) {
  test(`${excluded} stays outside post-action recovery`, async () => {
    const f = fixture();
    if (excluded === 'android') f.deps.platform = 'android';
    if (excluded === 'logbox' || excluded === 'no-dismiss') {
      const shown = overlay();
      shown.devError =
        excluded === 'logbox'
          ? { variant: 'logbox', dismissRef: '@dismiss' }
          : { variant: 'redbox' };
      const fresh = fixture({ overlay: shown });
      Object.assign(f, fresh);
    }
    if (excluded === 'selection') {
      const before = join(
        [
          {
            ref: '@row',
            index: 0,
            type: 'ScrollView',
            rect: { x: 0, y: 0, width: 200, height: 50 },
          },
          {
            ref: '@next',
            index: 1,
            parentIndex: 0,
            type: 'Button',
            label: 'Next',
            hittable: true,
            rect: { x: 0, y: 0, width: 80, height: 50 },
          },
          {
            ref: '@peer',
            index: 2,
            parentIndex: 0,
            type: 'Button',
            label: 'Other',
            hittable: true,
            rect: { x: 100, y: 0, width: 80, height: 50 },
          },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
      assert.equal(selectionPressCandidate(before.elements[1], before), true);
      Object.assign(f, fixture({ before }));
    }
    if (excluded === 'alert') {
      const before = join(
        [
          { ref: '@alert', index: 0, type: 'Alert' },
          { ref: '@next', index: 1, parentIndex: 0, type: 'Button', label: 'Next', hittable: true },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
      assert.equal(insideAlert(before.elements[1]), true);
      Object.assign(f, fixture({ before }));
    }
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    assert.deepEqual(f.actions, ['@next']);
  });
}

for (const next of ['✓ "Question"', '2. Wait for Question', '']) {
  test(`only an adjacent quoted target can prove completion: ${next}`, async () => {
    const f = fixture();
    const result = await runPlan(plan(next), f.deps);
    assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    assert.deepEqual(f.actions, ['@next', '@dismiss']);
    assert.match(result.message, /dismissed once/);
  });
}

test('an overlay still in front after Dismiss refuses without a loop', async () => {
  const f = fixture({ after: overlay() });
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.code, 'DEV_REDBOX_REPEATED');
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
  assert.match(result.message, /one dismissal/);
});

test('a second post-action overlay in another block spends no further dismissal', async () => {
  const f = fixture({ after: screen([...destination().elements, element('@next', 'Next')]) });
  const blocks = parsePlan(
    '# First\n1. Tap "Next"\n2. Wait for "question-2"\n# Second\n1. Tap "Next"\n2. Wait for "question-2"',
  ).blocks!;
  const result = await runPlan(blocks, f.deps);
  assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
  assert.deepEqual(f.actions, ['@next', '@dismiss', '@next']);
});

test('a RedBox after the cached Wait refuses before the next Tap without dismissal', async () => {
  const f = fixture();
  const capture = f.deps.captureScreen;
  let afterDismissal = 0;
  f.deps.captureScreen = async (options) =>
    f.actions.at(-1) === '@dismiss' && ++afterDismissal > 1 ? overlay() : capture(options);
  const result = await runPlan(plan('2. Wait for "question-2"\n3. Tap "Next"'), f.deps);
  assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
  assert.deepEqual(
    result.steps.slice(0, 2).map((row) => row.outcome),
    ['pass', 'pass'],
  );
  assert.equal(result.failure!.step, 3);
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
});

test('recovery disabled keeps the existing refusal', async () => {
  const f = fixture();
  const result = await walkBlock(plan()[0], f.deps, 0, [], undefined, undefined, {
    recover: false,
  });
  assert.equal(result.refusal?.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
  assert.deepEqual(f.actions, ['@next']);
});

test('an overlay first seen by recovery passes the press without retrying it', async () => {
  const before = screen([element('@next', 'Next')]);
  const f = fixture({ before });
  const capture = f.deps.captureScreen;
  let readbacks = 0;
  f.deps.captureScreen = async (options) =>
    f.actions.at(-1) === '@next' && readbacks++ === 0 ? before : capture(options);
  const result = await walkBlock(plan()[0], f.deps, 0, [], undefined, undefined, {
    singleAttempt: true,
  });
  assert.equal(result.block.outcome, 'pass');
  assert.deepEqual(
    result.rows.map((row) => row.outcome),
    ['pass', 'pass'],
  );
  assert.equal(result.rows[0].devError?.afterAction, true);
  assert.deepEqual(result.rows[0].selector, { text: 'Next' });
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
});

for (const repeatedTarget of [false, true]) {
  test(`a delayed overlay before attempt two never reuses the prior act (${repeatedTarget})`, async () => {
    const before = screen([element('@next', 'Next')]);
    const f = fixture({
      before,
      after: screen([...destination().elements, ...(repeatedTarget ? before.elements : [])]),
    });
    const capture = f.deps.captureScreen;
    let readbacks = 0;
    f.deps.captureScreen = async (options) =>
      f.actions.at(-1) === '@next' && readbacks++ === 0 ? before : capture(options);
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    assert.deepEqual(f.actions, ['@next']);
  });
}

for (const cause of ['incomplete', 'expired'] as const) {
  test(`an ${cause} RedBox capture keeps the action-uncertain refusal`, async () => {
    const shown = overlay();
    if (cause === 'incomplete') shown.captureCoverage = { native: 'incomplete', react: 'complete' };
    const f = fixture({ overlay: shown });
    const capture = f.deps.captureScreen;
    let clock = 0;
    f.deps.now = () => clock;
    f.deps.captureScreen = async (options) => {
      const observed = await capture(options);
      if (cause === 'expired' && observed.front === 'dev-redbox') clock += 1_000_000;
      return observed;
    };
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    assert.deepEqual(f.actions, ['@next']);
  });
}

test('the next cached Tap still requires its label provenance', async () => {
  const f = fixture({
    after: screen([
      element('@question', 'question-2, Other', {
        kind: 'cell',
        testID: 'question-2',
      }),
    ]),
  });
  let reads = 0;
  f.deps.readLabelProvenance = async (refs) => {
    reads++;
    assert.deepEqual(refs, ['@question']);
    return undefined;
  };
  const result = await runPlan(plan('2. Tap "question-2"'), f.deps);
  assert.equal(reads, 1);
  assert.equal(result.steps[0].outcome, 'pass');
  assert.equal(result.failure!.step, 2);
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
});

test('an incomplete post-dismissal capture cannot prove completion', async () => {
  const f = fixture({
    after: { ...destination(), captureCoverage: { native: 'incomplete', react: 'complete' } },
  });
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
});

for (const shot of [2, 3, 'incomplete', 'incomplete-overlay'] as const) {
  test(`a RedBox during pixel readback ${shot} preserves action safety`, async () => {
    const before = {
      ...join(
        [
          {
            ref: '@next',
            index: 0,
            type: 'Button',
            label: 'Next',
            identifier: 'next',
            hittable: true,
            rect: { x: 0, y: 0, width: 20, height: 20 },
          },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      ),
      pointScale: 3,
    };
    const f = fixture({
      before,
      ...(shot === 'incomplete-overlay'
        ? {
            overlay: { ...overlay(), captureCoverage: { native: 'incomplete', react: 'complete' } },
          }
        : {}),
      ...(shot === 'incomplete'
        ? {
            after: {
              ...destination(),
              captureCoverage: { native: 'incomplete', react: 'complete' },
            },
          }
        : {}),
    });
    const capture = f.deps.captureScreen;
    let raised = false;
    let shots = 0;
    f.deps.captureScreen = async (options) =>
      f.actions.at(-1) === '@next' && !raised ? before : capture(options);
    const bytes = readFileSync(
      new URL('../../fixtures/tap-pixels/toggle1-before.png', import.meta.url),
    );
    f.deps.comparisonScreenshot = async () => {
      if (++shots === (typeof shot === 'number' ? shot : 2)) raised = true;
      return bytes;
    };
    const result = await runPlan(plan(), f.deps);
    if (typeof shot !== 'number') {
      assert.equal(result.verdict, 'REFUSED');
      assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
    } else {
      assert.equal(result.verdict, 'PASS');
      assert.equal(result.steps[0].devError?.afterAction, true);
    }
    assert.equal(shots, typeof shot === 'number' ? shot : 2);
    if (shot === 'incomplete-overlay') {
      assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
      assert.deepEqual(f.actions, ['@next']);
    } else assert.deepEqual(f.actions, ['@next', '@dismiss']);
  });
}

test('cancellation during Dismiss aborts without replay', async () => {
  const f = fixture();
  const press = f.deps.press;
  f.deps.press = async (...args) => {
    const result = await press(...args);
    if (args[0] === '@dismiss') f.cancel();
    return result;
  };
  const result = await runPlan(plan(), f.deps);
  assert.notEqual(result.verdict, 'PASS');
  assert.match(result.failure!.seen, /RUN_CANCELLED/);
  assert.deepEqual(f.actions, ['@next', '@dismiss']);
});

test('privacy masking and screenshot withholding survive dismissal', async () => {
  const f = fixture({
    after: screen([
      ...destination().elements,
      element('@private', 'CANARY_PRIVATE', { kind: 'input', secure: true }),
    ]),
  });
  f.deps.privacy = new ObservedPrivacy(['CANARY_PRIVATE']);
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.ok(!JSON.stringify([result, f.rows]).includes('CANARY'));
  assert.deepEqual(f.shots, []);
});
