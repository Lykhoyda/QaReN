// GH #705: maestro_run must commit a fresh install receipt after a clearState
// reinstall, and cdp_run_action must be able to supply the `.app` at all —
// its missing `appFile` parameter made the documented advice unfollowable.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMaestroRunHandler } from '../../dist/handlers/maestro-run.js';
import { chooseMaestroDispatch } from '../../dist/handlers/maestro-dispatch.js';
import { createRunActionHandler } from '../../dist/handlers/run-action.js';
import { createTmpProject } from '../helpers/tmp-project.js';
import {
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  buildReplayEngineStatus,
  MAESTRO_RUNNER_PIN,
  RunnerCacheUnavailableError,
} from '../../dist/domain/engine-pin.js';

beforeEach(() =>
  _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)),
);
afterEach(() => _resetEngineStatusForTest());

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';
const APP_FILE = '/tmp/rn-appfile-snapshots/TestApp.app';

const CLEAR_STATE_FLOW = ['- launchApp:', '    clearState: true', '- tapOn:', '    id: "go"'].join(
  '\n',
);
const PLAIN_FLOW = ['- launchApp', '- tapOn:', '    id: "go"'].join('\n');

function runnerLog(): string {
  return [
    'Single device execution mode',
    `Building WDA for device ${EXACT} (team ID: )`,
    `Starting WDA on device ${EXACT} (port: 8447)`,
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

function maestroHandler(
  reissues: string[],
  outcome: 'pass' | 'fail' | 'cache-refusal' = 'pass',
  seenArgs: string[][] = [],
) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run: () => Promise<unknown>) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reissueInstallReceipt: async () => {
      reissues.push('reissued');
      if (outcome === 'cache-refusal') throw new Error('receipt reissue masked cache refusal');
    },
    execFile: async (_file: string, args: string[]) => {
      seenArgs.push(args);
      if (outcome === 'cache-refusal') {
        throw new RunnerCacheUnavailableError('cache', 'EACCES');
      }
      const index = args.indexOf('--output');
      const dir = args[index + 1];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'maestro-runner.log'), runnerLog(), 'utf8');
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({
          device: { id: EXACT, platform: 'ios' },
          flows: [{ device: { id: EXACT, platform: 'ios' } }],
        }),
        'utf8',
      );
      if (outcome === 'fail') {
        throw Object.assign(new Error('runner exited 1'), {
          stdout: '',
          stderr: 'Element not found',
          code: 1,
        });
      }
      return { stdout: runnerLog(), stderr: '' };
    },
  });
}

test('GH#705 a clearState reinstall re-issues the install receipt', async () => {
  const reissues: string[] = [];
  const seenArgs: string[][] = [];
  await maestroHandler(
    reissues,
    'pass',
    seenArgs,
  )({
    inlineYaml: CLEAR_STATE_FLOW,
    platform: 'ios',
    appId: APP_ID,
    appFile: APP_FILE,
    deviceId: EXACT,
  });
  assert.deepEqual(reissues, ['reissued']);
  assert.ok(
    seenArgs.some((args) => args.includes(APP_FILE)),
    'maestro-runner must receive the --app-file the receipt was re-issued for',
  );
});

test('GH#705 a failed clearState flow still re-issues the receipt', async () => {
  const reissues: string[] = [];
  await maestroHandler(
    reissues,
    'fail',
  )({
    inlineYaml: CLEAR_STATE_FLOW,
    platform: 'ios',
    appId: APP_ID,
    appFile: APP_FILE,
    deviceId: EXACT,
  });
  assert.deepEqual(reissues, ['reissued']);
});

test('a cache refusal before clearState execution does not re-issue the receipt', async () => {
  const reissues: string[] = [];
  const result = await maestroHandler(
    reissues,
    'cache-refusal',
  )({
    inlineYaml: CLEAR_STATE_FLOW,
    platform: 'ios',
    appId: APP_ID,
    appFile: APP_FILE,
    deviceId: EXACT,
  });
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'WDA_BOOTSTRAP_FAILED');
  assert.match(envelope.error, /RUNNER_CACHE_UNAVAILABLE: cache: EACCES/);
  assert.deepEqual(reissues, []);
});

test('GH#705 a flow that never reinstalls does not re-issue the receipt', async () => {
  const reissues: string[] = [];
  await maestroHandler(reissues)({
    inlineYaml: PLAIN_FLOW,
    platform: 'ios',
    appId: APP_ID,
    appFile: APP_FILE,
    deviceId: EXACT,
  });
  assert.deepEqual(reissues, []);
});

function clearStateAction(id: string): string {
  return [
    `appId: ${APP_ID}`,
    '---',
    `# id: ${id}`,
    '# intent: log in',
    '# tags: [auth]',
    '# mutates: false',
    '# status: active',
    '',
    '- launchApp:',
    '    clearState: true',
    '- tapOn:',
    '    id: "sign-in"',
    '',
  ].join('\n');
}

function passEnvelope() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' },
        }),
      },
    ],
  };
}

test('GH#705 cdp_run_action resolves appFile from the session install receipt', async () => {
  const project = createTmpProject();
  try {
    project.seedAction('login-de', clearStateAction('login-de'), null);
    const forwarded: Record<string, unknown>[] = [];
    const handler = createRunActionHandler({
      maestroRun: async (args: Record<string, unknown>) => {
        forwarded.push(args);
        return passEnvelope();
      },
      installReceipt: () => ({ platform: 'ios', deviceId: EXACT, appId: APP_ID }),
      resolveAppFile: () => APP_FILE,
      reissueInstallReceipt: async () => {},
      claimNativeOrigin: async () => {},
      completeNativeOrigin: async () => {},
      relaunchManagedApp: async () => {},
    });
    const result = await handler({ actionId: 'login-de', projectRoot: project.root });
    assert.equal(JSON.parse(result.content[0].text).ok, true);
    assert.equal(forwarded[0].appFile, APP_FILE);
    assert.equal(typeof forwarded[0].reissueInstallReceipt, 'function');
  } finally {
    project.cleanup();
  }
});

test('GH#705 an explicit cdp_run_action appFile wins over auto-resolution', async () => {
  const project = createTmpProject();
  try {
    project.seedAction('login-en', clearStateAction('login-en'), null);
    const forwarded: Record<string, unknown>[] = [];
    let resolutions = 0;
    const handler = createRunActionHandler({
      maestroRun: async (args: Record<string, unknown>) => {
        forwarded.push(args);
        return passEnvelope();
      },
      // GH #993: the install binding is read for every clearState flow to decide
      // the dev-client refusal, so the pin is that auto-resolution never runs —
      // not that the binding is never read.
      installReceipt: () => ({
        platform: 'ios',
        deviceId: EXACT,
        appId: APP_ID,
        buildKind: 'bare-react-native',
      }),
      resolveAppFile: () => {
        resolutions += 1;
        return APP_FILE;
      },
      reissueInstallReceipt: async () => {},
      claimNativeOrigin: async () => {},
      completeNativeOrigin: async () => {},
      relaunchManagedApp: async () => {},
    });
    await handler({
      actionId: 'login-en',
      projectRoot: project.root,
      appFile: '/explicit/Other.app',
    });
    assert.equal(forwarded[0].appFile, '/explicit/Other.app');
    assert.equal(resolutions, 0, 'an explicit appFile bypasses auto-resolution');
  } finally {
    project.cleanup();
  }
});

test('GH#705 a non-clearState action forwards no appFile', async () => {
  const project = createTmpProject();
  try {
    project.seedAction(
      'plain',
      clearStateAction('plain').replace('- launchApp:\n    clearState: true', '- launchApp'),
      null,
    );
    const forwarded: Record<string, unknown>[] = [];
    const handler = createRunActionHandler({
      maestroRun: async (args: Record<string, unknown>) => {
        forwarded.push(args);
        return passEnvelope();
      },
      installReceipt: () => ({ platform: 'ios', deviceId: EXACT, appId: APP_ID }),
      resolveAppFile: () => APP_FILE,
      reissueInstallReceipt: async () => {},
      claimNativeOrigin: async () => {},
      completeNativeOrigin: async () => {},
      relaunchManagedApp: async () => {},
    });
    await handler({ actionId: 'plain', projectRoot: project.root });
    assert.equal(forwarded[0].appFile, undefined);
  } finally {
    project.cleanup();
  }
});
