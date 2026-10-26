import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASK, ObservedPrivacy, matchPrivate } from '../../../dist/qa/privacy.js';
import { join, describe, type NativeNode } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { decideScreen } from '../../../dist/qa/resolve.js';

for (const [kind, entered, caret] of [
  ['Button', '5', false],
  ['Other', '50', true],
  ['Other', '50', false],
  ['Button', '5038', false],
] as const) {
  test(`${kind} cells containing ${entered}, caret=${caret}, mask every outward projection`, async () => {
    const nodes: NativeNode[] = [
      { ref: '@row', index: 0, type: 'Other', rect: { x: 0, y: 300, width: 402, height: 60 } },
    ];
    for (let i = 0; i < 4; i++) {
      const cell = nodes.length;
      const x = i * (44 + (402 - 176) / 3);
      nodes.push({
        ref: `@cell${i}`,
        index: cell,
        parentIndex: 0,
        type: kind,
        label: entered[i],
        identifier: 'otp-input',
        hittable: true,
        rect: { x, y: 300, width: 44, height: 60 },
      });
      if (entered[i] && kind === 'Other')
        nodes.push({
          ref: `@glyph${i}`,
          index: nodes.length,
          parentIndex: cell,
          type: 'StaticText',
          label: entered[i],
          rect: { x: x + 13, y: 313, width: 17, height: 34 },
        });
      if (caret && i === 1)
        nodes.push({
          ref: '@caret',
          index: nodes.length,
          parentIndex: cell,
          type: 'Other',
          rect: { x: x + 31, y: 313, width: 2, height: 34 },
        });
    }
    const captured = join(nodes, []);
    const privacy = new ObservedPrivacy(['5038']);
    privacy.didFill('5038');
    privacy.observe(captured);
    for (const char of entered) {
      assert.equal(privacy.screenText(captured).join(' | ').includes(char), false);
      const mask = privacy.maskForModel([], []);
      for (const node of captured.elements)
        assert.equal(mask.describeElement(node, describe).includes(char), false);
      for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
        assert.equal(
          matchPrivate(`observed ${char}`, privacy.privateSet(), policy).text.includes(char),
          false,
        );
    }
    assert.equal(privacy.canScreenshot(), false);
    const f = walker(
      [screen([element('@pin', 'Code', { kind: 'input', testID: 'pin' })]), captured],
      scriptedJudge(() => assert.fail('literal fill is model-free')),
      { ok: false, proven: false, mutation: 'observed', error: 'fill interrupted' },
    );
    const blocks = parsePlan('1. Type "5038" into "pin"\n✓ "Ready"').blocks!;
    const ledger = await runPlan(blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    for (const char of entered) assert.equal(ledger.failure!.seen.includes(char), false);
    assert.equal(ledger.failure!.screenshot, undefined);
  });
}

test('fragment protection starts at fill dispatch and persists across navigation', () => {
  const privacy = new ObservedPrivacy(['5038']);
  assert.equal(privacy.redact('5 | 0'), '5 | 0');
  privacy.didFill('5038');
  const later = screen([element('@digit', '5', { kind: 'text' })]);
  privacy.observe(later);
  assert.deepEqual(privacy.screenText(later), [MASK]);
  assert.equal(privacy.redact('5 | 0'), `${MASK} | ${MASK}`);
  assert.equal(privacy.redactIdentifier('row-5'), MASK);
  assert.equal(privacy.maskForModel([], []).apply('5  0'), `${MASK}  ${MASK}`);
});

test('non-secret fills leave partial text and unrelated digits readable', () => {
  const privacy = new ObservedPrivacy(['Alice', '47']);
  privacy.didFill('Alice');
  privacy.didFill('47');
  const captured = screen([element('@digit', '5', { kind: 'text' })]);
  privacy.observe(captured);
  assert.deepEqual(privacy.screenText(captured), ['5']);
  assert.equal(privacy.redact('Al 4 7'), 'Al 4 7');
  assert.equal(privacy.canScreenshot(), true);
});

test('secure fills mask contiguous fragments without assigning complete-value identity', () => {
  const privacy = new ObservedPrivacy(['p@ss']);
  privacy.concealFallback('p@ss', true);
  assert.equal(privacy.redact('p'), 'p');
  privacy.didFill('p@ss');
  const captured = screen([element('@echo', 'p@s', { kind: 'text' })]);
  privacy.observe(captured);
  assert.deepEqual(privacy.screenText(captured), [MASK]);
  const mask = privacy.maskForModel(['p@ss'], []);
  assert.equal(mask.apply('p'), 'p');
  assert.equal(mask.apply('p@ss'), mask.tokens[0]);
  assert.equal(mask.apply(mask.tokens[0]), mask.tokens[0]);
  assert.equal(mask.applyPlanLine('1. Tap "p@s"'), `1. Tap ${MASK}`);
  assert.equal(mask.apply('ps'), 'ps');
  assert.equal(privacy.canScreenshot(), false);
});

test('dispatching one code does not enable fragment matching for future codes', () => {
  const privacy = new ObservedPrivacy(['5038', '7291']);
  privacy.didFill('5038');
  assert.equal(privacy.redact('7 | 2'), '7 | 2');
  assert.equal(privacy.redact('5 | 0'), `${MASK} | ${MASK}`);
});

test('fragment matching leaves noncontiguous secure text and numeric runs readable', () => {
  for (const [secret, readable] of [
    ['hunter-canary-77', ['hnr', 'h', 'h!n!r']],
    ['4815', ['45', '85', '148', 'row-45']],
    ['5038', ['58', '305', 'row-58']],
  ] as const) {
    const privacy = new ObservedPrivacy([secret]);
    privacy.concealFallback(secret, true);
    privacy.didFill(secret);
    for (const text of readable)
      for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
        assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text, hit: false });
  }
});

test('filled numeric codes mask contiguous runs and retain complete-value identity', () => {
  const privacy = new ObservedPrivacy(['4815']);
  privacy.didFill('4815');
  for (const text of ['4', '8', '1', '5', '48', '81', '15', '481', '815', 'row-48'])
    for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text: MASK, hit: true });
  const mask = privacy.maskForModel(['4815'], []);
  assert.equal(mask.apply('"4815"'), `"${mask.tokens[0]}"`);
  assert.equal(mask.apply(mask.tokens[0]), mask.tokens[0]);
});

test('formatted numeric codes protect normalized partial runs', () => {
  const privacy = new ObservedPrivacy(['48-15']);
  privacy.didFill('48-15');
  for (const text of ['4', '8', '1', '5', '48', '81', '15', 'row-48'])
    for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text: MASK, hit: true });
  for (const text of ['45', '85', '148']) assert.equal(privacy.redact(text), text);
  const mask = privacy.maskForModel(['48-15'], []);
  assert.equal(mask.apply('"48-15"'), `"${mask.tokens[0]}"`);
  assert.equal(mask.apply('"4815"'), `"${mask.tokens[0]}"`);
});

test('secure punctuation fragments overlap at their shared character', () => {
  const privacy = new ObservedPrivacy(['p@s@word']);
  privacy.concealFallback('p@s@word', true);
  privacy.didFill('p@s@word');
  for (const text of ['p@s', 's@w', 'xs@wx'])
    for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text: MASK, hit: true });
  const mask = privacy.maskForModel(['p@s@word'], []);
  assert.equal(mask.apply('"p@s@word"'), `"${mask.tokens[0]}"`);
});

test('secure fragments do not mask unrelated words, identifiers or saved-block syntax', () => {
  const privacy = new ObservedPrivacy(['hunter-canary-77']);
  privacy.concealFallback('hunter-canary-77', true);
  privacy.didFill('hunter-canary-77');
  const readable = 'Step 1 of 2 | qa-start | the welcome banner is visible | Almost done';
  const syntax = '- tapOn: { id: "qa-start" }';
  for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const) {
    for (const text of [readable, syntax, 'open-the-code-screen'])
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text, hit: false });
    for (const text of ['h', '77', 'ps', 'p!s'])
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text, hit: false });
    for (const text of ['hunter', 'hun', 'r-c'])
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text: MASK, hit: true });
  }
});

test('secure fragments embedded in longer words mask the containing token', () => {
  const privacy = new ObservedPrivacy(['hunter-canary-77']);
  privacy.concealFallback('hunter-canary-77', true);
  privacy.didFill('hunter-canary-77');
  for (const text of ['xhunx', 'xhunterx', 'prefixcanarysuffix'])
    for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), { text: MASK, hit: true });
});

test('attached symbols in secure fragments are masked with their containing token', () => {
  const privacy = new ObservedPrivacy(['p@ss']);
  privacy.concealFallback('p@ss', true);
  privacy.didFill('p@ss');
  const mask = privacy.maskForModel(['p@ss'], []);
  for (const fragment of ['p@s', 'xp@sx', 'p@s!']) {
    const captured = screen([element('@echo', fragment, { kind: 'text' })]);
    privacy.observe(captured);
    assert.deepEqual(privacy.screenText(captured), [MASK]);
    assert.equal(privacy.redact(fragment), MASK);
    assert.equal(privacy.redactIdentifier(fragment), MASK);
    assert.equal(mask.apply(fragment), MASK);
    assert.equal(mask.applyPlanLine(`1. ${fragment}`), `1. ${MASK}`);
    assert.equal(mask.describeElement(captured.elements[0], describe).includes('@'), false);
    for (const policy of ['model', 'durable', 'identifier', 'persisted'] as const)
      assert.deepEqual(matchPrivate(fragment, privacy.privateSet(), policy), {
        text: MASK,
        hit: true,
      });
    assert.equal(privacy.canScreenshot(), false);
  }
  assert.equal(mask.apply('p@ss'), mask.tokens[0]);
  assert.equal(mask.apply(mask.tokens[0]), mask.tokens[0]);
});

test('prefixed complete values remain protected before fragment masking', () => {
  const privacy = new ObservedPrivacy(['5038', 'alice@example.test']);
  privacy.didFill('5038');
  for (const text of ['Account:alice@example.test', 'Text "alice@example.test"']) {
    assert.equal(privacy.redact(text), text.replace('alice@example.test', MASK));
    assert.equal(privacy.redactIdentifier(text), text.replace('alice@example.test', MASK));
    for (const policy of ['durable', 'identifier', 'persisted'] as const)
      assert.deepEqual(matchPrivate(text, privacy.privateSet(), policy), {
        text: text.replace('alice@example.test', MASK),
        hit: true,
      });
  }
  const captured = screen([element('@echo', 'alice@example.test', { kind: 'text' })]);
  privacy.observe(captured);
  const mask = privacy.maskForModel(['5038', 'alice@example.test'], []);
  assert.equal(
    mask.describeElement(captured.elements[0], describe).includes('alice@example.test'),
    false,
  );
  assert.equal(mask.apply('Account:alice@example.test'), `Account:${mask.tokens[1]}`);
});

test('quoted complete codes retain model identity and definite phrase checks', async () => {
  const privacy = new ObservedPrivacy(['5038']);
  privacy.didFill('5038');
  const mask = privacy.maskForModel(['5038'], []);
  assert.equal(mask.apply('"5038"'), `"${mask.tokens[0]}"`);
  assert.equal(mask.apply('Code:5038'), `Code:${mask.tokens[0]}`);
  assert.equal(mask.applyPlanLine('1. Type "5038"'), `1. Type "${mask.tokens[0]}"`);
  assert.deepEqual(
    matchPrivate('"5038" 5', privacy.privateSet(), 'model', () => '[identity3]'),
    {
      text: `"[identity3]" ${MASK}`,
      hit: true,
    },
  );
  const captured = screen([element('@code', 'Code:5038', { kind: 'text' })]);
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.99 }])),
  );
  const decision = await decideScreen(
    captured,
    judge,
    { kind: 'check', text: '"5038" is visible', literal: false, line: 1 },
    undefined,
    ['5038'],
    privacy,
  );
  assert.equal(decision.check, 'pass');
  assert.equal(judge.requests.length, 1);
});

test('every contiguous three-character fragment of a secure secret is masked, whatever its characters', () => {
  const policies = ['model', 'durable', 'identifier', 'persisted'] as const;
  const filled = (secret: string) => {
    const privacy = new ObservedPrivacy([secret]);
    privacy.concealFallback(secret, true);
    privacy.didFill(secret);
    return privacy;
  };
  const privacy = filled('ab@#!c');
  const masked = ['ab@', 'b@#', '@#!', '#!c', 'x@#!y', 'b@#!c', '#!c#!c', 'row:@#!'];
  const readable = ['a@c', 'b#c', '@!', 'ac', 'abc', '!c', 'Step 4 of 8', '148', 'Ordinary text'];
  for (const policy of policies) {
    for (const text of masked)
      assert.deepEqual(
        matchPrivate(text, privacy.privateSet(), policy),
        { text: MASK, hit: true },
        text,
      );
    for (const text of readable)
      assert.deepEqual(
        matchPrivate(text, privacy.privateSet(), policy),
        { text, hit: false },
        text,
      );
  }
  assert.equal(privacy.redact('Ordinary text then @#!c'), `Ordinary text then ${MASK}`);
  const accented = filled('café!é');
  for (const text of ['fé!', 'é!é', 'fé!', 'é!é'])
    assert.deepEqual(
      matchPrivate(text, accented.privateSet(), 'durable'),
      { text: MASK, hit: true },
      text,
    );
  for (const text of ['af', 'ca', 'cé', 'Shop closed'])
    assert.deepEqual(
      matchPrivate(text, accented.privateSet(), 'durable'),
      { text, hit: false },
      text,
    );
});

test('the publish window clears earlier sensitive pixels for the video, never for screenshots', () => {
  const privacy = new ObservedPrivacy(['ada@example.com']);
  privacy.observe(screen([element('@email', 'ada@example.com', { kind: 'text' })]));
  privacy.startWindow();
  assert.equal(privacy.windowClean(), false);
  privacy.observe(screen([element('@title', 'Settings', { kind: 'text' })]));
  assert.equal(privacy.windowClean(), false);
  privacy.startWindow();
  assert.equal(privacy.windowClean(), true);
  assert.equal(privacy.canScreenshot(), false);
  privacy.observe(screen([element('@greeting', 'Signed in as ada@example.com', { kind: 'text' })]));
  assert.equal(privacy.windowClean(), false);
});

test('a case-changed echo of a typed value dirties the publish window', () => {
  const privacy = new ObservedPrivacy(['alice@example.test']);
  privacy.startWindow();
  privacy.observe(
    screen([element('@greeting', 'Signed in as Alice@Example.TEST', { kind: 'text' })]),
  );
  assert.equal(privacy.windowClean(), false);
});

test('a concealed fill dirties the publish window until its field leaves the screen', () => {
  const privacy = new ObservedPrivacy(['123456']);
  const form = screen([element('@otp', '', { kind: 'input', testID: 'otp_code' })]);
  privacy.observe(form);
  privacy.concealFallback('123456', false, 'otp_code');
  privacy.observe(form);
  privacy.startWindow();
  assert.equal(privacy.windowClean(), false);
  privacy.observe(screen([element('@done', 'Login complete', { kind: 'text' })]));
  privacy.startWindow();
  assert.equal(privacy.windowClean(), true);
});
