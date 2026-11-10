import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';
import {
  join,
  modalCoverDiagnostic,
  type NativeNode,
  type Screen,
} from '../../../dist/qa/screen.js';
import { replayBlock, runPlan, walkBlock, type WalkerDeps } from '../../../dist/qa/walker.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';
import { formWithCancel } from './modal-fixtures.ts';

const tap = () => parsePlan('1. Tap "submit"\n').blocks![0];

function screen(
  options: { keyboard?: boolean; target?: boolean; x?: number; excludedTwins?: boolean } = {},
): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    { ref: '@heading', type: 'StaticText', parentIndex: 1, label: 'Form' },
    ...(options.target
      ? [
          {
            ref: '@submit',
            type: 'Button',
            parentIndex: 1,
            identifier: 'submit',
            label: 'Continue',
            hittable: true,
            rect: {
              x: options.x ?? 20,
              y: options.excludedTwins ? 900 : 200,
              width: 100,
              height: 44,
            },
          },
        ]
      : []),
  ];
  if (options.excludedTwins) nodes.push({ ...nodes.at(-1)!, ref: '@twin' });
  return {
    ...join(
      nodes,
      [],
      'app',
      { native: 'complete', react: 'complete' },
      {
        hosts: [],
        complete: true,
        typography: {
          version: 1,
          complete: true,
          durationMs: 1,
          coordinateSpace: 'window-points',
          nodes: [],
        },
      },
      {
        source: 'xcui-live',
        nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
      },
    ),
    keyboardVisible: options.keyboard ?? false,
  };
}

function device(initial: Screen) {
  let current = initial;
  let time = 0;
  const actions: string[] = [];
  const notes: string[] = [];
  const captures: Array<{ presence: boolean; typography: boolean }> = [];
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen(options) {
      const presence = options?.platformPresence === true;
      const typography = presence || options?.typography === true;
      captures.push({ presence, typography });
      time += 100;
      return typography ? current : { ...current, elements: [...current.elements] };
    },
    async dismissKeyboard(context) {
      context.authorize();
      actions.push('dismiss');
      return 'js';
    },
    async press(ref, context) {
      context.authorize();
      actions.push(`press ${ref}`);
      return { ok: true, proven: true };
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      throw new Error('unexpected scroll');
    },
    async back() {
      throw new Error('unexpected back');
    },
    async dialog(_action, context) {
      context.authorize();
      actions.push('dialog');
      return { ok: true, proven: true, executed: true };
    },
    async hideDevMenu() {
      throw new Error('unexpected dev menu');
    },
    async screenshot(name) {
      return name;
    },
    now: () => time,
    async sleep(ms) {
      time += ms;
    },
    row() {},
    note: (line) => notes.push(line),
  };
  return {
    deps,
    actions,
    captures,
    notes,
    show: (next: Screen) => {
      current = next;
    },
  };
}

test('an absent quoted Tap hides the keyboard once, resolves again and passes on the same attempt', async () => {
  const initial = screen({ keyboard: true });
  assert.equal(modalCoverDiagnostic(initial)?.modalCount, 0);
  assert.equal(modalCoverDiagnostic(initial)?.refused, 'modal-count');
  const f = device(initial);
  const dismiss = f.deps.dismissKeyboard!;
  f.deps.dismissKeyboard = async (context) => {
    const via = await dismiss(context);
    f.show(screen({ target: true }));
    return via;
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.actions, ['dismiss', 'press @submit']);
  assert.equal(outcome.rows.at(-1)?.keyboardCleared, 'js');
  assert.equal(outcome.rows.at(-1)?.attempt, 1);
  assert.equal(outcome.rows.at(-1)?.retryCause, undefined);
  assert.ok(f.notes.includes('keyboard-clearance {"line":1,"via":"js","hidden":true}'));
  assert.equal(
    f.captures.some((capture) => capture.presence),
    false,
  );
});

for (const hidden of [true, false]) {
  test(`a still absent Tap reports that the keyboard ${hidden ? 'was hidden' : 'could not be hidden'} and preserves surface recovery`, async () => {
    const f = device(screen({ keyboard: true }));
    const dismiss = f.deps.dismissKeyboard!;
    f.deps.dismissKeyboard = async (context) => {
      await dismiss(context);
      f.show({ ...formWithCancel(false), keyboardVisible: !hidden });
      return hidden ? 'js' : 'none';
    };
    const outcome = await walkBlock(tap(), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(f.actions, ['dismiss']);
    assert.match(
      JSON.stringify(outcome.failure?.seen),
      hidden
        ? /; the keyboard was hidden and the target is still not found/
        : /; the keyboard could not be hidden/,
    );
    assert.equal(f.captures.filter((capture) => capture.presence).length, 1);
    // Without the TARGET_NOT_FOUND surface proof this form's Cancel would be pressed.
    assert.equal(outcome.rows.at(-1)?.interruption?.veto, 'uncovered-target');
    assert.equal(outcome.rows.at(-1)?.keyboardCleared, hidden ? 'js' : undefined);
  });
}

test('recovery retry cannot dismiss the keyboard a second time for an absent target', async () => {
  const f = device(screen({ keyboard: true }));
  const acquire = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    if (options?.platformPresence && !f.actions.includes('dialog')) {
      const dialog = screen();
      dialog.front = 'dialog';
      f.show(dialog);
    }
    return acquire(options);
  };
  const dialog = f.deps.dialog;
  f.deps.dialog = async (action, context) => {
    const result = await dialog(action, context);
    f.show(screen({ keyboard: true }));
    return result;
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.actions, ['dismiss', 'dialog']);
  assert.ok(outcome.rows.some((row) => row.outcome === 'retry'));
});

test('dismissal that navigates resolves the target at its new screen position', async () => {
  const f = device(screen({ keyboard: true }));
  const dismiss = f.deps.dismissKeyboard!;
  f.deps.dismissKeyboard = async (context) => {
    const via = await dismiss(context);
    const next = screen({ target: true, x: 180 });
    next.elements.find((e) => e.ref === '@submit')!.ref = '@new-submit';
    f.show(next);
    return via;
  };
  f.deps.press = async (ref, context) => {
    context.authorize();
    f.actions.push(`press ${ref}`);
    assert.equal(ref, '@new-submit');
    return { ok: true, proven: true };
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.actions, ['dismiss', 'press @new-submit']);
});

for (const variant of [
  'disabled',
  'set-aside',
  'ambiguous',
  'replay',
  'dialog',
  'modal',
  'hidden',
  'android',
  'guard-disabled',
  'fill',
  'launch',
  'no-modal-proof',
] as const) {
  test(`absent-target clearance does not dismiss for ${variant}`, async () => {
    const initial =
      variant === 'modal'
        ? { ...formWithCancel(true, 'Stay'), keyboardVisible: true }
        : screen({
            keyboard: variant !== 'hidden',
            target: ['disabled', 'set-aside', 'ambiguous'].includes(variant),
            excludedTwins: variant === 'set-aside',
          });
    const block = variant === 'fill' ? parsePlan('1. Fill "submit" with "Ada"').blocks![0] : tap();
    if (variant === 'disabled') initial.elements.find((e) => e.ref === '@submit')!.disabled = true;
    if (variant === 'set-aside' || variant === 'ambiguous') {
      const target = initial.elements.find((e) => e.ref === '@submit')!;
      if (variant === 'ambiguous') initial.elements.push({ ...target, ref: '@twin' });
      if (variant === 'set-aside') {
        const refused = prepareTarget(block.items[0], initial);
        assert.ok('refuse' in refused && refused.refuse === 'TARGET_NOT_FOUND');
        assert.ok(!('missing' in refused));
      }
    }
    if (variant === 'dialog') initial.front = 'dialog';
    if (variant === 'no-modal-proof') initial.elements = [...initial.elements];
    const f = device(initial);
    if (variant === 'android') f.deps.platform = 'android';
    if (variant === 'guard-disabled') delete f.deps.dismissKeyboard;
    const replayed =
      variant === 'replay'
        ? replayBlock(block, {
            header: { appId: 'app', plan: block.slug, planHash: block.planHash, platform: 'ios' },
            steps: [{ kind: 'press', raw: block.items[0].raw, selector: { id: 'submit' } }],
          })
        : block;
    if (variant === 'launch') await runPlan([replayed], f.deps);
    else await walkBlock(replayed, f.deps);
    assert.equal(f.actions.includes('dismiss'), false);
    if (['android', 'fill', 'guard-disabled'].includes(variant))
      assert.equal(f.captures.some((capture) => capture.typography && !capture.presence), false);
  });
}

test('a name-mismatched phrase target does not dismiss the keyboard', async () => {
  const initial = screen({ keyboard: true, target: true });
  const f = device(initial);
  f.deps.judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  const outcome = await walkBlock(parsePlan('1. Tap the Save button').blocks![0], f.deps);
  assert.match(JSON.stringify(outcome.failure?.seen), /TARGET_NOT_FOUND/);
  assert.deepEqual(f.actions, []);
});
