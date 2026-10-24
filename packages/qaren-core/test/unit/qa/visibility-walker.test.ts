import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join as joinScreen } from '../../../dist/qa/screen.js';
import type { Element, Screen, Visibility } from '../../../dist/qa/screen.js';
import { CHECK } from '../../../dist/qa/questions.js';
import { EVIDENCE_USE_MS, PHRASE_WAIT_BUDGET_MS } from '../../../dist/qa/timing.js';
import { runPlan, SCROLL_ATTEMPTS, WAIT_BUDGET_MS, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

function text(label: string, visibility: Visibility = 'visible'): Element {
  return {
    ref: `@${label}`,
    kind: 'text',
    label,
    hittable: false,
    disabled: false,
    secure: false,
    offscreen: visibility === 'offscreen',
    semantic: { press: 'unsupported', fill: 'unsupported', visibility },
  };
}

function heading(label: string): Element {
  const base = text(label);
  return {
    ...base,
    semantic: {
      ...base.semantic!,
      heading: { kind: 'typographic-title', hostIndex: 0, anchorRef: base.ref, bodyRefs: [] },
      nativePresence: { kind: 'text', labelSource: 'direct', structural: false },
    },
  };
}

function screen(...elements: Element[]): Screen {
  return {
    front: 'app',
    coverage: { native: 'complete', react: 'complete' },
    elements,
    visibleText: elements
      .filter((e) => e.semantic?.visibility === 'visible')
      .map((e) => e.label ?? ''),
  };
}

function evidence(state: unknown): unknown[] {
  assert.ok(state && typeof state === 'object' && 'assertionEvidence' in state);
  const assertion = state.assertionEvidence;
  assert.ok(assertion && typeof assertion === 'object' && 'observed' in assertion);
  assert.ok(Array.isArray(assertion.observed));
  assert.deepEqual(Object.keys(assertion).sort(), [
    'observed',
    'qualifiedHeadings',
    'unassociatedReact',
    'unknown',
  ]);
  assert.ok(!('elements' in state), 'visibility does not select action candidates');
  return assertion.observed;
}

function visibilityJudge(...probabilities: number[]) {
  return scriptedJudge((questions, index) => {
    assert.equal(Object.keys(questions).length, 1);
    return Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        assert.match(id, /^visibility_\d+$/);
        assert.equal(question.type, 'noul');
        return [
          id,
          { type: 'noul', noul: probabilities[Math.min(index, probabilities.length - 1)] },
        ];
      }),
    );
  });
}

for (const direction of ['up', 'down']) {
  for (const refresh of ['reask', 'decision-expiry', 'dispatch-expiry']) {
    test(`scroll-until ${direction} refuses navigation during ${refresh}`, async () => {
      let elapsed = 0;
      const judge = scriptedJudge((_questions, index) => {
        if (index === 1 && refresh === 'decision-expiry') elapsed += EVIDENCE_USE_MS;
        return {
          visibility_1: {
            type: 'noul',
            noul: index >= 2 ? 0.9 : index === 1 && refresh === 'reask' ? 0.5 : 0.1,
          },
        };
      });
      const original = screen({ ...text('Policies'), selected: true }, text('Loading'));
      const destination = screen({ ...text('Claims'), selected: true }, text('Footer'));
      const f = walker([original, original, original, original, destination], judge);
      f.deps.now = () => elapsed;
      f.deps.sleep = async (ms) => {
        elapsed += ms;
      };
      const scroll = f.deps.scroll;
      let drags = 0;
      f.deps.scroll = async (dir, context) => {
        if (drags === 1 && refresh === 'dispatch-expiry') {
          elapsed += EVIDENCE_USE_MS;
          context!.check();
          assert.fail('expired dispatch must refresh before sending another drag');
        }
        context!.authorize();
        drags += 1;
        return scroll(dir, context);
      };
      const result = await runPlan(
        parsePlan(`1. Scroll ${direction} until the footer text`).blocks!,
        f.deps,
      );
      assert.equal(result.verdict, 'REFUSED');
      assert.equal(result.code, 'SCROLL_NAVIGATED');
      assert.equal(drags, 1);
      assert.deepEqual(f.actions, [`scroll ${direction}`]);
      assert.equal(f.captures(), 5);
      assert.equal(
        judge.requests.length,
        2,
        'the destination must not receive a visibility judgment',
      );
      assert.ok(result.steps.every((step) => step.outcome !== 'pass'));
    });
  }
}

test('a phrase wait succeeds on present text without selecting or pressing a target', async () => {
  const judge = scriptedJudge((questions, _index, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.equal(questions.visibility_1.type, 'noul');
    assert.deepEqual(evidence(state), ['Text "Welcome"']);
    return { visibility_1: { type: 'noul', noul: 0.9 } };
  });
  const f = walker([screen(text('Welcome'))], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, []);
  assert.equal(f.captures(), 1);
  assert.equal(result.steps[0].resolvedBy, 'jev');
  assert.equal(result.jev.calls, 1);
});

test('an absent phrase wait polls fresh screens without scrolling', async () => {
  const judge = visibilityJudge(0.1, 0.9);
  const f = walker([screen(text('Loading')), screen(text('Welcome'))], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, []);
  assert.equal(f.captures(), 2);
  assert.equal(f.deps.now(), WAIT_POLL_MS);
  assert.deepEqual(evidence(judge.requests[0].state), ['Text "Loading"']);
  assert.deepEqual(evidence(judge.requests[1].state), ['Text "Welcome"']);
});

test('negative phrase polls exhaust the wait budget without claiming current absence', async () => {
  const judge = visibilityJudge(0.1);
  const f = walker([screen(text('Loading'))], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/);
  assert.equal(f.deps.now(), PHRASE_WAIT_BUDGET_MS);
  assert.equal(f.captures(), PHRASE_WAIT_BUDGET_MS / WAIT_POLL_MS);
  assert.equal(result.jev.calls, f.captures());
  assert.deepEqual(f.actions, []);
});

test('waits accept visibility only before the item deadline on final polled captures or judgments', async (t) => {
  for (const quoted of [false, true]) {
    for (const delayed of quoted ? ['capture'] : ['capture', 'judge']) {
      for (const offset of [-1, 0, 1]) {
        await t.test(`${quoted ? 'quoted' : 'phrase'} ${delayed} ${offset}`, async () => {
          let elapsed = 0;
          const budget = quoted ? WAIT_BUDGET_MS : PHRASE_WAIT_BUDGET_MS;
          const finalIndex = budget / WAIT_POLL_MS - 1;
          const judge = scriptedJudge((_, index) => {
            assert.equal(quoted, false, 'quoted waits stay model-free');
            if (delayed === 'judge' && index === finalIndex) elapsed = budget + offset;
            return { visibility_1: { type: 'noul', noul: index === finalIndex ? 0.9 : 0.1 } };
          });
          const f = walker(
            [...Array(finalIndex).fill(screen(text('Loading'))), screen(text('Welcome'))],
            judge,
          );
          f.deps.now = () => elapsed;
          f.deps.sleep = async (ms) => {
            elapsed += ms;
          };
          const capture = f.deps.captureScreen;
          f.deps.captureScreen = async () => {
            const observed = await capture();
            if (delayed === 'capture' && f.captures() === finalIndex + 1) elapsed = budget + offset;
            return observed;
          };
          const line = quoted ? 'Wait for "Welcome"' : 'Wait for the welcome text';
          const result = await runPlan(parsePlan(`1. ${line}`).blocks!, f.deps);
          assert.equal(result.verdict, offset < 0 ? 'PASS' : 'FAIL');
          assert.equal(f.captures(), finalIndex + 1);
          assert.equal(
            result.jev.calls,
            quoted ? 0 : finalIndex + Number(delayed === 'judge' || offset < 0),
          );
          assert.equal(elapsed, budget + offset);
          assert.deepEqual(f.actions, []);
        });
      }
    }
  }
});

test('wait polling clamps its final sleep and never starts another capture at the deadline', async (t) => {
  for (const line of ['Wait for the welcome text', 'Wait for "Welcome"']) {
    for (const oversleep of [0, 1]) {
      await t.test(`${line}, oversleep ${oversleep}`, async () => {
        let elapsed = 0;
        const slept: number[] = [];
        const budget = line.includes('"') ? WAIT_BUDGET_MS : PHRASE_WAIT_BUDGET_MS;
        const judge = visibilityJudge(0.1);
        const f = walker([screen(text('Loading')), screen(text('Welcome'))], judge);
        f.deps.now = () => elapsed;
        f.deps.sleep = async (ms) => {
          slept.push(ms);
          elapsed += ms + (ms < WAIT_POLL_MS ? oversleep : 0);
        };
        const capture = f.deps.captureScreen;
        f.deps.captureScreen = async () => {
          await capture();
          if (f.captures() === budget / WAIT_POLL_MS) elapsed = budget - 1;
          return screen(text('Loading'));
        };
        const result = await runPlan(parsePlan(`1. ${line}\n2. Back`).blocks!, f.deps);
        assert.equal(result.verdict, 'FAIL');
        assert.equal(result.failure?.step, 1);
        assert.equal(slept.at(-1), 1);
        assert.equal(elapsed, budget + oversleep);
        assert.equal(f.captures(), budget / WAIT_POLL_MS);
        assert.equal(result.jev.calls, line.includes('"') ? 0 : f.captures());
        assert.deepEqual(f.actions, []);
      });
    }
  }
});

test('phrase scroll-until moves only in the plan direction after confirmed absence', async () => {
  for (const direction of ['up', 'down']) {
    const judge = visibilityJudge(0.1, 0.9);
    const f = walker(
      [screen(text('Middle')), screen(text('Middle')), screen(text('Destination'))],
      judge,
    );
    const result = await runPlan(
      parsePlan(`1. Scroll ${direction} until the destination text`).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(f.actions, [`scroll ${direction}`]);
    assert.equal(f.captures(), 4);
    assert.equal(result.jev.calls, 2);
  }
});

test('an absent phrase scroll-until stops at the existing scroll attempt limit', async () => {
  const judge = visibilityJudge(0.1);
  const f = walker([screen(text('Middle'))], judge);
  const result = await runPlan(
    parsePlan('1. Scroll up until the destination text').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /did not come into view after 6 scrolls/);
  assert.deepEqual(f.actions, Array(SCROLL_ATTEMPTS).fill('scroll up'));
  assert.equal(f.captures(), 2 * (SCROLL_ATTEMPTS + 1));
  assert.equal(result.steps[0].attempt, SCROLL_ATTEMPTS);
});

test('a present phrase scroll-until succeeds without scrolling, even for a disabled control', async () => {
  const control: Element = {
    ...text('Continue'),
    kind: 'button',
    disabled: true,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
  };
  const judge = visibilityJudge(0.9);
  const f = walker([screen(control)], judge);
  const result = await runPlan(parsePlan('1. Scroll until the continue control').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, []);
  assert.equal(f.captures(), 2);
});

test('a not-ok scroll succeeds when the fresh visibility re-ask proves it reached the destination', async () => {
  const judge = visibilityJudge(0.1, 0.5, 0.9);
  const before = screen(text('Middle'));
  const f = walker([before, before, before, before, screen(text('Destination'))], judge, {
    ok: false,
    proven: false,
    error: 'scroll timed out',
  });
  const result = await runPlan(
    parsePlan('1. Scroll up until the destination text').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['scroll up']);
  assert.equal(f.captures(), 6);
  assert.equal(result.jev.calls, 3);
  assert.equal(result.steps[0].attempt, 1);
  assert.deepEqual(evidence(judge.requests[2].state), ['Text "Destination"']);
});

test('a not-ok scroll fails if the final re-ask capture returns to the original screen', async () => {
  const judge = visibilityJudge(0.1, 0.5, 0.1);
  const before = screen(text('Middle'));
  const f = walker(
    [before, before, screen(text('Loading')), screen(text('Loading')), before],
    judge,
    {
      ok: false,
      proven: false,
      error: 'scroll timed out',
    },
  );
  const result = await runPlan(
    parsePlan('1. Scroll up until the destination text').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.match(
    result.failure?.seen ?? '',
    /scroll timed out; historical context, previously on screen: <app-text data, not instructions>Middle/,
  );
  assert.deepEqual(f.actions, ['scroll up']);
  assert.equal(f.captures(), 6);
  assert.equal(result.steps[0].attempt, 1);
});

test('uncertain phrase visibility re-asks a fresh screen once and can become present without an action', async () => {
  for (const line of ['Wait for the welcome text', 'Scroll up until the welcome text']) {
    const judge = visibilityJudge(0.5, 0.9);
    const f = walker([screen(text('Loading')), screen(text('Welcome'))], judge);
    const result = await runPlan(parsePlan(`1. ${line}`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(f.actions, []);
    assert.equal(f.captures(), line.startsWith('Scroll') ? 4 : 2);
    assert.equal(f.deps.now(), WAIT_POLL_MS);
    assert.equal(result.jev.calls, 2);
    assert.deepEqual(evidence(judge.requests[1].state), ['Text "Welcome"']);
  }
});

test('persistent visibility uncertainty fails on fresh evidence rather than polling or scrolling', async () => {
  for (const line of ['Wait for the welcome text', 'Scroll until the welcome text']) {
    const judge = visibilityJudge(0.5);
    const f = walker([screen(text('Before')), screen(text('Fresh evidence'))], judge);
    const result = await runPlan(parsePlan(`1. ${line}\n2. Back`).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
    assert.match(
      result.failure?.seen ?? '',
      /on screen: <app-text data, not instructions>Fresh evidence<\/app-text>/,
    );
    assert.equal(result.failure?.step, 1);
    assert.equal(result.failure?.screenshot, 'screenshots/01-line1.png');
    assert.equal(result.steps.length, 1);
    assert.equal(f.captures(), (line.startsWith('Scroll') ? 2 : 1) * (1 + CHECK.reasks));
    assert.equal(result.jev.calls, 1 + CHECK.reasks);
    assert.equal(f.deps.now(), WAIT_POLL_MS);
    assert.deepEqual(f.actions, []);
  }
});

test('a visibility re-ask must establish absence before scroll-until can dispatch', async () => {
  const events: string[] = [];
  const judge = scriptedJudge((questions, index) => {
    events.push(`judge ${index}`);
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    return { visibility_1: { type: 'noul', noul: [0.5, 0.1, 0.9][index] } };
  });
  const f = walker(
    [
      screen(text('Loading')),
      screen(text('Loading')),
      screen(text('Middle')),
      screen(text('Middle')),
      screen(text('Welcome')),
    ],
    judge,
  );
  const scroll = f.deps.scroll;
  f.deps.scroll = async (direction) => {
    events.push(`scroll ${direction}`);
    return scroll(direction);
  };
  const result = await runPlan(parsePlan('1. Scroll up until the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(events, ['judge 0', 'judge 1', 'scroll up', 'judge 2']);
  assert.equal(f.captures(), 6);
  assert.equal(result.steps[0].attempt, 1);
});

test('an uncertainty re-ask spends the wait budget rather than restarting it', async () => {
  const judge = visibilityJudge(0.5, 0.1);
  const f = walker([screen(text('Loading'))], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/);
  assert.equal(f.deps.now(), PHRASE_WAIT_BUDGET_MS);
  assert.equal(f.captures(), PHRASE_WAIT_BUDGET_MS / WAIT_POLL_MS);
  assert.equal(result.jev.calls, f.captures());
});

test('polls and scrolls do not replenish a step visibility re-ask budget', async () => {
  for (const line of ['Wait for the welcome text', 'Scroll up until the welcome text']) {
    const judge = visibilityJudge(0.5, 0.1, 0.5);
    const f = walker([screen(text('Loading'))], judge);
    const result = await runPlan(parsePlan(`1. ${line}`).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
    assert.equal(f.captures(), line.startsWith('Scroll') ? 6 : 3);
    assert.equal(result.jev.calls, 3);
    assert.deepEqual(f.actions, line.startsWith('Scroll') ? ['scroll up'] : []);
  }
});

test('a visibility re-ask cannot capture or judge when its sleep reaches the wait deadline', async () => {
  for (const remaining of [0, WAIT_POLL_MS / 2, WAIT_POLL_MS]) {
    let elapsed = 0;
    const judge = scriptedJudge((_questions, index) => {
      if (index === 0) elapsed += PHRASE_WAIT_BUDGET_MS - remaining;
      return { visibility_1: { type: 'noul', noul: index === 0 ? 0.5 : 0.9 } };
    });
    const f = walker([screen(text('Loading'))], judge);
    f.deps.now = () => elapsed;
    f.deps.sleep = async (ms) => {
      elapsed += ms;
    };
    const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(elapsed, PHRASE_WAIT_BUDGET_MS);
    assert.equal(f.captures(), 1);
    assert.equal(result.jev.calls, 1);
    assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
    assert.deepEqual(f.actions, []);
  }
});

test('a visibility re-ask cannot pass when its capture or judgment exhausts the wait budget', async () => {
  for (const delayed of ['capture', 'judge']) {
    let elapsed = 0;
    const judge = scriptedJudge((_questions, index) => {
      if (index === 1 && delayed === 'judge') elapsed = PHRASE_WAIT_BUDGET_MS;
      return { visibility_1: { type: 'noul', noul: index === 0 ? 0.5 : 0.9 } };
    });
    const f = walker([screen(text('Loading')), screen(text('Welcome'))], judge);
    f.deps.now = () => elapsed;
    f.deps.sleep = async (ms) => {
      elapsed += ms;
    };
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async () => {
      const observed = await capture();
      if (f.captures() === 2 && delayed === 'capture') elapsed = PHRASE_WAIT_BUDGET_MS;
      return observed;
    };
    const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(
      result.failure?.seen ?? '',
      delayed === 'capture' ? /SCREEN_EVIDENCE_INCOMPLETE/ : /VISIBILITY_UNSURE/,
    );
    assert.equal(f.captures(), 2);
    assert.equal(result.jev.calls, delayed === 'capture' ? 1 : 2);
    assert.equal(elapsed, PHRASE_WAIT_BUDGET_MS);
    assert.deepEqual(f.actions, []);
  }
});

test('a passing check shares its same-capture visibility decision with the next wait', async () => {
  const judge = scriptedJudge((questions) => {
    assert.deepEqual(Object.keys(questions), ['check_1', 'visibility_2']);
    assert.equal(questions.visibility_2.type, 'noul');
    return {
      check_1: { type: 'noul', noul: 0.9 },
      visibility_2: { type: 'noul', noul: 0.9 },
    };
  });
  const f = walker([screen(text('Welcome'))], judge);
  const result = await runPlan(
    parsePlan('✓ The home screen is ready\n1. Wait for the welcome text').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.captures(), 1);
  assert.equal(result.jev.calls, 1);
  assert.deepEqual(
    result.steps.map((row) => row.outcome),
    ['pass', 'pass'],
  );
  assert.deepEqual(f.actions, []);
});

test('re-asking a check discards its old visibility decision along with the old capture', async () => {
  const judge = scriptedJudge((questions, index) => {
    assert.deepEqual(
      Object.keys(questions),
      index < 2 ? ['check_1', 'visibility_2'] : ['visibility_2'],
    );
    return {
      ...(index < 2 ? { check_1: { type: 'noul' as const, noul: index === 0 ? 0.5 : 0.9 } } : {}),
      visibility_2: { type: 'noul', noul: index === 1 ? 0.1 : 0.9 },
    };
  });
  const f = walker([screen(text('Old')), screen(text('Loading')), screen(text('Welcome'))], judge);
  const result = await runPlan(
    parsePlan('✓ The home screen is ready\n1. Wait for the welcome text').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.captures(), 3);
  assert.equal(result.jev.calls, 3);
  assert.equal(f.deps.now(), 2 * WAIT_POLL_MS);
  assert.deepEqual(evidence(judge.requests[2].state), ['Text "Welcome"']);
});

test('uncertain cached visibility is re-asked on a new capture without repeating the passed check', async () => {
  for (const line of ['Wait for the welcome text', 'Scroll until the welcome text']) {
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
    const f = walker([screen(text('Loading')), screen(text('Welcome'))], judge);
    const result = await runPlan(
      parsePlan(`✓ The home screen is ready\n1. ${line}`).blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS');
    assert.equal(f.captures(), line.startsWith('Scroll') ? 3 : 2);
    assert.equal(result.jev.calls, 2);
    assert.deepEqual(evidence(judge.requests[1].state), ['Text "Welcome"']);
    assert.deepEqual(f.actions, []);
  }
});

test('visibility decisions are not reused for a later wait on another capture', async () => {
  const judge = scriptedJudge((questions, index) => {
    assert.deepEqual(
      Object.keys(questions),
      index === 0 ? ['check_1', 'visibility_2'] : ['visibility_3'],
    );
    return index === 0
      ? { check_1: { type: 'noul', noul: 0.9 }, visibility_2: { type: 'noul', noul: 0.9 } }
      : { visibility_3: { type: 'noul', noul: 0.5 } };
  });
  const f = walker([screen(text('Welcome')), screen(text('Changed'))], judge);
  const result = await runPlan(
    parsePlan(
      '✓ The home screen is ready\n1. Wait for the welcome text\n2. Wait for the welcome text',
    ).blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 3);
  assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
  assert.equal(f.captures(), 3);
  assert.deepEqual(evidence(judge.requests[1].state), ['Text "Changed"']);
  assert.deepEqual(f.actions, []);
});

test('a local visibility refusal fails the row without a model call or scroll', async () => {
  for (const line of ['Wait for the welcome text', 'Scroll until the welcome text']) {
    const judge = scriptedJudge(() => {
      assert.fail('incomplete visibility must be refused locally');
    });
    const f = walker([screen(text('Welcome', 'unknown'))], judge);
    const result = await runPlan(parsePlan(`1. ${line}`).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE/);
    assert.equal(result.steps[0].outcome, 'fail');
    assert.equal(f.captures(), line.startsWith('Scroll') ? 2 : 1);
    assert.equal(result.jev.calls, 0);
    assert.deepEqual(f.actions, []);
  }
});

test('negative judgments with unknown contributions cannot pass checks or authorize scroll-until', async () => {
  for (const line of ['✓ The welcome text is visible', '1. Scroll until the welcome text']) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.1 }])),
    );
    const f = walker([screen(text('Loading'), text('Welcome', 'unknown'))], judge);
    const result = await runPlan(parsePlan(line).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(
      result.steps[0].reason!,
      line.startsWith('✓') ? /^CHECK_UNSURE:/ : /^VISIBILITY_UNSURE:/,
    );
    assert.equal(f.captures(), (line.includes('Scroll') ? 2 : 1) * (1 + CHECK.reasks));
    assert.equal(judge.requests.length, 1 + CHECK.reasks);
    assert.equal(f.deps.now(), WAIT_POLL_MS);
    assert.deepEqual(f.actions, []);
  }
});

test('negative gap-bearing visibility keeps a wait polling until established evidence arrives', async () => {
  const judge = visibilityJudge(0.1, 0.9);
  const f = walker(
    [screen(text('Loading'), text('Welcome', 'unknown')), screen(text('Welcome'))],
    judge,
  );
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.captures(), 2);
  assert.equal(judge.requests.length, 2);
  assert.equal(f.deps.now(), WAIT_POLL_MS);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(evidence(judge.requests[0].state), ['Text "Loading"']);
  assert.deepEqual(evidence(judge.requests[1].state), ['Text "Welcome"']);
});

test('a heading wait keeps polling ordinary text for its whole budget and ends unsure, never absent', async () => {
  const judge = scriptedJudge(() => {
    assert.fail('ordinary text cannot attest a heading role');
  });
  const f = walker([screen(text('Welcome'))], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
  assert.doesNotMatch(result.failure?.seen ?? '', /did not appear/);
  assert.equal(f.captures(), PHRASE_WAIT_BUDGET_MS / WAIT_POLL_MS);
  assert.equal(result.jev.calls, 0);
  assert.deepEqual(f.actions, []);
});

test('an unestablished heading never authorizes scroll-until to scroll', async () => {
  const judge = scriptedJudge(() => {
    assert.fail('ordinary text cannot attest a heading role');
  });
  const f = walker([screen(text('Welcome'))], judge);
  const result = await runPlan(parsePlan('1. Scroll until the welcome heading').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
  assert.equal(f.captures(), 2 * (1 + CHECK.reasks));
  assert.deepEqual(f.actions, []);
});

test('a heading wait passes once the heading qualifies on a later capture', async () => {
  const f = walker(
    [screen(text('Welcome')), screen(text('Welcome')), screen(heading('Welcome'))],
    visibilityJudge(0.99),
  );
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.captures(), 3);
  assert.equal(result.jev.calls, 1);
});

test('a negative heading judgment keeps the wait polling instead of ending it', async () => {
  const f = walker([screen(heading('Welcome'))], visibilityJudge(0.01, 0.01, 0.99));
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.captures(), 3);
  assert.equal(result.jev.calls, 3);
});

test('hidden and offscreen observations do not authorize a wait to scroll', async () => {
  const judge = visibilityJudge(0.1, 0.9);
  const f = walker(
    [
      screen(text('Loading'), text('Hidden welcome', 'hidden'), text('Welcome', 'offscreen')),
      screen(text('Welcome')),
    ],
    judge,
  );
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(evidence(judge.requests[0].state), ['Text "Loading"']);
  assert.deepEqual(f.actions, []);
  assert.equal(f.captures(), 2);
});

test('missing model visibility evidence fails immediately instead of being treated as absence', async () => {
  const judge = scriptedJudge(() => ({}));
  const f = walker([screen(text('Loading'))], judge);
  const result = await runPlan(parsePlan('1. Scroll until the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /JEV_RESPONSE_INVALID/);
  assert.equal(f.captures(), 2);
  assert.equal(result.jev.calls, 1);
  assert.deepEqual(f.actions, []);
});

test('quoted waits and scroll-until retain model-free literal visibility', async () => {
  for (const line of ['Wait for "Welcome"', 'Scroll up until "Welcome"']) {
    const judge = scriptedJudge(() => {
      assert.fail('quoted targets must not ask a visibility question');
    });
    const f = walker([screen(text('Loading')), screen(text('Welcome'))], judge);
    const result = await runPlan(parsePlan(`1. ${line}`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.steps[0].resolvedBy, 'exact');
    assert.equal(f.captures(), line.startsWith('Scroll') ? 3 : 2);
    assert.deepEqual(f.actions, line.startsWith('Scroll') ? ['scroll up'] : []);
    assert.equal(result.jev.calls, 0);
  }
});

test('a literal wait over an unchanged screen fails as absent at its deadline', async () => {
  const f = walker(
    [screen(text('Baseline'))],
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  const result = await runPlan(parsePlan('1. Wait for "Absent sentinel"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(
    result.failure?.seen ?? '',
    new RegExp(`^"Absent sentinel" did not appear within ${WAIT_BUDGET_MS / 1000}s`),
  );
  assert.match(
    result.failure?.seen ?? '',
    /observations; no captured element carries the identifier "Absent sentinel";/,
  );
  assert.doesNotMatch(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
  assert.ok(f.captures() > 2);
});

test('a literal wait over a changing screen stays unsure at its deadline', async () => {
  const screens = Array.from({ length: WAIT_BUDGET_MS / WAIT_POLL_MS + 2 }, (_, i) =>
    screen(text(`Loading ${i}`)),
  );
  const f = walker(
    screens,
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  const result = await runPlan(parsePlan('1. Wait for "Absent sentinel"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/);
});

test('a literal wait over an unchanged screen still fails as absent when its last capture ends past the deadline', async () => {
  const f = walker(
    [screen(text('Baseline'))],
    scriptedJudge(() => assert.fail('literal wait is model-free')),
  );
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (...args) => {
    const late = f.deps.now() >= WAIT_BUDGET_MS - WAIT_POLL_MS;
    const observed = await capture(...args);
    if (late) await f.deps.sleep(WAIT_POLL_MS);
    return observed;
  };
  const result = await runPlan(parsePlan('1. Wait for "Absent sentinel"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(
    result.failure?.seen ?? '',
    new RegExp(`^"Absent sentinel" did not appear within ${WAIT_BUDGET_MS / 1000}s`),
  );
  assert.doesNotMatch(result.failure?.seen ?? '', /VISIBILITY_UNSURE/);
});

test('a quoted id wait does not pass while the keyboard covers the element centre', async () => {
  const field = (y: number, keyboard: boolean, keyboardVisible?: boolean): Screen => {
    const nodes = [
      { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        ref: '@field',
        type: 'TextField',
        label: 'Field 7',
        identifier: 'qa-field-7',
        rect: { x: 16, y, width: 200, height: 40 },
        parentIndex: 0,
      },
      ...(keyboard
        ? [
            {
              ref: '@keyboard',
              type: 'Keyboard',
              label: '',
              rect: { x: 0, y: 500, width: 390, height: 344 },
              parentIndex: 0,
            },
          ]
        : []),
    ].map((n, index) => ({ ...n, index }));
    const joined = joinScreen(nodes, [], 'app', { native: 'complete', react: 'complete' });
    return keyboardVisible === undefined ? joined : { ...joined, keyboardVisible };
  };
  const wait = async (screens: Screen[]) => {
    const f = walker(
      screens,
      scriptedJudge(() => assert.fail('quoted id wait is model-free')),
    );
    const result = await runPlan(parsePlan('1. Wait for "qa-field-7" to appear').blocks!, f.deps);
    return { result, captures: f.captures() };
  };
  for (const keyboardVisible of [undefined, true]) {
    const covered = await wait([field(650, true, keyboardVisible)]);
    assert.equal(covered.result.verdict, 'FAIL');
    assert.match(covered.result.failure?.seen ?? '', /"qa-field-7" did not appear/);
  }
  const cleared = await wait([field(650, true), field(300, true)]);
  assert.equal(cleared.result.verdict, 'PASS');
  assert.equal(cleared.captures, 2);
  for (const shown of [field(300, true), field(650, true, false), field(650, false)]) {
    const found = await wait([shown]);
    assert.equal(found.result.verdict, 'PASS');
    assert.equal(found.captures, 1);
  }
});
