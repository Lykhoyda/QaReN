import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { join, screenSignature, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { PHRASE_WAIT_BUDGET_MS } from '../../../dist/qa/timing.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const shown = (label: string): Screen => screen([element('@text', label, { kind: 'text' })]);

function fixture(initial: Screen) {
  const judge = scriptedJudge((questions, _index, state) =>
    Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { type: 'noul', noul: JSON.stringify(state).includes('Welcome') ? 0.9 : 0.1 },
      ]),
    ),
  );
  const f = walker([initial], judge);
  const modes: boolean[] = [];
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    modes.push(options?.platformPresence === true);
    return capture(options);
  };
  return { f, judge, modes };
}

function assertNextPoll(now: number, changedAt: number): void {
  assert.ok(now >= changedAt && now <= changedAt + WAIT_POLL_MS);
}

test('a transient title qualification is observed on the next heading poll', async () => {
  const body = shown('Welcome');
  const title = structuredClone(body);
  title.elements[0].semantic!.nativePresence = {
    kind: 'text',
    labelSource: 'direct',
    structural: false,
  };
  title.elements[0].semantic!.heading = {
    kind: 'typographic-title',
    hostIndex: 0,
    anchorRef: '@text',
    bodyRefs: [],
  };
  assert.equal(screenSignature(body), screenSignature(title));
  const { f, judge, modes } = fixture(body);
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    await capture(options);
    return f.deps.now() >= 1_000 && f.deps.now() < 8_000 ? title : body;
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assertNextPoll(f.deps.now(), 1_000);
  assert.deepEqual(modes, [true, true, true]);
  assert.equal(judge.calls.length, 1);
});

test('geometry-only scroll clipping changes are observed on the next phrase poll', async () => {
  const geometry = (y: number) => {
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: '@window',
        type: 'Window',
        parentIndex: 0,
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@scroll',
        type: 'ScrollView',
        parentIndex: 1,
        rect: { x: 0, y: 100, width: 400, height: 100 },
      },
      {
        ref: '@text',
        type: 'StaticText',
        parentIndex: 2,
        label: 'Welcome',
        hittable: true,
        rect: { x: 10, y, width: 100, height: 20 },
      },
      {
        ref: '@loading',
        type: 'StaticText',
        parentIndex: 1,
        label: 'Loading',
        hittable: true,
        rect: { x: 10, y: 400, width: 100, height: 20 },
      },
    ];
    const presence: NativePresence = {
      source: 'xcui-live',
      nodes: nodes.map((_, index) => ({
        status: index === 4 || (index === 3 && y === 150) ? 'observed' : 'unknown',
        labelSource: 'direct',
      })),
    };
    const coverage = { native: 'complete', react: 'complete' } as const;
    return {
      plain: join(nodes, [], 'app', coverage),
      observed: join(nodes, [], 'app', coverage, undefined, presence),
    };
  };
  const clipped = geometry(210);
  const visible = geometry(150);
  assert.notEqual(screenSignature(clipped.plain), screenSignature(visible.plain));
  assert.equal(clipped.observed.elements[3].semantic?.visibility, 'offscreen');
  assert.equal(visible.observed.elements[3].semantic?.visibility, 'visible');
  const { f, judge, modes } = fixture(clipped.observed);
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    await capture(options);
    const current = f.deps.now() >= 1_000 && f.deps.now() < 8_000 ? visible : clipped;
    return options?.platformPresence ? current.observed : current.plain;
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assertNextPoll(f.deps.now(), 1_000);
  assert.deepEqual(modes, [true, true, true]);
  assert.equal(judge.calls.length, 3);
});

test('Welcome returning after a Loading capture is observed at the next poll', async () => {
  const { f, judge, modes } = fixture(shown('Welcome'));
  let presenceCaptures = 0;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    await capture(options);
    if (!options?.platformPresence) return shown('Welcome');
    presenceCaptures++;
    return presenceCaptures === 1 || f.deps.now() >= 8_000 ? shown('Loading') : shown('Welcome');
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assertNextPoll(f.deps.now(), WAIT_POLL_MS);
  assert.deepEqual(modes, [true, true]);
  assert.equal(judge.calls.length, 2);
  assert.ok(JSON.stringify(judge.requests[0].state).includes('Loading'));
  assert.ok(JSON.stringify(judge.requests[1].state).includes('Welcome'));
});

test('an unchanged screen receives one presence capture and judgment per poll', async () => {
  const { f, judge, modes } = fixture(shown('Loading'));
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /ITEM_DEADLINE_EXCEEDED/);
  assert.equal(f.deps.now(), PHRASE_WAIT_BUDGET_MS);
  assert.equal(f.captures(), PHRASE_WAIT_BUDGET_MS / WAIT_POLL_MS);
  assert.equal(judge.calls.length, f.captures());
  assert.deepEqual(modes, Array(f.captures()).fill(true));
});
