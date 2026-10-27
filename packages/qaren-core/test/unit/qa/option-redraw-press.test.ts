import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodePng } from '../../../dist/qa/tap-pixels.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, screenSignature } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/tap-pixels/${name}.png`, import.meta.url));
const tap = parsePlan('1. Tap "option"\n').blocks![0];

function option(bytes: Uint8Array, moved = 0): Screen {
  const image = decodePng(bytes)!;
  const nodes: NativeNode[] = [
    {
      ref: '@option',
      index: 0,
      type: 'Button',
      label: 'Option',
      identifier: 'option',
      hittable: true,
      rect: { x: 0, y: moved, width: image.width / 3, height: image.height / 3 },
    },
  ];
  return {
    ...join(nodes, []),
    front: 'app',
    pointScale: 3,
    coverage: { native: 'complete', react: 'complete' },
  };
}

function fake(screens: Screen[], shots: (Uint8Array | undefined)[], proven = false) {
  const calls: string[] = [];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      return screens.length > 1 ? screens.shift()! : screens[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return { ok: true, proven } satisfies ActResult;
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
      calls.push('ledger shot');
      return name;
    },
    async comparisonScreenshot() {
      calls.push('pixel shot');
      return shots.shift();
    },
    now: () => (clock += 10),
    async sleep(ms) {
      calls.push(`sleep ${ms}`);
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, calls };
}

async function expectFailure(f: ReturnType<typeof fake>) {
  const outcome = await walkBlock(tap, f.deps, 0, [], f.deps.privacy);
  assert.equal(outcome.block.outcome, 'fail', JSON.stringify(outcome));
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 2);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the screen did not change after two attempts/,
  );
}

test('a stable visible toggle with no accessibility state passes on its first press', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  assert.equal(screenSignature(option(before)), screenSignature(option(after)));
  const f = fake([option(before)], [before, after, after]);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome));
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
  assert.deepEqual(f.calls.slice(0, 5), [
    'pixel shot',
    'press @option',
    'pixel shot',
    'sleep 200',
    'pixel shot',
  ]);
});

test('an unchanged chip still fails after two attempts', async () => {
  const before = fixture('chip-before'),
    after = fixture('chip-after');
  await expectFailure(fake([option(before)], [before, after, after, after, after]));
});

test('spinner and transition after-shots offer no stable proof', async () => {
  for (const [a, b] of [
    ['spinner-a', 'spinner-b'],
    ['transition-mid', 'transition-settled'],
  ]) {
    const first = fixture(a),
      second = fixture(b);
    await expectFailure(fake([option(first)], [first, first, second, first, second]));
  }
});

test('a moved target offers no proof despite a visible pixel delta', async () => {
  const before = fixture('moved-before'),
    after = fixture('moved-after');
  const f = fake([option(before), option(after, 1)], [before, after, after, after, after]);
  await expectFailure(f);
  assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
});

test('withheld, failed, missing and unsupported comparison shots offer no proof', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  for (const mode of ['withheld', 'failed', 'missing', 'unsupported', 'privacy']) {
    const f = fake(
      [option(before)],
      mode === 'unsupported' ? [Buffer.from('not a PNG')] : [before, after, after],
    );
    if (mode === 'withheld') f.deps.comparisonScreenshot = async () => undefined;
    if (mode === 'failed')
      f.deps.comparisonScreenshot = async () => {
        throw new Error('unavailable');
      };
    if (mode === 'missing') delete f.deps.comparisonScreenshot;
    if (mode === 'privacy') {
      f.deps.privacy = new ObservedPrivacy();
      f.deps.privacy.concealFallback('private', true);
    }
    await expectFailure(f);
    if (mode === 'privacy') assert.equal(f.calls.includes('pixel shot'), false);
  }
});

test('a retry keeps the first baseline when a toggle is undone', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  const f = fake([option(before)], [before, after, before, before, before]);
  await expectFailure(f);
  assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 5);
});

test('a later stable change can pass against the first baseline without another before-shot', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  const f = fake([option(before)], [before, before, before, after, after]);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome));
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 2);
  assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 5);
});

test('proven presses and changed screen signatures do not take after-shots', async () => {
  const before = fixture('toggle1-before');
  for (const proven of [true, false]) {
    const initial = option(before),
      after = option(before);
    if (!proven) after.visibleText.push('Changed');
    const f = fake([initial, after], [before], proven);
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome));
    assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
  }
});

test('ambiguous, unhittable, non-app and unscaled targets have no pixel proof', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  for (const change of [
    (s: Screen) => {
      s.pointScale = undefined;
    },
    (s: Screen) => {
      s.front = 'picker';
    },
    (s: Screen) => {
      s.elements[0].hittable = false;
    },
    (s: Screen) => {
      s.elements.push({ ...s.elements[0], ref: '@duplicate' });
    },
  ]) {
    const screen = option(before);
    change(screen);
    const f = fake([screen], [before, after, after]);
    const outcome = await walkBlock(tap, f.deps);
    assert.notEqual(outcome.block.outcome, 'pass');
    assert.equal(f.calls.includes('pixel shot'), false);
  }
});

test('runtime input runs withhold comparison shots', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  const f = fake([option(before)], [before, after, after]);
  await withInputs(new RunInputs({ TOKEN: 'fixture-secret-value' }, ['TOKEN']), () =>
    expectFailure(f),
  );
  assert.equal(f.calls.includes('pixel shot'), false);
});

test('after-capture scale must agree with the original baseline', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  for (const scale of [undefined, 2, NaN]) {
    const next = option(before);
    next.pointScale = scale;
    const f = fake([option(before), next], [before, after, after]);
    await expectFailure(f);
    assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
  }
});
