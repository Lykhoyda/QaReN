import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { join as joinScreen } from '../../../dist/qa/screen.js';
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

for (const at of [5_000, 12_000]) {
  for (const available of [true, false]) {
    test(`a target appearing at ${at} ms ${available ? 'uses' : 'requires'} label provenance before dispatch`, async () => {
      const lateScreen = () =>
        joinScreen(
          [
            {
              ref: '@container',
              type: 'Other',
              label: 'Profile',
              hittable: true,
              rect: { x: 0, y: 0, width: 400, height: 800 },
            },
            {
              ref: '@late-profile',
              parentIndex: 0,
              type: 'Button',
              label: 'Profile',
              hittable: true,
              rect: { x: 20, y: 100, width: 100, height: 50 },
            },
          ],
          [],
          'app',
          { native: 'complete', react: 'complete' },
        );
      const device = app((t) => (t >= at ? lateScreen() : view([home])));
      let readAtCapture = 0;
      device.deps.readLabelProvenance = async (refs, deadline) => {
        assert.deepEqual(refs, ['@container', '@late-profile']);
        assert.ok(deadline > device.clock());
        assert.ok(deadline <= WAIT_BUDGET_MS - 1_500);
        readAtCapture = device.captures();
        return available
          ? refs.map((ref) => ({
              ref,
              labelSource: ref === '@container' ? ('descendant' as const) : ('direct' as const),
            }))
          : undefined;
      };
      device.deps.press = async (ref) => {
        assert.equal(device.captures(), readAtCapture);
        device.actions.push(`press ${ref}`);
        return { ok: true, proven: true };
      };
      const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
      assert.ok(readAtCapture > 1);
      if (available) {
        assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
        assert.deepEqual(device.actions, ['press @late-profile']);
      } else {
        assert.equal(ledger.verdict, 'FAIL');
        assert.match(ledger.failure!.seen, /^TARGET_AMBIGUOUS: /);
        assert.deepEqual(device.actions, []);
      }
      assert.ok(failingRow(ledger).implicitWaitMs! > 0);
    });
  }
}

test('the launch poll never accepts a segment of a merged label', async () => {
  const merged = element('@merged', 'Profile, Notifications');
  const device = app((t) => view(t >= 5_000 ? [home, merged] : [home]));
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /^TARGET_NOT_FOUND_AFTER_LAUNCH: /);
  assert.deepEqual(device.actions, []);
  assert.ok(failingRow(ledger).implicitWaitMs! > 0);
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

test('dialog recovery after a step dispatch never restores launch polling', async () => {
  let postPressCaptures = 0;
  let dismissed = false;
  const device = app((_t, actions) => {
    if (dismissed) return view([home]);
    if (!actions.includes('press @profile')) return view([home, profile]);
    postPressCaptures += 1;
    return postPressCaptures === 1
      ? view([home, profile])
      : view([element('@allow', 'Allow')], 'dialog');
  });
  const capture = device.deps.captureScreen;
  device.deps.captureScreen = async (options) => {
    assert.equal(options?.budgetMs, undefined, 'a dispatched step must never launch-poll');
    return capture(options);
  };
  device.deps.press = async (ref, context) => {
    context!.authorize();
    device.actions.push(`press ${ref}`);
    return { ok: true, proven: false, executed: true };
  };
  device.deps.dialog = async (action, context) => {
    context!.authorize();
    device.actions.push(`dialog ${action}`);
    dismissed = true;
    return { ok: true, proven: true, executed: true };
  };
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(dismissed, true);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /^TARGET_NOT_FOUND: /);
  assert.deepEqual(device.actions, ['press @profile', 'dialog dismiss']);
  assert.ok(ledger.steps.every((row) => row.implicitWaitMs === undefined));
});

for (const variant of ['redbox', 'logbox'] as const) {
  test(`${variant} dismissal preserves the launch allowance and its original deadline`, async () => {
    let dismissedAt: number | undefined;
    let pollCapture = 0;
    const device = app((t) => {
      if (dismissedAt === undefined)
        return {
          ...view([element('@dismiss', 'Dismiss')], 'dev-redbox'),
          devError: { variant, dismissRef: '@dismiss' },
        };
      return view(t >= dismissedAt + 3_000 ? [home, profile] : [home]);
    });
    const capture = device.deps.captureScreen;
    device.deps.captureScreen = async (options) => {
      if (options?.budgetMs !== undefined) {
        assert.ok(device.clock() + options.budgetMs <= WAIT_BUDGET_MS);
      }
      const screen = await capture(options);
      if (options?.budgetMs !== undefined && screen.elements.includes(profile))
        pollCapture = device.captures();
      return screen;
    };
    device.deps.press = async (ref, context) => {
      context!.authorize();
      device.actions.push(`press ${ref}`);
      if (ref === '@dismiss') {
        await device.deps.sleep(1_000);
        dismissedAt = device.clock();
      } else {
        assert.equal(ref, '@profile');
        assert.ok(pollCapture > 0);
        assert.equal(device.captures(), pollCapture);
        assert.ok(device.clock() >= dismissedAt! + 3_000);
      }
      return { ok: true, proven: true, executed: true };
    };
    const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
    assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
    assert.deepEqual(device.actions, ['press @dismiss', 'press @profile']);
    const retry = ledger.steps.find((row) => row.retryCause === 'DEV_REDBOX');
    assert.deepEqual(retry?.devError, { variant, dismissal: 1 });
    const press = ledger.steps.find((row) => row.outcome === 'pass');
    assert.ok(press);
    assert.ok(press.implicitWaitMs !== undefined && press.implicitWaitMs >= 2_000);
  });
}

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

test('a late placeholder-only input fills from the polled observation', async () => {
  const email = element('@email', '', { kind: 'input', placeholder: 'Email' });
  delete email.label;
  const device = app((t) => view(t >= 4_000 ? [home, email] : [home]));
  let polledCapture = 0;
  const capture = device.deps.captureScreen;
  device.deps.captureScreen = async (options) => {
    const screen = await capture(options);
    if (options?.budgetMs !== undefined && screen.elements.includes(email))
      polledCapture = device.captures();
    return screen;
  };
  device.deps.fill = async (ref, text) => {
    assert.ok(polledCapture > 1);
    assert.equal(device.captures(), polledCapture);
    device.actions.push(`fill ${ref} ${text}`);
    return { ok: true, proven: true };
  };
  const ledger = await ledgerOf('1. Fill "Email" with "Ada"\n', device.deps);
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger.failure));
  assert.deepEqual(device.actions, ['fill @email Ada']);
  assert.ok(ledger.steps.find((row) => row.outcome === 'pass')!.implicitWaitMs! >= 3_000);
});

test('an ordinary retry cannot replenish the consumed launch allowance', async () => {
  let refused = false;
  let refusedAt = 0;
  let pollStartedAt: number | undefined;
  let pollCaptures = 0;
  let pollsBeforeRefusal = 0;
  const device = app((t) => view(!refused && t >= 4_000 ? [home, profile] : [home]), {
    hideDevMenu: undefined,
  });
  const capture = device.deps.captureScreen;
  device.deps.captureScreen = async (options) => {
    if (options?.budgetMs !== undefined) {
      assert.equal(refused, false, 'a refusal must not start another launch poll');
      pollStartedAt ??= device.clock();
      pollCaptures += 1;
    }
    return capture(options);
  };
  device.deps.press = async (ref) => {
    assert.equal(ref, '@profile');
    assert.equal(refused, false);
    refused = true;
    refusedAt = device.clock();
    pollsBeforeRefusal = pollCaptures;
    return { ok: false, proven: false, mutation: 'none', error: 'PRESS_REFUSED' };
  };
  const ledger = await ledgerOf('1. Tap "Profile"\n', device.deps);
  assert.equal(refused, true);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /^TARGET_NOT_FOUND: /);
  assert.ok(ledger.steps.some((row) => row.outcome === 'retry'));
  assert.equal(failingRow(ledger).attempt, 2);
  assert.ok(pollsBeforeRefusal > 1);
  assert.equal(pollCaptures, pollsBeforeRefusal);
  assert.ok(pollStartedAt !== undefined);
  for (const row of ledger.steps) assert.equal(row.implicitWaitMs, refusedAt - pollStartedAt);
  assert.ok(device.clock() < refusedAt + 1_000);
  assert.deepEqual(device.actions, []);
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
