import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

function traceCaptures(f: ReturnType<typeof walker>) {
  const modes: boolean[] = [];
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options?: { platformPresence?: boolean }) => {
    modes.push(options?.platformPresence === true);
    return capture();
  };
  return modes;
}

function passingJudge() {
  return scriptedJudge((questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'choice' ? choice(question) : { type: 'noul', noul: 0.9 },
      ]),
    ),
  );
}

test('mixed plans acquire provenance for quoted presses and presence for phrase targets', async () => {
  const f = walker([screen([element('@save', 'Save')])], passingJudge());
  const modes = traceCaptures(f);
  const result = await runPlan(
    parsePlan('1. Tap "Save"\n2. Tap the save button\n3. Wait for "Save"\n4. Back').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [true, true, true, true, false, false, false]);
  assert.deepEqual(f.actions, ['press @save', 'press @save', 'back']);
});

test('literal-only plans acquire provenance for quoted presses and presence for scroll-until', async () => {
  const judge = scriptedJudge(() => assert.fail('literal-only plans must not ask Jev'));
  const f = walker(
    [screen([element('@save', 'Save'), element('@name', 'Name', { kind: 'input' })])],
    judge,
  );
  const modes = traceCaptures(f);
  const result = await runPlan(
    parsePlan(
      '✓ "Save"\n1. Tap "Save"\n2. Type "private-value" into "Name"\n3. Wait for "Save"\n4. Scroll until "Save"\n5. Scroll down\n6. Back\n7. Accept the dialog',
    ).blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [
    false,
    true,
    true,
    false,
    false,
    false,
    false,
    true,
    ...Array(7).fill(false),
  ]);
  assert.equal(result.jev.calls, 0);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});

test('quoted scroll-until requests platform evidence without requiring semantic presence', async () => {
  for (const direction of ['down', 'up']) {
    const initial = screen([element('@welcome', 'Welcome')]);
    const revealed = screen([element('@save', 'Save')]);
    for (const captured of [initial, revealed]) {
      captured.captureCoverage = { native: 'complete', react: 'complete' };
      captured.coverage = { native: 'unknown', react: 'complete' };
    }
    const f = walker(
      [initial, revealed],
      scriptedJudge(() => assert.fail('literal scroll-until must not ask Jev')),
    );
    const modes = traceCaptures(f);
    const result = await runPlan(parsePlan(`1. Scroll ${direction} until "Save"`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', result.failure?.seen);
    assert.deepEqual(modes, [false, false, true, false]);
    assert.deepEqual(f.actions, [`scroll ${direction}`]);
  }
});

test('standalone semantic checks and checks batched with targetless steps retain presence on re-ask', async () => {
  for (const next of ['', '\n1. Back', '\n1. Scroll down', '\n1. Accept the dialog']) {
    const judge = scriptedJudge((questions, index) => {
      assert.deepEqual(Object.keys(questions), ['check_1']);
      return { check_1: { type: 'noul', noul: index === 0 ? 0.5 : 0.9 } };
    });
    const f = walker([screen([element('@save', 'Save')])], judge);
    const modes = traceCaptures(f);
    const result = await runPlan(parsePlan(`✓ The screen is ready${next}`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(modes, next ? [true, true, false] : [true, true]);
    assert.equal(f.deps.now(), WAIT_POLL_MS);
  }
});

test('semantic checks retain presence while quoted next steps select their capture mode', async () => {
  for (const quoted of [false, true]) {
    for (const kind of ['press', 'fill', 'wait', 'scroll']) {
      const target = quoted ? '"Save"' : 'the save control';
      const line =
        kind === 'press'
          ? `Tap ${target}`
          : kind === 'fill'
            ? `Type "private-value" into ${target}`
            : kind === 'wait'
              ? `Wait for ${target}`
              : `Scroll until ${target}`;
      const judge = scriptedJudge((questions, index) =>
        Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            question.type === 'choice'
              ? choice(question)
              : { type: 'noul', noul: id === 'check_1' && index === 0 ? 0.5 : 0.9 },
          ]),
        ),
      );
      const extra = kind === 'fill' ? { kind: 'input' as const } : {};
      const f = walker(
        [screen([element('@old', 'Save', extra)]), screen([element('@fresh', 'Save', extra)])],
        judge,
      );
      const modes = traceCaptures(f);
      const result = await runPlan(parsePlan(`✓ The screen is ready\n1. ${line}`).blocks!, f.deps);
      assert.equal(result.verdict, 'PASS', `${quoted ? 'quoted' : 'phrase'} ${kind}`);
      const mutates = kind === 'press' || kind === 'fill';
      assert.deepEqual(
        modes,
        kind === 'scroll'
          ? [true, true, false, true, false]
          : quoted
            ? mutates
              ? [true, true, kind === 'press', kind === 'press']
              : [true, true, false]
            : mutates
              ? [true, true, true]
              : [true, true],
      );
      assert.deepEqual(
        f.actions,
        kind === 'press' ? ['press @fresh'] : kind === 'fill' ? ['fill @fresh private-value'] : [],
      );
      assert.equal(result.jev.calls, kind === 'scroll' && !quoted ? 3 : 2);
      assert.equal(f.deps.now(), WAIT_POLL_MS);
      assert.equal(JSON.stringify(result).includes('private-value'), false);
      assert.equal(JSON.stringify(judge.requests).includes('private-value'), false);
    }
  }
});

test('semantic checks retain presence through independent freshness refreshes and re-asks', async () => {
  for (const next of ['', '\n1. Back', '\n1. Tap "Save"']) {
    for (const expiryFirst of [false, true]) {
      let now = 0;
      const judge = scriptedJudge((_questions, index) => {
        if (index === Number(!expiryFirst)) now += 10_000;
        return { check_1: { type: 'noul', noul: index < 2 ? 0.5 : 0.9 } };
      });
      const f = walker([screen([element('@save', 'Save')])], judge);
      f.deps.now = () => now;
      f.deps.sleep = async (ms) => {
        now += ms;
      };
      const modes = traceCaptures(f);
      const result = await runPlan(parsePlan(`✓ The screen is ready${next}`).blocks!, f.deps);
      assert.equal(result.verdict, 'PASS');
      assert.deepEqual(
        modes,
        next.includes('Tap')
          ? [true, true, true, true, true]
          : next
            ? [true, true, true, false]
            : [true, true, true],
      );
      assert.equal(judge.requests.length, 3);
      assert.equal(now, 10_000 + WAIT_POLL_MS);
      assert.deepEqual(f.actions, next.includes('Tap') ? ['press @save'] : next ? ['back'] : []);
    }
  }
});

test('semantic checks require raw acquisition and semantic presence admission before judgment', async () => {
  for (const next of ['', '\n1. Back', '\n1. Tap "Save"']) {
    for (const rawIncomplete of [false, true]) {
      const captured = screen([element('@save', 'Save')]);
      captured.captureCoverage = {
        native: rawIncomplete ? 'incomplete' : 'complete',
        react: 'complete',
      };
      captured.coverage!.native = rawIncomplete ? 'complete' : 'incomplete';
      const judge = passingJudge();
      const f = walker([captured], judge);
      const modes = traceCaptures(f);
      const result = await runPlan(parsePlan(`✓ The screen is ready${next}`).blocks!, f.deps);
      assert.equal(result.verdict, 'FAIL');
      assert.equal(
        result.steps[0].reason,
        `SCREEN_EVIDENCE_INCOMPLETE: ${rawIncomplete ? 'NATIVE_ACQUISITION_UNUSABLE' : 'NATIVE_PRESENCE_UNUSABLE'}`,
      );
      assert.deepEqual(modes, [true]);
      assert.equal(judge.requests.length, 0);
      assert.deepEqual(f.actions, []);
    }
  }
});

test('a literal check does not opt in or batch the following phrase step', async () => {
  const f = walker([screen([element('@save', 'Save')])], passingJudge());
  const modes = traceCaptures(f);
  const result = await runPlan(parsePlan('✓ "Save"\n1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [false, true, true]);
  assert.equal(result.jev.calls, 1);
});

test('phrase actions keep presence mode through read-back and safe retries', async () => {
  for (const kind of ['press', 'fill']) {
    const f = walker(
      [screen([element('@save', 'Save', kind === 'fill' ? { kind: 'input' } : {})])],
      passingJudge(),
      { ok: false, proven: false, error: 'action timed out' },
    );
    const modes = traceCaptures(f);
    const result = await runPlan(
      parsePlan(
        kind === 'press' ? '1. Tap the save button' : '1. Type "private-value" into the save field',
      ).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(modes, kind === 'fill' ? [true, true] : [true, true, true, true]);
    assert.equal(f.actions.length, kind === 'fill' ? 1 : 2);
    assert.deepEqual(
      result.steps.map((row) => [row.attempt, row.outcome]),
      kind === 'fill'
        ? [[1, 'fail']]
        : [
            [1, 'retry'],
            [2, 'fail'],
          ],
    );
    assert.equal(JSON.stringify(result).includes('private-value'), false);
  }
});

test('phrase targeting retains presence mode after an offscreen scroll and read-back', async () => {
  const f = walker(
    [
      screen([element('react:save', 'Save', { offscreen: true, hittable: false })]),
      screen([element('@fresh', 'Save')]),
    ],
    passingJudge(),
  );
  const modes = traceCaptures(f);
  const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(modes, [true, true, true, true]);
  assert.deepEqual(f.actions, ['scroll down', 'press @fresh']);
});

test('phrase scroll re-asks refresh ordinary geometry before presence confirmation', async () => {
  for (const kind of ['wait', 'scroll']) {
    const judge = scriptedJudge((_questions, index) => {
      const probability = [0.5, 0.1, 0.9][index];
      return { visibility_1: { type: 'noul', noul: probability } };
    });
    const f = walker([screen([element('@save', 'Save')])], judge);
    const modes = traceCaptures(f);
    const result = await runPlan(
      parsePlan(
        kind === 'wait' ? '1. Wait for the save control' : '1. Scroll until the save control',
      ).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(
      modes,
      kind === 'scroll'
        ? [false, true, false, false, true, false, false, true, false]
        : [true, true, true],
    );
    assert.deepEqual(f.actions, kind === 'scroll' ? ['scroll down'] : []);
    assert.equal(f.deps.now(), WAIT_POLL_MS * 2);
  }
});

test('scroll visibility is independent of a preceding check while waits reuse its decision', async () => {
  for (const line of ['Wait for the save control', 'Scroll until the save control']) {
    const judge = scriptedJudge((questions, index) => {
      assert.deepEqual(
        Object.keys(questions),
        index === 0
          ? line.startsWith('Scroll')
            ? ['check_1']
            : ['check_1', 'visibility_2']
          : ['visibility_2'],
      );
      return {
        ...(index === 0 ? { check_1: { type: 'noul' as const, noul: 0.9 } } : {}),
        visibility_2: { type: 'noul', noul: index === 0 ? 0.5 : 0.9 },
      };
    });
    const f = walker([screen([element('@save', 'Save')])], judge);
    const modes = traceCaptures(f);
    const result = await runPlan(
      parsePlan(`✓ The screen is ready\n1. ${line}\n2. Tap "Save"`).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(
      modes,
      line.startsWith('Scroll') ? [true, false, true, false, true, true] : [true, true, true, true],
    );
    assert.deepEqual(f.actions, ['press @save']);
    assert.equal(result.jev.calls, 2);
    assert.equal(f.deps.now(), line.startsWith('Scroll') ? 0 : WAIT_POLL_MS);
  }
});
