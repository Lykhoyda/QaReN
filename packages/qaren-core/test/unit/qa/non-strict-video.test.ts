import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import {
  applyNativePrivateInputs,
  NativeSnapshotIncomplete,
  ReactCaptureIncomplete,
} from '../../../dist/qa/private-input.js';
import { join } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const canary = 'synthetic-value-9216';
const ready = () => screen([element('@ready', 'Ready', { kind: 'text' })]);
function native(type: string, value?: string) {
  const nodes = [{ ref: '@carrier', type, value }];
  const observed = applyNativePrivateInputs(join(nodes, []), nodes);
  observed.elements.push(...ready().elements);
  observed.visibleText.push('Ready');
  return observed;
}

test('non-strict allows ordinary values while preserving the strict verdict and screenshots', async () => {
  for (const type of ['Other', 'TextField']) {
    for (const policy of ['undeclared', 'strict', 'non-strict'] as const) {
      const f = walker(
        [native(type, canary), ready()],
        scriptedJudge(() => assert.fail()),
      );
      f.deps.videoPolicy = policy;
      const result = await runPlan(parsePlan('✓ "Ready"\n✓ "Ready"').blocks!, f.deps);
      assert.equal(result.verdict, 'PASS');
      assert.equal(result.videoPolicy, policy);
      assert.equal(result.videoPublication, 'withheld-privacy');
      assert.equal(result.nonStrictPublication, 'eligible');
      assert.ok(result.steps.every((step) => !step.screenshot));
      assert.equal(result.mediaWithheld?.video !== undefined, policy !== 'non-strict');
      assert.ok(result.steps.every((step) => step.screenshotWithheld));
      assert.ok(!JSON.stringify(result).includes(canary));
    }
  }
});

test('clean walks remain eligible in every policy', async () => {
  for (const policy of ['undeclared', 'strict', 'non-strict'] as const) {
    const f = walker(
      [ready()],
      scriptedJudge(() => assert.fail()),
    );
    f.deps.videoPolicy = policy;
    const result = await runPlan(parsePlan('✓ "Ready"').blocks!, f.deps);
    assert.equal(result.videoPublication, 'eligible');
    assert.equal(result.nonStrictPublication, 'eligible');
    assert.ok(result.steps[0].screenshot);
  }
});

test('only TEST-PII runtime inventories relax, including unused inputs and unexecuted fills', async () => {
  for (const nonSecret of [false, true]) {
    for (const plan of [
      '✓ "Ready"',
      '✓ "Missing"\n1. Fill "Email" with input FIXTURE' + (nonSecret ? ' (test-pii)' : ''),
    ]) {
      const privacy = new ObservedPrivacy();
      const inputs = new RunInputs(
        { FIXTURE: canary },
        ['FIXTURE'],
        privacy,
        nonSecret ? ['FIXTURE'] : [],
      );
      const f = walker(
        [ready()],
        scriptedJudge(() => assert.fail()),
      );
      f.deps.privacy = privacy;
      f.deps.videoPolicy = 'non-strict';
      const result = await withInputs(inputs, () => runPlan(parsePlan(plan).blocks!, f.deps));
      assert.equal(result.videoPublication, 'withheld-fill');
      assert.equal(result.nonStrictPublication, nonSecret ? 'eligible' : 'withheld-secret');
      assert.equal(result.mediaWithheld?.video?.reason, nonSecret ? undefined : 'runtime-input');
      assert.ok(!JSON.stringify(result).includes(canary));
    }
  }
});

test('a literal plan fill is not itself a non-strict secret veto, even if unexecuted', async () => {
  const f = walker(
    [ready()],
    scriptedJudge(() => assert.fail()),
  );
  f.deps.videoPolicy = 'non-strict';
  const result = await runPlan(
    parsePlan('✓ "Missing"\n1. Fill "Email" with "fixture"').blocks!,
    f.deps,
  );
  assert.equal(result.videoPublication, 'withheld-fill');
  assert.equal(result.nonStrictPublication, 'eligible');
});

test('an empty secure field still vetoes non-strict video after a harmless first cause', async () => {
  const f = walker(
    [native('Other', canary), native('SecureTextField'), ready()],
    scriptedJudge(() => assert.fail()),
  );
  f.deps.videoPolicy = 'non-strict';
  const result = await runPlan(parsePlan('✓ "Ready"\n✓ "Ready"\n✓ "Ready"').blocks!, f.deps);
  assert.equal(result.nonStrictPublication, 'withheld-secret');
  assert.equal(result.mediaWithheld?.screenshots?.reason, 'generic-value');
  assert.deepEqual(result.mediaWithheld?.video, { reason: 'secure-field', line: 2 });
});

test('SECRET echoes cannot hide behind an earlier relaxed echo', () => {
  const privacy = new ObservedPrivacy([canary]);
  privacy.classifyInputs(['hidden-password'], ['hidden-password']);
  privacy.observe(ready());
  privacy.startWindow();
  privacy.observe(screen([], [canary]));
  privacy.observe(screen([], ['HIDDEN-PASSWORD']));
  assert.deepEqual(privacy.windowLatched(), { reason: 'echo', source: 'typed' });
  assert.deepEqual(privacy.secretWindowLatched(), { reason: 'echo', source: 'input' });
  assert.equal(privacy.redact('hidden-password'), '•••');
});

test('concealed fills and code rows veto non-strict video', () => {
  const concealed = new ObservedPrivacy();
  concealed.concealFallback(canary);
  assert.deepEqual(concealed.secretWindowLatched(), { reason: 'concealed-fill' });
  const codes = new ObservedPrivacy(['4829']);
  codes.didFill('4829');
  codes.observe(
    join(
      Array.from('4829', (label, i) => ({
        ref: `@box${i}`,
        type: 'StaticText',
        label,
        rect: { x: i * 48, y: 100, width: 42, height: 42 },
      })),
      [],
    ),
  );
  assert.deepEqual(codes.secretWindowLatched(), { reason: 'code-row' });
});

test('SECRET window reset retains the latest secure screen and never clears strict screenshots', () => {
  const privacy = new ObservedPrivacy();
  privacy.observe(native('SecureTextField'));
  privacy.startWindow();
  assert.deepEqual(privacy.secretWindowLatched(), { reason: 'secure-field' });
  privacy.observe(ready());
  assert.ok(privacy.secretWindowLatched());
  privacy.startWindow();
  assert.equal(privacy.secretWindowLatched(), undefined);
  assert.equal(privacy.canScreenshot(), false);
});

test('a PUBLIC literal fill into a readable native label-private field can publish non-strict video', async () => {
  const nodes = [
    {
      ref: '@email',
      type: 'TextField',
      identifier: 'email',
      label: 'Fixture',
      value: '',
      secure: false,
      hittable: true,
      enabled: true,
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
  ];
  const login = applyNativePrivateInputs(
    join(nodes, [], 'app', { native: 'complete', react: 'complete' }, undefined, {
      source: 'xcui-live',
      nodes: [{ status: 'observed', labelSource: 'value' }],
    }),
    nodes,
  );
  const f = walker(
    [login],
    scriptedJudge(() => assert.fail()),
  );
  f.deps.videoPolicy = 'non-strict';
  f.deps.fill = async (_ref, _value, _context, privateValue) => {
    assert.equal(privateValue, false);
    return { ok: true, proven: true };
  };
  const result = await runPlan(parsePlan('1. Fill "email" with "fixture"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.videoPublication, 'withheld-fill');
  assert.equal(result.nonStrictPublication, 'eligible');
  assert.equal(result.steps[0].screenshotWithheld, 'input-value');
});

test('protected runtime echoes retain protection provenance after the login window resets', () => {
  for (const strict of [false, true]) {
    for (const secure of [false, true]) {
      const privacy = new ObservedPrivacy();
      privacy.classifyInputs([canary], strict ? [canary] : []);
      privacy.observe(
        screen([element('@fixture', 'Fixture', { kind: 'input', testID: 'fixture' })]),
      );
      privacy.concealFallback(canary, { secure, protectedValue: true }, 'fixture');
      privacy.observe(screen([], [canary.toUpperCase()]));
      privacy.startWindow();
      assert.deepEqual(privacy.secretWindowLatched(), {
        reason: 'echo',
        source: secure ? 'secret' : 'concealed',
      });
      assert.equal(privacy.redact(canary), '•••');
      assert.equal(privacy.canScreenshot(), false);
    }
  }
});

for (const policy of [undefined, 'strict', 'non-strict'] as const) {
  for (const prior of ['clean', 'generic-value', 'plan-fill'] as const) {
    for (const [kind, incomplete] of [
      ['native', () => new NativeSnapshotIncomplete(0, ['unattested'])],
      ['react', () => new ReactCaptureIncomplete('deadline')],
    ] as const) {
      test(`privacy-capture refusal withholds ${policy ?? 'undeclared'} video after ${prior} (${kind})`, async () => {
        const observed = prior === 'generic-value' ? native('Other', canary) : ready();
        const f = walker(
          [],
          scriptedJudge(() => assert.fail('literal checks are model-free')),
        );
        let captures = 0;
        f.deps.videoPolicy = policy;
        f.deps.captureScreen = async () => {
          if (++captures > 1) throw incomplete();
          return observed;
        };
        const plan =
          '✓ "Ready"\n✓ "Ready"' +
          (prior === 'plan-fill' ? '\n1. Fill "fixture" with "synthetic"' : '');
        const result = await runPlan(parsePlan(plan).blocks!, f.deps);
        assert.equal(result.verdict, 'REFUSED');
        assert.equal(result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
        assert.equal(result.videoPublication, 'unknown');
        assert.equal(result.publicationInterrupted, false);
        assert.ok(!JSON.stringify(result).includes(canary));
      });
    }
  }
}
