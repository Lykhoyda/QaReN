// A runner occlusion refusal at dispatch scrolls once and retries the same identity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import type { WalkSequence } from '../../../dist/qa/walker.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { choice, element, scriptedJudge } from './judgment-fixtures.ts';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { checkQaNativeOutcome } from '../../../dist/runners/qa-native-policy.js';
import type { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { centreCovered, type CentreCoverageDiagnostic } from '../../../dist/qa/resolve.js';
import type { WalkerTimingDiagnostic } from '../../../dist/qa/walker.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { ANDROID_LIST, IOS_LIST, androidOptionSheet, iosOptionSheet } from './sheet-fixtures.ts';

const OCCLUDED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error: 'FOCUS_TARGET_OCCLUDED: the focus or tap point is covered by another element',
};

for (const kind of ['press', 'fill'] as const) {
  test(`a native moved-target refusal never succeeds or clears by scrolling (${kind})`, async () => {
    const type = kind === 'press' ? 'Button' : 'TextField';
    const moved: ActResult = {
      ok: false,
      proven: false,
      mutation: 'none',
      error:
        'TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch; no tap or typing was performed',
    };
    const f = fake([at(400, type)], { [kind]: [moved, moved] });
    const outcome = await walkBlock(
      block(kind === 'press' ? '1. Tap "go"\n' : '1. Fill "field" with "x"\n'),
      f.deps,
    );
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /TARGET_MOVED_BEFORE_DISPATCH/,
    );
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 0);
  });
}

for (const kind of ['press', 'fill', 'back', 'dialog', 'scroll'] as const) {
  test(`a proven no-mutation ${kind} refusal cannot pass on lower-to-middle readback movement`, async () => {
    const moved: ActResult = {
      ok: false,
      proven: false,
      mutation: 'none',
      error: 'TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch',
      ...(kind === 'fill' ? { evidence: 'unavailable' as const } : {}),
    };
    const type = kind === 'fill' ? 'TextField' : 'Button';
    const f = fake([at(700, type), at(400, type)], { [kind]: [moved, moved] });
    if (kind === 'back' || kind === 'dialog' || kind === 'scroll') f.deps[kind] = async () => moved;
    const steps = {
      press: '1. Tap "go"\n',
      fill: '1. Fill "field" with "x"\n',
      back: '1. Back\n',
      dialog: '1. Accept dialog\n',
      scroll: '1. Scroll down\n',
    };
    const outcome = await walkBlock(block(steps[kind]), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /TARGET_MOVED_BEFORE_DISPATCH/,
    );
    assert.equal(
      outcome.rows.some((row) => row.outcome === 'pass'),
      false,
    );
  });
}

const root = (): NativeNode[] => [
  { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
  {
    ref: '@win',
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
];

const covered = (screen: Screen): Screen => ({
  ...screen,
  coverage: { native: 'complete', react: 'complete' },
});

function at(y: number, type = 'Button', extra: NativeNode[] = []): Screen {
  const id = type === 'Button' ? 'go' : 'field';
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@target',
          index: 2,
          parentIndex: 1,
          type,
          identifier: id,
          label: type === 'Button' ? 'Go' : undefined,
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        ...extra,
      ],
      [],
    ),
  );
}

const done = (): Screen =>
  covered(
    join(
      [
        ...root(),
        {
          ref: '@done',
          index: 2,
          parentIndex: 1,
          type: 'StaticText',
          label: 'Done',
          hittable: true,
          rect: { x: 20, y: 100, width: 300, height: 44 },
        },
      ],
      [],
    ),
  );

function fake(screens: Screen[], results: { press?: ActResult[]; fill?: ActResult[] }) {
  const calls: string[] = [];
  const queue = [...screens];
  const press = [...(results.press ?? [])];
  const fill = [...(results.fill ?? [])];
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
    async fill(ref) {
      calls.push(`fill ${ref}`);
      return fill.shift() ?? { ok: true, proven: true };
    },
    async scroll(direction) {
      calls.push(`scroll ${direction}`);
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

function block(markdown: string) {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

const targetOf = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref);

function explicitKeyboard(
  sameWindow = false,
  edit: (nodes: NativeNode[]) => NativeNode[] = (nodes) => nodes,
): Screen {
  return covered(
    join(
      edit([
        {
          ref: '@app',
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
        {
          ref: '@win',
          index: 1,
          parentIndex: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
        {
          ref: '@submit',
          index: 2,
          parentIndex: 1,
          type: 'Button',
          identifier: 'login_submit',
          label: 'Sign in',
          hittable: true,
          rect: { x: 21, y: 565, width: 360, height: 38 },
        },
        {
          ref: '@kw',
          index: 3,
          parentIndex: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
        {
          ref: '@keyboard',
          index: 4,
          parentIndex: sameWindow ? 1 : 3,
          type: 'Keyboard',
          rect: { x: 0, y: 583, width: 402, height: 233 },
        },
        {
          ref: '@return',
          index: 5,
          parentIndex: 4,
          type: 'Key',
          label: 'Return',
          hittable: true,
          rect: { x: 310, y: 755, width: 80, height: 50 },
        },
      ]),
      [],
    ),
  );
}

for (const sameWindow of [false, true]) {
  test(`an explicit keyboard key presses without clearance scroll (${sameWindow ? 'ancestry' : 'separate window'})`, async () => {
    const f = fake([explicitKeyboard(sameWindow), done()], {});
    const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      ['press @return'],
    );
    assert.equal(outcome.block.outcome, 'pass');
  });
}

for (const sameWindow of [false, true]) {
  test(`a Button-typed keyboard key presses without clearance scroll (${sameWindow ? 'ancestry' : 'separate window'})`, async () => {
    const screen = explicitKeyboard(sameWindow, (nodes) =>
      nodes.map((node) => (node.ref === '@return' ? { ...node, type: 'Button' } : node)),
    );
    const f = fake([screen, done()], {});
    const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      ['press @return'],
    );
    assert.equal(outcome.block.outcome, 'pass');
  });
}

test('O1: an occluded press scrolls once toward clearance and presses the same identity', async () => {
  const screens = [at(700), at(400), at(400), done()];
  const f = fake(screens, { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'press @target',
    'scroll down',
    'capture',
    'capture',
    'press @target',
    'capture',
  ]);
  assert.equal(targetOf(screens[0], '@target')?.testID, 'go');
  assert.equal(targetOf(screens[1], '@target')?.testID, 'go');
});

test('O1: a target in the upper half scrolls up', async () => {
  const f = fake([at(80), at(300), at(300), done()], { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.ok(f.calls.includes('scroll up'));
});

test('O2: occluded twice fails after one scroll, never as an uncertain outcome', async () => {
  const f = fake([at(700), at(650)], { press: [OCCLUDED, OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 1);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /^FOCUS_TARGET_OCCLUDED: .*"go" stayed off screen after one scroll/,
  );
  assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
});

test('O3: an occluded exact fill scrolls once, then fills verified', async () => {
  const f = fake([at(700, 'TextField'), at(300, 'TextField'), at(300, 'TextField')], {
    fill: [OCCLUDED],
  });
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 6), [
    'capture',
    'fill @target',
    'scroll down',
    'capture',
    'capture',
    'fill @target',
  ]);
});

test('O4: a later transparent full-screen container never makes a hittable target scroll', async () => {
  const overlay: NativeNode = {
    ref: '@overlay',
    index: 3,
    parentIndex: 1,
    type: 'Other',
    hittable: true,
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
  const f = fake([at(700, 'Button', [overlay]), done()], {});
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, ['capture', 'press @target', 'capture']);
});

test('O5: a refusal other than occlusion keeps its existing path', async () => {
  const other: ActResult = { ...OCCLUDED, error: 'STALE_REF: gone' };
  const f = fake([at(700)], { press: [other, other] });
  await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 0);
});

for (const kind of ['press', 'fill'] as const) {
  test(`occlusion never switches a ${kind} to a same-label twin`, async () => {
    const first = at(700, kind === 'press' ? 'Button' : 'TextField');
    targetOf(first, '@target')!.label = 'Save';
    const twin = at(300, kind === 'press' ? 'Button' : 'TextField');
    targetOf(twin, '@target')!.testID = 'twin';
    targetOf(twin, '@target')!.label = 'Save';
    const f = fake([first, twin], { [kind === 'press' ? 'press' : 'fill']: [OCCLUDED] });
    const outcome = await walkBlock(
      block(kind === 'press' ? '1. Tap "Save"\n' : '1. Fill "Save" with "x"\n'),
      f.deps,
    );
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(f.calls.filter((call) => call.startsWith(kind)).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /TARGET_NOT_FOUND/,
    );
  });
}

function wrapperAt(y: number, keyboardVisible: boolean): Screen {
  const screen = at(y, 'Button');
  targetOf(screen, '@target')!.testID = 'email-pressable';
  screen.keyboardVisible = keyboardVisible;
  screen.coverage = { native: 'complete', react: 'incomplete' };
  return screen;
}

for (const secondOcclusion of [false, true]) {
  test(`keyboard fallback clears occlusion once (${secondOcclusion ? 'refused' : 'typed'})`, async () => {
    const f = fake(
      [wrapperAt(700, false), wrapperAt(300, false), wrapperAt(300, false), wrapperAt(300, true)],
      {
        press: secondOcclusion ? [OCCLUDED, OCCLUDED] : [OCCLUDED],
      },
    );
    let typed = 0;
    f.deps.typeFocused = async () => {
      typed += 1;
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
    assert.equal(outcome.block.outcome, secondOcclusion ? 'fail' : 'pass');
    assert.equal(typed, secondOcclusion ? 0 : 1);
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 2);
    if (secondOcclusion)
      assert.match(
        renderReason(outcome.failure?.seen ?? '', (text) => text),
        /stayed off screen after one scroll.*nothing was typed/,
      );
  });
}

test('keyboard fallback never taps a replacement wrapper after clearance', async () => {
  const twin = wrapperAt(300, false);
  targetOf(twin, '@target')!.testID = 'other-pressable';
  const f = fake([wrapperAt(700, false), twin], { press: [OCCLUDED] });
  let typed = 0;
  f.deps.typeFocused = async () => {
    typed += 1;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(typed, 0);
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

function keyboardWrapperAt(y: number): Screen {
  const screen = clipped(y, 'Button', 'keyboard');
  targetOf(screen, '@target')!.testID = 'email-pressable';
  screen.keyboardVisible = true;
  screen.coverage = { native: 'complete', react: 'incomplete' };
  return screen;
}

for (const [name, screens, calls, clearances, typed] of [
  [
    'clears with one overlap-sized scroll before its tap',
    [700, 300],
    ['scroll down', 'press @target'],
    [496],
    1,
  ],
  ['is tapped without a scroll when uncovered', [300], ['press @target'], [], 1],
  [
    'refuses without a tap when still covered after one scroll',
    [700, 650],
    ['scroll down'],
    [496],
    0,
  ],
] as const) {
  test(`a keyboard-covered fallback wrapper ${name}`, async () => {
    const f = fake(screens.map(keyboardWrapperAt), {});
    const seen: (number | undefined)[] = [];
    const scroll = f.deps.scroll;
    f.deps.scroll = (direction, context, clearance) => {
      seen.push(clearance);
      return scroll(direction, context, clearance);
    };
    f.deps.reactFocused = async () => true;
    let count = 0;
    f.deps.typeFocused = async () => {
      count += 1;
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
    assert.equal(outcome.block.outcome, typed ? 'pass' : 'fail');
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      calls,
    );
    assert.deepEqual(seen, clearances);
    assert.equal(count, typed);
    assert.deepEqual(outcome.privateFills, [1]);
    if (!typed)
      assert.match(
        renderReason(outcome.failure?.seen ?? '', (text) => text),
        /stayed off screen after one scroll.*nothing was typed/,
      );
  });
}

test('a semantic target stays pinned after occlusion without another model choice', async () => {
  const first = at(700);
  const twin = at(300);
  targetOf(twin, '@target')!.testID = 'twin';
  first.elements = [targetOf(first, '@target')!];
  twin.elements = [targetOf(twin, '@target')!];
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, choice(question)])),
  );
  const f = fake([first, twin], { press: [OCCLUDED] });
  f.deps.judge = judge;
  const outcome = await walkBlock(block('1. Tap the go button\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(judge.requests.length, 1);
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

test('duplicate refused testIDs cannot rebind after clearance', async () => {
  const duplicate = at(300, 'Button', [
    {
      ref: '@duplicate',
      index: 3,
      parentIndex: 1,
      type: 'Button',
      identifier: 'go',
      label: 'Go',
      hittable: true,
      rect: { x: 20, y: 400, width: 300, height: 44 },
    },
  ]);
  const f = fake([at(700), duplicate], { press: [OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

for (const kind of ['press', 'fill'] as const) {
  for (const semantic of [false, true]) {
    for (const y of [80, 700]) {
      test(`an unidentified ${semantic ? 'semantic' : 'literal'} ${kind} never retries a same-label twin at its old frame (${y})`, async () => {
        const type = kind === 'press' ? 'Button' : 'TextField';
        const first = at(y, type);
        const original = targetOf(first, '@target')!;
        delete original.testID;
        original.label = 'Save';
        const after = at(300, type, [
          {
            ref: '@twin',
            index: 3,
            parentIndex: 1,
            type,
            label: 'Save',
            hittable: true,
            rect: { x: 20, y, width: 300, height: 44 },
          },
        ]);
        const moved = targetOf(after, '@target')!;
        delete moved.testID;
        moved.label = 'Save';
        if (semantic) {
          first.elements = [original];
          after.elements = [moved, targetOf(after, '@twin')!];
        }
        const f = fake([first, after], { [kind]: [OCCLUDED] });
        const judge = scriptedJudge((questions) =>
          Object.fromEntries(
            Object.entries(questions).map(([id, question]) => [id, choice(question)]),
          ),
        );
        if (semantic) f.deps.judge = judge;
        const target = semantic ? 'the save control' : '"Save"';
        const instruction =
          kind === 'press' ? `1. Tap ${target}\n` : `1. Fill ${target} with "x"\n`;
        const outcome = await walkBlock(block(instruction), f.deps);
        assert.equal(outcome.block.outcome, 'fail');
        assert.deepEqual(f.calls, [
          'capture',
          `${kind} @target`,
          `scroll ${y < 400 ? 'up' : 'down'}`,
          'capture',
          'capture',
        ]);
        assert.match(
          renderReason(outcome.failure?.seen ?? '', (text) => text),
          /stayed off screen after one scroll/,
        );
        assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
        if (semantic) assert.equal(judge.requests.length, 1);
      });
    }
  }
}

function clipped(y: number, type = 'Button', occluder: 'tabs' | 'keyboard' = 'tabs'): Screen {
  const id = type === 'Button' ? 'go' : 'field';
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@scroll',
          index: 2,
          parentIndex: 1,
          type: 'ScrollView',
          rect: { x: 0, y: 0, width: 400, height: occluder === 'tabs' ? 720 : 800 },
        },
        {
          ref: '@target',
          index: 3,
          parentIndex: 2,
          type,
          identifier: id,
          label: type === 'Button' ? 'Go' : undefined,
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        ...(occluder === 'keyboard'
          ? [
              {
                ref: '@keyboard',
                index: 4,
                parentIndex: 1,
                type: 'Keyboard',
                hittable: true,
                rect: { x: 0, y: 500, width: 400, height: 300 },
              },
            ]
          : []),
      ],
      [],
    ),
  );
}

test('centre predicate diagnostics preserve short-circuit reads and explicit unknowns', () => {
  const inspect = (screen: Screen, ref = '@target') => {
    let facts: CentreCoverageDiagnostic | undefined;
    const target = screen.elements.find((e) => e.ref === ref)!;
    Object.defineProperty(target, 'label', {
      get() {
        assert.fail('no app-value read');
      },
    });
    const result = centreCovered(target, screen, (value) => {
      facts = value;
    });
    return { result, facts };
  };
  const viewport = clipped(710);
  for (const key of ['keyboardVisible', 'keyboardFrame'])
    Object.defineProperty(viewport, key, {
      get() {
        assert.fail('viewport short-circuits keyboard');
      },
    });
  assert.deepEqual(inspect(viewport), {
    result: true,
    facts: {
      framePresent: true,
      viewportPresent: true,
      viewportOutside: true,
      keyboardVisible: null,
      keyboardFramePresent: null,
      keyboardCoverage: null,
      centreInsideKeyboard: null,
      branch: 'viewport',
    },
  });
  const hidden = clipped(710, 'TextField', 'keyboard');
  hidden.keyboardVisible = false;
  Object.defineProperty(hidden, 'keyboardFrame', {
    get() {
      assert.fail('hidden short-circuits frame');
    },
  });
  assert.deepEqual(inspect(hidden), {
    result: false,
    facts: {
      framePresent: true,
      viewportPresent: true,
      viewportOutside: false,
      keyboardVisible: false,
      keyboardFramePresent: null,
      keyboardCoverage: null,
      centreInsideKeyboard: null,
      branch: 'none',
    },
  });
  const unknown = clipped(710, 'TextField', 'keyboard');
  unknown.keyboardVisible = undefined;
  const keyboardFrame = unknown.keyboardFrame;
  let keyboardReads = 0;
  Object.defineProperty(unknown, 'keyboardFrame', {
    get() {
      keyboardReads++;
      return keyboardFrame;
    },
  });
  assert.deepEqual(inspect(unknown), {
    result: true,
    facts: {
      framePresent: true,
      viewportPresent: true,
      viewportOutside: false,
      keyboardVisible: null,
      keyboardFramePresent: true,
      keyboardCoverage: true,
      centreInsideKeyboard: true,
      branch: 'keyboard',
    },
  });
  assert.equal(keyboardReads, 2);
  const visible = clipped(710, 'TextField', 'keyboard');
  visible.keyboardVisible = true;
  assert.equal(inspect(visible).facts?.keyboardVisible, true);
  const owned = inspect(explicitKeyboard(), '@return');
  assert.equal(owned.result, false);
  assert.equal(owned.facts?.keyboardCoverage, false);
  assert.equal(owned.facts?.centreInsideKeyboard, null);
  assert.equal(owned.facts?.branch, 'none');
  const clippedKey = inspect(
    explicitKeyboard(false, (nodes) =>
      nodes.map((node) =>
        node.ref === '@kw' ? { ...node, rect: { x: 0, y: 0, width: 402, height: 760 } } : node,
      ),
    ),
    '@return',
  );
  assert.equal(clippedKey.result, true);
  assert.equal(clippedKey.facts?.branch, 'viewport');
  assert.equal(clippedKey.facts?.keyboardCoverage, null);
  const missing = covered(
    join(
      [{ ref: '@target', index: 0, type: 'Button', rect: { x: 10, y: 10, width: 40, height: 40 } }],
      [],
    ),
  );
  assert.deepEqual(inspect(missing), {
    result: false,
    facts: {
      framePresent: true,
      viewportPresent: false,
      viewportOutside: null,
      keyboardVisible: null,
      keyboardFramePresent: false,
      keyboardCoverage: null,
      centreInsideKeyboard: null,
      branch: 'none',
    },
  });
  const noFrame = { elements: [element('@target', 'PRIVATE-label')], visibleText: [] };
  assert.deepEqual(inspect(noFrame), {
    result: false,
    facts: {
      framePresent: false,
      viewportPresent: null,
      viewportOutside: null,
      keyboardVisible: null,
      keyboardFramePresent: null,
      keyboardCoverage: null,
      centreInsideKeyboard: null,
      branch: 'none',
    },
  });
  const normal = clipped(710, 'TextField', 'keyboard');
  const target = normal.elements.find((e) => e.ref === '@target')!;
  assert.equal(
    centreCovered(target, normal, () => {
      throw Error('PRIVATE-observer');
    }),
    true,
  );
});

test('offscreen rows and keyboard clearance preserve refusal without exposing private diagnostics', async () => {
  for (const occluder of ['tabs', 'keyboard'] as const) {
    for (const sink of ['absent', 'record', 'throw'] as const) {
      const f = fake([clipped(700, 'Button', occluder), clipped(710, 'Button', occluder)], {});
      const events: WalkerTimingDiagnostic[] = [];
      let authorizations = 0;
      f.deps.scroll = async (direction, context) => {
        context.authorize();
        authorizations++;
        f.calls.push(`scroll ${direction}`);
        return { ok: true, proven: false };
      };
      if (sink !== 'absent')
        f.deps.diagnostic = (event) => {
          events.push(event);
          if (sink === 'throw') throw Error('PRIVATE-sink');
        };
      const result = await walkBlock(block('1. Tap "go"\n'), f.deps);
      assert.equal(result.block.outcome, 'fail');
      assert.match(
        renderReason(result.failure!.seen, (text) => text),
        /stayed off screen after one scroll/,
      );
      assert.deepEqual(f.calls, [
        'capture',
        'scroll down',
        'capture',
        'capture',
        ...(occluder === 'tabs' ? ['capture', 'capture'] : []),
      ]);
      assert.equal(authorizations, 1);
      const terminal = events.filter((event) => event.code === 'CENTRE_COVERED');
      if (sink !== 'absent' && occluder === 'tabs') assert.equal(terminal.length, 0);
      if (sink !== 'absent' && occluder === 'keyboard') {
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].stage, 'decision');
        assert.equal(terminal[0].observation, 3);
        assert.deepEqual(terminal[0].clearanceDiagnostic, {
          predicate: {
            framePresent: true,
            viewportPresent: true,
            viewportOutside: false,
            keyboardVisible: null,
            keyboardFramePresent: true,
            keyboardCoverage: true,
            centreInsideKeyboard: true,
            branch: 'keyboard',
          },
          scrollOrigin: 'centre-covered',
          requestedDirection: 'down',
          targetCentreChanged: true,
        });
      }
      assert.ok(!JSON.stringify(events).includes('PRIVATE-'));
      assert.ok(!JSON.stringify(result).includes('clearanceDiagnostic'));
      assert.ok(!JSON.stringify(result).includes('CENTRE_COVERED'));
      assert.ok(!JSON.stringify(events).includes('@target'));
    }
  }
});

test('terminal diagnostics preserve offscreen versus native-occlusion scroll origin and pinned movement', async () => {
  for (const origin of ['offscreen-resolution', 'native-occlusion'] as const) {
    const f = fake(
      origin === 'offscreen-resolution'
        ? [clipped(740), clipped(710, 'Button', 'keyboard')]
        : [clipped(80), clipped(710, 'Button', 'keyboard')],
      origin === 'native-occlusion' ? { press: [OCCLUDED] } : {},
    );
    const events: WalkerTimingDiagnostic[] = [];
    f.deps.diagnostic = (event) => events.push(event);
    const result = await walkBlock(block('1. Tap "go"\n'), f.deps);
    assert.equal(result.block.outcome, 'fail');
    const diagnostic = events.find((event) => event.code === 'CENTRE_COVERED')?.clearanceDiagnostic;
    assert.equal(diagnostic?.scrollOrigin, origin);
    assert.equal(diagnostic?.requestedDirection, origin === 'offscreen-resolution' ? 'down' : 'up');
    assert.equal(diagnostic?.targetCentreChanged, origin === 'offscreen-resolution' ? null : true);
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
    assert.equal(
      f.calls.filter((call) => call.startsWith('press')).length,
      origin === 'offscreen-resolution' ? 0 : 1,
    );
  }
});

test('O5: a press whose centre lies past its scroll clip scrolls before any dispatch', async () => {
  const f = fake([clipped(700), ...Array.from({ length: 4 }, () => clipped(400)), done()], {});
  const seen = recordingClearance(f);
  const events: WalkerTimingDiagnostic[] = [];
  f.deps.diagnostic = (event) => events.push(event);
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'capture',
    'capture',
    'press @target',
    'capture',
  ]);
  assert.equal(
    events.some((event) => event.code === 'CENTRE_COVERED'),
    false,
  );
  assert.deepEqual(seen, [
    { clearance: 722 - 360, within: { x: 0, y: 0, width: 400, height: 720 } },
  ]);
});

test('a press on a row whose centre lies above its scroll clip scrolls up and presses it', async () => {
  const f = fake([clipped(-30), ...Array.from({ length: 4 }, () => clipped(300)), done()], {});
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.equal(f.calls[1], 'scroll up');
  assert.ok(f.calls.includes('press @target'));
  assert.equal(
    f.calls.some((call) => call === 'scroll down'),
    false,
  );
});

test('O5: a fill whose centre lies under the keyboard scrolls before any dispatch', async () => {
  const kb = (y: number) => clipped(y, 'TextField', 'keyboard');
  const f = fake([kb(700), kb(300), kb(300)], {});
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 5), [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'fill @target',
  ]);
});

test('the iOS keyboard clearance scroll carries the overlap distance', async () => {
  const kb = (y: number) => clipped(y, 'TextField', 'keyboard');
  const f = fake([kb(700), kb(300), kb(300)], {});
  const clearances: (number | undefined)[] = [];
  const scroll = f.deps.scroll;
  f.deps.scroll = (direction, context, clearance) => {
    clearances.push(clearance);
    return scroll(direction, context, clearance);
  };
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(clearances, [496]);
});

test('O5: a target still covered after one scroll refuses with no dispatch', async () => {
  for (const [screen, step] of [
    [(y: number) => clipped(y), '1. Tap "go"\n'],
    [(y: number) => clipped(y, 'TextField', 'keyboard'), '1. Fill "field" with "x"\n'],
  ] as const) {
    const f = fake([screen(700), screen(710)], {});
    const outcome = await walkBlock(block(step), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(f.calls.filter((c) => /^(press|fill)/.test(c)).length, 0, f.calls.join());
    assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 1);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /stayed off screen after one scroll/,
    );
  }
});

test('O6: a keyboard-cleared fill waits for the scroll to stop before dispatching', async () => {
  const kb = (y: number) => clipped(y, 'TextField', 'keyboard');
  const f = fake([kb(700), kb(450), kb(400), kb(400)], {});
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 6), [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'capture',
    'fill @target',
  ]);
});

// A list stretched under the keyboard: its clip centre (550) lies below the keyboard top (500).
function stretched(y: number): Screen {
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@scroll',
          index: 2,
          parentIndex: 1,
          type: 'ScrollView',
          rect: { x: 0, y: 300, width: 400, height: 500 },
        },
        {
          ref: '@target',
          index: 3,
          parentIndex: 2,
          type: 'Button',
          identifier: 'go',
          label: 'Go',
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
        {
          ref: '@keyboard',
          index: 4,
          parentIndex: 1,
          type: 'Keyboard',
          hittable: true,
          rect: { x: 0, y: 500, width: 400, height: 300 },
        },
      ],
      [],
    ),
  );
}

function recordingScrolls(f: ReturnType<typeof fake>) {
  const bands: unknown[] = [];
  const scroll = f.deps.scroll;
  f.deps.scroll = (direction, context, clearance, within) => {
    bands.push(within);
    return scroll(direction, context, clearance, within);
  };
  return bands;
}

test('a keyboard-covered row of a list stretched under the keyboard is lifted inside its visible band', async () => {
  const f = fake([stretched(505), stretched(400), stretched(400), done()], {});
  const bands = recordingScrolls(f);
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'press @target',
    'capture',
  ]);
  assert.deepEqual(bands, [{ x: 0, y: 300, width: 400, height: 500 - 48 - 300 }]);
});

const listOnly = (): Screen =>
  covered(
    join(
      [
        ...root(),
        {
          ref: '@scroll',
          index: 2,
          parentIndex: 1,
          type: 'ScrollView',
          rect: { x: 0, y: 300, width: 400, height: 500 },
        },
      ],
      [],
    ),
  );

test('(g) scroll-until with its target absent drags inside the list', async () => {
  const f = fake([listOnly(), stretched(400)], {});
  const bands = recordingScrolls(f);
  const outcome = await walkBlock(block('1. Scroll down until "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down'],
  );
  assert.deepEqual(bands, [{ x: 0, y: 300, width: 400, height: 500 }]);
});

test('(h) scroll-until with a covered target drags inside its clip band', async () => {
  const f = fake([stretched(505), stretched(400)], {});
  const bands = recordingScrolls(f);
  const outcome = await walkBlock(block('1. Scroll down until "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(bands, [{ x: 0, y: 300, width: 400, height: 500 - 48 - 300 }]);
});

for (const layout of ['keyboard dismissal', 'header collapse'] as const) {
  test(`scroll-until accepts a revealed target after ${layout} resizes the same list`, async () => {
    const snapshot = (scrolled: boolean): Screen => {
      const keyboard = layout === 'keyboard dismissal' && !scrolled;
      const header = layout === 'header collapse' && !scrolled;
      return covered(
        join(
          [
            ...root(),
            {
              ref: '@scroll',
              index: 2,
              parentIndex: 1,
              type: 'ScrollView',
              identifier: 'policies-list',
              rect: {
                x: 0,
                y: header ? 200 : 100,
                width: 400,
                height: keyboard ? 400 : header ? 500 : 600,
              },
            },
            {
              ref: '@target',
              index: 3,
              parentIndex: 2,
              type: 'Button',
              identifier: 'go',
              label: 'Go',
              hittable: scrolled,
              rect: { x: 20, y: scrolled ? 300 : 740, width: 300, height: 44 },
            },
            ...(keyboard
              ? [
                  {
                    ref: '@keyboard',
                    index: 4,
                    parentIndex: 1,
                    type: 'Keyboard',
                    rect: { x: 0, y: 500, width: 400, height: 300 },
                  },
                ]
              : []),
            ...(layout === 'header collapse'
              ? [
                  {
                    ref: '@header',
                    index: 4,
                    parentIndex: 1,
                    type: 'StaticText',
                    label: 'Policies',
                    rect: { x: 0, y: 80, width: 400, height: header ? 120 : 20 },
                  },
                ]
              : []),
          ],
          [],
        ),
      );
    };
    const f = fake([snapshot(false), snapshot(true)], {});
    const outcome = await walkBlock(block('1. Scroll down until "go"\n'), f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
  });
}

// An Android keyboard form: a ScrollView list from 300 under the keyboard (1400) and a sticky Submit footer sibling 1150-1400.
function stickyForm(y: number): Screen {
  const rect = { x: 0, y: 0, width: 1080, height: 2400 };
  return covered(
    join(
      [
        { ref: '@app', index: 0, type: 'Application', rect },
        { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect },
        {
          ref: '@root',
          index: 2,
          parentIndex: 1,
          type: 'android.view.ViewGroup',
          hittable: true,
          rect,
        },
        {
          ref: '@scroll',
          index: 3,
          parentIndex: 2,
          type: 'android.widget.ScrollView',
          hittable: true,
          rect: { x: 0, y: 300, width: 1080, height: 2100 },
        },
        {
          ref: '@content',
          index: 4,
          parentIndex: 3,
          type: 'android.view.ViewGroup',
          hittable: true,
          rect: { x: 0, y: 300, width: 1080, height: 1700 },
        },
        {
          ref: '@target',
          index: 5,
          parentIndex: 4,
          type: 'android.widget.EditText',
          identifier: 'qa-kb-input-7',
          hittable: true,
          rect: { x: 40, y, width: 1000, height: 80 },
        },
        {
          ref: '@footer',
          index: 6,
          parentIndex: 2,
          type: 'android.view.ViewGroup',
          hittable: true,
          rect: { x: 0, y: 1150, width: 1080, height: 250 },
        },
        {
          ref: '@keyboard',
          index: 7,
          parentIndex: 1,
          type: 'Keyboard',
          hittable: true,
          rect: { x: 0, y: 1400, width: 1080, height: 1000 },
        },
      ],
      [],
    ),
  );
}

test('an Android field under the keyboard clears above a sticky footer in one scroll', async () => {
  const f = fake([stickyForm(1860), stickyForm(1012), stickyForm(1012)], {});
  const seen: unknown[] = [];
  const scroll = f.deps.scroll;
  f.deps.scroll = (direction, context, clearance, within) => {
    seen.push({ clearance, within });
    return scroll(direction, context, clearance, within);
  };
  const outcome = await walkBlock(block('1. Fill "qa-kb-input-7" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls.slice(0, 5), [
    'capture',
    'scroll down',
    'capture',
    'capture',
    'fill @target',
  ]);
  assert.deepEqual(seen, [{ clearance: 1175, within: { x: 0, y: 300, width: 1080, height: 850 } }]);
});

// An iOS keyboard form: a ScrollView list down to the keyboard top (538) and a sticky footer sibling 432-538.
function iosFooterForm(centre: number): Screen {
  const rect = { x: 0, y: 0, width: 402, height: 874 };
  return covered(
    join(
      [
        { ref: '@app', index: 0, type: 'Application', rect },
        { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect },
        { ref: '@root', index: 2, parentIndex: 1, type: 'Other', rect },
        {
          ref: '@scroll',
          index: 3,
          parentIndex: 2,
          type: 'ScrollView',
          rect: { x: 0, y: 0, width: 402, height: 538 },
        },
        {
          ref: '@content',
          index: 4,
          parentIndex: 3,
          type: 'Other',
          rect: { x: 0, y: 0, width: 402, height: 1400 },
        },
        {
          ref: '@target',
          index: 5,
          parentIndex: 4,
          type: 'TextField',
          identifier: 'qa-kb-input-8',
          hittable: true,
          rect: { x: 20, y: centre - 22, width: 362, height: 44 },
        },
        {
          ref: '@footer',
          index: 6,
          parentIndex: 2,
          type: 'Other',
          identifier: 'qa-kb-footer',
          hittable: true,
          rect: { x: 0, y: 432, width: 402, height: 106 },
        },
        { ref: '@kw', index: 7, parentIndex: 0, type: 'Window', rect },
        {
          ref: '@keyboard',
          index: 8,
          parentIndex: 7,
          type: 'Keyboard',
          rect: { x: 0, y: 538, width: 402, height: 336 },
        },
      ],
      [],
    ),
  );
}

test('an iOS field parked under a sticky footer clears with one banded scroll before the fill', async () => {
  const f = fake([iosFooterForm(480), iosFooterForm(216), iosFooterForm(216)], {});
  const seen: unknown[] = [];
  const scroll = f.deps.scroll;
  f.deps.scroll = (direction, context, clearance, within) => {
    seen.push({ direction, clearance, within });
    return scroll(direction, context, clearance, within);
  };
  const outcome = await walkBlock(block('1. Fill "qa-kb-input-8" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down', 'fill @target'],
  );
  assert.deepEqual(seen, [
    { direction: 'down', clearance: 264, within: { x: 0, y: 0, width: 402, height: 432 } },
  ]);
});

test('an iOS field inside the band above a sticky footer fills without a scroll', async () => {
  const f = fake([iosFooterForm(392)], {});
  const outcome = await walkBlock(block('1. Fill "qa-kb-input-8" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['fill @target'],
  );
});

function recordingClearance(f: ReturnType<typeof fake>) {
  const seen: unknown[] = [];
  const scroll = f.deps.scroll;
  f.deps.scroll = (direction, context, clearance, within) => {
    seen.push({ clearance, within });
    return scroll(direction, context, clearance, within);
  };
  return seen;
}

function presentTarget(screen: Screen, ref = '@target'): Screen {
  const target = screen.elements.find((element) => element.ref === ref);
  assert.ok(target?.semantic);
  target.semantic.visibility = 'visible';
  return screen;
}

// Option 17 parked after five full-list drags; option 20's collapsed frame sits at 1631, below the list.
test('(y) a press on a row scrolled out of the sheet list lifts it inside that list', async () => {
  const parked = covered(androidOptionSheet(2510));
  const reached = presentTarget(covered(androidOptionSheet(168 * 17)), '@option-20');
  const f = fake([parked, reached, reached, done()], {});
  const seen = recordingClearance(f);
  const outcome = await walkBlock(block('1. Tap "qa-sheet-capture-option-20"\n'), f.deps);
  assert.deepEqual(seen, [{ clearance: 1631 - 1201, within: ANDROID_LIST }]);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down', 'press @option-20'],
  );
});

test('(z) a row still out of the list after that one lift refuses without a press', async () => {
  const below = covered(androidOptionSheet(949 + 168 * 19 - 1621));
  const f = fake([below, below], {});
  const seen = recordingClearance(f);
  const outcome = await walkBlock(block('1. Tap "qa-sheet-capture-option-20"\n'), f.deps);
  assert.deepEqual(seen, [{ clearance: 1621 - 1201, within: ANDROID_LIST }]);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down'],
  );
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /stayed off screen after one scroll/,
  );
});

// A plain screen: the list's clip is the window, the target sits 300 px below the fold.
function belowFold(y: number): Screen {
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@scroll',
          index: 2,
          parentIndex: 1,
          type: 'ScrollView',
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          ref: '@target',
          index: 3,
          parentIndex: 2,
          type: 'Button',
          identifier: 'go',
          label: 'Go',
          hittable: true,
          rect: { x: 20, y, width: 300, height: 44 },
        },
      ],
      [],
    ),
  );
}

test('(ab) a target below the fold of a plain screen is lifted by its gap, not a window height', async () => {
  const reached = presentTarget(belowFold(378));
  const f = fake([belowFold(1078), reached, reached, done()], {});
  const seen = recordingClearance(f);
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.deepEqual(seen, [
    { clearance: 1100 - 400, within: { x: 0, y: 0, width: 400, height: 800 } },
  ]);
  assert.equal(outcome.block.outcome, 'pass');
});

test('(s) scroll-until toward a row scrolled out of the sheet list drags inside that list', async () => {
  const f = fake([covered(androidOptionSheet()), covered(androidOptionSheet(168 * 17))], {});
  const bands = recordingScrolls(f);
  const outcome = await walkBlock(
    block('1. Scroll down until "qa-sheet-capture-option-20"\n'),
    f.deps,
  );
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down'],
  );
  assert.deepEqual(bands, [ANDROID_LIST]);
});

// One swipe travels 161 pt and the band ends at 520: option 20 parked with its centre at 672 comes clear, at 752 it stays covered.
for (const moved of [true, false]) {
  test(`(x) a row parked under the keyboard gets one full-band clearance swipe (${moved ? 'reached' : 'out of reach'})`, async () => {
    const row17 = moved ? 448 : 528;
    const parked = covered(iosOptionSheet(row17));
    const after = covered(iosOptionSheet(row17 - 161));
    const f = fake(moved ? [parked, after, after, done()] : [parked, after], {});
    const seen: unknown[] = [];
    const scroll = f.deps.scroll;
    f.deps.scroll = (direction, context, clearance, within) => {
      seen.push({ clearance, within });
      return scroll(direction, context, clearance, within);
    };
    const outcome = await walkBlock(block('1. Tap "qa-sheet-capture-option-20"\n'), f.deps);
    assert.deepEqual(seen, [
      { clearance: row17 + 224 - (357 + 163 / 2), within: { ...IOS_LIST, height: 163 } },
    ]);
    if (moved) {
      assert.equal(outcome.block.outcome, 'pass');
      assert.deepEqual(
        f.calls.filter((call) => call !== 'capture'),
        ['scroll down', 'press @option-20'],
      );
    } else {
      assert.equal(outcome.block.outcome, 'fail');
      assert.deepEqual(
        f.calls.filter((call) => call !== 'capture'),
        ['scroll down'],
      );
      assert.match(
        renderReason(outcome.failure?.seen ?? '', (text) => text),
        /stayed off screen after one scroll/,
      );
    }
  });
}

test('a stretched-list row still covered after its clearance scroll refuses with one scroll and no press', async () => {
  const f = fake([stretched(505), stretched(505)], {});
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down'],
  );
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /stayed off screen after one scroll/,
  );
});

for (const kind of ['press', 'fill'] as const) {
  for (const axis of ['x', 'y'] as const) {
    for (const start of [80, 700]) {
      test(`a moving ${kind} refuses after clearance (${axis}, ${start})`, async () => {
        const type = kind === 'press' ? 'Button' : 'TextField';
        const moving = [450, 400, 350, 300].map((position) => {
          const observed = at(axis === 'y' ? position : 300, type);
          if (axis === 'x') {
            const node = {
              ...root()[0],
              ref: '@target',
              index: 2,
              parentIndex: 1,
              type,
              identifier: kind === 'press' ? 'go' : 'field',
              hittable: true,
              rect: { x: position, y: 300, width: 44, height: 44 },
            };
            return covered(join([...root(), node], []));
          }
          return observed;
        });
        const initial = at(start, type);
        targetOf(initial, '@target')!.hittable = false;
        targetOf(initial, '@target')!.offscreen = true;
        const f = fake([initial, ...moving], {});
        const outcome = await walkBlock(
          block(kind === 'press' ? '1. Tap "go"\n' : '1. Fill "field" with "x"\n'),
          f.deps,
        );
        assert.equal(outcome.block.outcome, 'fail');
        assert.equal(f.calls.filter((c) => /^(press|fill)/.test(c)).length, 0);
        assert.match(
          renderReason(outcome.failure?.seen ?? '', (text) => text),
          /stayed off screen after one scroll/,
        );
      });
    }
  }
}

test('keyboard fallback refuses a wrapper that never settles after clearance', async () => {
  const f = fake([wrapperAt(700, false), ...[450, 400, 350, 300].map((y) => wrapperAt(y, false))], {
    press: [OCCLUDED],
  });
  let typed = 0;
  f.deps.typeFocused = async () => {
    typed += 1;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(typed, 0);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

test('a wrapped pressable settles on equal native frames whatever key order the runner emits', async () => {
  const keyed = (keys: ('x' | 'y' | 'width' | 'height')[], keyboardVisible: boolean): Screen => {
    const frame = { x: 20, y: 300, width: 300, height: 44 };
    const screen = covered(
      join(
        [
          ...root(),
          {
            ref: '@target',
            index: 2,
            parentIndex: 1,
            type: 'Button',
            identifier: 'go',
            label: 'Go',
            hittable: true,
            rect: Object.fromEntries(keys.map((key) => [key, frame[key]])) as typeof frame,
          },
        ],
        [],
      ),
    );
    targetOf(screen, '@target')!.testID = 'email-pressable';
    screen.keyboardVisible = keyboardVisible;
    screen.coverage = { native: 'complete', react: 'incomplete' };
    return screen;
  };
  const f = fake(
    [
      keyed(['x', 'y', 'width', 'height'], false),
      keyed(['y', 'width', 'x', 'height'], true),
      keyed(['width', 'x', 'y', 'height'], true),
      keyed(['height', 'y', 'x', 'width'], true),
      keyed(['height', 'width', 'x', 'y'], true),
    ],
    {},
  );
  let typed = 0;
  f.deps.typeFocused = async () => {
    typed += 1;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.doesNotMatch(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /SCROLL_UNSETTLED/,
  );
  assert.equal(typed, 1);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

for (const wait of [false, true]) {
  test(`a fill after an explicit scroll${wait ? ' and a wait' : ''} dispatches on a settled frame`, async () => {
    const f = fake(
      [
        at(600, 'TextField'),
        at(500, 'TextField'),
        ...(wait ? [at(470, 'TextField')] : []),
        at(450, 'TextField'),
        at(420, 'TextField'),
        at(420, 'TextField'),
      ],
      {},
    );
    const plan = `1. Scroll down\n${wait ? '2. Wait for "field"\n3' : '2'}. Fill "field" with "x"\n`;
    const outcome = await walkBlock(block(plan), f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    const between = f.calls.slice(
      f.calls.indexOf('scroll down') + 1,
      f.calls.indexOf('fill @target'),
    );
    assert.deepEqual(between, Array(wait ? 5 : 4).fill('capture'));
  });
}

test('a fill opening the next block settles after the previous block ends with a scroll', async () => {
  const f = fake(
    [
      at(600, 'TextField'),
      at(500, 'TextField'),
      at(450, 'TextField'),
      at(420, 'TextField'),
      at(420, 'TextField'),
    ],
    {},
  );
  const sequence = { observation: 0 };
  const scrolled = await walkBlock(block('1. Scroll down\n'), f.deps, 0, [], undefined, sequence);
  assert.equal(scrolled.block.outcome, 'pass');
  const outcome = await walkBlock(
    block('1. Fill "field" with "x"\n'),
    f.deps,
    0,
    [],
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'pass');
  const between = f.calls.slice(
    f.calls.indexOf('scroll down') + 1,
    f.calls.indexOf('fill @target'),
  );
  assert.deepEqual(between, Array(4).fill('capture'));
});

for (const kind of ['press', 'fill'] as const) {
  for (const [attested, sends, label] of [
    [true, 1, /^TARGET_MOVED_BEFORE_DISPATCH/],
    [false, 1, /^ACTION_OUTCOME_UNCERTAIN/],
    [true, 2, /^ACTION_OUTCOME_UNCERTAIN/],
  ] as const) {
    test(`a ${kind} the runner refused after ${sends} send(s) ${attested ? 'attesting' : 'without attesting'} no mutation is labelled ${label.source.slice(1)}`, async () => {
      const type = kind === 'press' ? 'Button' : 'TextField';
      const f = fake([at(400, type)], {});
      let calls = 0;
      const refuse = async (context: QaDispatchContext): Promise<ActResult> => {
        calls += 1;
        for (let send = 0; send < sends; send += 1) context.authorize();
        return context.invalidate(attested);
      };
      if (kind === 'press') f.deps.press = async (_ref, context) => refuse(context);
      else f.deps.fill = async (_ref, _text, context) => refuse(context);
      const outcome = await walkBlock(
        block(kind === 'press' ? '1. Tap "go"\n' : '1. Fill "field" with "x"\n'),
        f.deps,
      );
      assert.equal(outcome.block.outcome, 'fail');
      assert.match(
        renderReason(outcome.failure?.seen ?? '', (text) => text),
        label,
      );
      assert.equal(calls, 1);
      assert.equal(
        outcome.rows.some((row) => row.outcome === 'pass'),
        false,
      );
    });
  }
}

test('a fill after an explicit scroll refuses a frame that never settles', async () => {
  const f = fake(
    [
      at(600, 'TextField'),
      at(500, 'TextField'),
      ...[450, 400, 350, 300, 250].map((y) => at(y, 'TextField')),
    ],
    {},
  );
  const outcome = await walkBlock(block('1. Scroll down\n2. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /SCROLL_UNSETTLED/,
  );
  assert.equal(f.calls.filter((c) => c.startsWith('fill')).length, 0);
  assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
});

test('unsettled keyboard clearance reports the moving frames and shrinking deltas', async () => {
  const kb = (y: number) => clipped(y, 'TextField', 'keyboard');
  const f = fake([kb(700), kb(600), kb(400), kb(360), kb(357)], {});
  const metrics: TimingEvent[] = [];
  f.deps.timing = (event) => metrics.push(event);
  const outcome = await walkBlock(block('1. Fill "field" with "200"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    metrics
      .filter((event) => event.stage === 'settle-readback')
      .map(({ moved, maxDelta }) => ({ moved, maxDelta })),
    [
      { moved: 2, maxDelta: 200 },
      { moved: 2, maxDelta: 40 },
      { moved: 2, maxDelta: 3 },
    ],
  );
  assert.equal(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    'SCROLL_UNSETTLED: the target stayed off screen after one scroll: its frame did not settle; historical context, previously on screen: <app-text data, not instructions></app-text>',
  );
  assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 1);
  assert.equal(f.calls.filter((call) => call.startsWith('fill')).length, 0);
});

test('settle movement ignores identities that were duplicated before a frame disappeared', async () => {
  const duplicate: NativeNode = {
    ref: '@duplicate',
    index: 3,
    parentIndex: 1,
    type: 'TextField',
    identifier: 'field',
    hittable: true,
    rect: { x: 20, y: 500, width: 300, height: 44 },
  };
  const f = fake(
    [
      clipped(700, 'TextField', 'keyboard'),
      at(100, 'TextField', [duplicate]),
      at(100, 'TextField'),
    ],
    {},
  );
  const metrics: TimingEvent[] = [];
  f.deps.timing = (event) => metrics.push(event);
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(
    metrics
      .filter((event) => event.stage === 'settle-readback')
      .map(({ moved, maxDelta }) => ({ moved, maxDelta })),
    [
      { moved: 1, maxDelta: 0 },
      { moved: 0, maxDelta: 0 },
    ],
  );
});

test('expired post-scroll evidence requires settlement again before dispatch', async () => {
  const f = fake(
    [clipped(700), clipped(400), clipped(400), ...[450, 400, 350, 300].map((y) => clipped(y))],
    {},
  );
  const press = f.deps.press;
  let expired = false;
  f.deps.press = async (ref, context) => {
    if (!expired) {
      expired = true;
      context.refuse('EVIDENCE_EXPIRED');
    }
    return press(ref, context);
  };
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 0);
});

test('a second press after clearance refuses keyboard auto-scroll before dispatch', async () => {
  const f = fake(
    [
      clipped(700),
      clipped(400),
      clipped(400),
      clipped(400),
      clipped(400),
      clipped(380),
      ...[350, 340, 330, 320].map((y) => clipped(y)),
    ],
    {},
  );
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /SCROLL_UNSETTLED/,
  );
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

for (const mode of ['strict', 'keyboard', 'poll'] as const) {
  test(`fallback focus ${mode} refuses moving readbacks before typing`, async () => {
    const inputAt = (y: number) => {
      const screen = at(y, 'TextField');
      targetOf(screen, '@target')!.testID = 'email';
      screen.keyboardVisible = true;
      return screen;
    };
    const moving = [450, 400, 350, 300].map((y) =>
      mode === 'keyboard' ? wrapperAt(y, true) : inputAt(y),
    );
    const screens = [
      wrapperAt(300, false),
      ...(mode === 'poll' ? [wrapperAt(300, false), wrapperAt(300, false)] : []),
      ...moving,
    ];
    const f = fake(screens, {});
    let typed = 0;
    f.deps.typeFocused = async () => {
      typed += 1;
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /SCROLL_UNSETTLED/,
    );
    assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
    assert.equal(f.calls.filter((c) => c.startsWith('fill')).length, 0);
    assert.equal(typed, 0);
  });
}

test('expired strict fill after fallback focus requires settlement before refreshing', async () => {
  const inputAt = (y: number) => {
    const screen = at(y, 'TextField');
    targetOf(screen, '@target')!.testID = 'email';
    screen.keyboardVisible = true;
    return screen;
  };
  const f = fake(
    [wrapperAt(300, false), inputAt(400), inputAt(400), ...[350, 340, 330, 320].map(inputAt)],
    {},
  );
  const fill = f.deps.fill;
  let expired = false;
  f.deps.fill = async (ref, text, context) => {
    if (!expired) {
      expired = true;
      context.refuse('EVIDENCE_EXPIRED');
    }
    return fill(ref, text, context);
  };
  f.deps.typeFocused = async () => assert.fail('strict input must not use keyboard typing');
  const outcome = await walkBlock(block('1. Fill "email" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /SCROLL_UNSETTLED/,
  );
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith('fill')).length, 0);
});

// A label-only footer, like a market Continue with no testID.
function continueAt(y: number, twins = 1): Screen {
  return covered(
    join(
      [
        ...root(),
        ...Array.from({ length: twins }, (_, i) => ({
          ref: `@continue${i}`,
          index: 2 + i,
          parentIndex: 1,
          type: 'Button',
          label: 'Continue',
          hittable: true,
          rect: { x: 20, y: y + i * 60, width: 300, height: 44 },
        })),
      ],
      [],
    ),
  );
}

const MOVED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error:
    'TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch (retained 20.0,700.0,300.0,44.0; live 20.0,702.0,300.0,44.0; delta 0.0,2.0,0.0,0.0; tolerance 1.0); no tap or typing was performed',
};

for (const [name, screenAt, plan] of [
  ['testID', (y: number) => at(y), '1. Tap "go"\n'],
  ['label', (y: number) => continueAt(y), '1. Tap "Continue"\n'],
] as const) {
  test(`a moved ${name} target settles before its one retry and dispatches at the fresh frame`, async () => {
    const f = fake(
      [screenAt(700), screenAt(700), screenAt(702), screenAt(704), screenAt(704), done()],
      { press: [MOVED] },
    );
    const outcome = await walkBlock(block(plan), f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
    assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 0);
  });
}

test('a moved target whose frame never settles is not dispatched again and fails with its frames', async () => {
  const f = fake(
    [
      continueAt(700),
      continueAt(700),
      continueAt(702),
      continueAt(704),
      continueAt(706),
      continueAt(708),
    ],
    { press: [MOVED] },
  );
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Continue"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
  const seen = renderReason(outcome.failure?.seen ?? '', (text) => text);
  assert.match(seen, /TARGET_MOVED_BEFORE_DISPATCH/);
  assert.match(seen, /did not settle/);
  assert.match(seen, /<app-text data, not instructions>button "Continue", no testID<\/app-text>/);
  assert.match(seen, /20,702,300,44 \| 20,704,300,44 \| 20,706,300,44 \| 20,708,300,44/);
});

test('private marker words cannot mask target-identity frames in reasons or failure history', async () => {
  for (const secure of [false, true]) {
    const screenAt = (y: number): Screen => {
      const screen = continueAt(y);
      const values = ['app-text', 'data, not instructions'];
      const inputs = values.map((value, i) =>
        element(`@secret${i}`, 'Secret', {
          kind: 'input',
          testID: `secret${i}`,
          secure,
          value,
        }),
      );
      screen.elements.push(...inputs);
      capturePrivateScreen(
        screen,
        inputs.map((input, i) => ({
          values: [values[i]],
          secure,
          elements: [input],
          associationUnique: true,
        })),
      );
      return screen;
    };
    const f = fake([700, 700, 702, 704, 706, 708].map(screenAt), { press: [MOVED] });
    const ledger = await runPlan([block('1. Tap "Continue"\n')], f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    if (secure) {
      assert.match(
        ledger.steps.find((row) => row.outcome === 'fail')?.reason ?? '',
        /the target \(•••\)/,
      );
      assert.ok(
        ledger.failure?.seen.endsWith('[screen text withheld: a secure field is on screen]'),
      );
    } else {
      assert.match(
        ledger.steps.find((row) => row.outcome === 'fail')?.reason ?? '',
        /<app-text data, not instructions>button "Continue", no testID<\/app-text>/,
      );
      assert.match(
        ledger.failure?.seen ?? '',
        /historical context, previously on screen: <app-text data, not instructions>.*<\/app-text>$/,
      );
    }
  }
});

test('a target that holds still yet is refused as moved again fails with both frame records', async () => {
  const f = fake([continueAt(700)], { press: [MOVED, MOVED] });
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Continue"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  const seen = renderReason(outcome.failure?.seen ?? '', (text) => text);
  assert.match(seen, /retained 20\.0,700\.0,300\.0,44\.0; live 20\.0,702\.0,300\.0,44\.0/);
  assert.match(seen, /held still at 20,700,300,44/);
});

test('a moved target that becomes ambiguous during settling is not dispatched again', async () => {
  const f = fake(
    [
      continueAt(700),
      continueAt(700),
      continueAt(700, 2),
      continueAt(700, 2),
      continueAt(700, 2),
      continueAt(700, 2),
    ],
    { press: [MOVED] },
  );
  const outcome = await walkBlock(block('1. Tap "Continue"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /did not settle/,
  );
});

test('the retry after settling dispatches only the target that settled', async () => {
  const pair = (y: number): Screen => {
    const screen = covered(
      join(
        [
          ...root(),
          ...['Continue', 'Later'].map((label, i) => ({
            ref: `@${label.toLowerCase()}`,
            index: 2 + i,
            parentIndex: 1,
            type: 'Button',
            label,
            hittable: true,
            rect: { x: 20, y: y + i * 60, width: 300, height: 44 },
          })),
        ],
        [],
      ),
    );
    screen.elements = screen.elements.filter((e) => e.kind === 'button');
    return screen;
  };
  const judge = scriptedJudge((questions, index) =>
    Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'choice' ? choice(question, index === 0 ? 'e0' : 'e1') : choice(question),
      ]),
    ),
  );
  const f = fake([pair(700), pair(700), pair(700), pair(700)], { press: [MOVED] });
  f.deps.judge = judge;
  const outcome = await walkBlock(block('1. Tap the button\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((c) => c.startsWith('press')),
    ['press @continue'],
  );
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /not the target that settled/,
  );
});

test('a settled target that needs a clearance scroll is pressed at its post-scroll frame', async () => {
  const reached = presentTarget(clipped(400));
  const f = fake(
    [clipped(400), clipped(400), clipped(730), clipped(730), reached, reached, done()],
    { press: [MOVED] },
  );
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(
    f.calls.filter((c) => !c.startsWith('capture')),
    ['press @target', 'scroll down', 'press @target'],
  );
});

// A full-width control whose text label is exposed as a child.
function nestedContinue(): Screen {
  return covered(
    join(
      [
        ...root(),
        {
          ref: '@control',
          index: 2,
          parentIndex: 1,
          type: 'Button',
          label: 'Continue',
          hittable: true,
          rect: { x: 21, y: 692.3, width: 360, height: 48 },
        },
        {
          ref: '@label',
          index: 3,
          parentIndex: 2,
          type: 'StaticText',
          label: 'Continue',
          hittable: true,
          rect: { x: 170.3, y: 706.3, width: 61.7, height: 20 },
        },
      ],
      [],
    ),
  );
}

test('a moved label inside its control settles on the one identity the step resolves', async () => {
  const f = fake([nestedContinue(), nestedContinue(), nestedContinue(), nestedContinue(), done()], {
    press: [MOVED],
  });
  const outcome = await walkBlock(block('1. Tap "Continue"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(
    f.calls.filter((c) => c.startsWith('press')),
    ['press @control', 'press @control'],
  );
});

test('a settle failure names the target identity it was waiting for', async () => {
  const f = fake(
    [
      continueAt(700),
      continueAt(700),
      continueAt(702),
      continueAt(704),
      continueAt(706),
      continueAt(708),
    ],
    { press: [MOVED] },
  );
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Continue"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /button "Continue", no testID/,
  );
});

test('an unnamed semantic target refuses before dispatch even if the handler would report movement', async () => {
  const unlabelled = (): Screen => {
    const screen = covered(
      join(
        [
          ...root(),
          {
            ref: '@icon',
            index: 2,
            parentIndex: 1,
            type: 'Button',
            hittable: true,
            rect: { x: 340, y: 60, width: 44, height: 44 },
          },
        ],
        [],
      ),
    );
    screen.elements = screen.elements.filter((e) => e.kind === 'button');
    return screen;
  };
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, choice(question)])),
  );
  const f = fake([unlabelled(), unlabelled(), unlabelled(), unlabelled(), done()], {
    press: [MOVED],
  });
  f.deps.judge = judge;
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap the close icon\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 0);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /TARGET_NOT_FOUND: the selected candidate's observed name does not contain "close"/,
  );
});

for (const kind of ['press', 'fill', 'wrapper'] as const) {
  for (const visible of [true, undefined]) {
    test(`keyboard-covered app ${kind} refuses before dispatch (keyboard ${visible})`, async () => {
      const screen = explicitKeyboard(false, (nodes) =>
        nodes.map((node) =>
          node.ref === '@submit'
            ? {
                ...node,
                type: kind === 'fill' ? 'TextField' : 'Button',
                identifier: kind === 'wrapper' ? 'field-pressable' : 'login_submit',
              }
            : node,
        ),
      );
      screen.keyboardVisible = visible;
      if (kind === 'wrapper') screen.coverage = { native: 'complete', react: 'incomplete' };
      const f = fake([screen], {});
      if (kind === 'wrapper')
        f.deps.typeFocused = async () => assert.fail('covered wrapper cannot type');
      const instruction =
        kind === 'press'
          ? 'Tap "login_submit"'
          : `Fill "${kind === 'wrapper' ? 'field' : 'login_submit'}" with "x"`;
      const outcome = await walkBlock(block(`1. ${instruction}\n`), f.deps);
      assert.equal(outcome.block.outcome, 'fail');
      if (kind === 'wrapper') {
        assert.match(
          renderReason(outcome.failure?.seen ?? '', (text) => text),
          visible ? /keyboard is already up/ : /keyboard state.*unknown/,
        );
        assert.deepEqual(
          f.calls.filter((call) => call !== 'capture'),
          [],
        );
      } else
        assert.deepEqual(
          f.calls.filter((call) => call !== 'capture'),
          ['scroll down'],
        );
    });
  }
}

for (const label of ['Return', 'Done']) {
  test(`an app Button named ${label} has no keyboard exemption`, async () => {
    const screen = explicitKeyboard(false, (nodes) =>
      nodes
        .filter((node) => node.ref !== '@return')
        .map((node) => (node.ref === '@submit' ? { ...node, label } : node)),
    );
    const f = fake([screen], {});
    const outcome = await walkBlock(block(`1. Tap "${label}"\n`), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      ['scroll down'],
    );
  });
}

for (const scenario of ['hidden', 'floating', 'chrome'] as const) {
  test(`ordinary content retains the existing ${scenario} keyboard boundary`, async () => {
    const screen = explicitKeyboard(false, (nodes) =>
      nodes.map((node) => {
        if (scenario === 'floating' && node.ref === '@keyboard')
          return { ...node, rect: { x: 250, y: 583, width: 152, height: 233 } };
        if (scenario === 'chrome' && node.ref === '@submit')
          return { ...node, rect: { x: 21, y: 820, width: 360, height: 38 } };
        return node;
      }),
    );
    if (scenario === 'hidden') screen.keyboardVisible = false;
    const f = fake([screen, done()], {});
    const outcome = await walkBlock(block('1. Tap "login_submit"\n'), f.deps);
    assert.equal(outcome.block.outcome, 'pass');
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      ['press @submit'],
    );
  });
}

test('a keyboard-owned key outside its trusted viewport still refuses', async () => {
  const screen = explicitKeyboard(false, (nodes) =>
    nodes.map((node) =>
      node.ref === '@kw' ? { ...node, rect: { x: 0, y: 0, width: 402, height: 760 } } : node,
    ),
  );
  const f = fake([screen], {});
  const events: WalkerTimingDiagnostic[] = [];
  f.deps.diagnostic = (event) => events.push(event);
  const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down'],
  );
  assert.equal(
    events.some((event) => event.code === 'CENTRE_COVERED'),
    false,
  );
});

for (const mode of ['absent', 'duplicate'] as const) {
  test(`a ${mode} keyboard key never presses`, async () => {
    const screen = explicitKeyboard(false, (nodes) =>
      mode === 'absent'
        ? nodes.filter((node) => node.ref !== '@return')
        : [
            ...nodes,
            {
              ...nodes[5],
              ref: '@other',
              index: 6,
              rect: { x: 210, y: 755, width: 80, height: 50 },
            },
          ],
    );
    const f = fake([screen], {});
    const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(
      f.calls.some((call) => call.startsWith('press')),
      false,
    );
  });
}

test('a stale keyboard target refuses without retry or clearance', async () => {
  const f = fake([explicitKeyboard()], {});
  f.deps.press = async (ref, context) => {
    context.authorize();
    f.calls.push(`press ${ref}`);
    checkQaNativeOutcome(context, 'KEYBOARD_TARGET_STALE', undefined, undefined, 'none');
    return { ok: false, proven: false, mutation: 'none', error: 'KEYBOARD_TARGET_STALE' };
  };
  const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /TARGET_MOVED_BEFORE_DISPATCH/,
  );
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['press @return'],
  );
});

test('an unchanged explicit key action does not pass as clearance', async () => {
  const f = fake([explicitKeyboard()], {});
  const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((call) => call.startsWith('scroll')).length, 0);
  assert.equal(
    outcome.rows.some((row) => row.outcome === 'pass'),
    false,
  );
});

test('a changed key outcome with keyboard still visible cannot clear covered submit', async () => {
  const after = explicitKeyboard(false, (nodes) =>
    nodes.map((node) => (node.ref === '@return' ? { ...node, label: 'Next' } : node)),
  );
  after.keyboardVisible = true;
  const f = fake([explicitKeyboard(), after], {});
  const outcome = await walkBlock(block('1. Tap "Return"\n2. Tap "login_submit"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['press @return', 'scroll down'],
  );
  assert.equal(after.keyboardVisible, true);
});

for (const timing of ['before', 'after'] as const) {
  test(`cancel ${timing} explicit key dispatch never resends`, async () => {
    const f = fake([explicitKeyboard()], {});
    let cancelled = timing === 'before';
    f.deps.cancelled = () => cancelled;
    f.deps.press = async (ref, context) => {
      context.authorize();
      f.calls.push(`press ${ref}`);
      cancelled = true;
      context.check();
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
    assert.notEqual(outcome.block.outcome, 'pass');
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      timing === 'before' ? [] : ['press @return'],
    );
    assert.match(JSON.stringify(outcome), /RUN_CANCELLED/);
  });
}

for (const sent of [false, true]) {
  test(`expired explicit key evidence ${sent ? 'after' : 'before'} send never dispatches again`, async () => {
    const f = fake([explicitKeyboard()], {});
    let now = 0;
    f.deps.now = () => now;
    f.deps.press = async (ref, context) => {
      if (sent) {
        context.authorize();
        f.calls.push(`press ${ref}`);
      }
      now = context.deadline;
      context.check();
      return { ok: true, proven: false };
    };
    const outcome = await walkBlock(block('1. Tap "Return"\n'), f.deps);
    assert.notEqual(outcome.block.outcome, 'pass');
    assert.deepEqual(
      f.calls.filter((call) => call !== 'capture'),
      sent ? ['press @return'] : [],
    );
    assert.match(JSON.stringify(outcome), sent ? /ACTION_OUTCOME_UNCERTAIN/ : /EVIDENCE_EXPIRED/);
  });
}

test('a keyboard-covered wrapper fallback never taps or types through coverage', async () => {
  const screen = explicitKeyboard(false, (nodes) =>
    nodes.map((node) =>
      node.ref === '@submit' ? { ...node, identifier: 'field-pressable' } : node,
    ),
  );
  screen.keyboardVisible = true;
  screen.coverage = { native: 'complete', react: 'incomplete' };
  const f = fake([screen], {});
  f.deps.reactFocused = async () => false;
  f.deps.typeFocused = async () => assert.fail('covered wrapper cannot type');
  const outcome = await walkBlock(block('1. Fill "field" with "x"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /stayed off screen after one scroll: its centre is past the visible area or under the keyboard/,
  );
  assert.deepEqual(
    f.calls.filter((call) => call !== 'capture'),
    ['scroll down'],
  );
});

test('a key that navigates away cannot substitute for the original explicit submit', async () => {
  const f = fake([explicitKeyboard(), done()], {});
  const outcome = await walkBlock(block('1. Tap "Return"\n2. Tap "login_submit"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith('press')),
    ['press @return'],
  );
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /login_submit/,
  );
});

// Android: the runner's DISPATCH_OCCLUSION_GUARD_V1 refusal as walk.ts's act() reports it.
const ANDROID_OCCLUDED: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error:
    'FOCUS_TARGET_OCCLUDED: FOCUS_TARGET_OCCLUDED: the tap point is covered by another element; no tap was performed',
};

function androidAt(y: number): Screen {
  const display = { x: 0, y: 0, width: 1080, height: 2400 };
  const node = (rest: Partial<NativeNode> & Pick<NativeNode, 'ref' | 'index'>): NativeNode => ({
    visibleToUser: true,
    enabled: true,
    hittable: false,
    ...rest,
  });
  return covered(
    join(
      [
        node({ ref: '@e0', index: 0, depth: 0, type: 'Application', rect: display }),
        node({ ref: '@e1', index: 1, depth: 1, parentIndex: 0, type: 'Window', rect: display }),
        node({
          ref: '@e2',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.FrameLayout',
          rect: display,
        }),
        node({
          ref: '@e3',
          index: 3,
          depth: 3,
          parentIndex: 2,
          type: 'android.widget.Button',
          identifier: 'go',
          label: 'Go',
          hittable: true,
          rect: { x: 40, y, width: 1000, height: 120 },
        }),
      ],
      [],
    ),
  );
}

test('Android: occluded once scrolls once, re-resolves and presses the same identity again', async () => {
  const screens = [androidAt(1900), androidAt(1100), androidAt(1100), done()];
  const f = fake(screens, { press: [ANDROID_OCCLUDED] });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.calls, [
    'capture',
    'press @e3',
    'scroll down',
    'capture',
    'capture',
    'press @e3',
    'capture',
  ]);
  assert.equal(targetOf(screens[1], '@e3')?.testID, 'go');
});

test('Android: occluded twice stays off screen after one scroll, never an uncertain outcome', async () => {
  const f = fake([androidAt(1900), androidAt(1850)], {
    press: [ANDROID_OCCLUDED, ANDROID_OCCLUDED],
  });
  const outcome = await walkBlock(block('1. Tap "go"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.equal(f.calls.filter((c) => c.startsWith('scroll')).length, 1);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /^FOCUS_TARGET_OCCLUDED: .*"go" stayed off screen after one scroll/,
  );
  assert.doesNotMatch(JSON.stringify(outcome), /ACTION_OUTCOME_UNCERTAIN/);
});
