import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { join } from '../../../dist/qa/screen.js';
import { applyNativePrivateInputs } from '../../../dist/qa/private-input.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { createWriter } from '../../../dist/qa/wire.js';
import { cleanDiagnostic } from '../../../dist/qa/diagnostics.js';
import { cleanTimingEvent } from '../../../dist/qa/timing.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const canary = 'PRIVATE-CANARY-69721';
const ready = () => screen([element('@ready', 'Ready', { kind: 'text' })]);
const native = (type: string, value?: string, label?: string) => {
  const nodes = [{ ref: '@private', type, value, label, identifier: `${canary}-id` }];
  return applyNativePrivateInputs(join(nodes, []), nodes);
};

for (const [name, cause, setup, qualifier] of [
  ['empty secure field', 'secure-field', () => ({ observed: native('SecureTextField') })],
  ['prefilled field', 'input-value', () => ({ observed: native('TextField', canary) })],
  [
    'Android label',
    'input-value',
    () => ({ observed: native('android.widget.EditText', undefined, canary) }),
  ],
  [
    'Other value',
    'generic-value',
    () => ({ observed: native('Other', canary) }),
    { kind: 'other' },
  ],
  [
    'saved-login literal without replay',
    'echo',
    () => ({ observed: screen([], [canary]), login: true }),
    { source: 'typed' },
  ],
  [
    'observed echo',
    'echo',
    () => {
      const privacy = new ObservedPrivacy();
      privacy.observe(screen([element('@input', canary, { kind: 'input', value: canary })]));
      return { privacy, observed: screen([], [canary]), before: true };
    },
    { source: 'observed' },
  ],
  [
    'code row',
    'code-row',
    () => {
      const privacy = new ObservedPrivacy(['4829']);
      privacy.didFill('4829');
      const observed = join(
        Array.from('4829', (label, i) => ({
          ref: `@box${i}`,
          type: 'StaticText',
          label,
          rect: { x: i * 48, y: 100, width: 42, height: 42 },
        })),
        [],
      );
      return { privacy, observed };
    },
  ],
  [
    'concealed fill',
    'concealed-fill',
    () => {
      const privacy = new ObservedPrivacy();
      privacy.concealFallback(canary);
      return { privacy, observed: ready(), before: true };
    },
  ],
  [
    'runtime input',
    'runtime-input',
    () => {
      const privacy = new ObservedPrivacy();
      privacy.classifyInputs([canary]);
      return { privacy, observed: ready(), before: true };
    },
  ],
] as const) {
  test(`withheld media records ${name} without values`, async () => {
    const data = setup() as {
      observed: ReturnType<typeof screen>;
      privacy?: ObservedPrivacy;
      login?: boolean;
      before?: boolean;
    };
    data.observed.elements.push(...ready().elements);
    data.observed.visibleText.push('Ready');
    const f = walker(
      [data.observed, ready()],
      scriptedJudge(() => assert.fail('literal check')),
    );
    const metrics: unknown[] = [];
    const warnings: string[] = [];
    f.deps.privacy = data.privacy;
    f.deps.timing = (event) => metrics.push(event);
    f.deps.mediaWithheld = (event) => warnings.push(`media-withheld ${JSON.stringify(event)}`);
    if (data.login)
      f.deps.login = {
        marker: { id: 'login-screen' },
        block: parsePlan(`1. Type "${canary}" into "Email"`).blocks![0],
      };
    const run = () => runPlan(parsePlan('✓ "Ready"\n✓ "Ready"').blocks!, f.deps);
    const ledger =
      cause === 'runtime-input'
        ? await withInputs(new RunInputs({ FIXTURE: canary }, ['FIXTURE']), run)
        : await run();
    const entry = { reason: cause, ...qualifier, line: data.before ? 0 : 1, count: 2 };
    assert.deepEqual(ledger.mediaWithheld?.screenshots, entry);
    assert.deepEqual(
      ledger.steps.map((row) => row.screenshotWithheld),
      [cause, cause],
    );
    assert.deepEqual(
      f.rows.map((row) => row.screenshotWithheld),
      [cause, cause],
    );
    assert.ok(ledger.steps.every((row) => row.screenshot === undefined));
    const withheld = metrics.filter(
      (event: any) => event.stage === 'screenshot' && event.outcome === 'withheld',
    );
    assert.equal(withheld.length, 2);
    for (const event of withheld) {
      assert.equal((event as any).withheld, cause);
      for (const [key, value] of Object.entries(qualifier ?? {}))
        assert.equal((event as any)[key], value);
    }
    assert.equal(
      warnings.filter((line) => line.startsWith('media-withheld ')).length,
      cause === 'runtime-input' ? 1 : 2,
    );
    if (cause === 'runtime-input') {
      assert.equal(ledger.videoPublication, 'withheld-fill');
      assert.equal(ledger.mediaWithheld?.video, undefined);
    }
    assert.doesNotMatch(
      JSON.stringify({ entry: ledger.mediaWithheld, metrics, warnings }),
      /PRIVATE-CANARY|@private|4829/,
    );
  });
}

test('clean frames have no withholding fields', async () => {
  const f = walker(
    [ready()],
    scriptedJudge(() => assert.fail('literal check')),
  );
  const ledger = await runPlan(parsePlan('✓ "Ready"').blocks!, f.deps);
  assert.equal(ledger.mediaWithheld, undefined);
  assert.ok(ledger.steps[0].screenshot);
  assert.equal(ledger.steps[0].screenshotWithheld, undefined);
});

test('withholding timing fields accept only closed words on withheld screenshots', () => {
  const event = {
    stage: 'screenshot',
    edge: 'point',
    outcome: 'withheld',
    at: 0,
    withheld: 'generic-value',
    kind: 'other',
  };
  assert.deepEqual(cleanTimingEvent(event), event);
  for (const invalid of [
    { withheld: canary },
    { kind: canary },
    { source: canary },
    { stage: 'capture' },
    { outcome: 'ok' },
  ])
    assert.equal(cleanTimingEvent({ ...event, ...invalid }), undefined);
});

test('private-input diagnostics preserve the metric discriminator and withholding code', () => {
  const event = {
    kind: 'metric',
    stage: 'screenshot',
    edge: 'point',
    outcome: 'withheld',
    at: 1,
    withheld: 'runtime-input',
  };
  assert.deepEqual(cleanDiagnostic(event), event);
});

test('only frames after the first cause are withheld and later causes cannot replace it', async () => {
  const observed = native('Other', canary);
  observed.elements.push(...ready().elements);
  observed.visibleText.push('Ready');
  const secure = native('SecureTextField');
  secure.elements.push(...ready().elements);
  secure.visibleText.push('Ready');
  const f = walker(
    [ready(), observed, secure, ready()],
    scriptedJudge(() => assert.fail('literal check')),
  );
  f.deps.mediaWithheld = () => {
    throw new Error('diagnostic sink unavailable');
  };
  const ledger = await runPlan(
    parsePlan('✓ "Ready"\n✓ "Ready"\n✓ "Ready"\n✓ "Ready"').blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(ledger.mediaWithheld?.screenshots, {
    reason: 'generic-value',
    kind: 'other',
    line: 2,
    count: 3,
  });
  assert.deepEqual(
    ledger.steps.map((row) => row.screenshotWithheld),
    [undefined, 'generic-value', 'generic-value', 'generic-value'],
  );
  assert.ok(ledger.steps[0].screenshot);
});

test('per-screen causes prefer secure fields, then input values, then generic values', () => {
  for (const [types, expected] of [
    [['Other', 'TextField', 'SecureTextField'], 'secure-field'],
    [['Other', 'TextField'], 'input-value'],
  ] as const) {
    const nodes = types.map((type, i) => ({
      type,
      ref: `@${i}`,
      value: type === 'SecureTextField' ? undefined : canary,
    }));
    const observed = applyNativePrivateInputs(join(nodes, []), nodes);
    const privacy = new ObservedPrivacy();
    privacy.observe(observed);
    assert.deepEqual(privacy.latched(), { reason: expected });
  }
});

test('qualified withholding metrics keep their native kind across diagnostic cleaning', () => {
  const event = {
    kind: 'other',
    stage: 'screenshot',
    edge: 'point',
    outcome: 'withheld',
    at: 1,
    withheld: 'generic-value',
  };
  assert.deepEqual(cleanDiagnostic(event), event);
  assert.equal(cleanDiagnostic({ ...event, stage: 'capture' }), undefined);
  assert.equal(cleanDiagnostic({ ...event, kind: canary }), undefined);
});

test('private media diagnostics survive the wire with only closed cause fields', async () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'media-run');
  const f = walker(
    [ready()],
    scriptedJudge(() => assert.fail('literal check')),
  );
  f.deps.mediaWithheld = writer.diagnostic;
  f.deps.privacy = new ObservedPrivacy();
  await withInputs(new RunInputs({ FIXTURE: canary }, ['FIXTURE'], f.deps.privacy), () =>
    runPlan(parsePlan('✓ "Ready"').blocks!, f.deps),
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).payload),
    [
      {
        kind: 'media-withheld',
        scope: 'screenshots',
        cause: { reason: 'runtime-input' },
        line: 0,
      },
    ],
  );
  const event = {
    kind: 'media-withheld',
    scope: 'video',
    cause: { reason: 'generic-value', kind: 'other', value: canary },
    line: 2,
  };
  assert.deepEqual(cleanDiagnostic(event), {
    ...event,
    cause: { reason: 'generic-value', kind: 'other' },
  });
  for (const cause of [
    { reason: canary },
    { reason: 'echo', source: canary },
    { reason: 'secure-field', kind: 'other' },
  ])
    assert.equal(cleanDiagnostic({ ...event, cause }), undefined);
});

for (const mode of ['unused', 'absent'] as const) {
  test(`media diagnostics cross the wire with ${mode} inputs`, async () => {
    const lines: string[] = [];
    const writer = createWriter((line) => lines.push(line), 'media-run');
    const observed = native('SecureTextField');
    observed.elements.push(...ready().elements);
    observed.visibleText.push('Ready');
    const f = walker(
      [observed],
      scriptedJudge(() => assert.fail('literal check')),
    );
    f.deps.mediaWithheld = writer.diagnostic;
    const run = () => runPlan(parsePlan('✓ "Ready"').blocks!, f.deps);
    if (mode === 'unused') await withInputs(new RunInputs({}, []), run);
    else await run();
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).payload),
      [
        {
          kind: 'media-withheld',
          scope: 'screenshots',
          cause: { reason: 'secure-field' },
          line: 1,
        },
        { kind: 'media-withheld', scope: 'video', cause: { reason: 'secure-field' }, line: 1 },
      ],
    );
    assert.doesNotMatch(lines.join(''), /PRIVATE-CANARY|@private/);
  });
}
