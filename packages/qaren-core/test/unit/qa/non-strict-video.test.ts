import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePrivateScreen, ObservedPrivacy } from '../../../dist/qa/privacy.js';
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

test('non-strict allows ordinary values while preserving the strict video verdict', async () => {
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
      assert.ok(
        result.steps.every((step) => Boolean(step.screenshot) === (policy === 'non-strict')),
      );
      assert.equal(result.mediaWithheld?.video !== undefined, policy !== 'non-strict');
      assert.ok(
        result.steps.every(
          (step) => Boolean(step.screenshotWithheld) === (policy !== 'non-strict'),
        ),
      );
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
  assert.deepEqual(result.mediaWithheld?.screenshots, {
    reason: 'secure-field',
    line: 2,
    count: 2,
  });
  assert.deepEqual(result.mediaWithheld?.video, { reason: 'secure-field', line: 2 });
});

test('replacement video causes carry their observation line into the ledger and diagnostic', async () => {
  for (const echoFirst of [false, true]) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ FIXTURE: canary }, ['FIXTURE'], privacy);
    const f = walker(
      [
        ready(),
        ready(),
        ready(),
        echoFirst ? native('TextField', canary) : ready(),
        native('SecureTextField'),
        ready(),
      ],
      scriptedJudge(() => assert.fail('literal checks are model-free')),
    );
    const diagnostics: unknown[] = [];
    f.deps.privacy = privacy;
    f.deps.videoPolicy = 'non-strict';
    f.deps.mediaWithheld = (event) => diagnostics.push(event);
    const result = await withInputs(inputs, () =>
      runPlan(parsePlan(Array(6).fill('✓ "Ready"').join('\n')).blocks!, f.deps),
    );
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(result.mediaWithheld?.video, { reason: 'secure-field', line: 5 });
    assert.deepEqual(diagnostics.at(-1), {
      kind: 'media-withheld',
      scope: 'video',
      cause: { reason: 'secure-field' },
      line: 5,
    });
    assert.equal(result.mediaWithheld?.screenshots?.line, 0);
    assert.equal(result.nonStrictPublication, 'withheld-secret');
  }
});

test('login window resets pair a retained secure cause with the new window line', async () => {
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs({ FIXTURE: canary }, ['FIXTURE'], privacy);
  let loggedIn = false;
  const wall = screen([
    element('@login', 'Sign in', { testID: 'login-screen' }),
    element('@password', '', { kind: 'input', secure: true }),
  ]);
  const home = screen([
    element('@settings', 'Settings'),
    element('@password', '', { kind: 'input', secure: true }),
    ...ready().elements,
  ]);
  capturePrivateScreen(wall, []);
  capturePrivateScreen(home, []);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal steps are model-free')),
  );
  f.deps.privacy = privacy;
  f.deps.videoPolicy = 'non-strict';
  f.deps.captureScreen = async () => (loggedIn ? home : wall);
  f.deps.press = async (ref) => {
    if (ref === '@login') loggedIn = true;
    return { ok: true, proven: true };
  };
  f.deps.hideDevMenu = async () => ({ ok: true, proven: true });
  f.deps.login = {
    marker: { id: 'login-screen' },
    block: parsePlan('1. Tap "Sign in"').blocks![0],
  };
  const result = await withInputs(inputs, () =>
    runPlan(parsePlan('\n\n\n\n1. Tap "Settings"\n✓ "Ready"').blocks!, f.deps),
  );
  assert.equal(result.verdict, 'PASS');
  assert.equal(typeof result.publishFromMs, 'number');
  assert.deepEqual(result.mediaWithheld?.video, { reason: 'secure-field', line: 5 });
  assert.equal(result.nonStrictPublication, 'withheld-secret');
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

test('runtime input fills report readable email and secure password causes separately', async () => {
  for (const secure of [false, true]) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ FIXTURE: canary }, ['FIXTURE'], privacy);
    let filled = false;
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal fills are model-free')),
    );
    f.deps.privacy = privacy;
    f.deps.videoPolicy = 'non-strict';
    f.deps.captureScreen = async () => {
      if (!secure)
        return screen([
          element('@fixture', 'fixture', {
            kind: 'input',
            testID: 'fixture',
            value: filled ? canary : '',
          }),
          ...ready().elements,
        ]);
      const nodes = [
        {
          ref: '@fixture',
          type: 'SecureTextField',
          identifier: 'fixture',
          value: filled ? canary : '',
          secure,
          hittable: true,
          enabled: true,
          rect: { x: 10, y: 20, width: 200, height: 40 },
        },
      ];
      const observed = applyNativePrivateInputs(
        join(nodes, [], 'app', { native: 'complete', react: 'complete' }, undefined, {
          source: 'xcui-live',
          nodes: [{ status: 'observed', labelSource: 'none' }],
        }),
        nodes,
      );
      observed.elements.push(...ready().elements);
      observed.visibleText.push('Ready');
      return observed;
    };
    f.deps.fill = async () => {
      filled = true;
      return { ok: true, proven: true };
    };
    const result = await withInputs(inputs, () =>
      runPlan(parsePlan('1. Fill "fixture" with input FIXTURE\n✓ "Ready"').blocks!, f.deps),
    );
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.equal(result.nonStrictPublication, 'withheld-secret');
    assert.equal(result.videoPublication, 'withheld-fill');
    assert.equal(result.mediaWithheld?.video?.reason, secure ? 'secure-field' : 'echo');
    assert.equal(result.mediaWithheld?.video?.source, secure ? undefined : 'input');
    assert.ok(!JSON.stringify(result).includes(canary));
  }
});

test('protected causes outrank runtime inputs and input echoes in either observation order', () => {
  const blockers = [
    (privacy: ObservedPrivacy) => privacy.observe(native('SecureTextField')),
    (privacy: ObservedPrivacy) => privacy.observePrivateFill(canary),
    (privacy: ObservedPrivacy) => privacy.concealFallback(canary),
    (privacy: ObservedPrivacy) => {
      privacy.didFill('4829');
      privacy.observe(
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
    },
  ];
  for (const block of blockers) {
    for (const first of [false, true]) {
      const privacy = new ObservedPrivacy();
      if (first) block(privacy);
      new RunInputs({ FIXTURE: canary }, ['FIXTURE'], privacy);
      privacy.observe(native('TextField', canary));
      if (!first) block(privacy);
      const cause = privacy.secretWindowLatched();
      assert.ok(cause);
      assert.ok(['secure-field', 'concealed-fill', 'code-row'].includes(cause.reason));
      privacy.observe(ready());
      assert.deepEqual(privacy.secretWindowLatched(), cause);
      privacy.startWindow();
      assert.equal(privacy.secretWindowLatched(), undefined);
      assert.equal(privacy.canScreenshot(), false);
    }
  }
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
  assert.equal(result.steps[0].screenshotWithheld, undefined);
  assert.ok(result.steps[0].screenshot);
});

for (const policy of [undefined, 'strict', 'non-strict'] as const) {
  for (const route of ['native', 'focused', 'set-handler'] as const) {
    test(`handler-detected private literal fill withholds ${policy ?? 'undeclared'} video (${route})`, async () => {
      const field = screen([
        element('@fixture', 'Fixture', { kind: 'input', testID: 'fixture', value: '' }),
      ]);
      const focused = {
        ...screen([]),
        keyboardVisible: true,
        reactHostEvidence: {
          complete: true,
          hosts: [
            {
              testID: 'fixture',
              role: null,
              roleSource: 'none' as const,
              capabilities: { fill: true },
            },
          ],
        },
      };
      const privacy = new ObservedPrivacy();
      const f = walker(
        [],
        scriptedJudge(() => assert.fail('literal steps are model-free')),
      );
      let filled = false;
      let callbacks = 0;
      const protect = (onPrivateInput?: () => void) => {
        assert.ok(onPrivateInput);
        onPrivateInput();
        callbacks += 1;
        filled = true;
        return { ok: true, proven: true };
      };
      f.deps.privacy = privacy;
      f.deps.videoPolicy = policy;
      f.deps.captureScreen = async () => (filled ? ready() : route === 'focused' ? focused : field);
      f.deps.fill = async (_ref, _value, _context, _privateValue, onPrivateInput) =>
        route === 'set-handler'
          ? {
              ok: false,
              mutation: 'observed',
              error: 'TEXT_ENTRY_UNVERIFIED: retained target differs',
            }
          : protect(onPrivateInput);
      f.deps.reactFocused = async () => true;
      f.deps.typeFocused = async (
        _ref,
        _value,
        _testID,
        _context,
        _requireFocused,
        _privateValue,
        onPrivateInput,
      ) => protect(onPrivateInput);
      f.deps.setByHandler = async (_testID, _value, _context, _privateValue, onPrivateInput) =>
        protect(onPrivateInput);
      const result = await runPlan(
        parsePlan(`1. Fill "fixture" with "${canary}"\n✓ "Ready"`).blocks!,
        f.deps,
      );
      assert.equal(result.verdict, 'PASS');
      assert.equal(callbacks, 1);
      assert.equal(result.nonStrictPublication, 'withheld-secret');
      assert.equal(privacy.canScreenshot(), false);
      assert.ok(
        privacy
          .privateSet()
          .values.some((value) => value.text === canary && value.provenance === 'secret'),
      );
      assert.equal(privacy.redact(canary), '•••');
      assert.ok(!JSON.stringify({ result, rows: f.rows }).includes(canary));
      if (route !== 'focused') {
        assert.deepEqual(privacy.secretWindowLatched(), { reason: 'secure-field' });
        if (policy === 'non-strict')
          assert.deepEqual(result.mediaWithheld?.video, { reason: 'secure-field', line: 1 });
      }
    });
  }
}

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
