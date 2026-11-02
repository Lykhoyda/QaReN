import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cropPng, decodePng, stablePixelChange } from '../../../dist/qa/tap-pixels.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { applicationFrame, elementFrame, join, screenSignature } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { applyNativePrivateInputs } from '../../../dist/qa/private-input.js';

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
      return screens[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      if (screens.length > 1) screens.shift();
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

for (const policy of [undefined, 'strict', 'non-strict'] as const) {
  for (const carrier of ['ordinary', 'test-pii', 'secret', 'secure'] as const) {
    test(`${policy ?? 'absent'} pixel-only toggles respect ${carrier} screenshot privacy`, async () => {
      const before = fixture('toggle1-before'),
        after = fixture('toggle1-after');
      const f = fake([option(before)], [before, after, after]);
      const privacy = new ObservedPrivacy();
      f.deps.privacy = privacy;
      f.deps.videoPolicy = policy;
      if (carrier === 'ordinary' || carrier === 'secure') {
        const nodes = [
          {
            ref: '@carrier',
            type: carrier === 'secure' ? 'SecureTextField' : 'Other',
            value: carrier === 'ordinary' ? 'synthetic-toggle-value' : undefined,
          },
        ];
        privacy.observe(applyNativePrivateInputs(join(nodes, []), nodes));
      }
      const inputs =
        carrier === 'test-pii' || carrier === 'secret'
          ? new RunInputs(
              { FIXTURE: 'synthetic-toggle-value' },
              ['FIXTURE'],
              privacy,
              carrier === 'test-pii' ? ['FIXTURE'] : [],
            )
          : undefined;
      const run = () => walkBlock(tap, f.deps, 0, [], privacy);
      const outcome = inputs ? await withInputs(inputs, run) : await run();
      const allowed = policy === 'non-strict' && (carrier === 'ordinary' || carrier === 'test-pii');
      assert.equal(outcome.block.outcome, allowed ? 'pass' : 'fail');
      assert.equal(f.calls.filter((call) => call === 'pixel shot').length, allowed ? 3 : 0);
    });
  }
}

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

for (const axis of ['x', 'y', 'width', 'height'] as const) {
  test(`an unchanged option with a changed ${axis} offers no stale-crop proof`, async () => {
    const before = fixture('moved-before');
    const after = fixture('moved-after');
    const initial = option(before);
    const next = option(after);
    elementFrame(next.elements[0])![axis] += 1;
    const frame = elementFrame(initial.elements[0])!;
    const originalCrop = cropPng(before, frame, 3)!;
    const staleCrop = cropPng(after, frame, 3)!;
    assert.equal(stablePixelChange(originalCrop, staleCrop, staleCrop), true);
    assert.equal(screenSignature(initial), screenSignature(next));
    const f = fake([initial, next], [before, after, after, after, after]);
    await expectFailure(f);
    assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
  });
}

for (const change of [
  'x',
  'y',
  'width',
  'height',
  'scale',
  'root-width',
  'root-height',
  'missing',
] as const) {
  test(`delayed ${change} changes after the post-tap tree offer no pixel proof`, async () => {
    const before = fixture('moved-before');
    const after = fixture('moved-after');
    const initial = change.startsWith('root-') ? iosOption(before) : option(before);
    const next = change.startsWith('root-') ? iosOption(after) : option(after);
    if (change === 'missing') next.elements = [];
    else if (change === 'scale') next.pointScale = 2;
    else if (change === 'root-width' || change === 'root-height')
      applicationFrame(next)![change === 'root-width' ? 'width' : 'height'] += 1;
    else elementFrame(next.elements[0])![change] += 1;
    if (change !== 'missing') assert.equal(screenSignature(initial), screenSignature(next));
    const frame = elementFrame(initial.elements.find((element) => element.testID === 'option')!)!;
    assert.equal(
      stablePixelChange(
        cropPng(before, frame, 3)!,
        cropPng(after, frame, 3)!,
        cropPng(after, frame, 3)!,
      ),
      true,
    );
    let live = initial;
    const f = fake([initial], [before, after, after, after, after]);
    f.deps.captureScreen = async () => live;
    const screenshot = f.deps.comparisonScreenshot!;
    f.deps.comparisonScreenshot = async () => {
      const bytes = await screenshot();
      if (f.calls.filter((call) => call === 'pixel shot').length === 2) live = next;
      return bytes;
    };
    const outcome = await walkBlock(tap, f.deps);
    assert.notEqual(outcome.block.outcome, 'pass', JSON.stringify(outcome));
    assert.equal(
      f.calls.filter((call) => call === 'pixel shot').length,
      2,
      'an invalid first after-shot stops further pixel capture',
    );
  });
}

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
    const f = fake([option(before), next], [before, after, after]);
    await expectFailure(f);
    assert.equal(f.calls.filter((call) => call === 'pixel shot').length, 1);
  }
});

test('delayed changes around every comparison shot withhold pixel proof', async () => {
  const before = fixture('toggle1-before');
  const after = fixture('toggle1-after');
  const changes: ((screen: Screen) => void)[] = [
    (screen) => {
      elementFrame(screen.elements[0])!.x += 1;
    },
    (screen) => {
      elementFrame(screen.elements[0])!.y += 1;
    },
    (screen) => {
      elementFrame(screen.elements[0])!.width += 1;
    },
    (screen) => {
      elementFrame(screen.elements[0])!.height += 1;
    },
    (screen) => {
      screen.pointScale = 2;
    },
    (screen) => {
      screen.elements[0].testID = 'replacement';
    },
    (screen) => {
      screen.elements[0].hittable = false;
    },
    (screen) => {
      screen.front = 'picker';
    },
    (screen) => {
      screen.elements.push({ ...screen.elements[0], ref: '@duplicate' });
    },
  ];
  for (const shot of [1, 2, 3]) {
    for (const phase of ['before', 'during']) {
      for (const change of changes) {
        const f = fake([option(before)], [before, after, after, after, after]);
        let captures = 0;
        let shots = 0;
        let changedDuringShot = false;
        const screenshot = f.deps.comparisonScreenshot!;
        f.deps.captureScreen = async () => {
          captures++;
          const screen = option(before);
          if ((phase === 'before' && captures === [0, 2, 5, 7][shot]) || changedDuringShot)
            change(screen);
          changedDuringShot = false;
          return screen;
        };
        f.deps.comparisonScreenshot = async () => {
          shots++;
          const bytes = await screenshot();
          if (phase === 'during' && shots === shot) changedDuringShot = true;
          return bytes;
        };
        const outcome = await walkBlock(tap, f.deps, 0, [], undefined, undefined, {
          singleAttempt: true,
        });
        assert.equal(outcome.block.outcome, 'fail', `${shot} ${phase}: ${JSON.stringify(outcome)}`);
        assert.equal(f.calls.filter((call) => call.startsWith('press')).length, shot === 1 ? 0 : 1);
      }
    }
  }
});

test('baseline recapture binds dispatch to the final native ref map', async () => {
  const before = fixture('toggle1-before');
  const after = fixture('toggle1-after');
  const f = fake([option(before)], [before, after, after]);
  let captures = 0;
  let currentRef = '';
  f.deps.captureScreen = async () => {
    const screen = option(before);
    currentRef = `@e${++captures}`;
    screen.elements[0].ref = currentRef;
    return screen;
  };
  f.deps.press = async (ref) => {
    assert.equal(ref, currentRef);
    assert.equal(ref, '@e3');
    f.calls.push(`press ${ref}`);
    return { ok: true, proven: false };
  };
  const outcome = await walkBlock(tap, f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome));
  assert.equal(f.calls.filter((call) => call.startsWith('press')).length, 1);
});

test('failed baseline recapture prevents dispatch even when comparison bytes are unavailable', async () => {
  const before = fixture('toggle1-before');
  for (const failedCapture of [2, 3]) {
    const f = fake([option(before)], [undefined]);
    let captures = 0;
    f.deps.captureScreen = async () => {
      if (++captures === failedCapture) throw new Error('capture failed');
      return option(before);
    };
    const outcome = await walkBlock(tap, f.deps);
    assert.equal(outcome.block.outcome, 'fail', JSON.stringify(outcome));
    assert.equal(
      f.calls.some((call) => call.startsWith('press')),
      false,
    );
  }
});
