import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlan,
  parsePlanWithJev,
  parseStep,
  preparePlan,
  readPreparedPlan,
} from '../../../dist/qa/plan.js';
import { decideScreen, prepareTarget } from '../../../dist/qa/resolve.js';
import { assertionView, join, screenSignature } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { redactEvidence, projectPlanLine } from '../../../dist/qa/privacy.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const classify = (verb: string) =>
  scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, verb)])),
  );
const noulJudge = (noul: number) =>
  scriptedJudge((questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        q.type === 'noul' ? { type: 'noul', noul } : choice(q),
      ]),
    ),
  );

test('fallback fill value roles are structural, not a second verb or target-word classifier', async () => {
  for (const verb of ['Insert', 'Put', 'Populate', 'Supply', 'Transcribe', 'Please insert']) {
    for (const relation of ['into', 'in']) {
      const markdown = `1. ${verb} "Anton" ${relation} the name field`;
      const judge = classify('fill');
      const parsed = await parsePlanWithJev(markdown, judge);
      assert.ok(parsed.blocks, markdown);
      const item = parsed.blocks[0].items[0];
      assert.ok(item.kind === 'fill');
      assert.equal(item.text, 'Anton');
      assert.equal(judge.requests.length, 1);
      assert.deepEqual(
        readPreparedPlan(markdown, preparePlan(markdown, parsed.blocks)),
        parsed.blocks,
      );
      assert.ok(!JSON.stringify(judge.requests).includes('Anton'));
    }
  }
});

test('fallback target-first quotes need an explicit value marker; relational target prose never supplies a value', async () => {
  for (const line of [
    'Populate the field associated with "Email"',
    'Change the field whose label ends with "Email"',
    'Populate the field next to "Email"',
    'Populate the field with "Email"',
    'Populate the field named "Email" in the profile',
    'Put "Email" next to the field',
    'Insert "Email" from the field',
    'Set the field to "Email"',
    'Populate with value "Email"',
  ]) {
    assert.ok((await parsePlanWithJev(`1. ${line}`, classify('fill'))).refused, line);
  }
  for (const marker of ['text', 'value', 'the text', 'the value']) {
    const line = `Populate the field associated with Email with ${marker} "Anton"`;
    const result = await parsePlanWithJev(`1. ${line}`, classify('fill'));
    assert.ok(result.blocks, line);
    const item = result.blocks[0].items[0];
    assert.ok(item.kind === 'fill');
    assert.equal(item.text, 'Anton');
  }
});

test('Phase 2 fill grammar stays model-free and retains its original shapes', async () => {
  const judge = scriptedJudge(() => {
    throw new Error('grammar must win');
  });
  for (const line of [
    'Fill "Name" with "Anton"',
    'Fill the name field with "Anton"',
    'Type "Anton" into "Name"',
    'Enter "Anton" in the name field',
    'Write "Anton" on the name field',
  ]) {
    const original = parseStep(line);
    assert.ok(original && !('refuse' in original) && original.kind === 'fill');
    const parsed = await parsePlanWithJev(`1. ${line}`, judge);
    assert.ok(parsed.blocks);
    assert.deepEqual(parsed.blocks[0].items[0], {
      ...original,
      line: 1,
      raw: `1. ${line}`,
      source: 'grammar',
    });
    assert.equal(original.text, 'Anton');
  }
  assert.equal(judge.requests.length, 0);
});

test('native-only Android input labels are private outward data, not rewritten local identities', async () => {
  for (const secure of [false, true]) {
    for (const label of ['native-private-text', '42', '1']) {
      const observed = join(
        [
          {
            ref: '@input',
            type: 'android.widget.EditText',
            label,
            identifier: 'address1',
            secure,
            hittable: true,
          },
          { ref: '@notice', type: 'android.widget.TextView', label: `Echo: ${label}` },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
      const before = JSON.stringify(observed.elements);
      const judge = noulJudge(0.9);
      const decision = await decideScreen(
        observed,
        judge,
        { kind: 'check', literal: false, text: 'The confirmation is visible', line: 1 },
        { kind: 'fill', target: { phrase: 'the address1 field' }, text: 'replacement', line: 2 },
      );
      assert.deepEqual(decision.check, {
        refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
        reason: 'no established assertion contribution is available',
      });
      assert.equal(decision.target, undefined);
      assert.equal(decision.visibility, undefined);
      assert.equal(judge.requests.length, 0);
      const standalone = await decideScreen(observed, judge, undefined, {
        kind: 'fill',
        target: { phrase: 'the address1 field' },
        text: 'replacement',
        line: 2,
      });
      assert.ok(standalone.target && 'ref' in standalone.target);
      assert.equal(standalone.target.ref, '@input');
      assert.equal(judge.requests.length, 1);
      assert.deepEqual(Object.keys(judge.requests[0].questions), ['target_2']);
      assert.equal(Object.hasOwn(judge.requests[0].state, 'assertionEvidence'), false);
      const request = JSON.stringify(judge.requests);
      assert.ok(!request.includes(`Echo: ${label}`));
      assert.ok(!request.includes(`"${label}"`));
      if (label.length > 2) assert.ok(!request.includes(label));
      assert.ok(request.includes('address1'));
      assert.equal(JSON.stringify(observed.elements), before);
      assert.equal(observed.elements[0].label, label);
      assert.equal(observed.elements[0].testID, 'address1');
      const exact = prepareTarget(
        { kind: 'fill', target: { quoted: 'address1', phrase: 'address1' }, text: 'replacement' },
        observed,
      );
      assert.ok('ref' in exact);
      assert.equal(exact.ref, '@input');
      const evidence = redactEvidence(observed, assertionView(observed).join(' '));
      assert.equal(evidence.includes(`Echo: ${label}`), !secure && label.length < 3);
    }
  }
});

test('secure value collisions never destroy exact labels, IDs, or placeholders', async () => {
  for (const key of ['label', 'identifier', 'placeholder'] as const) {
    const observed = join(
      [
        {
          ref: '@password',
          type: 'SecureTextField',
          label: key === 'label' ? 'Password' : 'Field',
          identifier: key === 'identifier' ? 'Password' : 'secret-input',
          value: 'Password',
          hittable: true,
        },
      ],
      [
        {
          role: 'textinput',
          testID: key === 'identifier' ? 'Password' : 'secret-input',
          placeholder: key === 'placeholder' ? 'Password' : undefined,
          value: 'Password',
        },
      ],
    );
    const target = prepareTarget(
      { kind: 'fill', target: { quoted: 'Password', phrase: 'Password' }, text: 'new-secret' },
      observed,
    );
    assert.ok('ref' in target, key);
    assert.equal(target.ref, '@password');
    assert.ok(!redactEvidence(observed, assertionView(observed).join(' ')).includes('Password'));
    const signature = JSON.parse(screenSignature(observed));
    assert.equal(signature.elements[0][3], null);
    assert.equal(signature.elements[0][2], observed.elements[0].testID);
    observed.captureCoverage = { native: 'complete', react: 'unknown' };
    const f = walker([observed], noulJudge(0.9));
    const result = await runPlan(
      parsePlan('1. Type "new-secret" into "Password"\n✓ "Missing"').blocks!,
      f.deps,
    );
    assert.deepEqual(f.actions, ['fill @password new-secret']);
    assert.equal(result.failure?.step, 2);
    assert.ok(!JSON.stringify(result).includes('Password'));
  }
});

test('screen signatures ignore secure contents but still detect ordinary input and layout changes', () => {
  for (const secure of [false, true]) {
    const observe = (value: string) =>
      join(
        [
          {
            ref: '@input',
            type: 'android.widget.EditText',
            identifier: 'input',
            label: value,
            secure,
            hittable: true,
          },
        ],
        [],
      );
    const before = observe('private-one');
    const after = observe('private-two');
    assert.equal(screenSignature(before).includes('private-one'), !secure);
    assert.equal(screenSignature(before) === screenSignature(after), secure);
    after.elements[0].disabled = true;
    assert.notEqual(screenSignature(before), screenSignature(after));
  }
  const observe = (value: string) =>
    join(
      [
        {
          ref: '@input',
          type: 'SecureTextField',
          identifier: 'password',
          label: 'Password',
          value,
        },
      ],
      [],
    );
  assert.equal(screenSignature(observe('Password')), screenSignature(observe('different-secret')));
});

test('human evidence masks overlapping native and typed values together without changing short typed-value policy', () => {
  for (const [native, typed] of [
    ['abcSECRET', 'abc'],
    ['abc', 'abcSECRET'],
  ]) {
    const observed = join(
      [{ ref: '@input', type: 'android.widget.EditText', label: native, secure: true }],
      [],
    );
    assert.ok(
      !redactEvidence(observed, `native=${native}; typed=${typed}`, [typed]).includes('SECRET'),
    );
  }
  assert.equal(
    projectPlanLine('1. Type "1" into "address1"', {
      values: [{ text: '1', provenance: 'typed' }],
    }).text,
    '1. Type "•••" into "address1"',
  );
});

test('observed private values stay masked after a fill, a screen change and a block boundary', async () => {
  for (const boundary of ['\n', '\n### Result\n']) {
    const before = join(
      [
        {
          ref: '@password',
          type: 'SecureTextField',
          identifier: 'password-input',
          label: 'Password',
          value: 'Password',
          hittable: true,
        },
      ],
      [],
    );
    const after = join(
      [
        {
          ref: '@password',
          type: 'SecureTextField',
          identifier: 'password-input',
          label: 'Password',
          value: 'new-secret',
          hittable: true,
        },
      ],
      [],
    );
    const confirmation = screen(
      [element('@message', 'Saved Password', { kind: 'text' })],
      ['Saved Password'],
    );
    const judge = noulJudge(0.9);
    before.captureCoverage = { native: 'complete', react: 'unknown' };
    after.captureCoverage = { native: 'complete', react: 'unknown' };
    const f = walker([before, after, confirmation], judge);
    const markdown = `### Form\n1. Type "new-secret" into "Password"${boundary}✓ The saved confirmation is visible`;
    const result = await runPlan(parsePlan(markdown).blocks!, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.ok(result.steps.every((row) => row.outcome === 'pass'));
    assert.deepEqual(f.actions, ['fill @password new-secret']);
    assert.ok(!JSON.stringify(result).includes('Password'));
    assert.ok(!JSON.stringify(judge.requests).includes('Password'));
  }
});

test('current short private values cannot expose suffixes of an earlier private value in failure evidence', async () => {
  const before = join(
    [
      {
        ref: '@input',
        type: 'android.widget.EditText',
        identifier: 'input',
        label: 'abcSECRET',
        secure: true,
        hittable: true,
      },
    ],
    [],
  );
  const after = join(
    [
      {
        ref: '@input',
        type: 'android.widget.EditText',
        identifier: 'input',
        label: 'abc',
        secure: true,
        hittable: true,
      },
      { ref: '@echo', type: 'android.widget.TextView', label: 'Echo abcSECRET' },
    ],
    [],
  );
  const f = walker([before, after, after], noulJudge(0.9));
  const result = await runPlan(
    parsePlan('1. Type "new-secret" into "input"\n✓ "Missing"').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('adding inputs cannot disable readable validation messages or promote body text to a heading', async () => {
  for (const [text, visibleText] of [
    ['The email validation error is visible', ['Email format is invalid']],
    ['The email field error says the format is invalid', ['Email format is invalid']],
    ['The email field shows a validation error', ['Email format is invalid']],
    ['The email field is invalid', ['Email format is invalid']],
    ['The profile heading shows Anton', ['Profile: Anton']],
    ['The name was saved successfully', ['Name saved successfully']],
  ] as const) {
    for (const noul of [0.7, 0.3, 0.5]) {
      for (const inputs of [
        [],
        [
          element('@email', 'Email', { kind: 'input', value: 'a@b.test' }),
          element('@name', 'Name', { kind: 'input', value: 'Anton' }),
        ],
      ]) {
        const judge = noulJudge(noul);
        const result = await decideScreen(
          screen(
            [...inputs, element('@message', visibleText[0], { kind: 'text' })],
            [...visibleText],
          ),
          judge,
          { kind: 'check', literal: false, text, line: 1 },
          undefined,
          ['Anton'],
        );
        if (text === 'The profile heading shows Anton') {
          assert.equal(judge.requests.length, 0, 'body text cannot establish a heading');
          assert.equal(result.check, 'unsure');
          continue;
        }
        assert.equal(judge.requests.length, 1, text);
        assert.equal(judge.requests[0].questions.check_1.type, 'noul');
        assert.equal(result.check, noul >= 0.7 ? 'pass' : noul <= 0.3 ? 'fail' : 'unsure', text);
        assert.ok(!JSON.stringify(judge.requests).includes('Anton'));
        assert.ok(!JSON.stringify(judge.requests).includes('a@b.test'));
      }
    }
  }
});

test('permission names are opaque to dialog grammar, including arbitrary multiword names', async () => {
  for (const permission of [
    'Bluetooth',
    'photo library',
    'tracking',
    'nearby Wi-Fi devices',
    'Photos and Videos',
    'Arbitrary Widget Ω',
  ]) {
    for (const [verb, action] of [
      ['Accept', 'accept'],
      ['Allow', 'accept'],
      ['Dismiss', 'dismiss'],
      ['Deny', 'dismiss'],
    ] as const) {
      for (const noun of ['dialog', 'prompt', 'alert']) {
        const text = `${verb} the ${permission} permission ${noun}`;
        assert.deepEqual(parseStep(text), { kind: 'dialog', action }, text);
        const grammar = await parsePlanWithJev(
          `1. ${text}`,
          scriptedJudge(() => {
            throw new Error('grammar must win');
          }),
        );
        assert.ok(grammar.blocks, text);
        const fallback = await parsePlanWithJev(`1. Please ${text}`, classify('dialog'));
        assert.ok(fallback.blocks, text);
        const item = fallback.blocks[0].items[0];
        assert.ok(item.kind === 'dialog' && item.action === action, text);
      }
    }
  }
});

test('arbitrary permission names do not bypass negation, conditions or conflicting actions', async () => {
  for (const line of [
    'Please do not allow the Bluetooth permission prompt',
    'Accept the photo library permission dialog unless it requires access',
    'Allow the tracking permission alert if it is safe',
    'Accept after confirming the Bluetooth permission dialog',
    'Allow once ready the tracking permission alert',
    'Please accept or dismiss the nearby Wi-Fi permission prompt',
    'Please explain how to allow the tracking permission alert',
  ])
    assert.ok((await parsePlanWithJev(`1. ${line}`, classify('dialog'))).refused, line);
});

function nativeLiteralScreen(label: string, secure = false, value?: string) {
  const observed = join(
    [
      {
        ref: '@input',
        type: 'android.widget.EditText',
        label,
        secure,
        value,
        identifier: 'input',
        hittable: true,
      },
      { ref: '@done', type: 'android.widget.Button', label: 'Done', hittable: true },
    ],
    [],
  );
  observed.captureCoverage = { native: 'complete', react: 'unknown' };
  return observed;
}

const noLiteralModel = () =>
  scriptedJudge(() => {
    throw new Error('literal assertions and quoted targets must be model-free');
  });

test('native-only Android text proves a local literal while the redacted run refuses lost React', async () => {
  const observed = nativeLiteralScreen('Anton');
  const judge = noLiteralModel();
  const f = walker([observed], judge);
  const result = await runPlan(parsePlan('✓ "Anton"\n1. Tap "Done"').blocks!, f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.steps[0].outcome, 'pass');
  assert.deepEqual(assertionView(observed), ['Anton', 'Done']);
  assert.deepEqual(f.actions, ['press @done']);
  assert.equal(result.steps[0].text, '✓ "•••"');
  assert.ok(!JSON.stringify(result).includes('Anton'));
  assert.ok(!JSON.stringify(f.rows).includes('Anton'));
  assert.equal(result.jev.calls, 0);
  assert.equal(judge.requests.length, 0);
});

test('local literal mask glyphs absent from the screen fail and stop the next action', async () => {
  const judge = noLiteralModel();
  const f = walker([nativeLiteralScreen('Anton')], judge);
  const result = await runPlan(parsePlan('✓ "•••"\n1. Tap "Done"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 1);
  assert.deepEqual(f.actions, []);
  assert.equal(result.steps.length, 1);
  assert.ok(!JSON.stringify(result).includes('Anton'));
  assert.ok(!JSON.stringify(f.rows).includes('Anton'));
  assert.equal(result.jev.calls, 0);
  assert.equal(judge.requests.length, 0);
});

test('local literal and quoted wait still match actual visible bullets', async () => {
  const observed = nativeLiteralScreen('•••', true, 'hidden-secret');
  assert.equal(observed.elements[0].value, undefined);
  assert.deepEqual(assertionView(observed), ['•••', 'Done']);
  const judge = noLiteralModel();
  const f = walker([observed], judge);
  const result = await runPlan(
    parsePlan('✓ "•••"\n1. Wait for "•••"\n2. Tap "Done"').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'REFUSED');
  assert.ok(result.steps.every((row) => row.outcome === 'pass'));
  assert.deepEqual(f.actions, ['press @done']);
  assert.ok(!JSON.stringify(result).includes('hidden-secret'));
  assert.equal(result.jev.calls, 0);
  assert.equal(judge.requests.length, 0);
});

test('local quoted wait cannot succeed on generated privacy masks', async () => {
  const judge = noLiteralModel();
  const f = walker([nativeLiteralScreen('Anton')], judge);
  const result = await runPlan(parsePlan('1. Wait for "•••"\n2. Tap "Done"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 1);
  assert.deepEqual(f.actions, []);
  assert.equal(result.steps.length, 1);
  assert.ok(!JSON.stringify(result).includes('Anton'));
  assert.equal(result.jev.calls, 0);
  assert.equal(judge.requests.length, 0);
});

test('local literals cannot read secure value properties that are not visible', async () => {
  const observed = nativeLiteralScreen('Password', true, 'hidden-secret');
  assert.deepEqual(assertionView(observed), ['Password', 'Done']);
  const judge = noLiteralModel();
  const f = walker([observed], judge);
  const result = await runPlan(parsePlan('✓ "hidden-secret"\n1. Tap "Done"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 1);
  assert.deepEqual(f.actions, []);
  assert.ok(!JSON.stringify(result).includes('hidden-secret'));
  assert.equal(result.jev.calls, 0);
  assert.equal(judge.requests.length, 0);
});
