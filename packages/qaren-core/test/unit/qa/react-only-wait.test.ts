import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { DigestEntry, Front, NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';
import { reactOnlyMiss } from '../../../dist/qa/resolve.js';
import { runPlan, WAIT_BUDGET_MS, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import type { ActResult } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

// A text field inside a wrapper view inside a 600-point scroll view, in a window whose native origin
// is 20 points down; React lays everything out in window points, the field at fieldY.
const O = 20;
interface Form {
  fieldY?: number;
  accessible?: boolean;
  nativeField?: boolean;
  typography?: boolean;
  front?: Front;
  native?: 'complete' | 'incomplete';
  // A second, unrelated scroll view below the form, which scroll-until would pick as its band.
  otherScroll?: boolean;
  // The scroll view's height; taller than the 844-point window, the window clips it.
  scrollHeight?: number;
}

function form(presence: boolean, f: Form = {}) {
  const { fieldY = 404, accessible = true, nativeField = false, typography = true } = f;
  const nodes: NativeNode[] = [
    { ref: '@w', index: 0, type: 'Window', rect: { x: 0, y: O, width: 390, height: 844 } },
    {
      ref: '@s',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'form-scroll',
      rect: { x: 0, y: O, width: 390, height: f.scrollHeight ?? 600 },
    },
    {
      ref: '@p',
      index: 2,
      parentIndex: 1,
      type: accessible ? 'Button' : 'Other',
      identifier: 'name-wrapper',
      label: 'Wrapper label',
      hittable: true,
      rect: { x: 16, y: O + 400, width: 358, height: 48 },
    },
    ...(nativeField
      ? [
          {
            ref: '@f',
            index: 3,
            parentIndex: 2,
            type: 'TextField',
            identifier: 'name-field',
            hittable: true,
            rect: { x: 24, y: O + 404, width: 340, height: 40 },
          },
        ]
      : []),
  ];
  if (f.otherScroll)
    nodes.push({
      ref: '@o',
      index: nodes.length,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'other-scroll',
      rect: { x: 0, y: O + 620, width: 390, height: 200 },
    });
  const view = (hostIndex: number, parent: number | null, type: string, a: string, y: number) => ({
    hostIndex,
    parentHostIndex: parent,
    rootIndex: 0,
    hostType: type,
    accessibility: { accessible: a as 'true' | 'absent', authoredLabel: 'absent' as const },
    rect:
      hostIndex === 0
        ? { x: 0, y: 0, width: 390, height: f.scrollHeight ?? 600 }
        : { x: 16, y, width: 358, height: 48 },
    text: { kind: 'none' as const },
  });
  const host: ReactHostEvidence = {
    complete: true,
    hosts: [
      { testID: 'form-scroll', role: null, roleSource: 'none', capabilities: {} },
      { testID: 'name-wrapper', role: null, roleSource: 'none', capabilities: { press: true } },
      { testID: 'name-field', role: null, roleSource: 'none', capabilities: { fill: true } },
    ],
    ...(presence && typography
      ? {
          typography: {
            version: 1,
            complete: true,
            durationMs: 5,
            coordinateSpace: 'window-points',
            nodes: [
              view(0, null, 'RCTScrollView', 'absent', 0),
              view(1, 0, 'RCTView', accessible ? 'true' : 'absent', 400),
              {
                ...view(2, 1, 'RCTSinglelineTextInputView', 'absent', fieldY),
                rect: { x: 24, y: fieldY, width: 340, height: 40 },
              },
            ],
          },
        }
      : {}),
  };
  const digest: DigestEntry[] = [
    { role: 'button', testID: 'name-wrapper', capabilities: { press: true, fill: false } },
    {
      role: 'textinput',
      testID: 'name-field',
      label: 'Full name',
      placeholder: 'Type your name',
      value: 'Ada Example',
      capabilities: { press: false, fill: true },
      inputHostIndices: [2],
    },
  ];
  return join(
    nodes,
    digest,
    f.front ?? 'app',
    { native: f.native ?? 'complete', react: 'complete' },
    host,
    presence
      ? {
          source: 'xcui-live',
          nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
        }
      : undefined,
  );
}

// Each capture takes the next form, built for the presence the walker asked for.
async function wait(forms: Form[], plan = '1. Wait for "name-field" to appear', act?: ActResult) {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted wait is model-free')),
    act,
  );
  const presence: boolean[] = [];
  f.deps.captureScreen = async (options) => {
    presence.push(options?.platformPresence === true);
    return form(
      options?.platformPresence === true,
      forms[Math.min(presence.length - 1, forms.length - 1)],
    );
  };
  const blocks = parsePlan(plan).blocks!;
  const started = f.deps.now();
  const result = await runPlan(blocks, f.deps);
  return { result, presence, actions: f.actions, elapsed: f.deps.now() - started, blocks, f };
}

const seen = (r: Awaited<ReturnType<typeof wait>>) => r.result.failure?.seen ?? '';

test('a field past the window but inside a taller scroll view is not inside its viewport', async () => {
  // The window clips the 1000-point scroll view at 864; the field starts at 944.
  const r = await wait([{ scrollHeight: 1000, fieldY: 924 }]);
  assert.doesNotMatch(seen(r), / inside its viewport;/);
  assert.match(seen(r), / below its viewport;/);
  assert.notEqual(r.elapsed, 2 * WAIT_POLL_MS);
});

test('a field swallowed by an accessible wrapper inside the viewport refuses early with its facts', async () => {
  const r = await wait([{}]);
  assert.equal(r.result.verdict, 'FAIL');
  assert.match(
    seen(r),
    /^TARGET_REACT_ONLY: "name-field" is mounted in React but absent from the native capture across 2 observations; input id=name-field frame=unknown react-only; react layout=24,424,340,40 inside its viewport; accessible ancestor=button id=name-wrapper frame=16,420,358,48 native; nearest native ancestor=button id=name-wrapper frame=16,420,358,48 native; host=2; attempt=none; next step: /,
  );
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.presence, [false, true, true]);
  assert.equal(r.elapsed, 2 * WAIT_POLL_MS);
});

test('the refusal names no label, placeholder or value', async () => {
  const reason = reactOnlyMiss(
    { quoted: 'name-field', phrase: 'name-field' },
    form(true),
    2,
    'none',
  )!;
  const r = await wait([{}]);
  const rows = JSON.stringify(r.f.rows);
  assert.match(seen(r), /^TARGET_REACT_ONLY: /);
  for (const value of ['Wrapper label', 'Full name', 'Type your name', 'Ada Example'])
    assert.ok(!reason.includes(value), value);
  // The wrapper's label is screen text the failure's existing context may carry; field facts never are.
  for (const value of ['Full name', 'Type your name', 'Ada Example'])
    assert.ok(!rows.includes(value) && !seen(r).includes(value), value);
});

test('a field below the fold of its scroll view gets one scroll and passes on native evidence', async () => {
  const below = { fieldY: 700, accessible: false };
  const r = await wait([below, below, below, { accessible: false, nativeField: true }]);
  assert.equal(r.result.verdict, 'PASS', seen(r));
  assert.deepEqual(r.actions, ['scroll down']);
  assert.deepEqual(r.presence, [false, true, true, true]);
});

test('a field still React-only after its one scroll ends with the typed reason at the deadline', async () => {
  // Inside the window, below the scroll view's 620-point edge: only its own container calls it below.
  const r = await wait([{ fieldY: 700, accessible: false }]);
  assert.equal(r.result.verdict, 'FAIL');
  assert.match(
    seen(r),
    /^TARGET_REACT_ONLY: .* below its viewport; accessible ancestor=none; .*; attempt=scroll; /,
  );
  assert.deepEqual(r.actions, ['scroll down']);
  assert.equal(r.elapsed, WAIT_BUDGET_MS);
});

test('a field above its scroll view scrolls up, and never through another container', async () => {
  const above = await wait([{ fieldY: -200, accessible: false }]);
  assert.deepEqual(above.actions, ['scroll up']);
  assert.match(seen(above), / above its viewport; .*; attempt=scroll; /);
  const other = await wait([{ fieldY: 700, accessible: false, otherScroll: true }]);
  assert.deepEqual(other.actions, []);
  assert.match(seen(other), / below its viewport; .*; attempt=none; /);
});

test('a scroll that moves nothing fails with the dispatch error', async () => {
  const r = await wait([{ fieldY: 700, accessible: false }], undefined, {
    ok: false,
    error: 'scroll refused by the runner',
  });
  assert.equal(r.result.verdict, 'FAIL');
  assert.match(seen(r), /scroll refused by the runner/);
  assert.deepEqual(r.actions, ['scroll down']);
});

test('without React layout facts the wait keeps its budget and ends with the typed reason', async () => {
  const r = await wait([{ typography: false }]);
  assert.equal(r.result.verdict, 'FAIL');
  assert.match(seen(r), /^TARGET_REACT_ONLY: .*; react layout=none; accessible ancestor=none; /);
  assert.match(seen(r), /; host=2; attempt=none; next step: /);
  assert.deepEqual(r.actions, []);
  assert.equal(r.elapsed, WAIT_BUDGET_MS);
});

test('a field that turns native before the deadline still passes', async () => {
  const r = await wait([
    { accessible: false },
    { accessible: false },
    { accessible: false },
    { accessible: false, nativeField: true },
  ]);
  assert.equal(r.result.verdict, 'PASS', seen(r));
  assert.deepEqual(r.actions, []);
});

test('incomplete native coverage, a dialog in front, a stored id or a block start never refuse early', async () => {
  const incomplete = await wait([{ native: 'incomplete' }]);
  assert.match(seen(incomplete), /^SCREEN_EVIDENCE_INCOMPLETE: /);
  const dialog = await wait([{ front: 'dialog' }]);
  assert.match(seen(dialog), /^TARGET_REACT_ONLY: /);
  assert.equal(dialog.elapsed, WAIT_BUDGET_MS);
  assert.deepEqual([...incomplete.actions, ...dialog.actions], []);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('model-free')),
  );
  f.deps.captureScreen = async (options) => form(options?.platformPresence === true);
  const blocks = parsePlan('1. Wait for "name-field" to appear').blocks!;
  const item = blocks[0].items[0] as { target: { exact?: 'id' } };
  item.target.exact = 'id';
  const stored = await runPlan(blocks, f.deps);
  assert.equal(stored.verdict, 'FAIL');
  assert.equal(f.deps.now(), WAIT_BUDGET_MS);
  assert.match(stored.failure?.seen ?? '', /TARGET_REACT_ONLY: /);
  assert.deepEqual(f.actions, []);

  const g = walker(
    [],
    scriptedJudge(() => assert.fail('model-free')),
  );
  g.deps.captureScreen = async (options) => form(options?.platformPresence === true);
  const start = parsePlan('1. Wait for "name-field" to appear').blocks!;
  (start[0].items[0] as { precondition?: boolean }).precondition = true;
  const missing = await runPlan(start, g.deps);
  assert.match(missing.failure?.seen ?? '', /^BLOCK_START_MISSING: /);
  assert.deepEqual(g.actions, []);
});

test("a native carrier keeps today's miss text and requests no React facts", async () => {
  const r = await wait(
    [{ accessible: false, nativeField: true, fieldY: 404 }],
    '1. Wait for "absent-id" to appear',
  );
  assert.equal(r.result.verdict, 'FAIL');
  assert.match(
    seen(r),
    /did not appear within 15s; .*no captured element carries the identifier "absent-id"/,
  );
  assert.ok(r.presence.every((p) => !p));
  // The field's native carrier drops its React-only twin, so the wait passes at once.
  const twin = await wait([{ accessible: false, nativeField: true }]);
  assert.equal(twin.result.verdict, 'PASS', seen(twin));
  assert.deepEqual(twin.presence, [false]);
  assert.equal(
    reactOnlyMiss(
      { quoted: 'name-field', phrase: 'name-field' },
      form(true, { nativeField: true }),
      2,
      'none',
    ),
    undefined,
  );
});
