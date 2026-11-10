import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createSandbox } from '../helpers/inject-harness.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, type DigestEntry, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { NativeCaptureError } from '../../../dist/qa/capture.js';

interface Shape {
  keyboard?: boolean;
  selected?: boolean;
  peer?: boolean;
  peerSelected?: boolean;
  listHeight?: number;
  outsideSelected?: boolean;
  inScroll?: boolean;
  frameX?: number;
  testID?: string;
  twin?: boolean;
  chipState?: 'absent' | 'duplicate' | 'no-frame';
}

function twinDigest(testID: string): DigestEntry[] {
  const press = { testID, onClick() {} };
  const node = (name: string, tag: number, props: object, child?: object) => ({
    tag,
    type: tag === 5 ? name : { displayName: name },
    memoizedProps: props,
    ...(child ? { child } : {}),
  });
  const chip = node(
    'Chip',
    0,
    press,
    node(
      'ChipInner',
      0,
      { onClick() {} },
      node('RCTView', 5, press, { tag: 6, type: null, memoizedProps: 'Choice' }),
    ),
  );
  const sandbox = createSandbox({ fiberRoot: node('Screen', 0, {}, chip) });
  return JSON.parse(vm.runInContext('__QAREN.getTree({ interactiveOnly: true })', sandbox))
    .interactive;
}

function screen({
  keyboard = false,
  selected = false,
  peer = true,
  peerSelected = false,
  listHeight = 100,
  outsideSelected = false,
  inScroll = true,
  frameX = 20,
  testID = 'chip',
  twin = false,
  chipState,
}: Shape = {}): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@input',
      index: 1,
      parentIndex: 0,
      type: outsideSelected ? 'Button' : 'TextField',
      ...(outsideSelected ? { selected: true } : {}),
      identifier: 'amount',
      hittable: true,
      rect: { x: 20, y: 100, width: 300, height: 44 },
    },
    {
      ref: '@list',
      index: 2,
      parentIndex: 0,
      type: inScroll ? 'ScrollView' : 'Other',
      rect: { x: 0, y: 200, width: 400, height: listHeight },
    },
    {
      ref: '@chip',
      index: 3,
      parentIndex: 2,
      type: 'Button',
      identifier: testID,
      label: 'Choice',
      hittable: true,
      rect: { x: frameX, y: 220, width: 100, height: 44 },
      ...(selected ? { selected: true } : {}),
    },
    ...(peer
      ? [
          {
            ref: '@peer',
            index: 4,
            parentIndex: 2,
            type: 'Button',
            label: 'Peer',
            ...(peerSelected ? { selected: true } : {}),
            hittable: true,
            rect: { x: 140, y: 220, width: 100, height: 44 },
          },
        ]
      : []),
  ];
  if (chipState === 'no-frame') delete nodes[3].rect;
  if (chipState === 'duplicate') nodes.push({ ...nodes[3], ref: '@duplicate', index: 5 });
  return {
    ...join(
      nodes.filter((node) => chipState !== 'absent' || node.ref !== '@chip'),
      twin ? twinDigest(testID) : [],
    ),
    keyboardVisible: keyboard,
    coverage: { native: 'complete', react: 'complete' },
  };
}

function fake(screens: Screen[], presses: ActResult[] = []) {
  const calls: string[] = [];
  const queue = [...screens];
  let clock = 0;
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen() {
      calls.push('capture');
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return presses.shift() ?? { ok: true, proven: false };
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

const withDismissal = (
  f: ReturnType<typeof fake>,
  via: 'js' | 'native-control' | 'none' = 'js',
) => {
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.calls.push('dismiss');
    return via;
  };
  return f;
};

const tap = parsePlan('1. Tap "chip"\n').blocks![0];
const count = (f: ReturnType<typeof fake>, prefix: string) =>
  f.calls.filter((call) => call.startsWith(prefix)).length;

test('a stable native chip with a React-only twin settles after keyboard dismissal', async () => {
  const shape = { testID: 'qa-chip', twin: true };
  const initial = screen({ ...shape, keyboard: true });
  assert.deepEqual(
    initial.elements.filter((e) => e.testID === 'qa-chip').map((e) => [e.ref, e.kind]),
    [
      ['@chip', 'button'],
      ['react:qa-chip', 'button'],
    ],
  );
  const f = withDismissal(fake([initial, ...Array.from({ length: 4 }, () => screen(shape))]));
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async () => {
    if (count(f, 'press') === 0) return capture();
    f.calls.push('capture');
    return screen({ ...shape, selected: true });
  };
  const outcome = await walkBlock(parsePlan('1. Tap "qa-chip"\n').blocks![0], f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure?.seen));
  assert.equal(count(f, 'press'), 1);
  assert.deepEqual(f.calls, ['capture', 'dismiss', 'capture', 'capture', 'press @chip', 'capture']);
});

test('a moving native chip with a twin refuses with all four frames after dismissal', async () => {
  const f = withDismissal(
    fake([
      screen({ keyboard: true, twin: true }),
      ...[30, 40, 50, 60].map((frameX) => screen({ frameX, twin: true })),
    ]),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'press'), 0);
  assert.equal(count(f, 'capture'), 5);
  assert.match(
    JSON.stringify(outcome.failure?.seen),
    /did not settle across 4 captures \(30,220,100,44 \| 40,220,100,44 \| 50,220,100,44 \| 60,220,100,44\); it was not dispatched; keyboard after dismissal: hidden/,
  );
});

test('an absent capture followed by two equal native frames with a twin settles', async () => {
  const f = withDismissal(
    fake([
      screen({ keyboard: true, twin: true }),
      screen({ chipState: 'absent', twin: true }),
      screen({ twin: true }),
      screen({ twin: true }),
      screen({ twin: true, selected: true }),
    ]),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure?.seen));
  assert.equal(count(f, 'press'), 1);
  assert.equal(count(f, 'capture'), 5);
});

for (const [chipState, reason] of [
  ['absent', 'absent'],
  ['duplicate', 'ambiguous:2'],
  ['no-frame', 'no-frame'],
] as const) {
  test(`a native chip that becomes ${chipState} after dismissal refuses with ${reason}`, async () => {
    const f = withDismissal(
      fake([screen({ keyboard: true, twin: true }), screen({ chipState, twin: true })]),
    );
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'press'), 0);
    assert.equal(count(f, 'capture'), 5);
    assert.ok(
      JSON.stringify(outcome.failure?.seen).includes(
        `did not settle across 4 captures (${Array(4).fill(reason).join(' | ')}); it was not dispatched; keyboard after dismissal: hidden`,
      ),
      JSON.stringify(outcome.failure?.seen),
    );
  });
}

for (const keyboard of [true, undefined] as const) {
  test(`an absent target reports keyboard after dismissal as ${keyboard ? 'visible' : 'unknown'}`, async () => {
    const after = screen({ chipState: 'absent', twin: true });
    after.keyboardVisible = keyboard;
    const f = withDismissal(fake([screen({ keyboard: true, twin: true }), after]));
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(count(f, 'press'), 0);
    assert.ok(
      JSON.stringify(outcome.failure?.seen).includes(
        `keyboard after dismissal: ${keyboard ? 'visible' : 'unknown'}`,
      ),
    );
  });
}

test('a moved-target retry retains its React-only twin ambiguity without keyboard clearance', async () => {
  const f = withDismissal(
    fake(
      [screen({ twin: true })],
      [{ ok: false, proven: false, mutation: 'none', error: 'TARGET_MOVED_BEFORE_DISPATCH' }],
    ),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'press'), 1);
  assert.equal(count(f, 'dismiss'), 0);
  assert.match(
    JSON.stringify(outcome.failure?.seen),
    /did not settle across 4 captures \(ambiguous:2 \| ambiguous:2 \| ambiguous:2 \| ambiguous:2\); it was not dispatched again/,
  );
});

test('a Fill retains React-only twins in its identity ambiguity', async () => {
  const input: Screen = {
    ...join(
      [
        {
          ref: '@field',
          index: 0,
          type: 'TextField',
          identifier: 'field',
          hittable: true,
          rect: { x: 20, y: 100, width: 300, height: 44 },
        },
      ],
      [
        { role: 'textinput', testID: 'field' },
        { role: 'textinput', testID: 'field' },
      ],
    ),
    coverage: { native: 'complete', react: 'complete' },
  };
  const f = withDismissal(fake([input]));
  f.deps.fill = async (ref) => {
    f.calls.push(`fill ${ref}`);
    return { ok: true, proven: true };
  };
  const outcome = await walkBlock(
    parsePlan('1. Fill "field" with "synthetic"\n').blocks![0],
    f.deps,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'fill'), 0);
  assert.equal(count(f, 'dismiss'), 0);
  assert.match(JSON.stringify(outcome.failure?.seen), /TARGET_AMBIGUOUS/);
});

for (const veto of ['dev-redbox', 'render-error', 'native-capture'] as const) {
  for (const readback of [1, 2] as const) {
    test(`a twin capture preserves the ${veto} veto on settle readback ${readback}`, async () => {
      const f = withDismissal(
        fake([screen({ keyboard: true, twin: true }), screen({ twin: true })]),
      );
      const capture = f.deps.captureScreen;
      f.deps.captureScreen = async () => {
        const captured = await capture();
        if (count(f, 'capture') !== readback + 1) return captured;
        if (veto === 'native-capture') throw new NativeCaptureError();
        return {
          ...captured,
          ...(veto === 'dev-redbox' ? { front: 'dev-redbox' as const } : { renderError: true }),
        };
      };
      const outcome = await walkBlock(tap, f.deps);
      assert.equal(outcome.block.outcome, 'fail');
      assert.equal(count(f, 'dismiss'), 1);
      assert.equal(count(f, 'press'), 0);
      if (veto === 'native-capture')
        assert.equal(outcome.refusal?.code, 'NATIVE_CAPTURE_UNAVAILABLE');
      assert.match(
        JSON.stringify(outcome.failure?.seen),
        veto === 'native-capture'
          ? /Native capture is unavailable/
          : veto === 'dev-redbox'
            ? /DEV_REDBOX_ACTION_UNCERTAIN/
            : /the app is showing a React Native error screen/,
      );
    });
  }
}

for (const changed of [false, true]) {
  test(`an expired settled twin capture ${changed ? 'rejects a moved target' : 'rebinds the same target'}`, async () => {
    const f = withDismissal(
      fake([
        screen({ keyboard: true, twin: true }),
        screen({ twin: true }),
        screen({ twin: true }),
        screen({ twin: true, frameX: changed ? 60 : 20 }),
        screen({ twin: true, selected: true }),
      ]),
    );
    let clock = 0;
    f.deps.now = () => (clock += 100);
    f.deps.note = (line) => {
      if (line.startsWith('keyboard-clearance')) clock += 60_000;
    };
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(
      outcome.block.outcome,
      changed ? 'fail' : 'pass',
      JSON.stringify(outcome.failure?.seen),
    );
    assert.equal(count(f, 'press'), changed ? 0 : 1);
    if (changed) assert.match(JSON.stringify(outcome.failure?.seen), /not the target that settled/);
  });
}

test('a visible keyboard is dismissed before a row-choice tap, then the chip is tapped once', async () => {
  const f = withDismissal(
    fake([screen({ keyboard: true }), screen(), screen(), screen({ selected: true })]),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.calls, ['capture', 'dismiss', 'capture', 'capture', 'press @chip', 'capture']);
  const row = outcome.rows.at(-1)!;
  assert.equal(row.keyboardCleared, 'js');
  assert.equal(row.retryCause, undefined);
  assert.equal(outcome.rows.length, 1);
});

test('the native tier is recorded when it cleared the keyboard', async () => {
  const f = withDismissal(
    fake([screen({ keyboard: true }), screen(), screen(), screen({ selected: true })]),
    'native-control',
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.rows.at(-1)!.keyboardCleared, 'native-control');
});

test('a resolved chip keeps its existing keyboard dismissal after a recovery retry', async () => {
  const f = fake([]);
  let current: Screen = { ...screen({ chipState: 'absent' }), front: 'dialog' };
  f.deps.captureScreen = async () => current;
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.calls.push('dismiss');
    current = screen();
    return 'js';
  };
  f.deps.press = async (ref, context) => {
    context.authorize();
    f.calls.push(`press ${ref}`);
    current = screen({ selected: true });
    return { ok: true, proven: true };
  };
  f.deps.hideDevMenu = async () => {
    throw new Error('unexpected dev menu');
  };
  f.deps.dialog = async (_action, context) => {
    context.authorize();
    f.calls.push('dialog');
    current = screen({ keyboard: true });
    return { ok: true, proven: true, executed: true };
  };
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.calls, ['dialog', 'dismiss', 'press @chip']);
});

for (const [name, shape] of [
  ['no keyboard', {}],
  ['a target outside any scroll container', { inScroll: false }],
  ['an ordinary button in a vertical list', { listHeight: 500 }],
  ['a row button without peers', { peer: false }],
  ['an already selected chip', { selected: true }],
] as const) {
  test(`${name} sends no dismissal`, async () => {
    const f = withDismissal(
      fake([
        screen({ keyboard: name !== 'no keyboard', ...shape }),
        screen({ ...shape, selected: true }),
      ]),
    );
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(count(f, 'dismiss'), 0);
    assert.equal(outcome.rows.at(-1)!.keyboardCleared, undefined);
  });
}

test('a tap on the focused text input itself is never preceded by a dismissal', async () => {
  const f = withDismissal(fake([screen({ keyboard: true })]));
  await walkBlock(parsePlan('1. Tap "amount"\n').blocks![0], f.deps);
  assert.equal(count(f, 'dismiss'), 0);
});

test('a target that does not settle after the dismissal fails typed with the keyboard note and no tap', async () => {
  const f = withDismissal(
    fake([
      screen({ keyboard: true }),
      screen({ frameX: 30 }),
      screen({ frameX: 40 }),
      screen({ frameX: 50 }),
      screen({ frameX: 60 }),
    ]),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'press'), 0);
  assert.match(JSON.stringify(outcome.failure?.seen), /the keyboard was dismissed before this tap/);
});

test('a target that no longer resolves after the dismissal fails with the keyboard note and no tap', async () => {
  const f = withDismissal(
    fake([screen({ keyboard: true }), screen({ testID: 'other' }), screen({ testID: 'other' })]),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'press'), 0);
  assert.match(JSON.stringify(outcome.failure?.seen), /the keyboard was dismissed before this tap/);
});

test('a dismissal that cannot prove the keyboard hidden still taps once on the re-settled target', async () => {
  const f = withDismissal(
    fake([
      screen({ keyboard: true }),
      screen({ keyboard: true }),
      screen({ keyboard: true }),
      screen({ keyboard: true, selected: true }),
    ]),
    'none',
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(count(f, 'press'), 1);
  assert.equal(outcome.rows.at(-1)!.keyboardCleared, undefined);
});

test('a selected peer does not authorize a retry after keyboard closure', async () => {
  const f = fake([screen({ keyboard: true, peerSelected: true }), screen({ peerSelected: true })]);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.equal(count(f, 'press'), 1);
});

test('a selection that lands on the second readback passes without another tap', async () => {
  const f = fake([
    screen({ keyboard: true, peerSelected: true }),
    screen({ peerSelected: true }),
    screen({ selected: true, peerSelected: true }),
  ]);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(count(f, 'press'), 1);
  assert.equal(outcome.rows.at(-1)!.attempt, 1);
});

test('an invisible successful toggle that closes the keyboard is never retried', async () => {
  const f = fake([screen({ keyboard: true }), screen(), screen()]);
  let selected = false;
  f.deps.press = async (ref) => {
    f.calls.push(`press ${ref}`);
    selected = !selected;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(count(f, 'press'), 1);
  assert.equal(selected, true);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.equal(
    outcome.rows.some((row) => row.retryCause !== undefined),
    false,
  );
});

for (const when of ['before', 'after'] as const) {
  test(`a peer selected only ${when} the tap cannot authorize a retry`, async () => {
    const f = fake([
      screen({ keyboard: true, peerSelected: when === 'before' }),
      screen({ peerSelected: when === 'after' }),
    ]);
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
    assert.equal(count(f, 'press'), 1);
  });
}

test('native selection outside the target scroll container cannot authorize a retry', async () => {
  const screens = [
    screen({ keyboard: true, outsideSelected: true }),
    screen({ outsideSelected: true }),
  ];
  const f = fake(screens);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(count(f, 'press'), 1);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
});

test('Android row-choice taps do not trigger pre-tap keyboard clearance', async () => {
  const f = withDismissal(fake([screen({ keyboard: true }), screen({ selected: true })]));
  f.deps.platform = 'android';
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(count(f, 'dismiss'), 0);
  assert.equal(count(f, 'press'), 1);
});

for (const [missing, screens] of [
  ['keyboard visible at dispatch', [screen({ peerSelected: true })]],
  ['keyboard hidden after', [screen({ keyboard: true, peerSelected: true })]],
  [
    'target subtree unchanged',
    [screen({ keyboard: true, peerSelected: true }), screen({ peerSelected: true })],
  ],
] as const) {
  test(`no retry without the fact: ${missing}`, async () => {
    const after = [...screens];
    if (missing === 'target subtree unchanged') {
      // The chip's own semantics changed (its label), so the tap may have landed.
      for (const s of after.slice(1)) s.elements.find((e) => e.ref === '@chip')!.label = 'Changed';
    }
    const f = fake(after);
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(count(f, 'press'), 1, missing);
    assert.equal(
      outcome.rows.some((row) => row.retryCause !== undefined),
      false,
    );
  });
}

test('no retry when the target is not a selection candidate (no peer in the row)', async () => {
  const f = fake(
    [screen({ keyboard: true, peer: false }), screen({ peer: false })],
    [{ ok: true, proven: true }],
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(count(f, 'press'), 1);
  assert.equal(
    outcome.rows.some((row) => row.retryCause !== undefined),
    false,
  );
});

test('a stateless row control with the keyboard up: one dismissal, one tap, no retry', async () => {
  const f = withDismissal(fake([screen({ keyboard: true }), screen(), screen()]));
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(count(f, 'press'), 1);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  const row = outcome.rows.at(-1)!;
  assert.equal(row.keyboardCleared, 'js');
  assert.equal(row.retryCause, undefined);
});

test('the streamed row channel records clearance and no app text', async () => {
  const streamed: unknown[] = [];
  const f = withDismissal(
    fake([screen({ keyboard: true }), screen(), screen(), screen({ selected: true })]),
  );
  f.deps.row = (row) => streamed.push(row);
  await walkBlock(tap, f.deps);
  const text = JSON.stringify(streamed);
  assert.match(text, /"keyboardCleared":"js"/);
  assert.equal(streamed.length, 1);
  assert.doesNotMatch(text, /Choice|chip|amount/);
});

test('a target that moves on an expiry recapture after the dismissal is not tapped', async () => {
  const f = withDismissal(
    fake([screen({ keyboard: true }), screen(), screen(), screen({ frameX: 60 })]),
  );
  let clock = 0;
  f.deps.now = () => (clock += 100);
  // The settled capture expires before its use, forcing one fresh capture.
  f.deps.note = (line) => {
    if (line.startsWith('keyboard-clearance')) clock += 60_000;
  };
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'press'), 0);
  assert.match(JSON.stringify(outcome.failure?.seen), /not the target that settled/);
  assert.match(JSON.stringify(outcome.failure?.seen), /the keyboard was dismissed before this tap/);
});

test('ANT-853: an independently selected peer cannot prove a stateless target did not toggle', async () => {
  const f = fake([screen({ keyboard: true, peerSelected: true }), screen({ peerSelected: true })]);
  let appSelection = false;
  f.deps.press = async (ref) => {
    f.calls.push(`press ${ref}`);
    appSelection = !appSelection;
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(
    count(f, 'press'),
    1,
    'A selected peer is not authoritative evidence about target mutation',
  );
  assert.equal(appSelection, true);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
});
