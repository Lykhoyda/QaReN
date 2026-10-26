import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlan,
  parsePlanWithJev,
  preparePlan,
  readPreparedPlan,
} from '../../../dist/qa/plan.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { assertionView, join as joinScreen, screenSignature } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createJev, JEV_MODEL } from '../../../dist/qa/jev.js';
import { preflightPlan } from '../../../dist/qa/preflight.js';
import { createWriter, exitCodeFor, resultForWalk } from '../../../dist/qa/wire.js';
import { maskValues, modelMask, redactEvidence } from '../../../dist/qa/privacy.js';
import { JevError } from '../../../dist/qa/questions.js';
import { choice, element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const nameCheck = {
  kind: 'check' as const,
  literal: false,
  text: 'The name field contains Anton',
  line: 2,
};
const nameScreen = (value: string) =>
  screen([element('@name', 'Name', { kind: 'input', value })], [`Name: ${value}`]);
const alwaysYes = () =>
  scriptedJudge((q) =>
    Object.fromEntries(
      Object.entries(q).map(([id, question]) => [
        id,
        question.type === 'noul' ? { type: 'noul', noul: 0.99 } : choice(question),
      ]),
    ),
  );

test('review P1: protected value equality survives projection and an unequal value cannot pass', async () => {
  const matching = alwaysYes();
  const mismatching = alwaysYes();
  const good = await decideScreen(nameScreen('Anton'), matching, nameCheck, undefined, ['Anton']);
  const bad = await decideScreen(nameScreen('Bob'), mismatching, nameCheck, undefined, ['Anton']);
  assert.equal(good.check, 'pass');
  assert.deepEqual(matching.requests[0], mismatching.requests[0]);
  assert.equal(
    bad.check,
    'fail',
    'even a confident model cannot override the locally observed value mismatch',
  );
  for (const requests of [matching.requests, mismatching.requests]) {
    assert.ok(!JSON.stringify(requests).includes('Anton'));
    assert.ok(!JSON.stringify(requests).includes('Bob'));
    const instructions = requests[0].questions.check_2.instructions;
    assert.match(
      instructions,
      /same token in the expectation and observed text is evidence of the same value/,
    );
    assert.match(instructions, /different tokens represent different values/);
    assert.match(instructions, /unmasked text never equals a token's value/);
    assert.match(instructions, /no content, length, format, order or validity/);
  }
  const tokens = (requests: typeof matching.requests) =>
    new Set(JSON.stringify(requests).match(/\[QAREN_VALUE_\d+\]/g));
  assert.equal(tokens(matching.requests).size, 1);
  assert.equal(tokens(mismatching.requests).size, 1);
});

test('protected equality still requires the noul threshold rather than a matching mask alone', async () => {
  for (const [noul, expected] of [
    [0.89, 'pass'],
    [0.58, 'unsure'],
    [0.56, 'unsure'],
  ] as const) {
    const judge = scriptedJudge(() => ({ check_2: { type: 'noul', noul } }));
    const result = await decideScreen(nameScreen('Anton'), judge, nameCheck, undefined, ['Anton']);
    assert.equal(result.check, expected);
    assert.equal(judge.requests.length, 1);
  }
});

test('a protected value in an identifier is not observed assertion text', async () => {
  const judge = alwaysYes();
  const result = await decideScreen(
    screen([element('@greeting', 'Welcome', { kind: 'text', testID: 'Anton' })]),
    judge,
    { kind: 'check', literal: false, text: 'The greeting says Welcome, Anton', line: 2 },
    undefined,
    ['Anton'],
  );
  assert.equal(result.check, 'unsure');
  assert.equal(judge.requests.length, 0);
});

test('review P1: an unparsed check cannot pass on a protected value the screen does not show', async () => {
  const greeting = {
    kind: 'check' as const,
    literal: false,
    text: 'The greeting says Welcome, Anton',
    line: 2,
  };
  for (const [text, expected, asked] of [
    ['Welcome, Anton', 'pass', 1],
    ['Welcome, Bob', 'unsure', 0],
  ] as const) {
    const judge = alwaysYes();
    const decision = await decideScreen(
      screen([element('@greeting', text, { kind: 'text' })]),
      judge,
      greeting,
      undefined,
      ['Anton'],
    );
    assert.equal(decision.check, expected, text);
    assert.equal(judge.requests.length, asked, text);
  }
  const judge = alwaysYes();
  const mismatch = await decideScreen(nameScreen('Bob'), judge, nameCheck, undefined, ['Anton']);
  assert.equal(mismatch.check, 'fail', 'a local mismatch outranks the unobserved-value bound');
});

test('review P1: opaque input values cannot prove hidden semantic properties', async () => {
  for (const text of [
    'The name field contains a valid name',
    'The name field starts with A',
    'The name field has five letters',
    'The PIN field is greater than 18',
  ]) {
    const judge = alwaysYes();
    const observed = text.includes('PIN')
      ? screen([element('@pin', 'PIN', { kind: 'input', value: '12345' })], ['PIN: 12345'])
      : nameScreen('Anton');
    const result = await decideScreen(observed, judge, { ...nameCheck, text }, undefined, [
      'Anton',
      '18',
    ]);
    assert.notEqual(result.check, 'pass', text);
    assert.ok(!JSON.stringify(judge.requests).includes('12345'));
  }
});

test('adding unrelated filled or secure inputs never disables banner checks or changes noul thresholds', async () => {
  for (const [noul, expected] of [
    [0.7, 'pass'],
    [0.3, 'fail'],
    [0.5, 'unsure'],
  ] as const) {
    for (const inputs of [
      [],
      [element('@name', 'Name', { kind: 'input', value: 'Anton' })],
      [element('@pin', 'PIN', { kind: 'input', secure: true })],
      [element('@password', 'Password', { kind: 'input', secure: true, value: 'secret-value' })],
    ]) {
      const judge = scriptedJudge((q) => {
        assert.deepEqual(Object.keys(q), ['check_2']);
        assert.equal(q.check_2.type, 'noul');
        return { check_2: { type: 'noul', noul } };
      });
      const observed = screen(
        [...inputs, element('@saved', 'Saved', { kind: 'text' })],
        [...inputs.map((e) => `${e.label}: ${e.value ?? ''}`), 'Saved'],
      );
      const result = await decideScreen(observed, judge, {
        ...nameCheck,
        text: 'The saved confirmation is visible',
      });
      assert.equal(
        judge.requests.length,
        1,
        'the filled input must not short-circuit the banner question',
      );
      assert.equal(result.check, expected);
      assert.ok(JSON.stringify(judge.requests[0].state).includes('Saved'));
      assert.ok(!JSON.stringify(judge.requests).includes('Anton'));
      assert.ok(!JSON.stringify(judge.requests).includes('secret-value'));
    }
  }
});

test('banner checks with unrelated private inputs retain check-target batching and only act after a pass', async () => {
  for (const noul of [0.9, 0.1]) {
    const judge = scriptedJudge((q) => {
      assert.deepEqual(Object.keys(q.target_2.criteria!), ['e0', 'none']);
      assert.match(q.target_2.criteria!.e0, /Done/);
      return { check_1: { type: 'noul', noul }, target_2: choice(q.target_2, 'e0') };
    });
    const observed = screen(
      [
        element('@name', 'Name', { kind: 'input', value: 'Anton' }),
        element('@saved', 'Saved', { kind: 'text' }),
        element('@done', 'Done'),
      ],
      ['Name: Anton', 'Saved', 'Done'],
    );
    const f = walker([observed], judge);
    const ledger = await runPlan(
      parsePlan('✓ The saved confirmation is visible\n1. Tap Done').blocks!,
      f.deps,
    );
    assert.equal(ledger.verdict, noul > 0.7 ? 'PASS' : 'FAIL');
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(Object.keys(judge.requests[0].questions), ['check_1', 'target_2']);
    assert.deepEqual(f.actions, noul > 0.7 ? ['press @done'] : []);
    assert.ok(!JSON.stringify(judge.requests).includes('Anton'));
  }
});

test('secure value properties remain unknown, but the control presence itself is visible evidence', async () => {
  const observed = screen(
    [element('@password', 'Password', { kind: 'input', secure: true })],
    ['Password', 'Saved'],
  );
  for (const text of [
    'The password field contains Anton',
    'The password field is valid',
    'The password field has five letters',
    'The password field starts with A',
  ]) {
    assert.equal(
      (await decideScreen(observed, alwaysYes(), { ...nameCheck, text }, undefined, ['Anton']))
        .check,
      'unsure',
      text,
    );
  }
  for (const text of ['The password field is visible', 'The password field is not visible']) {
    for (const noul of [0.9, 0.1]) {
      const judge = scriptedJudge(() => ({ check_2: { type: 'noul', noul } }));
      assert.equal(
        (await decideScreen(observed, judge, { ...nameCheck, text })).check,
        noul > 0.7 ? 'pass' : 'fail',
      );
      assert.equal(judge.requests.length, 1);
    }
  }
});

test('review P1: negated, conflicting and unrelated dialog words never authorize an action', async () => {
  for (const line of [
    'Please do not allow the permission prompt',
    'Please never accept the dialog',
    'Please allow or dismiss the permission prompt',
    'Please accept the dialog unless it requests location',
    'Please explain why the permission prompt does not allow login',
    'Please show the allow instructions for the permission prompt',
    'Allow the permission prompt but do not accept it',
    'Accept or dismiss the prompt',
  ]) {
    const judge = scriptedJudge((q) =>
      Object.fromEntries(
        Object.entries(q).map(([id, question]) => [id, choice(question, 'dialog')]),
      ),
    );
    const parsed = await parsePlanWithJev(`1. ${line}`, judge);
    assert.ok(
      parsed.refused?.some((r) => r.line === 1),
      line,
    );
    assert.equal(parsed.blocks, undefined);
  }
});

test('explicit fallback fills and dialog actions keep their original parameters through prepared-plan validation', async () => {
  for (const [line, kind, value] of [
    ['Populate the name field with value "private name"', 'fill', 'private name'],
    ['Please enter “private name” into the name field', 'fill', 'private name'],
    ['Set the name field with text "private name"', 'fill', 'private name'],
    ['Put "private name" in the name field', 'fill', 'private name'],
    ['Please dismiss the permission prompt', 'dialog', 'dismiss'],
    ['Please allow the permission prompt', 'dialog', 'accept'],
  ] as const) {
    const judge = scriptedJudge((q) =>
      Object.fromEntries(Object.entries(q).map(([id, question]) => [id, choice(question, kind)])),
    );
    const markdown = `1. ${line}`;
    const parsed = await parsePlanWithJev(markdown, judge);
    assert.ok(parsed.blocks, line);
    const item = parsed.blocks[0].items[0];
    assert.equal(
      item.kind === 'fill' ? item.text : item.kind === 'dialog' ? item.action : '',
      value,
    );
    assert.deepEqual(
      readPreparedPlan(markdown, preparePlan(markdown, parsed.blocks)),
      parsed.blocks,
    );
  }
});

test('review P1: spatial target quotes are not fallback fill values', async () => {
  for (const line of [
    'Populate the field next to "Email"',
    'Populate the field adjacent to "Email"',
    'Populate the field using "Email"',
    'Populate the "Email" field',
    'Set the field next to "Email"',
    'Set the value of the field next to "Email"',
  ]) {
    const judge = scriptedJudge((q) =>
      Object.fromEntries(Object.entries(q).map(([id, question]) => [id, choice(question, 'fill')])),
    );
    const parsed = await parsePlanWithJev(`1. ${line}`, judge);
    assert.ok(
      parsed.refused?.some((r) => r.line === 1),
      line,
    );
  }
});

test('review P1: all long grammar and fallback fill values are hidden throughout one preflight batch', async () => {
  const markdown = [
    '1. Type "private-credential" into "Token"',
    '2. Confirm the token field contains private-credential',
    '3. Populate the other token field with value "other-private-value"',
    '4. Confirm the other token field contains other-private-value',
    '5. Type "4242" into "PIN"',
    '6. Confirm the PIN is 4242',
  ].join('\n');
  const judge = scriptedJudge((q) =>
    Object.fromEntries(
      Object.entries(q).map(([id, question]) => [
        id,
        choice(question, id === 'verb_3' ? 'fill' : 'check'),
      ]),
    ),
  );
  const parsed = await parsePlanWithJev(markdown, judge);
  assert.ok(parsed.blocks, JSON.stringify(parsed));
  assert.equal(judge.requests.length, 1);
  assert.ok(!JSON.stringify(judge.requests).includes('private-credential'));
  assert.ok(!JSON.stringify(judge.requests).includes('other-private-value'));
  assert.ok(!/\b4242\b/.test(JSON.stringify(judge.requests)));
  assert.deepEqual(
    parsed.blocks[0].items.filter((i) => i.kind === 'fill').map((i) => i.text),
    ['private-credential', 'other-private-value', '4242'],
  );
});

test('review P2: duplicate Android input values are hidden in labels, identifiers, placeholders and instructions', async () => {
  const secret = 'prefilled-private-value';
  const observed = joinScreen(
    [
      {
        ref: '@input',
        type: 'android.widget.EditText',
        label: secret,
        value: secret,
        identifier: `input-${secret}`,
        hittable: true,
      },
    ],
    [
      {
        role: 'textinput',
        testID: `input-${secret}`,
        value: secret,
        placeholder: `Replace ${secret}`,
      },
    ],
    'app',
    { native: 'complete', react: 'complete' },
  );
  const judge = alwaysYes();
  await decideScreen(
    observed,
    judge,
    undefined,
    {
      kind: 'fill',
      target: { phrase: `the input containing ${secret}` },
      text: 'replacement',
      line: 1,
    },
    ['replacement'],
  );
  assert.equal(judge.requests.length, 1);
  assert.ok(!JSON.stringify(judge.requests).includes(secret));
});

test('secure input copies keep their local identities but stay out of outward evidence', async () => {
  const secret = 'private-secure-value';
  const observed = joinScreen(
    [
      {
        ref: '@pin',
        type: 'android.widget.EditText',
        secure: true,
        label: secret,
        value: secret,
        identifier: `pin-${secret}`,
        hittable: true,
      },
      { ref: '@copy', type: 'android.widget.TextView', label: `Copy: ${secret}` },
    ],
    [
      {
        role: 'textinput',
        testID: `pin-${secret}`,
        placeholder: `Replace ${secret}`,
        value: secret,
      },
    ],
    'app',
    { native: 'complete', react: 'complete' },
  );
  assert.equal(observed.elements[0].label, secret);
  assert.equal(observed.elements[0].testID, `pin-${secret}`);
  assert.equal(observed.elements[0].placeholder, `Replace ${secret}`);
  assert.ok(!redactEvidence(observed, assertionView(observed).join(' ')).includes(secret));
  const signature = JSON.parse(screenSignature(observed));
  assert.equal(signature.elements[0][1], null);
  assert.equal(signature.elements[0][3], null);
  assert.equal(signature.elements[0][2], `pin-${secret}`);
  assert.ok(signature.text.includes(`Copy: ${secret}`));
  const judge = alwaysYes();
  await decideScreen(
    observed,
    judge,
    undefined,
    { kind: 'fill', target: { phrase: 'the PIN field' }, text: '1234', line: 1 },
    ['1234'],
  );
  assert.equal(judge.requests.length, 1);
  assert.ok(!JSON.stringify(judge.requests).includes(secret));
});

test('review P2: short secure values are masked at boundaries without widening typed-value policy', async () => {
  const judge = alwaysYes();
  await decideScreen(
    screen(
      [element('@address', 'address1', { kind: 'input', value: '42', secure: true })],
      ['address1: 42'],
    ),
    judge,
    { ...nameCheck, text: 'The address1 field contains 42' },
    { kind: 'fill', target: { phrase: 'address1' }, text: '1', line: 3 },
    ['42', '1'],
  );
  const request = JSON.stringify(judge.requests);
  assert.ok(!/\b42\b/.test(request));
  assert.ok(request.includes('address1'));
  assert.equal(maskValues('The PIN is 42; address1', ['42', '1']), 'The PIN is 42; address1');
});

test('outbound masks distinguish values, replace once, escape regex syntax and avoid token collisions', () => {
  const mask = modelMask(
    ['111', '4242', 'A+B', 'A+B-long', 'QAREN_VALUE', '111'],
    ['[QAREN_VALUE_1]'],
  );
  const projected = mask.apply('111 4242 address1 142 A+B-long A+B QAREN_VALUE');
  assert.ok(projected.includes('address1 142'));
  assert.ok(!/\b(?:111|4242)\b/.test(projected));
  assert.ok(!projected.includes('A+B'));
  assert.equal(new Set(mask.tokens).size, 5);
  assert.ok(!mask.tokens.includes('[QAREN_VALUE_1]'));
  assert.equal(mask.apply('4242'), mask.apply('4242'));
  assert.notEqual(mask.apply('4242'), mask.apply('111'));
});

test('review P2: swipe gestures normalize into the inverse content-scroll direction', async () => {
  for (const [gesture, direction] of [
    ['up', 'down'],
    ['down', 'up'],
  ] as const) {
    for (const suffix of ['', ' until the footer']) {
      const judge = scriptedJudge((q) =>
        Object.fromEntries(
          Object.entries(q).map(([id, question]) => [id, choice(question, 'scroll')]),
        ),
      );
      const parsed = await parsePlanWithJev(`1. Swipe ${gesture}${suffix}`, judge);
      assert.ok(parsed.blocks);
      const item = parsed.blocks[0].items[0];
      assert.ok(item.kind === 'scroll');
      assert.equal(item.direction, direction);
      assert.equal(!!item.until, !!suffix);
      const walkJudge = scriptedJudge((q, index) => {
        assert.deepEqual(Object.keys(q), ['visibility_1']);
        assert.equal(q.visibility_1.type, 'noul');
        return { visibility_1: { type: 'noul', noul: index ? 0.9 : 0.1 } };
      });
      const f = walker(
        [screen([element('@loading', 'Loading')]), screen([element('@footer', 'Footer')])],
        walkJudge,
      );
      assert.equal((await runPlan(parsed.blocks, f.deps)).verdict, 'PASS');
      assert.deepEqual(f.actions, [`scroll ${direction}`]);
      assert.equal(walkJudge.requests.length, suffix ? 2 : 0);
    }
  }
});

test('review P2: auth/request rejection after good preflight is REFUSED/4 with line and call evidence', async () => {
  for (const status of [400, 401, 403, 422]) {
    let calls = 0;
    const judge = createJev({
      apiKey: 'hermetic-test-key',
      fetch: async () => {
        calls++;
        return calls === 1
          ? Response.json({
              model: JEV_MODEL,
              answers: { preflight: { type: 'noul', noul: 0.99 } },
              usage: { input_tokens: 10 },
            })
          : new Response('not echoed', { status });
      },
    });
    const prepared = await preflightPlan('1. Tap Save', judge);
    assert.ok(prepared.ok);
    const f = walker([screen([element('@save', 'Save')])], judge);
    const result = await runPlan(prepared.prepared.blocks, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    const payloadForWire = resultForWalk(result, 'test-lease');
    assert.equal(exitCodeFor(payloadForWire), 4);
    assert.equal(result.failure?.step, 1);
    assert.equal(result.jev.calls, 2);
    assert.equal(result.jev.callDetails.at(-1)?.status, status);
    assert.deepEqual(f.actions, []);
    const wire: string[] = [];
    const writer = createWriter((line) => {
      wire.push(line);
    }, 'run');
    assert.equal(writer.result(payloadForWire), 4);
    const payload = JSON.parse(wire[0]).payload;
    assert.equal(
      payload.code,
      status === 401 || status === 403 ? 'JEV_AUTH_FAILED' : 'JEV_REQUEST_INVALID',
    );
    assert.equal(payload.lease, 'test-lease');
    assert.equal(payload.jev.calls, 2);
  }
});

test('runtime refusal preserves the current failing line and preflight calls even when screenshot capture fails', async () => {
  const judge = scriptedJudge(() => {
    throw new JevError('JEV_AUTH_FAILED');
  });
  const f = walker([screen([element('@save', 'Save')])], judge);
  let shots = 0;
  f.deps.screenshot = async (name) => {
    if (shots++ > 0) throw new Error('capture failed');
    return name;
  };
  const refused = await runPlan(parsePlan('1. Back\n2. Tap Save').blocks!, f.deps, [
    { scope: 'preflight', questionIds: ['preflight'], inputTokens: 4, ms: 3, outcome: 'ok' },
  ]);
  assert.equal(refused.verdict, 'REFUSED');
  assert.equal(refused.failure?.step, 2);
  assert.equal(refused.failure?.screenshot, undefined);
  assert.deepEqual(
    refused.steps.map((row) => [row.line, row.outcome]),
    [
      [1, 'pass'],
      [2, 'fail'],
    ],
  );
  assert.equal(refused.jev.calls, 2);
  assert.equal(refused.jev.callDetails[0].scope, 'preflight');
});

test('review P2: transient exhaustion and real app failures remain FAIL/1', async () => {
  const judge = createJev({
    apiKey: 'hermetic-test-key',
    sleep: async () => {},
    fetch: async () => new Response('', { status: 529 }),
  });
  const f = walker([screen([element('@save', 'Save')])], judge);
  const result = await runPlan(parsePlan('1. Tap Save').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(exitCodeFor(result), 1);
  assert.equal(result.jev.calls, 3);
  const g = walker([screen([element('@save', 'Save')])], alwaysYes());
  assert.equal((await runPlan(parsePlan('✓ "Not here"').blocks!, g.deps)).verdict, 'FAIL');
});
