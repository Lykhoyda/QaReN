import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { centreCovered, prepareTarget, targetEvidence } from '../../../dist/qa/resolve.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

// AI-489: the real join() inputs of the failing Android Fill on a one-time-code field whose real
// input is fully transparent (both geometries of the Test App fixture), captured on develop
// faa08604. Value-free: no input value, no host path.
type Capture = {
  inputs: {
    nodes: NativeNode[];
    digest: unknown[];
    front: Screen['front'];
    coverage: Screen['coverage'];
    reactHostEvidence: unknown;
    nativeAcquisition: NonNullable<Screen['coverage']>['native'];
  };
  keyboardFrame: NonNullable<Screen['keyboardFrame']>;
};
const VARIANTS = ['overlay', 'default'] as const;
const HIDDEN = 'otp-input-hidden';
const CODE = '7391';

const capture = (variant: (typeof VARIANTS)[number]): Capture =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/android-hidden-input/${variant}-join-input.json`, import.meta.url),
      'utf8',
    ),
  );

// The capture predates the runner's `focused` fact; [focused] marks the hidden input as focused,
// as the runner now reports it for this autofocused field.
function screenOf(
  variant: (typeof VARIANTS)[number],
  {
    focused = false,
    extra = [] as NativeNode[],
    presence = undefined as NativePresence | undefined,
  } = {},
): Screen {
  const { inputs, keyboardFrame } = capture(variant);
  const nodes = [
    ...inputs.nodes.map((n) => (focused && n.identifier === HIDDEN ? { ...n, focused: true } : n)),
    ...extra,
  ];
  const screen = join(
    nodes,
    inputs.digest as never,
    inputs.front,
    inputs.coverage,
    inputs.reactHostEvidence as never,
    presence,
    inputs.nativeAcquisition,
  );
  // captureScreen adds the raw acquisition verdict beside join(), as the capture recorded it.
  const captureCoverage = { native: inputs.nativeAcquisition, react: inputs.coverage!.react };
  return { ...screen, captureCoverage, keyboardVisible: true, keyboardFrame };
}

const hiddenOf = (screen: Screen) => {
  const matches = screen.elements.filter((e) => e.testID === HIDDEN);
  assert.equal(matches.length, 1, 'one native element carries the hidden input testID');
  return matches[0];
};

const fill = { kind: 'fill', target: { phrase: HIDDEN, quoted: HIDDEN }, text: CODE } as const;

test('T1: the captured transparent input is hidden in place and unfocused, its targeting facts unchanged', () => {
  for (const variant of VARIANTS) {
    const hidden = hiddenOf(screenOf(variant));
    assert.equal(hidden.hiddenInView, 'unfocused', variant);
    assert.equal(hidden.offscreen, true, variant);
    assert.equal(hidden.hittable, false, variant);
    assert.equal(hidden.visibilityEvidence, 'offscreen', variant);
    assert.equal(hidden.kind, 'input', variant);
  }
});

test('T2: the same input holding focus is hidden in place and focused', () => {
  for (const variant of VARIANTS)
    assert.equal(hiddenOf(screenOf(variant, { focused: true })).hiddenInView, 'focused', variant);
});

test('T3: scrolled-out, keyboard-covered, outside-viewport, clipped and visible nodes never gain the fact', () => {
  for (const variant of VARIANTS) {
    const { inputs, keyboardFrame } = capture(variant);
    const appWindow = inputs.nodes.findIndex((n) => n.type === 'Window');
    const base = inputs.nodes.length;
    const synthetic = (offset: number, node: Partial<NativeNode>): NativeNode => ({
      ref: `@s${offset}`,
      index: base + offset,
      depth: 2,
      parentIndex: appWindow,
      type: 'android.widget.EditText',
      visibleToUser: false,
      enabled: true,
      hittable: false,
      focused: true,
      ...node,
    });
    const extra = [
      synthetic(0, {
        identifier: 'covered-input',
        rect: { x: 40, y: keyboardFrame.y + 100, width: 400, height: 120 },
      }),
      synthetic(1, {
        identifier: 'beyond-input',
        rect: { x: 40, y: 3000, width: 400, height: 120 },
      }),
      synthetic(2, {
        identifier: 'clipped-input',
        rect: { x: 40, y: 1200, width: 400, height: 120 },
      }),
      synthetic(3, {
        type: 'Window',
        rect: keyboardFrame,
        visibleToUser: true,
        focused: undefined,
        parentIndex: 0,
        depth: 1,
      }),
      synthetic(4, {
        type: 'Keyboard',
        rect: keyboardFrame,
        visibleToUser: true,
        focused: undefined,
        parentIndex: base + 3,
      }),
    ];
    const presence: NativePresence = {
      source: 'android-a11y-live',
      nodes: [...inputs.nodes, ...extra].map((n) =>
        n.identifier === 'clipped-input'
          ? { status: 'unknown', labelSource: 'none', unknownReason: 'clipped' }
          : { status: 'observed', labelSource: 'none' },
      ),
    };
    for (const screen of [screenOf(variant, { extra }), screenOf(variant, { extra, presence })]) {
      const byId = (id: string) => screen.elements.find((e) => e.testID === id)!;
      for (const element of screen.elements) {
        const node = [...inputs.nodes, ...extra].find((n) => n.ref === element.ref);
        const emptyRect = !node?.rect || node.rect.width <= 0 || node.rect.height <= 0;
        if (node?.visibleToUser !== false || emptyRect)
          assert.equal(element.hiddenInView, undefined, `${variant} ${element.ref}`);
      }
      assert.equal(byId('covered-input').hiddenInView, undefined, variant);
      assert.equal(
        byId('covered-input').offscreen,
        false,
        'keyboard-covered stays covered, not offscreen',
      );
      assert.equal(byId('covered-input').hittable, true);
      assert.equal(byId('beyond-input').hiddenInView, undefined, variant);
      assert.equal(byId('beyond-input').offscreen, true);
    }
    const clipped = screenOf(variant, { extra, presence }).elements.find(
      (e) => e.testID === 'clipped-input',
    )!;
    assert.equal(clipped.hiddenInView, undefined, `${variant}: the presence pass calls it clipped`);
    assert.equal(clipped.offscreen, true);
  }
});

test('T4: a quoted Fill on the focused hidden input targets it with no scroll', () => {
  for (const variant of VARIANTS) {
    const screen = screenOf(variant, { focused: true });
    const result = prepareTarget(fill, screen);
    assert.ok('ref' in result, `${variant}: ${JSON.stringify(result)}`);
    assert.equal(result.ref, hiddenOf(screen).ref);
    assert.ok(!('scroll' in result));
  }
});

test('T5: a quoted Fill on the unfocused hidden input refuses at once with the real cause', () => {
  for (const variant of VARIANTS) {
    const result = prepareTarget(fill, screenOf(variant));
    assert.ok('refuse' in result, `${variant}: ${JSON.stringify(result)}`);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
    assert.match(result.reason, /not visible to the user/);
    assert.match(result.reason, /no scroll was tried/);
    assert.doesNotMatch(result.reason, /off screen/);
    assert.ok(!('missing' in result));
  }
});

test('T6: Press and Wait evidence on the hidden input keep today’s behaviour', () => {
  for (const variant of VARIANTS) {
    const screen = screenOf(variant, { focused: true });
    const press = prepareTarget(
      { kind: 'press', target: { phrase: HIDDEN, quoted: HIDDEN } },
      screen,
    );
    assert.ok('scroll' in press, `${variant}: ${JSON.stringify(press)}`);
    assert.equal(targetEvidence({ phrase: HIDDEN, quoted: HIDDEN, exact: 'id' }, screen), 'fail');
  }
});

test('T7: the keyboard does not cover the hidden input’s centre', () => {
  for (const variant of VARIANTS) {
    const screen = screenOf(variant, { focused: true });
    let branch: string | undefined;
    assert.equal(
      centreCovered(hiddenOf(screen), screen, (facts) => (branch = facts.branch)),
      false,
    );
    assert.equal(branch, 'none', variant);
  }
});

test('T8/T9: the walker fills the focused input without a swipe and refuses the unfocused one without one', async () => {
  for (const variant of VARIANTS) {
    for (const focused of [true, false]) {
      const screen = screenOf(variant, { focused });
      const f = walker(
        [screen],
        scriptedJudge(() => assert.fail('a quoted fill is model-free')),
      );
      const result = await runPlan(parsePlan(`1. Fill "${HIDDEN}" with "${CODE}"`).blocks!, f.deps);
      const label = `${variant} ${focused ? 'focused' : 'unfocused'}`;
      assert.ok(
        !f.actions.some((a) => a.startsWith('scroll')),
        `${label}: ${f.actions.join(', ')}`,
      );
      if (focused) {
        assert.deepEqual(f.actions, [`fill ${hiddenOf(screen).ref} ${CODE}`], label);
        assert.equal(result.verdict, 'PASS', `${label}: ${result.failure?.seen}`);
      } else {
        assert.deepEqual(f.actions, [], label);
        assert.equal(result.verdict, 'FAIL', label);
        assert.match(JSON.stringify(result.failure), /hidden in place/, label);
        // SECRET tier: the plan value appears in no reason, row or note.
        assert.doesNotMatch(JSON.stringify({ result, rows: f.rows }), new RegExp(CODE), label);
      }
    }
  }
});
