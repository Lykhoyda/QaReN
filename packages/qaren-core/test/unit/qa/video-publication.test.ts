import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { AppProcessGoneError, postAdmissionSnapshots } from '../../../dist/qa/capture.js';
import { okResult, failResult } from '../../../dist/utils.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const appSnapshot = (pid = 41) =>
  okResult({ appProcessIdentifier: pid, nodes: [] }, { meta: { foregroundSurface: 'app' } });
const runnerRecovery = (pid?: number) =>
  okResult(
    { ...(pid === undefined ? {} : { appProcessIdentifier: pid }), nodes: [] },
    {
      meta: {
        foregroundSurface: 'app',
        recovered: 'agent-device-runner-leak',
        recoveryTier: 'relaunch',
      },
    },
  );

test('pre-admission runner recovery is recorded without withholding the walk', async () => {
  const observations = [
    appSnapshot(),
    runnerRecovery(41),
    appSnapshot(),
    appSnapshot(),
    appSnapshot(),
  ];
  const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
  await snapshots.snapshot({});
  await snapshots.snapshot({});
  snapshots.admit();
  for (let i = 0; i < 3; i++) await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), false);
  assert.equal(snapshots.events().length, 1);
  assert.deepEqual(snapshots.events()[0], {
    signal: 'runner-recovery',
    atMs: snapshots.events()[0].atMs,
    counted: false,
    beforeAdmission: true,
    detail: { recoveryTier: 'relaunch' },
  });
});

test('post-admission runner recovery requires same-process foreground proof', async () => {
  for (const [recovery, next, interrupted] of [
    [runnerRecovery(41), appSnapshot(), false],
    [runnerRecovery(), appSnapshot(), false],
    [runnerRecovery(), appSnapshot(77), true],
    [runnerRecovery(), undefined, true],
  ] as const) {
    const observations = [appSnapshot(), recovery, ...(next ? [next] : [])];
    const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
    await snapshots.snapshot({});
    snapshots.admit();
    await snapshots.snapshot({});
    if (next) await snapshots.snapshot({});
    assert.equal(snapshots.interrupted(), interrupted);
    assert.equal(snapshots.events()[0].signal, 'runner-recovery');
    assert.equal(snapshots.events()[0].counted, interrupted);
    if (next === undefined) assert.equal(snapshots.events()[0].detail?.unresolved, true);
    if (next && interrupted)
      assert.ok(
        snapshots
          .events()
          .some(
            (e) =>
              e.signal === 'app-process-changed' &&
              e.counted &&
              e.detail?.fromPid === 41 &&
              e.detail?.toPid === 77,
          ),
      );
  }
});

test('walker names counted overlay, changed-process and recovery-exit signals', async () => {
  for (const signal of ['dev-overlay', 'app-process-changed', 'app-process-gone'] as const) {
    const app = screen([element('@save', 'Save')]);
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal plan')),
    );
    let captures = 0;
    f.deps.captureScreen = async () => {
      captures++;
      if (signal === 'app-process-changed') return { ...app, appProcessIdentifier: 77 };
      return {
        ...(signal === 'app-process-gone' ? screen([]) : app),
        front: signal === 'app-process-gone' ? 'dev-menu' : 'dev-fab',
      };
    };
    if (signal === 'app-process-changed') f.deps.appProcess = { expected: 41 };
    if (signal === 'app-process-gone')
      f.deps.hideDevMenu = async () => {
        throw new AppProcessGoneError();
      };
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    const event = result.continuityEvents?.find((e) => e.signal === signal);
    assert.ok(event, signal);
    assert.equal(event.line, 1, signal);
    assert.equal(event.counted, true, signal);
    assert.equal(typeof event.atMs, 'number', signal);
    assert.equal(result.publicationInterrupted, true, signal);
    assert.ok(captures > 0);
  }
});

test('sixteen pre-admission events cannot crowd out a later app restart', async () => {
  const observations = [
    appSnapshot(),
    ...Array.from({ length: 16 }, () => runnerRecovery(41)),
    appSnapshot(77),
  ];
  const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
  for (let i = 0; i < 17; i++) await snapshots.snapshot({});
  snapshots.admit();
  await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), true);
  assert.equal(snapshots.events().length, 16);
  assert.equal(snapshots.dropped(), 1);
  assert.equal(snapshots.events().find((e) => e.counted)?.signal, 'app-process-changed');
});

test('walker merge keeps a counted signal after sixteen earlier uncounted events', async () => {
  const f = walker(
    [{ ...screen([]), front: 'dev-fab' }, screen([element('@save', 'Save')])],
    scriptedJudge(() => assert.fail('literal plan')),
  );
  f.deps.hideDevMenu = async () => ({ ok: true, proven: true });
  f.deps.continuityEvents = () =>
    Array.from({ length: 16 }, (_, atMs) => ({
      signal: 'runner-recovery',
      atMs,
      counted: false,
      beforeAdmission: true,
    }));
  const ledger = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
  assert.equal(ledger.publicationInterrupted, true);
  assert.equal(ledger.continuityEvents?.length, 16);
  assert.equal(ledger.continuityEventsDropped, 1);
  assert.equal(ledger.continuityEvents?.find((e) => e.counted)?.signal, 'dev-overlay');
});

test('missing process reads resolve on the next proof or finish as unproven', async () => {
  for (const [next, signal] of [
    [appSnapshot(), undefined],
    [appSnapshot(77), 'app-process-changed'],
    [undefined, 'app-process-unproven'],
  ] as const) {
    const observations = [appSnapshot(), okResult({ nodes: [] }), ...(next ? [next] : [])];
    const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
    await snapshots.snapshot({});
    snapshots.admit();
    await snapshots.snapshot({});
    assert.deepEqual(snapshots.events(), []);
    if (next) await snapshots.snapshot({});
    snapshots.finish();
    const finished = JSON.stringify(snapshots.events());
    snapshots.finish();
    assert.equal(JSON.stringify(snapshots.events()), finished);
    assert.equal(snapshots.interrupted(), signal !== undefined);
    assert.equal(snapshots.events().find((event) => event.counted)?.signal, signal);
  }
});

test('runner recovery without a process baseline stays unproven', async () => {
  const snapshots = postAdmissionSnapshots(async () => runnerRecovery(), 'com.test');
  snapshots.admit();
  await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), true);
  assert.equal(snapshots.events()[0].detail?.unresolved, true);
});

test('repeated runner recoveries share the next process proof even when the buffer is full', async () => {
  const observations = [
    appSnapshot(),
    ...Array.from({ length: 18 }, () => runnerRecovery()),
    appSnapshot(),
  ];
  const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
  await snapshots.snapshot({});
  snapshots.admit();
  for (let i = 0; i < 19; i++) await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), false);
  assert.equal(snapshots.events().length, 16);
  assert.equal(snapshots.dropped(), 2);
});

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
      false,
    ],
    [
      'failed recovery',
      failResult('recovery failed', { code: 'RUNNER_LEAK', recoveryReason: 'relaunch-failed' }),
      false,
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
    [
      'runner down outside relaunch',
      failResult('runner unavailable', 'RN_FAST_RUNNER_DOWN'),
      false,
    ],
    [
      'other relaunch failure',
      failResult('runner stale', 'RN_FAST_RUNNER_STALE', { runnerRelaunch: true }),
      false,
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
          'reason' in evidence || 'foregroundSurface' in evidence,
        ] as const,
    ),
    [
      'successful response without process proof',
      okResult({}, { meta: { code: 'RN_FAST_RUNNER_DOWN', runnerRelaunch: true } }),
      false,
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
    snapshots.admit();
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

test('finish retains an omitted pending recovery ahead of uncounted events', async () => {
  const observations = [
    appSnapshot(),
    ...Array.from({ length: 16 }, () => runnerRecovery(41)),
    runnerRecovery(),
  ];
  const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
  for (let i = 0; i < 17; i++) await snapshots.snapshot({});
  snapshots.admit();
  await snapshots.snapshot({});
  assert.equal(snapshots.dropped(), 1);
  assert.equal(
    snapshots.events().some((event) => !event.beforeAdmission),
    false,
  );
  snapshots.finish();
  assert.equal(snapshots.events().length, 16);
  assert.equal(snapshots.dropped(), 1);
  assert.equal(snapshots.interrupted(), true);
  assert.deepEqual(
    snapshots
      .events()
      .filter((event) => event.counted)
      .map((event) => ({ signal: event.signal, detail: event.detail })),
    [{ signal: 'runner-recovery', detail: { recoveryTier: 'relaunch', unresolved: true } }],
  );
  snapshots.finish();
  assert.equal(snapshots.dropped(), 1);
});

test('finish retains an unresolved missing process read when the event buffer is full', async () => {
  const observations = [
    appSnapshot(),
    ...Array.from({ length: 16 }, () => runnerRecovery(41)),
    okResult({ nodes: [] }),
  ];
  const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
  for (let i = 0; i < 17; i++) await snapshots.snapshot({});
  snapshots.admit();
  await snapshots.snapshot({});
  snapshots.finish();
  assert.equal(snapshots.events().length, 16);
  assert.equal(snapshots.dropped(), 1);
  assert.equal(snapshots.interrupted(), true);
  assert.equal(snapshots.events().find((event) => event.counted)?.signal, 'app-process-unproven');
});

test('a launcher resolves pending runner recovery and keeps both observation times', async (t) => {
  for (const surface of ['dev_client_picker', 'first_run_tutorial']) {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const observations = [
      appSnapshot(),
      runnerRecovery(),
      okResult({ nodes: [] }, { meta: { foregroundSurface: surface } }),
    ];
    const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
    await snapshots.snapshot({});
    snapshots.admit();
    now = 2000;
    await snapshots.snapshot({});
    now = 3000;
    await snapshots.snapshot({});
    snapshots.finish();
    assert.equal(snapshots.interrupted(), true);
    assert.deepEqual(
      snapshots
        .events()
        .map(({ signal, atMs, counted, detail }) => ({ signal, atMs, counted, detail })),
      [
        {
          signal: 'runner-recovery',
          atMs: 2000,
          counted: true,
          detail: { recoveryTier: 'relaunch' },
        },
        {
          signal: surface === 'dev_client_picker' ? 'dev-client-picker' : 'first-run-tutorial',
          atMs: 3000,
          counted: true,
          detail: undefined,
        },
        { signal: 'app-process-unproven', atMs: 3000, counted: true, detail: { unresolved: true } },
      ],
    );
    t.mock.restoreAll();
  }
});

test('a runner leak followed by app stop preserves the later positive proof', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const observations = [
    appSnapshot(),
    failResult('runner refused', { code: 'RUNNER_LEAK', recovered: true }),
    failResult('app stopped', { reason: 'app-not-running' }),
  ];
  const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
  await snapshots.snapshot({});
  snapshots.admit();
  now = 2000;
  await snapshots.snapshot({});
  now = 3000;
  await snapshots.snapshot({});
  snapshots.finish();
  assert.equal(snapshots.interrupted(), true);
  assert.deepEqual(
    snapshots.events().map(({ signal, atMs, counted }) => ({ signal, atMs, counted })),
    [
      { signal: 'runner-recovery', atMs: 2000, counted: true },
      { signal: 'runner-leak', atMs: 2000, counted: true },
      { signal: 'app-not-running', atMs: 3000, counted: true },
    ],
  );
  assert.equal(snapshots.events()[0].detail?.unresolved, true);
});
