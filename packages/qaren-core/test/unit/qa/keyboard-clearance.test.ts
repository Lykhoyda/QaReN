// A visible keyboard takes a chip tap inside a scrolling row; the walker clears it first and retries once only when it provably did.
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
  inScroll?: boolean;
  frameX?: number;
  testID?: string;
}

function screen({
  keyboard = false,
  selected = false,
  peer = true,
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
      type: 'TextField',
      identifier: 'amount',
      hittable: true,
      rect: { x: 20, y: 100, width: 300, height: 44 },
    },
    {
      ref: '@list',
      index: 2,
      parentIndex: 0,
      type: inScroll ? 'ScrollView' : 'Other',
      rect: { x: 0, y: 200, width: 400, height: 100 },
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

test('a visible keyboard is dismissed before a tap inside a scroll container, then the chip is tapped once', async () => {
  const f = withDismissal(
    fake([screen({ keyboard: true }), screen(), screen(), screen({ selected: true })]),
  );
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.calls, ['capture', 'dismiss', 'capture', 'capture', 'press @chip', 'capture']);
  const row = outcome.rows.at(-1)!;
  assert.equal(row.keyboardCleared, 'js');
  assert.equal(row.pressEvidence, 'selected');
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

// Without the walker's dismissal (keyboard guard off), the selection guard is the only defence.
const swallowed = () => [
  screen({ keyboard: true }),
  screen(),
  screen(),
  screen(),
  screen(),
  screen({ selected: true }),
];

test('a tap the keyboard provably swallowed is retried exactly once and the pass is marked retried', async () => {
  const f = fake(swallowed());
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(count(f, 'press'), 2);
  assert.deepEqual(
    outcome.rows.map((row) => [row.attempt, row.outcome, row.retryCause]),
    [
      [1, 'retry', 'KEYBOARD_SWALLOWED_TAP'],
      [2, 'pass', 'KEYBOARD_SWALLOWED_TAP'],
    ],
  );
  assert.match(String(outcome.rows[0].reason), /KEYBOARD_SWALLOWED_TAP/);
  assert.equal(outcome.rows[1].pressEvidence, 'selected');
});

test('a second swallowed tap is refused, never a third press', async () => {
  const f = fake([screen({ keyboard: true }), screen(), screen(), screen(), screen(), screen()]);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  assert.equal(count(f, 'press'), 2);
});

for (const [missing, screens] of [
  ['keyboard visible at dispatch', [screen(), screen(), screen()]],
  ['keyboard hidden after', [screen({ keyboard: true })]],
  ['target subtree unchanged', [screen({ keyboard: true }), screen(), screen()]],
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

test('a stateless row control with the keyboard up: one dismissal, one tap, no retry, no press evidence', async () => {
  const f = withDismissal(fake([screen({ keyboard: true }), screen(), screen()]));
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(count(f, 'press'), 1);
  assert.equal(outcome.refusal?.code, 'PRESS_NOT_REGISTERED');
  const row = outcome.rows.at(-1)!;
  assert.equal(row.pressEvidence, 'none');
  assert.equal(row.keyboardCleared, 'js');
  assert.equal(row.retryCause, undefined);
});

test('the streamed row channel carries the new fields and no app text', async () => {
  const streamed: unknown[] = [];
  const f = fake(swallowed());
  f.deps.row = (row) => streamed.push(row);
  await walkBlock(tap, f.deps);
  const text = JSON.stringify(streamed);
  assert.match(text, /"retryCause":"KEYBOARD_SWALLOWED_TAP"/);
  assert.match(text, /"pressEvidence":"selected"/);
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
