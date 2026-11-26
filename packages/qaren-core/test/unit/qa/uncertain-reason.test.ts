import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { WalkerTimingDiagnostic } from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import type { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const CODE = 'ACTION_OUTCOME_UNCERTAIN';
const SECRET = 'PRIVATE-input-value';
const LABEL = 'PRIVATE-screen-label';
const TEST_ID = 'PRIVATE-test-id';
const note = () => element('@note', LABEL, { kind: 'text', testID: TEST_ID });
// The reason argument does not exist on the base; the cast keeps this file loadable there.
const refuse = (context: QaDispatchContext, reason?: string): never =>
  (context.refuse as (code: string, reason?: string) => never)(CODE, reason);

const A = (): Screen[] => [screen([element('@save', 'Save'), note()])];
const B = (later: Screen = screen([element('@on', 'Save'), note()])): Screen[] => [
  screen([element('@off', 'Save', { offscreen: true }), note()]),
  later,
];
const PLAN = '1. Tap "Save"\n2. Fill "field" with input PASSWORD';

interface Row {
  name: string;
  screens: () => Screen[];
  arrange(f: ReturnType<typeof walker>, clock: { now: number }): void;
  expected: string;
  captures: number;
  // Every dispatch event of the run, in order: its code and its authorization count.
  dispatch: [string, number][];
  after?(): void;
}

const REFUSAL_KEYS = [
  'acquisitionMs',
  'action',
  'at',
  'authorizations',
  'code',
  'line',
  'observationAgeMs',
  'stage',
];
const DISPATCH_KEYS = [...REFUSAL_KEYS, 'nativeMutation', 'ok', 'refusalDiagnostic', 'resultCode'];
const INTERRUPTED: [string, number][] = [
  ['ACCEPTED', 1],
  ['ACTION_INTERRUPTED', 1],
];
let keptU6: QaDispatchContext | undefined;

const press =
  (body: (context: QaDispatchContext, clock: { now: number }) => void) =>
  (f: ReturnType<typeof walker>, clock: { now: number }) => {
    f.deps.press = async (ref, context) => {
      f.actions.push(`press ${ref}`);
      body(context!, clock);
      return { ok: true, proven: true };
    };
  };

const failedScroll = (f: ReturnType<typeof walker>) => {
  f.deps.scroll = async (direction) => {
    f.actions.push(`scroll ${direction}`);
    return { ok: false, proven: false };
  };
};

const rows: Row[] = [
  {
    name: 'U1 keyboard-visible',
    screens: A,
    arrange: press((context) => {
      context.authorize();
      refuse(context, 'keyboard-visible');
    }),
    expected: 'keyboard-visible',
    captures: 1,
    dispatch: INTERRUPTED,
  },
  {
    name: 'U2 dispatch-unconfirmed',
    screens: A,
    arrange: press((context) => {
      context.authorize();
      refuse(context, 'dispatch-unconfirmed');
    }),
    expected: 'dispatch-unconfirmed',
    captures: 1,
    dispatch: INTERRUPTED,
  },
  {
    name: 'U3 context-unverified',
    screens: A,
    arrange: press((context) => {
      context.authorize();
      context.invalidate();
    }),
    expected: 'context-unverified',
    captures: 1,
    dispatch: INTERRUPTED,
  },
  {
    name: 'U4 deadline-expired',
    screens: A,
    arrange: press((context, clock) => {
      context.authorize();
      clock.now += 10_000;
      try {
        context.authorize();
      } catch {
        /* A handler that swallows the guard error. */
      }
    }),
    expected: 'deadline-expired',
    captures: 1,
    dispatch: INTERRUPTED,
  },
  {
    name: 'U5a scroll-unverified (timed)',
    screens: B,
    arrange: (f, clock) => {
      let reads = 0;
      failedScroll(f);
      f.deps.now = () => {
        if (f.captures() === 2 && reads++ > 0) clock.now = 10_000;
        return clock.now;
      };
    },
    expected: 'scroll-unverified',
    captures: 2,
    dispatch: [['COMPLETED', 0]],
  },
  {
    name: 'U5b scroll-unverified (fixed clock, more gaps)',
    screens: () => B({ ...screen([element('@on', 'Save'), note()]), pressGapCount: 1 }),
    arrange: failedScroll,
    expected: 'scroll-unverified',
    captures: 3,
    dispatch: [['COMPLETED', 0]],
  },
  {
    name: 'U6b unknown (malformed reason)',
    screens: A,
    arrange: press((context) => {
      keptU6 = context;
      context.authorize();
      refuse(context, 'PRIVATE-reason');
    }),
    expected: 'unknown',
    captures: 1,
    dispatch: INTERRUPTED,
    after: () => {
      const error = keptU6!.refusal as unknown as Record<string, unknown>;
      assert.equal(error.message, CODE);
      assert.equal(error.uncertainReason, 'unknown');
      // Own properties at any depth, hidden ones included.
      assert.ok(!inspect(error, { showHidden: true, depth: 8 }).includes('PRIVATE-reason'));
    },
  },
  {
    name: 'U6a unknown (bare refusal)',
    screens: A,
    arrange: press((context) => {
      context.authorize();
      // One argument, as a caller without a reason would write it.
      (context.refuse as (code: string) => never)(CODE);
    }),
    expected: 'unknown',
    captures: 1,
    dispatch: INTERRUPTED,
  },
  {
    name: 'U12 an uncertain refusal before any authorization',
    screens: A,
    arrange: press((context) => refuse(context, 'dispatch-unconfirmed')),
    expected: 'dispatch-unconfirmed',
    captures: 1,
    dispatch: [['ACTION_OUTCOME_UNCERTAIN', 0]],
  },
  {
    name: 'U7 first refusal wins',
    screens: A,
    arrange: press((context) => {
      context.authorize();
      try {
        context.invalidate();
      } catch {
        /* swallowed */
      }
      refuse(context, 'dispatch-unconfirmed');
    }),
    expected: 'context-unverified',
    captures: 1,
    dispatch: INTERRUPTED,
  },
  {
    name: 'U8 alert-blocked',
    screens: B,
    arrange: (f) => {
      f.deps.scroll = async (direction, context) => {
        f.actions.push(`scroll ${direction}`);
        context!.authorize();
        return refuse(context!, 'alert-blocked');
      };
    },
    expected: 'alert-blocked',
    captures: 1,
    dispatch: INTERRUPTED,
  },
];

async function run(row: Row, withSecret: boolean, plan = PLAN) {
  const f = walker(
    row.screens(),
    scriptedJudge(() => ({})),
  );
  const clock = { now: 0 };
  const events: WalkerTimingDiagnostic[] = [];
  f.deps.now = () => clock.now;
  f.deps.diagnostic = (event) => events.push(event);
  row.arrange(f, clock);
  const walk = () => runPlan(parsePlan(plan).blocks!, f.deps);
  let result;
  if (withSecret) {
    const privacy = new ObservedPrivacy();
    f.deps.privacy = privacy;
    result = await withInputs(new RunInputs({ PASSWORD: SECRET }, ['PASSWORD'], privacy), walk);
  } else result = await walk();
  return { f, result, events };
}

for (const row of rows) {
  test(`${row.name}: a run with inputs carries the reason and nothing private`, async () => {
    const { f, result, events } = await run(row, true);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failure?.step, 1);
    assert.match(result.failure!.seen, /^ACTION_OUTCOME_UNCERTAIN/);
    assert.match(result.failure!.seen, /screen text withheld/);
    assert.equal(f.captures(), row.captures);
    assert.deepEqual(
      result.steps.map((step) => step.outcome),
      ['fail'],
    );
    // U10: the scan every row must pass, on the base too.
    const output = JSON.stringify({ result, rows: f.rows, events });
    for (const canary of [SECRET, LABEL, TEST_ID, 'PRIVATE-reason'])
      assert.ok(!output.includes(canary), canary);
    const dispatch = events.filter((event) => event.stage === 'dispatch');
    for (const event of dispatch)
      for (const key of Object.keys(event)) assert.ok(DISPATCH_KEYS.includes(key), key);
    assert.deepEqual(
      dispatch.map((event) => [event.code, event.authorizations]),
      row.dispatch,
    );
    for (const event of dispatch)
      if (event.code !== 'ACCEPTED' && event.code !== 'COMPLETED')
        assert.deepEqual(Object.keys(event).sort(), REFUSAL_KEYS);
    assert.equal(result.failure?.subreason, row.expected);
    row.after?.();
  });
}

test('U3 control: an attested single send keeps its own code and gets no subreason', async () => {
  const { result } = await run(
    {
      name: 'U3 control',
      screens: A,
      arrange: press((context) => {
        context.authorize();
        context.invalidate(true);
      }),
      expected: '',
      captures: 1,
      dispatch: INTERRUPTED,
    },
    true,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /^TARGET_MOVED_BEFORE_DISPATCH/);
  assert.equal(result.failure?.subreason, undefined);
});

test('U9: a run without inputs shows the same reason beside the screen text', async () => {
  const { result } = await run(rows[0], false, '1. Tap "Save"');
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.failure!.seen.includes(LABEL));
  assert.ok(!result.failure!.seen.includes('withheld'));
  assert.equal(result.failure?.subreason, 'keyboard-visible');
});

test('guard: an unchanged tap ends locally with its closed subreason', async () => {
  const { f, result } = await run(
    {
      name: 'guard unchanged',
      screens: A,
      arrange: (f) => {
        f.deps.press = async (ref, context) => {
          f.actions.push(`press ${ref}`);
          context!.authorize();
          return { ok: true, proven: false };
        };
      },
      expected: '',
      captures: 0,
      dispatch: [['COMPLETED', 0]],
    },
    true,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /^ACTION_OUTCOME_UNCERTAIN:/);
  assert.equal(result.failure?.subreason, 'press-retry-evidence-unavailable');
  assert.deepEqual(f.actions, ['press @save']);
  assert.deepEqual(
    result.steps.map(({ attempt, outcome }) => [attempt, outcome]),
    [[1, 'fail']],
  );
  const output = JSON.stringify({ result, rows: f.rows });
  for (const canary of [SECRET, LABEL, TEST_ID]) assert.ok(!output.includes(canary), canary);
});
