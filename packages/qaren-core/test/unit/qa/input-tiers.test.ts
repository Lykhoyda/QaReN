import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import {
  INPUT_SCREEN_TEXT_WITHHELD,
  ObservedPrivacy,
  emailForms,
} from '../../../dist/qa/privacy.js';
import { describeError } from '../../../dist/qa/adapt.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createWriter } from '../../../dist/qa/wire.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const EMAIL = 'qa.tester+run7@staging.example.test';
const PASSWORD = 'fake-pass-0000';
const PHONE = '+44 7700 900123';

test('(test-pii) and (non-secret) declare one TEST-PII tier; (secret) states the default', () => {
  const fill = (suffix: string) => parseStep(`Fill "email" with input EMAIL${suffix}`);
  assert.deepEqual(fill(' (test-pii)'), fill(' (non-secret)'));
  assert.equal((fill(' (TEST-PII)') as { sensitivity?: string }).sensitivity, 'non-secret');
  assert.deepEqual(fill(' (secret)'), fill(''));
  assert.deepEqual(parseStep('Fill "email" with input EMAIL (test-pii) (any method)'), {
    ...(fill(' (test-pii)') as object),
    anyMethod: true,
  });
  for (const text of [
    'Fill "field" with "fixture" (test-pii)',
    'Fill "field" with "fixture" (secret)',
    'Type "fixture" into "field" (test-pii)',
    'Expect input EMAIL on screen (test-pii)',
  ])
    assert.ok(parsePlan(`1. ${text}`).refused, text);
  assert.ok(parsePlan('### Login (test-pii)\n1. Tap "Sign in"\n').refused);
  assert.ok(
    parsePlan('1. Fill "a" with input EMAIL (test-pii)\n2. Fill "b" with input EMAIL\n').refused,
  );
  assert.ok(
    parsePlan(
      '1. Fill "a" with input EMAIL (test-pii)\n2. Fill "b" with input EMAIL (non-secret)\n',
    ).blocks,
  );
});

test('derived e-mail forms cover the local part, plus-less local part, domain and encodings', () => {
  const forms = emailForms(EMAIL);
  for (const form of [
    'qa.tester+run7',
    'qa.tester',
    'staging.example.test',
    'qa.tester%2Brun7%40staging.example.test',
    'qa.tester+run7&#64;staging.example.test',
    'qa.tester+run7&commat;staging.example.test',
  ])
    assert.ok(forms.includes(form), form);
  assert.deepEqual(emailForms('not an e-mail'), []);
  assert.deepEqual(emailForms(PASSWORD), []);
  assert.ok(!emailForms('ab@x.io').includes('ab'), 'short parts are not masked alone');
});

const accountScreen = () =>
  screen(
    [
      element('@email', `Signed in as ${EMAIL}`, { kind: 'text' }),
      element('@greeting', 'Hello qa.tester', { kind: 'text' }),
      element('@encoded', 'next=qa.tester%2Brun7%40staging.example.test', { kind: 'text' }),
      element('@phone', `Phone ${PHONE}`, { kind: 'text' }),
    ],
    ['Account'],
  );

function privacyFor(values: Record<string, string>, testPii: string[]) {
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs(values, Object.keys(values), privacy, testPii);
  return { privacy, inputs };
}

test('screen text is withheld only when the run holds a SECRET input', () => {
  const shown = accountScreen();
  const secret = privacyFor({ EMAIL, PASSWORD }, ['EMAIL']);
  assert.deepEqual(secret.privacy.screenText(shown), [INPUT_SCREEN_TEXT_WITHHELD]);
  assert.equal(secret.inputs.hasStrictInputs, true);

  const strictEmail = privacyFor({ EMAIL }, []);
  assert.equal(strictEmail.privacy.textWithheld(shown), INPUT_SCREEN_TEXT_WITHHELD);

  const testPii = privacyFor({ EMAIL }, ['EMAIL']);
  assert.equal(testPii.inputs.hasStrictInputs, false);
  assert.equal(testPii.inputs.hasInputs, true);
  assert.equal(testPii.privacy.textWithheld(shown), undefined);
  const text = testPii.privacy.screenText(shown).join(' | ');
  for (const leaked of [EMAIL, 'qa.tester', 'staging.example.test', '%40staging'])
    assert.ok(!text.includes(leaked), `${leaked} in ${text}`);
  assert.ok(text.includes('Signed in as'), text);
  assert.ok(text.includes(PHONE), 'undeclared on-screen data is not covered by value redaction');
  assert.equal(testPii.privacy.canScreenshot(), false, 'media stays withheld');
});

test('a TEST-PII run reports failure screen text redacted by the declared value', async () => {
  const f = walker(
    [accountScreen()],
    scriptedJudge(() => assert.fail('model-free')),
  );
  const { privacy, inputs } = privacyFor({ EMAIL }, ['EMAIL']);
  f.deps.privacy = privacy;
  const result = await withInputs(inputs, () =>
    runPlan(parsePlan('1. Wait for "Billing address"').blocks!, f.deps),
  );
  assert.equal(result.verdict, 'FAIL');
  const seen = result.failure?.seen ?? '';
  assert.ok(!seen.includes(INPUT_SCREEN_TEXT_WITHHELD), seen);
  assert.ok(seen.includes('Signed in as'), seen);
  const durable = JSON.stringify(result);
  for (const leaked of [EMAIL, 'qa.tester', 'staging.example.test'])
    assert.ok(!durable.includes(leaked), `leaked ${leaked}`);
});

test('a secure TEST-PII Fill promotes the run before typing and withholds later Account evidence', async () => {
  const login = screen([
    element('@code', 'Code', { kind: 'input', testID: 'code', secure: true }),
    element('@continue', 'Continue', { testID: 'continue' }),
  ]);
  const f = walker(
    [login],
    scriptedJudge(() => assert.fail('model-free')),
  );
  const { privacy, inputs } = privacyFor({ CODE: '123456' }, ['CODE']);
  const wire: string[] = [];
  const writer = createWriter((line) => wire.push(line), 'secure-fill');
  inputs.onPromotion(() => writer.strictInputs());
  f.deps.privacy = privacy;
  let account = false;
  f.deps.captureScreen = async () => (account ? accountScreen() : login);
  let typed = false;
  f.deps.fill = async (_ref, _text, _context, privateValue) => {
    assert.equal(inputs.hasStrictInputs, true);
    assert.equal(privateValue, true);
    assert.equal(inputs.protectFill('CODE'), true);
    assert.deepEqual(
      wire.map((line) => JSON.parse(line).payload),
      [{ kind: 'strict_inputs' }],
    );
    typed = true;
    return { ok: true, proven: true };
  };
  f.deps.press = async () => {
    account = true;
    return { ok: true, proven: true };
  };
  const result = await withInputs(inputs, () =>
    runPlan(
      parsePlan(
        '1. Fill "code" with input CODE (test-pii)\n2. Tap "continue"\n3. Wait for "Billing address"',
      ).blocks!,
      f.deps,
    ),
  );
  assert.equal(typed, true);
  assert.equal(account, true);
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.failure?.seen.includes(INPUT_SCREEN_TEXT_WITHHELD));
  assert.equal(inputs.protectFill('CODE'), true);
  assert.equal(wire.length, 1);
  const evidence = JSON.stringify({ result, rows: f.rows });
  for (const text of [PHONE, 'Signed in as', '123456']) assert.ok(!evidence.includes(text), text);
  assert.deepEqual(
    withInputs(inputs, () => describeError(new Error('Account address'))),
    {
      code: 'UNEXPECTED_ERROR',
      message: '[private output withheld]',
    },
  );
});

test('a TEST-PII run redacts handler errors instead of withholding them', () => {
  const error = new Error(`could not type ${EMAIL} into the field`);
  const testPii = privacyFor({ EMAIL }, ['EMAIL']).inputs;
  const described = withInputs(testPii, () => describeError(error));
  assert.ok(described.message.startsWith('could not type'), described.message);
  assert.ok(!described.message.includes('qa.tester'), described.message);
  const secret = privacyFor({ EMAIL, PASSWORD }, ['EMAIL']).inputs;
  assert.equal(withInputs(secret, () => describeError(error)).message, '[private output withheld]');
});

test('a refused SECRET fill carries its value-free mismatch counts on the failed row', async () => {
  const entryMismatch = { len: 12, exp: 14, prefix: 2, suffix: 10, caseEq: false };
  const field = element('@password', 'Password', { kind: 'input', testID: 'password-field' });
  const f = walker(
    [screen([field], ['Sign in'])],
    scriptedJudge(() => assert.fail('model-free')),
    {
      ok: false,
      proven: false,
      mutation: 'observed',
      error:
        'TEXT_ENTRY_UNVERIFIED: The private input differs from the requested text; not retrying.',
      entryMismatch,
    },
  );
  const { privacy, inputs } = privacyFor({ PASSWORD }, []);
  f.deps.privacy = privacy;
  const result = await withInputs(inputs, () =>
    runPlan(parsePlan('1. Fill "password-field" with input PASSWORD').blocks!, f.deps),
  );
  assert.equal(result.verdict, 'FAIL');
  const failed = f.rows.filter((row) => row.outcome === 'fail');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].entryMismatch, entryMismatch);
  assert.ok(!JSON.stringify({ result, rows: f.rows }).includes(PASSWORD));
});
