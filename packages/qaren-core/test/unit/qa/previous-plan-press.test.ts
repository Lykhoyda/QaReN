import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { Screen } from '../../../dist/qa/screen.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
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

test('protection ends after the item that followed the press', async () => {
  const f = app(opener(), { '@open': () => screen([element('@back', 'Next')]) });
  f.deps.back = async () => {
    f.actions.push('back');
    f.show(destination());
    return { ok: true, proven: false, executed: true };
  };
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    const acted = await press(ref, context);
    if (ref === '@close') f.show(ready());
    return acted;
  };
  const result = await run('1. Tap "Open"\n2. Go back\n3. Wait for "Ready" to appear', f);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @open', 'back', 'press @close']);
  assert.equal(result.recoveries, 1);
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
