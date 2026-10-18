import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, test } from 'node:test';
import {
  _setActiveSessionForTest,
  buildRunAndroidArgs,
  buildRunIOSArgs,
  runNative,
  isSnapshotCacheValid,
  getCachedSnapshot,
  setSnapshotAuthorityProvider,
} from '../../../dist/agent-device-wrapper.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import { createDeviceFindHandler } from '../../../dist/handlers/device-interact.js';
import {
  _setCapabilitiesForTest,
  _setFetchForTest,
  _setRunnerStateForTest,
  derivedDataPathForRunner,
  getFastRunnerState,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import { clearRefMap, hasRefMap } from '../../../dist/fast-runner-ref-map.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';

beforeEach(() => {
  clearRefMap();
  setSnapshotAuthorityProvider(null);
  _setActiveSessionForTest({
    name: 'presence-test',
    platform: 'ios',
    deviceId: 'sim',
    appId: 'com.test',
    openedAt: 'now',
  });
  _setRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});

afterEach(() => {
  setSnapshotAuthorityProvider(null);
  _setActiveSessionForTest(null);
  _setFetchForTest(globalThis.fetch);
  _setRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  clearRefMap();
});

test('device snapshot forwards the opt-in through the wrapper using the actual health capability', async () => {
  let capable = true;
  const requests: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) {
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [
          ...REQUIRED_IOS_FEATURES,
          'HONEST_HITTABLE',
          ...(capable ? ['PLATFORM_PRESENCE_V2'] : []),
        ],
      });
    }
    assert.equal(String(url), 'http://127.0.0.1:22088/command');
    const { commandId, ...body } = JSON.parse(String(init?.body));
    assert.equal(typeof commandId, 'string');
    requests.push(body);
    const optedIn = body.platformPresence === true;
    return Response.json({
      ok: true,
      data: {
        nodes: [
          {
            index: 0,
            type: 'Button',
            label: 'Continue',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            ...(optedIn ? { presence: { opaqueNodeEvidence: true } } : {}),
          },
        ],
        snapshotGeneration: 17,
        keyboardVisible: false,
        ...(optedIn ? { presenceCapture: { opaqueCaptureEvidence: true } } : {}),
      },
    });
  });
  const snapshot = createDeviceSnapshotHandler();
  const presence = parseEnvelope(
    await snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.deepEqual(requests.pop(), {
    command: 'snapshot',
    appBundleId: 'com.test',
    platformPresence: true,
    presenceBudgetMs: 20_000,
  });
  assert.deepEqual(presence.data.presenceCapture, { opaqueCaptureEvidence: true });
  assert.deepEqual(presence.data.nodes[0].presence, { opaqueNodeEvidence: true });
  assert.equal(presence.data.snapshotGeneration, 17);
  assert.equal(isSnapshotCacheValid('ios'), true, 'complete presence remains cacheable');

  const generic = parseEnvelope(await snapshot({ action: 'snapshot' }));
  assert.deepEqual(requests.pop(), {
    command: 'snapshot',
    appBundleId: 'com.test',
    interactiveOnly: true,
  });
  assert.equal(Object.hasOwn(generic.data, 'presenceCapture'), false);
  assert.equal(Object.hasOwn(generic.data.nodes[0], 'presence'), false);

  capable = false;
  const legacy = parseEnvelope(
    await snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, 'RN_FAST_RUNNER_STALE');
  assert.equal(legacy.meta?.mutation, 'none');
  assert.equal(legacy.meta?.dispatched, false);
  assert.deepEqual(requests, []);

  const genericLegacy = parseEnvelope(await snapshot({ action: 'snapshot' }));
  assert.equal(genericLegacy.ok, true);
  assert.deepEqual(requests.pop(), {
    command: 'snapshot',
    appBundleId: 'com.test',
    interactiveOnly: true,
  });
  assert.equal(Object.hasOwn(genericLegacy.data, 'presenceCapture'), false);
  assert.equal(Object.hasOwn(genericLegacy.data.nodes[0], 'presence'), false);
});

test('presence budget forwarding preserves QA read-only and context guards through handler and wrapper', async () => {
  const requests: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [
          ...REQUIRED_IOS_FEATURES,
          'HONEST_HITTABLE',
          'PLATFORM_PRESENCE_V2',
          'QA_READ_ONLY_V1',
        ],
      });
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      ok: true,
      data: {
        nodes: [{ index: 0, type: 'Button', rect: { x: 0, y: 0, width: 10, height: 10 } }],
        snapshotGeneration: 1,
        keyboardVisible: false,
      },
    });
  });
  const snapshot = createDeviceSnapshotHandler();
  const state = getFastRunnerState();
  for (const qa of [{ qaReadOnly: true }, { qaContext: new QaDispatchContext(100, () => 0) }]) {
    _setRunnerStateForTest(state);
    for (const read of [
      (presenceBudgetMs?: number) =>
        snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs, ...qa }),
      (presenceBudgetMs?: number) =>
        runNative(['snapshot', '--platform-presence'], { presenceBudgetMs, ...qa }),
    ]) {
      const count = requests.length;
      assert.equal(parseEnvelope(await read(12_345)).ok, true);
      assert.equal(requests.length, count + 1);
      assert.equal(requests.at(-1)?.presenceBudgetMs, 12_345);
      assert.equal(requests.at(-1)?.qaReadOnly, true);
      assert.equal(parseEnvelope(await read()).code, 'INVALID_ARGUMENT');
      assert.equal(requests.length, count + 1, 'missing budgets must not be defaulted');
      assert.equal(qa.qaContext?.authorizations ?? 0, 0, 'snapshot remains non-mutating');
    }
    _setRunnerStateForTest(null);
    await assert.rejects(
      snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 12_345, ...qa }),
      /ACTION_CONTEXT_CHANGED/,
    );
    if (qa.qaContext) assert.throws(() => qa.qaContext!.assertComplete(), /ACTION_CONTEXT_CHANGED/);
  }
});

test('unavailable presence reads never enter runner ensure or spawn, through handler or wrapper', async (t) => {
  const existsSync = fs.existsSync;
  let artifactChecks = 0;
  const artifacts = t.mock.method(fs, 'existsSync', (path) => {
    if (String(path).startsWith(derivedDataPathForRunner())) {
      artifactChecks++;
      return false;
    }
    return existsSync(path);
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    assert.fail('presence must not spawn a runner');
  });
  syncBuiltinESMExports();
  t.after(() => {
    artifacts.mock.restore();
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  const urls: string[] = [];
  _setFetchForTest(async (url) => {
    urls.push(String(url));
    assert.equal(String(url), 'http://127.0.0.1:22088/health');
    return Response.json({ ok: false }, { status: 503 });
  });
  const snapshot = createDeviceSnapshotHandler();
  for (const read of [
    () => snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
    () => runNative(['snapshot', '--platform-presence'], { presenceBudgetMs: 20_000 }),
  ]) {
    const result = parseEnvelope(await read());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RN_FAST_RUNNER_DOWN');
    assert.equal(
      artifactChecks,
      0,
      'ensure checks runner artifacts even before its spawn decision',
    );
    assert.equal(result.meta?.mutation, 'none');
    assert.equal(result.meta?.dispatched, false);
  }
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(urls.length, 2);

  const state = getFastRunnerState();
  _setRunnerStateForTest(null);
  for (const read of [
    () => snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
    () => runNative(['snapshot', '--platform-presence'], { presenceBudgetMs: 20_000 }),
  ]) {
    const missing = parseEnvelope(await read());
    assert.equal(missing.code, 'RN_FAST_RUNNER_DOWN');
    assert.equal(missing.meta?.dispatched, false);
    assert.equal(artifactChecks, 0);
  }
  assert.equal(urls.length, 2);
  assert.equal(spawn.mock.callCount(), 0);
  _setRunnerStateForTest(state);

  const generic = parseEnvelope(await snapshot({ action: 'snapshot' }));
  assert.equal(generic.ok, false);
  assert.equal(generic.code, 'RN_FAST_RUNNER_DOWN');
  assert.equal(artifactChecks, 1, 'generic capture retains its existing ensure path');
});

test('presence capture refuses runner-leak evidence without implicit session recovery', async (t) => {
  const processKill = process.kill;
  const signals: unknown[] = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal !== 0) {
      signals.push(signal);
      throw new Error('runner lifecycle mutation forbidden');
    }
    return processKill(pid, signal);
  });
  const commands: string[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) {
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', 'PLATFORM_PRESENCE_V2'],
      });
    }
    commands.push(JSON.parse(String(init?.body)).command);
    return Response.json({
      ok: true,
      data: {
        nodes: [
          {
            index: 0,
            type: 'Application',
            label: 'AgentDeviceRunner',
            rect: { x: 0, y: 0, width: 400, height: 800 },
          },
        ],
      },
    });
  });
  let recoveryCalls = 0;
  const snapshot = createDeviceSnapshotHandler({
    unbindRunner: () => {
      recoveryCalls++;
      throw new Error('recovery forbidden');
    },
    ensureIosRunner: async () => {
      recoveryCalls++;
      throw new Error('ensure forbidden');
    },
    stopIosRunner: async () => {
      recoveryCalls++;
      throw new Error('stop forbidden');
    },
  });
  const state = getFastRunnerState();
  const result = parseEnvelope(
    await snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.meta?.capture, 'unknown');
  assert.equal(result.meta?.mutation, 'none');
  assert.deepEqual(commands, ['snapshot']);
  assert.equal(recoveryCalls, 0);
  assert.deepEqual(signals, []);
  assert.equal(getFastRunnerState(), state);
});

test('presence without a session refuses without looking for or starting a runner', async () => {
  _setActiveSessionForTest(null);
  _setRunnerStateForTest(null);
  let requests = 0;
  _setFetchForTest(async () => {
    requests++;
    assert.fail('an absent session cannot dispatch');
  });
  const result = parseEnvelope(
    await createDeviceSnapshotHandler()({
      action: 'snapshot',
      platformPresence: true,
      presenceBudgetMs: 20_000,
    }),
  );
  assert.equal(result.code, 'RN_FAST_RUNNER_DOWN');
  assert.equal(result.meta?.dispatched, false);
  assert.equal(result.meta?.mutation, 'none');
  assert.equal(requests, 0);
});

test('presence argv reaches both native runners and the generic snapshot remains interactive', () => {
  assert.deepEqual(buildRunIOSArgs(['snapshot', '--platform-presence'], 'com.test'), {
    command: 'snapshot',
    bundleId: 'com.test',
    platformPresence: true,
  });
  assert.deepEqual(buildRunIOSArgs(['snapshot', '-i'], 'com.test'), {
    command: 'snapshot',
    bundleId: 'com.test',
    interactiveOnly: true,
  });
  assert.deepEqual(buildRunAndroidArgs(['snapshot', '--platform-presence'], 'com.test'), {
    command: 'snapshot',
    bundleId: 'com.test',
    platformPresence: true,
  });
  assert.deepEqual(buildRunAndroidArgs(['snapshot', '-i'], 'com.test'), {
    command: 'snapshot',
    bundleId: 'com.test',
    interactiveOnly: true,
  });
});

test('incomplete presence invalidates targeting cache and the next find refreshes before clicking', async (t) => {
  const settle = process.env.RN_SETTLE;
  process.env.RN_SETTLE = '0';
  t.after(() => {
    if (settle === undefined) delete process.env.RN_SETTLE;
    else process.env.RN_SETTLE = settle;
  });
  const snapshot = createDeviceSnapshotHandler();
  const find = createDeviceFindHandler();
  for (const entry of ['handler', 'runner']) {
    const commands: Record<string, unknown>[] = [];
    let captures = 0;
    _setFetchForTest(async (url, init) => {
      if (String(url).endsWith('/health')) {
        return Response.json({
          ok: true,
          protocolVersion: 2,
          commands: REQUIRED_IOS_COMMANDS,
          capabilities: [...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', 'PLATFORM_PRESENCE_V2'],
        });
      }
      const body = JSON.parse(String(init?.body));
      commands.push(body);
      if (body.command === 'tap') return Response.json({ ok: true, data: { tapped: true } });
      assert.equal(body.command, 'snapshot');
      captures++;
      const incomplete = body.platformPresence === true;
      return Response.json({
        ok: true,
        data: {
          nodes: [
            {
              index: captures === 1 ? 0 : incomplete ? 7 : 9,
              type: 'Button',
              label: 'Continue',
              identifier: 'continue',
              rect: { x: 10, y: 20, width: 100, height: 40 },
            },
          ],
          snapshotGeneration: captures,
          ...(incomplete
            ? { presenceCapture: { opaque: true, complete: false } }
            : { keyboardVisible: false }),
        },
      });
    });
    assert.equal((await snapshot({ action: 'snapshot' })).isError, undefined);
    assert.equal(isSnapshotCacheValid('ios'), true);
    assert.equal(parseEnvelope(await find({ text: 'Continue', exact: true })).data.ref, '@e0');
    assert.equal(captures, 1, 'healthy targeting cache remains reusable');

    const result = parseEnvelope(
      await (entry === 'handler'
        ? snapshot({ action: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 })
        : runIOS({
            command: 'snapshot',
            bundleId: 'com.test',
            platformPresence: true,
            presenceBudgetMs: 20_000,
          })),
    );
    assert.equal(result.ok, true);
    assert.equal(result.meta?.snapshotVerdict.refMapUpdated, false);
    assert.deepEqual(result.data.presenceCapture, { opaque: true, complete: false });
    assert.equal(result.data.nodes[0].ref, '@e7');
    assert.equal(hasRefMap(), false);
    assert.equal(isSnapshotCacheValid('ios'), false, entry);
    assert.equal(getCachedSnapshot('ios'), undefined);

    const clicked = parseEnvelope(await find({ text: 'Continue', exact: true, action: 'click' }));
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    assert.equal(clicked.meta?.snapshotProvenance.source, 'fresh');
    assert.equal(captures, 3);
    assert.deepEqual(
      commands.map((command) => command.command),
      ['snapshot', 'snapshot', 'snapshot', 'tap'],
    );
    assert.equal(commands[2].platformPresence, undefined);
    assert.equal(commands[2].interactiveOnly, true);
    assert.equal(commands[3].snapshotNodeIndex, 9);
    assert.equal(commands[3].snapshotGeneration, 3);
    assert.equal(hasRefMap(), true);
  }
});

test('snapshot preserves only structural modal metadata and never treats it as complete presence', async () => {
  _setCapabilitiesForTest([...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', 'PLATFORM_PRESENCE_V2']);
  _setFetchForTest(async (url) =>
    String(url).endsWith('/health')
      ? Response.json({
          ok: true,
          protocolVersion: 2,
          commands: REQUIRED_IOS_COMMANDS,
          capabilities: [...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', 'PLATFORM_PRESENCE_V2'],
        })
      : Response.json({
          ok: true,
          data: {
            nodes: [],
            snapshotGeneration: 1,
            keyboardVisible: false,
            systemModal: {
              appState: 'runningForeground',
              alertCount: 1,
              sheetCount: 0,
              modals: [],
              label: 'private modal',
              identifier: 'private-id',
            },
          },
        }),
  );
  const result = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 5000 }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.meta.systemModal, {
    appState: 'runningForeground',
    alertCount: 1,
    sheetCount: 0,
    modals: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /private modal|private-id/);
  assert.equal(result.meta.snapshotVerdict.state, 'degraded');
  assert.equal(hasRefMap(), false);
});
