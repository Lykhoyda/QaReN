import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

// An installed release build: native reads only, React coverage unknown, no optional React step functions.
const nativeOnly = (base: Screen): Screen => ({
  ...base,
  coverage: { native: 'complete', react: 'unknown' },
  captureCoverage: { native: 'complete', react: 'unknown' },
});

test('quoted Tap, Fill and literal check pass on native reads alone; a masked fill is unverified', async () => {
  const start = element('@start', 'Start');
  const email = element('@email', 'Email', { kind: 'input' });
  const welcome = element('@welcome', 'Welcome', { kind: 'text' });
  const f = walker(
    [nativeOnly(screen([start, email, welcome]))],
    scriptedJudge(() => {
      throw new Error('the model is never asked for quoted lines');
    }),
  );
  f.deps.fill = async (ref, text) => {
    f.actions.push(`fill ${ref} ${text}`);
    return { ok: true, proven: false, evidence: 'masked' };
  };
  for (const optional of [
    'reactFocused',
    'fillAlreadySet',
    'blurFocusedInput',
    'typeFocused',
    'setByHandler',
  ] as const)
    assert.equal(f.deps[optional], undefined);
  const ledger = await runPlan(
    parsePlan('1. Tap "Start"\n2. Type "a@b.test" into "Email"\n✓ "Welcome"').blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.steps));
  assert.deepEqual(
    ledger.steps.map((step) => [step.line, step.outcome, step.reactCoverage]),
    [
      [1, 'pass', 'unknown'],
      [2, 'pass', 'unknown'],
      [3, 'pass', 'unknown'],
    ],
  );
  const fill = ledger.steps.find((step) => step.line === 2)!;
  assert.match(fill.reason ?? '', /^UNVERIFIED_FILL: the field's final value reads back masked/);
});
