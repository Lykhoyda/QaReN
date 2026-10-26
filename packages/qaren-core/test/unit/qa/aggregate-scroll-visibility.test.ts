import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, type NativeNode } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { targetEvidence } from '../../../dist/qa/resolve.js';
import type { LabelProvenanceDiagnostic } from '../../../dist/qa/label-provenance.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested } from './platform-presence-fixtures.ts';

const target = { phrase: 'Add policy', quoted: 'Add policy' };
function nodes(count = 1): NativeNode[] {
  return [
    { ref: '@e0', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    { ref: '@e1', parentIndex: 0, type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 } },
    ...Array.from({ length: count }, (_, i) => ({
      ref: `@e${i + 2}`,
      parentIndex: 1,
      type: 'Other',
      label: 'Your policies, Add policy, Details',
      hittable: true,
      rect: { x: 20, y: 100 + i * 200, width: 360, height: 150 },
    })),
  ];
}
function screen(count = 1) {
  return join(nodes(count), [], 'app', { native: 'complete', react: 'complete' });
}

for (const afterScroll of [false, true]) {
  test(`quoted scroll confirms one aggregate container afterScroll=${afterScroll}`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('quoted visibility needs no model')),
    );
    let scrolled = false;
    const diagnostics: LabelProvenanceDiagnostic[] = [];
    f.deps.labelProvenanceDiagnostic = (event) => diagnostics.push(event);
    f.deps.readLabelProvenance = async () =>
      assert.fail('ordinary visibility needs no metadata read');
    f.deps.captureScreen = async (options) => {
      assert.notEqual(options?.platformPresence, true);
      return afterScroll && !scrolled ? screen(0) : screen();
    };
    f.deps.scroll = async (direction) => {
      scrolled = true;
      f.actions.push(`scroll ${direction}`);
      return { ok: true };
    };
    const result = await runPlan(parsePlan('1. Scroll down until "Add policy"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.deepEqual(f.actions, afterScroll ? ['scroll down'] : []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].resolvedBy, 'aggregate-visibility');
    assert.equal(diagnostics[0].requested, false);
    assert.doesNotMatch(JSON.stringify(diagnostics), /Add policy|Your policies|@e/);
  });
}

for (const contradiction of ['multiple', 'direct', 'value', 'none', 'unresolved'] as const) {
  test(`aggregate scroll refuses ${contradiction} evidence without mutation`, async () => {
    const s = screen(contradiction === 'multiple' ? 2 : 1);
    if (contradiction === 'unresolved') s.elements[2].visibilityEvidence = 'unresolved';
    else if (contradiction !== 'multiple')
      s.elements[2].semantic!.nativePresence = {
        kind: 'other',
        structural: false,
        labelSource: contradiction,
      };
    const f = walker(
      [s],
      scriptedJudge(() => assert.fail('quoted visibility needs no model')),
    );
    const result = await runPlan(parsePlan('1. Scroll down until "Add policy"').blocks!, f.deps);
    assert.notEqual(result.verdict, 'PASS');
    assert.match(JSON.stringify(result), /TARGET_AMBIGUOUS/);
    assert.deepEqual(f.actions, []);
  });
}

for (const source of [undefined, 'descendant', 'direct'] as const) {
  test(`aggregate scroll with an identified container carrying its card's label (${source})`, async () => {
    const [app, window, card] = nodes();
    const s = join(
      [
        app,
        window,
        {
          ref: '@scroll',
          parentIndex: 1,
          type: 'Other',
          identifier: 'home_scroll',
          label: card.label,
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        { ...card, parentIndex: 2 },
      ],
      [],
      'app',
      { native: 'complete', react: 'complete' },
    );
    if (source)
      s.elements[2].semantic!.nativePresence = {
        kind: 'other',
        structural: false,
        labelSource: source,
      };
    const f = walker(
      [s],
      scriptedJudge(() => assert.fail('quoted visibility needs no model')),
    );
    const diagnostics: LabelProvenanceDiagnostic[] = [];
    f.deps.labelProvenanceDiagnostic = (event) => diagnostics.push(event);
    const result = await runPlan(parsePlan('1. Scroll down until "Add policy"').blocks!, f.deps);
    assert.deepEqual(f.actions, []);
    if (source === 'direct') {
      assert.match(JSON.stringify(result), /TARGET_AMBIGUOUS: multiple on-screen containers/);
      return;
    }
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.equal(diagnostics[0]?.resolvedBy, 'aggregate-visibility');
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /Add policy|Your policies|home_scroll|@e|@scroll/,
    );
  });
}

function addressScreen(label = 'Name, Address, Phone') {
  return join(
    [
      ...nodes().slice(0, 2),
      {
        ref: '@row',
        parentIndex: 1,
        type: 'Other',
        label,
        hittable: true,
        rect: { x: 20, y: 100, width: 360, height: 150 },
      },
    ],
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
}

test('quoted wait confirms a whole component of one aggregate container', async () => {
  const s = addressScreen();
  assert.equal(targetEvidence({ phrase: 'Address', quoted: 'Address' }, s), 'fail');
  const f = walker(
    [s],
    scriptedJudge(() => assert.fail('quoted visibility needs no model')),
  );
  const diagnostics: LabelProvenanceDiagnostic[] = [];
  f.deps.labelProvenanceDiagnostic = (event) => diagnostics.push(event);
  const result = await runPlan(parsePlan('1. Wait for "Address"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.deepEqual(f.actions, []);
  assert.equal(diagnostics[0]?.resolvedBy, 'aggregate-visibility');
  assert.doesNotMatch(JSON.stringify(diagnostics), /Address|Phone|@row/);
});

for (const [quoted, why] of [
  ['dress', 'substring of a word'],
  ['Add', 'prefix of a word'],
  ['Address', 'secure container'],
  ['Address', 'value-derived label'],
] as const) {
  test(`quoted wait does not pass on an aggregate ${why}`, async () => {
    const s = addressScreen();
    if (why === 'secure container') s.elements[2].secure = true;
    if (why === 'value-derived label')
      s.elements[2].semantic!.nativePresence = {
        kind: 'other',
        structural: false,
        labelSource: 'value',
      };
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('quoted visibility needs no model')),
    );
    let now = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async () => {
      now += 5_000;
      return s;
    };
    const result = await runPlan(parsePlan(`1. Wait for "${quoted}"`).blocks!, f.deps);
    assert.notEqual(result.verdict, 'PASS', JSON.stringify(result));
    assert.deepEqual(f.actions, []);
  });
}

test('aggregate visibility does not broaden press resolution', async () => {
  const s = screen();
  assert.equal(targetEvidence(target, s), 'fail');
  const f = walker(
    [s],
    scriptedJudge(() => assert.fail('quoted target needs no model')),
  );
  f.deps.readLabelProvenance = async () => undefined;
  assert.notEqual(
    (await runPlan(parsePlan('1. Tap "Add policy"').blocks!, f.deps)).verdict,
    'PASS',
  );
  assert.deepEqual(f.actions, []);
});

for (const boundary of ['offscreen', 'incomplete', 'keyboard', 'expired'] as const) {
  test(`aggregate scroll retains ${boundary} boundary`, async () => {
    let s = screen();
    if (boundary === 'offscreen') s.elements[2].offscreen = true;
    if (boundary === 'incomplete') s.captureCoverage = { native: 'incomplete', react: 'complete' };
    if (boundary === 'keyboard') {
      s = join(
        [
          ...nodes(),
          { ref: '@keyboard', type: 'Keyboard', rect: { x: 0, y: 0, width: 400, height: 800 } },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
      s.keyboardVisible = true;
    }
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('expired evidence cannot be judged')),
    );
    let now = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async () => {
      if (boundary === 'expired') now += 40_000;
      return s;
    };
    const result = await runPlan(parsePlan('1. Scroll down until "Add policy"').blocks!, f.deps);
    assert.notEqual(result.verdict, 'PASS');
    assert.ok(f.actions.every((action) => action.startsWith('scroll ')));
  });
}

test('aggregate visibility preserves ordinary private admission and screenshot withholding', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted visibility needs no model')),
  );
  let screenshots = 0;
  f.deps.screenshot = async () => {
    screenshots++;
    return 'screen.png';
  };
  f.deps.captureScreen = (options) =>
    captureScreen({
      ...options,
      requirePrivateInputs: true,
      native: async () =>
        attested([
          ...nodes(),
          {
            ref: '@private',
            type: 'SecureTextField',
            label: 'Code',
            value: 'private-canary',
            secure: true,
            parentIndex: 1,
            rect: { x: 20, y: 600, width: 200, height: 40 },
          },
        ]),
      react: async () => ({ interactive: [] }),
    });
  const result = await runPlan(parsePlan('1. Scroll down until "Add policy"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(screenshots, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-canary/);
});
