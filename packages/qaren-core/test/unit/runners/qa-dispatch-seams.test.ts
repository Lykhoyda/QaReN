import { createWriter } from '../../../dist/qa/wire.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlan } from '../../../dist/qa/walker.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { element, screen, scriptedJudge, walker } from '../qa/judgment-fixtures.ts';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { buildIosProbes } from '../../../dist/lifecycle/settle.js';
import {
  _setFetchForTest,
  _setFastRunnerStateForTest,
  fastSwipe,
  runIOS,
  verifyTypeResultAfterSettle,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  runAndroid,
  _setAndroidRunnerStateForTest,
  _setFetchForTest as androidFetch,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  runNative,
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import {
  createDeviceScrollHandler,
  createDeviceSwipeHandler,
  createDevicePressHandler,
  createDeviceFillHandler,
  performFocusedFill,
} from '../../../dist/handlers/device-interact.js';
import { okResult } from '../../../dist/utils.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import {
  createTimingObserver,
  observeDispatchPhases,
  type TimingEvent,
} from '../../../dist/qa/timing.js';
import { createDeviceAcceptSystemDialogHandler } from '../../../dist/handlers/device-system-dialog.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  classifyRunnerCompatibility,
} from '../../../dist/runners/protocol.js';

afterEach(() => {
  _setFastRunnerStateForTest(null);
  _setFetchForTest(fetch);
  _setAndroidRunnerStateForTest(null);
  androidFetch(fetch);
  resetActiveSessionInMemoryForTest();
  clearRefMap();
});

function runner(
  reply: (body: Record<string, unknown>) => unknown,
  health: () => void | Promise<void> = () => {},
) {
  _setFastRunnerStateForTest({
    pid: process.pid,
    port: 12345,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    capability: 'test-capability',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  const sends: string[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) {
      await health();
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
      });
    }
    const body = JSON.parse(String(init?.body));
    sends.push(body.command);
    const response = reply(body);
    return response instanceof Response ? response : Response.json(response);
  });
  return sends;
}

test('a lagging runner without the target-frame guard is incompatible', () => {
  const health = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    commands: [...REQUIRED_IOS_COMMANDS],
    capabilities: REQUIRED_IOS_FEATURES.filter((feature) => feature !== 'TARGET_FRAME_GUARD_V1'),
  };
  assert.deepEqual(
    classifyRunnerCompatibility(health, null, REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES),
    {
      compatible: false,
      reason: 'missing-features',
      missing: ['TARGET_FRAME_GUARD_V1'],
    },
  );
});

test('a runner built before toolbar naming and sized snapshot dedupe is incompatible', () => {
  const health = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    commands: [...REQUIRED_IOS_COMMANDS],
    capabilities: REQUIRED_IOS_FEATURES.filter((feature) => feature !== 'SNAPSHOT_FIDELITY_V1'),
  };
  assert.deepEqual(
    classifyRunnerCompatibility(health, null, REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES),
    {
      compatible: false,
      reason: 'missing-features',
      missing: ['SNAPSHOT_FIDELITY_V1'],
    },
  );
});

for (const command of ['tap', 'type'] as const) {
  test(`the native moved-target refusal preserves mutation none through ${command}`, async () => {
    runner(() => ({
      ok: false,
      error: {
        code: 'TARGET_MOVED_BEFORE_DISPATCH',
        message: 'target moved before dispatch; no tap or typing was performed',
        mutation: 'none',
      },
    }));
    const result = await runIOS({ command, bundleId: 'qa.app', x: 10, y: 20, text: 'x' });
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.code, 'TARGET_MOVED_BEFORE_DISPATCH');
    assert.equal(envelope.meta.mutation, 'none');
  });
}

test('fast swipe refuses at expiry without sending or probing status', async () => {
  const sends = runner(() => ({ ok: true }));
  const context = new QaDispatchContext(10, () => 10);
  await assert.rejects(fastSwipe(1, 2, 3, 4, 100, 'qa.app', context), /EVIDENCE_EXPIRED/);
  assert.deepEqual(sends, []);
  assert.equal(context.authorizations, 0);
  assert.throws(() => context.assertComplete(), /EVIDENCE_EXPIRED/);
});

test('fast swipe counts authorization before a possibly failed send', async () => {
  const sends = runner(() => ({ ok: false, error: { code: 'FAILED' } }));
  const context = new QaDispatchContext(10, () => 1);
  await fastSwipe(1, 2, 3, 4, 100, 'qa.app', context);
  assert.deepEqual(sends, ['drag']);
  assert.equal(context.authorizations, 1);
});

test('a swallowed refusal cannot authorize a later fast swipe', async () => {
  const sends = runner(() => ({ ok: true }));
  let now = 10;
  const context = new QaDispatchContext(10, () => now);
  await fastSwipe(1, 2, 3, 4, 100, 'qa.app', context).catch(() => undefined);
  now = 0;
  await assert.rejects(fastSwipe(1, 2, 3, 4, 100, 'qa.app', context), /EVIDENCE_EXPIRED/);
  assert.deepEqual(sends, []);
});

function session(platform: 'ios' | 'android' = 'ios') {
  setActiveSessionInMemoryForTest({ name: 'qa', platform, appId: 'qa.app', deviceId: 'qa-device' });
}

test('QA native refusal retains a bounded response without another send', async () => {
  const sends = runner(() => ({
    ok: false,
    error: {
      code: 'NO_TEXT_INPUT_TARGET',
      mutation: 'none',
      reason: 'exact-target-missing',
      message: 'PRIVATE-message',
      data: 'PRIVATE-data',
    },
  }));
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    runIOS({ command: 'tap', x: 10, y: 20, qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(context.refusalDiagnostic, {
    refusal: 'ACTION_CONTEXT_CHANGED',
    stage: 'native-response',
    mutating: true,
    responseOk: false,
    nativeCode: 'NO_TEXT_INPUT_TARGET',
    nativeReason: 'exact-target-missing',
    nativeMutation: 'none',
    probeState: null,
    recovery: null,
  });
  assert.equal(context.refusedBeforeMutation, true);
  assert.equal(context.authorizations, 1);
  assert.deepEqual(sends, ['tap']);
  assert.ok(!JSON.stringify(context.refusalDiagnostic).includes('PRIVATE-'));
});

for (const failure of ['transport', 'decode']) {
  test(`QA ${failure} failure stays unknown after the existing status probe`, async () => {
    const sends = runner((body) => {
      if (body.command === 'tap') {
        if (failure === 'decode') return new Response('PRIVATE-not-json');
        throw Error('PRIVATE-transport');
      }
      return { ok: true, data: { commandId: body.commandId, state: 'unknown' } };
    });
    const context = new QaDispatchContext(10, () => 1);
    await assert.rejects(
      runIOS({ command: 'tap', x: 10, y: 20, qaContext: context }),
      /ACTION_OUTCOME_UNCERTAIN/,
    );
    assert.deepEqual(context.refusalDiagnostic, {
      refusal: 'ACTION_OUTCOME_UNCERTAIN',
      stage: 'dispatch-error',
      mutating: true,
      responseOk: null,
      nativeCode: null,
      nativeReason: null,
      nativeMutation: null,
      probeState: 'unknown',
      recovery: null,
    });
    assert.equal(context.refusedBeforeMutation, false);
    assert.equal(context.authorizations, 1);
    assert.deepEqual(sends, ['tap', 'status']);
  });
}

test('unrecognized native fields and malformed ok remain unknown on a recognized refusal', async () => {
  const sends = runner(() => ({
    ok: 'PRIVATE-ok',
    data: { verifyVerdict: 'target-lost' },
    error: {
      code: 'PRIVATE-code',
      reason: 'exact-target-PRIVATE-reason',
      mutation: 'PRIVATE-mutation',
      message: 'PRIVATE-message',
    },
  }));
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    runIOS({ command: 'tap', x: 10, y: 20, qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(context.refusalDiagnostic, {
    refusal: 'ACTION_CONTEXT_CHANGED',
    stage: 'native-response',
    mutating: true,
    responseOk: null,
    nativeCode: null,
    nativeReason: null,
    nativeMutation: null,
    probeState: null,
    recovery: null,
  });
  assert.equal(context.refusedBeforeMutation, false);
  assert.deepEqual(sends, ['tap']);
});

test('QA recovered refusal keeps the already-obtained journal disposition without replay', async () => {
  const sends = runner((body) => {
    if (body.command === 'tap') throw Error('PRIVATE-response-lost');
    return {
      ok: true,
      data: {
        commandId: body.commandId,
        state: 'failed',
        result: {
          ok: false,
          error: { code: 'STALE_REF', mutation: 'none' },
        },
      },
    };
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    runIOS({ command: 'tap', x: 10, y: 20, qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.equal(context.refusalDiagnostic?.recovery, 'recovered-error');
  assert.equal(context.refusalDiagnostic?.probeState, 'failed');
  assert.equal(context.refusalDiagnostic?.nativeCode, 'STALE_REF');
  assert.equal(context.refusedBeforeMutation, true);
  assert.equal(context.authorizations, 1);
  assert.deepEqual(sends, ['tap', 'status']);
});

test('a successful action followed by a settle probe failure retains its completed context', async () => {
  const sends = runner((body) =>
    body.command === 'tap'
      ? { ok: true }
      : {
          ok: false,
          error: {
            code: 'ACTION_CONTEXT_CHANGED',
            mutation: 'PRIVATE-mutation',
            reason: 'PRIVATE-reason',
            message: 'PRIVATE-message',
          },
        },
  );
  const context = new QaDispatchContext(10, () => 1);
  await runIOS({ command: 'tap', x: 10, y: 20, qaContext: context });
  assert.equal(context.refusalDiagnostic, undefined);
  assert.equal(await buildIosProbes('qa.app', context).snapshotHash(), null);
  assert.doesNotThrow(() => context.assertComplete());
  assert.equal(context.refusalDiagnostic, undefined);
  assert.equal(context.refusedBeforeMutation, false);
  assert.equal(context.authorizations, 1);
  assert.deepEqual(sends, ['tap', 'snapshot']);
});

test('runNative cannot hide an iOS startup in QA preparation', async () => {
  session();
  const context = new QaDispatchContext(10, () => 1);
  _setFastRunnerStateForTest(null);
  _setFetchForTest(async () => {
    assert.fail('no runner means no transport');
  });
  await assert.rejects(runNative(['back'], { qaContext: context }), /ACTION_CONTEXT_CHANGED/);
  assert.equal(context.authorizations, 0);
  assert.throws(() => context.assertComplete(), /ACTION_CONTEXT_CHANGED/);
});

test('runNative checks expiry at the actual send after readiness', async () => {
  session();
  let now = 1;
  const sends = runner(
    () => ({ ok: true }),
    () => {
      now = 10;
    },
  );
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(runNative(['back'], { qaContext: context }), /EVIDENCE_EXPIRED/);
  assert.deepEqual(sends, []);
});

for (const handler of [createDeviceScrollHandler, createDeviceSwipeHandler]) {
  test(`${handler.name} cannot fall back after a failed fast send`, async () => {
    session();
    const sends = runner(() => ({
      ok: false,
      error: { code: 'FAILED', message: 'unknown effect' },
    }));
    const context = new QaDispatchContext(10, () => 1);
    await assert.rejects(
      handler()({ direction: 'down', qaContext: context }),
      /ACTION_OUTCOME_UNCERTAIN/,
    );
    assert.deepEqual(sends, ['drag']);
    assert.equal(context.authorizations, 1);
  });
}

test('an iOS QA scroll logs its drag, band and keyboard top before the send, numbers only', async () => {
  session();
  updateRefMapFromFlat(
    [
      { ref: '@w', type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
      { ref: '@k', type: 'Keyboard', rect: { x: 0, y: 508, width: 390, height: 336 } },
    ] as never,
    { snapshotGeneration: 1, keyboardVisible: true },
  );
  const sends = runner(() => ({ ok: false, error: { code: 'FAILED', message: 'unknown effect' } }));
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await createDeviceScrollHandler()({
      direction: 'down',
      within: { x: 0, y: 300, width: 390, height: 200 },
      qaContext: new QaDispatchContext(10, () => 1),
    }).catch(() => undefined);
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(sends, ['drag']);
  assert.deepEqual(
    lines.filter((line) => line.includes('scroll drag')),
    ['qaren-core: scroll drag (195,499)->(195,301) band=(0,300,390,200) kb=508 duration=300ms\n'],
  );
});

test('scroll catch cannot swallow a send-seam expiry and fall back', async () => {
  session();
  let now = 1;
  const sends = runner(
    () => ({ ok: true }),
    () => {
      now = 10;
    },
  );
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(
    createDeviceScrollHandler()({ direction: 'down', qaContext: context }),
    /EVIDENCE_EXPIRED/,
  );
  assert.deepEqual(sends, []);
  assert.throws(() => context.assertComplete(), /EVIDENCE_EXPIRED/);
});

test('a completed late send is not retrospectively expired', async () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  const sends = runner(() => {
    now = 20;
    return { ok: true, data: {} };
  });
  await runIOS({ command: 'back', bundleId: 'qa.app', qaContext: context });
  assert.deepEqual(sends, ['back']);
  assert.equal(context.authorizations, 1);
  assert.doesNotThrow(() => context.assertComplete());
});

test('ordinary native refusal remains eligible for walker-owned unchanged-screen handling', async () => {
  session();
  const sends = runner(() => ({
    ok: false,
    error: { code: 'FOCUS_TARGET_OCCLUDED', message: 'target occluded', mutation: 'none' },
  }));
  const context = new QaDispatchContext(10, () => 1);
  const result = await createDevicePressHandler(() => {
    throw new Error('no CDP');
  })({
    x: 10,
    y: 20,
    qaContext: context,
  });
  assert.equal(result.isError, true);
  assert.deepEqual(sends, ['tap']);
  assert.equal(context.authorizations, 1);
  assert.doesNotThrow(() => context.assertComplete());
});

test('recovered transport result needs only the original authorization', async () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  const sends = runner((body) => {
    if (body.command === 'drag') {
      now = 20;
      throw new Error('socket hang up');
    }
    return {
      ok: true,
      data: { commandId: body.commandId, state: 'completed', result: { ok: true } },
    };
  });
  await fastSwipe(1, 2, 3, 4, 100, 'qa.app', context);
  assert.deepEqual(sends, ['drag', 'status']);
  assert.equal(context.authorizations, 1);
  assert.doesNotThrow(() => context.assertComplete());
});

for (const code of ['KEYBOARD_RELAYOUT_REQUIRED', 'KEYBOARD_OCCLUDED', 'KEYBOARD_DISMISS_FAILED']) {
  test(`QA ${code} cannot repair without proven no-invocation identity`, async () => {
    session();
    const sends = runner(() => ({ ok: false, error: { code, message: code } }));
    let cdpCalls = 0;
    const handler = createDevicePressHandler(() => ({
      isConnected: () => true,
      evaluate: async () => {
        cdpCalls++;
        return { value: '{"dismissed":true}' };
      },
    }));
    const context = new QaDispatchContext(10, () => 1);
    await assert.rejects(handler({ x: 10, y: 20, qaContext: context }), /ACTION_OUTCOME_UNCERTAIN/);
    assert.deepEqual(sends, ['tap']);
    assert.equal(cdpCalls, 0);
    assert.equal(context.authorizations, 1);
  });
}

function androidRunner(reply: (body: Record<string, unknown>) => unknown, health = () => {}) {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 12345,
    devicePort: 12345,
    pid: process.pid,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    startedAt: '',
    protocolVersion: 2,
  });
  const sends: string[] = [];
  androidFetch(async (url, init) => {
    if (String(url).endsWith('/health')) {
      health();
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, 'QA_READ_ONLY_V1'],
      });
    }
    const body = JSON.parse(String(init?.body));
    sends.push(body.command);
    return Response.json(reply(body));
  });
  return sends;
}

test('native keyboard identity invalidation survives the actual press handler', async () => {
  session();
  const sends = runner(() => ({
    ok: false,
    error: { code: 'KEYBOARD_TARGET_STALE', message: 'target changed', mutation: 'none' },
  }));
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDevicePressHandler(() => {
      throw new Error('no CDP');
    })({ x: 10, y: 20, qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(sends, ['tap']);
  assert.equal(context.authorizations, 1);
  assert.throws(() => context.assertComplete(), /ACTION_CONTEXT_CHANGED/);
});

test('Android checks the real send seam after read-only readiness', async () => {
  let now = 1;
  const sends = androidRunner(
    () => ({ ok: true }),
    () => {
      now = 10;
    },
  );
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(runAndroid({ command: 'back', qaContext: context }), /EVIDENCE_EXPIRED/);
  assert.deepEqual(sends, []);
  assert.equal(context.authorizations, 0);
});

test('Android QA snapshot refuses accessibility restart', async () => {
  const sends = androidRunner(() => ({ ok: false, error: { code: 'ACCESSIBILITY_UNAVAILABLE' } }));
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    runAndroid({ command: 'snapshot', qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(sends, ['snapshot']);
  assert.equal(context.authorizations, 0);
});

test('Android QA preparation never starts an absent runner', async () => {
  session('android');
  _setAndroidRunnerStateForTest(null);
  androidFetch(async () => {
    assert.fail('absent runner must not be contacted');
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(runNative(['back'], { qaContext: context }), /ACTION_CONTEXT_CHANGED/);
  assert.equal(context.authorizations, 0);
});

test('Android late recovered mutation retains one authorization', async () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  const sends = androidRunner((body) => {
    if (body.command === 'back') {
      now = 20;
      throw new Error('socket hang up');
    }
    return {
      ok: true,
      data: { commandId: body.commandId, state: 'completed', result: { ok: true } },
    };
  });
  await runAndroid({ command: 'back', qaContext: context });
  assert.deepEqual(sends, ['back', 'status']);
  assert.equal(context.authorizations, 1);
  assert.doesNotThrow(() => context.assertComplete());
});

function snapshot(label: string, type = 'Application', identifier?: string) {
  return {
    ok: true,
    data: {
      snapshotGeneration: 1,
      keyboardVisible: false,
      nodes: [
        {
          index: 0,
          label,
          type,
          identifier,
          rect: { x: 0, y: 0, width: 100, height: 100 },
          hittable: true,
          enabled: true,
        },
      ],
    },
  };
}

test('QA capture refuses runner leak without reopen or recovery', async () => {
  session();
  const sends = runner((body) => {
    assert.equal(body.qaReadOnly, true);
    return snapshot('AgentDeviceRunner');
  });
  await assert.rejects(
    createDeviceSnapshotHandler()({ action: 'snapshot', qaReadOnly: true }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(sends, ['snapshot']);
});

test('QA exact fill uses no-recovery snapshot preparation', async () => {
  session();
  const sends = runner((body) => {
    assert.equal(body.qaReadOnly, true);
    return snapshot('AgentDeviceRunner');
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDeviceFillHandler(() => {
      throw new Error('no CDP');
    })({ ref: 'input', text: 'hello', qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(sends, ['snapshot']);
  assert.equal(context.authorizations, 0);
});

test('an exact fill the runner refuses on a moved frame stays latched and attests no mutation', async () => {
  session();
  const sends = runner((body) =>
    body.command === 'snapshot'
      ? snapshot('Input', 'TextField', 'input')
      : {
          ok: false,
          error: {
            code: 'NO_TEXT_INPUT_TARGET',
            message:
              'NO_TEXT_INPUT_TARGET: the described text input is no longer present on screen',
            mutation: 'none',
          },
        },
  );
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDeviceFillHandler(() => {
      throw new Error('no CDP');
    })({ ref: 'input', text: 'hello', qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.deepEqual(sends, ['snapshot', 'type']);
  assert.equal(context.authorizations, 1);
  assert.equal(context.refusedBeforeMutation, true);
});

test('exact fill preparation cannot renew the original mutation deadline', async () => {
  session();
  let now = 1;
  const sends = runner(() => {
    now = 10;
    return snapshot('Input', 'TextField', 'input');
  });
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(
    createDeviceFillHandler(() => {
      throw new Error('no CDP');
    })({ ref: 'input', text: 'hello', qaContext: context }),
    /EVIDENCE_EXPIRED/,
  );
  assert.deepEqual(sends, ['snapshot']);
  assert.equal(context.authorizations, 0);
});

test('actual dialog preparation is read-only and taps the alert button by its exact label', async () => {
  session();
  const sends = runner((body) => {
    if (body.command === 'snapshot') {
      assert.equal(body.qaReadOnly, true);
      const dialog = snapshot('Permission', 'Alert');
      dialog.data.nodes.push({
        index: 1,
        label: 'Allow',
        type: 'Button',
        identifier: 'allow',
        rect: { x: 1, y: 1, width: 50, height: 50 },
        hittable: true,
        enabled: true,
      });
      return dialog;
    }
    assert.equal(body.command, 'systemAlertTap');
    assert.equal(body.text, 'Allow');
    assert.equal(body.qaReadOnly, undefined);
    assert.equal(body.x, undefined);
    return {
      ok: false,
      error: {
        code: 'SYSTEM_ALERT_CHANGED',
        message: 'SYSTEM_ALERT_CHANGED: the alert changed before the tap; nothing was tapped',
        mutation: 'none',
      },
    };
  });
  const context = new QaDispatchContext(10, () => 1);
  const result = await createDeviceAcceptSystemDialogHandler()({
    platform: 'ios',
    qaContext: context,
  });
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'SYSTEM_ALERT_CHANGED');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(sends, ['snapshot', 'systemAlertTap']);
  assert.equal(context.authorizations, 1);
});

for (const mode of ['proof', 'transition'] as const) {
  for (const focused of [true, false, null]) {
    test(`focused ${mode} fill checks focus after awaited health (${focused})`, async () => {
      session();
      const events: string[] = [];
      let currentFocus: boolean | null = true;
      const sends = runner(
        () => {
          events.push('type');
          return { ok: true, data: { typed: true, textEntryRoute: 'synthesized-first-responder' } };
        },
        async () => {
          await Promise.resolve();
          currentFocus = focused;
          events.push('health');
        },
      );
      const client = {
        isConnected: true,
        evaluate: async () => {
          events.push('focus');
          return currentFocus === null
            ? { error: 'unavailable' }
            : {
                value: JSON.stringify({ value: '', controlled: true, focused: currentFocus }),
              };
        },
      } as never;
      const context = new QaDispatchContext(100, () => 1);
      const result = await performFocusedFill(
        {
          ref: 'email-pressable',
          testID: 'email',
          text: 'replacement',
          qaContext: context,
          requireFocused: mode === 'proof',
          vetoUnfocused: true,
          skipFinalValidation: true,
          clearFirst: true,
        },
        client,
      );
      const env = JSON.parse(result.content[0].text);
      const allowed = focused === true;
      const prefix = allowed
        ? ['focus', 'health', 'focus', 'type', 'focus', 'type', 'health']
        : ['focus', 'health', 'focus'];
      assert.deepEqual(events.slice(0, prefix.length), prefix);
      assert.ok(events.slice(prefix.length).every((event) => event === 'focus'));
      assert.deepEqual(sends, allowed ? ['type', 'type'] : []);
      assert.equal(context.authorizations, sends.length);
      assert.equal(env.ok, allowed);
      if (!allowed) {
        assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
        assert.equal(env.meta.mutation, 'none');
      }
    });
  }
}

test('focused proof cannot bypass expiry while awaiting its final read', async () => {
  session();
  const sends = runner(() => ({ ok: true }));
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  const client = {
    isConnected: true,
    evaluate: async () => {
      now = 10;
      return { value: JSON.stringify({ value: '', controlled: true, focused: true }) };
    },
  } as never;
  await assert.rejects(
    performFocusedFill(
      {
        ref: 'email-pressable',
        testID: 'email',
        text: 'replacement',
        qaContext: context,
        requireFocused: true,
        skipFinalValidation: true,
      },
      client,
    ),
    /EVIDENCE_EXPIRED/,
  );
  assert.deepEqual(sends, []);
  assert.equal(context.authorizations, 0);
});

test('a QA native dispatch times its send, settle and post-settle health as value-free phases', async () => {
  session();
  runner((body) =>
    body.command === 'snapshot' ? { ok: true, data: { nodes: [] } } : { ok: true },
  );
  const events: TimingEvent[] = [];
  observeDispatchPhases({ now: () => 0, observe: createTimingObserver((e) => events.push(e)) });
  try {
    await runNative(['back'], { qaContext: new QaDispatchContext(10, () => 1, undefined, 7) });
  } finally {
    observeDispatchPhases(undefined);
  }
  assert.deepEqual(
    events.map((e) => [e.stage, e.edge, e.line, e.ms]),
    [
      ['dispatch-native', 'start', 7, undefined],
      ['dispatch-native', 'end', 7, 0],
      ['dispatch-settle', 'start', 7, undefined],
      ['dispatch-settle', 'end', 7, 0],
      ['dispatch-health', 'start', 7, undefined],
      ['dispatch-health', 'end', 7, 0],
    ],
  );
});

test('typing HTTP timeout names its refusal stage and native code with passive durations', async () => {
  let now = 0;
  const metrics: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'run');
  runner((body) => {
    if (body.command === 'type') {
      now += 10000;
      _setFastRunnerStateForTest(null);
      throw new Error('RUNNER_TIMEOUT: private-value');
    }
    return { ok: true, data: { commandId: body.commandId, state: 'unknown' } };
  });
  const context = new QaDispatchContext(20000, () => now);
  await withInputs(new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']), async () => {
    await assert.rejects(
      runIOS({
        command: 'type',
        text: 'private-value',
        bundleId: 'qa.app',
        qaContext: context,
        qaTiming: {
          now: () => now,
          observe: (event) => {
            metrics.push(event);
            writer.diagnostic({ kind: 'metric', ...event });
          },
        },
        _verifyExactReadback: async () => {
          now += 25;
          return { matches: false, actual: 'private-value' };
        },
      }),
      /ACTION_OUTCOME_UNCERTAIN/,
    );
    writer.diagnostic({
      kind: 'timing',
      stage: 'dispatch',
      code: 'ACTION_INTERRUPTED',
      line: 17,
      at: now,
      acquisitionMs: 1,
      observationAgeMs: now,
      authorizations: context.authorizations,
      refusalDiagnostic: context.refusalDiagnostic,
    });
  });
  assert.equal(context.refusalDiagnostic?.stage, 'dispatch-error');
  assert.equal(context.refusalDiagnostic?.nativeCode, 'RUNNER_TIMEOUT');
  assert.equal(context.refusalDiagnostic?.mutating, true);
  assert.ok(
    metrics.some(
      (event) =>
        event.stage === 'type-call' &&
        event.edge === 'end' &&
        event.ms === 10000 &&
        event.outcome === 'failed',
    ),
  );
  assert.ok(
    metrics.some(
      (event) =>
        event.stage === 'type-readback' &&
        event.edge === 'end' &&
        event.ms === 25 &&
        event.outcome === 'failed',
    ),
  );
  assert.ok(
    !JSON.stringify({ metrics, diagnostic: context.refusalDiagnostic }).includes('private-value'),
  );
  const record = lines.map((line) => JSON.parse(line).payload);
  assert.ok(record.some((event) => event.stage === 'type-call' && event.ms === 10000));
  assert.ok(
    record.some(
      (event) =>
        event.stage === 'dispatch' &&
        event.refusalStage === 'dispatch-error' &&
        event.nativeCode === 'RUNNER_TIMEOUT' &&
        event.mutating === true,
    ),
  );
  assert.ok(!lines.join('').includes('private-value'));
});

test('type success has the same result with metrics enabled, disabled or a failing sink', async () => {
  const results: unknown[] = [];
  for (const sink of ['absent', 'working', 'throwing']) {
    let now = 0;
    const events: Array<Record<string, unknown>> = [];
    runner(() => {
      now += 40;
      return { ok: true, data: { typed: true } };
    });
    const context = new QaDispatchContext(20000, () => now);
    results.push(
      await runIOS({
        command: 'type',
        text: 'private-value',
        qaContext: context,
        ...(sink !== 'absent'
          ? {
              qaTiming: {
                now: () => now,
                observe: (event) => {
                  events.push(event);
                  if (sink === 'throwing') throw Error('private-value');
                },
              },
            }
          : {}),
      }),
    );
    assert.equal(context.authorizations, 1);
    assert.equal(context.refusal, undefined);
    if (sink !== 'absent')
      assert.ok(
        events.some(
          (event) =>
            event.stage === 'type-call' &&
            event.edge === 'end' &&
            event.ms === 40 &&
            event.outcome === 'ok',
        ),
      );
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});

for (const guard of ['not_occluded', 'auto_dismissed', 'no_keyboard', 'private-value']) {
  test(`keyboard guard ${guard} emits only finite keyboard facts`, async () => {
    const events: Array<Record<string, unknown>> = [];
    runner(() => ({ ok: true, data: { tapped: true, keyboardGuard: guard } }));
    await runIOS({
      command: 'tap',
      x: 1,
      y: 2,
      qaTiming: { now: () => 10, observe: (event) => events.push(event) },
    });
    const keyboard = events.filter((event) => event.stage === 'keyboard');
    if (guard === 'private-value') assert.deepEqual(keyboard, []);
    else
      assert.deepEqual(keyboard, [
        {
          stage: 'keyboard',
          edge: 'point',
          outcome: 'ok',
          at: 10,
          ms: 0,
          event: guard === 'not_occluded' ? 'shown' : 'hidden',
        },
      ]);
  });
}

test('relayout metrics bracket the existing refresh and retap without changing its result', async () => {
  let now = 0;
  let taps = 0;
  const events: Array<Record<string, unknown>> = [];
  const sends = runner(() => {
    now += 10;
    return ++taps === 1
      ? { ok: false, error: { code: 'KEYBOARD_RELAYOUT_REQUIRED', message: 'private-value' } }
      : { ok: true, data: { tapped: true } };
  });
  const result = await runIOS({
    command: 'tap',
    x: 1,
    y: 2,
    qaTiming: { now: () => now, observe: (event) => events.push(event) },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(sends, ['tap', 'tap']);
  assert.ok(
    events.some(
      (event) => event.stage === 'keyboard' && event.event === 'relayout' && event.ms === 10,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.stage === 'relayout-retap' &&
        event.edge === 'end' &&
        event.ms === 10 &&
        event.outcome === 'ok',
    ),
  );
  assert.ok(!JSON.stringify(events).includes('private-value'));
});

test('QA relayout refusal keeps the native code and keyboard event before declining repair', async () => {
  const events: Array<Record<string, unknown>> = [];
  const sends = runner(() => ({
    ok: false,
    error: { code: 'KEYBOARD_RELAYOUT_REQUIRED', message: 'private-value', mutation: 'none' },
  }));
  const context = new QaDispatchContext(1000, () => 10);
  await assert.rejects(
    runIOS({
      command: 'tap',
      x: 1,
      y: 2,
      qaContext: context,
      qaTiming: { now: () => 10, observe: (event) => events.push(event) },
    }),
    /ACTION_OUTCOME_UNCERTAIN/,
  );
  assert.equal(context.refusalDiagnostic?.nativeCode, 'KEYBOARD_RELAYOUT_REQUIRED');
  assert.equal(context.refusalDiagnostic?.stage, 'native-response');
  assert.deepEqual(sends, ['tap']);
  assert.ok(events.some((event) => event.stage === 'keyboard' && event.event === 'relayout'));
  assert.ok(!events.some((event) => event.stage === 'relayout-retap'));
});

test('instant-submit authority loss retains refusal facts beside long typing and unavailable readback', async () => {
  const outputs: string[] = [];
  for (const secret of ['private-code-one', 'private-code-two']) {
    session();
    let now = 0;
    const lines: string[] = [];
    const writer = createWriter((line) => lines.push(line), 'run');
    const sends = runner((body) => {
      if (body.prepareReplacement) return { ok: true, data: { message: 'cleared' } };
      now += 12532;
      _setFastRunnerStateForTest(null);
      return { ok: true, data: { typed: true } };
    });
    const f = walker(
      [screen([element('@field', 'Code', { kind: 'input', testID: 'field' })])],
      scriptedJudge(() => ({})),
    );
    f.deps.now = () => now;
    f.deps.timing = createTimingObserver((event) =>
      writer.diagnostic({ kind: 'metric', ...event, line: 17 }),
    );
    f.deps.diagnostic = (event) => writer.diagnostic({ kind: 'timing', ...event });
    f.deps.fill = async (_ref, text, context) => {
      await runNative(['fill', '@field', text, '--clear-first'], {
        qaContext: context,
        qaTiming: { now: () => now, observe: f.deps.timing! },
        focusedType: true,
        focusedProof: async () => true,
        settle: { enabled: false },
      });
      assert.fail('lost authority must retain its existing refusal');
    };
    const result = await withInputs(new RunInputs({ CODE: secret }, ['CODE']), () =>
      runPlan(parsePlan('\n'.repeat(16) + '1. Fill "field" with input CODE').blocks!, f.deps),
    );
    const record = lines.map((line) => JSON.parse(line).payload);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /ACTION_OUTCOME_UNCERTAIN/);
    assert.deepEqual(sends, ['type', 'type']);
    assert.ok(
      record.some(
        (event) =>
          event.stage === 'type-call' &&
          event.edge === 'end' &&
          event.ms === 12532 &&
          event.outcome === 'ok',
      ),
    );
    assert.ok(
      record.some(
        (event) =>
          event.stage === 'type-readback' &&
          event.edge === 'end' &&
          event.ms === 0 &&
          event.outcome === 'unavailable',
      ),
    );
    const refusal = record.find(
      (event) =>
        event.kind === 'timing' &&
        event.stage === 'dispatch' &&
        event.code === 'ACTION_INTERRUPTED',
    );
    assert.equal(refusal?.line, 17);
    assert.equal(refusal?.authorizations, 2);
    assert.equal(refusal?.refusalStage, 'settle');
    assert.equal(refusal?.nativeCode, 'RUNNER_OWNERSHIP_MISMATCH');
    assert.equal(refusal?.mutating, true);
    for (const token of [
      secret,
      Buffer.from(secret).toString('hex'),
      Buffer.from(secret).toString('base64'),
      encodeURIComponent(secret),
    ])
      assert.ok(!lines.join('').includes(token));
    outputs.push(lines.join(''));
  }
  assert.equal(outputs[0], outputs[1]);
});

for (const [name, pid, after, nativeCode] of [
  ['cleared runner state', 111_111_111, null, 'RUNNER_OWNERSHIP_MISMATCH'],
  ['replaced runner', 111_111_111, 222_222_222, 'RUNNER_OWNERSHIP_MISMATCH'],
  ['dead runner health', 999_999_999, 999_999_999, undefined],
] as const) {
  test(`post-settle authority loss after a success-shaped type names the ${name} without a timeout`, async () => {
    _setFastRunnerStateForTest(
      after === null
        ? null
        : {
            pid: after,
            port: 12345,
            deviceId: 'qa-post-settle-device',
            bundleId: 'qa.app',
            protocolVersion: RUNNER_PROTOCOL_VERSION,
          },
    );
    const context = new QaDispatchContext(Infinity, () => 0);
    await assert.rejects(
      verifyTypeResultAfterSettle(
        {
          command: 'type',
          text: 'private-value',
          qaContext: context,
          _verifyExactReadback: async () => ({ matches: false, actual: '' }),
        },
        okResult({ typed: true }),
        {
          pid,
          port: 12345,
          deviceId: 'qa-post-settle-device',
          statePath: '/tmp/qa-post-settle-state.json',
          provenance: 'adopted',
        },
      ),
      /ACTION_CONTEXT_CHANGED/,
    );
    assert.equal(context.refusalDiagnostic?.stage, 'settle');
    assert.equal(context.refusalDiagnostic?.mutating, true);
    assert.equal(context.refusalDiagnostic?.nativeCode, nativeCode ?? null);
  });
}
