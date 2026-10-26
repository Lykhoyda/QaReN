import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLedger, ledgerWithoutResult, type LedgerRow } from '../../../dist/qa/ledger.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { createJev, JEV_MODEL } from '../../../dist/qa/jev.js';
import type { Questions } from '../../../dist/qa/questions.js';
import {
  createRowTimer,
  separateRowOperations,
  summarizeSpeed,
} from '../../../dist/qa/row-timing.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const end = (stage: TimingEvent['stage'], ms: number, at = 0): TimingEvent => ({
  stage,
  edge: 'end',
  outcome: 'ok',
  at,
  ms,
});

const row = (line: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  block: 'qa',
  line,
  text: `line ${line}`,
  attempt: 1,
  kind: 'step',
  resolvedBy: 'exact',
  t: 0,
  outcome: 'pass',
  ...extra,
});

test('a row window splits captures around the act and the top-level fields sum to its total', () => {
  const timer = createRowTimer(100);
  timer.observe(end('capture', 40.4));
  timer.observe({ ...end('native-total', 30), edge: 'end' });
  timer.observe(end('react-private', 8));
  timer.observe({ stage: 'native-production', edge: 'point', outcome: 'ok', at: 0, ms: 25.6 });
  timer.observe(end('decision', 20));
  timer.observe(end('mutation', 15));
  timer.observe(end('capture', 30));
  timer.observe({ stage: 'decision', edge: 'start', outcome: 'ok', at: 0 });
  const timing = timer.take(220, 12);
  assert.deepEqual(timing, {
    captureMs: 40,
    nativeMs: 30,
    reactMs: 8,
    presenceMs: 26,
    resolveMs: 20,
    jevMs: 12,
    actMs: 15,
    postCaptureMs: 30,
    otherMs: 15,
    total: 120,
  });
  assert.equal(
    timing.captureMs + timing.resolveMs + timing.actMs + timing.postCaptureMs + timing.otherMs,
    timing.total,
  );
  const next = timer.take(230, 0);
  assert.equal(next.total, 10);
  assert.equal(next.captureMs, 0);
  assert.equal('presenceMs' in next, false);
});

test('overlap and fractional rounding still partition the row total exactly', () => {
  const sum = (t: ReturnType<ReturnType<typeof createRowTimer>['take']>): number =>
    t.captureMs + t.resolveMs + t.actMs + t.postCaptureMs + t.otherMs;
  const overlap = createRowTimer(0);
  overlap.observe(end('capture', 50));
  overlap.observe(end('decision', 50));
  const clamped = overlap.take(60, 0);
  assert.deepEqual([clamped.captureMs, clamped.resolveMs, clamped.otherMs], [50, 10, 0]);
  assert.equal(sum(clamped), clamped.total);
  const fractional = createRowTimer(0);
  fractional.observe(end('capture', 0.6));
  fractional.observe(end('decision', 0.6));
  const rounded = fractional.take(1.2, 0);
  assert.equal(rounded.total, 1);
  assert.equal(sum(rounded), rounded.total);
});

const timed = (line: number, total: number, extra: Partial<LedgerRow> = {}): LedgerRow =>
  row(line, { timing: createRowTimer(0).take(total, 0), ...extra });

test('speed summarizes every logical step and check across all attempts', () => {
  const rows = [
    timed(1, 100),
    timed(2, 300, { kind: 'check' }),
    timed(3, 200),
    timed(4, 900, { outcome: 'retry' }),
    timed(5, 400),
    row(6),
  ];
  assert.deepEqual(summarizeSpeed(rows), {
    stepMedianMs: 300,
    stepP95Ms: 900,
    walkMs: 1_900,
    steps: 5,
    passed: 4,
    failed: 1,
  });
  assert.deepEqual(buildLedger([], rows).speed, summarizeSpeed(rows));
});

test('retry and success windows sum to the elapsed logical step time', () => {
  for (const kind of ['step', 'check'] as const) {
    assert.deepEqual(
      summarizeSpeed([
        timed(1, 9_000, { kind, outcome: 'retry' }),
        timed(1, 1_000, { kind, attempt: 2 }),
      ]),
      {
        stepMedianMs: 10_000,
        stepP95Ms: 10_000,
        walkMs: 10_000,
        steps: 1,
        passed: 1,
        failed: 0,
      },
    );
  }
});

test('failed-only walks retain real durations and count the final outcome', () => {
  const rows = [
    timed(1, 9_000, { outcome: 'retry' }),
    timed(1, 1_000, { outcome: 'fail', attempt: 2 }),
    timed(2, 2_000, { kind: 'check', outcome: 'fail' }),
  ];
  assert.deepEqual(buildLedger([], rows).speed, {
    stepMedianMs: 6_000,
    stepP95Ms: 10_000,
    walkMs: 12_000,
    steps: 2,
    passed: 0,
    failed: 2,
  });
});

test('logical step identities use line and kind regardless of block', () => {
  assert.deepEqual(
    summarizeSpeed([
      timed(1, 100),
      timed(1, 200, { block: 'other' }),
      timed(1, 300, { kind: 'check' }),
      timed(2, 400),
    ]),
    {
      stepMedianMs: 300,
      stepP95Ms: 400,
      walkMs: 1_000,
      steps: 3,
      passed: 3,
      failed: 0,
    },
  );
});

test('capture-refusal retries keep one logical step across diagnostic blocks', () => {
  for (const block of ['native-capture', 'private-input-capture']) {
    for (const kind of ['step', 'check'] as const) {
      const rows = [
        timed(1, 9_000, { block: 'plan', kind, outcome: 'retry' }),
        timed(1, 1_000, { block, kind, outcome: 'fail', attempt: 2 }),
      ];
      assert.deepEqual(buildLedger([], rows).speed, {
        stepMedianMs: 10_000,
        stepP95Ms: 10_000,
        walkMs: 10_000,
        steps: 1,
        passed: 0,
        failed: 1,
      });
    }
  }
});

test('walks without timing omit speed', () => {
  assert.equal(summarizeSpeed([]), undefined);
  assert.equal(summarizeSpeed([row(1)]), undefined);
  assert.equal('speed' in buildLedger([], [row(1)]), false);
});

test('timed walks without logical steps omit percentiles and retain counts', () => {
  for (const total of [0, 50]) {
    assert.deepEqual(summarizeSpeed([{ ...timed(1, total), kind: 'setup' }]), {
      walkMs: total,
      steps: 0,
      passed: 0,
      failed: 0,
    });
  }
});

function timedWalk() {
  let now = 0;
  const f = walker(
    [screen([element('@save', 'Save')])],
    scriptedJudge((q) => Object.fromEntries(Object.keys(q).map((id) => [id, choice(q[id])]))),
  );
  const events: TimingEvent[] = [];
  f.deps.now = () => now;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    now += 40;
    return capture(options);
  };
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    now += 15;
    return press(ref, context);
  };
  f.deps.timing = (event) => events.push(event);
  return { f, events };
}

test('a walked step carries its window timing and the ledger carries speed', async () => {
  const { f } = timedWalk();
  const ledger = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  const [step] = ledger.steps;
  assert.ok(step.timing);
  const t = step.timing;
  assert.equal(t.captureMs + t.resolveMs + t.actMs + t.postCaptureMs + t.otherMs, t.total);
  assert.ok(t.captureMs >= 40);
  assert.equal(t.actMs >= 15, true);
  assert.equal(t.jevMs, 20);
  assert.deepEqual(f.rows[0].timing, step.timing);
  assert.deepEqual(ledger.speed, {
    stepMedianMs: t.total,
    stepP95Ms: t.total,
    walkMs: t.total,
    steps: 1,
    passed: 1,
    failed: 0,
  });
});

test('row Jev timing includes retry backoff and resets after each row', async () => {
  let now = 0;
  let attempts = 0;
  const judge = createJev({
    apiKey: 'test-key',
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetch: async (_url, init) => {
      now += 100;
      if (attempts++ === 1)
        return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      const { questions } = JSON.parse(String(init?.body)) as { questions: Questions };
      return Response.json({
        model: JEV_MODEL,
        answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q)])),
        usage: { input_tokens: 10 },
      });
    },
  });
  const f = walker([screen([element('@save', 'Save')])], judge);
  f.deps.now = () => now;
  f.deps.timing = () => {};
  await judge.ask(
    {},
    { warmup: { type: 'choice', instructions: 'Choose', criteria: { e0: 'yes', e1: 'no' } } },
  );
  const plan = parsePlan('1. Tap the save button\n2. Tap the save button').blocks!;
  const ledger = await runPlan(plan, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(
    ledger.steps.map((step) => step.timing?.jevMs),
    [2_200, 100],
  );
});

test('timing is passive: rows and verdict match a walk without an observer', async () => {
  const timed = timedWalk();
  const plain = timedWalk();
  delete plain.f.deps.timing;
  const plan = '✓ "Save"\n1. Tap the save button';
  const a = await runPlan(parsePlan(plan).blocks!, timed.f.deps);
  const b = await runPlan(parsePlan(plan).blocks!, plain.f.deps);
  assert.equal(a.verdict, b.verdict);
  assert.deepEqual(
    a.steps.map(({ timing: _timing, ...rest }) => rest),
    b.steps,
  );
  assert.equal('speed' in b, false);
  assert.ok(b.steps.every((s) => !('timing' in s)));
  assert.deepEqual(timed.f.actions, plain.f.actions);
});

test('a failing row-timing projection still records and emits the row', async () => {
  const { f } = timedWalk();
  f.deps.rowTiming = () => {
    throw new Error('projection');
  };
  const outcome = await walkBlock(parsePlan('1. Tap the save button').blocks![0], f.deps);
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.rows.length, 1);
  assert.equal(outcome.rows[0].outcome, 'pass');
  assert.equal('timing' in outcome.rows[0], false);
  assert.deepEqual(
    f.rows.map((row) => [row.line, row.outcome]),
    outcome.rows.map((row) => [row.line, row.outcome]),
  );
});

test('a dispatch refused before authorization leaves later captures pre-action', () => {
  const timer = createRowTimer(0);
  timer.observe({ ...end('mutation', 5), count: 0 });
  timer.observe(end('capture', 30));
  const refused = timer.take(40, 0);
  assert.deepEqual([refused.actMs, refused.captureMs, refused.postCaptureMs], [5, 30, 0]);
  timer.observe({ ...end('mutation', 5), count: 1 });
  timer.observe(end('capture', 30));
  const sent = timer.take(80, 0);
  assert.deepEqual([sent.actMs, sent.captureMs, sent.postCaptureMs], [5, 0, 30]);
});

test('a ledger synthesized after the walk stopped carries no speed', () => {
  const timed = row(1, {
    timing: {
      captureMs: 0,
      nativeMs: 0,
      reactMs: 0,
      resolveMs: 0,
      jevMs: 0,
      actMs: 0,
      postCaptureMs: 0,
      otherMs: 10,
      total: 10,
    },
  });
  const ledger = ledgerWithoutResult([timed], 'core exited');
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal('speed' in ledger, false);
  assert.deepEqual(ledger.steps, [timed]);
});

test('login operation timings stay separate from plan lines and retain diagnostic retries', () => {
  for (const kind of ['step', 'check'] as const) {
    const login = [
      timed(1, 100, { block: 'login', kind, outcome: 'retry' }),
      timed(1, 200, { block: 'native-capture', kind, outcome: 'fail', attempt: 2 }),
    ];
    separateRowOperations(login);
    const rows = [...login, timed(1, 700, { block: 'plan', kind })];
    assert.deepEqual(
      buildLedger(
        [],
        rows.map((row) => ({ ...row, block: '<private>' })),
      ).speed,
      {
        stepMedianMs: 500,
        stepP95Ms: 700,
        walkMs: 1000,
        steps: 2,
        passed: 1,
        failed: 1,
      },
    );
  }
});

test('login recovery and the retried plan step produce separate ledger speed statistics', async () => {
  const loginScreen = screen([element('@login', 'Sign in')]);
  const planScreen = screen([element('@save', 'Save')]);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted steps never ask Jev')),
  );
  let loggedIn = false;
  let clock = 0;
  f.deps.now = () => clock;
  f.deps.timing = () => {};
  f.deps.captureScreen = async () => {
    clock += 10;
    return loggedIn ? planScreen : loginScreen;
  };
  f.deps.press = async (ref, context) => {
    context.authorize();
    clock += ref === '@login' ? 100 : 300;
    loggedIn = true;
    return { ok: true, proven: true };
  };
  f.deps.hideDevMenu = async () => ({ ok: true, proven: true });
  f.deps.login = {
    marker: { text: 'Sign in' },
    block: parsePlan('1. Tap "Sign in"').blocks![0],
  };
  const ledger = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 1);
  assert.deepEqual(
    ledger.steps.map((row) => [row.line, row.kind, row.outcome]),
    [
      [1, 'step', 'pass'],
      [1, 'step', 'retry'],
      [1, 'step', 'pass'],
    ],
  );
  const loginMs = ledger.steps[0].timing!.total;
  const planMs = ledger.steps.slice(1).reduce((total, row) => total + row.timing!.total, 0);
  assert.deepEqual(ledger.speed, {
    stepMedianMs: Math.round((loginMs + planMs) / 2),
    stepP95Ms: Math.max(loginMs, planMs),
    walkMs: loginMs + planMs,
    steps: 2,
    passed: 2,
    failed: 0,
  });
});
