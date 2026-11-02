import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

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
  return {
    ...join(nodes, []),
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
