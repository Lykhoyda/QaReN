import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import {
  walkBlock,
  type ActResult,
  type WalkerDeps,
  type WalkerTimingDiagnostic,
} from '../../../dist/qa/walker.js';
import { QaDispatchContext, QaDispatchError } from '../../../dist/domain/qa-dispatch.js';
import {
  createDevicePressHandler,
  entryMismatchOf,
  extractMutationDisposition,
} from '../../../dist/handlers/device-interact.js';
import {
  _setRunAgentDeviceForTest,
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { healKeyboardOccludedTap } from '../../../dist/runners/keyboard-guard.js';
import { HandlerError, describeError, fillEvidence, unwrap } from '../../../dist/qa/adapt.js';
import { AppProcessGoneError } from '../../../dist/qa/capture.js';
import { createStop } from '../../../dist/qa/stop.js';
import { isRecord } from '../../../dist/qa/questions.js';
import { observeTiming } from '../../../dist/qa/timing.js';
import { decodePng } from '../../../dist/qa/tap-pixels.js';
import { type ToolResult } from '../../../dist/utils.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../../dist/runners/qaren-ios-runner-client.js';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';

const error = 'KEYBOARD_DISMISS_FAILED: native control could not hide the keyboard';
const refusal: ActResult = { ok: false, proven: false, mutation: 'none', error };
const tap = () => parsePlan('1. Tap "submit"\n').blocks![0];

function nativeNodes(x = 20, label = 'Continue'): NativeNode[] {
  return [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: '@submit',
      type: 'Button',
      parentIndex: 1,
      identifier: 'submit',
      label,
      hittable: true,
      rect: { x, y: 200, width: 100, height: 44 },
    },
  ];
}

function screen(
  keyboard = true,
  x = 20,
  label = 'Continue',
  target = true,
  rect?: NativeNode['rect'],
): Screen {
  const nodes = nativeNodes(x, label).filter((n) => target || n.ref !== '@submit');
  if (rect) nodes.find((n) => n.ref === '@submit')!.rect = rect;
  return {
    ...join(
      nodes,
      [],
      'app',
      { native: 'complete', react: 'complete' },
      {
        hosts: [],
        complete: true,
        typography: {
          version: 1,
          complete: true,
          durationMs: 1,
          coordinateSpace: 'window-points',
          nodes: [],
        },
      },
      {
        source: 'xcui-live',
        nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
      },
    ),
    keyboardVisible: keyboard,
  };
}

function device() {
  let current = screen();
  let clock = 0;
  const calls: string[] = [];
  const notes: string[] = [];
  const options: unknown[] = [];
  let results = [refusal, { ok: true, proven: true }];
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen() {
      calls.push('capture');
      return current;
    },
    async dismissKeyboard(context) {
      context.authorize();
      calls.push('dismiss');
      current = screen(false);
      return 'js';
    },
    async press(ref, context, opts) {
      context.authorize();
      calls.push(`press ${ref}`);
      options.push(opts);
      return results.shift() ?? refusal;
    },
    async fill() {
      throw Error('unexpected fill');
    },
    async scroll() {
      throw Error('unexpected scroll');
    },
    async back() {
      throw Error('unexpected back');
    },
    async dialog(_action, context) {
      context.authorize();
      calls.push('dialog');
      return { ok: true, proven: true, executed: true };
    },
    async hideDevMenu() {
      throw Error('unexpected dev menu');
    },
    async screenshot(name) {
      return name;
    },
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    row() {},
    note: (note) => notes.push(note),
  };
  return {
    deps,
    calls,
    notes,
    options,
    show: (s: Screen) => {
      current = s;
    },
    results: (next: ActResult[]) => {
      results = next;
    },
  };
}
const count = (f: ReturnType<typeof device>, call: string) =>
  f.calls.filter((c) => c.startsWith(call)).length;

function toolRefusal(mutation: 'none' | 'possible' | 'observed' | undefined): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: 'KEYBOARD_DISMISS_FAILED',
          error,
          meta: mutation === undefined ? {} : { mutation },
        }),
      },
    ],
  };
}

// Execute the production adapter and press forwarding closure without opening a session.
// The only transport double is runNative's existing in-memory test seam.
function pressAdapter(press: ReturnType<typeof createDevicePressHandler>): WalkerDeps['press'] {
  const source = readFileSync(new URL('../../../dist/qa/walk.js', import.meta.url), 'utf8');
  const from = source.indexOf('function act(');
  const to = source.indexOf('// Attach over CDP', from);
  const start = source.indexOf('press: (ref, qaContext, options) =>');
  const end = source.indexOf('fill: (ref, text,', start);
  return runInNewContext(`${source.slice(from, to)}; ({ ${source.slice(start, end)} }).press`, {
    press,
    stop: createStop(),
    now: () => 0,
    timing: undefined,
    log() {},
    observeTiming,
    QaDispatchError,
    AppProcessGoneError,
    HandlerError,
    describeError,
    fillEvidence,
    unwrap,
    extractMutationDisposition,
    entryMismatchOf,
    isRecord,
  });
}

afterEach(() => {
  _setRunAgentDeviceForTest(null);
  _setFastRunnerStateForTest(null);
  _setFetchForTest(fetch);
  resetActiveSessionInMemoryForTest();
  clearRefMap();
});

test('K1: the real runner client preserves the refused native response mutation proof', async () => {
  const state = {
    port: 12345,
    pid: process.pid,
    deviceId: 'TEST',
    bundleId: 'com.test',
    startedAt: 'now',
    capability: 'unit-test',
    instanceId: 'unit-instance',
    sessionId: 'unit-session',
    claimEpoch: 1,
  };
  _setFastRunnerStateForTest(state);
  const commands: string[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: REQUIRED_IOS_FEATURES,
        instanceId: state.instanceId,
        sessionId: state.sessionId,
        claimEpoch: state.claimEpoch,
        deviceId: state.deviceId,
        appId: state.bundleId,
      });
    commands.push(JSON.parse(String(init?.body)).command);
    return Response.json({
      ok: false,
      v: 2,
      error: { code: 'KEYBOARD_DISMISS_FAILED', message: error, mutation: 'none' },
    });
  });
  const context = new QaDispatchContext(10_000, () => 0);
  const result = await runIOS({
    command: 'tap',
    x: 20,
    y: 200,
    bundleId: state.bundleId,
    deviceId: state.deviceId,
    qaContext: context,
  });
  assert.equal(result.isError, true);
  assert.equal(context.refusal, undefined);
  assert.equal(extractMutationDisposition(result), 'none');
  assert.equal(JSON.parse(result.content[0].text).code, 'KEYBOARD_DISMISS_FAILED');
  assert.deepEqual(commands, ['tap']);
});

function realHandler() {
  const calls: string[] = [];
  setActiveSessionInMemoryForTest({
    name: 'qa',
    platform: 'ios',
    deviceId: 'TEST',
    appId: 'com.test',
  });
  updateRefMapFromFlat(nativeNodes(), { snapshotGeneration: 1, keyboardVisible: true });
  _setRunAgentDeviceForTest(async (args, opts) => {
    opts?.qaContext?.authorize();
    calls.push(args[0]);
    return toolRefusal('none');
  });
  const client = {
    isConnected: true,
    async evaluate() {
      calls.push('js');
      throw Error('handler must not dismiss');
    },
  };
  const handler = createDevicePressHandler(() => client as never);
  return { handler, calls };
}

test('K1: opted-in QA press returns the runner no-mutation refusal without handler repair', async () => {
  const f = realHandler();
  const context = new QaDispatchContext(10_000, () => 0);
  const result = await f.handler({
    ref: '@submit',
    qaContext: context,
    deferKeyboardDismissal: true,
  });
  assert.equal(context.refusal, undefined);
  assert.equal(result.isError, true);
  assert.equal(extractMutationDisposition(result), 'none');
  assert.match(JSON.parse(result.content[0].text).error, /^KEYBOARD_DISMISS_FAILED:/);
  assert.deepEqual(f.calls, ['press']);
});

test('K2: a refused quoted iOS press dismisses once, settles and lands one tap', async () => {
  const f = device();
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(f.calls, [
    'capture',
    'press @submit',
    'dismiss',
    'capture',
    'capture',
    'press @submit',
    'capture',
  ]);
  assert.equal(outcome.rows.at(-1)?.keyboardCleared, 'js');
  assert.deepEqual(
    f.notes.filter((n) => n.startsWith('keyboard-clearance ')),
    ['keyboard-clearance {"line":1,"via":"js","hidden":true}'],
  );
});

test('K3: a second keyboard refusal fails with its text after one dismissal', async () => {
  const f = device();
  f.results([refusal, refusal]);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(count(f, 'press'), 2);
  assert.match(
    JSON.stringify(outcome.failure?.seen),
    /KEYBOARD_DISMISS_FAILED:.*; the keyboard covers the target and could not be hidden/,
  );
});

for (const change of ['identity', 'frame'] as const) {
  test(`K4: ${change} changing after two settled captures refuses before another tap`, async () => {
    const f = device();
    let clock = 0;
    f.deps.now = () => clock;
    f.deps.note = (note) => {
      f.notes.push(note);
      if (note.startsWith('keyboard-clearance')) clock += 60_000;
    };
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async (options) => {
      // Movement during dismissal is allowed; change only after two equal settled frames.
      if (count(f, 'dismiss') && count(f, 'capture') >= 3) {
        const next = screen(false, change === 'frame' ? 180 : 100);
        if (change === 'identity') next.elements.find((e) => e.ref === '@submit')!.kind = 'other';
        f.show(next);
      }
      return capture(options);
    };
    const dismiss = f.deps.dismissKeyboard!;
    f.deps.dismissKeyboard = async (context) => {
      const via = await dismiss(context);
      f.show(screen(false, 100));
      return via;
    };
    const outcome = await walkBlock(tap(), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'dismiss'), 1);
    assert.equal(count(f, 'press'), 1);
    assert.match(
      JSON.stringify(outcome.failure?.seen),
      /not the target that settled.*the keyboard was dismissed before this tap/,
    );
  });
}

for (const recoveryRetry of [false, true]) {
  test(`K5: an absent-target dismissal spends the allowance${recoveryRetry ? ' across recovery' : ''}`, async () => {
    const f = device();
    const absent = screen(true, 20, 'Continue', false);
    f.show(absent);
    const dismiss = f.deps.dismissKeyboard!;
    f.deps.dismissKeyboard = async (context) => {
      const via = await dismiss(context);
      f.show(recoveryRetry ? { ...absent, keyboardVisible: false } : screen(false));
      return via;
    };
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async (options) => {
      if (recoveryRetry && options?.platformPresence && !f.calls.includes('dialog'))
        f.show({ ...screen(false), front: 'dialog' });
      return capture(options);
    };
    const dialog = f.deps.dialog;
    f.deps.dialog = async (action, context) => {
      const act = await dialog(action, context);
      f.show(screen());
      return act;
    };
    f.results([refusal]);
    const outcome = await walkBlock(tap(), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'dismiss'), 1);
    assert.equal(count(f, 'press'), 1, JSON.stringify({ outcome, calls: f.calls }));
    if (recoveryRetry) assert.ok(outcome.rows.some((row) => row.outcome === 'retry'));
    assert.match(
      JSON.stringify(outcome.failure?.seen),
      /the keyboard covers the target and could not be hidden/,
    );
  });
}

test('K6: pixels changed by dismissal cannot prove a later ineffective tap', async () => {
  const f = device();
  const before = readFileSync(
    new URL('../../fixtures/tap-pixels/toggle1-before.png', import.meta.url),
  );
  const after = readFileSync(
    new URL('../../fixtures/tap-pixels/toggle1-after.png', import.meta.url),
  );
  const image = decodePng(before)!;
  const view = (keyboard: boolean) => {
    const s = screen(keyboard, 20, 'Continue', true, {
      x: 0,
      y: 0,
      width: image.width / 3,
      height: image.height / 3,
    });
    s.pointScale = 3;
    return s;
  };
  f.show(view(true));
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.calls.push('dismiss');
    f.show(view(false));
    return 'js';
  };
  f.deps.comparisonScreenshot = async () => {
    f.calls.push('pixels');
    return count(f, 'dismiss') ? after : before;
  };
  f.results([refusal, { ok: true, proven: false }, { ok: true, proven: false }]);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(outcome.block.outcome, 'fail', 'dismissal pixels must not pass the tap');
  assert.ok(count(f, 'pixels') >= 4, JSON.stringify({ outcome, calls: f.calls }));
});

test('K7: walker option traverses the real press adapter and handler and returns the refused act', async () => {
  const f = device();
  const real = realHandler();
  const adapter = pressAdapter(real.handler);
  const received: ActResult[] = [];
  f.deps.press = async (...args) => {
    const act = await adapter(...args);
    received.push(act);
    return act;
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.ok(received.length > 0);
  assert.equal(received[0].ok, false);
  assert.equal(received[0].mutation, 'none', JSON.stringify(received[0]));
  assert.match(received[0].error!, /^KEYBOARD_DISMISS_FAILED:/);
  assert.equal(count(f, 'dismiss'), 1);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(real.calls, ['press', 'press']);
});

test('guard: a QA press without opt-in keeps the existing uncertain-outcome refusal', async () => {
  const f = realHandler();
  const context = new QaDispatchContext(10_000, () => 0);
  await assert.rejects(
    f.handler({ ref: '@submit', qaContext: context }),
    /ACTION_OUTCOME_UNCERTAIN/,
  );
  assert.deepEqual(f.calls, ['press']);
});

for (const mutation of [undefined, 'possible', 'observed'] as const) {
  test(`guard: ${mutation ?? 'missing'} mutation proof never dismisses`, async () => {
    const f = device();
    f.results([
      { ...refusal, mutation },
      { ...refusal, mutation },
    ]);
    const outcome = await walkBlock(tap(), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'dismiss'), 0);
    const context = new QaDispatchContext(10_000, () => 0);
    await assert.rejects(
      healKeyboardOccludedTap(toolRefusal(mutation), null, context, true),
      /ACTION_OUTCOME_UNCERTAIN/,
    );
  });
}

for (const shape of ['android', 'no-adapter', 'unquoted', 'relayout'] as const) {
  test(`guard: ${shape} keeps existing press handling`, async () => {
    const f = device();
    f.results([refusal, refusal]);
    if (shape === 'android') f.deps.platform = 'android';
    if (shape === 'no-adapter') delete f.deps.dismissKeyboard;
    if (shape === 'unquoted')
      f.deps.judge = scriptedJudge((q) =>
        Object.fromEntries(Object.entries(q).map(([key, question]) => [key, choice(question)])),
      );
    if (shape === 'relayout')
      f.results(
        Array.from({ length: 2 }, () => ({
          ...refusal,
          error: 'KEYBOARD_RELAYOUT_REQUIRED: keyboard moved',
        })),
      );
    const plan =
      shape === 'unquoted' ? parsePlan('1. Tap the Continue button\n').blocks![0] : tap();
    const outcome = await walkBlock(plan, f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(count(f, 'dismiss'), 0);
    assert.ok(count(f, 'press') > 0, 'the guard must exercise a resolved press');
    if (shape !== 'relayout') assert.ok(f.options.every((o) => o === undefined));
  });
}

test('K4: a target that never settles is not pressed again', async () => {
  const f = device();
  const capture = f.deps.captureScreen;
  let x = 30;
  f.deps.captureScreen = async (options) => {
    if (count(f, 'dismiss')) f.show(screen(false, (x += 10)));
    return capture(options);
  };
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(count(f, 'press'), 1);
  assert.match(JSON.stringify(outcome.failure?.seen), /did not settle across 4 captures/);
});

test('guard: a Fill never opts into keyboard dismissal on a keyboard refusal', async () => {
  const f = device();
  const nodes = nativeNodes();
  nodes[2].type = 'TextField';
  f.show({
    ...join(nodes, []),
    front: 'app',
    keyboardVisible: true,
    coverage: { native: 'complete', react: 'complete' },
  });
  f.deps.fill = async (_ref, _text, context) => {
    context.authorize();
    f.calls.push('fill');
    return refusal;
  };
  const outcome = await walkBlock(parsePlan('1. Fill "submit" with "hello"\n').blocks![0], f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.ok(count(f, 'fill') > 0);
  assert.equal(count(f, 'dismiss'), 0);
});

function dispatchTrace(f: ReturnType<typeof device>) {
  const events: WalkerTimingDiagnostic[] = [];
  f.deps.diagnostic = (event) => events.push(event);
  return {
    events,
    completed: () =>
      events
        .filter(
          (event) => event.line === 1 && event.stage === 'dispatch' && event.code === 'COMPLETED',
        )
        .map((event) => {
          const { action, ok, nativeMutation, resultCode } = event;
          return {
            action,
            ok,
            ...(nativeMutation === undefined ? {} : { nativeMutation }),
            ...(resultCode === undefined ? {} : { resultCode }),
          };
        }),
  };
}

const refusedPressTrace = {
  action: 'press',
  ok: false,
  nativeMutation: 'none',
  resultCode: 'KEYBOARD_DISMISS_FAILED',
};

test('T1: dispatch trace identifies the refused press, dismissal and completed press', async () => {
  const f = device();
  const trace = dispatchTrace(f);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(trace.completed(), [
    refusedPressTrace,
    { action: 'dismiss-keyboard', ok: true },
    { action: 'press', ok: true },
  ]);
  assert.deepEqual(
    trace.events
      .filter((event) => event.stage === 'dispatch' && event.code === 'ACCEPTED')
      .map((event) => event.action),
    ['press', 'dismiss-keyboard', 'press'],
  );
});

test('T2: dispatch trace ends after the second refused press', async () => {
  const f = device();
  f.results([refusal, refusal]);
  const trace = dispatchTrace(f);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(trace.completed(), [
    refusedPressTrace,
    { action: 'dismiss-keyboard', ok: true },
    refusedPressTrace,
  ]);
});

test('T3: absent-target trace records a dismissal without a preceding press', async () => {
  const f = device();
  const absent = screen(true, 20, 'Continue', false);
  f.show(absent);
  f.deps.dismissKeyboard = async (context) => {
    context.authorize();
    f.calls.push('dismiss');
    f.show({ ...absent, keyboardVisible: false });
    return 'js';
  };
  const trace = dispatchTrace(f);
  const outcome = await walkBlock(tap(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(trace.completed(), [{ action: 'dismiss-keyboard', ok: true }]);
  assert.equal(count(f, 'press'), 0);
});

test('T4: dispatch trace maps an unlisted error to OTHER without retaining its text', async () => {
  const f = device();
  const error = 'PRIVATE_SYNTHETIC_CODE: synthetic-private-error-text';
  f.results([{ ok: false, proven: false, mutation: 'none', error }]);
  const trace = dispatchTrace(f);
  await walkBlock(tap(), f.deps);
  assert.deepEqual(trace.completed()[0], {
    action: 'press',
    ok: false,
    nativeMutation: 'none',
    resultCode: 'OTHER',
  });
  assert.ok(!JSON.stringify(trace.events).includes('PRIVATE_SYNTHETIC_CODE'));
  assert.ok(!JSON.stringify(trace.events).includes('synthetic-private-error-text'));
});
