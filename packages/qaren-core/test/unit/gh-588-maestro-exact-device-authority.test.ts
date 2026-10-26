import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createMaestroRunHandler,
  executeMaestroAuthorityStages,
  planMaestroAuthorityStages,
  resolveMaestroFlowAppId,
} from '../../dist/handlers/maestro-run.js';
import { chooseMaestroDispatch } from '../../dist/handlers/maestro-dispatch.js';
import {
  shouldRejectMaestroDeviceAuthority,
  verifyMaestroDeviceAuthority,
} from '../../dist/domain/maestro-device-authority.js';
import { createRunActionHandler } from '../../dist/handlers/run-action.js';
import { createTmpProject, fixtureYaml } from '../helpers/tmp-project.js';
import {
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  buildReplayEngineStatus,
  MAESTRO_RUNNER_PIN,
} from '../../dist/domain/engine-pin.js';

beforeEach(() =>
  _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)),
);
afterEach(() => _resetEngineStatusForTest());

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
const FOREIGN = 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3';
const APP_ID = 'com.rndevagent.testapp';

function runnerLog(found: string, wda = found): string {
  return [
    'Single device execution mode',
    `Using specified iOS device: ${found}`,
    `Building WDA for device ${wda} (team ID: )`,
    `Starting WDA on device ${wda} (port: 8447)`,
    'Flow execution completed: 1 passed, 0 failed, 0 skipped',
  ].join('\n');
}

function fakeRunnerDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

test('lifecycle stages re-prove origin before subsequent UI mutation', async () => {
  const calls: string[] = [];
  await executeMaestroAuthorityStages(
    ['launchApp', { tapOn: { id: 'submit' } }, 'stopApp'],
    async (commands) => {
      const first = commands[0];
      calls.push(
        `execute:${typeof first === 'string' ? first : String(Object.keys(first as object)[0])}`,
      );
    },
    async () => {
      calls.push('claim');
    },
    async (targetExpected) => {
      calls.push(`complete:${targetExpected}`);
    },
    async () => {
      calls.push('relaunch:managed');
    },
  );

  assert.deepEqual(calls, [
    'execute:launchApp',
    'relaunch:managed',
    'claim',
    'execute:tapOn',
    'execute:stopApp',
    'complete:false',
  ]);
  assert.throws(
    () =>
      planMaestroAuthorityStages([
        { runFlow: { commands: ['launchApp', { tapOn: { id: 'submit' } }] } },
      ]),
    /cannot contain app lifecycle transitions/,
  );
  assert.throws(
    () =>
      planMaestroAuthorityStages([
        { runFlow: { when: { visible: 'Continue' }, commands: ['launchApp'] } },
      ]),
    /cannot contain app lifecycle transitions/,
  );
});

test('failed lifecycle stages invalidate target authority before propagating failure', async () => {
  const calls: string[] = [];
  await assert.rejects(
    executeMaestroAuthorityStages(
      ['launchApp'],
      async () => {
        calls.push('execute');
        throw new Error('runner failed');
      },
      async () => {
        calls.push('claim');
      },
      async (targetExpected) => {
        calls.push(`complete:${targetExpected}`);
      },
      async () => {
        calls.push('relaunch');
      },
    ),
    /runner failed/,
  );

  assert.deepEqual(calls, ['execute', 'complete:false']);
});

test('failed grouped UI stages invalidate target authority after partial dispatch', async () => {
  const calls: string[] = [];
  await assert.rejects(
    executeMaestroAuthorityStages(
      [{ tapOn: { id: 'link' } }, { openLink: 'example://next' }],
      async () => {
        calls.push('execute');
        throw new Error('later command failed');
      },
      async () => {
        calls.push('claim');
      },
      async (targetExpected) => {
        calls.push(`complete:${targetExpected}`);
      },
      async () => {
        calls.push('relaunch');
      },
    ),
    /later command failed/,
  );

  assert.deepEqual(calls, ['claim', 'execute', 'complete:false']);
});

test('later stage failures retain earlier device-authority evidence', async () => {
  let stage = 0;
  let flowFile = '';
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => undefined,
    completeNativeOrigin: async () => undefined,
    execFile: async (_file, args) => {
      flowFile = args.find((argument) => argument.endsWith('.yaml')) ?? '';
      stage += 1;
      if (stage === 1) return { stdout: runnerLog(FOREIGN), stderr: '' };
      throw new Error('second stage failed before producing output');
    },
  });

  const result = await handler({
    inlineYaml: `appId: ${APP_ID}\n---\n- launchApp\n- tapOn: Continue`,
    platform: 'ios',
    deviceId: EXACT,
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.match(envelope.meta.output, new RegExp(FOREIGN));
  const restoredFlow = readFileSync(flowFile, 'utf8');
  assert.match(restoredFlow, /- launchApp/);
  assert.match(restoredFlow, /tapOn: Continue/);
});

test('staged execution shares one flow timeout budget', async () => {
  const timeouts: number[] = [];
  let now = 1_000;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => undefined,
    completeNativeOrigin: async () => undefined,
    relaunchManagedApp: async () => undefined,
    now: () => now,
    execFile: async (_file, _args, options) => {
      timeouts.push(options.timeout);
      now += 250;
      return { stdout: runnerLog(EXACT), stderr: '' };
    },
  });

  await handler({
    inlineYaml: `appId: ${APP_ID}\n---\n- launchApp\n- tapOn: Continue`,
    platform: 'ios',
    deviceId: EXACT,
    timeoutMs: 1_000,
  });

  assert.deepEqual(timeouts, [1_000, 750]);
});

test('flow headers cannot override the authority-bound app', async () => {
  assert.equal(resolveMaestroFlowAppId(APP_ID, APP_ID), APP_ID);
  assert.throws(
    () => resolveMaestroFlowAppId(APP_ID, 'com.foreign.app'),
    /does not match authority-bound appId/,
  );

  let dispatched = false;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    execFile: async () => {
      dispatched = true;
      return { stdout: runnerLog(EXACT), stderr: '' };
    },
  });
  const result = await handler({
    inlineYaml: 'appId: com.foreign.app\n---\n- launchApp',
    platform: 'ios',
    appId: APP_ID,
  });

  assert.equal(result.isError, true);
  assert.match(envelope(result).error, /does not match authority-bound appId/);
  assert.equal(dispatched, false);
});

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

test('exact active UDID is forwarded to maestro-runner before the flow', () => {
  const runner = fakeRunnerDispatch();
  assert.deepEqual(runner.buildArgs('ios', '/tmp/flow.yaml', undefined, EXACT), [
    '--platform',
    'ios',
    '--device',
    EXACT,
    'test',
    '/tmp/flow.yaml',
  ]);
});

test('actual pinned-device log verifies exact runner and WDA identity, not requested metadata', () => {
  const exact = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(EXACT),
    requireWdaProvenance: true,
  });
  assert.equal(exact.verified, true);
  assert.equal(exact.reportedDeviceId, EXACT);
  assert.equal(exact.reason, 'exact-runner-and-wda-match');

  const autoDetected = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(EXACT).replace('Using specified iOS device:', 'Found iOS device:'),
    requireWdaProvenance: true,
  });
  assert.equal(autoDetected.verified, true);
  assert.equal(autoDetected.reportedDeviceId, EXACT);

  const wrongRunner = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(FOREIGN),
    requireWdaProvenance: true,
  });
  assert.equal(wrongRunner.verified, false);
  assert.equal(wrongRunner.reportedDeviceId, FOREIGN);
  assert.equal(wrongRunner.reason, 'reported-device-mismatch');

  const wrongWda = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(EXACT, FOREIGN),
    requireWdaProvenance: true,
  });
  assert.equal(wrongWda.verified, false);
  assert.equal(wrongWda.reason, 'wda-device-mismatch');
});

test('structured report identity fills the direct receipt only when exact and unambiguous', () => {
  const exact = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: [
      `Building WDA for device ${EXACT} (team ID: )`,
      `Starting WDA on device ${EXACT} (port: 8447)`,
    ].join('\n'),
    directReportDeviceIds: [EXACT],
    requireWdaProvenance: true,
  });
  assert.equal(exact.verified, true);
  assert.equal(exact.reportedDeviceId, EXACT);
  assert.deepEqual(exact.observedDeviceIds, [EXACT]);

  const ambiguous = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(EXACT),
    directReportDeviceIds: [EXACT, FOREIGN],
    requireWdaProvenance: true,
  });
  assert.equal(ambiguous.verified, false);
  assert.equal(ambiguous.reportedDeviceId, null);
  assert.equal(ambiguous.reason, 'reported-device-ambiguous');
  assert.deepEqual(new Set(ambiguous.observedDeviceIds), new Set([EXACT, FOREIGN]));

  const missing = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: `Starting WDA on device ${EXACT} (port: 8447)`,
    directReportDeviceIds: [],
    requireWdaProvenance: true,
  });
  assert.equal(missing.verified, false);
  assert.equal(missing.reportedDeviceId, null);
  assert.equal(missing.reason, 'reported-device-missing');
});

test('real maestro_run path forwards active UDID and accepts only matching direct evidence', async () => {
  let argv: string[] = [];
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    execFile: async (_file, args) => {
      argv = args;
      return { stdout: runnerLog(EXACT), stderr: '' };
    },
  });

  const result = await handler({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
  });
  const body = envelope(result);
  assert.equal(body.ok, true, result.content[0].text);
  assert.deepEqual(argv.slice(0, 5), ['--platform', 'ios', '--device', EXACT, 'test']);
  assert.equal(body.data.deviceAuthority.verified, true);
  assert.equal(body.data.deviceAuthority.reportedDeviceId, EXACT);
});

test('an explicit deviceId matching the session in a different case is not a mismatch', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    execFile: async () => ({ stdout: runnerLog(EXACT), stderr: '' }),
  });
  const result = await handler({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
    deviceId: EXACT.toLowerCase(),
  });
  const body = envelope(result);
  assert.equal(body.ok, true, result.content[0].text);
  assert.equal(body.data.deviceAuthority.verified, true);

  const foreign = await handler({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
    deviceId: FOREIGN,
  });
  assert.equal(envelope(foreign).code, 'TARGET_SESSION_MISMATCH');
});

test('real maestro_run path rejects exit-zero wrong-device/shared-WDA evidence', async () => {
  for (const [output, reason] of [
    [runnerLog(FOREIGN), 'reported-device-mismatch'],
    [runnerLog(EXACT, FOREIGN), 'wda-device-mismatch'],
    ['Flow execution completed: 1 passed, 0 failed, 0 skipped', 'reported-device-missing'],
  ] as const) {
    const handler = createMaestroRunHandler({
      getActiveSession: () => ({
        name: 'exact',
        platform: 'ios',
        deviceId: EXACT,
        appId: APP_ID,
        openedAt: new Date(0).toISOString(),
      }),
      chooseDispatch: () => fakeRunnerDispatch(),
      parkFlow: async (run) => run(),
      claimNativeOrigin: async () => {},
      completeNativeOrigin: async () => {},
      execFile: async () => ({ stdout: output, stderr: '' }),
    });
    const result = await handler({
      inlineYaml: '- launchApp',
      platform: 'ios',
      appId: APP_ID,
    });
    const body = envelope(result);
    assert.equal(result.isError, true);
    assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
    assert.equal(body.meta.deviceAuthority.reason, reason);
  }
});

test('real maestro_run non-zero path preserves and rejects direct foreign-device evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    execFile: async () => {
      throw Object.assign(new Error('runner exited 1'), {
        stdout: runnerLog(FOREIGN),
        stderr: 'Failed to create session for app',
        code: 1,
      });
    },
  });
  const result = await handler({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
  });
  const body = envelope(result);
  assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(body.meta.deviceAuthority.reportedDeviceId, FOREIGN);
  assert.equal(body.meta.deviceAuthority.reason, 'reported-device-mismatch');
});

let project: ReturnType<typeof createTmpProject>;
beforeEach(() => {
  project = createTmpProject();
});
afterEach(() => project.cleanup());

test('cdp_run_action persists a verified direct report identity on success', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  const authority = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: [
      `Building WDA for device ${EXACT} (team ID: )`,
      `Starting WDA on device ${EXACT} (port: 8447)`,
    ].join('\n'),
    directReportDeviceIds: [EXACT],
    requireWdaProvenance: true,
  });
  const handler = createRunActionHandler({
    targetContext: () => ({ platform: 'ios', deviceId: EXACT, appId: APP_ID }),
    blindProbeContext: async () => ({ deviceId: EXACT, iosRuntimeMajor: 26 }),
    maestroRun: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            data: {
              passed: true,
              transport: 'maestro-runner',
              transportVersion: '1.0.9',
              fallback: 'none',
              deviceAuthority: authority,
              steps: [{ index: 0, name: 'tapOn', verb: 'tapOn', status: 'pass', durationMs: 1 }],
            },
          }),
        },
      ],
    }),
  });

  const result = await handler({
    actionId: 'demo',
    projectRoot: project.root,
    platform: 'ios',
    autoRepair: false,
  });
  const body = envelope(result);
  assert.equal(body.ok, true, result.content[0].text);
  assert.equal(body.data.deviceAuthority.reportedDeviceId, EXACT);

  const record = project.readSidecar('demo').runHistory.at(-1);
  assert.equal(record.status, 'pass');
  assert.equal(record.deviceId, EXACT, 'RunRecord must use the verified direct report identity');
});

test('cdp_run_action restores managed Metro attachment after launchApp before replay', async () => {
  project.seedAction(
    'managed-replay',
    [
      `appId: ${APP_ID}`,
      '---',
      '# id: managed-replay',
      '# intent: replay against managed Metro',
      '# tags: [fixture]',
      '# mutates: false',
      '# status: active',
      '- launchApp',
      '- tapOn:',
      '    id: "fab-create-task"',
      '',
    ].join('\n'),
  );
  let attachedToManagedMetro = true;
  const calls: string[] = [];
  const maestroRun = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    execFile: async (_file, args) => {
      const flowPath = args.find((argument) => argument.endsWith('.yaml'));
      assert.ok(flowPath);
      const flow = readFileSync(flowPath, 'utf8');
      if (flow.includes('launchApp')) {
        calls.push('runner-launch');
        attachedToManagedMetro = false;
      } else {
        calls.push('runner-ui');
        assert.equal(attachedToManagedMetro, true);
      }
      return { stdout: runnerLog(EXACT), stderr: '' };
    },
  });
  const handler = createRunActionHandler({
    maestroRun,
    targetContext: () => ({ platform: 'ios', deviceId: EXACT, appId: APP_ID }),
    blindProbeContext: async () => ({ deviceId: EXACT, iosRuntimeMajor: 26 }),
    claimNativeOrigin: async () => {
      calls.push('claim-origin');
      assert.equal(attachedToManagedMetro, true);
    },
    completeNativeOrigin: async (_args, targetExpected) => {
      calls.push(`complete-origin:${targetExpected}`);
    },
    relaunchManagedApp: async () => {
      calls.push('relaunch-managed');
      attachedToManagedMetro = true;
    },
  });

  const result = await handler({
    actionId: 'managed-replay',
    projectRoot: project.root,
    platform: 'ios',
    autoRepair: false,
  });

  assert.equal(envelope(result).ok, true, result.content[0]!.text);
  assert.deepEqual(calls, [
    'runner-launch',
    'relaunch-managed',
    'claim-origin',
    'runner-ui',
    'complete-origin:true',
  ]);
});

test('cdp_run_action persists the direct wrong device and never requested metadata', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  let maestroArgs: Record<string, unknown> | undefined;
  let repairCalled = false;
  const authority = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(FOREIGN),
  });
  const handler = createRunActionHandler({
    targetContext: () => ({ platform: 'ios', deviceId: EXACT, appId: APP_ID }),
    blindProbeContext: async () => ({ deviceId: EXACT, iosRuntimeMajor: 26 }),
    maestroRun: async (args) => {
      maestroArgs = args;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              code: 'DEVICE_AUTHORITY_MISMATCH',
              error: `requested ${EXACT}, direct runner reported ${FOREIGN}`,
              meta: { deviceAuthority: authority, output: runnerLog(FOREIGN) },
            }),
          },
        ],
        isError: true,
      };
    },
    repairAction: async () => {
      repairCalled = true;
      throw new Error('repair must not run for target-authority failures');
    },
  });

  const result = await handler({
    actionId: 'demo',
    projectRoot: project.root,
    platform: 'ios',
    autoRepair: false,
  });
  const body = envelope(result);
  assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(repairCalled, false);
  assert.equal(maestroArgs?.deviceId, EXACT, 'active exact UDID must reach maestro_run');

  const record = project.readSidecar('demo').runHistory.at(-1);
  assert.equal(record.failureCode, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(record.deviceId, FOREIGN, 'direct runner identity must replace requested metadata');
  assert.notEqual(record.deviceId, EXACT);
});

const ANDROID_SERIAL = 'emulator-5556';

test('an Android pinned-device receipt is direct evidence, not a missing-report refusal', () => {
  const pinned = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'android',
    requestedDeviceId: ANDROID_SERIAL,
    output: [
      'Single device execution mode',
      `Connecting to Android device: ${ANDROID_SERIAL}`,
      'Flow execution completed: 1 passed, 0 failed, 0 skipped',
    ].join('\n'),
  });
  assert.equal(pinned.verified, true);
  assert.equal(pinned.reportedDeviceId, ANDROID_SERIAL);
  assert.equal(pinned.reason, 'exact-runner-match');

  const foreign = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'android',
    requestedDeviceId: ANDROID_SERIAL,
    output: 'Connecting to Android device: emulator-5554',
  });
  assert.equal(foreign.verified, false);
  assert.equal(foreign.reason, 'reported-device-mismatch');
});

test('a warm WDA that never re-narrates its target is degraded, not refused', () => {
  const warm = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: `Using specified iOS device: ${EXACT}`,
    requireWdaProvenance: true,
  });
  assert.equal(warm.verified, true);
  assert.equal(warm.reason, 'exact-runner-match');
  assert.equal(warm.wdaProvenance, 'unavailable');

  const spelled = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: [
      `Using specified iOS device: ${EXACT}`,
      `Building WebDriverAgent for device ${EXACT}`,
    ].join('\n'),
    requireWdaProvenance: true,
  });
  assert.equal(spelled.verified, true);
  assert.equal(spelled.wdaProvenance, 'exact-match');

  const foreignWarm = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: [
      `Using specified iOS device: ${EXACT}`,
      `Building WebDriverAgent for device ${FOREIGN}`,
    ].join('\n'),
    requireWdaProvenance: true,
  });
  assert.equal(foreignWarm.verified, false);
  assert.equal(foreignWarm.reason, 'wda-device-mismatch');
});

test('UDID letter case never splits one device into ambiguous or foreign identities', () => {
  const mixedCase = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(EXACT.toLowerCase(), EXACT),
    directReportDeviceIds: [EXACT.toLowerCase()],
    requireWdaProvenance: true,
  });
  assert.equal(mixedCase.verified, true);
  assert.equal(mixedCase.reason, 'exact-runner-and-wda-match');
  assert.equal(mixedCase.observedDeviceIds.length, 1);

  const stillForeign = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(FOREIGN.toLowerCase()),
    requireWdaProvenance: true,
  });
  assert.equal(stillForeign.verified, false);
  assert.equal(stillForeign.reason, 'reported-device-mismatch');
});

test('a weak-only report identity refuses with its own diagnosable reason', () => {
  const modelName = 'iPhone-16-Pro';

  const weak = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: 'Flow execution completed: 1 passed, 0 failed, 0 skipped',
    directReportDeviceIds: [modelName],
    directReportIdentityStrength: 'weak',
    requireWdaProvenance: true,
  });
  assert.equal(weak.verified, false);
  assert.equal(weak.reason, 'reported-device-weak-identity');
  assert.equal(weak.reportedDeviceId, modelName);
  assert.equal(shouldRejectMaestroDeviceAuthority(weak), true);

  const strongForeign = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: 'Flow execution completed: 1 passed, 0 failed, 0 skipped',
    directReportDeviceIds: [FOREIGN],
    directReportIdentityStrength: 'strong',
    requireWdaProvenance: true,
  });
  assert.equal(strongForeign.reason, 'reported-device-mismatch');
  assert.equal(shouldRejectMaestroDeviceAuthority(strongForeign), true);
});

test('a weak identity that DOES match the request is not downgraded to the weak reason', () => {
  const weakButExact = verifyMaestroDeviceAuthority({
    runner: 'maestro-runner',
    platform: 'ios',
    requestedDeviceId: EXACT,
    output: runnerLog(EXACT),
    directReportDeviceIds: [EXACT],
    directReportIdentityStrength: 'weak',
    requireWdaProvenance: true,
  });
  assert.equal(weakButExact.verified, true);
  assert.equal(weakButExact.reason, 'exact-runner-and-wda-match');
});
