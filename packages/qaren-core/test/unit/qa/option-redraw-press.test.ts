import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodePng } from '../../../dist/qa/tap-pixels.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { elementFrame, join, screenSignature } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/tap-pixels/${name}.png`, import.meta.url));
const tap = parsePlan('1. Tap "option"\n').blocks![0];

function option(bytes: Uint8Array, moved = 0, covered = false): Screen {
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
  if (covered) nodes.push({ ref: '@keyboard', type: 'Keyboard', rect: nodes[0].rect });
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
  const initial = option(before);
  const f = fake(
    [initial, initial, initial, option(after, 1)],
    [before, after, after, after, after],
  );
  await expectFailure(f);
  assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
});

test('every comparison shot rejects target changes before and during acquisition', async (t) => {
  const before = fixture('moved-before'),
    after = fixture('moved-after');
  const changes: Record<string, (screen: Screen) => void> = {
    x: (s) => {
      elementFrame(s.elements[0])!.x += 1;
    },
    y: (s) => {
      elementFrame(s.elements[0])!.y += 1;
    },
    width: (s) => {
      elementFrame(s.elements[0])!.width += 1;
    },
    height: (s) => {
      elementFrame(s.elements[0])!.height += 1;
    },
    identity: (s) => {
      s.elements[0].testID = 'another-option';
    },
    duplicate: (s) => {
      s.elements.push({ ...s.elements[0], ref: '@duplicate' });
    },
    foreground: (s) => {
      s.front = 'picker';
    },
    hittable: (s) => {
      s.elements[0].hittable = false;
    },
    scale: (s) => {
      s.pointScale = 2;
    },
    occlusion: (s) => {
      Object.assign(s, option(before, 0, true));
      s.keyboardVisible = true;
    },
    coverage: (s) => {
      s.coverage = { native: 'incomplete', react: 'complete' };
    },
    acquisition: (s) => {
      s.captureCoverage = { native: 'incomplete', react: 'complete' };
    },
  };
  for (const [shot, captures] of [
    [2, 3],
    [5, 6],
    [7, 8],
  ].entries()) {
    for (const [edge, invalidAt] of captures.entries()) {
      for (const [name, change] of Object.entries(changes)) {
        await t.test(
          `${['baseline', 'first', 'second'][shot]} ${['before', 'during'][edge]} ${name}`,
          async () => {
            const f = fake([option(before)], []);
            let captures = 0;
            let shots = 0;
            let invalidated = false;
            f.deps.captureScreen = async () => {
              const screen = option(before);
              if (++captures === invalidAt) {
                change(screen);
                invalidated = true;
              }
              return screen;
            };
            f.deps.comparisonScreenshot = async () =>
              ++shots === 1 || invalidated ? before : after;
            const outcome = await walkBlock(tap, f.deps);
            assert.notEqual(outcome.block.outcome, 'pass', JSON.stringify(outcome));
            assert.equal(invalidated, true);
          },
        );
      }
    }
  }
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
    const f = fake([initial, initial, initial, after], [before], proven);
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

// The iOS runner reports no point scale, so it is derived from the app root's size in points.
function iosOption(bytes: Uint8Array, root = { width: 0, height: 0 }): Screen {
  const image = decodePng(bytes)!;
  const size = { width: image.width / 3, height: image.height / 3 };
  const nodes: NativeNode[] = [
    {
      ref: '@app',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: root.width || size.width, height: root.height || size.height },
    },
    {
      ref: '@option',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Option',
      identifier: 'option',
      hittable: true,
      rect: { x: 0, y: 0, ...size },
    },
  ];
  return { ...join(nodes, []), front: 'app', coverage: { native: 'complete', react: 'complete' } };
}

test('an iOS capture without a reported point scale derives it from the app root', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  assert.equal(iosOption(before).pointScale, undefined);
  const f = fake([iosOption(before)], [before, after, after]);
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome));
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

test('an app root that does not match the screenshot on both axes offers no proof', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  const image = decodePng(before)!;
  const skewed = { width: image.width / 3, height: image.height / 2 };
  await expectFailure(fake([iosOption(before, skewed)], [before, after, after, after, after]));
});

test('after-capture scale must agree with the original baseline', async () => {
  const before = fixture('toggle1-before'),
    after = fixture('toggle1-after');
  for (const scale of [undefined, 2, NaN]) {
    const next = option(before);
    next.pointScale = scale;
    const initial = option(before);
    const f = fake([initial, initial, initial, next], [before, after, after]);
    await expectFailure(f);
    assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
  }
});
