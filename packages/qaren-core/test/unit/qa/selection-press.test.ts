import { choice, scriptedJudge } from './judgment-fixtures.ts';
import { resultForWalk, exitCodeFor, createWriter } from '../../../dist/qa/wire.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
// A control whose only visible change is its selected state proves its press by that change alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, screenSignature } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { NativeCaptureError } from '../../../dist/qa/capture.js';
import { QaDispatchError } from '../../../dist/domain/qa-dispatch.js';
import { withCancellation, RunCancelledError } from '../../../dist/domain/cancellation.js';
import { selectionPressCandidate } from '../../../dist/qa/selection-press.js';
import { elementFrame } from '../../../dist/qa/screen.js';
import { walkBlock, runPlan } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

function chips(selected: 'Male' | 'Female' | undefined, refPrefix = '@'): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@win',
      index: 1,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    ...(['Male', 'Female'] as const).map((label, i) => ({
      ref: `${refPrefix}${label.toLowerCase()}`,
      index: 2 + i,
      parentIndex: 1,
      type: 'Button',
      label,
      identifier: `gender_${label === 'Male' ? 'm' : 'f'}`,
      hittable: true,
      rect: { x: 20 + i * 180, y: 300, width: 160, height: 44 },
      ...(selected === label ? { selected: true } : {}),
    })),
  ];
  return { ...join(nodes, []), coverage: { native: 'complete', react: 'complete' } };
}

function fake(screens: Screen[], press: ActResult[] = []) {
  const calls: string[] = [];
  const queue = [...screens];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return press.shift() ?? { ok: true, proven: false };
    },
    async fill() {
      return { ok: true, proven: true };
    },
    async scroll() {
      return { ok: true, proven: false };
    },
    async back() {
      return { ok: true, proven: false };
    },
    async dialog() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, calls };
}

const block = (markdown: string) => parsePlan(markdown).blocks![0];

test('a selection change alone changes the screen signature', () => {
  assert.notEqual(screenSignature(chips(undefined)), screenSignature(chips('Male')));
  assert.equal(screenSignature(chips('Male')), screenSignature(chips('Male')));
});

test('a press whose only effect is selecting the chip passes on its first attempt', async () => {
  const f = fake([chips(undefined), chips('Male')]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

test('a press on an already selected control passes with the evidence already selected, no change (single-choice or an untoggled multi-select alike)', async () => {
  const f = fake([chips('Male')]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
  assert.equal(
    renderReason(outcome.rows[0].reason ?? '', (text) => text),
    'already selected, no change',
  );
});

test('a selected control found under a different ref after the tap is not the same control and does not pass on that attempt', async () => {
  const f = fake([chips('Male'), chips('Male', '@new-')]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.equal(outcome.rows[0].outcome, 'retry');
});

test('a press that deselects the chip passes on its first attempt', async () => {
  const f = fake([chips('Male'), chips(undefined)]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

test('a not-ok press on an already selected chip still fails with its selection before and after', async () => {
  const f = fake(
    [chips('Male')],
    [
      { ok: false, proven: false },
      { ok: false, proven: false },
    ],
  );
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the target stayed selected/,
  );
});

test('a press with a runner error on an already selected chip still fails with its selection before and after', async () => {
  const error = 'RUNNER_TIMEOUT: the tap was not confirmed';
  const f = fake(
    [chips('Male')],
    [
      { ok: true, proven: false, error },
      { ok: true, proven: false, error },
    ],
  );
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the target stayed selected/,
  );
});

test('a press on a control never reported selected fails with the reason it had before', async () => {
  const f = fake([chips(undefined)]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.doesNotMatch(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /selected/,
  );
});

function rowChips(selected = false, outside = false): Screen {
  return {
    ...join(
      [
        {
          index: 0,
          ref: '@app',
          type: 'Application',
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          index: 1,
          parentIndex: 0,
          ref: '@list',
          type: 'ScrollView',
          rect: { x: 0, y: 200, width: 400, height: 100 },
        },
        {
          index: 2,
          parentIndex: 1,
          ref: '@chip',
          type: 'Button',
          identifier: 'chip',
          label: 'Choice',
          hittable: true,
          rect: { x: 20, y: 220, width: 100, height: 44 },
          ...(selected ? { selected: true } : {}),
        },
        {
          index: 3,
          parentIndex: 1,
          ref: '@peer',
          type: 'Button',
          label: 'Peer',
          hittable: true,
          rect: { x: 140, y: 220, width: 100, height: 44 },
        },
        {
          index: 4,
          parentIndex: 0,
          ref: '@outside',
          type: 'StaticText',
          label: outside ? 'CANARY_OUTSIDE_AFTER' : 'CANARY_OUTSIDE_BEFORE',
          rect: { x: 20, y: 400, width: 200, height: 44 },
        },
      ],
      [],
    ),
    coverage: { native: 'complete', react: 'complete' },
  };
}
const rowTap = block('1. Tap "chip"\n');
const rowFake = (screens: Screen[], results: ActResult[] = []) => {
  const f = fake(screens, results);
  f.deps.platform = 'ios';
  return f;
};
const presses = (f: ReturnType<typeof fake>) =>
  f.calls.filter((call) => call.startsWith('press')).length;

test('row buttons refuse outside semantic changes after one tap and one read-only recapture', async () => {
  const f = rowFake([rowChips(), rowChips(false, true)]);
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.deepEqual(outcome.pressEvidence, {
    subreason: 'selection_unverified',
    heldPress: 'not_tried_unsafe',
    outsideTargetChange: true,
    captures: 2,
  });
  assert.equal(presses(f), 1);
  assert.equal(f.calls.filter((call) => call === 'capture').length, 3);
  assert.equal(outcome.failure?.kind, undefined);
  assert.doesNotMatch(JSON.stringify(outcome), /CANARY_OUTSIDE/);
});

test('selection refusal gives the exact recovery guidance with observed count and duration', async () => {
  const f = rowFake([rowChips()]);
  let clock = 0;
  f.deps.now = () => clock;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (...args) => {
    clock += 25;
    return capture(...args);
  };
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.ok(
    outcome.refusal.message.endsWith(
      "The tap did not change the control's selected state (2 observations over 50 ms); the control sits in a row-shaped scrolling list, which can swallow synthetic taps. Next: re-run once; if it repeats on the same control, ask the app team to make the selection reachable for automated taps (for example by disabling the list's own scrolling for this set) or to expose the selected state another way.",
    ),
  );
  assert.equal(presses(f), 1);
});

for (const delayed of [false, true]) {
  test(`bound selection passes with ${delayed ? 'delayed' : 'immediate'} readback and one tap`, async () => {
    const f = rowFake([rowChips(), ...(delayed ? [rowChips()] : []), rowChips(true)]);
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.equal(presses(f), 1);
    assert.equal(f.calls.filter((call) => call === 'capture').length, delayed ? 3 : 2);
  });
}

test('the authoritative-effect contract seam accepts proof when its target disappears', async () => {
  const f = rowFake([rowChips(), chips(undefined)], [{ ok: true, proven: true }]);
  assert.equal((await walkBlock(rowTap, f.deps)).block.outcome, 'pass');
  assert.equal(presses(f), 1);
});

for (const change of ['missing', 'reused-ref']) {
  test(`${change} exits selection proof when the target identity is gone`, async () => {
    const after = rowChips(false, true);
    const target = after.elements.find((e) => e.ref === '@chip')!;
    if (change === 'missing') after.elements = after.elements.filter((e) => e !== target);
    if (change === 'reused-ref') target.testID = 'replacement';
    const f = rowFake([rowChips(), after]);
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.equal(outcome.pressEvidence, undefined);
    assert.equal(presses(f), 1);
    assert.equal(f.calls.filter((call) => call === 'capture').length, 2);
  });
}

for (const effect of ['navigation', 'validation']) {
  test(`a Save button in a vertical form passes on ${effect} with one tap`, async () => {
    const form = (outside = false) => {
      const screen = rowChips(false, outside);
      const container = screen.elements.find((e) => e.ref === '@list')!;
      elementFrame(container)!.height = 600;
      const save = screen.elements.find((e) => e.ref === '@chip')!;
      save.label = 'Save';
      const cancel = screen.elements.find((e) => e.ref === '@peer')!;
      cancel.label = 'Cancel';
      return screen;
    };
    const before = form();
    assert.equal(
      selectionPressCandidate(before.elements.find((e) => e.ref === '@chip')!, before),
      false,
    );
    const f = rowFake([before, effect === 'navigation' ? chips(undefined) : form(true)]);
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.equal(outcome.pressEvidence, undefined);
    assert.equal(presses(f), 1);
    assert.equal(f.calls.filter((call) => call === 'capture').length, 2);
  });
}

for (const change of ['new-ref', 'ambiguous']) {
  test(`${change} cannot stand in for the bound target`, async () => {
    const after = rowChips(true, true);
    const target = after.elements.find((e) => e.ref === '@chip')!;
    if (change === 'new-ref') target.ref = '@new';
    if (change === 'ambiguous') after.elements.push({ ...target, ref: '@duplicate' });
    const f = rowFake([rowChips(), after]);
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
    assert.equal(outcome.pressEvidence?.subreason, 'target_identity_unavailable');
    assert.equal(presses(f), 1);
  });
}

test('style-only selection stays on after an honest refusal, including saved-block replay', async () => {
  for (const mode of ['walk', 'replay'] as const) {
    const f = rowFake([rowChips()]);
    let selected = false;
    f.deps.press = async () => {
      selected = !selected;
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(rowTap, f.deps, 0, [], undefined, undefined, { mode });
    assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
    assert.equal(selected, true);
  }
});

test('a selected row target retains the dependency behavior', async () => {
  for (const [after, reason] of [
    [rowChips(true), 'already selected, no change'],
    [rowChips(true, true), undefined],
    [rowChips(), undefined],
  ] as const) {
    const f = rowFake([rowChips(true), after]);
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.equal(outcome.rows[0].reason, reason);
    assert.equal(presses(f), 1);
  }
});

test('candidate classification requires a visible enabled horizontal peer and finite frames', () => {
  for (const missing of [
    'peer-disabled',
    'peer-hidden',
    'peer-offscreen',
    'vertical',
    'overlap',
    'bad-frame',
    'tall-container',
    'bad-container-frame',
    'selected',
    'react',
  ]) {
    const screen = rowChips();
    const target = screen.elements.find((e) => e.ref === '@chip')!;
    const peer = screen.elements.find((e) => e.ref === '@peer')!;
    assert.equal(selectionPressCandidate(target, screen), true);
    if (missing === 'peer-disabled') peer.disabled = true;
    if (missing === 'peer-hidden') peer.hittable = false;
    if (missing === 'peer-offscreen') peer.offscreen = true;
    if (missing === 'vertical') elementFrame(peer)!.y += 100;
    if (missing === 'overlap') elementFrame(peer)!.x = 30;
    if (missing === 'bad-frame') elementFrame(target)!.width = NaN;
    if (missing === 'tall-container')
      elementFrame(screen.elements.find((e) => e.ref === '@list')!)!.height = 133;
    if (missing === 'bad-container-frame')
      elementFrame(screen.elements.find((e) => e.ref === '@list')!)!.height = NaN;
    if (missing === 'selected') target.selected = true;
    if (missing === 'react') target.ref = 'react:chip';
    assert.equal(selectionPressCandidate(target, screen), false, missing);
  }
});

test('a scroll container exactly three target heights tall is a candidate', () => {
  const screen = rowChips();
  const target = screen.elements.find((e) => e.ref === '@chip')!;
  const container = screen.elements.find((e) => e.ref === '@list')!;
  elementFrame(container)!.height = 3 * elementFrame(target)!.height;
  assert.equal(selectionPressCandidate(target, screen), true);
});

test('non-iOS row buttons retain the screen change contract', async () => {
  const f = rowFake([rowChips(), rowChips(false, true)]);
  f.deps.platform = 'android';
  assert.equal((await walkBlock(rowTap, f.deps)).block.outcome, 'pass');
});

for (const code of ['NATIVE_CAPTURE_UNAVAILABLE', 'RUN_CANCELLED']) {
  test(`the extra read preserves ${code} and never repeats the tap`, async () => {
    const f = rowFake([rowChips()]);
    const capture = f.deps.captureScreen;
    let count = 0;
    f.deps.captureScreen = async (...args) => {
      if (++count === 3)
        throw code === 'NATIVE_CAPTURE_UNAVAILABLE'
          ? new NativeCaptureError()
          : new QaDispatchError(code);
      return capture(...args);
    };
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.refusal?.code, code);
    assert.equal(outcome.pressEvidence?.captures, 2);
    assert.equal(presses(f), 1);
  });
}

test('signal cancellation during the extra read retains only closed evidence for the exit owner', async () => {
  const controller = new AbortController();
  const f = rowFake([rowChips()]);
  let evidence: unknown;
  f.deps.pressReadback = (value) => {
    evidence = value;
  };
  let count = 0;
  f.deps.captureScreen = async () => {
    if (++count === 3) {
      controller.abort(new RunCancelledError());
      controller.signal.throwIfAborted();
    }
    return rowChips();
  };
  await assert.rejects(
    withCancellation(controller.signal, () => walkBlock(rowTap, f.deps)),
    { name: 'AbortError' },
  );
  assert.deepEqual(evidence, {
    subreason: 'selection_unverified',
    heldPress: 'not_tried_unsafe',
    outsideTargetChange: false,
    captures: 2,
  });
  assert.equal(presses(f), 1);
});

for (const during of ['first-readback', 'recapture'] as const) {
  test(`the pre-tap lifetime expires during ${during} without renewal or another tap`, async () => {
    const f = rowFake([rowChips()]);
    let clock = 0;
    let count = 0;
    f.deps.now = () => clock;
    f.deps.captureScreen = async () => {
      count++;
      clock =
        during === 'first-readback'
          ? count === 2
            ? 10_001
            : 0
          : count === 2
            ? 9_000
            : count === 3
              ? 10_001
              : 0;
      return rowChips(during === 'first-readback' ? count === 2 : count === 3);
    };
    const outcome = await walkBlock(rowTap, f.deps);
    assert.equal(outcome.refusal?.code, 'ITEM_DEADLINE_EXCEEDED');
    assert.equal(outcome.pressEvidence?.captures, during === 'first-readback' ? 1 : 2);
    assert.equal(presses(f), 1);
    assert.equal(count, during === 'first-readback' ? 2 : 3);
  });
}

test('the terminal refusal keeps closed evidence through finalization and wire serialization', async () => {
  const f = rowFake([rowChips(), rowChips(false, true)]);
  const ledger = await runPlan([rowTap], f.deps);
  assert.equal(ledger.verdict, 'REFUSED');
  assert.equal(ledger.recipe, undefined);
  assert.equal(ledger.failure?.kind, undefined);
  assert.equal(ledger.pressEvidence?.outsideTargetChange, true);
  const payload = resultForWalk(ledger, 'synthetic-lease');
  assert.equal(exitCodeFor(payload), 4);
  const lines: string[] = [];
  assert.equal(createWriter((line) => lines.push(line), 'synthetic-run').result(payload), 4);
  const result = JSON.parse(lines[0]).payload;
  assert.equal(result.code, 'PRESS_NOT_REGISTERED');
  assert.deepEqual(result.pressEvidence, ledger.pressEvidence);
  assert.doesNotMatch(lines[0], /CANARY_OUTSIDE/);
  assert.equal(presses(f), 1);
});

test('a stalled recapture is interrupted by the pinned deadline timer', async () => {
  const f = rowFake([rowChips()]);
  let clock = 0;
  let count = 0;
  f.deps.now = () => clock;
  f.deps.captureScreen = async () => {
    if (++count === 2) clock = 9_980;
    if (count === 3) return new Promise<Screen>(() => {});
    return rowChips();
  };
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.refusal?.code, 'ITEM_DEADLINE_EXCEEDED');
  assert.equal(outcome.pressEvidence?.captures, 2);
  assert.equal(presses(f), 1);
});

test('a stalled first readback is interrupted by the pinned deadline timer', async () => {
  const f = rowFake([rowChips()]);
  let clock = 0;
  let count = 0;
  f.deps.now = () => clock;
  const press = f.deps.press;
  f.deps.press = async (...args) => {
    const result = await press(...args);
    clock = 9_980;
    return result;
  };
  f.deps.captureScreen = async () => {
    if (++count === 2) return new Promise<Screen>(() => {});
    return rowChips();
  };
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.refusal?.code, 'ITEM_DEADLINE_EXCEEDED');
  assert.equal(outcome.pressEvidence?.captures, 1);
  assert.equal(presses(f), 1);
  assert.equal(count, 2);
});

test('an uncertain failed tap cannot pass on an outside change or be retried', async () => {
  const f = rowFake(
    [rowChips(), rowChips(false, true)],
    [{ ok: false, proven: false, mutation: 'possible', error: 'RUNNER_TIMEOUT' }],
  );
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.equal(outcome.pressEvidence?.captures, 2);
  assert.equal(outcome.pressEvidence?.outsideTargetChange, true);
  assert.equal(presses(f), 1);
});

test('a first-readback capture fault keeps its code and closed one-capture evidence', async () => {
  const f = rowFake([rowChips()]);
  let count = 0;
  f.deps.captureScreen = async () => {
    if (++count === 2) throw new NativeCaptureError();
    return rowChips();
  };
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.refusal?.code, 'NATIVE_CAPTURE_UNAVAILABLE');
  assert.deepEqual(outcome.pressEvidence, {
    subreason: 'target_identity_unavailable',
    heldPress: 'not_tried_unsafe',
    outsideTargetChange: false,
    captures: 1,
  });
  assert.equal(presses(f), 1);
  assert.equal(count, 2);
});

test('proven no-mutation refusals retain their existing outcome without selection evidence', async () => {
  const f = rowFake(
    [rowChips()],
    Array.from({ length: 2 }, () => ({
      ok: false,
      proven: false,
      mutation: 'none' as const,
      error: 'OWNERSHIP_UNPROVEN',
    })),
  );
  const outcome = await walkBlock(rowTap, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.pressEvidence, undefined);
  assert.match(
    renderReason(outcome.failure!.seen, (text) => text),
    /OWNERSHIP_UNPROVEN/,
  );
});

test('a first-readback system dialog never enters recovery or repeats the candidate tap', async () => {
  const initial = rowChips();
  for (const element of initial.elements)
    element.semantic = {
      press: element.kind === 'button' ? 'supported' : 'unsupported',
      fill: 'unsupported',
      visibility: element.hittable ? 'visible' : 'hidden',
    };
  const dialog: Screen = { ...rowChips(), front: 'dialog' };
  const f = rowFake([initial, dialog]);
  f.deps.judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  let recoveries = 0;
  f.deps.dialog = async () => {
    recoveries++;
    return { ok: true, proven: true };
  };
  const outcome = await walkBlock(block('1. Tap the choice chip\n'), f.deps);
  assert.equal(outcome.refusal?.code, 'SYSTEM_DIALOG_INTERRUPTED', JSON.stringify(outcome));
  assert.equal(outcome.pressEvidence?.captures, 1);
  assert.equal(presses(f), 1);
  assert.equal(recoveries, 0);
});

test('a later selection refusal retains earlier private fill accounting', async () => {
  const screen = rowChips();
  screen.elements.push({
    ref: '@input',
    kind: 'input',
    nativeKind: 'input',
    testID: 'input',
    label: 'Input',
    hittable: true,
    disabled: false,
    secure: true,
    offscreen: false,
  });
  const f = rowFake([screen]);
  const outcome = await walkBlock(
    block('1. Fill "input" with "SYNTHETIC_CANARY"\n2. Tap "chip"\n'),
    f.deps,
  );
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.deepEqual(outcome.privateFills, [1]);
  assert.doesNotMatch(JSON.stringify(outcome.failure), /SYNTHETIC_CANARY/);
});
