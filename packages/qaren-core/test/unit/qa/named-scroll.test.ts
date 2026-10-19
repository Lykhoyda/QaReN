import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan, SCROLL_ATTEMPTS } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

function band(index: number, visible = false, kind: 'button' | 'input' = 'button') {
  return screen([
    element('@band', `Band ${index}`, { kind: 'text' }),
    element('@pager', 'Pager', { kind, offscreen: !visible, hittable: visible }),
  ]);
}

const judge = () => scriptedJudge((q) => ({ target_1: choice(q.target_1) }));

for (const kind of ['button', 'input'] as const) {
  const phrase = kind === 'button' ? 'Tap Pager' : 'Type "x" into the Pager field';
  const quoted = kind === 'button' ? 'Tap "Pager"' : 'Type "x" into "Pager"';

  test(`a uniquely named ${kind} two bands away settles after each scroll, then acts`, async () => {
    const f = walker(
      [
        band(0, false, kind),
        band(1, false, kind),
        band(1, false, kind),
        band(2, true, kind),
        band(2, true, kind),
      ],
      judge(),
    );
    const result = await runPlan(parsePlan(`1. ${phrase}`).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(f.actions, [
      'scroll down',
      'scroll down',
      kind === 'button' ? 'press @pager' : 'fill @pager x',
    ]);
    assert.equal(f.captures(), 6);
  });

  test(`a quoted offscreen ${kind} keeps exactly one scroll`, async () => {
    const f = walker([band(0, false, kind), band(1, false, kind), band(1, false, kind)], judge());
    const result = await runPlan(parsePlan(`1. ${quoted}`).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /stayed off screen after one scroll/);
    assert.deepEqual(f.actions, ['scroll down']);
  });
}

test('a named target still offscreen after six changing bands refuses with its scroll count', async () => {
  const screens = [
    band(0),
    ...Array.from({ length: SCROLL_ATTEMPTS }, (_, i) => [band(i + 1), band(i + 1)]).flat(),
  ];
  const f = walker(screens, judge());
  const result = await runPlan(parsePlan('1. Tap Pager').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /stayed off screen after 6 scrolls/);
  assert.deepEqual(f.actions, Array(SCROLL_ATTEMPTS).fill('scroll down'));
});

test('named-target scrolling stops when a settled screen no longer changes', async () => {
  const f = walker([band(0), band(1), band(1), band(1), band(1)], judge());
  const result = await runPlan(parsePlan('1. Tap Pager').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /stayed off screen after 2 scrolls/);
  assert.deepEqual(f.actions, ['scroll down', 'scroll down']);
});

test('named-target scrolling preserves the existing deadline cancellation', async () => {
  let now = 0;
  const f = walker([band(0), band(1), band(1), band(2), band(2)], judge());
  f.deps.now = () => now;
  f.deps.cancelled = () => now >= 2;
  f.deps.scroll = async (direction, context) => {
    context.authorize();
    f.actions.push(`scroll ${direction}`);
    now++;
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Tap Pager').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /RUN_CANCELLED/);
  assert.deepEqual(f.actions, ['scroll down', 'scroll down']);
});
