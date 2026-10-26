import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASK,
  ObservedPrivacy,
  matchPrivate,
  projectPlanLine,
  codeBoxRows,
} from '../../../dist/qa/privacy.js';
import { join, describe, type NativeNode } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { parsePlan, parsePlanWithJev } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';

for (const code of ['4', '48']) {
  test(`proven short code ${code} is protected as a whole token outside its row`, async () => {
    const captured = join(
      [
        ...Array.from({ length: 4 }, (_, i) => ({
          ref: `@box${i}`,
          type: 'StaticText',
          label: code[i] ?? '',
          rect: { x: i * 48, y: 100, width: 42, height: 42 },
        })),
        { ref: '@caption', type: 'StaticText', label: `Code ${code}` },
        { ref: '@echo', type: 'StaticText', label: code },
      ],
      [],
    );
    const privacy = new ObservedPrivacy([code]);
    privacy.didFill(code);
    assert.equal(privacy.redact(`Code ${code}`), `Code ${code}`);
    privacy.observe(captured);
    assert.deepEqual(privacy.screenText(captured), ['[code]', `Code ${MASK}`, MASK]);
    assert.equal(privacy.redact(`Code ${code}`), `Code ${MASK}`);
    assert.equal(privacy.redact(code), MASK);
    assert.equal(privacy.redactIdentifier(`code-${code}`), `code-${MASK}`);
    assert.deepEqual(privacy.privateSet().fragments, []);
    for (const text of ['148', ...(code === '48' ? ['Step 4 of 8', '4 8'] : ['Step 8 of 9'])])
      for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
        assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text, hit: false });
    for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
      assert.equal(matchPrivate(`Code ${code}`, privacy.privateSet(), policy).hit, true);
    const mask = privacy.maskForModel([code], []);
    for (const text of [code, `Code ${code}`]) {
      assert.equal(mask.apply(text).includes(code), false);
      assert.equal(mask.applyPlanLine(`1. Tap "${text}"`).includes(code), false);
    }
    for (const node of captured.elements.slice(4))
      assert.equal(mask.describeElement(node, describe).includes(code), false);
    const f = walker(
      [screen([element('@pin', 'Code', { kind: 'input', testID: 'pin' })]), captured],
      scriptedJudge(() => assert.fail('literal fill is model-free')),
      { ok: false, proven: false, mutation: 'observed', error: 'fill interrupted' },
    );
    const blocks = parsePlan(`1. Type "${code}" into "pin"\n✓ "Ready"`).blocks!;
    const ledger = await runPlan(blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.ok(ledger.failure!.seen.includes(`Code ${MASK}`), ledger.failure!.seen);
    assert.equal(ledger.failure!.seen.includes(code), false);
  });
}

test('short fills without matching code rows preserve ordinary numbers', () => {
  const privacy = new ObservedPrivacy(['2', '48']);
  privacy.didFill('2');
  privacy.didFill('48');
  const ordinary = screen([
    element('@input', 'Number', { kind: 'input', value: '2' }),
    element('@caption', 'Step 2 of 3', { kind: 'text' }),
  ]);
  privacy.observe(ordinary);
  assert.ok(privacy.screenText(ordinary).includes('Step 2 of 3'));
  assert.equal(privacy.redact('2 48 Step 4 of 8 148'), '2 48 Step 4 of 8 148');
  const unmatchedRow = join(
    Array.from({ length: 4 }, (_, i) => ({
      ref: `@box${i}`,
      type: 'StaticText',
      label: '59'[i] ?? '',
      rect: { x: i * 48, y: 100, width: 42, height: 42 },
    })),
    [],
  );
  privacy.observe(unmatchedRow);
  assert.equal(privacy.redact('48'), '48');
});

function accessibleCodeCells(
  type: 'Button' | 'Other',
  code: string,
  mismatch?: 'parent' | 'geometry',
) {
  const nodes: NativeNode[] = [
    { ref: '@row', index: 0, type: 'Other', rect: { x: 0, y: 100, width: 192, height: 42 } },
    { ref: '@unrelated', index: 1, type: 'Other' },
    ...Array.from({ length: 4 }, (_, i) => ({
      ref: `@box${i}`,
      index: i + 2,
      parentIndex: mismatch === 'parent' && i > 0 ? 1 : 0,
      type,
      label: code[i] ?? '',
      rect: {
        x: i * 48,
        y: mismatch === 'geometry' && i > 0 ? 200 : 100,
        width: 42,
        height: 42,
      },
    })),
    { ref: '@caption', type: 'StaticText', label: `Code ${code}` },
    { ref: '@echo', type: 'StaticText', label: code },
    { ref: '@ordinary', type: 'StaticText', label: 'Step 4 of 8 | 148' },
  ];
  return join(nodes, []);
}

for (const type of ['Button', 'Other'] as const) {
  for (const code of ['4', '48']) {
    test(`${type} cells with short fill ${code} and blank siblings protect outward evidence`, async () => {
      const captured = accessibleCodeCells(type, code);
      const privacy = new ObservedPrivacy([code]);
      privacy.didFill(code);
      privacy.observe(captured);
      assert.equal(codeBoxRows(captured, [code])[0]?.length, 4);
      assert.deepEqual(privacy.screenText(captured), [
        '[code]',
        `Code ${MASK}`,
        MASK,
        code === '48' ? 'Step 4 of 8 | 148' : `Step ${MASK} of 8 | 148`,
      ]);
      assert.equal(privacy.redact(`Code ${code}`), `Code ${MASK}`);
      assert.equal(privacy.redact(code), MASK);
      assert.deepEqual(privacy.privateSet().fragments, []);
      const mask = privacy.maskForModel([], []);
      for (const box of captured.elements.filter((element) => element.ref.startsWith('@box')))
        assert.equal(mask.describeElement(box, describe), 'box (hidden)');
      for (const ref of ['@caption', '@echo']) {
        const node = captured.elements.find((element) => element.ref === ref)!;
        assert.equal(mask.describeElement(node, describe).includes(code), false);
      }
      assert.equal(privacy.redact('148 | Unrelated caption'), '148 | Unrelated caption');
      if (code === '48') assert.equal(privacy.redact('Step 4 of 8'), 'Step 4 of 8');
      const f = walker(
        [screen([element('@pin', 'Code', { kind: 'input', testID: 'pin' })]), captured],
        scriptedJudge(() => assert.fail('literal fill is model-free')),
        { ok: false, proven: false, mutation: 'observed', error: 'fill interrupted' },
      );
      const ledger = await runPlan(
        parsePlan(`1. Type "${code}" into "pin"\n✓ "Ready"`).blocks!,
        f.deps,
      );
      assert.equal(ledger.verdict, 'FAIL');
      assert.ok(ledger.failure!.seen.includes(`Code ${MASK}`), ledger.failure!.seen);
      assert.equal(ledger.failure!.seen.includes(`Code ${code}`), false);
      assert.equal(ledger.failure!.screenshot, undefined);
    });
  }

  for (const mismatch of ['parent', 'geometry'] as const) {
    test(`${type} blank cells with mismatched ${mismatch} do not establish a short code`, () => {
      const captured = accessibleCodeCells(type, '4', mismatch);
      const privacy = new ObservedPrivacy(['4']);
      privacy.didFill('4');
      privacy.observe(captured);
      assert.deepEqual(codeBoxRows(captured, ['4']), []);
      assert.ok(privacy.screenText(captured).includes('Code 4'));
      assert.equal(privacy.redact('Code 4 | Step 4 of 8 | 148'), 'Code 4 | Step 4 of 8 | 148');
      const box = captured.elements.find((element) => element.ref === '@box0')!;
      assert.ok(privacy.maskForModel([], []).describeElement(box, describe).includes('"4"'));
    });
  }
}

for (const code of ['', '7', '1234']) {
  test(`ordinary Button row ${JSON.stringify(code)} stays readable after unrelated short fill`, () => {
    const captured = accessibleCodeCells('Button', code);
    const privacy = new ObservedPrivacy(['48']);
    privacy.didFill('48');
    privacy.observe(captured);
    assert.deepEqual(codeBoxRows(captured, ['48']), []);
    assert.ok(privacy.screenText(captured).includes(`Code ${code}`.trim()));
    assert.equal(privacy.redact('Step 4 of 8 | 148'), 'Step 4 of 8 | 148');
    for (const box of captured.elements.filter((element) => element.ref.startsWith('@box')))
      assert.notEqual(privacy.maskForModel([], []).describeElement(box, describe), 'box (hidden)');
  });
}

for (const code of ['4815', '1122', '9382']) {
  test(`structural code row ${code} ignores wrappers and repeated text`, () => {
    const screen = join(
      [...code].flatMap((label, i) => [
        { ref: `@group${i}`, type: 'Group' },
        {
          ref: `@box${i}`,
          type: 'StaticText',
          label,
          rect: { x: i * 48, y: 100, width: 32, height: 40 },
        },
      ]),
      [],
    );
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.deepEqual(privacy.screenText(screen), [...code]);
    privacy.didFill();
    privacy.observe(screen);
    assert.equal(codeBoxRows(screen).length, 1);
    assert.deepEqual(privacy.screenText(screen), ['[code]']);
    const mask = privacy.maskForModel([], []);
    for (const box of screen.elements.filter((element) => element.kind === 'text'))
      assert.equal(mask.describeElement(box, describe), 'box (hidden)');
    assert.equal(privacy.redact('1 | 2 | 3 | 4'), '1 | 2 | 3 | 4');
    assert.deepEqual(privacy.privateSet().values, []);
  });
}

for (const representation of ['label', 'value'] as const) {
  for (const labels of [
    ['9', '', '', ''],
    ['9', '', '', '3'],
    ['9', '3', '8', ''],
    ['9', '9', '9', ''],
  ]) {
    test(`partially filled ${representation} code row ${JSON.stringify(labels)} counts empty boxes`, () => {
      const captured = join(
        labels.map((label, i) => ({
          ref: `@box${i}`,
          type: 'StaticText',
          label: '',
          [representation]: label,
          rect: { x: i * 48, y: 100, width: 42, height: 42 },
        })),
        [],
      );
      assert.equal(codeBoxRows(captured)[0]?.length, 4);
      const privacy = new ObservedPrivacy();
      privacy.observe(captured);
      assert.equal(privacy.canScreenshot(), true);
      privacy.didFill();
      privacy.observe(captured);
      assert.deepEqual(privacy.screenText(captured), ['[code]']);
      assert.equal(privacy.canScreenshot(), false);
      const mask = privacy.maskForModel([], []);
      for (const box of captured.elements)
        assert.equal(mask.describeElement(box, describe), 'box (hidden)');
      assert.equal(privacy.redact('step 9 of 93'), 'step 9 of 93');
    });
  }
}

for (const [width, typed, wrapped, entered] of [
  [354, '5038', false, '5038'],
  [402, '5038', false, '5038'],
  [402, '503', false, '503'],
  [402, '5038', true, '5038'],
  [402, '5038', false, '50'],
  [402, '5038', true, '50'],
  [402, '5038', false, '5'],
  [402, '5038', true, '5'],
  [402, '5038', false, '08'],
  [402, '5038', false, '123'],
] as const) {
  test(`spread pressable cells with glyph-width${wrapped ? ' wrapped' : ''} text in ${width}pt hide ${entered} from filled ${typed}`, async () => {
    const cells = 4;
    const gap = (width - cells * 44) / (cells - 1);
    const nodes: NativeNode[] = [
      { ref: '@row', index: 0, type: 'Other', rect: { x: 0, y: 300, width, height: 60 } },
    ];
    for (let i = 0; i < cells; i++) {
      const x = i * (44 + gap);
      const cell = nodes.length;
      const char = entered[i];
      nodes.push({
        ref: `@cell${i}`,
        index: cell,
        parentIndex: 0,
        type: 'Other',
        identifier: 'otp-input',
        hittable: true,
        ...(char ? { label: char } : {}),
        rect: { x, y: 300, width: 44, height: 60 },
      });
      if (wrapped)
        nodes.push({
          ref: `@glyph${i}`,
          index: nodes.length,
          parentIndex: cell,
          type: 'Other',
          rect: { x: x + 13, y: 313, width: 17, height: 34 },
        });
      const parent = nodes.length - 1;
      nodes.push(
        char
          ? {
              ref: `@char${i}`,
              index: parent + 1,
              parentIndex: parent,
              type: 'StaticText',
              label: char,
              rect: { x: x + 13, y: 313, width: 17, height: 34 },
            }
          : {
              ref: `@stick${i}`,
              index: parent + 1,
              parentIndex: parent,
              type: 'Other',
              rect: { x: x + 21, y: 315, width: 2, height: 30 },
            },
      );
    }
    nodes.push({
      ref: '@hidden',
      index: nodes.length,
      parentIndex: 0,
      type: 'TextField',
      identifier: 'otp-input-hidden',
      value: entered,
      rect: { x: 0, y: 300, width: 25, height: 46 },
    });
    const captured = join(nodes, []);
    const privacy = new ObservedPrivacy([typed]);
    privacy.didFill(typed);
    privacy.observe(captured);
    assert.equal(privacy.canScreenshot(), false);
    const text = privacy.screenText(captured);
    assert.ok(text.includes('[code]'), JSON.stringify(text));
    for (const char of entered)
      assert.equal(
        text.some((line) => line.includes(char)),
        false,
        JSON.stringify(text),
      );
    const mask = privacy.maskForModel([], []);
    for (const element of captured.elements)
      for (const char of entered)
        assert.equal(mask.describeElement(element, describe).includes(` ${char}`), false);
    if (entered === '50' && !wrapped) {
      const initial = screen([element('@pin', 'Code', { kind: 'input', testID: 'pin' })]);
      const f = walker(
        [initial, captured],
        scriptedJudge(() => assert.fail('literal fill is model-free')),
        { ok: false, proven: false, mutation: 'observed', error: 'fill interrupted' },
      );
      const blocks = parsePlan('1. Type "5038" into "pin"\n✓ "Ready"').blocks;
      assert.ok(blocks);
      const ledger = await runPlan(blocks, f.deps);
      assert.equal(ledger.verdict, 'FAIL');
      assert.ok(ledger.failure?.seen.includes('[code]'), ledger.failure?.seen);
      assert.equal(ledger.failure?.seen.includes('5 | 0'), false);
      assert.equal(ledger.failure?.screenshot, undefined);
    }
  });
}

test('an unrelated lone digit matching a filled secret is masked', () => {
  const captured = join(
    [
      { ref: '@cell', index: 0, type: 'Other', rect: { x: 0, y: 300, width: 44, height: 60 } },
      {
        ref: '@digit',
        index: 1,
        parentIndex: 0,
        type: 'StaticText',
        label: '5',
        rect: { x: 13, y: 313, width: 17, height: 34 },
      },
    ],
    [],
  );
  const privacy = new ObservedPrivacy(['5038']);
  privacy.didFill('5038');
  privacy.observe(captured);
  assert.deepEqual(codeBoxRows(captured, ['5038']), []);
  assert.deepEqual(privacy.screenText(captured), [MASK]);
  assert.equal(privacy.canScreenshot(), false);
  assert.notEqual(
    privacy.maskForModel([], []).describeElement(captured.elements[1], describe),
    'box (hidden)',
  );
});

for (const [typed, texts, entered] of [
  ['5038', [0], '5038'],
  ['503', [1, 2], '503'],
  ['5038', [0], '50'],
  ['5038', [], '5'],
] as const) {
  test(`accessible pressable cells labelled by their character hide ${entered} from filled ${typed}`, () => {
    const nodes: NativeNode[] = [
      { ref: '@row', index: 0, type: 'Other', rect: { x: 0, y: 300, width: 402, height: 60 } },
    ];
    for (let i = 0; i < 4; i++) {
      const x = i * (44 + (402 - 176) / 3);
      const cell = nodes.length;
      nodes.push({
        ref: `@cell${i}`,
        index: cell,
        parentIndex: 0,
        type: 'Other',
        identifier: 'otp-input',
        hittable: true,
        ...(entered[i] ? { label: entered[i] } : {}),
        rect: { x, y: 300, width: 44, height: 60 },
      });
      if ((texts as readonly number[]).includes(i))
        nodes.push({
          ref: `@char${i}`,
          index: cell + 1,
          parentIndex: cell,
          type: 'StaticText',
          label: entered[i],
          rect: { x: x + 13, y: 313, width: 17, height: 34 },
        });
    }
    const captured = join(nodes, []);
    const privacy = new ObservedPrivacy([typed]);
    privacy.didFill(typed);
    privacy.observe(captured);
    const text = privacy.screenText(captured);
    assert.ok(text.includes('[code]'), JSON.stringify(text));
    for (const char of typed)
      assert.equal(
        text.some((line) => line.includes(char)),
        false,
        JSON.stringify(text),
      );
    const mask = privacy.maskForModel([], []);
    for (const element of captured.elements)
      for (const char of typed)
        assert.equal(mask.describeElement(element, describe).includes(` ${char}`), false);
  });
}

test('a text code row stays masked beside an unrelated one-character control', () => {
  const captured = join(
    [
      ...['9', '3', '8'].map((label, i) => ({
        ref: `@box${i}`,
        type: 'StaticText',
        label,
        rect: { x: i * 48, y: 100, width: 42, height: 42 },
      })),
      { ref: '@plus', type: 'Button', label: '+', rect: { x: 150, y: 100, width: 42, height: 42 } },
    ],
    [],
  );
  const privacy = new ObservedPrivacy();
  privacy.didFill();
  privacy.observe(captured);
  const text = privacy.screenText(captured);
  assert.ok(text.includes('[code]'), JSON.stringify(text));
  for (const char of '938') assert.equal(text.includes(char), false, JSON.stringify(text));
});

test('a keypad that is not the filled value stays readable after filling', () => {
  for (const type of ['Button', 'Other']) {
    const captured = join(
      ['1', '2', '3'].map((label, i) => ({
        ref: `@${i}`,
        type,
        label,
        rect: { x: 40 + i * 110, y: 600, width: 100, height: 60 },
      })),
      [],
    );
    const privacy = new ObservedPrivacy(['5038']);
    privacy.didFill();
    privacy.observe(captured);
    assert.deepEqual(codeBoxRows(captured, ['5038']), []);
  }
});

test('empty rows alone do not establish a private code', () => {
  const captured = join(
    ['', '', '', ''].map((label, i) => ({
      ref: `@box${i}`,
      type: 'StaticText',
      label,
      rect: { x: i * 48, y: 100, width: 42, height: 42 },
    })),
    [],
  );
  assert.deepEqual(codeBoxRows(captured), []);
});

for (const value of ['938', '999']) {
  test(`partial numeric value ${value} is projected across separators at every policy`, () => {
    for (const separator of [', ', ' | ', ' / ', '\u202f', '---']) {
      const grouped = [...value].join(separator);
      for (const [privateValue, echo] of [
        [value, grouped],
        [grouped, value],
      ]) {
        for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const) {
          const result = matchPrivate(
            echo,
            { values: [{ text: privateValue, provenance: 'typed' }] },
            policy,
          );
          assert.equal(result.text, MASK);
          assert.equal(result.hit, true);
        }
      }
    }
  });
}

test('keypads, counters and separated text stay readable after filling', () => {
  for (const type of ['Button', 'Cell', 'TextField']) {
    const screen = join(
      ['1', '2', '3', '4'].map((label, i) => ({
        ref: `@${i}`,
        type,
        label,
        rect: { x: i * 48, y: 100, width: 32, height: 40 },
      })),
      [],
    );
    assert.deepEqual(codeBoxRows(screen), []);
  }
});

test('shared policies combine trimming, normalization and digit separators', () => {
  const privacy = new ObservedPrivacy([' Café ', '1234567890', 'CanaryAlpha77']);
  for (const value of ['Cafe\u0301', ' Café ', '1234/5678/90', '1234-5678-90', 'CanaryAlpha77']) {
    assert.equal(privacy.redact(value), MASK);
    assert.equal(matchPrivate(value, privacy.privateSet(), 'persisted').hit, true);
    assert.equal(
      privacy.maskForModel(privacy.modelValues(), []).apply(value).includes(value),
      false,
    );
  }
  const target = element('@account', 'Account', { testID: 'account-1234-5678-90' });
  assert.equal(
    privacy.maskForModel([], []).describeElement(target, describe).includes('1234'),
    false,
  );
  assert.equal(target.testID, 'account-1234-5678-90');
});

test('short typed values only mask quoted slots and input values', () => {
  const privacy = new ObservedPrivacy(['1', '47']);
  assert.equal(
    projectPlanLine('1. Type "1" into "address1"', privacy.privateSet()).text,
    '1. Type "•••" into "address1"',
  );
  assert.equal(projectPlanLine('Type "47"', privacy.privateSet(), 'persisted').hit, true);
  assert.equal(privacy.redact('step 1 of 47'), 'step 1 of 47');
  const input = element('@input', 'Age', { kind: 'input', value: '47' });
  const screen = { front: 'app' as const, elements: [input], visibleText: ['Age: 47'] };
  privacy.observe(screen);
  assert.deepEqual(privacy.screenText(screen), ['Age: •••']);
  assert.equal(privacy.maskForModel([], []).describeElement(input, describe).includes('47'), false);
});

test('secure length one is a whole token and secure length two masks substrings', () => {
  const set = {
    values: [
      { text: '7', provenance: 'secret' as const },
      { text: 'pw', provenance: 'secret' as const },
    ],
  };
  assert.equal(matchPrivate('x7x 7 apwb', set, 'durable').text, `x7x ${MASK} a${MASK}b`);
});

test('a protected mask still reports a persisted hit', () => {
  assert.deepEqual(
    matchPrivate(MASK, { values: [{ text: MASK, provenance: 'typed' }] }, 'persisted'),
    { text: MASK, hit: true },
  );
});

test('Unicode digit grouping matches both directions at every policy', () => {
  for (const separator of ['\u00a0', '\u202f', '\u0085', '\ufeff', '\t', '\n', '.', '-', '/']) {
    const grouped = `1234${separator}5678${separator}90`;
    for (const [privateValue, echo] of [
      [grouped, '1234567890'],
      ['1234567890', grouped],
    ]) {
      for (const provenance of ['typed', 'observed', 'concealed', 'secret'] as const) {
        const set = { values: [{ text: privateValue, provenance }] };
        for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const) {
          const projected = matchPrivate(`Account ${echo} ready`, set, policy, () => '[opaque]');
          assert.deepEqual(projected, {
            text: `Account ${policy === 'model' ? '[opaque]' : MASK} ready`,
            hit: true,
          });
        }
      }
      const privacy = new ObservedPrivacy();
      privacy.observe({
        front: 'app',
        visibleText: [],
        elements: [element('@input', 'Account', { kind: 'input', value: privateValue })],
      });
      const label = element('@echo', `Account ${echo} ready`, { kind: 'text' });
      const later = { front: 'app' as const, visibleText: [label.label!], elements: [label] };
      privacy.observe(later);
      assert.deepEqual(privacy.screenText(later), [`Account ${MASK} ready`]);
      const mask = privacy.maskForModel([], []);
      assert.equal(mask.describeElement(label, describe).includes(echo), false);
      assert.equal(privacy.redactIdentifier(`account-${echo}`), `account-${MASK}`);
    }
  }
});

test('both structural prefixes survive model, refusal and ledger projection', async () => {
  for (const prefix of ['123.', '123)']) {
    const privacy = new ObservedPrivacy(['123']);
    const raw = `${prefix} Type "123" into "pin"`;
    assert.equal(
      projectPlanLine(raw, privacy.privateSet()).text,
      `${prefix} Type "•••" into "pin"`,
    );
    assert.equal(projectPlanLine(raw, privacy.privateSet(), 'persisted').hit, true);
    const model = privacy.maskForModel(['123'], [raw]);
    assert.equal(model.applyPlanLine(raw), `${prefix} Type "${model.tokens[0]}" into "pin"`);
    const observed = screen([
      element('@pin', 'PIN', { kind: 'input', testID: 'pin' }),
      element('@ready', 'Ready', { kind: 'text' }),
    ]);
    const f = walker(
      [observed],
      scriptedJudge(() => assert.fail('literal plan is model-free')),
    );
    const blocks = parsePlan(`${raw}\n✓ "Ready"`).blocks;
    assert.ok(blocks);
    const ledger = await runPlan(blocks, f.deps);
    assert.equal(ledger.verdict, 'PASS');
    assert.equal(ledger.steps[0].text, `${prefix} Type "•••" into "pin"`);
    assert.deepEqual(f.actions, ['fill @pin 123']);
    const refused = await parsePlanWithJev(
      `${prefix} Type "123"\n124. Type "123" into "pin"`,
      f.deps.judge!,
    );
    assert.ok(refused.refused);
    assert.equal(refused.refused[0].text, `${prefix} Type "•••"`);
    const secure = { values: [{ text: '1', provenance: 'secret' as const }] };
    for (const punctuation of ['.', ')']) {
      const line = `1${punctuation} Tap "Continue"`;
      assert.deepEqual(projectPlanLine(line, secure, 'persisted'), { text: line, hit: false });
    }
  }
});

function mirroredCodeScreen(entered: string, mirror: string, caption?: string) {
  const nodes: NativeNode[] = [
    { ref: '@row', index: 0, type: 'Other', rect: { x: 0, y: 300, width: 402, height: 60 } },
  ];
  for (let i = 0; i < 4; i++) {
    const x = i * (44 + (402 - 176) / 3);
    const cell = nodes.length;
    nodes.push({
      ref: `@cell${i}`,
      index: cell,
      parentIndex: 0,
      type: 'Other',
      identifier: 'otp-input',
      hittable: true,
      rect: { x, y: 300, width: 44, height: 60 },
    });
    nodes.push(
      entered[i]
        ? {
            ref: `@char${i}`,
            index: cell + 1,
            parentIndex: cell,
            type: 'StaticText',
            label: entered[i],
            rect: { x: x + 13, y: 313, width: 17, height: 34 },
          }
        : {
            ref: `@stick${i}`,
            index: cell + 1,
            parentIndex: cell,
            type: 'Other',
            rect: { x: x + 21, y: 315, width: 2, height: 30 },
          },
    );
  }
  nodes.push({
    ref: '@mirror',
    index: nodes.length,
    type: 'TextField',
    label: mirror,
    value: entered,
    rect: { x: 0, y: 380, width: 300, height: 40 },
  });
  if (caption)
    nodes.push({
      ref: '@caption',
      index: nodes.length,
      type: 'StaticText',
      label: caption,
      rect: { x: 0, y: 440, width: 300, height: 20 },
    });
  return join(nodes, []);
}

for (const typed of ['4', '48', '481']) {
  test(`an input label mirroring its ${typed.length}-character typed code is masked in every projection`, async () => {
    const captured = mirroredCodeScreen(typed, typed);
    const privacy = new ObservedPrivacy([typed]);
    privacy.didFill(typed);
    privacy.observe(captured);
    const text = privacy.screenText(captured);
    assert.deepEqual(text, ['[code]', `${MASK}: ${MASK}`]);
    const mirror = captured.elements.find((element) => element.ref === '@mirror')!;
    assert.equal(
      privacy.maskForModel([], []).describeElement(mirror, describe).includes(`"${typed}"`),
      false,
    );
    const initial = screen([element('@pin', 'Code', { kind: 'input', testID: 'pin' })]);
    const f = walker(
      [initial, captured],
      scriptedJudge(() => assert.fail('literal fill is model-free')),
      { ok: false, proven: false, mutation: 'observed', error: 'fill interrupted' },
    );
    const blocks = parsePlan(`1. Type "${typed}" into "pin"\n✓ "Ready"`).blocks;
    assert.ok(blocks);
    const ledger = await runPlan(blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.ok(ledger.failure?.seen.includes(`${MASK}: ${MASK}`), ledger.failure?.seen);
    assert.equal(ledger.failure?.seen.includes(`${typed}: `), false, ledger.failure?.seen);
  });
}

test('ordinary input labels and short text without a typed origin stay readable', () => {
  const captured = mirroredCodeScreen('48', 'Code', '12');
  const privacy = new ObservedPrivacy(['48']);
  privacy.didFill('48');
  privacy.observe(captured);
  assert.deepEqual(privacy.screenText(captured), ['[code]', `Code: ${MASK}`, '12']);
  const mirror = captured.elements.find((element) => element.ref === '@mirror')!;
  assert.ok(privacy.maskForModel([], []).describeElement(mirror, describe).includes('"Code"'));
});
