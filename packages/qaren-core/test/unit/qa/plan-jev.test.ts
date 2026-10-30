import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  parsePlan,
  parsePlanWithJev,
  planNeedsJev,
  preparePlan,
  readPreparedPlan,
} from '../../../dist/qa/plan.js';
import { preflightPlan } from '../../../dist/qa/preflight.js';
import { JevError } from '../../../dist/qa/questions.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';

test('fallback lines are classified together once and retain line numbers and whole phrases', async () => {
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, 'press')])),
  );
  const markdown =
    '## QA\n1. Visit the account tile\n2. Visit the overview\n3. Tap "Save"\n✓ "Saved"';
  const parsed = await parsePlanWithJev(markdown, judge);
  assert.ok(parsed.blocks, JSON.stringify(parsed));
  assert.equal(judge.requests.length, 1);
  assert.deepEqual(Object.keys(judge.requests[0].questions), ['verb_2', 'verb_3']);
  assert.equal(judge.calls[0].scope, 'parse');
  assert.deepEqual(
    parsed.blocks[0].items
      .slice(0, 2)
      .map((i) => [i.line, i.source, i.kind === 'press' && i.target.phrase]),
    [
      [2, 'jev', 'Visit the account tile'],
      [3, 'jev', 'Visit the overview'],
    ],
  );
  const prepared = preparePlan(markdown, parsed.blocks);
  assert.deepEqual(readPreparedPlan(markdown, JSON.parse(JSON.stringify(prepared))), parsed.blocks);
  const sortKeys = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sortKeys)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sortKeys(entry)]),
          )
        : value;
  assert.deepEqual(
    readPreparedPlan(markdown, sortKeys(JSON.parse(JSON.stringify(prepared)))),
    parsed.blocks,
    'Rust reserializes JSON object keys in a different order',
  );
  assert.equal(readPreparedPlan(markdown + '\n', prepared), undefined);
  const altered = structuredClone(prepared);
  altered.blocks[0].items[0].kind = 'back';
  assert.equal(readPreparedPlan(markdown, altered), undefined);
  assert.equal(judge.requests.length, 1, 'handing off the parsed plan never asks again');
});

test('fallback defines UI navigation as a press and retains the original target phrase', async () => {
  const markdown = '1. Visit the profile tab';
  const judge = scriptedJudge((questions) => {
    const question = questions.verb_1;
    assert.ok(question.type === 'choice');
    assert.match(question.criteria.press, /navigating to a screen or tab/);
    assert.match(question.criteria.press, /pressing its control/);
    return {
      verb_1: choice(question, 'press', {
        press: 0.98,
        fill: 0,
        scroll: 0,
        wait: 0,
        back: 0,
        dialog: 0,
        check: 0,
        unsupported: 0.02,
      }),
    };
  });
  const parsed = await parsePlanWithJev(markdown, judge);
  assert.ok(parsed.blocks);
  assert.equal(judge.requests.length, 1);
  const item = parsed.blocks[0].items[0];
  assert.ok(item.kind === 'press');
  assert.deepEqual(item.target, { phrase: 'Visit the profile tab' });
  assert.equal(item.source, 'jev');
  assert.deepEqual(readPreparedPlan(markdown, preparePlan(markdown, parsed.blocks)), parsed.blocks);
});

test('grammar and literal checks never call the model during parsing', async () => {
  const judge = scriptedJudge(() => {
    throw new Error('must not ask');
  });
  assert.ok((await parsePlanWithJev('1. Tap "Save"\n✓ "Saved"', judge)).blocks);
  const unsafe = await parsePlanWithJev('1. Fill name with a value', judge);
  assert.ok(unsafe.refused?.some((r) => r.line === 1));
  assert.equal(judge.requests.length, 0);
});

test('unsupported, unsure, missing fill text and unsafe parameters refuse at their source line', async () => {
  for (const [line, kind, unsure] of [
    ['Perform a shell command', 'unsupported', false],
    ['Visit the profile', 'press', true],
    ['Populate the name field', 'fill', false],
    ['Populate the "Email" field', 'fill', false],
    ['Populate "Name" with "Anton"', 'fill', false],
    ['Move the list', 'scroll', false],
    ['Respond to the prompt', 'dialog', false],
  ] as const) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          choice(
            q,
            kind,
            unsure
              ? {
                  press: 0.4,
                  fill: 0.3,
                  scroll: 0.1,
                  wait: 0.1,
                  back: 0,
                  dialog: 0,
                  check: 0,
                  unsupported: 0.1,
                }
              : undefined,
          ),
        ]),
      ),
    );
    const parsed = await parsePlanWithJev(`## QA\n1. ${line}`, judge);
    assert.ok(
      parsed.refused?.some((r) => r.line === 2),
      JSON.stringify(parsed),
    );
    assert.equal(parsed.blocks, undefined);
  }
});

test('safe fallback arguments are copied deterministically and values never go to the verb model', async () => {
  for (const [line, kind, fields] of [
    ['Populate the name field with value "Anton-secret"', 'fill', { text: 'Anton-secret' }],
    ['Swipe up', 'scroll', { direction: 'down' }],
    ['Swipe down until the footer', 'scroll', { direction: 'up' }],
    ['Please allow the permission', 'dialog', { action: 'accept' }],
    ['Return to the prior screen', 'back', {}],
    ['Await the profile header', 'wait', {}],
    ['Confirm the profile header is shown', 'check', { literal: false }],
  ] as const) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, kind)])),
    );
    const parsed = await parsePlanWithJev(`1. ${line}`, judge);
    assert.ok(parsed.blocks, JSON.stringify(parsed));
    const item = parsed.blocks[0].items[0];
    assert.equal(item.kind, kind);
    for (const [key, value] of Object.entries(fields)) assert.equal(Reflect.get(item, key), value);
    assert.ok(!JSON.stringify(judge.requests).includes('Anton-secret'));
  }
});

const throwingJudge = () =>
  scriptedJudge(() => {
    throw new Error('a literal plan must not call Jev');
  });

test('planNeedsJev is true only for unrecognised verbs, phrase targets and phrase checks', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../fixtures/plans/${name}`, import.meta.url), 'utf8');
  for (const [plan, needs] of [
    [fixture('literal.md'), false],
    [fixture('phrases.md'), true],
    ['1. Visit profile', true],
    ['1. Tap the save button', true],
    ['✓ the header shows the name', true],
    ['1. Scroll down', false],
    ['1. Scroll down until "Footer"', false],
    ['1. Scroll down until the footer', true],
    ['1. Accept the dialog', false],
    ['1. Go back', false],
    ['1. Tap "A"\n2. Type "x" into "Name"\n3. Wait for "Done"\n✓ "Done"', false],
    ['Not a numbered line', false],
  ] as const)
    assert.equal(planNeedsJev(plan), needs, plan);
});

test('a literal plan preflights without the probe or any Jev call', async () => {
  const markdown = readFileSync(
    new URL('../../fixtures/plans/literal.md', import.meta.url),
    'utf8',
  );
  const judge = throwingJudge();
  const result = await preflightPlan(markdown, judge);
  assert.ok(result.ok);
  assert.equal(result.jevRequired, false);
  assert.equal(result.jev.calls, 0);
  assert.equal(judge.requests.length, 0);
  assert.equal(result.prepared.hash, createHash('sha256').update(markdown).digest('hex'));
  const quoted = await preflightPlan('1. Tap "A"', throwingJudge());
  assert.ok(quoted.ok && quoted.jevRequired === false && quoted.jev.calls === 0);
});

test('a grammar-refused literal plan reports PLAN_UNPARSEABLE without calling Jev', async () => {
  const judge = throwingJudge();
  const result = await preflightPlan('## QA\nTap "A" without a number', judge);
  assert.ok(!result.ok && result.code === 'PLAN_UNPARSEABLE');
  assert.equal(judge.requests.length, 0);
});

test('a plan that needs Jev keeps the fixed probe and reports jevRequired', async () => {
  const judge = scriptedJudge(() => ({ preflight: { type: 'noul', noul: 0.99 } }));
  const result = await preflightPlan('1. Tap the save button', judge);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.jevRequired === true);
  assert.equal(result.jev.calls, 1);
  assert.equal(result.jev.inputTokens, 10);
  assert.deepEqual(judge.requests[0].state, { readiness: 'ready' });
  assert.deepEqual(result.jev.callDetails[0].questionIds, ['preflight']);
  assert.equal(result.jev.callDetails[0].scope, 'preflight');
});

test('a plan that needs Jev refuses JEV_UNREACHABLE when the key is missing or rejected', async () => {
  const judge = scriptedJudge(() => {
    throw new JevError('JEV_AUTH_FAILED');
  });
  const result = await preflightPlan('✓ the header shows the name', judge);
  assert.ok(!result.ok && result.code === 'JEV_UNREACHABLE');
  assert.equal(judge.requests.length, 1);
});

test('preflight does one probe and one fallback batch, not a parse per line', async () => {
  const judge = scriptedJudge((questions, i) =>
    i === 0
      ? { preflight: { type: 'noul', noul: 0.99 } }
      : Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, 'press')])),
  );
  const result = await preflightPlan('1. Visit profile\n2. Visit edit', judge);
  assert.ok(result.ok);
  assert.equal(result.jev.calls, 2);
  assert.deepEqual(
    result.jev.callDetails.map((c) => c.scope),
    ['preflight', 'parse'],
  );
});

test('bad credentials and malformed probe answers refuse without parsing', async () => {
  for (const judge of [
    scriptedJudge(() => {
      throw new JevError('JEV_AUTH_FAILED');
    }),
    scriptedJudge(() => ({})),
    scriptedJudge(() => ({ preflight: { type: 'noul', noul: 0.2 } })),
  ]) {
    const result = await preflightPlan('1. Select profile', judge);
    assert.ok(!result.ok && result.code === 'JEV_UNREACHABLE');
    assert.equal(judge.requests.length, 1);
  }
});

test('only a whole quoted check is literal; mixed expectations retain the readiness probe', async () => {
  for (const payload of [
    '"Welcome"',
    '“Welcome”',
    'The heading shows "Welcome" and no error is visible',
    '"Welcome" and "Ready"',
    '“Welcome” is visible',
  ]) {
    const markdown = `✓ ${payload}`;
    const literal = payload === '"Welcome"' || payload === '“Welcome”';
    const parsed = parsePlan(markdown);
    assert.ok(parsed.blocks);
    const item = parsed.blocks[0].items[0];
    assert.ok(item.kind === 'check');
    assert.equal(item.literal, literal);
    assert.equal(item.text, literal ? 'Welcome' : payload);
    assert.equal(planNeedsJev(markdown), !literal);
    assert.deepEqual(
      readPreparedPlan(markdown, preparePlan(markdown, parsed.blocks)),
      parsed.blocks,
    );
    const judge = scriptedJudge(() => {
      throw new JevError('JEV_AUTH_FAILED');
    });
    const result = await preflightPlan(markdown, judge);
    assert.equal(result.ok, literal);
    if (!result.ok) assert.equal(result.code, 'JEV_UNREACHABLE');
    assert.equal(judge.requests.length, literal ? 0 : 1);
    if (!literal) assert.deepEqual(judge.requests[0].state, { readiness: 'ready' });
  }
});

test('phrase lines require readiness even when another line refuses, in either order', async () => {
  for (const phrase of [
    '✓ The heading shows "Welcome" and no error is visible',
    '1. Tap the save button',
    '1. Type "x" into the name field',
    '1. Fill the name field with "x"',
    '1. Wait for the footer',
    '1. Scroll down until the footer',
    '1. Scroll up until the header',
    '1. Visit the profile',
  ]) {
    for (const refusal of ['2. Type your name into the field', 'unparseable prose']) {
      for (const markdown of [`${phrase}\n${refusal}`, `${refusal}\n${phrase}`]) {
        assert.equal(planNeedsJev(markdown), true, markdown);
        const rejected = scriptedJudge(() => {
          throw new JevError('JEV_AUTH_FAILED');
        });
        const result = await preflightPlan(markdown, rejected);
        assert.ok(!result.ok && result.code === 'JEV_UNREACHABLE', markdown);
        assert.equal(rejected.requests.length, 1);
        assert.deepEqual(rejected.requests[0].state, { readiness: 'ready' });
        assert.equal(rejected.calls[0].scope, 'preflight');
        const ready = scriptedJudge((questions, index) =>
          index === 0
            ? { preflight: { type: 'noul', noul: 0.99 } }
            : Object.fromEntries(
                Object.entries(questions).map(([id, q]) => [id, choice(q, 'press')]),
              ),
        );
        const refused = await preflightPlan(markdown, ready);
        assert.ok(!refused.ok && refused.code === 'PLAN_UNPARSEABLE', markdown);
        assert.equal(ready.calls[0].scope, 'preflight');
      }
    }
  }
});

test('structural refusals retain phrase classification across blocks', () => {
  for (const markdown of [
    '### Empty\n### Next\n✓ the header is visible',
    '### Same\n✓ "Welcome"\n### Same\n1. Tap the save button',
  ]) {
    assert.ok(parsePlan(markdown).refused);
    assert.equal(planNeedsJev(markdown), true);
  }
});

test('refused plans without active phrase lines still skip readiness', async () => {
  for (const markdown of [
    '✓ "Welcome"\n1. Type "x"',
    '### Empty\n### Next\n✓ “Welcome”',
    '## QA\n✓ "Welcome"\nunparseable prose\n## Notes\n1. Tap the save button',
    '<!-- ✓ the header is visible -->\n✓ "Welcome"\nunparseable prose',
  ]) {
    assert.equal(planNeedsJev(markdown), false, markdown);
    const judge = throwingJudge();
    const result = await preflightPlan(markdown, judge);
    assert.ok(!result.ok && result.code === 'PLAN_UNPARSEABLE');
    assert.equal(judge.requests.length, 0);
  }
});

test('verb parsing protects short straight and curly quoted slots while retaining operational values', async () => {
  for (const quoted of ['"47"', '“47”']) {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, choice(q, 'fill')])),
    );
    const parsed = await parsePlanWithJev(`1. Put ${quoted} into age`, judge);
    assert.ok(parsed.blocks, JSON.stringify(parsed));
    const item = parsed.blocks[0].items[0];
    assert.ok(item.kind === 'fill');
    assert.equal(item.text, '47');
    assert.equal(judge.requests.length, 1);
    const request = JSON.stringify(judge.requests);
    assert.equal(request.includes('47'), false);
    assert.match(request, /QAREN_VALUE_/);
  }
});

test('parser and preflight refusals project planned values in heading text and reasons', async () => {
  const canary = 'hunter-canary-77';
  for (const [fill, extra] of [
    [`Type "${canary}" into "email"`, ''],
    [`Put “${canary}” into email`, ''],
    [`Type "${canary}" into "email"`, '\n2. Perform unsupported work'],
  ]) {
    const markdown = `### ${canary}\n1. ${fill}\n### ${canary}\n✓ "Ready"${extra}`;
    const makeJudge = () =>
      scriptedJudge((questions) =>
        Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            id === 'preflight'
              ? { type: 'noul', noul: 0.99 }
              : choice(q, extra ? 'unsupported' : 'fill'),
          ]),
        ),
      );
    const parsed = await parsePlanWithJev(markdown, makeJudge());
    const preflight = await preflightPlan(markdown, makeJudge());
    assert.ok(parsed.refused);
    assert.ok(!preflight.ok && preflight.code === 'PLAN_UNPARSEABLE' && preflight.refused);
    for (const refused of [parsed.refused, preflight.refused]) {
      const duplicate = refused.find((entry) => entry.reason.includes('already named'));
      assert.ok(duplicate);
      if ('text' in duplicate) {
        assert.equal(duplicate.text, '### •••');
        assert.equal(duplicate.reason, 'another block is already named "•••"');
      } else {
        assert.equal(duplicate.reason, 'another block is already named');
        assert.equal(duplicate.nextAction, 'give each block a distinct heading');
      }
      assert.equal(JSON.stringify(refused).includes(canary), false);
    }
  }
});

test('parser and preflight withhold private heading slugs while preserving operational names', async () => {
  for (const canary of ['Alice@Example.com', `Alice@Example.com-${'long-title-'.repeat(12)}`]) {
    for (const duplicate of [canary, canary.replace(/[@.]/g, ' ')]) {
      const markdown = `### ${canary}\n1. Type "${canary}" into "email"\n### ${duplicate}\n✓ "Ready"`;
      const judge = scriptedJudge(() => assert.fail('grammar refusals need no model'));
      const parsed = parsePlan(markdown);
      const preflight = await preflightPlan(markdown, judge);
      assert.ok(parsed.refused);
      assert.ok(!preflight.ok && preflight.refused);
      for (const refused of [parsed.refused, preflight.refused]) {
        const collision = refused.find((entry) => entry.reason.includes('already named'));
        assert.ok(collision);
        assert.equal(
          collision.reason,
          'text' in collision
            ? 'another block is already named "•••"'
            : 'another block is already named',
        );
        assert.equal(JSON.stringify(refused).includes(canary), false);
        assert.equal(JSON.stringify(refused).includes('alice-example-com'), false);
      }
    }
    const accepted = parsePlan(`### ${canary}\n1. Type "${canary}" into "email"`);
    assert.ok(accepted.blocks);
    assert.ok(accepted.blocks[0].slug.startsWith('alice-example-com'));
  }
  const ordinary = parsePlan('### Account\n✓ "Ready"\n### Account\n✓ "Ready"');
  assert.equal(ordinary.refused?.[0].reason, 'another block is already named "account"');
});

test('preflight retains Cleanup actions separately and verifies the prepared handoff', async () => {
  const markdown = [
    '# Disposable record',
    '## QA',
    '1. Tap "Create record"',
    '## Cleanup',
    '### Delete the record',
    '1. Tap "Delete record"',
    '✓ "Record deleted"',
    '## Notes',
    'This is not executable.',
  ].join('\n');
  const result = await preflightPlan(markdown, throwingJudge());
  assert.ok(result.ok);
  assert.equal(result.jevRequired, false);
  const { prepared } = result;
  assert.deepEqual(prepared.blocks.flatMap((b) => b.items.map((i) => i.raw)), [
    '1. Tap "Create record"',
  ]);
  assert.deepEqual(prepared.cleanup?.[0].items.map((i) => [i.line, i.raw]), [
    [6, '1. Tap "Delete record"'],
    [7, '✓ "Record deleted"'],
  ]);
  assert.match(prepared.cleanup![0].planHash, /^[a-f0-9]{64}$/);
  const wire = JSON.parse(JSON.stringify(prepared));
  assert.deepEqual(readPreparedPlan(markdown, wire), prepared.blocks);
  delete wire.cleanup;
  assert.equal(readPreparedPlan(markdown, wire), undefined);
  const altered = structuredClone(prepared);
  altered.cleanup![0].items[0].kind = 'back';
  assert.equal(readPreparedPlan(markdown, altered), undefined);
});

test('Cleanup actions use Jev fallback and preserve its result in the prepared handoff', async () => {
  const markdown = '## QA\n1. Tap "Create"\n## Cleanup\n1. Visit the delete control';
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, q]) => [
      id,
      id === 'preflight' ? { type: 'noul', noul: 0.99 } : choice(q, 'press'),
    ])),
  );
  const result = await preflightPlan(markdown, judge);
  assert.ok(result.ok);
  assert.equal(result.jevRequired, true);
  assert.deepEqual(result.prepared.cleanup?.[0].items[0], {
    kind: 'press',
    target: { phrase: 'Visit the delete control' },
    line: 4,
    raw: '1. Visit the delete control',
    source: 'jev',
  });
  assert.deepEqual(readPreparedPlan(markdown, result.prepared), result.prepared.blocks);
});

test('malformed Cleanup actions refuse preflight rather than silently disappearing', async () => {
  const result = await preflightPlan(
    '## QA\n1. Tap "Create"\n## Cleanup\n1. Fill "Name" with input invalid-name',
    throwingJudge(),
  );
  assert.ok(!result.ok && result.code === 'PLAN_UNPARSEABLE');
  assert.equal(result.refused?.[0].line, 4);
});
