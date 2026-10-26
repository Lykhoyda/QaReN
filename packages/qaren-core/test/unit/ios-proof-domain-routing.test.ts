import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { getActiveSession, _setActiveSessionForTest } from '../../dist/agent-device-wrapper.js';
import {
  nativeSelectorsForCommands,
  planIosProofDomains,
  selectorsVisibleInNativeSnapshot,
  soleComparableNativeSelectorForCommands,
} from '../../dist/domain/ios-proof-router.js';
import {
  createMaestroRunHandler,
  executeMaestroAuthorityStages,
  runFlowParked,
} from '../../dist/handlers/maestro-run.js';
import { replayTreeData, runCdpReplayCommands } from '../../dist/handlers/cdp-replay-dispatch.js';
import { performReactTreeInput } from '../../dist/handlers/device-interact.js';
import { chooseMaestroDispatch } from '../../dist/handlers/maestro-dispatch.js';
import { createRunActionHandler } from '../../dist/handlers/run-action.js';
import { createTmpProject } from '../helpers/tmp-project.js';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';
import { reapStaleFastRunner } from '../../dist/runners/rn-fast-runner-client.js';
import {
  normalizeSteps,
  replayFlow,
  UnsupportedStepError,
} from '../../dist/domain/cdp-flow-replay.js';

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok?: boolean;
    code?: string;
    data?: Record<string, any>;
    meta?: Record<string, any>;
    error?: string;
  };
}

const callbacks = {
  claimNativeOrigin: async () => {},
  completeNativeOrigin: async () => {},
  relaunchManagedApp: async () => {},
  reproveManagedOrigin: async () => {},
  completeRunnerPark: async () => {},
};

test('exact iOS commands route before dispatch to react-tree proof', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      throw new Error('WDA dispatch must not be selected for an exact React flow');
    },
    replayDeps: () => ({
      pressByTestId: async (id) => calls.push(`press:${id}`),
      typeByTestId: async (id, text) => calls.push(`type:${id}:${text}`),
      treeFor: async (id) => ({ testID: id, children: [] }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => calls.push('unexpected-launch'),
      settle: async () => calls.push('settle'),
    }),
    getLiveRoute: async () => 'home',
  });

  const result = await handler({
    platform: 'ios',
    inlineYaml: `appId: com.example.app
---
- launchApp:
    stopApp: false
- tapOn:
    id: email
- inputText: a
- assertVisible:
    id: home
`,
    actionMetadata: {
      id: 'login-en',
      enginePin: 'maestro-runner@1.1.28',
      tags: ['auth', 'login'],
      expectedRouteSequence: ['home'],
    },
    ...callbacks,
  });
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.passed, true);
  assert.equal(env.data?.proofDomain, 'react-tree');
  assert.equal(env.data?.maestroCertified, false);
  assert.deepEqual(calls, ['press:email', 'type:email:a']);
});

test('React launchApp stopApp is forwarded to the authority relaunch lifecycle', async () => {
  const relaunches: boolean[] = [];
  const run = (launch: unknown) =>
    executeMaestroAuthorityStages(
      [launch, { tapOn: { id: 'email' } }],
      async (commands) => commands,
      async () => {},
      async () => {},
      async (stopApp) => relaunches.push(stopApp ?? true),
    );

  await run({ launchApp: { stopApp: false } });
  await run({ launchApp: { stopApp: true } });
  await run({ launchApp: null });
  assert.deepEqual(relaunches, [false, true, true]);
});

test('partitioned reconnect recovery honors the replay deadline', async () => {
  const started = Date.now();
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const result = await handler({
    platform: 'ios',
    timeoutMs: 20,
    inlineYaml: 'appId: com.example.app\n---\n- launchApp: null\n- tapOn:\n    id: submit\n',
    relaunchManagedApp: async () => {
      throw new Error('reconnect required');
    },
    reproveManagedOrigin: async ({ signal } = {}) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        if (signal?.aborted) {
          clearTimeout(timer);
          reject(new Error('RUNNER_TIMEOUT: reconnect cancelled'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('RUNNER_TIMEOUT: reconnect cancelled'));
          },
          { once: true },
        );
      }),
    completeNativeOrigin: async () => {},
    claimNativeOrigin: async () => {},
    completeRunnerPark: async () => {},
  });
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'RUNNER_TIMEOUT');
  assert.ok(Date.now() - started < 3000);
});

test('React-only learned replay preflights action format before mutation', async () => {
  let mutations = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => mutations++,
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    resolveEngineStatus: async () => buildReplayEngineStatus('not-installed', null, false),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: submit
`,
      actionMetadata: { id: 'saved-login', tags: ['auth'] },
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'ENGINE_PIN_MISMATCH');
  assert.match(env.error ?? '', /migrated to maestro-runner/);
  assert.equal(mutations, 0);
});

test('React-only learned replay ignores native runtime pin drift', async () => {
  let mutations = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => mutations++,
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    resolveEngineStatus: async () => buildReplayEngineStatus('not-installed', null, false),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: submit
`,
      actionMetadata: {
        id: 'saved-submit',
        enginePin: `maestro-runner@${MAESTRO_RUNNER_PIN.version}`,
        tags: ['action'],
      },
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.equal(mutations, 1);
});

test('mounted hidden extendedWaitUntil target is an assertion failure, not absence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'clipped' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => ({ testID: 'clipped' }),
      frontmostFor: async () => ({ visible: false, reason: 'target is clipped' }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'ASSERTION_FAILED');
  assert.match(replay.reason ?? '', /clipped/);
});

test('an omitted-timeout wait polls readable absence until the React target appears', async () => {
  let treeReads = 0;
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' } } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => (++treeReads >= 3 ? { testID: id } : null),
      frontmostFor: async () =>
        treeReads >= 3
          ? { visible: true, matchCount: 1 }
          : { visible: false, matchCount: 0, reason: 'testID is not mounted' },
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, true);
  assert.equal(treeReads, 3);
  assert.ok(replay.steps[0]!.durationMs >= 350);
});

test('an omitted-timeout wait preserves unreadable component-tree evidence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' } } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: false,
          code: 'RECONNECT_TIMEOUT',
          error: 'Component tree connection timed out',
          meta: { reconnectAttempted: true },
        }),
      frontmostFor: async () => ({ visible: false }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'RECONNECT_TIMEOUT');
  assert.equal(replay.failedStepIndex, 0);
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: false,
    code: 'RECONNECT_TIMEOUT',
    error: 'Component tree connection timed out',
    meta: { reconnectAttempted: true },
  });
});

test('hideKeyboard after exact-testID steps is refused before WDA', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      throw new Error('WDA dispatch must not be selected');
    },
    replayDeps: () => ({
      pressByTestId: async (id) => {
        calls.push(`press:${id}`);
      },
      typeByTestId: async (id, text) => {
        calls.push(`type:${id}:${text}`);
      },
      treeFor: async () => null,
      frontmostFor: async () => ({ visible: false, matchCount: 0 }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: email
- inputText: x
- hideKeyboard
- extendedWaitUntil:
    visible:
      id: submit
- tapOn:
    id: submit
`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.match(env.error ?? '', /Refusing iOS proof-domain ambiguity at step 2/);
  assert.match(env.error ?? '', /relaunches the app/);
  assert.deepEqual(calls, []);
});

for (const [platform, runtimeAvailable] of [
  ['ios', true],
  [undefined, true],
  [undefined, false],
] as const) {
  test(`late-native refusal (${platform ?? 'session'}, pin ${runtimeAvailable})`, async () => {
    const project = createTmpProject();
    const priorSession = getActiveSession();
    try {
      _setActiveSessionForTest({
        name: 'late-native-test',
        platform: 'ios',
        openedAt: new Date(0).toISOString(),
      });
      project.seedAction(
        'late-native',
        `appId: com.example.app
---
# id: late-native
# intent: submit
# status: active
# enginePin: maestro-runner@${MAESTRO_RUNNER_PIN.version}
- tapOn:
    id: submit
- hideKeyboard
`,
        null,
      );
      const calls: string[] = [];
      const handler = createRunActionHandler({
        engineStatus: async () => {
          calls.push('native-runtime-preflight');
          return runtimeAvailable
            ? buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)
            : buildReplayEngineStatus('not-installed', null, false);
        },
        claimNativeOrigin: async () => {
          calls.push('claim-native-origin');
        },
        completeNativeOrigin: async () => {
          calls.push('complete-native-origin');
        },
        relaunchManagedApp: async () => {
          calls.push('relaunch');
        },
        reproveManagedOrigin: async () => {
          calls.push('reprove');
        },
      });
      const env = envelope(
        await handler({
          actionId: 'late-native',
          projectRoot: project.root,
          platform,
          appId: 'com.example.app',
          autoRepair: false,
          forceReload: false,
          proofReplay: true,
        }),
      );
      assert.equal(env.ok, false);
      assert.equal(env.code, 'UNSUPPORTED_STEP');
      assert.match(env.error ?? '', /Refusing iOS proof-domain ambiguity at step 1: hideKeyboard:/);
      assert.equal(env.meta?.actionId, 'late-native');
      assert.equal(env.meta?.sourceIndex, 1);
      assert.deepEqual(env.meta?.proofDomains, ['react-tree', 'xctest-native']);
      assert.deepEqual(calls, []);
    } finally {
      _setActiveSessionForTest(priorSession);
      project.cleanup();
    }
  });
}

test('Maestro without replay adapters refuses late native steps before dispatch', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      calls.push('dispatch');
      return { error: 'unexpected native dispatch' };
    },
    parkFlow: async (run) => {
      calls.push('park');
      return run();
    },
    claimNativeOrigin: async () => {
      calls.push('claim');
    },
    execFile: async () => {
      calls.push('runner');
      return { stdout: '', stderr: '' };
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      appId: 'com.example.app',
      inlineYaml: 'appId: com.example.app\n---\n- tapOn:\n    id: submit\n- hideKeyboard\n',
    }),
  );
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.equal(env.meta?.sourceIndex, 1);
  assert.deepEqual(env.meta?.proofDomains, ['react-tree', 'xctest-native']);
  assert.match(env.error ?? '', /Refusing iOS proof-domain ambiguity at step 1: hideKeyboard:/);
  assert.deepEqual(calls, []);
});

test('native-only iOS flows without exact testIDs still reach native dispatch', async () => {
  let dispatches = 0;
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      dispatches++;
      return { error: 'native dispatch reached' };
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      appId: 'com.example.app',
      inlineYaml: 'appId: com.example.app\n---\n- inputText: autofocused value\n- hideKeyboard\n',
    }),
  );
  assert.equal(dispatches, 1);
  assert.equal(env.error, 'native dispatch reached');
});

test('ordinary missing React testID stays TESTID_NOT_FOUND without WDA', async () => {
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      throw new Error('WDA dispatch must not be selected');
    },
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => null,
      frontmostFor: async () => ({ visible: false, matchCount: 0 }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- extendedWaitUntil:
    visible:
      id: genuinely-missing
    timeout: 250
`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.match(env.error ?? '', /React-tree replay failed/);
});

test('React stage failures retain completed tap and launch evidence', async () => {
  const calls: string[] = [];
  let relaunches = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async (id) => calls.push(`press:${id}`),
      typeByTestId: async () => {},
      treeFor: async (id) => (id === 'missing' ? { tree: {} } : { testID: id }),
      frontmostFor: async (id) =>
        id === 'missing' ? { visible: false, matchCount: 0 } : { visible: true },
      launchApp: async () => calls.push('launch'),
      settle: async () => {},
    }),
  });
  const result = await handler({
    platform: 'ios',
    inlineYaml: `appId: com.example.app
---
- launchApp: null
- tapOn:
    id: continue
- launchApp: null
- extendedWaitUntil:
    visible:
      id: missing
    timeout: 250
`,
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {
      relaunches++;
    },
    reproveManagedOrigin: async () => {},
    completeRunnerPark: async () => {},
  });
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error ?? '', /testID "missing" not present/);
  assert.equal(relaunches, 2);
  assert.deepEqual(calls, ['press:continue']);
  assert.deepEqual(
    env.meta?.steps?.map((step: { name: string }) => step.name),
    ['launch', 'tap', 'launch', 'waitVisible'],
  );
});

test('login replay refuses before mutation without a final positive ID', async () => {
  let mutations = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => mutations++,
      typeByTestId: async () => mutations++,
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: submit
`,
      actionMetadata: { id: 'login-en', tags: ['auth'], enginePin: 'maestro-runner@1.1.28' },
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'ASSERTION_FAILED');
  assert.equal(mutations, 0);
});

test('a native-only command after exact-testID steps is refused before execution', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: { id: 'email' } },
      { inputText: 'x' },
      { hideKeyboard: null },
      { extendedWaitUntil: { visible: { id: 'submit' } } },
      { tapOn: { id: 'submit' } },
    ],
    {},
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.sourceIndex, 2);
  assert.match(plan.reason, /hideKeyboard/);
  assert.match(plan.reason, /relaunches the app/);
});

test('a text assertVisible after exact-testID steps is refused before a native segment', () => {
  const plan = planIosProofDomains(
    [
      { assertVisible: { id: 'home-welcome' } },
      { tapOn: { id: 'tab-tasks' } },
      { waitForAnimationToEnd: null },
      { assertVisible: { id: 'task-screen' } },
      { assertVisible: { id: 'hackathon-qa-banner' } },
      { assertVisible: 'Hackathon QA · live' },
    ],
    {},
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.sourceIndex, 5);
  assert.match(plan.reason, /assertVisible/);
  assert.match(plan.reason, /relaunches the app/);
});

test('a native text prefix before exact-testID steps still plans', () => {
  const plan = planIosProofDomains(
    [{ tapOn: 'Cancel' }, { tapOn: { id: 'a' } }, { assertVisible: { id: 'b' } }],
    {},
  );
  assert.equal(plan.ok, true);
});

test('lifecycle commands after exact-testID steps still plan', () => {
  const plan = planIosProofDomains(
    [{ tapOn: { id: 'a' } }, { killApp: null }, { launchApp: {} }, { assertVisible: { id: 'b' } }],
    {},
  );
  assert.equal(plan.ok, true);
});

test('a native-only command after a late lifecycle command is refused at its source index', () => {
  const plan = planIosProofDomains(
    [{ tapOn: { id: 'a' } }, { killApp: null }, { hideKeyboard: null }],
    {},
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.sourceIndex, 2);
  assert.match(plan.reason, /hideKeyboard/);
});

test('neutral prefixes do not trigger late-native refusal before an exact testID', () => {
  for (const neutral of [{ launchApp: {} }, { waitForAnimationToEnd: null }]) {
    const native = planIosProofDomains([neutral, { inputText: 'autofocused value' }], {});
    assert.equal(native.ok, true);

    const afterExactId = planIosProofDomains(
      [
        neutral,
        { inputText: 'autofocused value' },
        { assertVisible: { id: 'ready' } },
        { hideKeyboard: null },
      ],
      {},
    );
    assert.equal(afterExactId.ok, false);
    if (afterExactId.ok) continue;
    assert.equal(afterExactId.sourceIndex, 3);
    assert.match(afterExactId.reason, /hideKeyboard/);
  }
});

test('22 neutral waits followed by inputText still plan without an exact testID', () => {
  const plan = planIosProofDomains(
    [
      ...Array.from({ length: 22 }, () => ({ waitForAnimationToEnd: null })),
      { inputText: 'autofocused value' },
    ],
    {},
  );
  assert.equal(plan.ok, true);
});

test('the real login shape partitions native prefix from exact React suffix', () => {
  const commands = [
    { launchApp: { clearState: true, stopApp: true } },
    { runFlow: { when: { visible: 'Open in' }, commands: [{ tapOn: 'Cancel' }] } },
    { extendedWaitUntil: { visible: { id: 'direct_login_button' }, timeout: 90_000 } },
    { tapOn: { id: 'direct_login_button' } },
    { assertVisible: { id: 'MainTabNavigatorCoverageTab' } },
  ];
  const plan = planIosProofDomains(commands, {});
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
    [
      { domain: 'xctest-native', sourceIndices: [0, 1] },
      { domain: 'react-tree', sourceIndices: [2, 3, 4] },
    ],
  );
});

test('an exact-id extended wait with omitted timeout plans in the React proof domain', () => {
  const plan = planIosProofDomains(
    [{ extendedWaitUntil: { visible: { id: 'otp_email-pressable' } } }],
    {},
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
    [{ domain: 'react-tree', sourceIndices: [0] }],
  );
});

test('exact-ID commands with unimplemented selector fields refuse React routing', () => {
  for (const command of [
    { assertVisible: { id: 'row', text: 'Paid' } },
    { tapOn: { id: 'row', retryTapIfNoChange: true } },
    { extendedWaitUntil: { visible: { id: 'row', text: 'Paid' }, timeout: 1000 } },
  ]) {
    const plan = planIosProofDomains([command], {});
    assert.equal(plan.ok, false);
    assert.throws(() => normalizeSteps([command], {}), UnsupportedStepError);
  }
});

test('inputText inherits the preceding selector proof domain', () => {
  const native = planIosProofDomains([{ tapOn: 'Email' }, { inputText: 'person@example.com' }], {});
  assert.equal(native.ok, true);
  if (native.ok)
    assert.deepEqual(
      native.segments.map((segment) => segment.domain),
      ['xctest-native'],
    );

  const react = planIosProofDomains(
    [{ tapOn: { id: 'email' } }, { inputText: 'person@example.com' }],
    {},
  );
  assert.equal(react.ok, true);
  if (react.ok)
    assert.deepEqual(
      react.segments.map((segment) => segment.domain),
      ['react-tree'],
    );
});

test('inputText keeps the focused selector domain across an intervening proof segment (refused, GH-1075)', () => {
  const nativeFocus = planIosProofDomains(
    [
      { tapOn: 'Email' },
      { assertVisible: { id: 'react-status' } },
      { inputText: 'person@example.com' },
    ],
    {},
  );
  assert.equal(nativeFocus.ok, false);
  if (!nativeFocus.ok) {
    assert.equal(nativeFocus.sourceIndex, 2);
    assert.match(nativeFocus.reason, /relaunches the app/);
  }

  const reactFocus = planIosProofDomains(
    [
      { tapOn: { id: 'email' } },
      { assertVisible: 'Native status' },
      { inputText: 'person@example.com' },
    ],
    {},
  );
  assert.equal(reactFocus.ok, false);
  if (!reactFocus.ok) {
    assert.equal(reactFocus.sourceIndex, 1);
    assert.match(reactFocus.reason, /relaunches the app/);
  }
});

test('inputText without a proven React focus remains in the native domain', () => {
  const plan = planIosProofDomains(
    [{ inputText: 'autofocused value' }, { assertVisible: { id: 'react-status' } }],
    {},
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
    [
      { domain: 'xctest-native', sourceIndices: [0] },
      { domain: 'react-tree', sourceIndices: [1] },
    ],
  );
});

test('nested leading inputText preserves native auto-focus without a proven React focus', () => {
  const plan = planIosProofDomains(
    [
      {
        runFlow: {
          when: { visible: { id: 'condition' } },
          commands: [{ inputText: 'autofocused value' }],
        },
      },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  if (plan.ok)
    assert.deepEqual(
      plan.segments.map(({ domain }) => domain),
      ['xctest-native'],
    );
});

test('nested waits before inputText remain native without a React focus anchor', () => {
  for (const leading of [
    [{ waitForAnimationToEnd: null }],
    [{ waitForAnimationToEnd: null }, { waitForAnimationToEnd: null }],
  ]) {
    const plan = planIosProofDomains(
      [
        {
          runFlow: {
            when: { visible: { id: 'condition' } },
            commands: [...leading, { inputText: 'value' }],
          },
        },
      ],
      {},
    );
    assert.equal(plan.ok, true);
    if (plan.ok)
      assert.deepEqual(
        plan.segments.map(({ domain }) => domain),
        ['xctest-native'],
      );
  }
});

test('conditional nested tap cannot prove focus for a later inputText (refused, GH-1075)', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: { id: 'field' } },
      {
        runFlow: {
          when: { visible: { id: 'condition' } },
          commands: [{ inputText: 'focused value' }],
        },
      },
    ],
    {},
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.sourceIndex, 1);
  assert.match(plan.reason, /relaunches the app/);
});

test('nested leading inputText preserves native focus after a native tap', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: 'Email' },
      {
        runFlow: {
          when: { visible: { id: 'condition' } },
          commands: [{ inputText: 'focused value' }],
        },
      },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  if (plan.ok)
    assert.deepEqual(
      plan.segments.map(({ domain }) => domain),
      ['xctest-native'],
    );
});

test('conditional React subflows preserve focus in both directions', async () => {
  const calls: string[] = [];
  const result = await replayFlow(
    [
      { t: 'tap', id: 'outer-field' },
      {
        t: 'runFlow',
        whenVisible: 'first-condition',
        commands: [{ t: 'type', text: 'from-outer' }],
      },
      {
        t: 'runFlow',
        whenVisible: 'second-condition',
        commands: [{ t: 'tap', id: 'inner-field' }],
      },
      { t: 'type', text: 'from-inner' },
    ],
    {
      press: async (id) => calls.push(`press:${id}`),
      type: async (id, text) => calls.push(`type:${id}:${text}`),
      visibility: async () => ({ visible: true }),
      launch: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(result.passed, true);
  assert.equal(result.finalFocusId, 'inner-field');
  assert.deepEqual(calls, [
    'press:outer-field',
    'type:outer-field:from-outer',
    'press:inner-field',
    'type:inner-field:from-inner',
  ]);
});

test('partitioned replay carries nested React focus across a native segment (refused, GH-1075)', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'nested-focus-across-native',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async (id) => calls.push(`press:${id}`),
      typeByTestId: async (id) => calls.push(`type:${id}`),
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({ stdout: nativeRunnerOutput(), stderr: '' }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: outer-field
- runFlow:
    when:
      visible:
        id: nested-form
    commands:
      - tapOn:
          id: inner-field
- assertVisible: Native status
- inputText: value
- assertVisible:
    id: finished
`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.match(env.error ?? '', /relaunches the app/);
  assert.deepEqual(calls, []);
});

test('a designation-only tap cannot be revived as static React focus after a native segment (refused, GH-1075)', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'designation-across-native',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async (id) => {
        calls.push(`press:${id}`);
        return { kind: 'designation', focusOnly: true, token: `designation-${id}` };
      },
      typeByTestId: async (id, text) => calls.push(`type:${id}:${text}`),
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      releaseInputDesignation: async () => {},
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({ stdout: nativeRunnerOutput(), stderr: '' }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: email
- inputText: first
- assertVisible: Native status
- inputText: second
`,
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.match(env.error ?? '', /relaunches the app/);
  assert.deepEqual(calls, []);
});

test('inputText follows a nested native tap instead of reviving stale React focus (refused, GH-1075)', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: { id: 'react-field' } },
      {
        runFlow: {
          when: { visible: 'Native form' },
          commands: [{ tapOn: 'Native field' }],
        },
      },
      { inputText: 'value' },
    ],
    {},
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.sourceIndex, 1);
  assert.match(plan.reason, /relaunches the app/);
});

test('inputText does not retain React authority after a native coordinate tap (refused, GH-1075)', () => {
  for (const nativeCommand of [
    { tap: { point: '50%,50%' } },
    { doubleTapOn: 'Native field' },
    { back: true },
    { swipe: { direction: 'LEFT' } },
  ]) {
    const plan = planIosProofDomains(
      [{ tapOn: { id: 'react-field' } }, nativeCommand, { inputText: 'value' }],
      {},
    );
    assert.equal(plan.ok, false);
    if (plan.ok) continue;
    assert.equal(plan.sourceIndex, 1);
    assert.match(plan.reason, /relaunches the app/);
  }
});

test('negative native assertions cannot prove blindness', () => {
  assert.deepEqual(
    nativeSelectorsForCommands([
      { assertNotVisible: 'Gone' },
      { extendedWaitUntil: { notVisible: { text: 'Also gone' }, timeout: 1000 } },
    ]),
    [],
  );
  assert.deepEqual(nativeSelectorsForCommands([{ assertVisible: { text: 'Present' } }]), [
    { kind: 'text', value: 'Present' },
  ]);
  assert.deepEqual(
    nativeSelectorsForCommands([{ assertVisible: { text: 'Present', index: 1 } }]),
    [],
  );
  assert.deepEqual(
    nativeSelectorsForCommands([
      { assertVisible: 'Present' },
      { assertVisible: { text: 'Present', index: 1 } },
    ]),
    [],
  );
  assert.deepEqual(soleComparableNativeSelectorForCommands([{ assertVisible: 'Present' }]), {
    kind: 'text',
    value: 'Present',
  });
  assert.equal(
    soleComparableNativeSelectorForCommands([
      { assertVisible: 'Present' },
      { assertVisible: { text: 'Hidden', index: 1 } },
    ]),
    null,
  );
  assert.equal(
    soleComparableNativeSelectorForCommands([
      { assertVisible: 'Present' },
      { assertVisible: { label: 'Hidden' } },
    ]),
    null,
  );
});

test('hidden or offscreen native nodes cannot prove blindness', () => {
  const selectors = [{ kind: 'text' as const, value: 'Present' }];
  assert.deepEqual(
    selectorsVisibleInNativeSnapshot(selectors, [
      { label: 'Present', hittable: false },
      { identifier: 'Present' },
    ]),
    [],
  );
  assert.deepEqual(
    selectorsVisibleInNativeSnapshot(selectors, [{ label: 'Present', hittable: true }]),
    selectors,
  );
});

test('controlled input appends and succeeds only after exact fiber read-back', async () => {
  let value = '04';
  const client = {
    evaluate: async (expression: string) => {
      if (expression.includes('__QAREN.interact')) {
        const options = JSON.parse(expression.slice(expression.indexOf('(') + 1, -1));
        const before = value;
        value = options.text;
        return {
          value: JSON.stringify({
            controlled: true,
            handlerCalled: 'onChangeText',
            text: value,
            valueBefore: before,
          }),
        };
      }
      return { value: JSON.stringify({ value, controlled: true }) };
    },
  };
  const env = envelope(await performReactTreeInput('otp', '5', client as never));
  assert.equal(env.ok, true);
  assert.equal(value, '045');
  assert.equal(env.data?.filled, true);
  assert.equal(JSON.stringify(env).includes('045'), false, 'result must not echo entered text');
});

test('uncontrolled or secure-masked-only input refuses without mutation', async () => {
  let interacted = false;
  const client = {
    evaluate: async (expression: string) => {
      if (expression.includes('__QAREN.interact')) interacted = true;
      return { value: JSON.stringify({ value: null, controlled: false }) };
    },
  };
  const env = envelope(await performReactTreeInput('password', 'secret', client as never));
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(interacted, false);
  assert.equal(JSON.stringify(env).includes('secret'), false);
});

function makeFrontmostSandbox(root: any, navState: Record<string, unknown>) {
  const sandbox: Record<string, any> = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Set,
    Error,
    Date,
    RegExp,
    Symbol,
    String,
    Number,
    Boolean,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    __expo_router_state__: navState,
  };
  sandbox.globalThis = sandbox;
  const roots = Array.isArray(root) ? root : [root];
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id: number) =>
      id === 1 ? new Set(roots.map((current) => ({ current }))) : new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

const viewportRect = { x: 0, y: 0, width: 390, height: 844 };

interface LayoutBoundsInstance {
  getBoundingClientRect(): Record<string, number>;
  ownerDocument?: { documentElement: LayoutBoundsInstance };
  parentElement?: LayoutBoundsInstance | null;
}

function layoutStateNode(
  rect: Record<string, number>,
  viewport = viewportRect,
  parentElement: LayoutBoundsInstance | null = null,
) {
  const documentElement: LayoutBoundsInstance = {
    getBoundingClientRect: () => viewport,
  };
  return {
    canonical: {
      publicInstance: {
        ownerDocument: { documentElement },
        parentElement,
        getBoundingClientRect: () => rect,
      },
    },
  };
}

interface SceneState {
  index: number;
  routes: { key: string; name: string }[];
}

function sceneProps(
  route: { key: string; name: string },
  state: SceneState,
  isFocused = () => state.routes[state.index]?.key === route.key,
) {
  const neverInvoke = () => assert.fail('scene callbacks and renderers must not be invoked');
  return {
    screen: { name: route.name, component: neverInvoke },
    route,
    getState: neverInvoke,
    setState: neverInvoke,
    clearOptions: neverInvoke,
    navigation: { getState: () => state, isFocused },
  };
}

function routeTree(
  testID: string,
  route: string,
  state: SceneState = { index: 0, routes: [{ key: `${route}-key`, name: route }] },
) {
  const root: any = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  const screen: any = {
    type: { displayName: 'Screen' },
    memoizedProps: sceneProps({ key: `${route}-key`, name: route }, state),
    return: root,
    child: null,
    sibling: null,
  };
  const target: any = {
    type: { displayName: 'View' },
    memoizedProps: { testID },
    stateNode: layoutStateNode({ x: 20, y: 80, width: 120, height: 44 }),
    return: screen,
    child: null,
    sibling: null,
  };
  root.child = screen;
  screen.child = target;
  return root;
}

test('mounted prior-route IDs are not frontmost', () => {
  const state = {
    index: 1,
    routes: [
      { key: 'login-key', name: 'login' },
      { key: 'home-key', name: 'home' },
    ],
  };
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'login', state), state);
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /inactive mounted route/);
});

test('current-route ID is frontmost', () => {
  const state = {
    index: 1,
    routes: [
      { key: 'login-key', name: 'login' },
      { key: 'home-key', name: 'home' },
    ],
  };
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'home', state), state);
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.activeRoute, 'home');
});

test('frontmost exact-ID oracle carries disabled state from the matched fiber', () => {
  const root = routeTree('save', 'home');
  root.child.child.memoizedProps.accessibilityState = { disabled: true };
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('save'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.disabled, true);
  assert.equal(verdict.matchCount, 1);
});

test('frontmost exact matches refuse incomplete renderer coverage', () => {
  const root = routeTree('coverage', 'home');
  const rootWithoutTarget = routeTree('other', 'home');
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const incompleteRegistry = {
    renderers: {
      keys: () => {
        throw new Error('renderer registry is incomplete');
      },
      forEach: () => {},
    },
    getFiberRoots: (id: number) => (id === 1 ? new Set([{ current: root }]) : new Set()),
  };
  const rendererError = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (id: number) => {
      if (id === 1) return new Set([{ current: root }]);
      if (id === 2) throw new Error('renderer teardown');
      return new Set();
    },
  };
  const unscannedRegistry = {
    renderers: {
      keys: () => new Map([[40, {}]]).keys(),
      forEach: (callback: (value: object, id: number) => void) => {
        callback({}, 1);
        callback({}, 30);
        callback({}, 40);
      },
    },
    getFiberRoots: (id: number) => {
      if (id === 1) return new Set([{ current: rootWithoutTarget }]);
      if (id === 30) return new Set([{ current: root }]);
      return new Set();
    },
  };
  const cases = [
    [
      incompleteRegistry,
      {
        reasons: ['renderer-error', 'root-enumeration-incomplete'],
        registeredRendererIds: null,
        unscannedRendererIds: [],
        erroredRendererIds: [],
        rendererErrors: 0,
        extraRootsError: false,
        scanFinished: false,
        scanErrors: [],
      },
    ],
    [
      rendererError,
      {
        reasons: ['renderer-error'],
        registeredRendererIds: [1, 2],
        unscannedRendererIds: [],
        erroredRendererIds: [2],
        rendererErrors: 1,
        extraRootsError: false,
        scanFinished: true,
        scanErrors: [{ rendererId: 2, phase: 'roots', message: 'renderer teardown' }],
      },
    ],
    [
      unscannedRegistry,
      {
        reasons: ['renderers-unscanned'],
        registeredRendererIds: [40, 1, 30],
        unscannedRendererIds: [30],
        erroredRendererIds: [],
        rendererErrors: 0,
        extraRootsError: false,
        scanFinished: true,
        scanErrors: [],
      },
    ],
  ] as const;
  for (const [hook, coverage] of cases) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
    assert.deepEqual(verdict, {
      visible: false,
      code: 'ASSERTION_FAILED',
      reason: 'frontmost proof cannot cover every mounted renderer',
      coverage,
    });
  }
});

test('a target owned by an active ancestor route remains frontmost', () => {
  const state = {
    index: 1,
    routes: [
      { key: 'login-key', name: 'login' },
      {
        key: 'home-key',
        name: 'home',
        state: {
          index: 0,
          routes: [
            { key: 'feed-key', name: 'feed' },
            { key: 'settings-key', name: 'settings' },
          ],
        },
      },
    ],
  };
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'home', state), state);
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.route, 'home');
  assert.equal(verdict.activeRoute, 'feed');
});

test('scene focus includes inactive parents even when names and the local selected key agree', async (t) => {
  for (const locallySelected of [true, false]) {
    await t.test(`local owner selected=${locallySelected}`, async () => {
      const route = { key: 'inactive-home', name: 'home' };
      const state = {
        index: locallySelected ? 0 : 1,
        routes: [route, { key: 'active-home', name: 'home' }],
      };
      const root = routeTree('coverage', 'home');
      root.child.memoizedProps = sceneProps(route, state, () => false);
      const sandbox = makeFrontmostSandbox(root, state);
      const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
      assert.equal(verdict.visible, false);
      assert.equal(verdict.route, 'home');
      assert.equal(verdict.activeRoute, 'home');
      assert.equal(verdict.matchCount, 1);
      let presses = 0;
      const replay = await runCdpReplayCommands(
        [{ tapOn: { id: 'coverage' } }],
        {},
        {
          treeFor: async () => ({}),
          frontmostFor: async () => verdict,
          pressByTestId: async () => {
            presses++;
          },
          typeByTestId: async () => {},
          launchApp: async () => {},
          settle: async () => {},
        },
      );
      assert.equal(replay.failureCode, 'ASSERTION_FAILED');
      assert.equal(replay.failedStepIndex, 0);
      assert.equal(presses, 0);
    });
  }
});

test('malformed nearer route scopes fail closed instead of borrowing an active ancestor', async (t) => {
  const cases: [string, (props: Record<string, any>) => void][] = [
    [
      'missing route key',
      (p) => {
        delete p.route.key;
      },
    ],
    [
      'empty route key',
      (p) => {
        p.route.key = '';
      },
    ],
    [
      'empty route name',
      (p) => {
        p.route.name = '';
      },
    ],
    [
      'missing navigation getState',
      (p) => {
        delete p.navigation.getState;
      },
    ],
    [
      'missing navigation isFocused',
      (p) => {
        delete p.navigation.isFocused;
      },
    ],
    [
      'throwing state',
      (p) => {
        p.navigation.getState = () => {
          throw new Error('unreadable');
        };
      },
    ],
    [
      'null state',
      (p) => {
        p.navigation.getState = () => null;
      },
    ],
    [
      'missing routes',
      (p) => {
        p.navigation.getState = () => ({ index: 0 });
      },
    ],
    [
      'empty routes',
      (p) => {
        p.navigation.getState = () => ({ index: 0, routes: [] });
      },
    ],
    [
      'missing owner membership',
      (p) => {
        p.navigation.getState = () => ({ index: 0, routes: [{ key: 'other', name: 'home' }] });
      },
    ],
    [
      'duplicate owner membership',
      (p) => {
        p.navigation.getState = () => ({ index: 0, routes: [p.route, p.route] });
      },
    ],
    [
      'membership name mismatch',
      (p) => {
        p.navigation.getState = () => ({ index: 0, routes: [{ key: p.route.key, name: 'other' }] });
      },
    ],
    ...[undefined, -1, 1, 0.5, NaN, '0'].map<[string, (p: Record<string, any>) => void]>(
      (index) => [
        `invalid index ${String(index)}`,
        (p) => {
          p.navigation.getState = () => ({ index, routes: [p.route] });
        },
      ],
    ),
    [
      'throwing focus',
      (p) => {
        p.navigation.isFocused = () => {
          throw new Error('unreadable');
        };
      },
    ],
    ...[undefined, null, 0, 1, 'true', {}, Promise.resolve(true)].map<
      [string, (p: Record<string, any>) => void]
    >((value, index) => [
      `nonboolean focus ${index}`,
      (p) => {
        p.navigation.isFocused = () => value;
      },
    ]),
    [
      'focus contradicts selected key',
      (p) => {
        p.navigation.getState = () => ({
          index: 1,
          routes: [p.route, { key: 'other', name: 'home' }],
        });
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const root = routeTree('coverage', 'home');
      const outer = root.child;
      const target = outer.child;
      const nearer = {
        type: { displayName: 'Minified' },
        memoizedProps: sceneProps(
          { key: 'home-key', name: 'home' },
          { index: 0, routes: [{ key: 'home-key', name: 'home' }] },
        ),
        return: outer,
        child: target,
        sibling: null,
      };
      outer.child = nearer;
      target.return = nearer;
      mutate(nearer.memoizedProps);
      const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'home' }] });
      const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
      assert.equal(verdict.visible, false);
      assert.equal(verdict.code, 'ASSERTION_FAILED');
      assert.equal(verdict.matchCount, 1);
      let presses = 0;
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'coverage' } }],
        {},
        {
          treeFor: async () => ({}),
          frontmostFor: async () => verdict,
          pressByTestId: async () => {
            presses++;
          },
          typeByTestId: async () => {},
          launchApp: async () => {},
          settle: async () => {},
        },
      );
      assert.equal(result.passed, false);
      assert.equal(result.failureCode, 'ASSERTION_FAILED');
      assert.equal(result.failedStepIndex, 0);
      assert.equal(presses, 0);
    });
  }
});

test('route ownership normalizes descriptor and paired-context shells without hiding readable content', async (t) => {
  for (const shell of ['direct', 'descriptor', 'scene descriptor', 'paired contexts']) {
    for (const selected of [0, 1]) {
      await t.test(`${shell}: selected ${selected}`, async () => {
        const home = { key: 'home-key', name: 'Home' };
        const state = { index: selected, routes: [home, { key: 'other-home', name: 'Home' }] };
        const root = routeTree('coverage', 'Home', state);
        const owner = root.child;
        const props = sceneProps(home, state);
        const descriptor = { route: home, navigation: props.navigation };
        if (shell === 'direct') owner.memoizedProps = props;
        if (shell === 'descriptor') owner.memoizedProps = { descriptor };
        if (shell === 'scene descriptor') owner.memoizedProps = { scene: { descriptor } };
        if (shell === 'paired contexts') {
          owner.tag = 10;
          owner.memoizedProps = { value: home, children: null };
          const target = owner.child;
          owner.child = {
            tag: 10,
            type: {},
            memoizedProps: { value: props.navigation, children: target },
            return: owner,
            child: target,
            sibling: null,
          };
          target.return = owner.child;
        }
        const sandbox = makeFrontmostSandbox(root, state);
        const tree = JSON.parse(sandbox.__QAREN.getTree({ filter: 'coverage' }));
        assert.ok(JSON.stringify(tree).includes('coverage'));
        const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
        assert.equal(verdict.visible, selected === 0);
        assert.equal(verdict.matchCount, 1);
        let presses = 0;
        const result = await runCdpReplayCommands(
          [{ tapOn: { id: 'coverage' } }],
          {},
          {
            treeFor: async () => tree,
            frontmostFor: async () => verdict,
            pressByTestId: async () => {
              presses++;
            },
            typeByTestId: async () => {},
            launchApp: async () => {},
            settle: async () => {},
          },
        );
        assert.equal(result.passed, selected === 0);
        assert.equal(presses, selected === 0 ? 1 : 0);
        if (selected === 1) {
          assert.equal(result.failureCode, 'ASSERTION_FAILED');
          assert.equal(result.failedStepIndex, 0);
        }
      });
    }
  }
});

test('an invalid present modern scope getter cannot borrow a valid legacy getter', () => {
  for (const getter of [
    null,
    undefined,
    0,
    () => {
      throw new Error('unreadable');
    },
  ]) {
    const root = routeTree('coverage', 'home');
    const navigation = root.child.memoizedProps.navigation;
    navigation.dangerouslyGetState = navigation.getState;
    navigation.getState = getter;
    const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'home' }] });
    const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
    assert.equal(verdict.visible, false);
    assert.equal(verdict.code, 'ASSERTION_FAILED');
    assert.equal(verdict.matchCount, 1);
  }
});

test('ownerless multi-route content cannot borrow ownership from ordinary route props', () => {
  const root = routeTree('coverage', 'home');
  root.child.memoizedProps = { screen: 'home', route: { key: 'home-key', name: 'home' } };
  const sandbox = makeFrontmostSandbox(root, {
    index: 1,
    routes: [{ name: 'login' }, { name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /no route owner/);
  assert.equal(verdict.route, undefined);
  assert.equal(verdict.activeRoute, 'home');
  assert.equal(verdict.matchCount, 1);
});

test('a per-screen header follows the route it renders, not the scene around it', async (t) => {
  const home = { key: 'home-key', name: 'home' };
  const detail = { key: 'detail-key', name: 'detail' };
  for (const covered of [true, false]) {
    await t.test(covered ? 'covered card' : 'top card', () => {
      const state = { index: covered ? 1 : 0, routes: [home, detail] };
      const root = routeTree('coverage', 'home', state);
      // @react-navigation/stack renders the card header outside SceneView with
      // the documented header props of the screen it belongs to.
      root.child.memoizedProps = {
        route: home,
        navigation: {
          getState: () => state,
          isFocused: () => state.routes[state.index]?.key === home.key,
        },
        options: {},
        layout: { width: 390, height: 844 },
      };
      const sandbox = makeFrontmostSandbox(root, {
        index: covered ? 1 : 0,
        routes: [{ name: 'home' }, { name: 'detail' }],
      });
      const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
      assert.equal(verdict.visible, !covered);
      assert.equal(verdict.route, 'home');
      if (covered) assert.match(verdict.reason, /inactive mounted route/);
    });
  }
});

test('cyclic and over-budget ancestry cannot establish absence of a scene owner', async (t) => {
  for (const cyclic of [true, false]) {
    await t.test(cyclic ? 'cycle' : 'budget', () => {
      const root = routeTree('coverage', 'home');
      root.child.memoizedProps = {};
      if (cyclic) root.child.return = root.child;
      else {
        let parent = root.child;
        for (let index = 0; index < 1001; index++) {
          parent.return = { memoizedProps: {}, return: null };
          parent = parent.return;
        }
      }
      const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'home' }] });
      const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
      assert.equal(verdict.visible, false);
      assert.equal(verdict.code, 'ASSERTION_FAILED');
      assert.equal(verdict.matchCount, 1);
    });
  }
});

test('filtered replay proves pointer events from the live fiber ancestor chain', async () => {
  for (const pointerEvents of ['none', 'box-only', 'box-none', 'auto']) {
    const root = routeTree('coverage', 'home');
    root.child.memoizedProps.pointerEvents = pointerEvents;
    const sandbox = makeFrontmostSandbox(root, {
      index: 0,
      routes: [{ name: 'home' }],
    });
    const mutations: string[] = [];
    const deps = {
      pressByTestId: async () => mutations.push('press'),
      typeByTestId: async () => mutations.push('type'),
      treeFor: async (id: string) => JSON.parse(sandbox.__QAREN.getTree({ filter: id })),
      frontmostFor: async (id: string) => JSON.parse(sandbox.__QAREN.isTestIdFrontmost(id)),
      launchApp: async () => {},
      settle: async () => {},
    };
    const press = await runCdpReplayCommands([{ tapOn: { id: 'coverage' } }], {}, deps);
    const input = await runCdpReplayCommands([{ inputText: 'value' }], {}, deps, {
      initialFocusId: 'coverage',
    });
    if (pointerEvents === 'none' || pointerEvents === 'box-only') {
      assert.equal(press.passed, false);
      assert.equal(input.passed, false);
      assert.equal(press.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.equal(input.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.deepEqual(mutations, []);
    } else {
      assert.equal(press.passed, true);
      assert.equal(input.passed, true);
      assert.deepEqual(mutations, ['press', 'type']);
    }
  }
});

test('filtered replay enforces target pointer-event semantics before mutation', async () => {
  for (const pointerEvents of ['none', 'box-none', 'auto', 'box-only']) {
    const root = routeTree('coverage', 'home');
    root.child.child.memoizedProps.pointerEvents = pointerEvents;
    const sandbox = makeFrontmostSandbox(root, {
      index: 0,
      routes: [{ name: 'home' }],
    });
    const mutations: string[] = [];
    const deps = {
      pressByTestId: async () => mutations.push('press'),
      typeByTestId: async () => mutations.push('type'),
      treeFor: async (id: string) => JSON.parse(sandbox.__QAREN.getTree({ filter: id })),
      frontmostFor: async (id: string) => JSON.parse(sandbox.__QAREN.isTestIdFrontmost(id)),
      launchApp: async () => {},
      settle: async () => {},
    };
    const press = await runCdpReplayCommands([{ tapOn: { id: 'coverage' } }], {}, deps);
    const input = await runCdpReplayCommands([{ inputText: 'value' }], {}, deps, {
      initialFocusId: 'coverage',
    });
    if (pointerEvents === 'none' || pointerEvents === 'box-none') {
      assert.equal(press.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.equal(input.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.deepEqual(mutations, []);
    } else {
      assert.equal(press.passed, true);
      assert.equal(input.passed, true);
      assert.deepEqual(mutations, ['press', 'type']);
    }
  }
});

test('unavailable navigation proof is typed and does not skip runFlow commands', async () => {
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'home'), {
    error: 'No navigation state',
  });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');

  let nestedPresses = 0;
  const replay = await replayFlow(
    [
      {
        t: 'runFlow',
        whenVisible: 'coverage',
        commands: [{ t: 'tap', id: 'nested-action' }],
      },
    ],
    {
      press: async () => {
        nestedPresses++;
      },
      type: async () => {},
      visibility: async () => verdict,
      launch: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'ASSERTION_FAILED');
  assert.equal(nestedPresses, 0);
});

test('an inactive mounted modal does not mask the current route', () => {
  const root = routeTree('coverage', 'home');
  root.child.sibling = {
    type: { displayName: 'Modal' },
    memoizedProps: { visible: false },
    return: root,
    child: null,
    sibling: null,
  };
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.modalCount, 0);
});

test('stacked visible modal roots fail closed when ordering is unavailable', () => {
  const backgroundModal: any = {
    type: { displayName: 'Modal' },
    memoizedProps: { visible: true },
    return: null,
    child: null,
    sibling: null,
  };
  const target: any = {
    type: { displayName: 'View' },
    memoizedProps: { testID: 'covered-action' },
    return: backgroundModal,
    child: null,
    sibling: null,
  };
  backgroundModal.child = target;
  const foregroundModal = {
    type: { displayName: 'Modal' },
    memoizedProps: { visible: true },
    return: null,
    child: null,
    sibling: null,
  };
  const sandbox = makeFrontmostSandbox([backgroundModal, foregroundModal], {
    index: 0,
    routes: [{ name: 'home' }],
  });

  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('covered-action'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.modalCount, 2);
});

// React double-buffers fibers: after a commit, a child collected from the
// current tree can carry a .return pointing at an ancestor's alternate.
function modalAlternateSubtree(root: any, testID: string) {
  const modalHost: any = {
    type: { displayName: 'RCTModalHostView' },
    memoizedProps: { visible: true },
    return: root,
    child: null,
    sibling: null,
  };
  const modalHostAlternate: any = {
    type: { displayName: 'RCTModalHostView' },
    memoizedProps: { visible: true },
    return: root,
    child: null,
    sibling: null,
  };
  modalHost.alternate = modalHostAlternate;
  modalHostAlternate.alternate = modalHost;
  modalHost.child = {
    type: { displayName: 'View' },
    memoizedProps: { testID },
    return: modalHostAlternate,
    child: null,
    sibling: null,
  };
  return modalHost;
}

function modalAlternateTree(testID: string) {
  const root: any = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  root.child = modalAlternateSubtree(root, testID);
  return root;
}

test('a modal-hosted target reached through the host fiber alternate is frontmost', () => {
  const root = modalAlternateTree('otp_email-pressable');
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'Home' }] });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('otp_email-pressable'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.modalCount, 1);
  assert.equal(verdict.matchCount, 1);
});

test('a target genuinely behind the active modal stays refused when the host has an alternate', () => {
  const root = modalAlternateTree('otp_email-pressable');
  root.child.sibling = {
    type: { displayName: 'View' },
    memoizedProps: { testID: 'behind_the_modal' },
    return: root,
    child: null,
    sibling: null,
  };
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'Home' }] });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('behind_the_modal'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /behind the active modal/);
  assert.equal(verdict.matchCount, 1);
});

test('an ordinary non-modal target is unaffected by ancestor alternates', () => {
  const root = routeTree('coverage', 'home');
  const screen = root.child;
  const screenAlternate: any = {
    type: { displayName: 'Screen' },
    memoizedProps: screen.memoizedProps,
    return: root,
    child: null,
    sibling: null,
  };
  screen.alternate = screenAlternate;
  screenAlternate.alternate = screen;
  screen.child.return = screenAlternate;
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'home' }] });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.matchCount, 1);
});

test('duplicate IDs in separate subtrees stay ambiguous when ancestors have alternates', () => {
  const root = modalAlternateTree('otp_email-pressable');
  const duplicate: any = {
    type: { displayName: 'View' },
    memoizedProps: { testID: 'otp_email-pressable' },
    return: root,
    child: null,
    sibling: null,
  };
  root.child.sibling = duplicate;
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'Home' }] });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('otp_email-pressable'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /ambiguous across mounted React trees/);
  assert.equal(verdict.matchCount, 2);
});

test('a delayed modal-hosted target becomes frontmost through the timed wait', async () => {
  const root: any = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  const home: any = {
    type: { displayName: 'View' },
    memoizedProps: { testID: 'open_otp' },
    return: root,
    child: null,
    sibling: null,
  };
  root.child = home;
  const modalHost = modalAlternateSubtree(root, 'otp_email-pressable');
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'Home' }] });
  let polls = 0;
  const absentVerdicts: string[] = [];
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp_email-pressable' }, timeout: 2000 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id: string) => JSON.parse(sandbox.__QAREN.getTree({ filter: id })),
      frontmostFor: async (id: string) => {
        polls++;
        if (polls === 3) home.sibling = modalHost;
        const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost(id));
        if (!verdict.visible) absentVerdicts.push(verdict.reason);
        return verdict;
      },
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, true);
  assert.ok(polls >= 3, `expected the wait to poll through absence, saw ${polls} polls`);
  assert.deepEqual([...new Set(absentVerdicts)], ['testID is not mounted']);
});

test('a matching route returned after the replay deadline cannot report success', async () => {
  let clock = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    getLiveRoute: async () => {
      clock = 101;
      return 'home';
    },
    now: () => clock,
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: home\n`,
      actionMetadata: {
        id: 'route-deadline-proof',
        enginePin: 'maestro-runner@1.1.28',
        tags: [],
        expectedRouteSequence: ['home'],
      },
      ...callbacks,
    }),
  );

  assert.equal(env.code, 'RUNNER_TIMEOUT');
  assert.equal(env.meta?.expectedRoute, 'home');
  assert.equal(env.meta?.liveRoute, 'home');
});

test('propagated testIDs on one fiber lineage remain one logical match', () => {
  const root = routeTree('coverage', 'home');
  const propagated = {
    type: { displayName: 'HostView' },
    memoizedProps: { testID: 'coverage' },
    stateNode: layoutStateNode({ x: 20, y: 80, width: 120, height: 44 }),
    return: root.child.child,
    child: null,
    sibling: null,
  };
  root.child.child.child = propagated;
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
});

test('frontmost scan-budget exhaustion is a typed proof failure', () => {
  const root: any = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  let cursor = root;
  for (let index = 0; index < 40_001; index++) {
    const fiber = {
      type: { displayName: 'View' },
      memoizedProps: {},
      return: root,
      child: null,
      sibling: null,
    };
    cursor.sibling = fiber;
    cursor = fiber;
  }
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'home' }] });
  const verdict = JSON.parse(sandbox.__QAREN.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.truncated, true);
});

const IOS_UDID = 'B5E71CBD-D1F7-46C6-944C-28FF15F773B4';

function nativeDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

function nativeRunnerOutput(extra = '') {
  return [
    'Single device execution mode',
    `Using specified iOS device: ${IOS_UDID}`,
    `Building WDA for device ${IOS_UDID} (team ID: )`,
    `Starting WDA on device ${IOS_UDID} (port: 8447)`,
    extra,
  ].join('\n');
}

function nativeHandler(
  visible: boolean | (() => boolean),
  runnerFails: boolean,
  failureOutput = "Element with text 'Open in' not found",
  options: {
    beforeFailure?: () => void;
    failureCode?: string | number;
    stopFastRunner?: () => Promise<void>;
  } = {},
) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-blind-environment',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    stopFastRunner: options.stopFastRunner ?? (async () => {}),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => ({
      source: 'rn-fast-runner-snapshot',
      nodeCount: 42,
      visibleSelectors: (typeof visible === 'function' ? visible() : visible) ? selectors : [],
      runtimeMajor: 26,
    }),
    execFile: async () => {
      if (!runnerFails) return { stdout: nativeRunnerOutput(), stderr: '' };
      options.beforeFailure?.();
      throw Object.assign(new Error('native selector failed'), {
        code: options.failureCode ?? 1,
        stdout: nativeRunnerOutput(failureOutput),
        stderr: '',
      });
    },
  });
}

test('a partitioned saved flow resumes at an omitted-timeout wait without replaying its native prefix', async () => {
  let nativeRuns = 0;
  let treeReads = 0;
  const mutations: string[] = [];
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partitioned-otp-resume',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async (id) => mutations.push(id),
      typeByTestId: async () => {},
      treeFor: async (id) => {
        treeReads += 1;
        return treeReads >= 3 ? { testID: id } : null;
      },
      frontmostFor: async () =>
        treeReads >= 3
          ? { visible: true, matchCount: 1 }
          : { visible: false, matchCount: 0, reason: 'testID is not mounted' },
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      nativeRuns += 1;
      return {
        stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
        stderr: '',
      };
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- assertVisible: Native prefix
- extendedWaitUntil:
    visible:
      id: otp_email-pressable
- tapOn:
    id: otp_email-pressable
`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.equal(env.data?.proofDomain, 'partitioned');
  assert.equal(nativeRuns, 1);
  assert.deepEqual(mutations, ['otp_email-pressable']);
  assert.deepEqual(
    env.data?.steps.map((step: { index: number; verb: string; status: string }) => [
      step.index,
      step.verb,
      step.status,
    ]),
    [
      [0, 'assertVisible', 'pass'],
      [1, 'waitVisible', 'pass'],
      [2, 'tap', 'pass'],
    ],
  );
});

test('native-only blindness requires a WDA miss and same-screen native visibility', async () => {
  let comparisonRunnerStopped = false;
  const env = envelope(
    await nativeHandler(true, true, undefined, {
      stopFastRunner: async () => {
        comparisonRunnerStopped = true;
      },
    })({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Open in\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.nativeVision.source, 'rn-fast-runner-snapshot');
  assert.equal(env.meta?.nativeVision.visibleSelectorCount, 1);
  assert.equal(env.meta?.nativeVision.failedSelectorKind, 'text');
  assert.equal(env.meta?.nativeVision.runtimeVersionHeuristicIsProof, false);
  assert.equal(env.meta?.cleanup.cleanupProven, true);
  assert.equal(env.meta?.cleanup.wdaProcessSettled, true);
  assert.equal(comparisonRunnerStopped, true);
  assert.equal(JSON.stringify(env).includes('Open in'), false, 'selector text stays sanitized');
});

test('one failed native assertion can use its sole failure-screen selector without echoing it', async () => {
  const handler = nativeHandler(true, true, '    ✗ assertVisible (0.1s)');
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Modal control\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(JSON.stringify(env).includes('Modal control'), false);
});

test('a selector visible only before navigation cannot prove native blindness', async () => {
  let visible = true;
  const env = envelope(
    await nativeHandler(() => visible, true, "Element with text 'Initial control' not found", {
      beforeFailure: () => {
        visible = false;
      },
    })({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- tapOn: Next\n- assertVisible: Initial control\n`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('failure-screen comparison cleanup uncertainty overrides native blindness', async () => {
  const env = envelope(
    await nativeHandler(true, true, undefined, {
      stopFastRunner: async () => {
        throw new Error('cleanup unavailable');
      },
    })({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Open in\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.equal(env.meta?.cleanup.cleanupProven, false);
});

test('ordinary native selector miss is not called blind', async () => {
  const env = envelope(
    await nativeHandler(
      false,
      true,
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Open in\n`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('a constrained native selector miss is not reduced to a blind text comparison', async () => {
  const env = envelope(
    await nativeHandler(
      true,
      true,
      "Element with text 'Repeated' not found",
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- assertVisible:
    text: Repeated
    index: 1
`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('a selector-less constrained failure cannot borrow another visible selector', async () => {
  const env = envelope(
    await nativeHandler(
      true,
      true,
      '    ✗ assertVisible (0.1s)',
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- assertVisible: Visible
- assertVisible:
    text: Hidden
    index: 1
`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('a timed-out selector failure cannot become native blindness', async () => {
  let comparisonProbes = 0;
  const env = envelope(
    await nativeHandler(
      () => {
        comparisonProbes += 1;
        return true;
      },
      true,
      "Element with text 'Visible' not found",
      { failureCode: 'ETIMEDOUT' },
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(comparisonProbes, 0);
});

test('a Maestro-internal selector timeout cannot become native blindness', async () => {
  let comparisonProbes = 0;
  const env = envelope(
    await nativeHandler(
      () => {
        comparisonProbes += 1;
        return true;
      },
      true,
      "Timed out waiting for element 'Visible'",
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(comparisonProbes, 0);
});

test('a deadline reached during the failure-screen probe cannot become native blindness', async () => {
  let clock = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-probe-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    stopFastRunner: async () => {},
    now: () => clock,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => {
      clock = 101;
      return {
        source: 'rn-fast-runner-snapshot',
        nodeCount: 42,
        visibleSelectors: selectors,
        runtimeMajor: 26,
      };
    },
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput("Element with text 'Visible' not found"),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(env.meta?.terminal.exitClass, 'timed-out');
});

test('a deadline reached during failure-screen cleanup cannot become native blindness', async () => {
  let clock = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-cleanup-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    stopFastRunner: async () => {},
    now: () => clock,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => ({
      source: 'rn-fast-runner-snapshot',
      nodeCount: 42,
      visibleSelectors: selectors,
      runtimeMajor: 26,
    }),
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput("Element with text 'Visible' not found"),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
      completeRunnerPark: async () => {
        clock = 101;
      },
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(env.meta?.terminal.exitClass, 'timed-out');
});

test('a deadline reached during runner resume skips the failure-screen probe', async () => {
  let clock = 0;
  let comparisonProbes = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'runner-resume-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    fastHealthCheck: async () => {
      clock = 101;
      return true;
    },
    now: () => clock,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => {
      comparisonProbes += 1;
      return {
        source: 'rn-fast-runner-snapshot',
        nodeCount: 42,
        visibleSelectors: selectors,
        runtimeMajor: 26,
      };
    },
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput("Element with text 'Visible' not found"),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(env.meta?.terminal.exitClass, 'timed-out');
  assert.equal(comparisonProbes, 0);
});

test('WDA-visible native smoke still passes in the XCTest domain', async () => {
  const env = envelope(
    await nativeHandler(
      true,
      false,
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Increment\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.equal(env.data?.proofDomain, 'xctest-native');
});

test('a deadline-triggered runner abort remains a timeout', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async (_file, _args, options) =>
      new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('runner aborted'), { code: 'ABORT_ERR' }));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      }),
  });

  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 30,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.meta?.timedOut, true);
  assert.match(env.error ?? '', /timed out/);
});

test('partitioned native trace indices map back to original commands (refused, GH-1075)', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-index',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: react-status\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.match(env.error ?? '', /Refusing iOS proof-domain ambiguity at step 1/);
  assert.match(env.error ?? '', /relaunches the app/);
});

test('partitioned route failures retain native and React proof evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-route-failure',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    getLiveRoute: async () => 'unexpected-route',
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n- assertVisible:\n    id: react-status\n`,
      actionMetadata: {
        id: 'partition-route-proof',
        enginePin: 'maestro-runner@1.1.28',
        tags: [],
        expectedRouteSequence: ['expected-route'],
      },
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(env.meta?.proofDomains, ['xctest-native', 'react-tree']);
  assert.equal(env.meta?.runner, 'partitioned');
  assert.equal(env.meta?.transport, 'partitioned');
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number }) => step.index),
    [0, 1],
  );
});

test('partitioned native failures map evidence back to original commands (refused, GH-1075)', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-failure-index',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput('    ✗ assertVisible (0.1s)'),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: react-status\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.match(env.error ?? '', /Refusing iOS proof-domain ambiguity at step 1/);
  assert.match(env.error ?? '', /relaunches the app/);
});

test('partitioned React failures retain prior native proof evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-react-failure',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => null,
      frontmostFor: async () => ({ visible: false, matchCount: 0 }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n- extendedWaitUntil:\n    visible:\n      id: missing-react-status\n    timeout: 250\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(env.meta?.proofDomains, ['xctest-native', 'react-tree']);
  assert.equal(env.meta?.failedProofDomain, 'react-tree');
  assert.equal(env.meta?.runner, 'partitioned');
  assert.equal(env.meta?.transport, 'partitioned');
  assert.equal(env.meta?.failedStepIndex, 1);
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number; status: string }) => [step.index, step.status]),
    [
      [0, 'pass'],
      [1, 'fail'],
    ],
  );
});

test('partitioned React setup failures retain prior native proof evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-react-setup-failure',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n- assertVisible:\n    id: react-status\n`,
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.code, 'CDP_NOT_CONNECTED');
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(env.meta?.proofDomains, ['xctest-native', 'react-tree']);
  assert.equal(env.meta?.failedProofDomain, 'react-tree');
  assert.equal(env.meta?.runner, 'partitioned');
  assert.equal(env.meta?.transport, 'partitioned');
  assert.equal(env.meta?.failedStepIndex, 1);
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number; status: string }) => [step.index, step.status]),
    [[0, 'pass']],
  );
});

test('partitioned warning failures retain native data evidence (refused, GH-1075)', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-native-warning',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✗ assertVisible (0.1s)\nTest FAILED'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: react-status\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'UNSUPPORTED_STEP');
  assert.match(env.error ?? '', /Refusing iOS proof-domain ambiguity at step 1/);
  assert.match(env.error ?? '', /relaunches the app/);
});

test('native origin is claimed before runner parking and completed after resume', async () => {
  const events: string[] = [];
  const handler = createMaestroRunHandler({
    replayDeps: () => null,
    getActiveSession: () => ({
      name: 'native-order',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => {
      events.push('park');
      try {
        return await run();
      } finally {
        events.push('resume');
      }
    },
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      events.push('execute');
      return { stdout: nativeRunnerOutput(), stderr: '' };
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Increment\n`,
      claimNativeOrigin: async () => events.push('claim'),
      completeNativeOrigin: async (targetExpected) => events.push(`complete:${targetExpected}`),
      relaunchManagedApp: async () => {},
      reproveManagedOrigin: async () => events.push('reprove'),
      completeRunnerPark: async () => {},
    }),
  );
  assert.equal(env.ok, true);
  assert.deepEqual(events, ['claim', 'park', 'execute', 'resume', 'reprove', 'complete:true']);
});

test('parking forwards the replay deadline signal', async () => {
  const controller = new AbortController();
  controller.abort(new Error('deadline'));
  const seen: AbortSignal[] = [];
  await runFlowParked(async () => 'done', {
    platform: 'ios',
    signal: controller.signal,
    stopFastRunner: async (_deviceId, signal) => seen.push(signal!),
    completeRunnerPark: async (signal) => seen.push(signal!),
    markCdpStale: () => {},
  });
  assert.deepEqual(seen, [controller.signal, controller.signal]);
});

test('an expired deadline skips grace and still settles runner cleanup', async () => {
  const controller = new AbortController();
  controller.abort(new Error('deadline'));
  const signals: string[] = [];
  let probes = 0;
  let killSettled = false;
  let cleared = false;
  await reapStaleFastRunner({
    signal: controller.signal,
    getState: () => ({
      pid: 123,
      port: 456,
      deviceId: IOS_UDID,
      processBirth: 'birth',
      instanceId: 'instance',
    }),
    probeProcessBirth: () => {
      probes += 1;
      return probes < 3 || !killSettled
        ? { status: 'present', birth: { pid: 123, token: 'birth' } }
        : { status: 'absent' };
    },
    sendSignal: (_pid, signal) => signals.push(signal),
    sleep: async (ms) => {
      if (ms === 50) killSettled = true;
      else await new Promise<void>(() => {});
    },
    clearState: () => {
      cleared = true;
    },
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(cleared, true);
});
