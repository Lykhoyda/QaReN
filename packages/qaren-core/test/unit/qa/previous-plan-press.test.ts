import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge } from './judgment-fixtures.ts';
import { replayBlock } from '../../../dist/qa/walker.js';

const opener = () => screen([element('@open', 'Open')]);
const ready = () => screen([element('@ready', 'Ready')]);
// The screen the plan's own press opens: no planned target yet, one decline control.
const destination = () => screen([element('@title', 'Details', { kind: 'text' }), close()]);
const close = (label = 'Close') => element('@close', label);

function withModal(snapshot: Screen, id?: string): Screen {
  const present = id !== undefined;
  return {
    ...snapshot,
    reactHostEvidence: {
      complete: true,
      hosts: present ? [{ testID: id, role: null, roleSource: 'none', capabilities: {} }] : [],
      typography: {
        version: 1,
        complete: true,
        durationMs: 0,
        coordinateSpace: 'window-points',
        nodes: present
          ? [
              {
                hostIndex: 0,
                parentHostIndex: null,
                rootIndex: 0,
                hostType: 'RCTModalHostView',
                text: { kind: 'none' },
              },
            ]
          : [],
      },
    },
  };
}

// `pressed` maps a pressed ref to the screen it leads to; unknown refs keep the screen.
function app(initial: Screen, pressed: Record<string, () => Screen>) {
  let current = initial;
  let clock = 0;
  const actions: string[] = [];
  const vetoes: string[] = [];
  const deps: WalkerDeps = {
    async captureScreen() {
      return current;
    },
    async press(ref) {
      actions.push(`press ${ref}`);
      if (pressed[ref]) current = pressed[ref]();
      return { ok: true, proven: false, executed: true };
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      throw new Error('unexpected scroll');
    },
    async back() {
      actions.push('back');
      return { ok: true, proven: false, executed: true };
    },
    async dialog(action) {
      actions.push(`dialog ${action}`);
      return { ok: true, proven: true, executed: true };
    },
    async hideDevMenu() {
      throw new Error('unexpected dev menu');
    },
    async screenshot(name) {
      return name;
    },
    interruptionRejected: (event) => vetoes.push(event.veto),
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    row() {},
  };
  return { deps, actions, vetoes, show: (next: Screen) => (current = next) };
}

const run = (text: string, f: ReturnType<typeof app>) => runPlan(parsePlan(text).blocks!, f.deps);

test('a missing wait after a passed planned press leaves the opened screen and fails', async () => {
  const destinations: Record<string, () => Screen> = {
    'opener gone': destination,
    'opener retained': () => screen([element('@open', 'Open'), close()]),
    'inline replacement': () => screen([element('@open', 'Opened'), close()]),
    'decline named Skip': () => screen([close('Skip')]),
  };
  for (const [name, next] of Object.entries(destinations)) {
    const f = app(opener(), { '@open': next, '@close': ready });
    const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
    assert.equal(result.verdict, 'FAIL', name);
    assert.deepEqual(f.actions, ['press @open'], name);
    assert.equal(result.recoveries, 0, name);
    assert.equal(result.failure?.step, 2, name);
    assert.equal(result.failure?.subreason, 'previous-plan-press', name);
    if (name === 'opener gone' || name === 'decline named Skip')
      assert.match(
        result.failure?.suggestion ?? '',
        /Add a step after line 1: Tap "(?:Close|Skip)"\./,
        name,
      );
    else assert.equal(result.failure?.suggestion, undefined, name);
    assert.ok(result.failure?.screen, name);
    assert.match(
      result.failure?.seen ?? '',
      /the previous planned press succeeded; the next target was not found; automatic app dismissal was withheld/,
      name,
    );
    assert.ok(f.vetoes.includes('previous-plan-press'), name);
    const failedRow = result.steps.find((row) => row.line === 2 && row.outcome === 'fail');
    assert.equal(failedRow?.interruption?.outcome, 'vetoed', name);
    assert.equal(failedRow?.interruption?.veto, 'previous-plan-press', name);
    assert.equal(failedRow?.interruption?.targetLine, 2, name);
  }
});

test('a planned press passing on loading never dismisses its delayed opt-in destination', async () => {
  for (const decline of ['Skip', 'Not now', "Don't allow"]) {
    for (const withheld of [false, true]) {
      for (const next of ['2. Wait for "Ready" to appear', '✓ "Ready"']) {
        const f = app(opener(), {
          '@open': () => withModal(screen([element('@heading', 'Loading', { kind: 'text' })])),
          '@decline': ready,
        });
        if (withheld) {
          f.deps.privacy = new ObservedPrivacy();
          f.deps.privacy.classifyInputs(['zq-s3cret-7781']);
        }
        f.deps.row = (row) => {
          if (row.line === 1 && row.outcome === 'pass')
            f.show(
              screen([
                element('@title', 'zq-s3cret-7781', { kind: 'text' }),
                element('@decline', decline),
                element('@accept', 'Allow'),
              ]),
            );
        };
        const result = await run(`1. Tap "Open"\n${next}`, f);
        assert.equal(result.verdict, 'FAIL');
        assert.deepEqual(f.actions, ['press @open']);
        assert.equal(result.recoveries, 0);
        assert.match(
          result.failure?.seen ?? '',
          /a permission opt-in with a decline and an accept control is in front; the previous planned tap may have opened it, so it was not dismissed/,
        );
        assert.equal(result.failure?.suggestion, `Add a step after line 1: Tap "${decline}".`);
        if (withheld) assert.ok(!JSON.stringify(result).includes('zq-s3cret-7781'));
      }
    }
  }
});

test('a press inside modal A never dismisses delayed modal B while A remains mounted', async () => {
  for (const withheld of [false, true]) {
    const modalA = withModal(opener(), 'modal-a');
    const modalB = withModal(screen([close()]), 'modal-b');
    modalB.elements[0].testID = 'close-b';
    modalB.reactHostEvidence!.hosts.push(
      { testID: 'close-b', role: null, roleSource: 'none', capabilities: {} },
      modalA.reactHostEvidence!.hosts[0],
    );
    modalB.reactHostEvidence!.typography!.nodes.push(
      { hostIndex: 1, parentHostIndex: 0, rootIndex: 0, hostType: 'View', text: { kind: 'none' } },
      {
        hostIndex: 2,
        parentHostIndex: null,
        rootIndex: 0,
        hostType: 'RCTModalHostView',
        text: { kind: 'none' },
      },
    );
    const f = app(modalA, {
      '@open': () =>
        withModal(screen([element('@loading', 'Loading', { kind: 'text' })]), 'modal-a'),
      '@close': ready,
    });
    if (withheld) {
      f.deps.privacy = new ObservedPrivacy();
      f.deps.privacy.classifyInputs(['zq-s3cret-7781']);
      modalB.elements.push(element('@copy', 'zq-s3cret-7781', { kind: 'text' }));
      modalB.visibleText.push('zq-s3cret-7781');
    }
    f.deps.row = (row) => {
      if (row.line === 1 && row.outcome === 'pass') f.show(modalB);
    };
    const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(f.actions, ['press @open']);
    assert.equal(result.recoveries, 0);
    assert.equal(result.failure?.subreason, 'previous-plan-press');
    assert.match(
      result.failure?.seen ?? '',
      /an app (?:screen|•••) with only a decline control is in front; the previous planned tap may have opened it, so it was not dismissed/,
    );
    assert.equal(result.failure?.suggestion, 'Add a step after line 1: Tap "Close".');
    if (withheld) assert.ok(!JSON.stringify(result).includes('zq-s3cret-7781'));
  }
});

test('an opt-in before a planned press or after its identified destination departs is declined once', async () => {
  const optIn = () => screen([close('Skip'), element('@allow', 'Allow')]);
  for (const departed of [false, true]) {
    const f = app(departed ? withModal(opener()) : optIn(), {
      '@open': () => withModal(screen([element('@home', 'Home', { kind: 'text' })]), 'home'),
      '@close': ready,
    });
    f.deps.back = async () => {
      f.show(withModal(optIn()));
      return { ok: true, proven: true, executed: true };
    };
    const result = await run(
      `${departed ? '1. Tap "Open"\n2. Go back\n' : ''}3. Wait for "Ready" to appear`,
      f,
    );
    assert.equal(result.verdict, 'PASS', result.failure?.seen);
    assert.deepEqual(f.actions, departed ? ['press @open', 'press @close'] : ['press @close']);
    assert.equal(result.recoveries, 1);
    const retry = result.steps.find((row) => row.outcome === 'retry');
    assert.equal(retry?.interruption?.screenClass, 'permission-opt-in');
    assert.match(retry?.reason ?? '', /dismissed a permission opt-in with Skip/);
  }
});

test('a protected decline label matching a private value stays masked in the plan suggestion', async () => {
  const f = app(opener(), { '@open': () => screen([close('Skip'), element('@accept', 'Allow')]) });
  f.deps.privacy = new ObservedPrivacy();
  f.deps.privacy.classifyInputs(['Skip']);
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(
    result.failure?.suggestion,
    'Add a step after line 1 that taps the decline control.',
  );
  assert.ok(!JSON.stringify(result.failure).includes('Skip'));
});

test('a consent or opt-in already present at planned press readback stays protected', async () => {
  for (const accept of ['Allow all', 'Accept all', 'Enable all notifications', 'Allow']) {
    const consent = () => screen([close('Skip'), element('@accept', accept)]);
    const f = app(screen([element('@open', 'Open consent')]), {
      '@open': consent,
      '@close': () => screen([element('@continue', 'Continue')]),
    });
    const result = await run('1. Tap "Open consent"\n2. Wait for "Continue" to appear', f);
    assert.equal(result.verdict, 'FAIL', accept);
    assert.equal(result.failure?.subreason, 'previous-plan-press', accept);
    assert.deepEqual(f.actions, ['press @open'], accept);
    assert.equal(result.recoveries, 0, accept);
  }
});

test('a consent modal arriving after an empty press baseline stays protected', async () => {
  const consent = withModal(screen([close('Skip')]), 'consent');
  consent.elements[0].testID = 'skip';
  consent.reactHostEvidence!.hosts.push({
    testID: 'skip',
    role: null,
    roleSource: 'none',
    capabilities: {},
  });
  consent.reactHostEvidence!.typography!.nodes.push({
    hostIndex: 1,
    parentHostIndex: 0,
    rootIndex: 0,
    hostType: 'View',
    text: { kind: 'none' },
  });
  const f = app(opener(), {
    '@open': () => withModal(screen([element('@heading', 'Loading', { kind: 'text' })])),
    '@close': ready,
  });
  f.deps.row = (row) => {
    if (row.line === 1 && row.outcome === 'pass') f.show(consent);
  };
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.subreason, 'previous-plan-press');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.recoveries, 0);
});

test('an opt-in stays protected by a later described target before protection lapses', async () => {
  const optIn = () => screen([element('@skip', 'Skip'), element('@accept', 'Allow')]);
  const f = app(opener(), { '@open': optIn, '@skip': ready });
  const result = await run(
    '1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Tap the allow button',
    f,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.ok(f.vetoes.includes('later-target'));
  assert.equal(result.steps.find((row) => row.outcome === 'fail')?.interruption?.targetLine, 3);
  assert.match(result.failure?.seen ?? '', /later planned item at line 3/);
});

test('an unprompted sheet after later items passed on a decline-free screen is dismissed once', async () => {
  const optIn = () =>
    screen([
      element('@title', 'Get reminders?', { kind: 'text' }),
      element('@notnow', 'Not now'),
      element('@turnon', 'Turn on notifications'),
    ]);
  const home = (...extra: ReturnType<typeof element>[]) =>
    screen([
      element('@ready', 'Home ready', { kind: 'text' }),
      element('@count', 'Reminder declines: 1', { kind: 'text' }),
      ...extra,
    ]);
  const sheet = (): Screen => ({
    ...screen([
      element('@new', 'New: shared lists', { kind: 'text' }),
      element('@try', 'Try shared lists'),
      element('@later', 'Maybe later'),
    ]),
    reactHostEvidence: { complete: true, hosts: [] },
    fillGapCount: 0,
  });
  const f = app(optIn(), {
    '@notnow': () => home(),
    '@later': () => home(element('@lists', 'Lists ready', { kind: 'text' })),
  });
  f.deps.row = (row) => {
    if (row.line === 3 && row.outcome === 'pass') f.show(sheet());
  };
  const result = await run(
    '1. Tap "Not now"\n2. Wait for "Home ready" to appear\n✓ "Reminder declines: 1"\n4. Wait for "Lists ready" to appear',
    f,
  );
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @notnow', 'press @later']);
  assert.equal(result.recoveries, 1);
  assert.ok(!f.vetoes.includes('previous-plan-press'));
  const retry = result.steps.find((row) => row.line === 4 && row.outcome === 'retry');
  assert.match(
    retry?.reason ?? '',
    /recovered: dismissed an app screen with Maybe later; retrying the step once/,
  );
  assert.equal(retry?.interruption?.outcome, 'dismissed');
});

test('after a decline-free pass, a delayed opt-in a later step targets is still not dismissed', async () => {
  const loading = () => screen([element('@loading', 'Loading', { kind: 'text' })]);
  // A joined native capture, so text targets resolve as they do on a device.
  const optIn = () => {
    const rect = { x: 0, y: 0, width: 400, height: 800 };
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application', rect },
      { ref: '@window', type: 'Window', parentIndex: 0, rect },
      {
        ref: '@title',
        type: 'StaticText',
        parentIndex: 1,
        label: 'Get reminders?',
        rect: { x: 20, y: 200, width: 360, height: 40 },
      },
      {
        ref: '@skip',
        type: 'Button',
        parentIndex: 1,
        label: 'Skip',
        hittable: true,
        rect: { x: 20, y: 600, width: 160, height: 44 },
      },
      {
        ref: '@allow',
        type: 'Button',
        parentIndex: 1,
        label: 'Allow',
        hittable: true,
        rect: { x: 200, y: 600, width: 180, height: 44 },
      },
    ];
    return join(
      nodes,
      [],
      'app',
      { native: 'complete', react: 'complete' },
      { complete: true, hosts: [] },
      {
        source: 'xcui-live',
        nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
      },
    );
  };
  const f = app(opener(), { '@open': loading });
  f.deps.row = (row) => {
    if (row.line === 2 && row.outcome === 'pass') f.show(optIn());
  };
  const result = await run(
    '1. Tap "Open"\n2. Wait for "Loading" to appear\n3. Wait for "Ready" to appear\n4. Tap "Allow"',
    f,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 3);
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.recoveries, 0);
  assert.ok(f.vetoes.includes('later-target'));
  assert.ok(!f.vetoes.includes('previous-plan-press'));
});

test('a later pass with static Later text permits recovery, but uncertain press evidence protects it', async () => {
  for (const press of ['unsupported', 'unknown'] as const) {
    const f = app(opener(), {
      '@open': () =>
        screen([
          element('@details', 'Details', { kind: 'text' }),
          element('@later', 'Later', {
            kind: 'text',
            semantic: { press, fill: 'unsupported', visibility: 'visible' },
          }),
        ]),
      '@close': ready,
    });
    f.deps.row = (row) => {
      if (row.line === 2 && row.outcome === 'pass') f.show(screen([close()]));
    };
    const result = await run(
      '1. Tap "Open"\n2. Wait for "Details" to appear\n3. Wait for "Ready" to appear',
      f,
    );
    assert.equal(result.verdict, press === 'unsupported' ? 'PASS' : 'FAIL');
    assert.deepEqual(
      f.actions,
      press === 'unsupported' ? ['press @open', 'press @close'] : ['press @open'],
    );
    assert.equal(result.recoveries, press === 'unsupported' ? 1 : 0);
    if (press === 'unknown') assert.equal(result.failure?.subreason, 'previous-plan-press');
  }
});

test('an input declaration cannot lapse protection using the previous press loading capture', async () => {
  const f = app(opener(), {
    '@open': () => screen([element('@loading', 'Loading', { kind: 'text' })]),
    '@skip': ready,
  });
  f.deps.row = (row) => {
    if (row.line === 2 && row.outcome === 'pass')
      f.show(screen([element('@skip', 'Skip'), element('@allow', 'Allow')]));
  };
  const result = await withInputs(new RunInputs({ EMAIL: 'fixture@example.test' }, ['EMAIL']), () =>
    run(
      '1. Tap "Open"\n2. Expect input EMAIL on screen\n3. Wait for "Ready" to appear\n4. Fill "Email" with input EMAIL',
      f,
    ),
  );
  assert.ok(result.steps.some((row) => row.line === 2 && row.outcome === 'pass'));
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 3);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.recoveries, 0);
});

test('after protection lapses, every remaining target uses the same conservative veto in every block', async () => {
  const cases = [
    ['4. Tap "Allow"', true],
    ['4. Wait for "Allow" to appear', true],
    ['✓ "Allow"', true],
    ['4. Fill "Allow" with "fixture"', true],
    ['4. Tap the allow button', true],
    ['4. Wait for the allow button to appear', true],
    ['✓ the allow button is visible', true],
    ['4. Tap an unrelated button', true],
    ['4. Tap "Unrelated"', false],
    ['4. Wait for "Unrelated" to appear', false],
    ['✓ "Unrelated"', false],
  ] as const;
  for (const laterBlock of [false, true]) {
    for (const [laterItem, couldMatch] of cases) {
      for (const withheld of [false, true]) {
        const f = app(opener(), {
          '@open': () => screen([element('@loading', 'Loading', { kind: 'text' })]),
          '@skip': () => screen([element('@ready', 'Ready'), element('@future', 'Unrelated')]),
          '@future': ready,
        });
        if (withheld) {
          f.deps.privacy = new ObservedPrivacy();
          f.deps.privacy.classifyInputs(['zq-s3cret-7781']);
        }
        f.deps.row = (row) => {
          if (row.line === 3 && row.outcome === 'pass')
            f.show(
              join(
                [
                  { ref: '@heading', type: 'StaticText', label: 'zq-s3cret-7781' },
                  { ref: '@skip', type: 'Button', label: 'Skip', hittable: true },
                  { ref: '@allow', type: 'Button', label: 'Allow', hittable: true },
                ],
                [],
                'app',
                { native: 'complete', react: 'complete' },
                { hosts: [], complete: true },
                {
                  source: 'xcui-live',
                  nodes: [0, 1, 2].map(() => ({ status: 'observed', labelSource: 'direct' })),
                },
              ),
            );
        };
        const result = await run(
          '### First\n1. Tap "Open"\n2. Wait for "Loading" to appear\n3. Wait for "Ready" to appear\n' +
            (laterBlock ? '\n### Later\n' : '') +
            laterItem,
          f,
        );
        const laterLine = laterBlock ? 7 : 5;
        if (!couldMatch) {
          assert.equal(result.verdict, 'PASS', result.failure?.seen);
          assert.equal(result.recoveries, 1);
          assert.deepEqual(
            f.actions,
            laterItem.startsWith('4. Tap')
              ? ['press @open', 'press @skip', 'press @future']
              : ['press @open', 'press @skip'],
          );
          continue;
        }
        assert.equal(result.verdict, 'FAIL');
        assert.equal(result.failure?.step, 4);
        assert.deepEqual(f.actions, ['press @open']);
        assert.equal(result.recoveries, 0);
        assert.ok(f.vetoes.includes('later-target'));
        assert.ok(!f.vetoes.includes('previous-plan-press'));
        const failed = result.steps.find((row) => row.line === 4 && row.outcome === 'fail');
        assert.equal(failed?.interruption?.targetLine, laterLine);
        assert.match(
          result.failure?.seen ?? '',
          new RegExp(`later planned item at line ${laterLine}`),
        );
        assert.equal(result.failure?.screen?.front, 'app');
        assert.deepEqual(
          result.failure?.screen?.controls.map((control) => control.label),
          ['Skip', 'Allow'],
        );
        if (withheld) assert.ok(!JSON.stringify(result).includes('zq-s3cret-7781'));
      }
    }
  }
});

test('a later item passing with a decline still on screen keeps protection and names the press line', async () => {
  const destination = () =>
    screen([
      element('@title', 'Details', { kind: 'text' }),
      close('Skip'),
      element('@go', 'Allow'),
    ]);
  const f = app(opener(), { '@open': destination, '@close': ready });
  const result = await run(
    '1. Tap "Open"\n2. Wait for "Details" to appear\n3. Wait for "Ready" to appear',
    f,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.failure?.step, 3);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
  assert.match(
    result.failure?.seen ?? '',
    /the planned press at line 1 succeeded and later steps passed while a decline control stayed on screen; the next target was not found; automatic app dismissal was withheld/,
  );
  assert.doesNotMatch(result.failure?.seen ?? '', /the previous planned press succeeded/);
  // F3: the opt-in shape is named and the exact plan edit is suggested.
  assert.match(
    result.failure?.seen ?? '',
    /a permission opt-in with a decline and an accept control is in front; the planned tap at line 1 may have opened it, so it was not dismissed/,
  );
  assert.equal(result.failure?.suggestion, 'Add a step after line 1: Tap "Skip".');
});

test('ANT-848: a planned press accepted despite a handler error protects its consent screen', async () => {
  const acceptedErrors: ActResult[] = [
    {
      ok: false,
      proven: false,
      mutation: 'possible',
      error:
        'INTERACTION_EFFECT_UNVERIFIED: The tap was dispatched but produced no observable UI change.',
    },
    { ok: false, proven: false, error: 'press timed out' },
    { ok: true, proven: false, executed: true, error: 'effect verification timed out' },
  ];
  for (const decline of ['Close', 'Skip']) {
    for (const accepted of acceptedErrors) {
      const f = app(screen([element('@open', 'Open consent')]), {
        '@open': () => screen([element('@heading', 'Consent', { kind: 'text' }), close(decline)]),
        '@close': () => screen([element('@continue', 'Continue')]),
      });
      f.deps.platform = 'android';
      const press = f.deps.press;
      f.deps.press = async (ref, context) => {
        const result = await press(ref, context);
        return ref === '@open' ? accepted : result;
      };
      const result = await run('1. Tap "Open consent"\n2. Wait for "Continue" to appear', f);
      assert.ok(result.steps.some((row) => row.line === 1 && row.outcome === 'pass'));
      assert.equal(result.verdict, 'FAIL', `${decline}: ${accepted.error}`);
      assert.equal(result.failure?.step, 2);
      assert.equal(result.failure?.subreason, 'previous-plan-press');
      assert.equal(result.recoveries, 0);
      assert.deepEqual(f.actions, ['press @open']);
    }
  }
});

test('a planned press accepted through a delayed system dialog protects its destination', async () => {
  const f = app(opener(), { '@close': ready });
  f.deps.row = (row) => {
    if (row.line === 1 && row.outcome === 'retry')
      f.show({ ...screen([element('@allow', 'Allow')]), front: 'dialog' });
  };
  f.deps.dialog = async (action) => {
    f.actions.push(`dialog ${action}`);
    f.show(destination());
    return { ok: true, proven: true, executed: true };
  };
  const result = await run(
    '1. Tap "Open"\n2. Dismiss the permission dialog\n3. Wait for "Ready" to appear',
    f,
  );
  assert.ok(result.steps.some((row) => row.line === 1 && row.outcome === 'pass'));
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 3);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
  assert.equal(result.recoveries, 0);
  assert.deepEqual(f.actions, ['press @open', 'dialog dismiss']);
});

test('a churning destination is still protected', async () => {
  let frame = 0;
  const f = app(opener(), {
    '@open': () => destination(),
    '@close': ready,
  });
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    const seen = await capture(options);
    return f.actions.length && !f.actions.includes('press @close')
      ? screen([element('@title', `Details ${frame++}`, { kind: 'text' }), close()])
      : seen;
  };
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.notEqual(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @open']);
});

test('a planned modal stays protected across a passing wait and check', async () => {
  for (const observe of ['2. Wait for "Signature" to appear', '✓ "Signature"']) {
    const modal = () => screen([element('@heading', 'Signature', { kind: 'text' }), close('Skip')]);
    const f = app(opener(), {
      '@open': modal,
      '@close': () => screen([element('@c', 'Continue')]),
    });
    const result = await run(`1. Tap "Open"\n${observe}\n3. Tap "Continue"`, f);
    assert.equal(result.verdict, 'FAIL', observe);
    assert.deepEqual(f.actions, ['press @open'], observe);
    assert.equal(result.failure?.subreason, 'previous-plan-press', observe);
    assert.ok(f.vetoes.includes('previous-plan-press'), observe);
  }
});

test('a planned consent stays protected across fills and scrolls in both directions', async () => {
  for (const decline of ['Close', 'Skip']) {
    for (const action of [
      'Scroll down',
      'Scroll up',
      'Scroll down until "Signature"',
      'Scroll up until "Signature"',
      'Fill "Name" with "Example"',
    ]) {
      const modal = (scrolled = false) =>
        screen([
          element('@name', 'Name', { kind: 'input' }),
          element('@heading', scrolled ? 'Signature' : 'Consent', { kind: 'text' }),
          close(decline),
        ]);
      const f = app(screen([element('@open', 'Open consent')]), {
        '@open': modal,
        '@close': () => screen([element('@continue', 'Continue')]),
      });
      f.deps.scroll = async (direction) => {
        f.actions.push(`scroll ${direction}`);
        f.show(modal(true));
        return { ok: true, proven: true, executed: true };
      };
      f.deps.fill = async (ref) => {
        f.actions.push(`fill ${ref}`);
        return { ok: true, proven: true, executed: true };
      };
      const result = await run(
        `1. Tap "Open consent"\n2. ${action}\n### Continue\n3. Wait for "Continue" to appear`,
        f,
      );
      assert.equal(result.verdict, 'FAIL', `${decline}: ${action}`);
      assert.equal(result.failure?.step, 4, `${decline}: ${action}`);
      assert.equal(result.failure?.subreason, 'previous-plan-press', `${decline}: ${action}`);
      assert.deepEqual(f.actions, [
        'press @open',
        action.startsWith('Fill') ? 'fill @name' : `scroll ${action.split(' ')[1]}`,
      ]);
      assert.equal(result.recoveries, 0);
    }
  }
});

test('a Back without a changed capture retains protection', async () => {
  const f = app(opener(), { '@open': destination, '@close': ready });
  f.deps.back = async () => {
    f.actions.push('back');
    return { ok: true, proven: true, executed: true };
  };
  const result = await run('1. Tap "Open"\n2. Go back\n3. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 3);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
  assert.deepEqual(f.actions, ['press @open', 'back']);
});

test('a failed check right after a planned press says the dismissal was withheld', async () => {
  const f = app(opener(), { '@open': destination, '@close': ready });
  const result = await run('1. Tap "Open"\n✓ "Ready"', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.failure?.subreason, undefined);
  assert.match(result.failure?.seen ?? '', /automatic app dismissal was withheld/);
});

test('protection crosses a block boundary', async () => {
  const f = app(opener(), { '@open': destination, '@close': ready });
  const result = await run('### Open\n1. Tap "Open"\n### Land\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
});

test('a later planned Close stays untapped by recovery', async () => {
  const f = app(opener(), { '@open': destination, '@close': ready });
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Tap "Close"', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
});

test('ANT-848: Back hiding only the keyboard never permits Close or Skip on planned consent', async () => {
  for (const decline of ['Close', 'Skip']) {
    const consent = (keyboard = false): Screen => ({
      ...screen([
        element('@heading', 'Consent', { kind: 'text' }),
        element('@name', 'Name', { kind: 'input' }),
        close(decline),
      ]),
      ...(keyboard ? { keyboardVisible: true, keylessKeyboard: true } : {}),
    });
    const f = app(screen([element('@open', 'Open consent')]), {
      '@open': consent,
      '@close': () => screen([element('@continue', 'Continue')]),
    });
    f.deps.fill = async (ref) => {
      f.actions.push(`fill ${ref}`);
      f.show(consent(true));
      return { ok: true, proven: true, executed: true };
    };
    f.deps.back = async () => {
      f.actions.push('back');
      f.show(consent());
      return { ok: true, proven: false, executed: true };
    };
    const result = await run(
      '1. Tap "Open consent"\n2. Fill "Name" with "Example"\n3. Go back\n4. Wait for "Continue" to appear',
      f,
    );
    assert.equal(result.verdict, 'FAIL', decline);
    assert.equal(result.failure?.step, 4, decline);
    assert.equal(result.failure?.subreason, 'previous-plan-press', decline);
    assert.deepEqual(f.actions, ['press @open', 'fill @name', 'back'], decline);
    assert.equal(result.recoveries, 0, decline);
    assert.ok(f.vetoes.includes('previous-plan-press'), decline);
  }
});

test('an unsolicited sheet after the identified Accept destination departs is dismissed once', async () => {
  const consent = () => withModal(screen([element('@accept', 'Accept'), close('Skip')]), 'consent');
  const home = () => withModal(screen([element('@home', 'Home', { kind: 'text' })]), 'home');
  const sheet = () => withModal(screen([close()]), 'offer');
  const f = app(opener(), { '@open': consent, '@accept': home, '@close': ready });
  f.deps.back = async () => {
    f.actions.push('back');
    f.show(sheet());
    return { ok: true, proven: true, executed: true };
  };
  const result = await run(
    '1. Tap "Open"\n2. Tap "Accept"\n3. Go back\n4. Wait for "Ready" to appear',
    f,
  );
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @open', 'press @accept', 'back', 'press @close']);
  assert.equal(result.recoveries, 1);
  assert.ok(!f.vetoes.includes('previous-plan-press'));
});

test('Accept re-arms protection for an unidentified onboarding destination and later sheet', async () => {
  for (const laterSheet of [false, true]) {
    const consent = () =>
      withModal(screen([element('@accept', 'Accept'), close('Close')]), 'consent');
    const onboarding = () =>
      withModal(screen([element('@heading', 'Onboarding', { kind: 'text' }), close('Skip')]));
    const f = app(opener(), { '@open': consent, '@accept': onboarding, '@close': ready });
    if (laterSheet) {
      f.deps.row = (row) => {
        if (row.line === 2 && row.outcome === 'pass') f.show(withModal(screen([close()]), 'offer'));
      };
    }
    const result = await run('1. Tap "Open"\n2. Tap "Accept"\n3. Wait for "Ready" to appear', f);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failure?.step, 3);
    assert.equal(result.failure?.subreason, 'previous-plan-press');
    assert.deepEqual(f.actions, ['press @open', 'press @accept']);
    assert.equal(result.recoveries, 0);
  }
});

test('cross-block Accept submitting in existing consent keeps its asynchronous destination protected', async () => {
  const consent = (submitting = false) =>
    withModal(
      screen([element('@accept', submitting ? 'Submitting' : 'Accept'), close()]),
      'consent',
    );
  const f = app(withModal(opener()), {
    '@open': () => consent(),
    '@accept': () => consent(true),
    '@close': ready,
  });
  f.deps.row = (row) => {
    if (row.line === 4 && row.outcome === 'pass')
      f.show(
        withModal(screen([element('@heading', 'Onboarding', { kind: 'text' }), close('Skip')])),
      );
  };
  const result = await run(
    '### Consent\n1. Tap "Open"\n### Accept\n2. Tap "Accept"\n3. Wait for "Ready" to appear',
    f,
  );
  assert.ok(result.steps.some((row) => row.line === 4 && row.outcome === 'pass'));
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 5);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
  assert.deepEqual(f.actions, ['press @open', 'press @accept']);
  assert.equal(result.recoveries, 0);
});

test('scrolling every original consent element offscreen never permits dismissal', async () => {
  for (const identified of [true, false]) {
    for (const direction of ['up', 'down']) {
      const wrap = (snapshot: Screen) => (identified ? withModal(snapshot, 'consent') : snapshot);
      const f = app(opener(), {
        '@open': () => wrap(screen([element('@heading', 'Consent', { kind: 'text' })])),
        '@close': ready,
      });
      f.deps.scroll = async () => {
        f.actions.push(`scroll ${direction}`);
        f.show(
          wrap(
            screen([
              element('@heading', 'Consent', { kind: 'text', offscreen: true }),
              element('@end', 'End of terms', { kind: 'text' }),
              close('Skip'),
            ]),
          ),
        );
        return { ok: true, proven: true, executed: true };
      };
      const result = await run(
        `1. Tap "Open"\n2. Scroll ${direction}\n3. Wait for "Ready" to appear`,
        f,
      );
      assert.equal(result.verdict, 'FAIL');
      assert.equal(result.failure?.subreason, 'previous-plan-press');
      assert.deepEqual(f.actions, ['press @open', `scroll ${direction}`]);
      assert.equal(result.recoveries, 0);
    }
  }
});

test('a sheet that the planned press opened with its screen stays protected after a passing wait', async () => {
  const sheetHome = () =>
    screen([element('@sheet', 'Sheet', { kind: 'text' }), element('@card', 'Card'), close()]);
  const f = app(opener(), { '@open': sheetHome, '@close': ready });
  const result = await run(
    '1. Tap "Open"\n2. Wait for "Sheet" to appear\n3. Wait for "Ready" to appear',
    f,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.failure?.step, 3);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
});

test('an unsolicited sheet before any planned press still recovers', async () => {
  const f = app(destination(), { '@close': ready });
  const result = await run('1. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
});

test('a recovery decline press never protects the next item', async () => {
  const promo = () => screen([element('@close', 'Close')]);
  let declines = 0;
  const f = app(promo(), {
    '@close': () =>
      ++declines === 1
        ? screen([element('@settings', 'Settings')])
        : screen([element('@profile', 'Profile')]),
  });
  // Once the retried first wait passes, a second sheet covers the next target.
  let retried = false;
  f.deps.row = (row) => {
    if (row.outcome === 'retry') retried = true;
    else if (retried && row.outcome === 'pass' && row.line === 1) f.show(promo());
  };
  const result = await run('1. Wait for "Settings" to appear\n2. Wait for "Profile" to appear', f);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @close', 'press @close']);
  assert.ok(!f.vetoes.includes('previous-plan-press'));
});

test('a login replay clears protection and its own press never sets it', async () => {
  const home = () => screen([element('@home', 'Home')]);
  const sheet = () => screen([close()]);
  const wall = () => screen([element('@signin', 'Sign in', { testID: 'login-screen' })]);
  const f = app(opener(), { '@open': wall, '@signin': home, '@close': ready });
  f.deps.login = {
    marker: { id: 'login-screen' },
    block: { ...parsePlan('1. Tap "Sign in"').blocks![0], slug: 'login' },
  };
  // Once the retried wait passes, a sheet covers the next target.
  let retried = false;
  f.deps.row = (row) => {
    if (row.outcome === 'retry') retried = true;
    else if (retried && row.outcome === 'pass' && row.line === 2) f.show(sheet());
  };
  const result = await run(
    '1. Tap "Open"\n2. Wait for "Home" to appear\n3. Wait for "Ready" to appear',
    f,
  );
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @open', 'press @signin', 'press @close']);
  assert.ok(!f.vetoes.includes('previous-plan-press'));
});

test('login replay clears the previous dismissal veto from a retried target or check failure', async () => {
  for (const next of ['2. Wait for "Dashboard" to appear', '✓ "Dashboard"']) {
    const wall = () =>
      screen([
        element('@signin', 'Sign in', { testID: 'login-screen' }),
        element('@cancel', 'Cancel'),
      ]);
    const f = app(opener(), {
      '@open': wall,
      '@signin': () => screen([element('@home', 'Home')]),
    });
    f.deps.login = {
      marker: { id: 'login-screen' },
      block: { ...parsePlan('1. Tap "Sign in"').blocks![0], slug: 'login' },
    };
    const result = await run(`1. Tap "Open"\n${next}`, f);
    assert.equal(result.verdict, 'FAIL', next);
    assert.equal(result.failure?.step, 2, next);
    assert.ok(f.vetoes.includes('previous-plan-press'), next);
    assert.equal(result.recoveries, 1, next);
    assert.deepEqual(f.actions, ['press @open', 'press @signin'], next);
    assert.ok(
      result.steps.some((row) => row.reason?.includes('recovered: login')),
      next,
    );
    assert.doesNotMatch(result.failure?.seen ?? '', /automatic app dismissal was withheld/, next);
    if (next.startsWith('2.')) {
      assert.equal(result.failure?.subreason, 'absent');
      assert.match(result.failure?.suggestion ?? '', /inserting the missing step/);
    } else {
      assert.equal(result.failure?.subreason, undefined);
    }
  }
});

test('a capture failure after a planned press keeps its own cause', async () => {
  const f = app(opener(), { '@open': destination });
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    if (f.actions.length) throw new Error('capture broke');
    return capture(options);
  };
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f).catch(
    (error: Error) => error,
  );
  const subreason = result instanceof Error ? undefined : result.failure?.subreason;
  assert.notEqual(subreason, 'previous-plan-press');
  assert.deepEqual(f.actions, ['press @open']);
});

// AI-484: a permission opt-in after the plan's own tap is declined once when every condition holds.
const NOTIFY = 'Get notifications when your order ships';
const permission = (
  decline = 'Not now',
  accept = 'Allow',
  text = NOTIFY,
  ...extra: Screen['elements']
) =>
  screen([
    element('@body', text, { kind: 'text' }),
    element('@decline', decline),
    element('@accept', accept),
    ...extra,
  ]);
const DECLINED =
  /declined a permission opt-in that followed the plan's own tap \((.+)\); retrying the step once/;

function assertDeclined(
  result: Awaited<ReturnType<typeof run>>,
  f: ReturnType<typeof app>,
  name = '',
) {
  assert.equal(result.verdict, 'PASS', name);
  assert.ok(!f.actions.includes('press @accept'), name);
  assert.equal(result.recoveries, 1, name);
  const retry = result.steps.find((row) => row.outcome === 'retry');
  assert.match(retry?.reason ?? '', DECLINED, name);
  assert.equal(retry?.interruption?.outcome, 'dismissed', name);
  assert.equal(retry?.interruption?.screenClass, 'permission-opt-in', name);
  assert.equal(retry?.interruption?.afterPlannedPress, true, name);
}

test('a qualifying opt-in after a planned tap is declined once and the step passes', async () => {
  for (const [decline, accept, text] of [
    ['Not now', 'Allow', NOTIFY],
    ['Skip', 'Yes, notify me', 'Stay in the loop'],
    ["Don't allow", 'Enable notifications', 'Stay in the loop'],
    ['Later', 'Allow access to my location', 'Find stores near you'],
  ]) {
    const f = app(opener(), {
      '@open': () => permission(decline, accept, text),
      '@decline': ready,
    });
    const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
    assertDeclined(result, f, decline);
    assert.deepEqual(f.actions, ['press @open', 'press @decline'], decline);
    assert.deepEqual(result.declinedOptIns, [{ line: 2, afterPlannedPress: true }], decline);
    assert.equal(result.steps.filter((row) => row.interruption?.afterPlannedPress).length, 2);
    assert.equal(
      result.steps.find((row) => row.outcome === 'retry')?.reason?.match(DECLINED)?.[1],
      decline,
    );
  }
});

test('an opt-in the planned tap revealed in place, or a delayed one after loading, is inside the decision', async () => {
  const inPlace = app(
    screen([element('@title', 'Orders', { kind: 'text' }), element('@open', 'Open')]),
    {
      '@open': () =>
        permission('Not now', 'Allow', NOTIFY, element('@title', 'Orders', { kind: 'text' })),
      '@decline': ready,
    },
  );
  assertDeclined(
    await run('1. Tap "Open"\n2. Wait for "Ready" to appear', inPlace),
    inPlace,
    'in place',
  );
  const delayed = app(opener(), {
    '@open': () => screen([element('@heading', 'Loading', { kind: 'text' })]),
    '@decline': ready,
  });
  delayed.deps.row = (row) => {
    if (row.line === 1 && row.outcome === 'pass') delayed.show(permission('Skip', 'Allow'));
  };
  assertDeclined(
    await run('1. Tap "Open"\n2. Wait for "Ready" to appear', delayed),
    delayed,
    'delayed',
  );
});

test('an opt-in that fails a condition keeps the named refusal and taps nothing after the planned tap', async () => {
  const cases: Record<string, { before?: Screen; after: () => Screen; plan?: string }> = {
    'consent wording in the body': {
      after: () => permission('Skip', 'Allow', 'Your privacy choices for notifications'),
    },
    'no permission subject for a bare accept': {
      after: () => permission('Skip', 'Allow', 'Before you go'),
    },
    'an accept outside the closed forms': {
      after: () => permission('Not now', 'Allow all notifications'),
    },
    'an unassociated React control': {
      after: () => ({ ...permission(), semanticUnassociatedReact: 1 }),
    },
    'the plan tapped Allow': {
      before: screen([element('@open', 'Allow')]),
      after: () => permission(),
      plan: '1. Tap "Allow"\n2. Wait for "Ready" to appear',
    },
    'the plan tapped Not now': {
      before: screen([element('@open', 'Not now')]),
      after: () => permission(),
      plan: '1. Tap "Not now"\n2. Wait for "Ready" to appear',
    },
    'more info with unchanged controls': {
      before: screen([
        element('@open', 'More info'),
        element('@decline', 'Not now'),
        element('@accept', 'Allow'),
      ]),
      after: () => permission(),
      plan: '1. Tap "More info"\n2. Wait for "Ready" to appear',
    },
  };
  for (const [name, { before = opener(), after, plan }] of Object.entries(cases)) {
    const f = app(before, { '@open': after, '@decline': ready, '@accept': ready });
    const result = await run(plan ?? '1. Tap "Open"\n2. Wait for "Ready" to appear', f);
    assert.equal(result.verdict, 'FAIL', name);
    assert.deepEqual(f.actions, ['press @open'], name);
    assert.equal(result.failure?.subreason, 'previous-plan-press', name);
    assert.ok(f.vetoes.includes('previous-plan-press'), name);
    assert.equal(result.declinedOptIns, undefined, name);
  }
});

test('the decline is proven only when both opt-in controls are gone; otherwise nothing is retried', async () => {
  const f = app(opener(), {
    '@open': () => permission(),
    '@decline': () =>
      screen([element('@body', NOTIFY, { kind: 'text' }), element('@accept', 'Allow')]),
  });
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open', 'press @decline']);
  assert.match(
    result.failure?.seen ?? '',
    /the permission opt-in was still in front after its decline; it was not retried/,
  );
  const failed = result.steps.find((row) => row.line === 2 && row.outcome === 'fail');
  assert.equal(failed?.interruption?.outcome, 'did-not-disappear');
  assert.equal(failed?.interruption?.afterPlannedPress, true);
});

test('a declined opt-in that returns is never tapped again, on a later item or after protection lapsed', async () => {
  const later = app(opener(), {
    '@open': () => permission(),
    '@decline': () => screen([element('@again', 'Again')]),
    '@again': () => permission(),
  });
  const repeated = await run('1. Tap "Open"\n2. Tap "Again"\n3. Wait for "Ready" to appear', later);
  assert.equal(repeated.verdict, 'FAIL');
  assert.deepEqual(later.actions, ['press @open', 'press @decline', 'press @again']);
  assert.match(
    repeated.failure?.seen ?? '',
    /the app asked again after recovery declined this permission opt-in; nothing was tapped/,
  );
  assert.equal(repeated.failure?.suggestion, 'Add a step after line 2: Tap "Not now".');
  const lapsed = app(opener(), { '@open': () => permission(), '@decline': ready });
  lapsed.deps.row = (row) => {
    if (row.line === 3 && row.outcome === 'pass') lapsed.show(permission());
  };
  const afterLapse = await run(
    '1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Wait for "Ready" to appear\n4. Wait for "Done" to appear',
    lapsed,
  );
  assert.equal(afterLapse.verdict, 'FAIL');
  assert.deepEqual(lapsed.actions, ['press @open', 'press @decline']);
  assert.equal(afterLapse.failure?.step, 4);
  assert.match(afterLapse.failure?.seen ?? '', /asked again after recovery declined/);
  assert.equal(afterLapse.failure?.suggestion, 'Add a step before line 4: Tap "Not now".');
  let ordinaryDeclines = 0;
  const ordinaryFirst = app(permission(), {
    '@decline': () => (++ordinaryDeclines === 1 ? opener() : ready()),
    '@open': ready,
  });
  ordinaryFirst.deps.row = (row) => {
    if (row.line === 3 && row.outcome === 'pass') ordinaryFirst.show(permission());
  };
  const afterOrdinary = await run(
    '1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Wait for "Ready" to appear\n4. Wait for "Ready" to appear',
    ordinaryFirst,
  );
  assert.equal(afterOrdinary.verdict, 'PASS');
  assert.deepEqual(ordinaryFirst.actions, ['press @decline', 'press @open', 'press @decline']);
  assert.deepEqual(afterOrdinary.declinedOptIns, [
    { line: 1, afterPlannedPress: false },
    { line: 4, afterPlannedPress: false },
  ]);
});

test('the press record is the original dispatch capture through a delayed dialog and after its own recovery', async () => {
  const dialogFirst = app(opener(), { '@decline': ready });
  dialogFirst.deps.row = (row) => {
    if (row.line === 1 && row.outcome === 'retry')
      dialogFirst.show({ ...screen([element('@allow', 'Allow')]), front: 'dialog' });
  };
  dialogFirst.deps.dialog = async (action) => {
    dialogFirst.actions.push(`dialog ${action}`);
    dialogFirst.show(permission());
    return { ok: true, proven: true, executed: true };
  };
  const delayed = await run(
    '1. Tap "Open"\n2. Dismiss the permission dialog\n3. Wait for "Ready" to appear',
    dialogFirst,
  );
  assert.equal(delayed.verdict, 'PASS');
  const declinedRow = delayed.steps.find((row) => row.line === 3 && row.outcome === 'retry');
  assert.match(declinedRow?.reason ?? '', DECLINED);
  assert.equal(declinedRow?.interruption?.afterPlannedPress, true);
  assert.deepEqual(delayed.declinedOptIns, [{ line: 3, afterPlannedPress: true }]);
  assert.deepEqual(dialogFirst.actions, ['press @open', 'dialog dismiss', 'press @decline']);
  let declines = 0;
  const promoFirst = app(
    screen([element('@title', 'Sale today', { kind: 'text' }), element('@decline', 'Not now')]),
    {
      '@decline': () => (declines++ === 0 ? opener() : ready()),
      '@open': () => permission(),
    },
  );
  const recovered = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', promoFirst);
  assert.equal(recovered.verdict, 'PASS');
  assert.deepEqual(promoFirst.actions, ['press @decline', 'press @open', 'press @decline']);
  assert.ok(!promoFirst.actions.includes('press @accept'));
  assert.deepEqual(recovered.declinedOptIns, [{ line: 2, afterPlannedPress: true }]);
});

test('a protected value equal to the decline word is never printed by the opt-in row', async () => {
  const f = app(opener(), {
    '@open': () => permission('Skip', 'Enable notifications'),
    '@decline': ready,
  });
  f.deps.privacy = new ObservedPrivacy();
  f.deps.privacy.classify(['Skip']);
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @open', 'press @decline']);
  const retry = result.steps.find((row) => row.outcome === 'retry');
  assert.equal(retry?.interruption?.afterPlannedPress, true);
  assert.doesNotMatch(JSON.stringify(result.steps), /Skip/);
});

test('normalized decline and accept forms dispatch only the observed decline label', async () => {
  for (const decline of [
    'skip',
    'NOT NOW',
    ' Later ',
    'Maybe\t later',
    'NO  THANKS',
    'don‘t allow',
  ]) {
    for (const accept of [' allow ', 'ENABLE', 'TURN\t ON', 'Notify  me', ' YES,\t NOTIFY ME ']) {
      const f = app(opener(), { '@open': () => permission(decline, accept), '@decline': ready });
      const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
      assert.equal(result.verdict, 'PASS', `${decline} / ${accept}: ${result.failure?.seen}`);
      assert.deepEqual(f.actions, ['press @open', 'press @decline']);
      assert.deepEqual(result.declinedOptIns, [{ line: 2, afterPlannedPress: true }]);
    }
  }
});

test('a normalized opt-in still in front after a later pass keeps planned-press protection', async () => {
  const snapshot = screen([
    ...permission(' NOT  NOW ', ' allow ').elements,
    element('@ready', 'Ready', { kind: 'text' }),
  ]);
  const f = app(opener(), {
    '@open': () => snapshot,
    '@decline': () => screen([element('@done', 'Done', { kind: 'text' })]),
  });
  const result = await run(
    '1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Wait for "Done" to appear',
    f,
  );
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @open', 'press @decline']);
  assert.deepEqual(result.declinedOptIns, [{ line: 3, afterPlannedPress: true }]);
});

test('changed casing or spacing does not prove an opt-in control disappeared', async () => {
  for (const [ref, label] of [
    ['@decline', ' NOT\t NOW '],
    ['@accept', ' ALLOW '],
  ]) {
    const f = app(opener(), {
      '@open': () => permission(),
      '@decline': () => screen([element(ref, label)]),
    });
    const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
    assert.equal(result.verdict, 'FAIL', label);
    assert.deepEqual(f.actions, ['press @open', 'press @decline']);
    assert.match(result.failure?.seen ?? '', /permission opt-in was still in front/);
  }
});

test('a second opt-in sharing a normalized decline word keeps the per-item refusal', async () => {
  let declines = 0;
  const f = app(opener(), {
    '@open': () => permission(),
    '@decline': () => (++declines === 1 ? screen([]) : ready()),
  });
  f.deps.row = (row) => {
    if (row.line === 2 && row.outcome === 'retry' && row.interruption?.afterPlannedPress)
      f.show(permission(' NOT\t NOW ', 'Allow location'));
  };
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open', 'press @decline']);
  assert.match(result.failure?.seen ?? '', /app interruption did not disappear/);
});

test('normalized repeat signatures survive lapse and private decline variants stay withheld', async () => {
  for (const decline of ['skip', ' SKIP ', 'Skip']) {
    const f = app(opener(), {
      '@open': () => permission(decline, ' ENABLE NOTIFICATIONS '),
      '@decline': ready,
    });
    f.deps.privacy = new ObservedPrivacy();
    f.deps.privacy.classify([decline, 'sKiP']);
    f.deps.row = (row) => {
      if (row.line === 3 && row.outcome === 'pass')
        f.show(permission('sKiP', 'enable notifications'));
    };
    const result = await run(
      '1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Wait for "Ready" to appear\n4. Wait for "Done" to appear',
      f,
    );
    assert.equal(result.verdict, 'FAIL', result.failure?.seen);
    assert.deepEqual(f.actions, ['press @open', 'press @decline']);
    assert.match(result.failure?.seen ?? '', /asked again after recovery declined/);
    assert.equal(JSON.stringify(result.steps).includes(decline), false);
    assert.ok(!result.failure?.suggestion?.includes('sKiP'));
  }
});

test('two different opt-ins on one item are both declined; two sharing a decline word keep the per-item refusal', async () => {
  const two = app(opener(), {
    '@open': () => permission(),
    '@decline': () =>
      screen([
        element('@body', 'Find stores near you', { kind: 'text' }),
        element('@skip', 'Skip'),
        element('@accept2', 'Allow location'),
      ]),
    '@skip': ready,
  });
  const both = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', two);
  assert.equal(both.verdict, 'PASS');
  assert.deepEqual(two.actions, ['press @open', 'press @decline', 'press @skip']);
  assert.deepEqual(both.declinedOptIns, [
    { line: 2, afterPlannedPress: true },
    { line: 2, afterPlannedPress: true },
  ]);
  const shared = app(opener(), {
    '@open': () => permission(),
    '@decline': () => permission('Not now', 'Allow location', 'Find stores near you'),
  });
  const refused = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', shared);
  assert.equal(refused.verdict, 'FAIL');
  assert.deepEqual(shared.actions, ['press @open', 'press @decline']);
});

test('after protection lapses on a clean pass the ordinary rule takes an opt-in, and a passedSince opt-in is declined by the exception', async () => {
  const clean = app(opener(), {
    '@open': () => screen([element('@title', 'Welcome', { kind: 'text' })]),
    '@decline': ready,
  });
  clean.deps.row = (row) => {
    if (row.line === 2 && row.outcome === 'pass') clean.show(permission());
  };
  const ordinary = await run(
    '1. Tap "Open"\n2. Wait for "Welcome" to appear\n3. Wait for "Ready" to appear',
    clean,
  );
  assert.equal(ordinary.verdict, 'PASS');
  assert.deepEqual(clean.actions, ['press @open', 'press @decline']);
  const retry = ordinary.steps.find((row) => row.outcome === 'retry');
  assert.match(
    retry?.reason ?? '',
    /recovered: dismissed a permission opt-in with Not now; retrying the step once/,
  );
  assert.equal(retry?.interruption?.afterPlannedPress, undefined);
  assert.deepEqual(ordinary.declinedOptIns, [{ line: 3, afterPlannedPress: false }]);
  const kept = app(opener(), {
    '@open': () =>
      permission('Not now', 'Allow', NOTIFY, element('@title', 'Welcome', { kind: 'text' })),
    '@decline': ready,
  });
  const passedSince = await run(
    '1. Tap "Open"\n2. Wait for "Welcome" to appear\n3. Wait for "Ready" to appear',
    kept,
  );
  assertDeclined(passedSince, kept, 'passedSince');
  assert.deepEqual(passedSince.declinedOptIns, [{ line: 3, afterPlannedPress: true }]);
});

test('the dispatch re-check reads protection afresh: a departed destination leaves the ordinary rule', async () => {
  const f = app(withModal(opener()), {
    '@open': () => withModal(permission(), 'optin-modal'),
    '@decline': () => withModal(ready()),
  });
  f.deps.interruptionVeto = true;
  f.deps.judge = scriptedJudge(() => {
    f.show(withModal(permission()));
    return { interruption: { type: 'noul', noul: 0.99 } };
  });
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @open', 'press @decline']);
  const retry = result.steps.find((row) => row.outcome === 'retry');
  assert.equal(retry?.interruption?.afterPlannedPress, undefined);
  assert.doesNotMatch(retry?.reason ?? '', DECLINED);
  assert.deepEqual(result.declinedOptIns, [{ line: 2, afterPlannedPress: false }]);
  const promo = app(withModal(opener()), {
    '@open': () => withModal(permission(), 'optin-modal'),
    '@decline': () => withModal(ready()),
  });
  promo.deps.interruptionVeto = true;
  promo.deps.judge = scriptedJudge(() => {
    promo.show({
      ...withModal(
        screen([
          element('@sale', 'Sale ends tonight', { kind: 'text' }),
          element('@decline', 'Not now'),
          element('@buy', 'Buy now'),
        ]),
      ),
      fillGapCount: 0,
    });
    return { interruption: { type: 'noul', noul: 0.99 } };
  });
  const changed = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', promo);
  assert.equal(changed.verdict, 'PASS');
  assert.deepEqual(promo.actions, ['press @open', 'press @decline']);
  assert.equal(changed.declinedOptIns, undefined);
});

test('an opt-in after a press dispatched from an incomplete capture keeps the planned-press veto', async () => {
  const partial: Screen = { ...opener(), coverage: { native: 'complete', react: 'incomplete' } };
  const f = app(partial, { '@open': () => permission(), '@decline': ready });
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
});

test('the same opt-in back on the same item after its decline keeps the per-item refusal', async () => {
  const f = app(opener(), {
    '@open': () => permission(),
    '@decline': () => screen([element('@loading', 'Loading', { kind: 'text' })]),
  });
  f.deps.row = (row) => {
    if (row.line === 2 && row.outcome === 'retry' && row.interruption?.afterPlannedPress)
      f.show(permission());
  };
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open', 'press @decline']);
  assert.equal(result.failure?.step, 2);
  assert.match(result.failure?.seen ?? '', /the app interruption did not disappear/);
});

test('the judge veto stays in force over the opt-in exception', async () => {
  for (const [noul, verdict] of [
    [0.1, 'REFUSED'],
    [0.99, 'PASS'],
  ] as const) {
    const f = app(opener(), { '@open': () => permission(), '@decline': ready });
    f.deps.interruptionVeto = true;
    f.deps.judge = scriptedJudge(() => ({ interruption: { type: 'noul', noul } }));
    const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
    assert.equal(result.verdict, verdict, String(noul));
    assert.deepEqual(
      f.actions,
      verdict === 'PASS' ? ['press @open', 'press @decline'] : ['press @open'],
      String(noul),
    );
    if (verdict === 'REFUSED') assert.equal(result.code, 'INTERRUPTION_VETOED');
  }
});

test('a replayed step whose declared target names an opt-in control withholds the exception', async () => {
  const plan = parsePlan('1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Tap "Allow"').blocks![0];
  const stored = (third: string) => ({
    header: { appId: 'app', plan: plan.slug, planHash: plan.planHash, platform: 'ios' as const },
    steps: [
      { kind: 'press' as const, raw: plan.items[0].raw, selector: { text: 'Open' } },
      { kind: 'wait' as const, raw: plan.items[1].raw, selector: { text: 'Ready' } },
      { kind: 'press' as const, raw: plan.items[2].raw, selector: { id: third } },
    ],
  });
  const replayed = replayBlock(plan, stored('stale-allow-id'));
  assert.deepEqual(replayed.items[2].declared, { quoted: 'Allow', phrase: 'Allow' });
  const f = app(opener(), { '@open': () => permission(), '@decline': ready });
  const refused = await runPlan([replayed], f.deps);
  assert.equal(refused.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open']);
  const walked = app(opener(), { '@open': () => permission(), '@decline': ready });
  const plain = await run(
    '1. Tap "Open"\n2. Wait for "Ready" to appear\n3. Tap "Checkout"',
    walked,
  );
  assert.deepEqual(walked.actions.slice(0, 2), ['press @open', 'press @decline']);
  assert.equal(plain.declinedOptIns?.[0]?.afterPlannedPress, true);
});

test('a system permission alert after a planned tap is still declined by the dialog branch', async () => {
  const f = app(opener(), {
    '@open': () => ({
      ...screen([element('@deny', "Don't Allow"), element('@allow', 'Allow')]),
      front: 'dialog',
    }),
  });
  const dialog = f.deps.dialog;
  f.deps.dialog = async (action, context) => {
    f.show(ready());
    return dialog(action, context);
  };
  const result = await run('1. Tap "Open"\n2. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @open', 'dialog dismiss']);
  assert.equal(result.declinedOptIns, undefined);
});
