import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { Element, NativeNode, Screen } from '../../../dist/qa/screen.js';
import type { Ledger, LedgerRow } from '../../../dist/qa/ledger.js';
import { CaptureDeadline, NativeCaptureError } from '../../../dist/qa/capture.js';
import type { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { WAIT_BUDGET_MS, runPlan, type WalkerDeps } from '../../../dist/qa/walker.js';
import { element, scriptedJudge } from './judgment-fixtures.ts';

// What the walker's ports report when QaReN's own runner is gone (capture.ts and both runner gates):
// a read ends NATIVE_CAPTURE_UNAVAILABLE; a send is refused before authorization and invalidates its context.
type Outcome = 'alive' | 'relaunched' | 'down' | 'app-changed';

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
const settings = element('@settings', 'Settings', { kind: 'text', testID: 'settings-title' });
const name = element('@name', 'Name', { kind: 'input', testID: 'name-input' });

interface Device {
  deps: WalkerDeps;
  sent: string[];
  refusedSends: number;
  asked: number;
  rows: LedgerRow[];
  runner: { down: boolean };
}

// The runner dies when `dies` says so and stays down until a relaunch answers 'relaunched'.
function device(options: {
  render: (t: number, sent: string[]) => Screen;
  dies: (at: { capture: number; send: number; sent: string[]; time: number }) => boolean;
  recover?: Outcome[];
  relaunchMs?: number;
  platform?: 'ios' | 'android';
  extra?: Partial<WalkerDeps>;
  cancelled?: () => boolean;
  withoutRecovery?: boolean;
}): Device {
  const sent: string[] = [];
  const rows: LedgerRow[] = [];
  const runner = { down: false };
  const script = [...(options.recover ?? [])];
  let time = 0;
  let captures = 0;
  let sends = 0;
  const out: Device = { deps: undefined as never, sent, refusedSends: 0, asked: 0, rows, runner };
  const gate = (context: QaDispatchContext): boolean => {
    sends += 1;
    if (!runner.down && options.dies({ capture: captures, send: sends, sent, time }))
      runner.down = true;
    if (!runner.down) {
      context.authorize();
      return true;
    }
    out.refusedSends += 1;
    try {
      context.invalidate();
    } catch {
      /* The handler adapter turns the gate's throw into the result below. */
    }
    return false;
  };
  const refused = {
    ok: false,
    proven: false,
    mutation: 'possible' as const,
    error: 'ACTION_CONTEXT_CHANGED: ACTION_CONTEXT_CHANGED',
  };
  out.deps = {
    platform: options.platform ?? 'ios',
    judge: scriptedJudge(() => assert.fail('a literal plan must never ask Jev')),
    async captureScreen() {
      captures += 1;
      time += 100;
      if (!runner.down && options.dies({ capture: captures, send: sends, sent, time }))
        runner.down = true;
      if (runner.down) throw new NativeCaptureError();
      return options.render(time, sent);
    },
    async press(ref, context) {
      if (!gate(context)) return refused;
      sent.push(`press ${ref}`);
      return { ok: true, proven: false };
    },
    async fill(ref, text, context) {
      if (!gate(context)) return refused;
      sent.push(`fill ${ref} ${text}`);
      return { ok: true, proven: true };
    },
    async scroll(direction, context) {
      if (!gate(context)) return refused;
      sent.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    },
    async back(context) {
      if (!gate(context)) return refused;
      sent.push('back');
      return { ok: true, proven: false };
    },
    async dialog(action, context) {
      if (!gate(context)) return refused;
      sent.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async hideDevMenu() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    ...(options.withoutRecovery
      ? {}
      : {
          async recoverRunner() {
            out.asked += 1;
            if (!runner.down) return 'alive';
            const outcome = script.shift() ?? 'down';
            if (outcome === 'relaunched') {
              time += options.relaunchMs ?? 12_000;
              runner.down = false;
            }
            return outcome;
          },
        }),
    now: () => time,
    async sleep(ms) {
      time += ms;
    },
    row: (row) => {
      rows.push(row);
    },
    ...(options.cancelled ? { cancelled: options.cancelled } : {}),
    ...options.extra,
  };
  return out;
}

const ledgerOf = async (markdown: string, deps: WalkerDeps): Promise<Ledger> =>
  (await runPlan(blocks(markdown), deps)) as Ledger;

const text = (ledger: Ledger): string => JSON.stringify(ledger);
const TAP = '1. Wait for "Home"\n2. Tap "Profile"\n';
const tapScreens = (_t: number, sent: string[]): Screen =>
  sent.includes('press @profile') ? view([settings]) : view([home, profile]);

// A press whose target qualifies for the pixel pre-check: one hittable native button, a point scale.
function option(label: string): Screen {
  const nodes: NativeNode[] = [
    {
      ref: '@option',
      index: 0,
      type: 'Button',
      label,
      identifier: 'option',
      hittable: true,
      rect: { x: 0, y: 0, width: 40, height: 20 },
    },
  ];
  return {
    ...join(nodes, []),
    front: 'app',
    pointScale: 3,
    coverage: { native: 'complete', react: 'complete' },
  };
}
const optionScreens = (_t: number, sent: string[]): Screen =>
  option(sent.includes('press @option') ? 'Chosen' : 'Option');
const pixels: Partial<WalkerDeps> = {
  async comparisonScreenshot() {
    return undefined;
  },
};

test('W1 a runner that died before the step is restarted on the first read and the step passes', async () => {
  // Capture 1 is the Wait; the Tap's first read meets the dead runner.
  const d = device({
    render: tapScreens,
    dies: ({ capture }) => capture === 2,
    recover: ['relaunched'],
  });
  const ledger = await ledgerOf(TAP, d.deps);
  assert.equal(ledger.verdict, 'PASS', text(ledger));
  assert.deepEqual(d.sent, ['press @profile']);
  assert.equal(d.asked, 1);
  const retry = ledger.steps.find((row) => row.line === 2 && row.outcome === 'retry');
  assert.match(String(retry?.reason), /restarted its own device runner/);
  assert.ok(ledger.steps.some((row) => row.line === 2 && row.outcome === 'pass'));
});

test('W2 a runner that died before the pixel pre-check is not reported as a moved target', async () => {
  // Capture 1 resolves the target; capture 2 is the pre-check's own read.
  const d = device({
    render: optionScreens,
    dies: ({ capture }) => capture === 2,
    recover: ['relaunched'],
    extra: pixels,
  });
  const ledger = await ledgerOf('1. Tap "option"\n', d.deps);
  assert.doesNotMatch(text(ledger), /TARGET_MOVED_BEFORE_DISPATCH/);
  assert.equal(ledger.verdict, 'PASS', text(ledger));
  assert.deepEqual(d.sent, ['press @option']);
});

test('W2b without the port, the W2 fixture reaches the pixel pre-check and ends TARGET_MOVED_BEFORE_DISPATCH', async () => {
  const d = device({
    render: optionScreens,
    dies: ({ capture }) => capture === 2,
    extra: pixels,
    withoutRecovery: true,
  });
  const ledger = await ledgerOf('1. Tap "option"\n', d.deps);
  assert.equal(ledger.verdict, 'FAIL', text(ledger));
  assert.match(text(ledger), /TARGET_MOVED_BEFORE_DISPATCH/);
  assert.deepEqual(d.sent, []);
});

test('W3 a send refused because the runner is gone sends nothing, restarts it and presses once', async () => {
  // One death, at the first send: captures also consult the predicate, so it fires only once.
  let killed = false;
  const d = device({
    render: tapScreens,
    dies: ({ send }) => send === 1 && !killed && (killed = true),
    recover: ['relaunched'],
  });
  const ledger = await ledgerOf(TAP, d.deps);
  assert.equal(ledger.verdict, 'PASS', text(ledger));
  assert.equal(d.refusedSends, 1);
  assert.deepEqual(d.sent, ['press @profile']);
  assert.doesNotMatch(text(ledger), /ACTION_CONTEXT_CHANGED/);
});

for (const platform of ['ios', 'android'] as const) {
  const code = platform === 'ios' ? 'RN_FAST_RUNNER_DOWN' : 'RN_ANDROID_RUNNER_DOWN';
  test(`W4 ${platform}: a runner that stays down refuses with ${code} and names QaReN's runner`, async () => {
    const d = device({
      render: tapScreens,
      dies: ({ capture }) => capture === 2,
      recover: ['down'],
      platform,
    });
    const ledger = await ledgerOf(TAP, d.deps);
    assert.equal(ledger.verdict, 'REFUSED', text(ledger));
    assert.equal((ledger as { code?: string }).code, code);
    assert.match(String((ledger as { message?: string }).message), /QaReN's own device runner/);
    assert.doesNotMatch(text(ledger), /TARGET_MOVED_BEFORE_DISPATCH|NATIVE_CAPTURE_UNAVAILABLE/);
    assert.deepEqual(d.sent, []);
    assert.equal(ledger.failure?.step, 2);
  });
}

test('W5 a runner that stays down at the pixel pre-check refuses as runner down, never as a moved target', async () => {
  const d = device({
    render: optionScreens,
    dies: ({ capture }) => capture === 2,
    recover: ['down'],
    extra: pixels,
  });
  const ledger = await ledgerOf('1. Tap "option"\n', d.deps);
  assert.equal(ledger.verdict, 'REFUSED', text(ledger));
  assert.equal((ledger as { code?: string }).code, 'RN_FAST_RUNNER_DOWN');
  assert.doesNotMatch(text(ledger), /TARGET_MOVED_BEFORE_DISPATCH/);
  assert.deepEqual(d.sent, []);
});

test('W6 after a press was sent, a dead runner is never asked and the press is never sent again', async () => {
  // The press goes out; every read after it meets the dead runner.
  const run = async (withoutRecovery: boolean) => {
    const d = device({
      render: tapScreens,
      dies: ({ sent }) => sent.length > 0,
      recover: ['relaunched', 'relaunched'],
      withoutRecovery,
    });
    const ledger = await ledgerOf(TAP, d.deps);
    return { d, ledger };
  };
  const fixed = await run(false);
  const plain = await run(true);
  assert.deepEqual(fixed.d.sent, ['press @profile']);
  assert.equal(fixed.d.asked, 0);
  assert.notEqual(fixed.ledger.verdict, 'PASS');
  // Same verdict and same words as a walk that has no recovery port at all.
  assert.equal(fixed.ledger.verdict, plain.ledger.verdict);
  assert.equal((fixed.ledger as { code?: string }).code, (plain.ledger as { code?: string }).code);
  assert.deepEqual(fixed.ledger.failure, plain.ledger.failure);
});

test('W7 a runner that answers leaves a real failure exactly as it was', async () => {
  const missing = (): Screen => view([home]);
  const run = async (withoutRecovery: boolean) => {
    const d = device({ render: missing, dies: () => false, withoutRecovery });
    return { d, ledger: await ledgerOf(TAP, d.deps) };
  };
  const fixed = await run(false);
  const plain = await run(true);
  assert.equal(fixed.ledger.verdict, 'FAIL', text(fixed.ledger));
  assert.ok(fixed.d.asked >= 1);
  assert.equal(fixed.ledger.verdict, plain.ledger.verdict);
  assert.deepEqual(fixed.ledger.failure, plain.ledger.failure);
  assert.deepEqual(
    fixed.ledger.steps.map((row) => [row.line, row.outcome, row.reason]),
    plain.ledger.steps.map((row) => [row.line, row.outcome, row.reason]),
  );
});

test('W8 the restart is not charged to a Wait: its budget resumes where it stood', async () => {
  // The target appears 3 s of app time after the run starts reading again; the restart alone outlasts the Wait.
  let resumed: number | undefined;
  const d = device({
    render: (t) => {
      resumed ??= t;
      return view(t - resumed >= 3_000 && d.asked > 0 ? [home, profile] : [home]);
    },
    dies: ({ capture }) => capture === 3,
    recover: ['relaunched'],
    relaunchMs: WAIT_BUDGET_MS + 5_000,
  });
  const ledger = await ledgerOf('1. Wait for "Home"\n2. Wait for "Profile"\n', d.deps);
  assert.equal(ledger.verdict, 'PASS', text(ledger));
  assert.equal(d.asked, 1);
});

test('W9 an app that is gone or restarted is reported as the app, not as the runner', async () => {
  const d = device({
    render: tapScreens,
    dies: ({ capture }) => capture === 2,
    recover: ['app-changed'],
  });
  const ledger = await ledgerOf(TAP, d.deps);
  assert.equal(ledger.verdict, 'FAIL', text(ledger));
  assert.match(text(ledger.failure), /APP_PROCESS_CHANGED|restarted or crashed/);
  assert.doesNotMatch(text(ledger), /RUNNER_DOWN|TARGET_MOVED_BEFORE_DISPATCH/);
  assert.equal(ledger.publicationInterrupted, true);
  assert.ok(ledger.continuityEvents?.some((event) => event.signal === 'app-process-changed'));
  assert.deepEqual(d.sent, []);
});

test('W10 a cancelled run never asks the runner', async () => {
  let cancelled = false;
  const d = device({
    render: tapScreens,
    dies: ({ capture }) => {
      if (capture === 2) cancelled = true;
      return capture === 2;
    },
    recover: ['relaunched'],
    cancelled: () => cancelled,
  });
  await ledgerOf(TAP, d.deps);
  assert.equal(d.asked, 0);
  assert.deepEqual(d.sent, []);
});

test('W11 a second death in the same step is asked again; the port decides whether it restarts', async () => {
  let deaths = 0;
  const twice = device({
    render: tapScreens,
    dies: ({ capture }) => (capture === 2 || capture === 3) && ++deaths > 0,
    recover: ['relaunched', 'relaunched'],
  });
  const passed = await ledgerOf(TAP, twice.deps);
  assert.equal(passed.verdict, 'PASS', text(passed));
  assert.equal(twice.asked, 2);
  assert.deepEqual(twice.sent, ['press @profile']);

  const spent = device({
    render: tapScreens,
    dies: ({ capture }) => capture === 2 || capture === 3,
    recover: ['relaunched', 'down'],
  });
  const refused = await ledgerOf(TAP, spent.deps);
  assert.equal(refused.verdict, 'REFUSED', text(refused));
  assert.equal((refused as { code?: string }).code, 'RN_FAST_RUNNER_DOWN');
  assert.deepEqual(spent.sent, []);
});

test('W12 a Fill that sent nothing is typed once after the restart', async () => {
  const d = device({
    render: (_t, sent) =>
      view(sent.length ? [home, { ...name, value: 'Ada' } as Element] : [home, name]),
    dies: ({ capture }) => capture === 2,
    recover: ['relaunched'],
  });
  const ledger = await ledgerOf('1. Wait for "Home"\n2. Type "Ada" into "Name"\n', d.deps);
  assert.equal(d.sent.filter((entry) => entry.startsWith('fill')).length, 1, text(ledger));
  assert.equal(d.asked, 1);
});

test('W13 a walk without the port keeps the base outcome', async () => {
  const d = device({
    render: tapScreens,
    dies: ({ capture }) => capture === 2,
    withoutRecovery: true,
  });
  const ledger = await ledgerOf(TAP, d.deps);
  assert.equal(ledger.verdict, 'REFUSED', text(ledger));
  assert.equal((ledger as { code?: string }).code, 'NATIVE_CAPTURE_UNAVAILABLE');
});

test('W14 after a Fill was sent, a dead runner is never asked and nothing is typed again', async () => {
  // The fill goes out (authorized); its readback meets the dead runner.
  const run = async (withoutRecovery: boolean) => {
    const d = device({
      render: (_t, sent) =>
        view(sent.length ? [home, { ...name, value: 'Ada' } as Element] : [home, name]),
      dies: ({ sent }) => sent.length > 0,
      recover: ['relaunched', 'relaunched'],
      withoutRecovery,
    });
    const ledger = await ledgerOf('1. Wait for "Home"\n2. Type "Ada" into "Name"\n', d.deps);
    return { d, ledger };
  };
  const fixed = await run(false);
  const plain = await run(true);
  assert.equal(fixed.d.sent.filter((entry) => entry.startsWith('fill')).length, 1);
  assert.equal(fixed.d.asked, 0);
  assert.equal(fixed.ledger.verdict, plain.ledger.verdict);
  assert.deepEqual(fixed.ledger.failure, plain.ledger.failure);
});

test('W15 a recovery that tapped an interruption, then met a dead runner, is never asked and never taps again', async () => {
  // The step's target is missing behind a pop-up; recovery's nested walk taps Close, the next
  // `after` reads succeed, then every read fails: wherever that lands, Close is tapped once.
  for (let after = 0; after <= 4; after++) {
    const promo = view([element('@close', 'Close')]);
    const settings = view([element('@settings', 'Settings')]);
    const sent: string[] = [];
    let asked = 0;
    let reads: number | undefined;
    const deps: WalkerDeps = {
      platform: 'ios',
      judge: scriptedJudge(() => assert.fail('a literal plan must never ask Jev')),
      async captureScreen() {
        if (reads !== undefined && reads-- <= 0) throw new NativeCaptureError();
        return sent.length ? settings : promo;
      },
      async press(ref, context) {
        context.authorize();
        sent.push(`press ${ref}`);
        if (ref === '@close') reads = after;
        return { ok: true, proven: false, executed: true };
      },
      async fill() {
        return assert.fail('no fill');
      },
      async scroll() {
        return assert.fail('no scroll');
      },
      async back() {
        return assert.fail('no back');
      },
      async dialog() {
        return assert.fail('no dialog');
      },
      async hideDevMenu() {
        return { ok: true, proven: true };
      },
      async screenshot(name) {
        return name;
      },
      async recoverRunner() {
        asked += 1;
        reads = undefined;
        return 'relaunched';
      },
      now: () => 0,
      async sleep() {},
      row() {},
    };
    await runPlan(blocks('1. Tap "Settings"\n'), deps);
    assert.equal(
      sent.filter((entry) => entry === 'press @close').length,
      1,
      `after=${after} ${JSON.stringify(sent)}`,
    );
    assert.equal(asked, 0, `after=${after}`);
  }
});

test('W16 a Wait whose first read outlasts its deadline asks the runner before reporting the timeout', async () => {
  let asked = 0;
  let wedged = true;
  const deps = device({ render: () => view([home]), dies: () => false }).deps;
  const ledger = (await runPlan(blocks('1. Wait for "Home"\n'), {
    ...deps,
    async captureScreen(options) {
      if (wedged) throw new CaptureDeadline();
      return deps.captureScreen(options);
    },
    async recoverRunner() {
      asked += 1;
      if (!wedged) return 'alive';
      wedged = false;
      return 'relaunched';
    },
  })) as Ledger;
  assert.equal(asked, 1);
  assert.equal(ledger.verdict, 'PASS', text(ledger));
  assert.doesNotMatch(text(ledger), /TARGET_WAIT_TIMEOUT/);
});

test('W16b a Wait first-read deadline with a live runner keeps TARGET_WAIT_TIMEOUT and its fields', async () => {
  const run = async (withPort: boolean) => {
    let time = 0;
    let asked = 0;
    const baseDeps = device({
      render: () => view([home]),
      dies: () => false,
      withoutRecovery: !withPort,
    }).deps;
    const ledger = (await runPlan(blocks('1. Wait for "Home"\n'), {
      ...baseDeps,
      now: () => time,
      async captureScreen() {
        time += WAIT_BUDGET_MS;
        throw new CaptureDeadline();
      },
      ...(withPort
        ? {
            async recoverRunner() {
              asked += 1;
              time += 350;
              return 'alive' as const;
            },
          }
        : {}),
    })) as Ledger;
    return { asked, ledger };
  };
  const fixed = await run(true);
  const plain = await run(false);
  assert.equal(fixed.asked, 1);
  assert.equal(fixed.ledger.verdict, 'FAIL', text(fixed.ledger));
  assert.equal(fixed.ledger.verdict, plain.ledger.verdict);
  assert.equal(fixed.ledger.failure?.step, plain.ledger.failure?.step);
  assert.match(
    String(fixed.ledger.failure?.seen),
    new RegExp(
      `^TARGET_WAIT_TIMEOUT: target was not observed within ${WAIT_BUDGET_MS}ms; no capture completed before the wait deadline; cause=capture-deadline; elapsed_ms=${WAIT_BUDGET_MS + 350}; next_action=inspect_capture_health;`,
    ),
  );
  assert.equal(
    String(fixed.ledger.failure?.seen).replace(
      `elapsed_ms=${WAIT_BUDGET_MS + 350}`,
      `elapsed_ms=${WAIT_BUDGET_MS}`,
    ),
    plain.ledger.failure?.seen,
  );
});

test('W16c a Wait whose first read ran the clock to its deadline refunds that wedged read after a restart', async () => {
  let time = 0;
  let asked = 0;
  let wedged = true;
  const baseDeps = device({ render: () => view([home]), dies: () => false }).deps;
  const ledger = (await runPlan(blocks('1. Wait for "Home"\n'), {
    ...baseDeps,
    now: () => time,
    async captureScreen(options) {
      if (wedged) {
        time += WAIT_BUDGET_MS;
        throw new CaptureDeadline();
      }
      time += 100;
      return baseDeps.captureScreen(options);
    },
    async recoverRunner() {
      asked += 1;
      if (!wedged) return 'alive';
      time += 12_000;
      wedged = false;
      return 'relaunched';
    },
  })) as Ledger;
  assert.equal(asked, 1);
  assert.equal(ledger.verdict, 'PASS', text(ledger));
  assert.doesNotMatch(text(ledger), /TARGET_WAIT_TIMEOUT/);
});

test('W17 a nested login walk whose step fails before sending does not ask the runner itself', async () => {
  const wall = element('@wall', 'Sign in to continue', { kind: 'text', testID: 'login-screen' });
  const signIn = element('@signin', 'Sign in');
  const login = {
    marker: { id: 'login-screen' },
    block: blocks('### Login\n1. Tap "Sign in"\n')[0],
  };
  let killed = false;
  let seen = 0;
  const d = device({
    render: (_t, sent) => {
      seen += 1;
      if (seen === 1) return view([home]);
      if (sent.includes('press @profile')) return view([settings]);
      return sent.includes('press @signin') ? view([home, profile]) : view([wall, signIn]);
    },
    // Capture 1 passes step 1; capture 2 misses step 2; capture 3 reads recovery's fresh screen; capture 4 is the nested login step.
    dies: ({ capture }) => capture === 4 && !killed && (killed = true),
    recover: ['relaunched'],
    extra: { login },
  });
  const ledger = await ledgerOf('### Main\n1. Wait for "Home"\n2. Tap "Profile"\n', d.deps);
  assert.equal(d.asked, 1);
  assert.equal(
    ledger.steps.some((row) => row.block === 'login' && row.outcome === 'retry'),
    false,
    text(ledger),
  );
  assert.equal(
    ledger.steps.some((row) => row.block === 'main' && row.outcome === 'retry'),
    true,
    text(ledger),
  );
});
