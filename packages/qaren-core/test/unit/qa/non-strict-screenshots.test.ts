import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { capturePrivateScreen, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { applyNativePrivateInputs } from '../../../dist/qa/private-input.js';
import { join } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const canary = 'synthetic-screenshot-value-9216';
const ready = () => screen([element('@ready', 'Ready', { kind: 'text' })]);
function native(type: string, value?: string) {
  const nodes = [{ ref: '@carrier', type, value }];
  const observed = applyNativePrivateInputs(join(nodes, []), nodes);
  observed.elements.push(...ready().elements);
  observed.visibleText.push('Ready');
  return observed;
}

for (const [secureHome, secretInput] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  test(`non-strict screenshots share the login window with video (${secureHome ? 'secure' : 'clean'} home, ${secretInput ? 'SECRET input' : 'no input'})`, async () => {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs(
      secretInput ? { FIXTURE: canary } : {},
      secretInput ? ['FIXTURE'] : [],
      privacy,
    );
    const wall = screen([
      element('@login', 'Sign in', { testID: 'login-screen' }),
      element('@password', '', { kind: 'input', secure: true }),
    ]);
    const home = screen([
      element('@settings', 'Settings'),
      ...ready().elements,
      ...(secureHome ? [element('@password', '', { kind: 'input', secure: true })] : []),
    ]);
    capturePrivateScreen(wall, []);
    capturePrivateScreen(home, []);
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal checks are model-free')),
    );
    let loggedIn = false;
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
      runPlan(parsePlan('1. Tap "Settings"\n✓ "Missing"').blocks!, f.deps),
    );
    assert.equal(result.verdict, 'FAIL');
    assert.equal(typeof result.publishFromMs, 'number');
    const withheld = secureHome || secretInput;
    assert.equal(Boolean(result.failure?.screenshot), !withheld);
    assert.equal(result.nonStrictPublication, withheld ? 'withheld-secret' : 'eligible');
    if (withheld) {
      const reason = secureHome ? 'secure-field' : 'runtime-input';
      assert.equal(result.steps.at(-1)?.screenshotWithheld, reason);
      assert.equal(result.mediaWithheld?.screenshots?.reason, reason);
      assert.ok(result.mediaWithheld!.screenshots!.count > 0);
    } else {
      assert.equal(result.mediaWithheld?.screenshots, undefined);
    }
  });
}

test('a protected value echoed after login still withholds a non-strict screenshot', async () => {
  const privacy = new ObservedPrivacy();
  privacy.observePrivateFill(canary);
  privacy.observe(ready());
  privacy.startWindow();
  const f = walker(
    [screen([...ready().elements], ['Ready', canary])],
    scriptedJudge(() => assert.fail('literal checks are model-free')),
  );
  f.deps.privacy = privacy;
  f.deps.videoPolicy = 'non-strict';
  const result = await runPlan(parsePlan('✓ "Missing"').blocks!, f.deps);
  assert.equal(result.failure?.screenshot, undefined);
  assert.equal(result.steps[0].screenshotWithheld, 'echo');
  assert.deepEqual(result.mediaWithheld?.screenshots, {
    reason: 'echo',
    source: 'secret',
    line: 1,
    count: 1,
  });
  assert.ok(!JSON.stringify(result).includes(canary));
});

for (const policy of [undefined, 'strict', 'non-strict'] as const) {
  for (const type of ['Other', 'TextField']) {
    test(`${policy ?? 'absent'} screenshots of ordinary values follow the video mode (${type})`, async () => {
      const f = walker(
        [native(type, canary), ready()],
        scriptedJudge(() => assert.fail('literal checks are model-free')),
      );
      f.deps.videoPolicy = policy;
      const result = await runPlan(parsePlan('✓ "Ready"\n✓ "Missing"').blocks!, f.deps);
      const publishes = policy === 'non-strict';
      assert.equal(result.verdict, 'FAIL');
      assert.equal(Boolean(result.failure?.screenshot), publishes);
      for (const row of [...result.steps, ...f.rows]) {
        assert.equal(Boolean(row.screenshot), publishes);
        assert.equal(Boolean(row.screenshotWithheld), !publishes);
      }
      assert.equal(Boolean(result.mediaWithheld?.screenshots), !publishes);
      assert.ok(!JSON.stringify({ result, rows: f.rows }).includes(canary));
    });
  }

  for (const nonSecret of [false, true]) {
    test(`${policy ?? 'absent'} screenshots respect ${nonSecret ? 'TEST-PII' : 'SECRET'} runtime inputs`, async () => {
      const privacy = new ObservedPrivacy();
      const inputs = new RunInputs(
        { FIXTURE: canary },
        ['FIXTURE'],
        privacy,
        nonSecret ? ['FIXTURE'] : [],
      );
      const f = walker(
        [screen([...ready().elements], ['Ready', canary])],
        scriptedJudge(() => assert.fail('literal checks are model-free')),
      );
      f.deps.videoPolicy = policy;
      f.deps.privacy = privacy;
      const result = await withInputs(inputs, () =>
        runPlan(parsePlan('✓ "Missing"').blocks!, f.deps),
      );
      const publishes = policy === 'non-strict' && nonSecret;
      assert.equal(Boolean(result.failure?.screenshot), publishes);
      assert.equal(Boolean(result.steps[0].screenshot), publishes);
      assert.equal(Boolean(result.steps[0].screenshotWithheld), !publishes);
      assert.equal(Boolean(result.mediaWithheld?.screenshots), !publishes);
      assert.ok(!JSON.stringify({ result, rows: f.rows }).includes(canary));
    });
  }

  test(`${policy ?? 'absent'} screenshots still withhold an empty secure field after an ordinary value`, async () => {
    const f = walker(
      [native('Other', canary), native('SecureTextField'), ready()],
      scriptedJudge(() => assert.fail('literal checks are model-free')),
    );
    const diagnostics: unknown[] = [];
    f.deps.videoPolicy = policy;
    f.deps.mediaWithheld = (event) => diagnostics.push(event);
    const result = await runPlan(parsePlan('✓ "Ready"\n✓ "Ready"\n✓ "Missing"').blocks!, f.deps);
    assert.equal(Boolean(result.steps[0].screenshot), policy === 'non-strict');
    assert.equal(result.steps[1].screenshot, undefined);
    assert.equal(result.failure?.screenshot, undefined);
    const cause =
      policy === 'non-strict'
        ? { reason: 'secure-field', line: 2, count: 2 }
        : { reason: 'generic-value', kind: 'other', line: 1, count: 3 };
    assert.deepEqual(result.mediaWithheld?.screenshots, cause);
    assert.deepEqual(diagnostics[0], {
      kind: 'media-withheld',
      scope: 'screenshots',
      cause:
        policy === 'non-strict'
          ? { reason: 'secure-field' }
          : { reason: 'generic-value', kind: 'other' },
      line: cause.line,
    });
  });
}
