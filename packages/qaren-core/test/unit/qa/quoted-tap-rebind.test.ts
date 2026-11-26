import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, type Block } from '../../../dist/qa/plan.js';
import { bindDispatchIdentity } from '../../../dist/qa/resolve.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { EVIDENCE_USE_MS } from '../../../dist/qa/timing.js';
import { loginBlock, replayBlock, runPlan, type ActResult } from '../../../dist/qa/walker.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = NonNullable<NativeNode['rect']>;
const SIZE = { width: 100, height: 48 };
const COVERED: Rect = { x: 20, y: 500, ...SIZE };
const CLEAR: Rect = { x: 20, y: 220, ...SIZE };

function button(
  ref = '@continue',
  rect: Rect = CLEAR,
  extra: Partial<NativeNode> = {},
): NativeNode {
  return { ref, type: 'Button', label: 'Continue', hittable: true, enabled: true, rect, ...extra };
}

function screen(buttons: NativeNode[], keyboard = false): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: '@list',
      type: 'ScrollView',
      parentIndex: 1,
      rect: { x: 0, y: 100, width: 400, height: 700 },
    },
    ...buttons.map((node) => ({ parentIndex: 2, ...node })),
    ...(keyboard
      ? [
          {
            ref: '@keyboard',
            type: 'Keyboard',
            parentIndex: 0,
            rect: { x: 0, y: 500, width: 400, height: 300 },
          },
        ]
      : []),
  ];
  const joined = join(
    nodes,
    [],
    'app',
    { native: 'complete', react: 'complete' },
    { hosts: [], complete: true },
    {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    },
  );
  // This fixture's keyboard has no controls; it is not an unknown phrase-action candidate.
  const keyboardElement = joined.elements.find((element) => element.ref === '@keyboard');
  if (keyboardElement) keyboardElement.semantic!.press = 'unsupported';
  return {
    ...joined,
    keyboardVisible: keyboard,
  };
}

function fixture(
  afterScroll: Screen,
  line = '1. Tap "Continue"',
  first = screen([button('@original', COVERED)], true),
) {
  let current = first;
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted taps do not ask the model')),
  );
  const actions: string[] = [];
  f.deps.platform = 'ios';
  f.deps.captureScreen = async () => current;
  f.deps.scroll = async (direction, context) => {
    context.authorize();
    actions.push(`scroll ${direction}`);
    current = afterScroll;
    return { ok: true, executed: true, proven: false };
  };
  f.deps.press = async (ref, context) => {
    context.authorize();
    actions.push(`press ${ref}`);
    return { ok: true, proven: true } satisfies ActResult;
  };
  const block = parsePlan(line).blocks![0];
  return {
    ...f,
    actions,
    block,
    setScreen(value: Screen) {
      current = value;
    },
    async run(value: Block = block) {
      const result = await runPlan([value], f.deps);
      return { result, reason: renderReason(result.failure?.seen ?? '', (text) => text) };
    },
  };
}

const tap = { kind: 'press' as const, target: { quoted: 'Continue', phrase: 'Continue' } };
const missing = {
  refuse: 'TARGET_NOT_FOUND',
  reason:
    'the refused target identity no longer resolves uniquely; stayed off screen after one scroll',
};
const original = (node = button('@original', COVERED)) =>
  screen([node], true).elements.find((e) => e.ref === node.ref)!;

for (const count of [2, 3]) {
  test(`L2: ${count} candidates return the exact terminal refusal without contenders`, () => {
    const observed = screen(
      Array.from({ length: count }, (_, i) =>
        button(`@candidate-${i}`, { ...CLEAR, y: 200 + i * 100 }),
      ),
    );
    assert.deepEqual(bindDispatchIdentity(tap, observed, original(), true), {
      refuse: 'TARGET_AMBIGUOUS',
      reason: `"Continue" names ${count} buttons of the same size on the next read, and the button has no testID to tell them apart, so nothing was tapped. Give the button a testID, or quote text only one of them carries; stayed off screen after one scroll`,
    });
  });
}

test('L1: a quoted label-only button binds after exactly one clearance scroll', async () => {
  const f = fixture(screen([button()]));
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'PASS', reason);
  assert.deepEqual(f.actions, ['scroll down', 'press @continue']);
});

for (const offscreen of [false, true]) {
  test(`L2/L8: two same-size candidates refuse finally, including offscreen=${offscreen}`, async () => {
    const twin = button('@twin', { ...CLEAR, y: offscreen ? 1000 : 300 });
    const f = fixture(screen([button(), twin]));
    let dismissals = 0;
    f.deps.dialog = async () => {
      dismissals += 1;
      return { ok: true, proven: true };
    };
    f.deps.hideDevMenu = async () => {
      dismissals += 1;
      return { ok: true, proven: true };
    };
    const { result, reason } = await f.run();
    assert.equal(result.verdict, 'FAIL');
    assert.match(
      reason,
      /TARGET_AMBIGUOUS: "Continue" names 2 buttons of the same size on the next read/,
    );
    assert.match(reason, /no testID to tell them apart, so nothing was tapped/);
    assert.match(
      reason,
      /Give the button a testID, or quote text only one of them carries; stayed off screen after one scroll/,
    );
    assert.deepEqual(f.actions, ['scroll down']);
    assert.equal(dismissals, 0);
    assert.equal(f.rows.filter((row) => row.attempt > 1).length, 0);
  });
}

const excluded = [
  ['another kind', button('@next', CLEAR, { type: 'StaticText' })],
  ['width more than one point off', button('@next', { ...CLEAR, width: SIZE.width + 1.01 })],
  ['height more than one point off', button('@next', { ...CLEAR, height: SIZE.height - 1.01 })],
  ['testID added', button('@next', CLEAR, { identifier: 'continue' })],
  ['no frame', button('@next', CLEAR, { rect: undefined })],
  ['changed label', button('@next', CLEAR, { label: 'Next' })],
] as const;

for (const [name, candidate] of excluded) {
  test(`L3: ${name} keeps the existing refusal`, () => {
    assert.deepEqual(bindDispatchIdentity(tap, screen([candidate]), original(), true), missing);
  });
}

test('L3: a candidate inside an alert is excluded', () => {
  const observed = screen([
    { ref: '@alert', type: 'Alert', rect: { x: 0, y: 100, width: 400, height: 400 } },
    button('@next', CLEAR, { parentIndex: 3 }),
  ]);
  assert.deepEqual(bindDispatchIdentity(tap, observed, original(), true), missing);
});

for (const type of ['StaticText', 'Image']) {
  test(`L3: an original ${type} keeps the existing refusal`, () => {
    assert.deepEqual(
      bindDispatchIdentity(
        tap,
        screen([button()]),
        original(button('@original', COVERED, { type })),
        true,
      ),
      missing,
    );
  });
}

for (const delta of [-1, 1]) {
  test(`L3: width and height within ${delta} point bind`, () => {
    const observed = screen([
      button('@next', { ...CLEAR, width: SIZE.width + delta, height: SIZE.height + delta }),
    ]);
    const result = bindDispatchIdentity(tap, observed, original(), true);
    assert.ok('ref' in result);
    assert.equal(result.ref, '@next');
  });
}

test('L3b: a whole comma-separated segment binds and presses', async () => {
  const f = fixture(
    screen([button('@next', CLEAR, { label: 'Continue, Next' })]),
    '1. Tap "Continue"',
    screen([button('@original', COVERED, { label: 'Continue, Next' })], true),
  );
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'PASS', reason);
  assert.deepEqual(f.actions, ['scroll down', 'press @next']);
});

test('L3b: a whole-label match elsewhere suppresses the segment match', () => {
  const observed = screen([
    button('@segment', CLEAR, { label: 'Continue, Next' }),
    button('@whole', { ...CLEAR, y: 300 }),
  ]);
  assert.deepEqual(
    bindDispatchIdentity(
      tap,
      observed,
      original(button('@original', COVERED, { label: 'Continue, Next' })),
      true,
    ),
    missing,
  );
});

test('L3b: an original without a frame keeps the existing refusal', () => {
  assert.deepEqual(
    bindDispatchIdentity(
      tap,
      screen([button()]),
      original(button('@original', COVERED, { rect: undefined })),
      true,
    ),
    missing,
  );
});

test('L4: a replacement with the same label, kind and size receives the press', async () => {
  const f = fixture(screen([button('@replacement')]));
  const receivers = { original: 0, replacement: 0 };
  f.deps.press = async (ref, context) => {
    context.authorize();
    if (ref === '@original') receivers.original += 1;
    else if (ref === '@replacement') receivers.replacement += 1;
    else assert.fail(`unexpected receiver ${ref}`);
    return { ok: true, proven: true };
  };
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'PASS', reason);
  assert.deepEqual(receivers, { original: 0, replacement: 1 });
  assert.deepEqual(f.actions, ['scroll down']);
});

test('L6: a scroll that leaves the button under the keyboard reaches one keyboard clearance', async () => {
  const f = fixture(screen([button('@next', COVERED)], true));
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.actions.push('dismiss-keyboard');
    f.setScreen(screen([button('@next')]));
    return 'js';
  };
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'PASS', reason);
  assert.deepEqual(f.actions, ['scroll down', 'dismiss-keyboard', 'press @next']);
});

test('L8: ambiguity on a refreshed read after keyboard clearance retains the keyboard clause', async () => {
  const f = fixture(screen([button('@next', COVERED)], true));
  let clock = 0;
  f.deps.now = () => clock;
  f.deps.sleep = async (ms) => {
    clock += ms;
  };
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.actions.push('dismiss-keyboard');
    f.setScreen(screen([button('@next')]));
    return 'js';
  };
  f.deps.press = async (_ref, context) => {
    // The runner has not authorized a press; expiration requires a fresh whole read.
    clock += EVIDENCE_USE_MS + 1;
    f.setScreen(screen([button('@next'), button('@twin', { ...CLEAR, y: 300 })]));
    context.authorize();
    assert.fail('expired evidence must not dispatch');
  };
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'FAIL');
  assert.match(
    reason,
    /TARGET_AMBIGUOUS: "Continue" names 2 buttons of the same size on the next read/,
  );
  assert.match(
    reason,
    /stayed off screen after one scroll; the keyboard was dismissed before this tap/,
  );
  assert.deepEqual(f.actions, ['scroll down', 'dismiss-keyboard']);
});

test('L7/L9: a phrase Tap keeps its refusal after the scroll', async () => {
  const f = fixture(screen([button()]), '1. Tap the Continue button');
  f.deps.judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'FAIL');
  assert.ok(reason.includes(`TARGET_NOT_FOUND: ${missing.reason}`), reason);
  assert.deepEqual(f.actions, ['scroll down']);
});

test('L7/L9: a Fill through the main loop keeps its refusal after the scroll', async () => {
  const f = fixture(
    screen([button('@input', CLEAR, { type: 'TextField' })]),
    '1. Fill "Continue" with "golf"',
    screen([button('@original', COVERED, { type: 'TextField' })], true),
  );
  const { result, reason } = await f.run();
  assert.equal(result.verdict, 'FAIL');
  assert.ok(reason.includes(`TARGET_NOT_FOUND: ${missing.reason}`), reason);
  assert.deepEqual(f.actions, ['scroll down']);
});

test('L7: calls made like the Fill keyboard fallback keep the no-argument refusal', () => {
  for (const type of ['Button', 'TextField']) {
    assert.deepEqual(
      bindDispatchIdentity(
        tap,
        screen([button('@next', CLEAR, { type })]),
        original(button('@original', COVERED, { type })),
      ),
      missing,
    );
  }
});

test('L7: enabling quote binding cannot admit a Fill or a declared stored target', () => {
  const observed = screen([button()]);
  assert.deepEqual(
    bindDispatchIdentity(
      { kind: 'fill', target: tap.target, text: 'golf' },
      observed,
      original(),
      true,
    ),
    missing,
  );
  assert.deepEqual(
    bindDispatchIdentity({ ...tap, declared: tap.target }, observed, original(), true),
    missing,
  );
});

for (const line of ['1. Tap "Continue"', '1. Tap the Continue button']) {
  for (const login of [false, true]) {
    test(`L7b: stored text selectors remain excluded, login=${login}, ${line}`, async () => {
      const f = fixture(screen([button()]), line);
      const stored = {
        header: {
          appId: 'app',
          plan: f.block.slug,
          planHash: f.block.planHash,
          platform: 'ios' as const,
        },
        steps: [{ kind: 'press' as const, raw: line, selector: { text: 'Continue' } }],
      };
      const block = login ? loginBlock('login', stored) : replayBlock(f.block, stored);
      const { result, reason } = await f.run(block);
      assert.equal(result.verdict, 'FAIL');
      assert.ok(reason.includes(`TARGET_NOT_FOUND: ${missing.reason}`), reason);
      assert.deepEqual(f.actions, ['scroll down']);
    });
  }
}

test('L9: omitting byQuote preserves the base results for every label-only candidate shape', () => {
  const variants = [
    screen([button()]),
    screen([button(), button('@twin', { ...CLEAR, y: 300 })]),
    ...excluded.map(([, candidate]) => screen([candidate])),
    screen([button('@next', { ...CLEAR, width: SIZE.width + 1 })]),
    screen([button('@next', CLEAR, { label: 'Continue, Next' })]),
    screen([]),
  ];
  for (const observed of variants) {
    for (const step of [tap, { kind: 'fill' as const, target: tap.target, text: 'golf' }]) {
      assert.deepEqual(bindDispatchIdentity(step, observed, original()), missing);
      assert.deepEqual(bindDispatchIdentity(step, observed, original(), false), missing);
    }
  }
});

test('L7/L9: a target with a testID binds by the ID even when the quote is a label', () => {
  const observed = screen([
    button('@next', CLEAR, { identifier: 'continue' }),
    button('@other', { ...CLEAR, y: 300 }),
  ]);
  const refused = original(button('@original', COVERED, { identifier: 'continue' }));
  for (const byQuote of [undefined, false, true]) {
    const result = bindDispatchIdentity(tap, observed, refused, byQuote);
    assert.ok('ref' in result);
    assert.equal(result.ref, '@next');
  }
});

test('L10: a late ambiguous label ends the original quote-bound press', async () => {
  const f = fixture(screen([button()]));
  f.deps.press = async (ref, context) => {
    context.authorize();
    f.actions.push(`press ${ref}`);
    return { ok: true, proven: false, executed: true, mutation: 'possible' };
  };
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = (options) => {
    if (options?.pressGuardRead)
      f.setScreen(screen([button(), button('@twin', { ...CLEAR, y: 300 })]));
    return capture(options);
  };
  const { result } = await f.run();
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.subreason, 'press-retry-target-changed');
  assert.deepEqual(f.actions, ['scroll down', 'press @continue']);
});

test('L10: a late observation retains its original ID binding without sending', async () => {
  const withID = (ref: string, rect = CLEAR) => button(ref, rect, { identifier: 'continue' });
  const f = fixture(
    screen([withID('@next')]),
    '1. Tap "Continue"',
    screen([withID('@original', COVERED)], true),
  );
  f.deps.press = async (ref, context) => {
    context.authorize();
    f.actions.push(`press ${ref}`);
    return { ok: true, proven: false, executed: true, mutation: 'possible' };
  };
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = (options) => {
    if (options?.pressGuardRead)
      f.setScreen(screen([withID('@next'), button('@twin', { ...CLEAR, y: 300 })]));
    return capture(options);
  };
  const { result } = await f.run();
  assert.equal(result.failure?.subreason, 'press-retry-screen-changed');
  assert.deepEqual(f.actions, ['scroll down', 'press @next']);
});
