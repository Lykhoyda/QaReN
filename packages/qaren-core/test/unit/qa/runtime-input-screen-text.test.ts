import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { INPUT_SCREEN_TEXT_WITHHELD, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const email = 'jane.synthetic@example.test';
const phone = '+44 7700 900123';
const address = 'Home address 12 Synthetic Lane';
const accountDetails = () =>
  screen(
    [
      element('@email', `Email ${email}`, { kind: 'text' }),
      element('@phone', `Phone ${phone}`, { kind: 'text' }),
      element('@address', address, { kind: 'text' }),
    ],
    ['Account details', email, phone, address],
  );

async function failedWait(inputs: boolean) {
  const f = walker(
    [accountDetails()],
    scriptedJudge(() => assert.fail('quoted target must be model-free')),
  );
  const privacy = new ObservedPrivacy();
  f.deps.privacy = privacy;
  const diagnostics: unknown[] = [];
  f.deps.targetMiss = (event) => diagnostics.push(event);
  const run = () => runPlan(parsePlan('1. Wait for "Billing address"').blocks!, f.deps);
  const result = inputs
    ? await withInputs(
        new RunInputs({ FIXTURE: 'unrelated-runtime-value' }, ['FIXTURE'], privacy),
        run,
      )
    : await run();
  return { result, diagnostics };
}

test('a failed wait in a run with runtime inputs leaves no undeclared screen text', async () => {
  const { result, diagnostics } = await failedWait(true);
  assert.equal(result.verdict, 'FAIL');
  const durable = JSON.stringify({ result, diagnostics });
  for (const leaked of [email, phone, '12 Synthetic Lane'])
    assert.ok(!durable.includes(leaked), `leaked ${leaked}`);
  assert.match(result.failure?.seen ?? '', /"Billing address"/);
  assert.ok(result.failure?.seen?.includes(INPUT_SCREEN_TEXT_WITHHELD), result.failure?.seen);
  assert.equal(diagnostics.length, 1);
  assert.ok(
    (diagnostics[0] as { candidates: { label?: string }[] }).candidates.some(
      (candidate) => candidate.label === '•••',
    ),
  );
});

test('a failed wait without runtime inputs keeps its screen text context', async () => {
  const { result, diagnostics } = await failedWait(false);
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.failure?.seen?.includes(email), result.failure?.seen);
  assert.ok(!result.failure?.seen?.includes(INPUT_SCREEN_TEXT_WITHHELD));
  assert.match(JSON.stringify(diagnostics), /12 Synthetic Lane/);
});
