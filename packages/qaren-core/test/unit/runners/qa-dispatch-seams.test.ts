import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import {
  _setFetchForTest,
  _setFastRunnerStateForTest,
  fastSwipe,
  runIOS,
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
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import { createDeviceAcceptSystemDialogHandler } from '../../../dist/handlers/device-system-dialog.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
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
    return Response.json(reply(body));
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
      const allowed = focused === true || (mode === 'transition' && focused === null);
      // After the one send, only value read-backs follow; an empty read-back is never retyped.
      assert.deepEqual(
        events.slice(0, allowed ? 4 : undefined),
        allowed ? ['health', 'focus', 'type', 'health'] : ['health', 'focus'],
      );
      assert.ok(events.slice(4).every((event) => event === 'focus'));
      assert.deepEqual(sends, allowed ? ['type'] : []);
      assert.equal(context.authorizations, allowed ? 1 : 0);
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
