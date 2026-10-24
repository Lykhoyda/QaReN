import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../../dist/injected-helpers.js';
import { reactFocused } from '../../../dist/qa/walk.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import type { WalkSequence } from '../../../dist/qa/walker.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCaptureError } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block, Step } from '../../../dist/qa/plan.js';
import { join as joinScreen } from '../../../dist/qa/screen.js';
import type { Element, NativeNode, ReactHostObservation, Screen } from '../../../dist/qa/screen.js';
import { ObservedPrivacy, codeBoxRows } from '../../../dist/qa/privacy.js';
import { describe } from '../../../dist/qa/screen.js';
import { exactIdentities } from '../../../dist/qa/identity.js';
import { keyboardFallbackTarget, prepareTarget } from '../../../dist/qa/resolve.js';
import {
  KEYBOARD_READY_CAPTURES,
  loginBlock,
  runPlan,
  walkBlock,
} from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { readBlock, storedFits, storedMatches } from '../../../dist/qa/blocks.js';
import type { ActResult, BlockStore, WalkerDeps } from '../../../dist/qa/walker.js';
import type { Ledger, LedgerRow, WalkResult } from '../../../dist/qa/ledger.js';
import type { Questions } from '../../../dist/qa/questions.js';
import { element, scriptedJudge } from './judgment-fixtures.ts';

const WRAP = 'qa-hidden-email-pressable';
const EMAIL = 'qa@example.test';

const wrapper = (label = 'Email', extra: Partial<Element> = {}): Element =>
  element('@wrap', label, { kind: 'other', testID: WRAP, ...extra });
const submit = element('@submit', 'Submit', { testID: 'qa-hidden-submit' });

// The hidden field itself is observed only as a React host, as a real capture reports it.
const INNER = {
  testID: 'qa-hidden-email',
  role: null,
  roleSource: 'none',
  capabilities: { fill: true },
} as const;

function screenOf(
  elements: Element[],
  keyboardVisible?: boolean,
  hosts: ReactHostObservation[] = [INNER],
): Screen {
  return {
    front: 'app',
    elements,
    visibleText: elements.map((e) => e.label ?? ''),
    coverage: { native: 'complete', react: 'complete' },
    reactHostEvidence: { hosts, complete: true },
    ...(keyboardVisible === undefined ? {} : { keyboardVisible }),
  };
}

function blocks(markdown: string): Block[] {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks;
}

const plan = (
  value = EMAIL,
  target = 'qa-hidden-email',
  tail = '2. Tap "qa-hidden-submit"\n✓ "Form accepted"\n',
) => `## QA\n\n### Hidden email\n\n1. Fill "${target}" with "${value}"\n${tail}`;

interface AppOptions {
  initial?: Element[];
  initialKeyboard?: boolean | 'absent';
  // Screens returned after the tap, one per capture; the last one repeats.
  focused?: Screen[];
  typedLabel?: string;
  press?: ActResult;
  type?: ActResult;
  typeFocused?: false;
  expireBeforeType?: boolean;
  questions?: Questions[];
  reactFocused?: boolean | 'throw';
  hosts?: ReactHostObservation[];
  reactUnavailable?: boolean;
}

function app(options: AppOptions = {}) {
  let state: 'idle' | 'focused' | 'typed' | 'accepted' = 'idle';
  let focusedCaptures = 0;
  let time = 0;
  let expire = false;
  const log: string[] = [];
  const rows: LedgerRow[] = [];
  const diagnostics: unknown[] = [];
  const typed: { ref: string; text: string; testID?: string }[] = [];
  const focusRequirements: Array<boolean | undefined> = [];
  const focusReads: string[] = [];
  const notes: string[] = [];
  const questions = options.questions ?? [];
  const judge = scriptedJudge((q) => {
    questions.push(structuredClone(q));
    return Object.fromEntries(Object.keys(q).map((id) => [id, { type: 'noul', noul: 0.99 }]));
  });
  const initial = options.initial ?? [wrapper(), submit];
  const current = (): Screen => {
    const screen = observe();
    return options.reactUnavailable
      ? {
          ...screen,
          coverage: { native: 'complete', react: 'unknown' },
          reactHostEvidence: undefined,
        }
      : screen;
  };
  const observe = (): Screen => {
    if (state === 'idle')
      return screenOf(
        initial,
        options.initialKeyboard === 'absent' ? undefined : (options.initialKeyboard ?? false),
        options.hosts,
      );
    if (state === 'focused') {
      const screens = options.focused ?? [screenOf(initial, true, options.hosts)];
      const next = screens[Math.min(focusedCaptures++, screens.length - 1)];
      if (options.expireBeforeType && next.keyboardVisible) expire = true;
      return next;
    }
    if (state === 'typed')
      return screenOf(
        options.typedLabel === undefined ? initial : [wrapper(options.typedLabel), submit],
        true,
      );
    return screenOf([element('@accepted', 'Form accepted', { kind: 'text' })], false);
  };
  const deps: WalkerDeps = {
    judge,
    async captureScreen() {
      log.push('capture');
      return current();
    },
    async press(ref, context) {
      context.authorize();
      log.push(`press ${ref}`);
      if (ref === '@wrap' && state === 'idle') state = 'focused';
      if (ref === '@submit') state = 'accepted';
      return options.press ?? { ok: true, proven: false };
    },
    async fill(ref, text, context) {
      context.authorize();
      log.push(`fill ${ref}`);
      typed.push({ ref, text });
      state = 'typed';
      return { ok: true, proven: true };
    },
    ...(options.typeFocused === false
      ? {}
      : {
          async typeFocused(
            ref: string,
            text: string,
            testID: string | undefined,
            context,
            requireFocused?: boolean,
          ) {
            context.authorize();
            focusRequirements.push(requireFocused);
            log.push(`type ${ref}`);
            typed.push({ ref, text, ...(testID ? { testID } : {}) });
            state = 'typed';
            return options.type ?? { ok: true, proven: false };
          },
        }),
    ...(options.reactFocused === undefined
      ? {}
      : {
          async reactFocused(testID: string) {
            focusReads.push(testID);
            if (options.reactFocused === 'throw') throw new Error('PRIVATE-read-failure');
            return options.reactFocused === true;
          },
        }),
    note: (line: string) => {
      notes.push(line);
    },
    async scroll(direction) {
      log.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    },
    async back() {
      log.push('back');
      return { ok: true, proven: false };
    },
    async dialog(action) {
      log.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      log.push(`shot ${name}`);
      return name;
    },
    now: () => time,
    async sleep(ms) {
      time += ms;
    },
    row: (row) => {
      rows.push(structuredClone(row));
    },
    diagnostic: (event) => {
      diagnostics.push(event);
    },
    timing: (event) => {
      if (expire && event.stage === 'capture' && event.edge === 'end') {
        expire = false;
        time += 60_000;
      }
    },
  };
  return {
    deps,
    log,
    rows,
    typed,
    diagnostics,
    questions,
    focusReads,
    focusRequirements,
    notes,
    state: () => state,
  };
}

const steps = (log: string[]) => log.filter((entry) => entry !== 'capture');

const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(strings)
      : [];

function wrappedInput(
  label: string,
  unrelated = false,
  ancestry = true,
  input: ReactHostObservation = INNER,
  wrapperID = WRAP,
): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: '@wrap',
      type: 'Other',
      identifier: wrapperID,
      label,
      parentIndex: 1,
      hittable: true,
      rect: { x: 20, y: 100, width: 360, height: 50 },
    },
  ];
  if (unrelated)
    nodes.push({
      ref: '@other',
      type: 'Button',
      identifier: 'unrelated',
      label,
      parentIndex: 1,
      hittable: true,
      rect: { x: 20, y: 200, width: 360, height: 50 },
    });
  return {
    ...joinScreen(
      nodes,
      [
        { role: 'button', testID: wrapperID, capabilities: { press: true, fill: false } },
        {
          role: 'textinput',
          testID: input.testID,
          placeholder: label,
          inputHostIndices: [1],
          capabilities: { fill: true, press: false },
        },
      ],
      'app',
      { native: 'complete', react: 'complete' },
      {
        complete: true,
        hosts: [
          { testID: wrapperID, role: 'button', roleSource: 'role', capabilities: { press: true } },
          input,
        ],
        typography: {
          version: 1,
          complete: true,
          durationMs: 1,
          coordinateSpace: 'window-points',
          nodes: [
            {
              hostIndex: 0,
              parentHostIndex: null,
              rootIndex: 0,
              hostType: 'RCTView',
              text: { kind: 'none' },
            },
            {
              hostIndex: 1,
              parentHostIndex: ancestry ? 0 : null,
              rootIndex: ancestry ? 0 : 1,
              hostType: 'RCTSinglelineTextInputView',
              text: { kind: 'none' },
            },
          ],
        },
      },
    ),
    keyboardVisible: false,
  };
}

for (const label of [INNER.testID, 'Email address']) {
  test(`a wrapper labelled with the input identity or placeholder ${label} permits keyboard fallback`, async () => {
    const captured = wrappedInput(label);
    const step: Step = { kind: 'fill', target: { phrase: label, quoted: label }, text: EMAIL };
    const fallback = keyboardFallbackTarget(step, captured);
    assert.equal(fallback?.element.ref, '@wrap');
    assert.equal(fallback?.oracleTestID, INNER.testID);
    const fake = app({
      initial: captured.elements,
      focused: [{ ...captured, keyboardVisible: true }],
    });
    const capture = fake.deps.captureScreen;
    fake.deps.captureScreen = async (options) =>
      fake.state() === 'idle' ? captured : capture(options);
    const outcome = await walkBlock(blocks(plan(EMAIL, label, ''))[0], fake.deps);
    assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
    assert.deepEqual(fake.typed, [{ ref: '@wrap', text: EMAIL, testID: INNER.testID }]);
    assert.deepEqual(
      steps(fake.log).filter((line) => !line.startsWith('shot')),
      ['press @wrap', 'type @wrap'],
    );
    const twin = wrappedInput(label, true);
    assert.equal(keyboardFallbackTarget(step, twin), undefined);
    assert.ok(exactIdentities(twin, step.target, 'press').length > 1);
    if (label === INNER.testID)
      assert.equal(keyboardFallbackTarget(step, wrappedInput(label, false, false)), undefined);
  });
}

test('a placeholder-labelled wrapper with its own identifier binds the React-only input', async () => {
  const input = { ...INNER, testID: 'email' };
  const captured = wrappedInput('Email address', false, true, input, 'email-wrap');
  const step: Step = { kind: 'fill', target: { phrase: 'email', quoted: 'email' }, text: EMAIL };
  assert.equal(keyboardFallbackTarget(step, captured)?.element.ref, '@wrap');
  const fake = app({
    initial: captured.elements,
    focused: [{ ...captured, keyboardVisible: true }],
    hosts: [input],
  });
  const capture = fake.deps.captureScreen;
  fake.deps.captureScreen = async (options) =>
    fake.state() === 'idle' ? captured : capture(options);
  const outcome = await walkBlock(blocks(plan(EMAIL, 'email', ''))[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(fake.typed, [{ ref: '@wrap', text: EMAIL, testID: 'email' }]);
  assert.equal(
    keyboardFallbackTarget(
      { ...step, target: { phrase: 'Email address', quoted: 'Email address' } },
      wrappedInput('Email address', true, true, input, 'email-wrap'),
    ),
    undefined,
  );
});

for (const code of ['9', '93', '938', '999', '9386', '9966']) {
  test(`nested code boxes and merged labels stay private after fallback fill ${code}`, async () => {
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: '@code',
        type: 'Other',
        identifier: 'qa-otp-code-field',
        label: [...code].join(', '),
        parentIndex: 0,
        rect: { x: 20, y: 100, width: 200, height: 42 },
      },
    ];
    for (const [i, label] of [...code.padEnd(4, ' ')].map((char) => char.trim()).entries()) {
      const parentIndex = nodes.length;
      nodes.push(
        {
          ref: `@box${i}`,
          type: 'StaticText',
          identifier: `qa-otp-box-${i}`,
          label,
          parentIndex: 1,
          rect: { x: 20 + i * 48, y: 100, width: 42, height: 42 },
        },
        {
          ref: `@echo${i}`,
          type: 'StaticText',
          label,
          parentIndex,
          rect: { x: 30 + i * 48, y: 110, width: 20, height: 20 },
        },
      );
    }
    const captured = screenOf(
      [
        ...joinScreen(nodes, []).elements,
        element('@heading', 'Enter code', { kind: 'text' }),
        element('@verify', 'Verify'),
      ],
      true,
    );
    captured.visibleText = captured.visibleText.filter(Boolean);
    assert.deepEqual(
      codeBoxRows(captured).map((row) => row.map((box) => box.ref)),
      [['@box0', '@box1', '@box2', '@box3']],
    );
    const privacy = new ObservedPrivacy([code]);
    privacy.didFill();
    privacy.observe(captured);
    assert.deepEqual(privacy.screenText(captured), ['[code]', 'Enter code', 'Verify']);
    const mask = privacy.maskForModel([code], []);
    for (const node of captured.elements.filter(
      (node) => node.ref === '@code' || node.ref.startsWith('@box') || node.ref.startsWith('@echo'),
    ))
      assert.equal(mask.describeElement(node, describe), 'box (hidden)');
    for (const separator of [', ', ' | ', ' / ', '---', '\u2009']) {
      const text = [...code].join(separator);
      if (code.length >= 3) {
        assert.equal(privacy.redact(text), '•••');
        assert.equal(mask.apply(text).includes(text), false);
      }
    }
    const fake = app();
    const capture = fake.deps.captureScreen;
    fake.deps.captureScreen = async (options) =>
      fake.state() === 'typed' ? captured : capture(options);
    const ledger = await runPlan(
      blocks(plan(code, INNER.testID, '✓ The Verify button is visible\n✓ "Missing"\n')),
      fake.deps,
    );
    assert.equal(ledger.verdict, 'FAIL');
    assert.match(
      renderReason(ledger.failure?.seen ?? '', (text) => text),
      /\[code\]/,
    );
    assert.equal(
      ledger.steps.some((row) => row.reason?.startsWith('UNVERIFIED_FILL:')),
      true,
    );
    const surfaces = strings({
      ledger,
      rows: fake.rows,
      questions: fake.questions,
      diagnostics: fake.diagnostics,
      notes: fake.notes,
    });
    assert.ok(fake.questions.length > 0, JSON.stringify(ledger.failure));
    for (const text of surfaces) {
      assert.equal(text.replace(/[\s\p{P}\p{S}]/gu, '').includes(code), false);
      assert.equal([...code].includes(text.trim()), false);
      assert.equal(/[|]\s*[9386]\s*[|]/u.test(text), false);
    }
  });
}

test('U8: a field the snapshot cannot see is tapped, typed once, marked unverified, and the walk continues', async () => {
  const fake = app();
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap', 'press @submit']);
  assert.deepEqual(fake.typed, [{ ref: '@wrap', text: EMAIL, testID: 'qa-hidden-email' }]);
  const fill = outcome.rows[0];
  assert.equal(fill.outcome, 'pass');
  assert.equal(fill.screenshot, undefined);
  assert.deepEqual(fill.selector, { id: 'qa-hidden-email' });
  assert.equal(
    fill.reason,
    'UNVERIFIED_FILL: typed with the keyboard after tapping "qa-hidden-email"; the field is not an observable native input, so its final value was not validated',
  );
  assert.deepEqual(outcome.privateFills, [fill.line]);
  assert.deepEqual(
    fake.rows.map((r) => [r.line, r.outcome]),
    [
      [fill.line, 'pass'],
      [fill.line + 1, 'pass'],
      [fill.line + 2, 'pass'],
    ],
  );
  assert.ok(
    !fake.log.some((entry) => entry.startsWith('shot')),
    'pixels withheld from the fill on',
  );
});

test('U8: a later failing check still fails the block after an unverified fill', async () => {
  const fake = app();
  const outcome = await walkBlock(
    blocks(plan(EMAIL, 'qa-hidden-email', '2. Tap "qa-hidden-submit"\n✓ "Welcome home"\n'))[0],
    fake.deps,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.failure?.step, fake.rows.at(-1)?.line);
  assert.equal(fake.typed.length, 1);
  assert.equal(outcome.failure?.screenshot, undefined);
});

test('a phrase check after a qa-otp fallback fill sends no protected digit boxes', async () => {
  const fake = app({
    initial: [wrapper('Code', { testID: 'qa-otp-pressable' })],
    hosts: [{ ...INNER, testID: 'qa-otp' }],
  });
  const capture = fake.deps.captureScreen;
  fake.deps.captureScreen = async () =>
    fake.state() === 'typed'
      ? screenOf(
          [
            element('@heading', 'Enter the code', { kind: 'text' }),
            ...joinScreen(
              ['1', '2', '3', '4'].map((label, i) => ({
                ref: `@digit${i}`,
                type: 'StaticText',
                label,
                rect: { x: i * 48, y: 100, width: 32, height: 40 },
              })),
              [],
            ).elements,
            element('@verify', 'Verify'),
          ],
          true,
        )
      : capture();
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.99 }])),
  );
  fake.deps.judge = judge;
  const outcome = await walkBlock(
    blocks(plan('1234', 'qa-otp', '✓ The Verify button is visible\n'))[0],
    fake.deps,
  );
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(fake.typed, [{ ref: '@wrap', text: '1234', testID: 'qa-otp' }]);
  assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap']);
  assert.equal(judge.requests.length, 1);
  const request = JSON.stringify(judge.requests[0]);
  assert.equal(/[1-4]/.test(request), false, request);
  assert.ok(request.includes('Enter the code'));
  assert.ok(request.includes('Verify'));
});

test('U8: the block of an unverified fill is never saved and video stays withheld', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
  mkdirSync(join(dir, '.qaren'));
  const store: BlockStore = { appRoot: dir, platform: 'ios', appId: 'com.example.app' };
  const fake = app();
  const result = (await runPlan(blocks(plan()), fake.deps, [], store)) as Ledger;
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.deepEqual(result.blocks, [
    {
      key: 'hidden-email',
      outcome: 'pass',
      source: 'discovered',
      saved: false,
      unsavable: `line ${fake.rows[0].line}: fills a private input`,
    },
  ]);
  assert.deepEqual(result.blocksWritten, []);
  assert.deepEqual(result.recipe, {
    unsavable: `line ${fake.rows[0].line}: fills a private input`,
  });
  assert.equal(result.videoPublication, 'withheld-fill');
  assert.equal(existsSync(join(dir, '.qaren', 'actions', 'hidden-email.yaml')), false);
});

test('U14: without the focused-typing dep the strict refusal is unchanged', async () => {
  const fake = app({ typeFocused: false });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /^TARGET_NOT_FOUND: /,
  );
  assert.deepEqual(
    steps(fake.log).filter((s) => !s.startsWith('shot')),
    [],
  );
  assert.equal(outcome.privateFills, undefined);
});

for (const keyboard of [true, 'absent'] as const) {
  test(`U4: keyboard ${keyboard === true ? 'already up' : 'state absent'} fails before any tap`, async () => {
    const fake = app({ initialKeyboard: keyboard });
    const outcome = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      keyboard === true
        ? /^the keyboard is already up before tapping "qa-hidden-email"; nothing was typed/
        : /^the keyboard state before tapping "qa-hidden-email" is unknown; nothing was typed/,
    );
    assert.deepEqual(steps(fake.log), []);
    assert.equal(fake.rows.length, 1);
  });
}

test('U5: keyboard state comes from the decision observation; nothing is captured before the tap', async () => {
  const fake = app();
  await walkBlock(blocks(plan())[0], fake.deps);
  assert.deepEqual(fake.log.slice(0, 3), ['capture', 'press @wrap', 'capture']);
});

test('U6: an input that appears after the tap takes the strict verified fill path', async () => {
  const input = element('@input', 'Email', {
    kind: 'input',
    nativeKind: 'input',
    testID: 'qa-hidden-email',
  });
  const fake = app({ focused: [screenOf([wrapper(), input, submit], true)] });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(steps(fake.log), ['press @wrap', 'fill @input', 'press @submit']);
  assert.equal(outcome.rows[0].reason, undefined);
  assert.equal(outcome.rows[0].ref, '@input');
  assert.deepEqual(outcome.rows[0].selector, { id: 'qa-hidden-email' });
});

for (const [name, after, reason] of [
  [
    'target gone',
    screenOf([submit], true),
    /the tap on "qa-hidden-email" changed the screen; nothing was typed/,
  ],
  [
    'target duplicated',
    screenOf(
      [wrapper(), element('@wrap2', 'Email', { kind: 'other', testID: WRAP }), submit],
      true,
    ),
    /^TARGET_AMBIGUOUS:/,
  ],
  [
    'no keyboard',
    screenOf([wrapper(), submit], false),
    /tapping "qa-hidden-email" raised no keyboard; nothing was typed/,
  ],
] as const) {
  test(`U7: ${name} after the tap fails without typing or tapping again`, async () => {
    const fake = app({ focused: [after] });
    const outcome = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      reason,
    );
    assert.deepEqual(steps(fake.log), ['press @wrap']);
    assert.equal(fake.typed.length, 0);
    assert.equal(
      fake.log.filter((entry) => entry === 'capture').length,
      name === 'no keyboard' ? 1 + 2 * KEYBOARD_READY_CAPTURES : 3,
    );
  });
}

test('U7: a target replaced by another identity after the tap fails without typing', async () => {
  const other = element('@other', 'qa-hidden-email', { kind: 'other', testID: 'something-else' });
  const fake = app({ focused: [screenOf([other, submit], true)] });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the tap on "qa-hidden-email" changed the screen/,
  );
  assert.deepEqual(steps(fake.log), ['press @wrap']);
});

test('U11: expired post-focus evidence never taps again', async () => {
  const input = element('@input', 'Email', {
    kind: 'input',
    nativeKind: 'input',
    testID: 'qa-hidden-email',
  });
  const fake = app({
    expireBeforeType: true,
    focused: [screenOf([wrapper(), input, submit], true), screenOf([wrapper(), submit], false)],
  });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /^TARGET_NOT_FOUND:/,
  );
  assert.deepEqual(steps(fake.log), ['press @wrap']);
  assert.equal(fake.typed.length, 0);
});

test('U7: a keyboard that rises on the third capture is accepted', async () => {
  const fake = app({
    focused: [
      screenOf([wrapper(), submit], false),
      screenOf([wrapper(), submit], false),
      screenOf([wrapper(), submit], true),
    ],
  });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.equal(fake.typed.length, 1);
});

for (const type of [
  {
    ok: false,
    proven: false,
    error: 'NO_TEXT_INPUT_TARGET: the intended input is not focused; no text was entered.',
  },
  {
    ok: false,
    proven: false,
    error: 'TEXT_ENTRY_UNVERIFIED: typed into the focused field but its React value differs',
  },
] as const) {
  test(`U10/U11: a failed focused type (${type.error.split(':')[0]}) fails once and is never retried`, async () => {
    const fake = app({ type });
    const outcome = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap']);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /was not retried/,
    );
    assert.deepEqual(outcome.privateFills, [fake.rows[0].line]);
  });
}

test('U8v: a fallback fill whose read-back matched passes without the unverified reason', async () => {
  const fake = app({ type: { ok: true, proven: true } });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap', 'press @submit']);
  assert.equal(outcome.rows[0].outcome, 'pass');
  assert.equal(outcome.rows[0].reason, undefined);
  assert.deepEqual(outcome.privateFills, [outcome.rows[0].line]);
});

test('U8k: a fill kept short on both attempts carries its counts as numbers that masking cannot touch', async () => {
  const value = '4915123456789';
  const fake = app({ type: { ok: true, proven: false, kept: { typed: 13, observed: [10, 10] } } });
  const outcome = await walkBlock(blocks(plan(value))[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  const row = outcome.rows[0];
  assert.match(
    row.reason ?? '',
    /^UNVERIFIED_FILL: .*; the field kept the same shorter value on every attempt$/,
  );
  assert.deepEqual(row.kept, { typed: 13, observed: [10, 10] });
  const durable = JSON.stringify(outcome.rows);
  assert.doesNotMatch(durable, /4915|1234|56789/);
});

test('U11: a failed tap fails without typing', async () => {
  const fake = app({ press: { ok: false, proven: false, error: 'TAP_FAILED: no' } });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(fake.typed.length, 0);
  assert.deepEqual(steps(fake.log), ['press @wrap']);
});

test('U11: evidence that expires before the type fails without typing or tapping again', async () => {
  const fake = app({ expireBeforeType: true });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /^EVIDENCE_EXPIRED/,
  );
  assert.deepEqual(steps(fake.log), ['press @wrap']);
  assert.equal(fake.typed.length, 0);
});

for (const value of ['SECRET-MARKER-123', '12']) {
  test(`U12: the typed value ${value} reaches no row, reason, failure, question or diagnostic`, async () => {
    const fake = app({ typedLabel: `Code A${value}B` });
    const outcome = await walkBlock(
      blocks(
        plan(
          value,
          'qa-hidden-email',
          '✓ the code is shown\n2. Tap "qa-hidden-submit"\n✓ "Welcome home"\n',
        ),
      )[0],
      fake.deps,
    );
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(fake.typed[0].text, value);
    assert.ok(fake.questions.length > 0, 'Jev saw the screen after typing');
    const surfaces = strings({
      rows: fake.rows,
      outcome,
      questions: fake.questions,
      diagnostics: fake.diagnostics,
    });
    assert.deepEqual(
      surfaces.filter((text) => text.includes(value)),
      [],
    );
  });
}

test('U12: short free-text echoes remain readable while quoted fill slots stay masked', async () => {
  const fake = app({ typedLabel: 'Code A12B' });
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    blocks(plan('12', 'qa-hidden-email', '2. Tap "qa-hidden-email-pressable"\n'))[0],
    fake.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /Code A12B/,
  );
  assert.ok(outcome.rows[0].text.includes('“•••”') || outcome.rows[0].text.includes('"•••"'));
  assert.equal(
    strings(fake.rows).some((text) => text.includes('12')),
    false,
  );
});

test('U13: an earlier block is not written with a value a later fallback made private', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
  mkdirSync(join(dir, '.qaren'));
  const store: BlockStore = { appRoot: dir, platform: 'ios', appId: 'com.example.app' };
  const fake = app({
    initial: [wrapper(), submit, element('@code', `Code ${EMAIL}`, { kind: 'text' })],
  });
  const markdown = `## QA\n\n### Code shown\n\n✓ "${EMAIL}"\n\n### Hidden email\n\n1. Fill "qa-hidden-email" with "${EMAIL}"\n`;
  const result = (await runPlan(blocks(markdown), fake.deps, [], store)) as Ledger;
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.deepEqual(result.blocks[0], {
    key: 'code-shown',
    outcome: 'pass',
    source: 'discovered',
    saved: false,
    unsavable: 'contains a protected plan-typed value',
  });
  assert.equal(result.blocks[1].saved, false);
  assert.deepEqual(result.blocksWritten, []);
  assert.equal(existsSync(join(dir, '.qaren', 'actions', 'code-shown.yaml')), false);
});

test('a later private fill preserves unrelated fragment titles and their canonical files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
  mkdirSync(join(dir, '.qaren'));
  const fake = app({ initial: [wrapper(), submit, element('@hello', 'Hello', { kind: 'text' })] });
  const parsed = blocks(
    '## QA\n\n### secr\n✓ "Hello"\n\n### Hidden email\n1. Fill "qa-hidden-email" with "existing-secret"\n',
  );
  const result = await runPlan(parsed, fake.deps, [], {
    appRoot: dir,
    platform: 'ios',
    appId: 'com.example.app',
  });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(result.blocks[0].key, 'secr');
  assert.equal(result.blocks[0].saved, undefined);
  assert.equal(result.steps[0].block, 'secr');
  assert.equal(fake.rows[0].block, '');
  assert.deepEqual(result.blocksWritten, ['secr']);
  assert.equal(existsSync(join(dir, '.qaren', 'actions', 'secr.yaml')), true);
  assert.equal(JSON.stringify(result).includes('existing-secret'), false);
  assert.equal(parsed[0].slug, 'secr');
});

for (const suffix of ['', '2. Tap "missing"\n']) {
  test(`private PIN block identifiers are masked on ${suffix ? 'failure' : 'success'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
    mkdirSync(join(dir, '.qaren'));
    const fake = app();
    const parsed = blocks(
      `## QA\n\n### PIN 1234\n1. Fill "qa-hidden-email" with "1234"\n${suffix}`,
    );
    const result = await runPlan(parsed, fake.deps, [], {
      appRoot: dir,
      platform: 'ios',
      appId: 'com.example.app',
    });
    assert.equal(result.verdict, suffix ? 'FAIL' : 'PASS');
    assert.equal(JSON.stringify({ result, streamed: fake.rows }).includes('1234'), false);
    assert.deepEqual(result.blocksWritten, []);
    assert.equal(existsSync(join(dir, '.qaren', 'actions', 'pin-1234.yaml')), false);
    assert.equal(parsed[0].slug, 'pin-1234');
  });
}

test('preclassified private titles are withheld before dispatch without rewriting operational slugs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
  mkdirSync(join(dir, '.qaren'));
  const fake = app({ initial: [element('@hello', 'Hello', { kind: 'text' })] });
  const parsed = blocks(
    '## QA\n\n### alice\n✓ "Hello"\n\n### Later\n1. Fill "missing" with "alice"\n',
  );
  const result = await runPlan(parsed, fake.deps, [], {
    appRoot: dir,
    platform: 'ios',
    appId: 'com.example.app',
  });
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(fake.typed, []);
  assert.deepEqual(result.blocksWritten, []);
  assert.equal(result.blocks[0].key, '•••');
  assert.equal(result.blocks[0].saved, false);
  assert.equal(parsed[0].slug, 'alice');
  assert.equal(existsSync(join(dir, '.qaren', 'actions', 'alice.yaml')), false);
});

test('U13: deferred writes preserve ordinary blocks and withhold the planned fill block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
  mkdirSync(join(dir, '.qaren'));
  const store: BlockStore = { appRoot: dir, platform: 'ios', appId: 'com.example.app' };
  const input = element('@name', 'Name', { kind: 'input', nativeKind: 'input', testID: 'name' });
  const fake = app({ initial: [input, submit, element('@hello', 'Hello', { kind: 'text' })] });
  const markdown =
    '## QA\n\n### First\n\n✓ "Hello"\n\n### Second\n\n1. Type "Ada" into "name"\n\n### Third\n\n✓ "Hello"\n';
  const result = (await runPlan(blocks(markdown), fake.deps, [], store)) as WalkResult;
  assert.notEqual(result.verdict, 'REFUSED');
  const ledger = result as Ledger;
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
  assert.deepEqual(ledger.blocks, [
    { key: 'first', outcome: 'pass', source: 'discovered' },
    {
      key: 'second',
      outcome: 'pass',
      source: 'discovered',
      saved: false,
      unsavable: 'contains a protected plan-typed value',
    },
    { key: 'third', outcome: 'pass', source: 'discovered' },
  ]);
  assert.deepEqual(ledger.blocksWritten, ['first', 'third']);
  assert.equal(existsSync(join(dir, '.qaren', 'actions', 'second.yaml')), false);
  for (const slug of ledger.blocksWritten ?? [])
    assert.equal(
      readFileSync(join(dir, '.qaren', 'actions', `${slug}.yaml`), 'utf8').includes('Ada'),
      false,
    );
});

const fill = (target: string, extra: Partial<Step & { kind: 'fill' }> = {}): Step =>
  ({ kind: 'fill', target: { quoted: target, phrase: target }, text: 'v', ...extra }) as Step;

test('U1: phrase and text-stored replay fills never fall back; an id-stored fill does', () => {
  const s = screenOf([wrapper(), submit], false);
  assert.equal(
    keyboardFallbackTarget({ kind: 'fill', target: { phrase: 'email' }, text: 'v' }, s),
    undefined,
  );
  assert.equal(
    keyboardFallbackTarget(
      { kind: 'fill', target: { quoted: WRAP, phrase: WRAP, exact: 'text' }, text: 'v' },
      s,
    ),
    undefined,
  );
  const stored = keyboardFallbackTarget(
    { kind: 'fill', target: { quoted: WRAP, phrase: WRAP, exact: 'id' }, text: 'v' },
    s,
  );
  assert.equal(stored?.element.ref, '@wrap');
  assert.equal(stored?.oracleTestID, 'qa-hidden-email');
  assert.equal(
    keyboardFallbackTarget({ kind: 'press', target: { quoted: WRAP, phrase: WRAP } }, s),
    undefined,
  );
});

test('U1: non-qualifying refusals keep the strict refusal with no tap or type', async () => {
  const ambiguous = app({
    initial: [
      element('@a', 'Email', { kind: 'input', nativeKind: 'input', testID: 'qa-hidden-email' }),
      element('@b', 'Email', { kind: 'input', nativeKind: 'input', testID: 'qa-hidden-email' }),
    ],
  });
  const a = await walkBlock(blocks(plan())[0], ambiguous.deps);
  assert.match(
    renderReason(a.failure?.seen ?? '', (text) => text),
    /^TARGET_AMBIGUOUS: /,
  );
  assert.equal(ambiguous.typed.length, 0);
  const incomplete = app();
  const capture = incomplete.deps.captureScreen;
  incomplete.deps.captureScreen = async (o) => ({
    ...(await capture(o)),
    coverage: { native: 'incomplete', react: 'complete' },
  });
  const i = await walkBlock(blocks(plan())[0], incomplete.deps);
  assert.match(
    renderReason(i.failure?.seen ?? '', (text) => text),
    /^SCREEN_EVIDENCE_INCOMPLETE: /,
  );
  const process = app();
  process.deps.appProcess = {};
  const p = await walkBlock(blocks(plan())[0], process.deps);
  assert.match(
    renderReason(p.failure?.seen ?? '', (text) => text),
    /^APP_PROCESS_UNKNOWN: /,
  );
  for (const fake of [ambiguous, incomplete, process])
    assert.deepEqual(
      steps(fake.log).filter((s) => !s.startsWith('shot')),
      [],
    );
});

for (const [name, observable] of [
  [
    'the quoted id',
    element('@i', 'Other', { kind: 'input', nativeKind: 'input', testID: 'qa-hidden-email' }),
  ],
  [
    'the wrapper base',
    element('@i', 'Other', {
      kind: 'input',
      nativeKind: 'input',
      testID: 'qa-hidden-email',
      disabled: true,
    }),
  ],
  [
    'quoted-pressable',
    element('@i', 'Other', { kind: 'input', nativeKind: 'input', label: WRAP, offscreen: true }),
  ],
  [
    'a secure node',
    element('@i', 'Other', { kind: 'other', secure: true, placeholder: 'qa-hidden-email' }),
  ],
] as const) {
  test(`U2: an observable input or secure node matching ${name} blocks the fallback`, () => {
    assert.equal(
      keyboardFallbackTarget(fill('qa-hidden-email'), screenOf([wrapper(), observable], false)),
      undefined,
    );
  });
}

test('U2: a quoted wrapper id resolves through its base', () => {
  const s = screenOf([wrapper(), submit], false);
  assert.deepEqual(keyboardFallbackTarget(fill(WRAP), s), {
    element: s.elements[0],
    oracleTestID: 'qa-hidden-email',
  });
  const input = element('@i', 'Other', {
    kind: 'input',
    nativeKind: 'input',
    testID: 'qa-hidden-email',
    disabled: true,
  });
  assert.equal(keyboardFallbackTarget(fill(WRAP), screenOf([wrapper(), input], false)), undefined);
});

test('U3: zero or two candidates, or a semantically disabled one, keep the strict refusal', () => {
  assert.equal(
    keyboardFallbackTarget(fill('qa-hidden-email'), screenOf([submit], false)),
    undefined,
  );
  assert.equal(
    keyboardFallbackTarget(
      fill('qa-hidden-email'),
      screenOf([wrapper(), element('@w2', 'Email', { kind: 'other', testID: WRAP })], false),
    ),
    undefined,
  );
  assert.equal(
    keyboardFallbackTarget(
      fill('qa-hidden-email'),
      screenOf(
        [
          wrapper('Email', {
            semantic: {
              press: 'supported',
              fill: 'unsupported',
              visibility: 'visible',
              disabled: true,
            },
          }),
        ],
        false,
      ),
    ),
    undefined,
  );
  assert.equal(
    keyboardFallbackTarget(
      fill('qa-hidden-email'),
      screenOf([wrapper('Email', { offscreen: true })], false),
    ),
    undefined,
  );
  assert.equal(
    keyboardFallbackTarget(
      fill('Email'),
      screenOf([wrapper(), element('@x', 'Email', { kind: 'text' })], false),
    ),
    undefined,
  );
  const labelled = screenOf([element('@l', 'Email', { kind: 'other' })], false);
  assert.equal(keyboardFallbackTarget(fill('Email'), labelled), undefined);
});

for (const mutation of ['observed', 'possible', undefined] as const) {
  test(`strict Ada to Ad mismatch fails without retry (${mutation})`, async () => {
    const input = element('@name', 'Name', { kind: 'input', nativeKind: 'input', testID: 'name' });
    const fake = app({ initial: [input, submit], typeFocused: false });
    let fills = 0;
    fake.deps.fill = async (_ref, text, context) => {
      context.authorize();
      assert.equal(text, 'Ada');
      fills += 1;
      fake.deps.captureScreen = async () => screenOf([{ ...input, value: 'Ad' }, submit], true);
      return { ok: false, proven: false, mutation, error: 'TEXT_ENTRY_UNVERIFIED: mismatch' };
    };
    const result = await walkBlock(blocks(plan('Ada', 'name', ''))[0], fake.deps);
    assert.equal(result.block.outcome, 'fail');
    assert.equal(fills, 1);
    assert.match(
      renderReason(result.failure?.seen ?? '', (text) => text),
      /TEXT_ENTRY_UNVERIFIED/,
    );
    assert.equal(
      fake.rows.some((row) => row.outcome === 'pass'),
      false,
    );
  });
}

test('strict fill retries only a proven pre-mutation refusal', async () => {
  const input = element('@name', 'Name', { kind: 'input', nativeKind: 'input', testID: 'name' });
  const fake = app({ initial: [input] });
  let fills = 0;
  fake.deps.fill = async (_ref, _text, context) => {
    context.authorize();
    fills += 1;
    return fills === 1
      ? { ok: false, proven: false, mutation: 'none', error: 'NO_TEXT_INPUT_TARGET: refused' }
      : { ok: true, proven: true };
  };
  const result = await walkBlock(blocks(plan('Ada', 'name', ''))[0], fake.deps);
  assert.equal(result.block.outcome, 'pass');
  assert.equal(fills, 2);
});

for (const strict of [false, true]) {
  test(`capture failure after ${strict ? 'strict private' : 'fallback'} fill preserves action protection`, async () => {
    const target = strict ? 'email' : 'qa-hidden-email';
    const initial = [
      ...(strict
        ? [
            element('@email', 'Email', {
              kind: 'input',
              nativeKind: 'input',
              testID: target,
              secure: true,
            }),
          ]
        : [wrapper()]),
      submit,
      element('@code', `Code ${EMAIL}`, { kind: 'text' }),
      element('@hello', 'Hello', { kind: 'text' }),
    ];
    const create = () => {
      const fake = app({ initial });
      const capture = fake.deps.captureScreen;
      fake.deps.captureScreen = async (opts) => {
        if (fake.state() === 'typed') throw new NativeCaptureError();
        return capture(opts);
      };
      return fake;
    };
    const markdown = `## QA\n\n### Safe\n\n✓ "Hello"\n\n### Code shown\n\n✓ "${EMAIL}"\n\n### Private email\n\n1. Fill "${target}" with "${EMAIL}"\n`;
    const parsed = blocks(markdown);
    const outcome = await walkBlock(parsed[2], create().deps);
    assert.deepEqual(outcome.privateFills, [parsed[2].items[0].line]);
    assert.equal(outcome.refusal?.code, 'NATIVE_CAPTURE_UNAVAILABLE');
    const dir = mkdtempSync(join(tmpdir(), 'qaren-fallback-'));
    mkdirSync(join(dir, '.qaren'));
    const result = await runPlan(parsed, create().deps, [], {
      appRoot: dir,
      platform: 'ios',
      appId: 'com.example.app',
    });
    assert.equal(result.verdict, 'REFUSED');
    assert.deepEqual(result.blocksWritten, strict ? [] : ['safe']);
    assert.equal(result.blocks[1].saved, false);
    assert.equal(existsSync(join(dir, '.qaren', 'actions', 'code-shown.yaml')), false);
    if (strict) {
      assert.equal(result.blocks[0].saved, false);
      assert.equal(existsSync(join(dir, '.qaren', 'actions', 'safe.yaml')), false);
    } else {
      assert.equal(
        readFileSync(join(dir, '.qaren', 'actions', 'safe.yaml'), 'utf8').includes(EMAIL),
        false,
      );
    }
  });
}

for (const route of ['transition', 'keyboard-up', 'no-target'] as const) {
  for (const readback of [
    'retained-prefix',
    'exact',
    'unreadable',
    'retype-initial-prefix',
    'retype-dispatch-prefix',
    'retype-exact',
    'retype-same-shorter',
    'retype-other-longer',
    'retype-unreadable',
  ] as const) {
    test(`controlled replacement ${readback} stops or continues truthfully through ${route} fallback`, async () => {
      const { performFocusedFill, extractMutationDisposition } =
        await import('../../../dist/handlers/device-interact.js');
      const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
        await import('../../../dist/agent-device-wrapper.js');
      const { updateRefMapFromFlat, clearRefMap } =
        await import('../../../dist/fast-runner-ref-map.js');
      const { okResult } = await import('../../../dist/utils.js');
      const before = 'synthetic-prefill';
      const text = 'synthetic-replacement';
      const shorter = 'synthetic';
      const retype = readback.startsWith('retype-');
      const fails =
        readback === 'retained-prefix' ||
        readback === 'retype-initial-prefix' ||
        readback === 'retype-dispatch-prefix';
      const unverified = !fails && readback !== 'exact' && readback !== 'retype-exact';
      const finalValue = {
        'retained-prefix': before + text,
        exact: text,
        unreadable: null,
        'retype-initial-prefix': before + text,
        'retype-dispatch-prefix': shorter + text,
        'retype-exact': text,
        'retype-same-shorter': shorter,
        'retype-other-longer': 'unrelated' + text,
        'retype-unreadable': null,
      }[readback];
      const fake = app({
        ...(route === 'no-target' ? { initial: [submit] } : {}),
        initialKeyboard: route !== 'transition',
        reactFocused: true,
      });
      const type = fake.deps.typeFocused!;
      let dispatches = 0;
      const native = [{ ref: '@wrap', identifier: WRAP, type: 'Other' }];
      const client = {
        isConnected: true,
        evaluate: async () => ({
          value: JSON.stringify({
            value: dispatches === 0 ? before : retype && dispatches === 1 ? shorter : finalValue,
            controlled: dispatches === 0 || (retype && dispatches === 1) || finalValue !== null,
            focused: true,
          }),
        }),
      } as never;
      _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
      clearRefMap();
      markSnapshotDirty();
      updateRefMapFromFlat(native as never, { snapshotGeneration: 7, keyboardVisible: true });
      _setRunAgentDeviceForTest(async (args) => {
        if (args[0] !== 'fill') return okResult({ nodes: native });
        dispatches += 1;
        assert.ok(args.includes('--clear-first'));
        return okResult({ typed: true });
      });
      fake.deps.typeFocused = async (ref, value, testID, context, requireFocused) => {
        await type(ref, value, testID, context, requireFocused);
        const result = await performFocusedFill(
          {
            ref,
            text: value,
            testID,
            focused: true,
            vetoUnfocused: true,
            requireFocused,
            skipFinalValidation: true,
            clearFirst: true,
            qaContext: context,
          },
          client,
        );
        const env = JSON.parse(result.content[0].text);
        return env.ok
          ? { ok: true, proven: env.meta?.verify === 'exact' }
          : {
              ok: false,
              proven: false,
              mutation: extractMutationDisposition(result),
              error: `${env.code}: ${env.error}`,
            };
      };
      try {
        const dir = mkdtempSync(join(tmpdir(), 'qaren-retained-prefix-'));
        const ledger = await runPlan(
          blocks(route === 'no-target' ? otpPlan(text) : plan(text)),
          fake.deps,
          [],
          { appRoot: dir, platform: 'ios', appId: 'com.test' },
        );
        assert.equal(ledger.verdict, fails ? 'FAIL' : 'PASS');
        assert.equal(dispatches, retype || readback === 'retained-prefix' ? 2 : 1);
        assert.equal(fake.typed.length, 1);
        assert.equal(fake.log.includes('press @submit'), !fails);
        if (!fails) assert.equal(ledger.blocks[0].saved, false);
        assert.deepEqual(ledger.blocksWritten, []);
        assert.equal(ledger.videoPublication, 'withheld-fill');
        assert.ok(!fake.log.some((line) => line.startsWith('shot')));
        assert.equal(fake.rows[0].screenshot, undefined);
        assert.equal(fake.rows[0].selector, undefined);
        assert.equal(
          ledger.steps[0].reason?.startsWith('UNVERIFIED_FILL:') ?? false,
          unverified,
          JSON.stringify(ledger.steps),
        );
        if (fails) {
          assert.equal(fake.rows[0].outcome, 'fail');
          assert.match(
            renderReason(ledger.failure?.seen ?? '', (value) => value),
            /not retried/,
          );
          assert.equal(fake.state(), 'typed');
        }
        assert.ok(
          !strings({ ledger, rows: fake.rows, questions: fake.questions, notes: fake.notes }).some(
            (value) => value.includes(before) || value.includes(text),
          ),
        );
      } finally {
        _setRunAgentDeviceForTest(null);
        _setActiveSessionForTest(null);
        clearRefMap();
      }
    });
  }
}

test('a normalizing controlled fallback continues as unverified', async () => {
  const { performFocusedFill } = await import('../../../dist/handlers/device-interact.js');
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../../dist/agent-device-wrapper.js');
  const { okResult } = await import('../../../dist/utils.js');
  const { unwrap } = await import('../../../dist/qa/adapt.js');
  const fake = app({ typedLabel: 'normalized@example.test' });
  const type = fake.deps.typeFocused!;
  let reads = 0;
  let fills = 0;
  const client = {
    isConnected: true,
    evaluate: async () => {
      reads += 1;
      return {
        value: JSON.stringify({
          value: reads === 1 ? '' : 'normalized@example.test',
          controlled: true,
          focused: true,
        }),
      };
    },
  } as never;
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  _setRunAgentDeviceForTest(async () => {
    fills += 1;
    return okResult({ typed: true });
  });
  fake.deps.typeFocused = async (ref, text, testID, context) => {
    await type(ref, text, testID, context);
    const { data } = unwrap<{ verified: boolean }>(
      await performFocusedFill(
        {
          ref,
          text,
          testID,
          focused: true,
          vetoUnfocused: true,
          skipFinalValidation: true,
        },
        client,
      ),
    );
    assert.equal(data.verified, false);
    return { ok: true, proven: false };
  };
  try {
    const result = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(result.block.outcome, 'pass');
    assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
    assert.ok(reads > 1, 'the typed value is read back');
    assert.equal(fills, 1);
    assert.equal(fake.state(), 'accepted');
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

for (const nativeType of ['Other', 'TextField']) {
  test(`React input joined to native ${nativeType} uses the correct fill path`, async () => {
    const { createDeviceFillHandler, extractMutationDisposition } =
      await import('../../../dist/handlers/device-interact.js');
    const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
      await import('../../../dist/agent-device-wrapper.js');
    const { updateRefMapFromFlat, clearRefMap } =
      await import('../../../dist/fast-runner-ref-map.js');
    const { okResult } = await import('../../../dist/utils.js');
    const native = [
      {
        ref: '@e1',
        identifier: 'qa-hidden-email',
        type: nativeType,
        label: 'Email',
        hittable: true,
        rect: { x: 20, y: 100, width: 360, height: 60 },
      },
    ];
    const joined = joinScreen(native, [{ role: 'textinput', testID: 'qa-hidden-email' }]);
    assert.equal(joined.elements[0].kind, 'input');
    assert.equal(joined.elements[0].nativeKind, nativeType === 'Other' ? 'other' : 'input');
    const fake = app({ initial: [...joined.elements, submit] });
    const press = fake.deps.press;
    fake.deps.press = (ref, context) => press(ref === '@e1' ? '@wrap' : ref, context);
    let strictCalls = 0;
    let nativeFills = 0;
    const handler = createDeviceFillHandler(() => null as never);
    _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
    clearRefMap();
    markSnapshotDirty();
    updateRefMapFromFlat(native as never, { snapshotGeneration: 7, keyboardVisible: false });
    _setRunAgentDeviceForTest(async (args, opts) => {
      if (args[0] === 'snapshot') {
        updateRefMapFromFlat(native as never, { snapshotGeneration: 8, keyboardVisible: false });
        return okResult({ nodes: native });
      }
      if (args[0] === 'fill') {
        (opts as { qaContext?: { authorize(): void } } | undefined)?.qaContext?.authorize();
        nativeFills += 1;
        return okResult({ typed: true });
      }
      if (args[0] === 'verify-input')
        return okResult({ verifyVerdict: 'exact', verifyStable: true });
      throw new Error(`unexpected command ${args[0]}`);
    });
    fake.deps.fill = async (ref, text, context) => {
      strictCalls += 1;
      fake.log.push(`fill ${ref}`);
      const result = await handler({ ref, text, qaContext: context });
      const env = JSON.parse(result.content[0].text);
      if (!env.ok) {
        assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
        return {
          ok: false,
          proven: false,
          mutation: extractMutationDisposition(result),
          error: `${env.code}: ${env.error}`,
        };
      }
      return { ok: true, proven: true };
    };
    try {
      const result = await walkBlock(blocks(plan())[0], fake.deps);
      assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
      assert.equal(strictCalls, 1);
      assert.equal(nativeFills, nativeType === 'Other' ? 0 : 1);
      assert.equal(fake.typed.length, nativeType === 'Other' ? 1 : 0);
      if (nativeType === 'Other') {
        assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
        assert.deepEqual(steps(fake.log), ['fill @e1', 'press @wrap', 'type @e1', 'press @submit']);
      } else {
        assert.equal(result.rows[0].reason, undefined);
        assert.deepEqual(
          steps(fake.log).filter((step) => !step.startsWith('shot')),
          ['fill @e1', 'press @submit'],
        );
      }
    } finally {
      _setRunAgentDeviceForTest(null);
      _setActiveSessionForTest(null);
      clearRefMap();
    }
  });
}

for (const mutation of ['observed', 'possible', undefined] as const) {
  test(`an unobservable target refusal with mutation ${mutation} never falls back`, async () => {
    const joined = joinScreen(
      [
        {
          ref: '@wrap',
          identifier: 'qa-hidden-email',
          type: 'Other',
          label: 'Email',
          hittable: true,
        },
      ],
      [{ role: 'textinput', testID: 'qa-hidden-email' }],
    );
    const fake = app({ initial: [...joined.elements, submit] });
    fake.deps.fill = async (_ref, _text, context) => {
      context.authorize();
      fake.log.push('strict refusal');
      return { ok: false, proven: false, mutation, error: 'NO_TEXT_INPUT_TARGET: refused' };
    };
    const result = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(result.block.outcome, 'fail');
    assert.deepEqual(
      steps(fake.log).filter((step) => !step.startsWith('shot')),
      ['strict refusal'],
    );
    assert.equal(fake.typed.length, 0);
  });
}

test('React-only inputs do not block or become keyboard fallback targets', () => {
  const joined = joinScreen(
    [{ ref: '@wrap', identifier: WRAP, type: 'Other', label: 'Email', hittable: true }],
    [{ role: 'textinput', testID: 'qa-hidden-email' }],
  );
  assert.equal(keyboardFallbackTarget(fill('qa-hidden-email'), joined)?.element.ref, '@wrap');
  const reactOnly = joinScreen([], [{ role: 'textinput', testID: 'qa-hidden-email' }]);
  assert.equal(keyboardFallbackTarget(fill('qa-hidden-email'), reactOnly), undefined);
});

function hiddenInputScreen(reactKnown = true, labelled = false): Screen {
  return joinScreen(
    [
      {
        ref: '@wrap',
        identifier: 'custom-pressable-pressable',
        ...(labelled ? { label: 'custom-pressable' } : {}),
        type: 'Other',
        hittable: true,
        rect: { x: 20, y: 100, width: 360, height: 60 },
      },
    ],
    reactKnown
      ? [{ role: 'textinput', testID: 'custom-pressable', capabilities: { fill: true } }]
      : [],
    'app',
    { native: 'complete', react: reactKnown ? 'complete' : 'unknown' },
  );
}

for (const reactKnown of [true, false]) {
  test(`strict hidden fill reaches keyboard fallback with React evidence ${reactKnown}`, () => {
    const joined = hiddenInputScreen(reactKnown);
    const step = fill('custom-pressable');
    const strict = prepareTarget(step, joined);
    assert.ok('refuse' in strict);
    assert.equal(strict.refuse, 'TARGET_NOT_FOUND');
    // Seen by React or unavailable to React, the exact wrapper stands for the field.
    assert.deepEqual(keyboardFallbackTarget(step, joined), {
      element: joined.elements[0],
      oracleTestID: 'custom-pressable',
    });
    assert.equal(
      joined.elements.some((e) => e.ref.startsWith('react:')),
      reactKnown,
    );
  });

  test(`joined hidden input ${reactKnown ? 'walks without scrolling' : 'refuses without an observed inner field'} (React evidence ${reactKnown})`, async () => {
    const joined = hiddenInputScreen(reactKnown);
    const fake = app({ initial: joined.elements, initialKeyboard: false });
    const result = await walkBlock(blocks(plan(EMAIL, 'custom-pressable', ''))[0], fake.deps);
    if (!reactKnown) {
      assert.equal(result.block.outcome, 'fail');
      assert.match(
        renderReason(result.failure?.seen ?? '', (text) => text),
        /TARGET_NOT_FOUND/,
      );
      assert.deepEqual(
        steps(fake.log).filter((s) => !s.startsWith('shot')),
        [],
      );
      assert.deepEqual(fake.typed, []);
      return;
    }
    assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
    assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap']);
    assert.deepEqual(fake.typed, [{ ref: '@wrap', text: EMAIL, testID: 'custom-pressable' }]);
    assert.equal(fake.rows[0].outcome, 'pass');
    assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
  });
}

test('a wrapper echoing its hidden field name stands for that one field', async () => {
  const joined = hiddenInputScreen(true, true);
  assert.deepEqual(keyboardFallbackTarget(fill('custom-pressable'), joined), {
    element: joined.elements[0],
    oracleTestID: 'custom-pressable',
  });
  const fake = app({ initial: joined.elements, initialKeyboard: false });
  const result = await walkBlock(blocks(plan(EMAIL, 'custom-pressable', ''))[0], fake.deps);
  assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
  assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap']);
  assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
});

for (const belowFold of [true, false]) {
  test(`native input ${belowFold ? 'below the fold scrolls' : 'on screen resolves strictly'}`, () => {
    const joined = joinScreen(
      [
        {
          ref: '@window',
          type: 'Application',
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          ref: '@input',
          identifier: 'custom-pressable',
          type: 'TextField',
          hittable: !belowFold,
          rect: { x: 20, y: belowFold ? 900 : 100, width: 360, height: 60 },
        },
      ],
      [{ role: 'textinput', testID: 'custom-pressable', capabilities: { fill: true } }],
    );
    assert.deepEqual(
      prepareTarget(fill('custom-pressable'), joined),
      belowFold
        ? { scroll: 'down', element: joined.elements[1] }
        : { ref: '@input', element: joined.elements[1] },
    );
    assert.equal(keyboardFallbackTarget(fill('custom-pressable'), joined), undefined);
  });
}

test('pressing a React-only input still requests scrolling', () => {
  const joined = hiddenInputScreen();
  assert.deepEqual(
    prepareTarget(
      { kind: 'press', target: { quoted: 'custom-pressable', phrase: 'custom-pressable' } },
      joined,
    ),
    { scroll: 'down', element: joined.elements.find((e) => e.ref === 'react:custom-pressable') },
  );
});

for (const guard of ['secure', 'ambiguous', 'unrelated refusal']) {
  test(`${guard} still excludes the promoted input fallback`, async () => {
    const joined = joinScreen(
      [
        {
          ref: '@wrap',
          identifier: 'qa-hidden-email',
          type: 'Other',
          label: 'Email',
          hittable: true,
          secure: guard === 'secure',
        },
        ...(guard === 'ambiguous'
          ? [
              {
                ref: '@duplicate',
                identifier: 'qa-hidden-email',
                type: 'Other',
                label: 'Email',
                hittable: true,
              },
            ]
          : []),
      ],
      [{ role: 'textinput', testID: 'qa-hidden-email' }],
    );
    const fake = app({ initial: [...joined.elements, submit] });
    fake.deps.fill = async (_ref, _text, context) => {
      context.authorize();
      return {
        ok: false,
        proven: false,
        mutation: 'none',
        error:
          guard === 'unrelated refusal'
            ? 'FOCUS_TARGET_OCCLUDED: refused'
            : 'NO_TEXT_INPUT_TARGET: refused',
      };
    };
    const result = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(result.block.outcome, 'fail');
    assert.equal(fake.typed.length, 0);
    assert.equal(
      fake.log.some((entry) => entry.startsWith('press')),
      false,
    );
  });
}

for (const identity of ['qa-hidden-email', WRAP]) {
  for (const freshState of ['unique', 'duplicate', 'missing', 'keyboard up', 'keyboard unknown']) {
    test(`strict refusal refreshes ${identity} before fallback (${freshState})`, async () => {
      const { bindExactFillTarget } = await import('../../../dist/handlers/device-interact.js');
      const original = {
        ref: '@e1',
        identifier: identity,
        type: 'Other',
        label: 'Email',
        hittable: true,
        rect: { x: 20, y: 100, width: 360, height: 60 },
      };
      const moved = { ...original, ref: '@e2' };
      const other = {
        ref: '@e1',
        identifier: 'unrelated-control',
        type: 'Button',
        label: 'Other',
        hittable: true,
        rect: { x: 20, y: 300, width: 360, height: 60 },
      };
      const digest = [{ role: 'textinput', testID: identity }];
      const initial = joinScreen([original], digest).elements;
      const fresh = joinScreen(
        [
          other,
          ...(freshState === 'missing' ? [] : [moved]),
          ...(freshState === 'duplicate' ? [{ ...moved, ref: '@e3' }] : []),
        ],
        digest,
      ).elements;
      const fake = app({ initial: [...initial, submit] });
      let refreshed = false;
      let strictCalls = 0;
      const taps: string[] = [];
      const capture = fake.deps.captureScreen;
      fake.deps.captureScreen = async (options) => {
        if (fake.state() === 'accepted') return capture(options);
        fake.log.push('capture');
        return screenOf(
          [...(refreshed ? fresh : initial), submit],
          fake.state() !== 'idle' || (refreshed && freshState === 'keyboard up')
            ? true
            : refreshed && freshState === 'keyboard unknown'
              ? undefined
              : false,
        );
      };
      fake.deps.fill = async (ref, _text, context) => {
        context.check();
        strictCalls += 1;
        assert.equal(ref, '@e1');
        const bound = bindExactFillTarget([other, moved], ref, {
          type: original.type,
          identifier: original.identifier,
          label: original.label,
          rect: original.rect,
          flatIndex: 0,
          nodeCount: 1,
        });
        assert.equal(bound.ok, false);
        if (bound.ok) throw new Error('expected an unobservable input');
        assert.equal(bound.unobservable, true);
        refreshed = true;
        return {
          ok: false,
          proven: false,
          mutation: 'none',
          error: `NO_TEXT_INPUT_TARGET: ${bound.detail}`,
        };
      };
      const press = fake.deps.press;
      fake.deps.press = (ref, context) => {
        taps.push(ref);
        return press(ref === '@e2' ? '@wrap' : ref, context);
      };
      const result = await walkBlock(blocks(plan(EMAIL, identity))[0], fake.deps);
      assert.equal(strictCalls, 1);
      if (freshState === 'unique') {
        assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
        assert.deepEqual(taps, ['@e2', '@submit']);
        assert.equal(fake.typed.length, 1);
        assert.equal(fake.typed[0].ref, '@e2');
        assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
      } else {
        assert.equal(result.block.outcome, 'fail');
        assert.deepEqual(taps, []);
        assert.equal(fake.typed.length, 0);
        assert.match(
          renderReason(result.failure?.seen ?? '', (text) => text),
          freshState === 'duplicate' ? /^TARGET_AMBIGUOUS:/ : /nothing was typed/,
        );
      }
      assert.equal(taps.includes('@e1'), false);
    });
  }
}

test('fresh fallback cannot substitute another identity with the same label', async () => {
  const original = joinScreen(
    [{ ref: '@e1', identifier: 'original-email', type: 'Other', label: 'Email', hittable: true }],
    [{ role: 'textinput', testID: 'original-email' }],
  ).elements;
  const replacement = joinScreen(
    [
      {
        ref: '@e2',
        identifier: 'replacement-email',
        type: 'Other',
        label: 'Email',
        hittable: true,
      },
    ],
    [{ role: 'textinput', testID: 'replacement-email' }],
  ).elements;
  const fake = app({ initial: original });
  let refused = false;
  fake.deps.captureScreen = async () => screenOf(refused ? replacement : original, false);
  fake.deps.fill = async (_ref, _text, context) => {
    context.check();
    refused = true;
    return { ok: false, proven: false, mutation: 'none', error: 'NO_TEXT_INPUT_TARGET: refused' };
  };
  const result = await walkBlock(blocks(plan(EMAIL, 'Email', ''))[0], fake.deps);
  assert.equal(result.block.outcome, 'fail');
  assert.equal(
    fake.log.some((entry) => entry.startsWith('press')),
    false,
  );
  assert.equal(fake.typed.length, 0);
});

for (const replacementHasId of [false, true]) {
  test(`an anonymous strict target never falls back to a replacement (id: ${replacementHasId})`, async () => {
    const original = joinScreen(
      [{ ref: '@e1', type: 'Other', label: 'Email', hittable: true }],
      [{ role: 'textinput', text: 'Email' }],
    ).elements;
    assert.equal(original[0].kind, 'input');
    assert.equal(original[0].testID, undefined);
    const replacement = element('@e2', 'Email', {
      kind: 'other',
      ...(replacementHasId ? { testID: 'replacement-email' } : {}),
    });
    const fake = app({ initial: original });
    let fills = 0;
    let captures = 0;
    fake.deps.captureScreen = async () => {
      captures += 1;
      return screenOf(fills ? [replacement] : original, false);
    };
    fake.deps.fill = async (_ref, _text, context) => {
      context.check();
      fills += 1;
      return {
        ok: false,
        proven: false,
        mutation: 'none',
        error: 'NO_TEXT_INPUT_TARGET: unobservable input',
      };
    };
    const result = await walkBlock(blocks(plan(EMAIL, 'Email', ''))[0], fake.deps);
    assert.equal(result.block.outcome, 'fail');
    assert.match(
      renderReason(result.failure?.seen ?? '', (text) => text),
      /^NO_TEXT_INPUT_TARGET: unobservable input/,
    );
    assert.equal(fills, 1);
    assert.equal(captures, 1);
    assert.equal(
      fake.log.some((entry) => entry.startsWith('press')),
      false,
    );
    assert.equal(fake.typed.length, 0);
  });
}

test('a label-only unresolved target keeps its strict resolution refusal', async () => {
  const fake = app({ initial: [element('@label', 'Email', { kind: 'other' })] });
  const result = await walkBlock(blocks(plan(EMAIL, 'Email', ''))[0], fake.deps);
  assert.equal(result.block.outcome, 'fail');
  assert.match(
    renderReason(result.failure?.seen ?? '', (text) => text),
    /^TARGET_NOT_FOUND:/,
  );
  assert.equal(
    fake.log.some((entry) => entry.startsWith('press')),
    false,
  );
  assert.equal(fake.typed.length, 0);
});

test('a labelled target with a unique ID remains eligible', () => {
  const identified = element('@email', 'Email', { kind: 'other', testID: 'email' });
  assert.deepEqual(keyboardFallbackTarget(fill('Email'), screenOf([identified], false)), {
    element: identified,
    oracleTestID: 'email',
  });
  const duplicate = element('@duplicate', 'Elsewhere', {
    kind: 'other',
    testID: 'email',
    offscreen: true,
  });
  assert.equal(
    keyboardFallbackTarget(fill('Email'), screenOf([identified, duplicate], false)),
    undefined,
  );
});

for (const refusal of ['resolution', 'native binding']) {
  for (const kind of ['input', 'other'] as const) {
    for (const matching of [false, true]) {
      test(`post-tap ${kind} preserves original identity after ${refusal} refusal (${matching})`, async () => {
        const initial =
          refusal === 'resolution'
            ? wrapper('Email', { testID: 'original-email-pressable' })
            : joinScreen(
                [
                  {
                    ref: '@wrap',
                    identifier: 'original-email-pressable',
                    type: 'Other',
                    label: 'Email',
                    hittable: true,
                  },
                ],
                [{ role: 'textinput', testID: 'original-email-pressable' }],
              ).elements[0];
        const input = element('@input', 'Email', {
          kind,
          nativeKind: kind,
          testID: matching ? 'original-email' : 'replacement-email',
        });
        const fake = app({
          initial: [initial],
          focused: [screenOf([input], true)],
          hosts: [{ ...INNER, testID: 'original-email' }],
        });
        const fill = fake.deps.fill;
        fake.deps.fill = async (ref, text, context) => {
          if (ref === '@wrap') {
            context.check();
            fake.log.push('strict refusal');
            return {
              ok: false,
              proven: false,
              mutation: 'none',
              error: 'NO_TEXT_INPUT_TARGET: refused',
            };
          }
          return fill(ref, text, context);
        };
        const result = await walkBlock(blocks(plan(EMAIL, 'Email', ''))[0], fake.deps);
        assert.equal(result.block.outcome, matching ? 'pass' : 'fail');
        assert.equal(fake.typed.length, matching ? 1 : 0);
        if (!matching) {
          assert.equal(
            fake.rows.some((row) => row.outcome === 'pass'),
            false,
          );
          assert.equal(
            fake.log.some((entry) => entry === 'fill @input'),
            false,
          );
        } else {
          assert.equal(fake.typed[0].ref, '@input');
          assert.equal(
            result.rows[0].reason?.startsWith('UNVERIFIED_FILL:') ?? false,
            kind === 'other',
          );
        }
      });
    }
  }
}

for (const refusal of ['resolution', 'native binding']) {
  for (const matching of [false, true]) {
    test(`freshness refresh retains post-tap identity after ${refusal} refusal (${matching})`, async () => {
      const initial =
        refusal === 'resolution'
          ? wrapper('Email', { testID: 'original-email-pressable' })
          : joinScreen(
              [
                {
                  ref: '@wrap',
                  identifier: 'original-email-pressable',
                  type: 'Other',
                  label: 'Email',
                  hittable: true,
                },
              ],
              [{ role: 'textinput', testID: 'original-email-pressable' }],
            ).elements[0];
      const input = element('@input', 'Email', {
        kind: 'input',
        nativeKind: 'input',
        testID: 'original-email',
      });
      const replacement = element('@replacement', matching ? 'Renamed field' : 'Email', {
        kind: 'input',
        nativeKind: 'input',
        testID: matching ? 'original-email' : 'replacement-email',
      });
      const fake = app({
        initial: [initial],
        focused: [screenOf([input], true), screenOf([replacement], true)],
        hosts: [{ ...INNER, testID: 'original-email' }],
      });
      let time = 0;
      let expired = false;
      fake.deps.now = () => time;
      fake.deps.timing = (event) => {
        if (
          !expired &&
          fake.state() === 'focused' &&
          event.stage === 'capture' &&
          event.edge === 'end'
        ) {
          expired = true;
          time += 60_000;
        }
      };
      const fill = fake.deps.fill;
      fake.deps.fill = async (ref, text, context) => {
        if (ref === '@wrap') {
          context.check();
          return {
            ok: false,
            proven: false,
            mutation: 'none',
            error: 'NO_TEXT_INPUT_TARGET: refused',
          };
        }
        return fill(ref, text, context);
      };
      const result = await walkBlock(blocks(plan(EMAIL, 'Email', ''))[0], fake.deps);
      assert.equal(expired, true);
      assert.equal(
        result.block.outcome,
        matching ? 'pass' : 'fail',
        JSON.stringify(result.failure),
      );
      assert.equal(fake.typed.length, matching ? 1 : 0);
      if (matching) assert.equal(fake.typed[0].ref, '@replacement');
      else {
        assert.equal(
          fake.rows.some((row) => row.outcome === 'pass'),
          false,
        );
        assert.match(
          renderReason(result.failure?.seen ?? '', (text) => text),
          /^TARGET_NOT_FOUND:/,
        );
      }
    });
  }
}

for (const evidence of ['masked', 'unavailable', 'mismatch'] as const) {
  test(`I5: a strict fill with ${evidence} evidence ${evidence === 'mismatch' ? 'fails' : 'passes unverified'} and is never retried`, async () => {
    const input = element('@pw', 'Password', {
      kind: 'input',
      nativeKind: 'input',
      testID: 'login_password',
      secure: evidence === 'masked',
    });
    const fake = app({ initial: [input, submit], typeFocused: false });
    let fills = 0;
    fake.deps.fill = async (_ref, text, context) => {
      context.authorize();
      assert.equal(text, 'hunter22');
      fills += 1;
      fake.deps.captureScreen = async () => screenOf([input, submit], true);
      return {
        ok: false,
        proven: false,
        mutation: 'possible',
        error:
          'TEXT_ENTRY_UNVERIFIED: device_fill typed but the retained native target could not be verified',
        evidence,
      };
    };
    const result = await walkBlock(blocks(plan('hunter22', 'login_password', ''))[0], fake.deps);
    assert.equal(fills, 1);
    assert.equal(fake.rows.filter((row) => row.outcome === 'retry').length, 0);
    if (evidence === 'mismatch') {
      assert.equal(result.block.outcome, 'fail');
      assert.match(
        renderReason(result.failure?.seen ?? '', (text) => text),
        /TEXT_ENTRY_UNVERIFIED/,
      );
      return;
    }
    assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
    assert.equal(result.rows[0].outcome, 'pass');
    assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
    assert.equal(JSON.stringify(result.rows).includes('hunter22'), false);
    assert.equal(JSON.stringify(fake.rows).includes('hunter22'), false);
  });
}

test('I6: a strict fill the app only re-cased passes unverified with its character count as a number', async () => {
  const input = element('@name', 'Name', {
    kind: 'input',
    nativeKind: 'input',
    testID: 'name_field',
  });
  const fake = app({ initial: [input, submit], typeFocused: false });
  let fills = 0;
  fake.deps.fill = async (_ref, _text, context) => {
    context.authorize();
    fills += 1;
    fake.deps.captureScreen = async () => screenOf([input, submit], true);
    return {
      ok: false,
      proven: false,
      mutation: 'observed',
      error:
        'TEXT_ENTRY_UNVERIFIED: device_fill typed the value and the field changed only its letter case',
      evidence: 'case-normalized',
    };
  };
  const result = await walkBlock(blocks(plan('Ada Lovelace', 'name_field', ''))[0], fake.deps);
  assert.equal(fills, 1);
  assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
  assert.match(
    result.rows[0].reason ?? '',
    /^UNVERIFIED_FILL: the field changed only the letter case/,
  );
  assert.deepEqual(result.rows[0].caseNormalized, { chars: 12 });
  assert.equal(JSON.stringify(result.rows).includes('Lovelace'), false);
});

test('I7: a fallback fill the app only re-cased passes unverified with its character count', async () => {
  const fake = app({ type: { ok: true, proven: false, caseNormalized: { chars: 15 } } });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.match(outcome.rows[0].reason ?? '', /; the field changed only the letter case$/);
  assert.deepEqual(outcome.rows[0].caseNormalized, { chars: 15 });
});

const mutations = (log: string[]) =>
  log.filter((entry) => /^(press|type|fill|scroll) /.test(entry));

const FOCUS_NOTE = (path: 'tap' | 'none', proof: 'focused' | 'not-proven') =>
  `fallback-focus {"v":1,"path":"${path}","keyboard":true,"proof":"${proof}"}`;

test('P1: keyboard up with a wrapper types once after the tap when React proves focus', async () => {
  const fake = app({ initialKeyboard: true, reactFocused: true });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap', 'press @submit']);
  assert.deepEqual(fake.typed, [{ ref: '@wrap', text: EMAIL, testID: 'qa-hidden-email' }]);
  assert.deepEqual(fake.focusReads, ['qa-hidden-email']);
  assert.deepEqual(fake.focusRequirements, [true]);
  assert.deepEqual(fake.notes, [FOCUS_NOTE('tap', 'focused')]);
  assert.equal(fake.rows[0].outcome, 'pass');
  assert.match(
    outcome.rows[0].reason ?? '',
    /^UNVERIFIED_FILL: typed with the keyboard into the field React reports focused \("qa-hidden-email"\)/,
  );
  assert.deepEqual(outcome.privateFills, [fake.rows[0].line]);
});

for (const focus of [false, 'throw'] as const) {
  test(`P2: keyboard up with a wrapper taps but types nothing when focus is ${focus === false ? 'not reported' : 'unreadable'}`, async () => {
    const fake = app({ initialKeyboard: true, reactFocused: focus });
    const outcome = await walkBlock(blocks(plan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(steps(fake.log), ['press @wrap']);
    assert.deepEqual(fake.typed, []);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /^the keyboard was already up and focus on "qa-hidden-email" is not proven; nothing was typed/,
    );
    assert.deepEqual(fake.notes, [FOCUS_NOTE('tap', 'not-proven')]);
    assert.deepEqual(outcome.privateFills, [fake.rows[0].line]);
  });
}

const otpPlan = (value = '1234') =>
  `## QA\n\n### Code\n\n1. Fill "qa-otp-code" with "${value}"\n2. Tap "qa-hidden-submit"\n`;

test('P3: keyboard up with no tappable target types once into the field React reports focused', async () => {
  const fake = app({ initial: [submit], initialKeyboard: true, reactFocused: true });
  const outcome = await walkBlock(blocks(otpPlan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(steps(fake.log), ['type qa-otp-code', 'press @submit']);
  assert.deepEqual(fake.typed, [{ ref: 'qa-otp-code', text: '1234', testID: 'qa-otp-code' }]);
  assert.deepEqual(fake.focusReads, ['qa-otp-code']);
  assert.deepEqual(fake.focusRequirements, [true]);
  assert.deepEqual(fake.notes, [FOCUS_NOTE('none', 'focused')]);
  assert.match(
    outcome.rows[0].reason ?? '',
    /^UNVERIFIED_FILL: typed with the keyboard into the field React reports focused \("qa-otp-code"\)/,
  );
  assert.deepEqual(outcome.privateFills, [fake.rows[0].line]);
});

for (const focus of [false, 'throw'] as const) {
  test(`P4: keyboard up with no target and focus ${focus === false ? 'not reported' : 'unreadable'} keeps the strict refusal`, async () => {
    const fake = app({ initial: [submit], initialKeyboard: true, reactFocused: focus });
    const outcome = await walkBlock(blocks(otpPlan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /^TARGET_NOT_FOUND:/,
    );
    assert.deepEqual(mutations(fake.log), []);
    assert.deepEqual(fake.notes, [FOCUS_NOTE('none', 'not-proven')]);
    assert.equal(outcome.privateFills, undefined);
  });
}

test('no-target focus proof preserves a quoted ID ending in -pressable', async () => {
  const sibling = element('@sibling', 'Sibling', { kind: 'input', testID: 'custom' });
  const hidden = element('react:custom-pressable', 'Hidden', {
    kind: 'input',
    testID: 'custom-pressable',
    offscreen: true,
    hittable: false,
  });
  const fake = app({ initial: [sibling, hidden, submit], initialKeyboard: true });
  fake.deps.reactFocused = async (id) => {
    fake.focusReads.push(id);
    return id === 'custom';
  };
  const outcome = await walkBlock(blocks(plan(EMAIL, 'custom-pressable', ''))[0], fake.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(fake.focusReads, ['custom-pressable']);
  assert.deepEqual(fake.typed, []);
  assert.deepEqual(mutations(fake.log), []);
  assert.equal(
    fake.rows.some((row) => row.outcome === 'pass'),
    false,
  );
});

for (const blocker of ['secure', 'disabled'] as const) {
  test(`P5: a ${blocker} element carrying the field id blocks typing without a target`, async () => {
    const field = element('@code', 'Code', {
      kind: 'other',
      testID: 'qa-otp-code',
      ...(blocker === 'secure'
        ? { secure: true }
        : {
            semantic: {
              press: 'unsupported',
              fill: 'unsupported',
              visibility: 'visible',
              disabled: true,
            },
          }),
    } as Partial<Element>);
    const fake = app({ initial: [field, submit], initialKeyboard: true, reactFocused: true });
    const outcome = await walkBlock(blocks(otpPlan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(mutations(fake.log), []);
    assert.deepEqual(fake.typed, []);
    assert.deepEqual(fake.focusReads, []);
  });
}

for (const shape of ['wrapper', 'none'] as const) {
  test(`P6: unknown keyboard state never reads focus (${shape})`, async () => {
    const fake = app({
      ...(shape === 'none' ? { initial: [submit] } : {}),
      initialKeyboard: 'absent',
      reactFocused: true,
    });
    const outcome = await walkBlock(blocks(shape === 'none' ? otpPlan() : plan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(mutations(fake.log), []);
    assert.deepEqual(fake.focusReads, []);
  });
}

test('P7: keyboard down keeps the transition path and never reads focus', async () => {
  const fake = app({ reactFocused: false });
  const outcome = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(steps(fake.log), ['press @wrap', 'type @wrap', 'press @submit']);
  assert.deepEqual(fake.focusReads, []);
  assert.deepEqual(fake.focusRequirements, [false]);
  assert.deepEqual(fake.notes, []);
  assert.match(
    outcome.rows[0].reason ?? '',
    /^UNVERIFIED_FILL: typed with the keyboard after tapping/,
  );
});

for (const secret of ['SECRET-MARKER-123', '12']) {
  test(`P8: the typed value ${secret.length > 2 ? 'marker' : 'short value'} never reaches rows or notes`, async () => {
    for (const shape of ['wrapper', 'none'] as const) {
      const fake = app({
        ...(shape === 'none' ? { initial: [submit] } : {}),
        initialKeyboard: true,
        reactFocused: true,
      });
      const outcome = await walkBlock(
        blocks(shape === 'none' ? otpPlan(secret) : plan(secret))[0],
        fake.deps,
      );
      assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
      const exposed = [...strings(fake.rows), ...fake.notes, ...strings(outcome.block)];
      assert.equal(
        exposed.some((text) => text.includes(secret)),
        false,
        `${shape}: ${exposed.filter((text) => text.includes(secret)).join(' | ')}`,
      );
    }
  });
}

for (const shape of ['wrapper', 'none'] as const) {
  test(`P9: a failed proven-focus type is not retried (${shape})`, async () => {
    const fake = app({
      ...(shape === 'none' ? { initial: [submit] } : {}),
      initialKeyboard: true,
      reactFocused: true,
      type: {
        ok: false,
        proven: false,
        mutation: 'possible',
        error: 'TEXT_ENTRY_UNVERIFIED: failed',
      },
    });
    const outcome = await walkBlock(blocks(shape === 'none' ? otpPlan() : plan())[0], fake.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(fake.typed.length, 1);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /not retried/,
    );
  });
}

function twinScreen(): Screen {
  return joinScreen(
    [
      { ref: '@window', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: '@twin',
        identifier: 'qa-twin-same',
        type: 'TextField',
        hittable: true,
        rect: { x: 20, y: 100, width: 360, height: 60 },
      },
    ],
    [
      { role: 'textinput', testID: 'qa-twin-same', capabilities: { fill: true } },
      { role: 'textinput', testID: 'qa-twin-same', capabilities: { fill: true } },
    ],
  );
}

test('a native input and its React-only twin with the same testID refuse as ambiguous', () => {
  const joined = twinScreen();
  assert.equal(
    joined.elements.some((e) => e.ref.startsWith('react:')),
    true,
  );
  const strict = prepareTarget(fill('qa-twin-same'), joined);
  assert.ok('refuse' in strict);
  assert.equal(strict.refuse, 'TARGET_AMBIGUOUS');
});

test('twin inputs are refused before any tap or typing', async () => {
  const joined = twinScreen();
  const fake = app({ initial: joined.elements, initialKeyboard: false });
  const result = await walkBlock(blocks(plan(EMAIL, 'qa-twin-same', ''))[0], fake.deps);
  assert.equal(result.block.outcome, 'fail');
  assert.match(
    renderReason(result.failure?.seen ?? '', (text) => text),
    /^TARGET_AMBIGUOUS:/,
  );
  assert.deepEqual(mutations(fake.log), []);
  assert.deepEqual(fake.typed, []);
});

test('split digit boxes never reveal a concealed code in any evidence sink', async () => {
  const boxes = joinScreen(
    ['1', '2', '3', '4'].map((label, i) => ({
      ref: `@box${i}`,
      type: 'StaticText',
      label,
      rect: { x: i * 48, y: 100, width: 32, height: 40 },
    })),
    [],
  ).elements;
  const fake = app({ initial: [submit], initialKeyboard: true, reactFocused: true });
  const capture = fake.deps.captureScreen;
  fake.deps.captureScreen = async () =>
    fake.state() === 'typed' ? screenOf([...boxes, submit], true) : capture();
  const outcome = await walkBlock(
    blocks('## QA\n\n### Code\n\n1. Fill "qa-otp-code" with "1234"\n✓ "Code accepted"\n')[0],
    fake.deps,
  );
  assert.equal(outcome.block.outcome, 'fail');
  const exposed = [...strings(fake.rows), ...strings(outcome.block), ...strings(outcome.failure)];
  assert.equal(
    exposed.some((text) => /[1-4]/.test(text.replace(/line|\d+-line\d+|\.png/g, ''))),
    false,
    exposed.filter((text) => /[1-4]/.test(text)).join(' | '),
  );
});

test('twins appearing after the fallback tap remain terminal during rebinding', async () => {
  const fake = app({
    focused: [
      screenOf(
        [
          element('@one', 'Email', { kind: 'input', testID: 'qa-hidden-email' }),
          element('@two', 'Email', { kind: 'input', testID: 'qa-hidden-email' }),
        ],
        true,
      ),
    ],
  });
  let recoveries = 0;
  fake.deps.hideDevMenu = async () => {
    recoveries += 1;
    return { ok: true, proven: true };
  };
  const result = await walkBlock(blocks(plan(EMAIL, 'qa-hidden-email', ''))[0], fake.deps);
  assert.equal(result.block.outcome, 'fail');
  assert.match(
    renderReason(result.failure?.seen ?? '', (text) => text),
    /^TARGET_AMBIGUOUS:/,
  );
  assert.equal(fake.typed.length, 0);
  assert.equal(recoveries, 0);
  assert.equal(fake.log.filter((entry) => entry.startsWith('press')).length, 1);
});

test('without React reads the exact wrapper is tapped and typed into, unverified', async () => {
  const fake = app({ reactUnavailable: true });
  const result = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
  assert.deepEqual(steps(fake.log).slice(0, 2), ['press @wrap', 'type @wrap']);
  assert.deepEqual(fake.typed[0], { ref: '@wrap', text: EMAIL, testID: 'qa-hidden-email' });
  assert.match(result.rows[0].reason ?? '', /^UNVERIFIED_FILL:/);
});

test('without React a second wrapper for the field refuses before any tap', async () => {
  const fake = app({
    reactUnavailable: true,
    initial: [wrapper(), wrapper('Email', { ref: '@wrap2' }), submit],
  });
  const result = await walkBlock(blocks(plan())[0], fake.deps);
  assert.equal(result.block.outcome, 'fail');
  assert.deepEqual(fake.typed, []);
  assert.ok(!fake.log.some((line) => line.startsWith('press')));
});

const publishWindow = async (markdown: string, options: AppOptions = {}) => {
  const typed: string[] = [];
  const privacy = new ObservedPrivacy(typed);
  const outcome = await walkBlock(blocks(markdown)[0], app(options).deps, 0, typed, privacy);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  privacy.startWindow();
  return privacy.windowClean();
};

test('a wrapper fill keeps the publish window dirty while its form stays on screen', async () => {
  assert.equal(await publishWindow(plan(EMAIL, 'qa-hidden-email', '')), false);
  assert.equal(await publishWindow(plan()), true);
});

test('a focus-only fill keeps the publish window dirty with no field to see leave', async () => {
  const fillOnly = '## QA\n\n### Code\n\n1. Fill "qa-otp-code" with "1234"\n';
  const focused = { initial: [submit], initialKeyboard: true, reactFocused: true } as const;
  assert.equal(await publishWindow(fillOnly, focused), false);
  assert.equal(await publishWindow(otpPlan(), focused), false);
});

const slotPlan = (name = 'EMAIL', target = 'qa-hidden-email') =>
  `## QA\n\n### Hidden email\n\n1. Fill "${target}" with input ${name}\n2. Tap "qa-hidden-submit"\n✓ "Form accepted"\n`;
const SLOT_SHAPES = [
  ['nothing names the field', {}],
  ['React lists the field', { initial: [...wrappedInput('Email').elements, submit] }],
] as const;
const slotStore = (): BlockStore => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-slot-'));
  mkdirSync(join(dir, '.qaren'));
  return { appRoot: dir, platform: 'ios', appId: 'com.example.app' };
};
const slotRun = (
  store: BlockStore,
  value: string,
  options: AppOptions = {},
  markdown = slotPlan(),
) => {
  const fake = app(options);
  const name = markdown.includes('OTP') ? 'OTP' : 'EMAIL';
  const inputs = new RunInputs(
    { [name]: value },
    [name],
    undefined,
    markdown.includes('(non-secret)') ? [name] : [],
  );
  return withInputs(inputs, async () => ({
    fake,
    result: (await runPlan(blocks(markdown), fake.deps, [], store)) as Ledger,
  }));
};
const savedFile = (store: BlockStore, slug: string) =>
  readFileSync(join(store.appRoot, '.qaren', 'actions', `${slug}.yaml`), 'utf8');

for (const [shape, options] of SLOT_SHAPES) {
  test(`a wrapper slot fill stores the field id and saves name-only when ${shape}`, async () => {
    const block = blocks(slotPlan())[0];
    const fake = app(options);
    const outcome = await withInputs(new RunInputs({ EMAIL: EMAIL }, ['EMAIL']), () =>
      walkBlock(block, fake.deps),
    );
    assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
    assert.equal(outcome.rows[0].ref, '@wrap');
    assert.deepEqual(outcome.rows[0].selector, { id: 'qa-hidden-email' });
    const files = [];
    for (const value of [EMAIL, 'qa-other@example.test']) {
      const store = slotStore();
      const { result } = await slotRun(store, value, options);
      assert.deepEqual(result.blocks, [
        { key: 'hidden-email', outcome: 'pass', source: 'discovered' },
      ]);
      const text = savedFile(store, 'hidden-email');
      assert.ok(
        text.includes(
          '# 1. Fill "qa-hidden-email" with input EMAIL\n- tapOn: { id: "qa-hidden-email" }\n- inputText: { input: "EMAIL" }',
        ),
        text,
      );
      assert.equal(text.includes(value), false);
      const stored = readBlock(text);
      assert.ok('steps' in stored, JSON.stringify(stored));
      assert.equal(stored.steps[0].input, 'EMAIL');
      assert.equal(storedMatches(block, stored), true);
      assert.equal(storedFits(block, stored, text, store), true);
      files.push(text);
    }
    assert.equal(files[0], files[1]);
  });

  test(`a saved wrapper slot fill replays through the same fallback when ${shape}`, async () => {
    const store = slotStore();
    const walk = await slotRun(store, EMAIL, options);
    assert.deepEqual(walk.result.blocksWritten, ['hidden-email']);
    const before = savedFile(store, 'hidden-email');
    const { fake, result } = await slotRun(store, 'qa-other@example.test', options);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
    assert.equal(result.path, 'replay');
    assert.deepEqual(result.blocks, [{ key: 'hidden-email', outcome: 'pass', source: 'replayed' }]);
    assert.deepEqual(result.blocksWritten, []);
    assert.deepEqual(steps(fake.log), steps(walk.fake.log));
    assert.deepEqual(fake.typed, [
      { ref: '@wrap', text: 'qa-other@example.test', testID: 'qa-hidden-email' },
    ]);
    assert.deepEqual(fake.focusRequirements, walk.fake.focusRequirements);
    assert.equal(result.jev.calls, 0);
    assert.equal(savedFile(store, 'hidden-email'), before);
  });
}

test('a proven-focus slot fill stores the quoted id and replays the same way', async () => {
  const markdown = `## QA\n\n### Code\n\n1. Fill "qa-otp-code" with input OTP\n2. Tap "qa-hidden-submit"\n`;
  const options = { initial: [submit], initialKeyboard: true, reactFocused: true } as const;
  const fake = app(options);
  const outcome = await withInputs(new RunInputs({ OTP: '5839' }, ['OTP']), () =>
    walkBlock(blocks(markdown)[0], fake.deps),
  );
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.equal(outcome.rows[0].ref, undefined);
  assert.deepEqual(outcome.rows[0].selector, { id: 'qa-otp-code' });
  const store = slotStore();
  const walk = await slotRun(store, '5839', options, markdown);
  assert.deepEqual(walk.result.blocksWritten, ['code']);
  const text = savedFile(store, 'code');
  assert.ok(text.includes('- tapOn: { id: "qa-otp-code" }\n- inputText: { input: "OTP" }'), text);
  const { fake: again, result } = await slotRun(store, '2468', options, markdown);
  assert.equal(result.path, 'replay', JSON.stringify(result.failure));
  assert.deepEqual(result.blocks, [{ key: 'code', outcome: 'pass', source: 'replayed' }]);
  assert.deepEqual(steps(again.log), ['type qa-otp-code', 'press @submit']);
  assert.deepEqual(again.focusRequirements, [true]);
  assert.equal(savedFile(store, 'code'), text);
});

test('login recovery replays a saved slot fill through the fallback', async () => {
  const store = slotStore();
  await slotRun(store, EMAIL);
  const stored = readBlock(savedFile(store, 'hidden-email'));
  assert.ok('steps' in stored);
  const fake = app();
  const outcome = await withInputs(new RunInputs({ EMAIL: EMAIL }, ['EMAIL']), () =>
    walkBlock(loginBlock('hidden-email', stored), fake.deps, 0, [], undefined, undefined, {
      recover: false,
      login: true,
    }),
  );
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.equal(steps(fake.log).filter((s) => s === 'type @wrap').length, 1);
});

test('a slot fill whose field id contains the input value is not stored and stays unsavable', async () => {
  const store = slotStore();
  const fake = app();
  // Parsed outside the run: the plan hash alone would refuse a plan that quotes the value.
  const parsed = blocks(slotPlan());
  const result = await withInputs(new RunInputs({ EMAIL: 'qa-hidden-email' }, ['EMAIL']), () =>
    runPlan(parsed, fake.deps, [], store),
  );
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  const block = (result as Ledger).blocks[0];
  assert.equal(block.saved, false);
  assert.match(block.unsavable ?? '', /^line \d+: element has no testID or label$/);
});

test('a slot fill matched only by placeholder on a native input stays unsavable', async () => {
  const field = {
    ...element('@field', '', { kind: 'input', nativeKind: 'input', placeholder: 'Email address' }),
    label: undefined,
  };
  const { result } = await slotRun(
    slotStore(),
    EMAIL,
    { initial: [field, submit] },
    slotPlan('EMAIL', 'Email address'),
  );
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.equal(result.blocks[0].saved, false);
  assert.match(result.blocks[0].unsavable ?? '', /^line \d+: element has no testID or label$/);
});

test('annotated wrapper and focused slots replay current fixtures with symbolic policy', async () => {
  for (const [name, markdown, options] of [
    ['EMAIL', slotPlan().replace('input EMAIL', 'input EMAIL (non-secret)'), {}],
    [
      'OTP',
      '## QA\n### Code\n1. Fill "qa-otp-code" with input OTP (non-secret)\n2. Tap "qa-hidden-submit"',
      { initial: [submit], initialKeyboard: true, reactFocused: true },
    ],
  ] as const) {
    const store = slotStore();
    const first = await slotRun(store, 'first-fixture', options, markdown);
    assert.equal(first.result.verdict, 'PASS');
    const slug = name === 'EMAIL' ? 'hidden-email' : 'code';
    const saved = savedFile(store, slug);
    assert.ok(saved.includes(`input: "${name}", sensitivity: "non-secret"`));
    const stored = readBlock(saved);
    assert.ok('steps' in stored);
    const again = await slotRun(store, 'second-fixture', options, markdown);
    assert.equal(again.result.path, 'replay');
    assert.equal(again.result.verdict, 'PASS');
    assert.equal(again.fake.typed[0].text, 'second-fixture');
    assert.equal(savedFile(store, slug), saved);
    const f = app(options);
    const inputs = new RunInputs(
      { [name]: 'third-fixture', SECRET: 'strict-canary' },
      [name, 'SECRET'],
      undefined,
      [name],
    );
    const register = inputs.expectEcho.bind(inputs);
    const names: (string | undefined)[] = [];
    inputs.expectEcho = (identifier, inputName) => {
      names.push(inputName);
      register(identifier, inputName);
      const candidate = { identifier, label: 'strict-canary' };
      assert.equal(inputs.maskFilledEcho(candidate), candidate);
    };
    const outcome = await withInputs(inputs, () =>
      walkBlock(loginBlock(slug, stored), f.deps, 0, [], undefined, undefined, {
        recover: false,
        login: true,
      }),
    );
    assert.equal(outcome.block.outcome, 'pass');
    assert.deepEqual(names, [name]);
    assert.equal(f.typed[0].text, 'third-fixture');
  }
});

test('fallback focus emits value-free keyboard proof even when the metric sink fails', async () => {
  for (const focused of [false, true]) {
    for (const throwing of [false, true]) {
      const fake = app({ initialKeyboard: true, reactFocused: focused });
      const events: Array<Record<string, unknown>> = [];
      fake.deps.timing = (event) => {
        events.push(event);
        if (throwing) throw Error('private-sink');
      };
      const outcome = await walkBlock(blocks(plan())[0], fake.deps);
      assert.equal(outcome.block.outcome, focused ? 'pass' : 'fail');
      const proofs = events.filter((event) => event.stage === 'keyboard');
      assert.equal(proofs.length, 1);
      assert.equal(proofs[0].keyboard, true);
      assert.equal(proofs[0].proof, focused ? 'focused' : 'not-proven');
      assert.equal(typeof proofs[0].ms, 'number');
      assert.equal(Object.hasOwn(proofs[0], 'path'), false);
      assert.equal(JSON.stringify(proofs).includes('qa-hidden-email'), false);
      assert.equal(JSON.stringify(proofs).includes(EMAIL), false);
    }
  }
});

test('no-target fallback focus never times its keyboard proof from an earlier line dispatch', async () => {
  const other = element('@other', 'Other', { testID: 'qa-other' });
  const shown = [other, submit];
  const fake = app({ initial: shown, initialKeyboard: true, reactFocused: true });
  const press = fake.deps.press;
  fake.deps.press = async (ref, context) => {
    const result = await press(ref, context);
    shown.push(element('@pressed', 'Pressed', { kind: 'text' }));
    return result;
  };
  const events: Array<Record<string, unknown>> = [];
  fake.deps.timing = (event) => {
    events.push(event);
  };
  const outcome = await walkBlock(
    blocks('## QA\n\n### Code\n\n1. Tap "qa-other"\n2. Fill "qa-otp-code" with "1234"\n')[0],
    fake.deps,
  );
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(mutations(fake.log), ['press @other', 'type qa-otp-code']);
  const proofs = events.filter((event) => event.stage === 'keyboard');
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].proof, 'focused');
  assert.equal(Object.hasOwn(proofs[0], 'ms'), false);
});

for (const route of ['tap', 'no-target'] as const) {
  test(`keyboard-up runtime-input ${route} focus probe never reads or transmits a private prefill`, async () => {
    const prefill = 'private-prefilled-address';
    let valueReads = 0;
    const input = {
      tag: 5,
      type: 'RCTSinglelineTextInputView',
      memoizedProps: {
        testID: 'qa-hidden-email',
        get value() {
          valueReads++;
          return prefill;
        },
        onChangeText() {},
      },
      stateNode: { isFocused: () => true },
      child: null,
      sibling: null,
      return: null as unknown,
    };
    const root = {
      tag: 0,
      type: { displayName: 'PrivateForm' },
      memoizedProps: {},
      child: input,
      sibling: null,
      return: null,
    };
    input.return = root;
    const context = vm.createContext({
      setTimeout,
      clearTimeout,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers: new Map([[1, {}]]),
        getFiberRoots: () => new Set([{ current: root }]),
      },
    });
    vm.runInContext(INJECTED_HELPERS, context);
    const responses: string[] = [];
    const client = {
      evaluate: async (expression: string) => {
        const value = vm.runInContext(expression, context) as string;
        responses.push(value);
        return { value };
      },
    } as never;
    const fake = app({
      initialKeyboard: true,
      ...(route === 'no-target' ? { initial: [submit] } : {}),
    });
    fake.deps.reactFocused = (testID) => reactFocused(client, testID);
    const outcome = await withInputs(new RunInputs({ EMAIL }, ['EMAIL']), () =>
      walkBlock(blocks(slotPlan())[0], fake.deps),
    );
    assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
    assert.equal(fake.typed.length, 1);
    assert.ok(responses.length > 0);
    assert.equal(valueReads, 0);
    for (const response of responses) {
      assert.equal(response.includes(prefill), false);
      assert.equal(JSON.parse(response).value, null);
      assert.equal(JSON.parse(response).focused, true);
    }
    assert.ok(fake.notes.includes(FOCUS_NOTE(route === 'tap' ? 'tap' : 'none', 'focused')));
  });
}
