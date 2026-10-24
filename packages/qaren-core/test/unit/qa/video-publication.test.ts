import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { postAdmissionSnapshots } from '../../../dist/qa/capture.js';
import { okResult, failResult } from '../../../dist/utils.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

test('video eligibility follows the entire plan and sticky screenshot privacy', async () => {
  for (const [plan, sensitive, expected] of [
    ['1. Tap "Save"', false, 'eligible'],
    ['1. Fill "Email" with "hello"', false, 'withheld-fill'],
    ['1. Type "private-canary" into "Email"', false, 'withheld-fill'],
    ['1. Tap "Save"', true, 'withheld-privacy'],
    ['1. Wait for "Missing"\n2. Fill "Email" with "private-canary"', false, 'withheld-fill'],
  ] as const) {
    const observed = screen([
      element('@save', 'Save'),
      element('@email', 'Email', { kind: 'input' }),
    ]);
    if (sensitive)
      capturePrivateScreen(observed, [
        {
          values: ['prefilled-canary'],
          secure: false,
          elements: [],
          associationUnique: false,
        },
      ]);
    const cleared = screen(observed.elements);
    const f = walker(
      [observed, cleared],
      scriptedJudge(() => assert.fail('literal plan is model-free')),
    );
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    assert.equal(result.videoPublication, expected);
    assert.equal(result.verdict, plan.includes('Missing') ? 'FAIL' : 'PASS');
    assert.doesNotMatch(JSON.stringify(result), /private-canary|prefilled-canary/);
  }
});

test('a recovery-only runtime input withholds video even when the plan never fills', async () => {
  const observed = screen([element('@save', 'Save')]);
  const f = walker(
    [observed, screen(observed.elements)],
    scriptedJudge(() => assert.fail('literal plan is model-free')),
  );
  const inputs = new RunInputs({ PASSWORD: 'recovery-only-canary' }, ['PASSWORD'], undefined, [
    'PASSWORD',
  ]);
  const result = await withInputs(inputs, () =>
    runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps),
  );
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.videoPublication, 'withheld-fill');
  assert.doesNotMatch(JSON.stringify(result), /recovery-only-canary/);
});

test('post-admission startup observations remain in the ledger after normal walker captures', async () => {
  const app = okResult(
    { appProcessIdentifier: 41, nodes: [] },
    {
      meta: { foregroundSurface: 'app' },
    },
  );
  for (const [event, startup, expected] of [
    ['picker', okResult({ nodes: [{ type: 'StaticText', label: 'Development servers' }] }), true],
    ['picker metadata', okResult({}, { meta: { foregroundSurface: 'dev_client_picker' } }), true],
    [
      'launcher tutorial',
      okResult({}, { meta: { foregroundSurface: 'first_run_tutorial' } }),
      true,
    ],
    [
      'recovery',
      okResult({}, { meta: { recovered: 'agent-device-runner-leak', recoveryTier: 'relaunch' } }),
      true,
    ],
    [
      'failed recovery',
      failResult('recovery failed', { code: 'RUNNER_LEAK', recoveryReason: 'relaunch-failed' }),
      true,
    ],
    ['process change', okResult({ appProcessIdentifier: 77, nodes: [] }), true],
    ['process lost', failResult('app stopped', { reason: 'app-not-running' }), true],
    [
      'transient relaunch failure',
      failResult('runner restarting', 'RN_FAST_RUNNER_DOWN', { runnerRelaunch: true }),
      false,
    ],
    [
      'transient relaunch failure with metadata code',
      failResult('runner restarting', { code: 'RN_FAST_RUNNER_DOWN', runnerRelaunch: true }),
      false,
    ],
    ['runner down outside relaunch', failResult('runner unavailable', 'RN_FAST_RUNNER_DOWN'), true],
    [
      'other relaunch failure',
      failResult('runner stale', 'RN_FAST_RUNNER_STALE', { runnerRelaunch: true }),
      true,
    ],
    ...[
      { code: 'RUNNER_LEAK' },
      { reason: 'app-not-running' },
      { recovered: 'runner' },
      { recoveryTier: 'relaunch' },
      { recoveryReason: 'relaunch-failed' },
      { foregroundSurface: 'dev_client_picker' },
      { foregroundSurface: 'first_run_tutorial' },
    ].map(
      (evidence) =>
        [
          'transient failure with interruption evidence',
          failResult('runner restarting', 'RN_FAST_RUNNER_DOWN', {
            runnerRelaunch: true,
            ...evidence,
          }),
          true,
        ] as const,
    ),
    [
      'successful response without process proof',
      okResult({}, { meta: { code: 'RN_FAST_RUNNER_DOWN', runnerRelaunch: true } }),
      true,
    ],
    ['normal app', app, false],
  ] as const) {
    let probes = 0;
    const forwarded: { action: 'snapshot'; qaReadOnly?: boolean }[] = [];
    const snapshots = postAdmissionSnapshots(
      async (args: { action: 'snapshot'; qaReadOnly?: boolean }) => {
        probes += 1;
        forwarded.push(args);
        return probes === 2 ? startup : app;
      },
      'com.test',
    );
    await snapshots.snapshot({ action: 'snapshot' });
    const observed = await snapshots.snapshot({ action: 'snapshot' });
    assert.equal(observed, startup);
    const f = walker(
      [screen([element('@save', 'Save')])],
      scriptedJudge(() => assert.fail('literal plan')),
    );
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async (options) => {
      await snapshots.snapshot({ action: 'snapshot', qaReadOnly: true });
      return { ...(await capture(options)), appProcessIdentifier: 41 };
    };
    f.deps.appProcess = {};
    f.deps.publicationInterrupted = snapshots.interrupted;
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', event);
    assert.equal(result.publicationInterrupted, expected, event);
    assert.equal(f.deps.appProcess.expected, 41, event);
    assert.deepEqual(f.actions, ['press @save'], event);
    assert.ok(probes > 2);
    assert.deepEqual(forwarded.slice(0, 2), [{ action: 'snapshot' }, { action: 'snapshot' }]);
    assert.equal(forwarded.at(-1)?.qaReadOnly, true);
  }
});

test('dev chrome interrupts publication even when recovery hides it and the retry passes', async () => {
  for (const front of ['dev-fab', 'dev-menu'] as const) {
    const app = screen([element('@save', 'Save')]);
    const overlay = { ...screen([]), front };
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal plan is model-free')),
    );
    let current = screen([element('@open', 'Open')]);
    let presses = 0;
    let hides = 0;
    f.deps.captureScreen = async () => current;
    f.deps.press = async (ref) => {
      f.actions.push(`press ${ref}`);
      presses += 1;
      current = hides === 0 ? overlay : screen([element('@done', 'Done')]);
      return { ok: true, proven: true };
    };
    f.deps.hideDevMenu = async () => {
      hides += 1;
      current = app;
      return { ok: true, proven: true };
    };
    const result = await runPlan(
      parsePlan('1. Tap "Open"\n2. Tap "Save"\n3. Tap "Done"').blocks!,
      f.deps,
    );
    assert.equal(result.verdict, 'PASS', front);
    assert.equal(result.recoveries, 1, front);
    assert.equal(hides, 1, front);
    assert.equal(presses, 3, front);
    assert.deepEqual(f.actions, ['press @open', 'press @save', 'press @done'], front);
    assert.ok(
      result.steps.some((row) => row.reason?.includes(`recovered: ${front}`)),
      front,
    );
    assert.equal(result.steps.at(-1)?.outcome, 'pass', front);
    assert.equal(current.front, 'app', front);
    assert.equal(result.publicationInterrupted, true, front);
  }
});

test('non-secret-only runs still refuse screenshots at the capture adapter', async () => {
  const { captureQaScreenshot } = await import('../../../dist/qa/screenshot.js');
  const inputs = new RunInputs({ FIXTURE: 'fixture-canary' }, ['FIXTURE'], undefined, ['FIXTURE']);
  for (const platform of ['ios', 'android'] as const)
    assert.deepEqual(
      await withInputs(inputs, () =>
        captureQaScreenshot(platform, '/unused', 'unused', 'com.test'),
      ),
      { ok: false, reason: 'WITHHELD_PRIVATE_INPUT' },
    );
});

test('video reason follows a pre-plan login window while screenshots retain the first cause', async () => {
  const wall = screen([
    element('@login', 'Sign in', { testID: 'login-screen' }),
    element('@password', '', { kind: 'input', secure: true }),
  ]);
  capturePrivateScreen(wall, []);
  const home = screen([
    element('@settings', 'Settings'),
    element('@ready', 'Ready', { kind: 'text' }),
  ]);
  const valued = screen([
    ...home.elements,
    element('@value', '', { nativeKind: 'other', kind: 'other', value: 'private-display-canary' }),
  ]);
  capturePrivateScreen(valued, [
    {
      values: ['private-display-canary'],
      secure: false,
      elements: [valued.elements.at(-1)!],
      associationUnique: true,
    },
  ]);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plan')),
  );
  let loggedIn = false;
  let navigated = false;
  f.deps.captureScreen = async () => (!loggedIn ? wall : navigated ? valued : home);
  f.deps.press = async (ref) => {
    if (ref === '@login') loggedIn = true;
    if (ref === '@settings') navigated = true;
    return { ok: true, proven: true };
  };
  f.deps.hideDevMenu = async () => ({ ok: true, proven: true });
  f.deps.login = {
    marker: { id: 'login-screen' },
    block: parsePlan('1. Tap "Sign in"').blocks![0],
  };
  const result = await runPlan(parsePlan('1. Tap "Settings"\n✓ "Ready"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(typeof result.publishFromMs, 'number');
  assert.equal(result.videoPublication, 'withheld-privacy');
  assert.equal(result.mediaWithheld?.screenshots?.reason, 'secure-field');
  assert.deepEqual(result.mediaWithheld?.video, {
    reason: 'generic-value',
    kind: 'other',
    line: 1,
  });
});
