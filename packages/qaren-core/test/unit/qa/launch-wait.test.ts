import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import type { Ledger, LedgerRow } from '../../../dist/qa/ledger.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import {
  LAUNCH_MISS,
  WAIT_BUDGET_MS,
  runPlan,
  walkBlock,
  type BlockStore,
  type WalkerDeps,
} from '../../../dist/qa/walker.js';
import { element, scriptedJudge } from './judgment-fixtures.ts';

function blocks(markdown: string): Block[] {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks;
}

const view = (elements: Element[], front: Screen['front'] = 'app'): Screen => ({
  front,
  elements,
  visibleText: elements.map((e) => e.label ?? ''),
  coverage: { native: 'complete', react: 'complete' },
});

const home = element('@home', 'Home', { kind: 'text', testID: 'home-title' });
const profile = element('@profile', 'Profile', { testID: 'profile-button' });

interface App {
  deps: WalkerDeps;
  actions: string[];
  rows: LedgerRow[];
  captures: () => number;
  clock: () => number;
}

// A device whose screen is a function of the clock and of what was pressed; nothing advances time but sleep.
function app(
  render: (t: number, pressed: string[]) => Screen,
  extra: Partial<WalkerDeps> = {},
): App {
  const actions: string[] = [];
  const rows: LedgerRow[] = [];
  let time = 0;
  let captures = 0;
  const deps: WalkerDeps = {
    judge: scriptedJudge(() => assert.fail('a literal plan must never ask Jev')),
    async captureScreen() {
      captures += 1;
      time += 100;
      return render(time, actions);
    },
    async press(ref) {
      actions.push(`press ${ref}`);
      return { ok: true, proven: false };
    },
    async fill(ref, text) {
      actions.push(`fill ${ref} ${text}`);
      return { ok: true, proven: true };
    },
    async scroll(direction) {
      actions.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    },
    async back() {
      actions.push('back');
      return { ok: true, proven: false };
    },
    async dialog(action) {
      actions.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async hideDevMenu() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => time,
    async sleep(ms) {
      time += ms;
    },
    row: (row) => {
      rows.push(row);
    },
    ...extra,
  };
  return { deps, actions, rows, captures: () => captures, clock: () => time };
}

// The profile control renders `at` ms after launch and the press moves the app on.
const lateProfile =
  (at: number) =>
  (t: number, pressed: string[]): Screen =>
    pressed.includes('press @profile')
      ? view([element('@settings', 'Settings')])
      : view(t >= at ? [home, profile] : [home]);

const ledgerOf = async (markdown: string, deps: WalkerDeps): Promise<Ledger> =>
  (await runPlan(blocks(markdown), deps)) as Ledger;

const failingRow = (ledger: Ledger): LedgerRow => ledger.steps[ledger.steps.length - 1];

test('the first press after launch waits for a target that renders late, then passes from that observation', async () => {
  const device = app(lateProfile(5_000));
  const ledger = await ledgerOf('1. Wait for "Home"\n2. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
  assert.deepEqual(device.actions, ['press @profile']);
  const press = ledger.steps.find((row) => row.line === 2 && row.outcome === 'pass')!;
  assert.ok(press.implicitWaitMs !== undefined);
  assert.ok(
    press.implicitWaitMs! >= 4_000 && press.implicitWaitMs! < 6_000,
    `implicitWaitMs ${press.implicitWaitMs}`,
  );
  assert.equal(
    ledger.steps.filter((row) => row.line === 2).length,
    1,
    'the poll adds no retry row',
  );
  // The streamed value-free row carries the number too.
  assert.equal(device.rows.find((row) => row.line === 2)?.implicitWaitMs, press.implicitWaitMs);
});

test('a first target already present passes without polling', async () => {
  const device = app(lateProfile(0));
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.ok(ledger.steps.every((row) => row.implicitWaitMs === undefined));
  assert.ok(device.captures() < 6, `captures ${device.captures()}`);
});

test('a first target that never renders fails with the launch reason and suggestion within the budget', async () => {
  const device = app(lateProfile(Infinity));
  const ledger = await ledgerOf('1. Wait for "Home"\n2. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'FAIL');
  const failure = ledger.failure!;
  assert.equal(failure.step, 2);
  assert.match(
    failure.seen,
    new RegExp(`^${LAUNCH_MISS}: the first step after launch found its target absent for 15 s;`),
  );
  assert.doesNotMatch(failure.seen, /the screen changed/);
  assert.equal(
    failure.suggestion,
    'insert Wait for "Profile" before line 2, or move line 1\'s wait to an element that renders with it',
  );
  // Target-class diagnostics still apply.
  assert.equal(failure.subreason, 'absent');
  assert.ok(failure.screen);
  assert.deepEqual(device.actions, []);
  const row = failingRow(ledger);
  assert.equal(row.outcome, 'fail');
  assert.ok(row.implicitWaitMs! > 0 && row.implicitWaitMs! <= WAIT_BUDGET_MS);
  assert.ok(device.clock() <= WAIT_BUDGET_MS + 1_000, `ended at ${device.clock()}`);
});

test('without an earlier wait the suggestion names only the missing wait', async () => {
  const device = app(lateProfile(Infinity));
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(
    ledger.failure?.suggestion,
    'insert Wait for "Profile" before line 1; the first screen had not rendered it yet',
  );
});

test('preparation resets seen during the step are counted into the reason; absent counters add nothing', async () => {
  const events: TimingEvent[] = [];
  const device = app(lateProfile(Infinity));
  const capture = device.deps.captureScreen;
  device.deps.captureScreen = async (options) => {
    options?.timing?.({
      stage: 'native-preparation',
      edge: 'point',
      outcome: 'ok',
      at: device.clock(),
      count: 2,
      resets: 1,
    });
    return capture(options);
  };
  device.deps.timing = (event) => events.push(event);
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  const prepared = events.filter((e) => e.stage === 'native-preparation').length;
  assert.ok(prepared > 1);
  assert.match(ledger.failure!.seen, new RegExp(`, the screen changed ${prepared} times during`));

  const zero = app(lateProfile(Infinity), { timing: () => {} });
  const zeroCapture = zero.deps.captureScreen;
  zero.deps.captureScreen = async (options) => {
    options?.timing?.({
      stage: 'native-preparation',
      edge: 'point',
      outcome: 'ok',
      at: 0,
      resets: 0,
    });
    return zeroCapture(options);
  };
  const quiet = await ledgerOf('1. Tap "Profile"\n', zero.deps);
  assert.doesNotMatch(quiet.failure!.seen, /the screen changed/);
});

test("a later block keeps today's immediate miss once the first press spent the allowance", async () => {
  const device = app((_t, pressed) =>
    pressed.includes('press @profile') ? view([home]) : view([home, profile]),
  );
  const ledger = await ledgerOf(
    '### Open profile\n1. Tap "Profile"\n### Open settings\n1. Tap "Settings"\n',
    device.deps,
  );
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /^TARGET_NOT_FOUND: /);
  assert.ok(ledger.steps.every((row) => row.implicitWaitMs === undefined));
  assert.ok(device.clock() < 5_000, `ended at ${device.clock()}`);
});

test('a block walked on its own has no launch allowance', async () => {
  const device = app(lateProfile(Infinity));
  const outcome = await walkBlock(blocks('1. Tap "Profile"\n')[0], device.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.ok(outcome.rows.every((row) => row.implicitWaitMs === undefined));
});

test('only an absent target polls: disabled, ambiguous and offscreen misses keep their class', async () => {
  const cases: [string, Element[], RegExp][] = [
    [
      'disabled',
      [home, element('@profile', 'Profile', { disabled: true, hittable: false })],
      /^TARGET_NOT_FOUND: /,
    ],
    ['ambiguous', [home, profile, element('@profile2', 'Profile')], /^TARGET_AMBIGUOUS: /],
    [
      'offscreen',
      [home, element('@profile', 'Profile', { offscreen: true })],
      /^(?!TARGET_NOT_FOUND_AFTER_LAUNCH)/,
    ],
  ];
  for (const [name, elements, code] of cases) {
    const device = app(() => view(elements));
    const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
    assert.equal(ledger.verdict, 'FAIL', name);
    assert.match(ledger.failure!.seen, code, name);
    assert.ok(
      ledger.steps.every((row) => row.implicitWaitMs === undefined),
      `${name} must not poll`,
    );
    assert.ok(device.clock() < 5_000, `${name} ended at ${device.clock()}`);
  }
});

test('a described (phrase) target is not polled', async () => {
  const device = app(lateProfile(Infinity));
  device.deps.judge = undefined;
  const ledger = (await runPlan(blocks('1. Tap the profile button\n'), device.deps)) as Ledger;
  assert.notEqual(ledger.verdict, 'PASS');
  assert.ok((ledger.steps ?? []).every((row) => row.implicitWaitMs === undefined));
});

test('a dialog on the first step is recovered before any polling', async () => {
  let dismissed = false;
  const device = app((t, pressed) =>
    pressed.includes('press @profile')
      ? view([element('@settings', 'Settings')])
      : dismissed
        ? view(t >= 3_000 ? [home, profile] : [home])
        : view([element('@allow', 'Allow')], 'dialog'),
  );
  const order: string[] = [];
  const capture = device.deps.captureScreen;
  device.deps.captureScreen = async (options) => {
    // Only the launch poll captures cheaply under a deadline.
    if (options?.budgetMs !== undefined && !options.platformPresence) order.push('poll');
    return capture(options);
  };
  const dialog = device.deps.dialog;
  device.deps.dialog = async (action, context) => {
    dismissed = true;
    order.push('dismiss');
    return dialog(action, context);
  };
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
  assert.equal(ledger.recoveries, 1);
  assert.deepEqual(device.actions, ['dialog dismiss', 'press @profile']);
  assert.equal(order[0], 'dismiss', order.join(','));
  assert.ok(order.includes('poll'));
  assert.match(ledger.steps.find((row) => row.outcome === 'retry')?.reason ?? '', /recovered/);
  assert.ok(ledger.steps.some((row) => row.outcome === 'pass' && row.implicitWaitMs !== undefined));
});

test('a login replay re-arms the allowance for the step it retries, after the first press spent it', async () => {
  const wall = view([element('@signin', 'Sign in', { testID: 'login-screen' })]);
  let signedInAt: number | undefined;
  const device = app((t, pressed) => {
    if (pressed.includes('press @profile')) return view([element('@settings', 'Settings')]);
    if (!pressed.includes('press @start')) return view([element('@start', 'Start')]);
    if (signedInAt === undefined) return wall;
    return view(t >= signedInAt + 3_000 ? [home, profile] : [home]);
  });
  const press = device.deps.press;
  device.deps.press = async (ref, context) => {
    if (ref === '@signin') signedInAt = device.clock();
    return press(ref, context);
  };
  device.deps.login = {
    marker: { id: 'login-screen' },
    block: { ...blocks('1. Tap "Sign in"\n')[0], slug: 'login' },
  };
  const ledger = await ledgerOf('1. Tap "Start"\n2. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
  assert.deepEqual(device.actions, ['press @start', 'press @signin', 'press @profile']);
  const start = ledger.steps.find((row) => row.line === 1 && row.block !== 'login')!;
  assert.equal(start.implicitWaitMs, undefined);
  const passed = ledger.steps.find(
    (row) => row.line === 2 && row.block !== 'login' && row.outcome === 'pass',
  )!;
  assert.ok(passed.implicitWaitMs! >= 2_000, `implicitWaitMs ${passed.implicitWaitMs}`);
});

test('cancellation during the poll stops capturing and dispatches nothing', async () => {
  let cancelAt: number | undefined;
  const device = app(lateProfile(Infinity));
  const capture = device.deps.captureScreen;
  device.deps.captureScreen = async (options) => {
    const screen = await capture(options);
    if (device.captures() === 3) cancelAt = device.clock();
    return screen;
  };
  device.deps.cancelled = () => cancelAt !== undefined;
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.deepEqual(device.actions, []);
  // The capture that observed cancellation is the last one.
  assert.equal(device.captures(), 3);
  assert.notEqual(ledger.verdict, 'PASS');
  assert.match(ledger.failure!.seen, /RUN_CANCELLED/);
});

test('a capture that stalls past the deadline ends the poll at the deadline', async () => {
  const device = app(lateProfile(Infinity));
  const capture = device.deps.captureScreen;
  const budgeted: { at: number; budgetMs: number }[] = [];
  device.deps.captureScreen = async (options) => {
    const at = device.clock();
    const screen = await capture(options);
    // The poll's own captures carry a budget; spend all of it.
    if (options?.budgetMs !== undefined && !options.platformPresence) {
      budgeted.push({ at, budgetMs: options.budgetMs });
      await device.deps.sleep(options.budgetMs);
    }
    return screen;
  };
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, new RegExp(`^${LAUNCH_MISS}: `));
  assert.deepEqual(device.actions, []);
  assert.equal(budgeted.length, 1, 'the stalled poll capture used the whole remaining budget');
  // The step starts at clock 0, so its fixed deadline is the budget itself.
  for (const { at, budgetMs } of budgeted) {
    assert.ok(at < WAIT_BUDGET_MS, `poll started at ${at}`);
    assert.ok(at + budgetMs <= WAIT_BUDGET_MS, `poll budget ran to ${at + budgetMs}`);
  }
  assert.ok(device.clock() <= WAIT_BUDGET_MS + 1_000, `ended at ${device.clock()}`);
});

test('the first Fill after launch waits for a field that renders late', async () => {
  const email = element('@email', 'Email', { kind: 'input' });
  const device = app((t) => view(t >= 4_000 ? [home, email] : [home]));
  const ledger = await ledgerOf('1. Fill "Email" with "Ada"\n', device.deps);
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
  assert.deepEqual(device.actions, ['fill @email Ada']);
  const fill = ledger.steps.find((row) => row.outcome === 'pass')!;
  assert.ok(fill.implicitWaitMs! >= 3_000, `implicitWaitMs ${fill.implicitWaitMs}`);
});

test('a re-walk after a replay miss is not a launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-launch-'));
  mkdirSync(join(dir, '.qaren'));
  const store: BlockStore = { appRoot: dir, platform: 'ios', appId: 'com.example.app' };
  const plan = '### Profile\n1. Wait for "Home"\n2. Tap "Profile"\n';
  try {
    const first = app(lateProfile(0));
    const saved = (await runPlan(blocks(plan), first.deps, [], store)) as Ledger;
    assert.equal(saved.verdict, 'PASS', JSON.stringify(saved.failure));
    // The stored home testID no longer matches, so the replay misses at line 1 and re-walks.
    const renamed = element('@home', 'Home', { kind: 'text', testID: 'home-heading' });
    const second = app(() => view([renamed]));
    const ledger = (await runPlan(blocks(plan), second.deps, [], store)) as Ledger;
    assert.match(ledger.path ?? '', /^replay→walk@/);
    assert.equal(ledger.verdict, 'FAIL');
    assert.match(ledger.failure!.seen, /^TARGET_NOT_FOUND: /);
    assert.ok(ledger.steps.every((row) => row.implicitWaitMs === undefined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
