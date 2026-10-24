import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { WalkerTimingDiagnostic } from '../../../dist/qa/walker.js';
import { JevError } from '../../../dist/qa/questions.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { checkQaNativeOutcome } from '../../../dist/runners/qa-native-policy.js';
import { join } from '../../../dist/qa/screen.js';
import {
  admitObservation,
  observationDeadline,
  observationUsable,
} from '../../../dist/qa/timing.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

test('terminal clearance telemetry preserves public rows, screenshots and one-send behavior under sink failure or delay', async () => {
  let baseline: string | undefined;
  const joined = (y: number) => ({
    ...join(
      [
        {
          ref: '@app',
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          ref: '@list',
          index: 1,
          parentIndex: 0,
          type: 'ScrollView',
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          ref: '@PRIVATE-target',
          index: 2,
          parentIndex: 1,
          type: 'Button',
          identifier: 'go',
          label: 'PRIVATE-app-label',
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        {
          ref: '@keyboard',
          index: 3,
          parentIndex: 0,
          type: 'Keyboard',
          rect: { x: 0, y: 500, width: 400, height: 300 },
        },
      ],
      [],
    ),
    coverage: { native: 'complete' as const, react: 'complete' as const },
  });
  for (const sink of ['absent', 'record', 'throw', 'delay']) {
    const judge = scriptedJudge(() => ({}));
    const f = walker([joined(710), joined(710), joined(710)], judge);
    let now = 0;
    let sends = 0;
    let shots = 0;
    const events: WalkerTimingDiagnostic[] = [];
    f.deps.now = () => now;
    f.deps.scroll = async (direction, context) => {
      context.authorize();
      sends++;
      f.actions.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    };
    f.deps.screenshot = async (name) => {
      shots++;
      return name;
    };
    if (sink !== 'absent')
      f.deps.diagnostic = (event) => {
        events.push(event);
        if (event.code === 'CENTRE_COVERED') {
          if (sink === 'throw') throw Error('PRIVATE-sink');
          if (sink === 'delay') now += 20_000;
        }
      };
    const result = await runPlan(parsePlan('1. Tap "go"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /stayed off screen after one scroll: its centre/);
    assert.equal(sends, 1);
    assert.equal(f.captures(), 3);
    assert.equal(shots, 1);
    assert.deepEqual(f.actions, ['scroll down']);
    assert.equal(judge.requests.length, 0);
    const publicOutput = JSON.stringify({ result, rows: f.rows });
    baseline ??= publicOutput;
    assert.equal(publicOutput, baseline);
    assert.ok(!publicOutput.includes('clearanceDiagnostic'));
    assert.ok(!JSON.stringify(events).includes('PRIVATE-'));
    if (sink !== 'absent') {
      assert.equal(events.filter((event) => event.code === 'CENTRE_COVERED').length, 1);
      assert.equal(
        events.find((event) => event.code === 'CENTRE_COVERED')?.clearanceDiagnostic
          ?.targetCentreChanged,
        false,
      );
    }
  }
});

test('private first-refusal diagnostics preserve verdict, captures and no replay even with a failing sink', async () => {
  for (const attested of [false, true]) {
    for (const throwSink of [false, true]) {
      const f = walker(
        [screen([element('@one', 'Save')])],
        scriptedJudge(() => ({})),
      );
      const events: WalkerTimingDiagnostic[] = [];
      let sends = 0;
      let shots = 0;
      f.deps.screenshot = async () => {
        shots++;
        return 'PRIVATE-shot';
      };
      f.deps.diagnostic = (event) => {
        events.push(event);
        if (throwSink) throw Error('PRIVATE-sink');
      };
      f.deps.press = async (_ref, context) => {
        context.authorize();
        sends++;
        const code = attested ? 'STALE_REF' : 'ACTION_CONTEXT_CHANGED';
        context.diagnoseRefusal(
          () => ({
            stage: 'native-response',
            mutating: true,
            responseOk: false,
            nativeCode: code,
            nativeMutation: attested ? 'none' : 'PRIVATE-unknown',
            message: 'PRIVATE-message',
          }),
          () => checkQaNativeOutcome(context, code, {}, undefined, attested ? 'none' : undefined),
        );
        return { ok: true, proven: true };
      };
      const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
      assert.equal(result.verdict, 'FAIL');
      assert.match(
        result.failure!.seen,
        attested ? /TARGET_MOVED_BEFORE_DISPATCH/ : /ACTION_OUTCOME_UNCERTAIN/,
      );
      assert.equal(sends, 1);
      assert.equal(f.captures(), 1);
      assert.equal(shots, 0);
      const interrupted = events.find((event) => event.code === 'ACTION_INTERRUPTED');
      assert.equal(
        interrupted?.refusalDiagnostic?.nativeCode,
        attested ? 'STALE_REF' : 'ACTION_CONTEXT_CHANGED',
      );
      assert.equal(interrupted?.refusalDiagnostic?.nativeMutation, attested ? 'none' : null);
      assert.equal(
        events.some((event) => event.code === 'COMPLETED'),
        false,
      );
      assert.equal(events.filter((event) => event.refusalDiagnostic).length, 1);
      assert.ok(!JSON.stringify(events).includes('PRIVATE-'));
      assert.ok(!JSON.stringify(result).includes('refusalDiagnostic'));
      assert.ok(!JSON.stringify(result).includes('nativeCode'));
    }
  }
});

test('a late target judgment refreshes once and never dispatches its stale reference', async () => {
  let now = 0;
  const judge = scriptedJudge((questions, index) => {
    if (index === 0) now += 10_000;
    return { target_1: choice(questions.target_1) };
  });
  const f = walker([screen([element('@old', 'Save')]), screen([element('@new', 'Save')])], judge);
  f.deps.now = () => now;
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @new']);
  assert.equal(judge.calls.length, 2);
});

test('observation admission and use have strict, immutable boundaries', () => {
  assert.equal(admitObservation(100, 22_100), undefined);
  assert.equal(admitObservation(100, 99), undefined);
  const timing = admitObservation(100, 22_099)!;
  assert.equal(timing.expiresAt, 32_099);
  assert.equal(observationUsable(timing, 32_098), true);
  assert.equal(observationUsable(timing, 32_099), false);
  assert.equal(observationDeadline(timing, 25_000), 25_000);
  assert.equal(observationUsable(timing, 25_000, 25_000), false);
});

test('check semantic and freshness allowances are independent in either order', async () => {
  for (const expiryFirst of [false, true]) {
    let now = 0;
    const judge = scriptedJudge((_questions, index) => {
      if (index === Number(!expiryFirst)) now += 10_000;
      return { check_1: { type: 'noul', noul: index < 2 ? 0.5 : 0.99 } };
    });
    const f = walker([screen([element('@one', 'Ready')])], judge);
    f.deps.now = () => now;
    f.deps.sleep = async (ms) => {
      now += ms;
    };
    const result = await runPlan(parsePlan('✓ The screen is ready').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(f.captures(), 3);
    assert.equal(judge.calls.length, 3);
  }
});

test('a check never exceeds three decision cycles or refreshes around unavailable service', async () => {
  for (const unavailable of [false, true]) {
    let now = 0;
    const judge = scriptedJudge((_questions, index) => {
      if (unavailable) throw new JevError('JEV_UNAVAILABLE');
      if (index > 0) now += 10_000;
      return { check_1: { type: 'noul', noul: 0.5 } };
    });
    const f = walker([screen([element('@one', 'Ready')])], judge);
    f.deps.now = () => now;
    f.deps.sleep = async (ms) => {
      now += ms;
    };
    const result = await runPlan(parsePlan('✓ The screen is ready').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, unavailable ? /JEV_UNAVAILABLE/ : /EVIDENCE_EXPIRED/);
    assert.equal(f.captures(), unavailable ? 1 : 3);
  }
});

test('screenshot delay preserves check acceptance but the cached action owns a separate refresh', async () => {
  let now = 0;
  const diagnostics: WalkerTimingDiagnostic[] = [];
  const judge = scriptedJudge((questions, index) => ({
    ...(index < 2 ? { check_1: { type: 'noul' as const, noul: index === 0 ? 0.5 : 0.99 } } : {}),
    target_2: choice(questions.target_2),
  }));
  const f = walker(
    [
      screen([element('@old', 'Save')]),
      screen([element('@batch', 'Save')]),
      screen([element('@new', 'Save')]),
    ],
    judge,
  );
  f.deps.now = () => now;
  f.deps.sleep = async (ms) => {
    now += ms;
  };
  f.deps.diagnostic = (event) => diagnostics.push(event);
  f.deps.screenshot = async (name) => {
    now += 10_000;
    return name;
  };
  const result = await runPlan(
    parsePlan('✓ The screen is ready\n1. Tap the save button').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @new']);
  assert.equal(judge.calls.length, 3);
  assert.deepEqual(
    diagnostics.filter((e) => e.line === 1).map((e) => [e.code, e.at]),
    [
      ['ACCEPTED', 0],
      ['ACCEPTED', 500],
    ],
  );
  assert.ok(diagnostics.some((e) => e.line === 2 && e.code === 'EVIDENCE_EXPIRED'));
});

test('press gaps growing after a scroll refresh once even when identity counts stay zero and the target is off screen', async () => {
  const off = { ...screen([element('@off', 'Save', { offscreen: true })]), pressGapCount: 0 };
  const lagging = { ...off, pressGapCount: 35, semanticUnassociatedReact: 0 };
  const on = { ...screen([element('@on', 'Save')]), pressGapCount: 0 };
  const f = walker(
    [off, lagging, lagging, on, on, on],
    scriptedJudge((questions) => ({ target_1: choice(questions.target_1) })),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(refreshes, 1);
  assert.equal(f.captures(), 6);
  assert.deepEqual(f.actions, ['scroll down', 'press @on']);
});

test('one press gap and unknown target visibility share the single post-scroll refresh', async () => {
  const off = { ...screen([element('@off', 'Save', { offscreen: true })]), pressGapCount: 0 };
  const unknown = {
    ...screen([
      element('@unknown', 'Save', {
        semantic: {
          press: 'supported',
          fill: 'unsupported',
          visibility: 'unknown',
          nativePresence: { kind: 'button', labelSource: 'direct', structural: false },
        },
      }),
    ]),
    pressGapCount: 1,
    semanticUnassociatedReact: 0,
  };
  const on = { ...screen([element('@on', 'Save')]), pressGapCount: 0 };
  const f = walker(
    [off, unknown, unknown, on, on, on],
    scriptedJudge((questions) => ({ target_1: choice(questions.target_1) })),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(refreshes, 1);
  assert.equal(f.captures(), 6);
  assert.deepEqual(f.actions, ['scroll down', 'press @on']);
});

test('equal or fewer press gaps with a visible target do not refresh even when fill gaps grow', async () => {
  for (const count of [2, 1, 0]) {
    const off = { ...screen([element('@off', 'Save', { offscreen: true })]), pressGapCount: 2 };
    const on = {
      ...screen([element('@on', 'Save')]),
      pressGapCount: count,
      fillGapCount: 35,
      semanticUnassociatedReact: 0,
    };
    const f = walker(
      [off, on],
      scriptedJudge(() => ({})),
    );
    let refreshes = 0;
    f.deps.timing = (event) => {
      if (event.stage === 'refresh') refreshes++;
    };
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(refreshes, 0);
    assert.equal(f.captures(), 4);
    assert.deepEqual(f.actions, ['scroll down', 'press @on']);
  }
});

test('a post-scroll fill compares fill gaps and ignores press gaps', async () => {
  for (const fillGaps of [35, 0]) {
    const off = {
      ...screen([
        element('@off', 'Name', {
          kind: 'input',
          nativeKind: 'input',
          testID: 'field',
          offscreen: true,
        }),
      ]),
      fillGapCount: 0,
      pressGapCount: 0,
    };
    const on = {
      ...screen([element('@on', 'Name', { kind: 'input', nativeKind: 'input', testID: 'field' })]),
      fillGapCount: 0,
      pressGapCount: 0,
    };
    const lagging = {
      ...(fillGaps > 0 ? off : on),
      fillGapCount: fillGaps,
      pressGapCount: fillGaps > 0 ? 0 : 35,
      semanticUnassociatedReact: 0,
    };
    const f = walker(
      [off, lagging, lagging, on, on, on],
      scriptedJudge(() => ({})),
    );
    let refreshes = 0;
    f.deps.timing = (event) => {
      if (event.stage === 'refresh') refreshes++;
    };
    const result = await runPlan(parsePlan('1. Fill "field" with "x"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(refreshes, fillGaps > 0 ? 1 : 0);
    assert.equal(f.captures(), fillGaps > 0 ? 6 : 4);
    assert.deepEqual(f.actions, ['scroll down', 'fill @on x']);
  }
});

test('a scrolled-to target with unknown visibility refreshes once even when gap counts are equal', async () => {
  const off = screen([element('@off', 'Save', { offscreen: true })]);
  const unknown = screen([
    element('@unknown', 'Save', {
      semantic: {
        press: 'supported',
        fill: 'unsupported',
        visibility: 'unknown',
        nativePresence: { kind: 'button', labelSource: 'direct', structural: false },
      },
    }),
  ]);
  const on = screen([element('@on', 'Save')]);
  const f = walker(
    [off, unknown, unknown, on, on, on],
    scriptedJudge((questions) => ({ target_1: choice(questions.target_1) })),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(refreshes, 1);
  assert.equal(f.captures(), 6);
  assert.deepEqual(f.actions, ['scroll down', 'press @on']);
});

test('a target still off screen after one scroll keeps its refusal without refreshing', async () => {
  const off = screen([element('@off', 'Save', { offscreen: true })]);
  const f = walker(
    [off],
    scriptedJudge((questions) => ({ target_1: choice(questions.target_1) })),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /stayed off screen after one scroll/);
  assert.equal(refreshes, 0);
  assert.equal(f.captures(), 3);
  assert.deepEqual(f.actions, ['scroll down']);
});

test('worse association after a resolution scroll refreshes once before tapping', async () => {
  const off = screen([element('@off', 'Save', { offscreen: true })]);
  const lagging = {
    ...screen([element('@lagging', 'Save')]),
    semanticUnassociatedReact: 35,
  };
  const on = screen([element('@on', 'Save')]);
  const f = walker(
    [off, lagging, lagging, on, on, on],
    scriptedJudge((questions) => ({ target_1: choice(questions.target_1) })),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(refreshes, 1);
  assert.equal(f.captures(), 6);
  assert.deepEqual(f.actions, ['scroll down', 'press @on']);
});

test('association still incomplete after the scroll refresh keeps the existing refusal', async () => {
  const off = screen([element('@off', 'Save', { offscreen: true })]);
  const lagging = {
    ...screen([element('@on', 'Save')]),
    semanticUnassociatedReact: 35,
  };
  const f = walker(
    [off, lagging],
    scriptedJudge((questions) => ({ target_1: choice(questions.target_1) })),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.equal(refreshes, 1);
  assert.equal(f.captures(), 5);
  assert.deepEqual(f.actions, ['scroll down']);
});

test('equal or fewer unmatched observations after a scroll do not refresh', async () => {
  for (const [before, after] of [
    [0, 0],
    [2, 2],
    [2, 1],
    [2, 0],
  ]) {
    const off = {
      ...screen([element('@off', 'Save', { offscreen: true })]),
      semanticUnassociatedReact: before,
    };
    const on = { ...screen([element('@on', 'Save')]), semanticUnassociatedReact: after };
    const f = walker(
      [off, on],
      scriptedJudge(() => ({})),
    );
    let refreshes = 0;
    f.deps.timing = (event) => {
      if (event.stage === 'refresh') refreshes++;
    };
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(refreshes, 0);
    assert.equal(f.captures(), 4);
    assert.deepEqual(f.actions, ['scroll down', 'press @on']);
  }
});

test('association regression after scrolling cannot replenish a consumed freshness allowance', async () => {
  let now = 0;
  // The visible header ensures the allowance is consumed before the named scroll.
  const off = screen([element('@header', 'Header'), element('@off', 'Save', { offscreen: true })]);
  const lagging = {
    ...screen([element('@on', 'Save')]),
    semanticUnassociatedReact: 35,
  };
  const judge = scriptedJudge((questions, index) => {
    if (index === 0) now += 10_000;
    return { target_1: choice(questions.target_1, 'none') };
  });
  const f = walker([off, off, lagging], judge);
  f.deps.now = () => now;
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /EVIDENCE_EXPIRED/);
  assert.equal(refreshes, 1);
  assert.equal(f.captures(), 4);
  assert.deepEqual(f.actions, ['scroll down']);
});

test('incomplete association without a scroll refuses without refreshing', async () => {
  const f = walker(
    [{ ...screen([element('@on', 'Save')]), semanticUnassociatedReact: 35 }],
    scriptedJudge(() => ({})),
  );
  let refreshes = 0;
  f.deps.timing = (event) => {
    if (event.stage === 'refresh') refreshes++;
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.equal(refreshes, 0);
  assert.equal(f.captures(), 1);
  assert.deepEqual(f.actions, []);
});

test('completed resolution scroll survives freshness refresh without a repeated scroll', async () => {
  let now = 0;
  const off = screen([element('@header', 'Header'), element('@off', 'Save', { offscreen: true })]);
  const on = screen([element('@on', 'Save')]);
  const judge = scriptedJudge((questions, index) => {
    if (index === 1) now += 10_000;
    return { target_1: choice(questions.target_1, index === 0 ? 'none' : 'e0') };
  });
  const f = walker([off, on], judge);
  f.deps.now = () => now;
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['scroll down', 'press @on']);
  assert.equal(judge.calls.length, 3);
});

test('one freshness allowance spans both sides of resolution scrolling', async () => {
  let now = 0;
  const off = screen([element('@header', 'Header'), element('@off', 'Save', { offscreen: true })]);
  const on = screen([element('@on', 'Save')]);
  const judge = scriptedJudge((questions, index) => {
    if (index !== 1) now += 10_000;
    return { target_1: choice(questions.target_1, index < 2 ? 'none' : 'e0') };
  });
  const f = walker([off, off, on], judge);
  f.deps.now = () => now;
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /EVIDENCE_EXPIRED/);
  assert.deepEqual(f.actions, ['scroll down']);
  assert.equal(judge.calls.length, 3);
});

test('second ordinary mutation attempt receives fresh capture but no expiry refresh', async () => {
  let now = 0;
  const judge = scriptedJudge((questions, index) => {
    if (index === 1) now += 10_000;
    return { target_1: choice(questions.target_1) };
  });
  const f = walker([screen([element('@one', 'Save')])], judge, { ok: false, proven: false });
  f.deps.now = () => now;
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(
    result.steps.map((s) => s.outcome),
    ['retry', 'fail'],
  );
  assert.deepEqual(
    result.steps.map((s) => s.attempt),
    [1, 2],
  );
  assert.deepEqual(f.actions, ['press @one']);
  assert.equal(f.captures(), 3);
  assert.equal(judge.calls.length, 2);
});

test('pre-dispatch expiration refreshes once, but lifecycle invalidation never refreshes', async () => {
  for (const invalidated of [false, true]) {
    let now = 0;
    let preparations = 0;
    let sends = 0;
    const f = walker(
      [screen([element('@one', 'Save')])],
      scriptedJudge(() => ({})),
    );
    f.deps.now = () => now;
    f.deps.press = async (_ref, context) => {
      preparations++;
      if (preparations === 1) {
        try {
          if (invalidated) context.invalidate();
          now += 10_000;
          context.authorize();
        } catch {
          return { ok: true, proven: true };
        }
      }
      context.authorize();
      sends++;
      return { ok: true, proven: true };
    };
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, invalidated ? 'FAIL' : 'PASS');
    assert.equal(sends, invalidated ? 0 : 1);
    assert.equal(preparations, invalidated ? 1 : 2);
    if (invalidated) assert.match(result.failure!.seen, /ACTION_CONTEXT_CHANGED/);
  }
});

test('all target-free mutations carry the preceding observation deadline', async () => {
  for (const line of ['Back', 'Scroll down', 'Accept dialog']) {
    let now = 0;
    let sends = 0;
    const f = walker(
      [screen([element('@one', 'Ready')])],
      scriptedJudge(() => ({})),
    );
    f.deps.now = () => now;
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async () => {
      const result = await capture();
      now += 20_000;
      return result;
    };
    const act = async (context: Parameters<typeof f.deps.back>[0]) => {
      assert.equal(context.deadline, 30_000);
      context.authorize();
      sends++;
      return { ok: true, proven: true };
    };
    f.deps.back = act;
    f.deps.scroll = (_direction, context) => act(context);
    f.deps.dialog = (_action, context) => act(context);
    const plan = parsePlan(`1. ${line}`);
    assert.ok(plan.blocks, line);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'PASS', line);
    assert.equal(sends, 1);
  }
});

test('judgment deadline includes joined capture duration and does not enter model state', async () => {
  let now = 0;
  let receivedDeadline: number | undefined;
  const f = walker(
    [screen([element('@one', 'Save')])],
    scriptedJudge(() => ({})),
  );
  f.deps.now = () => now;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async () => {
    const result = await capture();
    now += 20_000;
    return result;
  };
  f.deps.judge = {
    calls: [],
    async ask(state, questions, _scope, deadline?: number) {
      receivedDeadline = deadline;
      assert.doesNotMatch(JSON.stringify(state), /startedAt|completedAt|expiresAt/);
      return { target_1: choice(questions.target_1) };
    },
  };
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(receivedDeadline, 30_000);
});

test('swallowed expiry after an ancillary authorization cannot pass by diff or retry', async () => {
  for (const changed of [false, true]) {
    let now = 0;
    let sends = 0;
    const f = walker(
      [screen([element('@one', 'Save')]), screen([element('@two', changed ? 'Done' : 'Save')])],
      scriptedJudge(() => ({})),
    );
    f.deps.now = () => now;
    f.deps.press = async (_ref, context) => {
      context.authorize();
      sends++;
      now += 10_000;
      try {
        context.authorize();
      } catch {
        /* Simulate a handler that swallows the guard error. */
      }
      return { ok: true, proven: true };
    };
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /ACTION_OUTCOME_UNCERTAIN/);
    assert.equal(sends, 1);
    assert.equal(f.captures(), 1);
    assert.deepEqual(
      result.steps.map((s) => s.outcome),
      ['fail'],
    );
  }
});

test('fully authorized action completing late retains its owned fresh readback', async () => {
  let now = 0;
  const f = walker(
    [screen([element('@one', 'Save')]), screen([element('@two', 'Done')])],
    scriptedJudge(() => ({})),
  );
  f.deps.now = () => now;
  f.deps.press = async (_ref, context) => {
    context.authorize();
    now += 20_000;
    return { ok: false, proven: false };
  };
  const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.captures(), 2);
});

test('dispatch diagnostics record each authorization separately from late handler completion', async () => {
  let now = 0;
  const diagnostics: WalkerTimingDiagnostic[] = [];
  const f = walker(
    [screen([element('@one', 'Save')])],
    scriptedJudge(() => ({})),
  );
  f.deps.now = () => now;
  f.deps.diagnostic = (event) => diagnostics.push(event);
  f.deps.press = async (_ref, context) => {
    now = 100;
    context.authorize();
    now = 200;
    context.authorize();
    now = 20_000;
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(
    diagnostics.filter((e) => e.stage === 'dispatch').map((e) => [e.code, e.at, e.authorizations]),
    [
      ['ACCEPTED', 100, 1],
      ['ACCEPTED', 200, 2],
      ['COMPLETED', 20_000, 2],
    ],
  );
});

test('late host finalization refuses before judgment while remembering private values', async () => {
  let now = 0;
  let shots = 0;
  const secret = 'private-finalization-secret';
  const privateScreen = screen(
    [element('@input', 'Password', { kind: 'input', value: secret, secure: true })],
    [secret],
  );
  capturePrivateScreen(privateScreen, [
    { values: [secret], secure: true, elements: privateScreen.elements, associationUnique: true },
  ]);
  const f = walker(
    [privateScreen],
    scriptedJudge(() => assert.fail('late capture must not be judged')),
  );
  f.deps.now = () => now;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async () => {
    const result = await capture();
    now += 22_000;
    return result;
  };
  f.deps.screenshot = async () => {
    shots++;
    return 'secret.png';
  };
  const result = await runPlan(parsePlan('✓ The screen is ready').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(
    result.failure!.seen,
    /SCREEN_EVIDENCE_INCOMPLETE.*historical context, previously on screen: \[screen text withheld: a secure field is on screen\]$/,
  );
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(shots, 0);
  assert.equal(f.captures(), 1);
});

test('stale visibility polls consume neither semantic re-asks nor scrolls', async () => {
  for (const verb of ['Wait for', 'Scroll until']) {
    let now = 0;
    const judge = scriptedJudge((_questions, index) => {
      if (index === 0 || index === 2) now += 10_000;
      return { visibility_1: { type: 'noul', noul: index < 3 ? 0.5 : 0.99 } };
    });
    const f = walker([screen([element('@one', 'Welcome')])], judge);
    f.deps.now = () => now;
    f.deps.sleep = async (ms) => {
      now += ms;
    };
    const result = await runPlan(parsePlan(`1. ${verb} the welcome text`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(f.captures(), verb.startsWith('Scroll') ? 8 : 4);
    assert.deepEqual(f.actions, []);
    assert.equal(now, 21_500);
  }
});

test('zero-scroll stale loops stop at the original 65-second item deadline', async () => {
  for (const verb of ['Wait for', 'Scroll until']) {
    let now = 0;
    const judge = scriptedJudge(() => {
      now += 10_000;
      return { visibility_1: { type: 'noul', noul: 0.1 } };
    });
    const f = walker([screen([element('@one', 'Loading')])], judge);
    f.deps.now = () => now;
    f.deps.sleep = async (ms) => {
      now += ms;
    };
    const result = await runPlan(parsePlan(`1. ${verb} the welcome text`).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /VISIBILITY_UNSURE/);
    assert.doesNotMatch(result.failure!.seen, /did not appear|did not come into view/);
    assert.equal(f.captures(), verb.startsWith('Scroll') ? 14 : 7);
    assert.equal(now, 73_000, 'the final in-flight read drains but is never accepted');
    assert.deepEqual(f.actions, []);
  }
});

test('wait deadline after sleeping never promotes the prior negative poll to current absence', async () => {
  for (const quoted of [false, true]) {
    let now = 0;
    const f = walker(
      [screen([element('@one', 'Loading')])],
      scriptedJudge(() => ({
        visibility_1: { type: 'noul', noul: 0.1 },
      })),
    );
    const events: WalkerTimingDiagnostic[] = [];
    f.deps.now = () => now;
    f.deps.sleep = async () => {
      now = quoted ? 15_000 : 65_000;
    };
    f.deps.diagnostic = (event) => events.push(event);
    const result = await runPlan(
      parsePlan(`1. Wait for ${quoted ? '"Welcome"' : 'the welcome text'}`).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/);
    assert.doesNotMatch(result.failure!.seen, /did not appear/);
    assert.equal(f.captures(), 1);
    assert.ok(events.some((event) => event.code === 'ITEM_DEADLINE_EXCEEDED'));
  }
});

test('literal mutations refuse incomplete native acquisition before sends and before readback verdicts', async () => {
  for (const native of ['incomplete', 'unknown'] as const) {
    for (const readback of [false, true]) {
      for (const changed of [false, true]) {
        const before = screen([element('@one', 'Save')]);
        const unadmitted = screen([element('@one', changed ? 'Done' : 'Save')]);
        unadmitted.captureCoverage = { native, react: 'complete' };
        const f = walker(
          readback ? [before, unadmitted] : [unadmitted],
          scriptedJudge(() => assert.fail('literal actions stay model-free')),
          { ok: false, proven: false },
        );
        const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
        assert.equal(result.verdict, 'FAIL');
        assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
        assert.deepEqual(
          result.steps.map((row) => row.outcome),
          ['fail'],
        );
        assert.equal(f.actions.length, readback ? 1 : 0);
        assert.equal(f.captures(), readback ? 2 : 1);
      }
    }
  }
});

test('literal policy does not confuse missing semantic support with incomplete acquisition', async () => {
  for (const native of ['incomplete', 'unknown'] as const) {
    const observed = screen([element('@one', 'Save')]);
    observed.captureCoverage = { native: 'complete', react: 'unknown' };
    observed.coverage = { native, react: 'unknown' };
    delete observed.elements[0].semantic;
    const f = walker(
      [observed],
      scriptedJudge(() => assert.fail('literal actions stay model-free')),
    );
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.steps[0].reactCoverage, 'unknown');
    assert.deepEqual(f.actions, ['press @one']);
  }
});

test('an incomplete resolution-scroll readback cannot authorize a target or freshness replay', async () => {
  const off = screen([element('@off', 'Save', { offscreen: true })]);
  const unknown = screen([element('@on', 'Save')]);
  unknown.captureCoverage = { native: 'unknown', react: 'complete' };
  const f = walker(
    [off, unknown],
    scriptedJudge(() => ({})),
  );
  const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.deepEqual(f.actions, ['scroll down']);
  assert.equal(f.captures(), 2);
});

test('cancellation stops capture, judgment acceptance, refresh, and screenshots without new work', async () => {
  for (const stage of ['start', 'capture', 'judge', 'sleep']) {
    let cancelled = stage === 'start';
    let now = 0;
    let shots = 0;
    const judge = scriptedJudge(() => {
      if (stage === 'judge') {
        cancelled = true;
        now = 10_000;
        throw new JevError('JEV_DEADLINE_EXCEEDED');
      }
      return { visibility_1: { type: 'noul', noul: 0.1 } };
    });
    const observed = screen([element('@one', 'Loading')]);
    const secret = 'cancelled-acquisition-secret';
    capturePrivateScreen(observed, [
      { values: [secret], secure: true, elements: [], associationUnique: false },
    ]);
    observed.visibleText.push(secret);
    const f = walker([observed], judge);
    f.deps.cancelled = () => cancelled;
    f.deps.now = () => now;
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async () => {
      const result = await capture();
      if (stage === 'capture') cancelled = true;
      return result;
    };
    f.deps.sleep = async () => {
      now = 65_000;
      cancelled = true;
    };
    f.deps.screenshot = async () => {
      shots++;
      return 'unexpected.png';
    };
    const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /RUN_CANCELLED/);
    assert.doesNotMatch(JSON.stringify(result), /cancelled-acquisition-secret/);
    assert.equal(f.captures(), stage === 'start' ? 0 : 1);
    assert.equal(judge.calls.length, stage === 'start' || stage === 'capture' ? 0 : 1);
    assert.equal(shots, 0);
    assert.deepEqual(f.actions, []);
  }
});

test('cancellation after a completed mutation cannot pass or retry from readback', async () => {
  let cancelled = false;
  const f = walker(
    [screen([element('@one', 'Save')])],
    scriptedJudge(() => ({})),
  );
  f.deps.cancelled = () => cancelled;
  f.deps.press = async (_ref, context) => {
    context.authorize();
    cancelled = true;
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /RUN_CANCELLED/);
  assert.equal(f.captures(), 1);
  assert.deepEqual(
    result.steps.map((row) => row.outcome),
    ['fail'],
  );
});

test('expired readback cannot reconcile an unsuccessful resolution scroll or justify refresh', async () => {
  let now = 0;
  let readbackClockReads = 0;
  const f = walker(
    [screen([element('@off', 'Save', { offscreen: true })]), screen([element('@on', 'Save')])],
    scriptedJudge(() => ({})),
    { ok: false, proven: false },
  );
  f.deps.now = () => {
    if (f.captures() === 2 && readbackClockReads++ > 0) now = 10_000;
    return now;
  };
  const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /ACTION_OUTCOME_UNCERTAIN/);
  assert.deepEqual(f.actions, ['scroll down']);
  assert.equal(f.captures(), 2);
  assert.deepEqual(
    result.steps.map((row) => row.outcome),
    ['fail'],
  );
});

test('dispatch diagnostics cannot delay a guarded host send past its deadline', async () => {
  let now = 0;
  let sends = 0;
  const f = walker(
    [screen([element('@one', 'Save')])],
    scriptedJudge(() => ({})),
  );
  f.deps.now = () => now;
  f.deps.diagnostic = (event) => {
    if (event.stage === 'dispatch' && event.code === 'ACCEPTED') now = 10_000;
  };
  f.deps.press = async (_ref, context) => {
    context.authorize();
    sends++;
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(sends, 0);
  assert.equal(f.captures(), 1);
  assert.match(result.failure!.seen, /ACTION_OUTCOME_UNCERTAIN/);
});

test('item expiry wins an evidence deadline tie and starts no screenshot or next poll', async () => {
  let now = 0;
  let shots = 0;
  const events: WalkerTimingDiagnostic[] = [];
  const f = walker(
    [screen([element('@one', 'Loading')])],
    scriptedJudge(() => ({})),
  );
  f.deps.now = () => now;
  f.deps.sleep = async (ms) => {
    now += ms;
  };
  f.deps.diagnostic = (event) => events.push(event);
  f.deps.screenshot = async () => {
    shots++;
    return 'unexpected.png';
  };
  f.deps.judge = {
    calls: [],
    async ask(_state, _questions, _scope, deadline?: number) {
      if (now === 55_000) {
        assert.equal(deadline, 65_000);
        now = 65_000;
        throw new JevError('JEV_DEADLINE_EXCEEDED');
      }
      return { visibility_1: { type: 'noul', noul: 0.1 } };
    },
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/);
  assert.equal(events.at(-1)!.code, 'ITEM_DEADLINE_EXCEEDED');
  assert.equal(f.captures(), 111);
  assert.equal(shots, 0);
});

test('private facts on discarded observations stay masked and withhold later screenshots', async () => {
  let now = 0;
  let shots = 0;
  const secret = 'expired-private-value';
  const privateScreen = screen([element('@one', 'Loading')], [secret]);
  capturePrivateScreen(privateScreen, [
    { values: [secret], secure: false, elements: [], associationUnique: false },
  ]);
  const judge = scriptedJudge((_questions, index) => {
    if (index === 0) now = 10_000;
    return { check_1: { type: 'noul', noul: index === 0 ? 0.9 : 0.1 } };
  });
  const f = walker([privateScreen, screen([element('@two', 'Ready')], [`Echo: ${secret}`])], judge);
  f.deps.now = () => now;
  f.deps.screenshot = async () => {
    shots++;
    return 'unexpected.png';
  };
  const result = await runPlan(parsePlan('✓ The screen is ready').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(f.captures(), 2);
  assert.equal(shots, 0);
  assert.doesNotMatch(
    JSON.stringify({ result, requests: judge.requests }),
    /expired-private-value/,
  );
});

test('a screenshot cannot retroactively expire an accepted six-scroll terminal decision', async () => {
  let now = 0;
  const f = walker(
    [screen([element('@one', 'Loading')])],
    scriptedJudge(() => ({
      visibility_1: { type: 'noul', noul: 0.1 },
    })),
  );
  f.deps.now = () => now;
  f.deps.sleep = async (ms) => {
    now += ms;
  };
  f.deps.screenshot = async (name) => {
    now += 65_000;
    return name;
  };
  const result = await runPlan(parsePlan('1. Scroll until the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /did not come into view after 6 scrolls/);
  assert.doesNotMatch(result.failure!.seen, /ITEM_DEADLINE_EXCEEDED/);
  assert.equal(result.failure!.screenshot, 'screenshots/01-line1.png');
  assert.equal(f.actions.length, 6);
});

test('dispatch expiry at the item deadline reports item expiry unless cancellation wins', async () => {
  for (const cancel of [false, true]) {
    let now = 0;
    let cancelled = false;
    let sends = 0;
    const events: WalkerTimingDiagnostic[] = [];
    const f = walker(
      [screen([element('@one', 'Loading')])],
      scriptedJudge(() => ({
        visibility_1: { type: 'noul', noul: 0.1 },
      })),
    );
    f.deps.now = () => now;
    f.deps.cancelled = () => cancelled;
    f.deps.diagnostic = (event) => events.push(event);
    f.deps.scroll = async (_direction, context) => {
      now = 65_000;
      cancelled = cancel;
      context.authorize();
      sends++;
      return { ok: true, proven: true };
    };
    const result = await runPlan(parsePlan('1. Scroll until the welcome text').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, cancel ? /RUN_CANCELLED/ : /ITEM_DEADLINE_EXCEEDED/);
    assert.equal(events.at(-1)!.code, cancel ? 'RUN_CANCELLED' : 'ITEM_DEADLINE_EXCEEDED');
    assert.equal(sends, 0);
    assert.equal(f.captures(), 2);
  }
});
