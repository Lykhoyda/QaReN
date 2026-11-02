import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { Screen } from '../../../dist/qa/screen.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import { element, screen } from './judgment-fixtures.ts';

const opener = () => screen([element('@open', 'Open')]);
const ready = () => screen([element('@ready', 'Ready')]);
// The screen the plan's own press opens: no planned target yet, one decline control.
const destination = () => screen([element('@title', 'Details', { kind: 'text' }), close()]);
const close = (label = 'Close') => element('@close', label);

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
    assert.equal(result.failure?.suggestion, undefined, name);
    assert.ok(result.failure?.screen, name);
    assert.match(
      result.failure?.seen ?? '',
      /the previous planned press succeeded; the next target was not found; automatic app dismissal was withheld/,
      name,
    );
    assert.ok(f.vetoes.includes('previous-plan-press'), name);
  }
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

// The consent the plan opens, closed by Go back onto Home; a sheet then covers the next target.
function consentThenSheet(consentDecline: string) {
  const consent = () =>
    screen([element('@heading', 'Consent', { kind: 'text' }), close(consentDecline)]);
  const home = () => screen([element('@home', 'Home', { kind: 'text' })]);
  const sheet = () => screen([element('@home', 'Home', { kind: 'text' }), close('Close')]);
  const f = app(opener(), { '@open': consent, '@close': ready });
  f.deps.back = async () => {
    f.actions.push('back');
    f.show(home());
    return { ok: true, proven: true, executed: true };
  };
  f.deps.row = (row) => {
    if (row.line === 2 && row.outcome === 'pass') f.show(sheet());
  };
  return f;
}

test('an unsolicited sheet after the planned consent closed is dismissed once', async () => {
  const f = consentThenSheet('Skip');
  const result = await run('1. Tap "Open"\n2. Go back\n3. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @open', 'back', 'press @close']);
  assert.equal(result.recoveries, 1);
  assert.ok(!f.vetoes.includes('previous-plan-press'));
});

test('a later sheet sharing the closed consent decline label stays protected', async () => {
  // Label-only identities cannot tell the two Close controls apart, so recovery refuses rather than guess.
  const f = consentThenSheet('Close');
  const result = await run('1. Tap "Open"\n2. Go back\n3. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @open', 'back']);
  assert.equal(result.failure?.subreason, 'previous-plan-press');
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
