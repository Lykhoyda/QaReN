import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { createJev, JEV_MODEL } from '../../../dist/qa/jev.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  createTimingObserver,
  observeTiming,
  TIMING_EVENT_LIMIT,
  type RecordedTimingEvent,
  type TimingEvent,
} from '../../../dist/qa/timing.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

test('metric sink is content-free, bounded, synchronous and cannot throw into policy', () => {
  const events: RecordedTimingEvent[] = [];
  const timing = createTimingObserver((event) => events.push(event));
  const event = {
    stage: 'capture',
    edge: 'point',
    outcome: 'ok',
    at: 2,
    text: 'SECRET',
    token: 'SECRET',
  } as const;
  timing(event);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  for (let i = 0; i < TIMING_EVENT_LIMIT + 10; i++) timing(event);
  assert.equal(events.length, TIMING_EVENT_LIMIT + 1);
  assert.equal(events.at(-1)?.stage, 'overflow');
  assert.doesNotThrow(() =>
    createTimingObserver(() => {
      throw new Error('sink');
    })(event),
  );
  assert.doesNotThrow(() =>
    observeTiming(() => {
      throw new Error('sink');
    }, event),
  );
  assert.doesNotThrow(() => timing({ ...event, at: Infinity }));
});

test('capture stages reuse producer diagnostics without changing screen evidence', async () => {
  const events: TimingEvent[] = [];
  const native = nativeCapture();
  Object.assign(native.presenceCapture, {
    diagnostics: {
      phaseMs: {
        'initial-eligibility': 1,
        enumeration: 2,
        observation: 3,
        'final-eligibility': 4,
        revalidation: 5,
        SECRET: 99,
      },
    },
  });
  const deps = {
    native: async () => native,
    react: async () => ({}),
    appId: 'com.test',
    now: () => 10,
  };
  const plain = await captureScreen(deps);
  const measured = await captureScreen({ ...deps, timing: (event) => events.push(event) });
  assert.deepEqual(measured, plain);
  assert.equal(events.find((e) => e.stage === 'native-production')?.ms, 100);
  assert.equal(events.find((e) => e.stage === 'native-revalidation')?.ms, 5);
  assert.deepEqual(
    events.find((e) => e.stage === 'native-presence-v2'),
    {
      stage: 'native-presence-v2',
      edge: 'point',
      outcome: 'ok',
      at: 10,
      budgetMs: 20_000,
      appliedBudgetMs: 20_000,
    },
  );
  assert.ok(events.some((e) => e.stage === 'react-private' && e.edge === 'end'));
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  assert.ok(
    !events.some((e) =>
      ['native-readiness', 'native-decode', 'native-transport', 'native-read-only-v1'].includes(
        e.stage,
      ),
    ),
  );
});

test('a degraded digest retains native timings and closes the React acquisition span', async () => {
  const events: TimingEvent[] = [];
  await captureScreen({
    native: async () => nativeCapture(),
    react: async () => {
      throw new Error('SECRET');
    },
    requirePrivateInputs: true,
    now: () => 10,
    timing: (event) => events.push(event),
  });
  assert.ok(events.some((e) => e.stage === 'native-production'));
  assert.ok(
    events.some((e) => e.stage === 'react-private' && e.edge === 'end' && e.outcome === 'failed'),
  );
  assert.ok(!JSON.stringify(events).includes('SECRET'));
});

test('cached check, actual screenshot and every multi-send authorization retain one observation', async () => {
  const events: TimingEvent[] = [];
  const f = walker(
    [screen([element('@save', 'Save')])],
    scriptedJudge((q) => ({
      check_1: { type: 'noul', noul: 0.99 },
      target_2: choice(q.target_2),
    })),
  );
  f.deps.timing = (event) => events.push(event);
  f.deps.press = async (_ref, context) => {
    context!.authorize();
    context!.authorize();
    return { ok: true, proven: true };
  };
  const ledger = await runPlan(
    parsePlan('✓ The screen is ready\n1. Tap the save button').blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'PASS');
  const reuse = events.find((e) => e.stage === 'cache-reuse')!;
  const shot = events.find((e) => e.stage === 'screenshot' && e.edge === 'end')!;
  const sends = events.filter((e) => e.stage === 'authorization');
  assert.equal(sends.length, 2);
  assert.equal(reuse.observation, shot.observation);
  assert.equal(reuse.observation, sends[0].observation);
  assert.equal(sends[1].count, 2);
  assert.ok(events.indexOf(shot) < events.indexOf(reuse));
  assert.ok(events.indexOf(reuse) < events.indexOf(sends[0]));
  assert.ok(!events.some((e) => ['replay', 'refresh', 'expiry'].includes(e.stage)));
  assert.ok(!JSON.stringify(events).includes('Save'));
});

test('observer cost cannot bypass the final authorization deadline guard', async () => {
  let now = 0;
  let sent = false;
  const events: TimingEvent[] = [];
  const f = walker(
    [screen([element('@save', 'Save')])],
    scriptedJudge((q) => ({ target_1: choice(q.target_1) })),
  );
  f.deps.now = () => now;
  f.deps.timing = (event) => {
    events.push(event);
    if (event.stage === 'authorization') now += 10_000;
  };
  f.deps.press = async (_ref, context) => {
    context!.authorize();
    sent = true;
    return { ok: true, proven: true };
  };
  const ledger = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.notEqual(ledger.verdict, 'PASS');
  assert.equal(sent, false);
  assert.ok(events.some((e) => e.stage === 'mutation' && e.outcome === 'failed'));
  assert.ok(events.some((e) => e.stage === 'expiry'));
  assert.ok(!events.some((e) => e.stage === 'replay'));
});

test('Jev timings include failed attempts, validation and real backoff without request content', async () => {
  let now = 0;
  let request = 0;
  const events: TimingEvent[] = [];
  const judge = createJev({
    apiKey: 'SECRET',
    now: () => now,
    wallNow: () => 0,
    random: () => 0,
    timing: (event) => events.push(event),
    sleep: async (ms) => {
      now += ms;
    },
    fetch: async () => {
      now += 20;
      return ++request === 1
        ? new Response('', { status: 429, headers: { 'retry-after-ms': '100' } })
        : Response.json({
            model: JEV_MODEL,
            answers: { check_1: { type: 'noul', noul: 0.99 } },
            usage: { input_tokens: 1 },
          });
    },
  });
  await judge.ask(
    { text: 'SECRET' },
    { check_1: { type: 'noul', instructions: 'SECRET' } },
    'walk',
    500,
  );
  assert.equal(events.filter((e) => e.stage === 'jev-attempt' && e.edge === 'end').length, 2);
  assert.equal(events.find((e) => e.stage === 'jev-backoff' && e.edge === 'end')?.ms, 100);
  assert.ok(events.some((e) => e.stage === 'jev-validation' && e.outcome === 'ok'));
  assert.equal(judge.calls[0].ms, 20);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
});

test('a clipped backoff is reported with zero actual sleep and no policy change', async () => {
  const events: TimingEvent[] = [];
  const judge = createJev({
    apiKey: 'fake',
    now: () => 0,
    timing: (e) => events.push(e),
    sleep: async () => {
      assert.fail('must not sleep');
    },
    fetch: async () => new Response('', { status: 429, headers: { 'retry-after-ms': '1000' } }),
  });
  await assert.rejects(
    judge.ask({}, { check_1: { type: 'noul', instructions: 'ready' } }, 'walk', 100),
  );
  assert.ok(
    events.some(
      (e) => e.stage === 'jev-backoff' && e.outcome === 'failed' && e.ms === 0 && e.count === 1000,
    ),
  );
});

test('withheld screenshots, refreshes and automatic replays are explicit without private bytes', async () => {
  let now = 0;
  const secret = 'private-calibration-secret';
  const source = screen([element('@one', 'Ready')], [secret]);
  capturePrivateScreen(source, [
    { values: [secret], secure: true, elements: [], associationUnique: false },
  ]);
  const events: TimingEvent[] = [];
  const f = walker(
    [source],
    scriptedJudge((_q, index) => {
      if (index === 0) now += 10_000;
      return { check_1: { type: 'noul', noul: 0.99 } };
    }),
  );
  f.deps.now = () => now;
  f.deps.timing = (e) => events.push(e);
  f.deps.screenshot = async () => {
    assert.fail('private pixels must not be captured');
  };
  assert.equal((await runPlan(parsePlan('✓ Ready').blocks!, f.deps)).verdict, 'PASS');
  assert.ok(events.some((e) => e.stage === 'refresh'));
  assert.ok(events.some((e) => e.stage === 'screenshot' && e.outcome === 'withheld'));
  assert.ok(!JSON.stringify(events).includes(secret));
  const replay = walker(
    [screen([element('@save', 'Save')])],
    scriptedJudge(() => ({})),
    { ok: true, proven: false },
  );
  replay.deps.timing = (e) => events.push(e);
  await runPlan(parsePlan('1. Tap "Save"').blocks!, replay.deps);
  assert.equal(events.filter((e) => e.stage === 'replay').length, 1);
});

test('a throwing observer cannot change the functional ledger or action count', async () => {
  const outcomes = [];
  for (const observed of [false, true]) {
    const f = walker(
      [screen([element('@save', 'Save')])],
      scriptedJudge(() => ({})),
    );
    if (observed)
      f.deps.timing = () => {
        throw new Error('observer failure');
      };
    const { speed: _speed, ...ledger } = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    outcomes.push({
      ledger: { ...ledger, steps: ledger.steps.map(({ timing: _timing, ...row }) => row) },
      actions: f.actions,
    });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});
