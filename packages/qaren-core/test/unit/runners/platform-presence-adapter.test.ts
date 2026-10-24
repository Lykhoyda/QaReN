import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, test } from 'node:test';
import {
  _setCapabilitiesForTest,
  _setFetchForTest,
  _setRunnerStateForTest,
  getFastRunnerState,
  runIOS,
  readIOSLabelProvenance,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  clearRefMap,
  getCachedMetadata,
  getCachedSignature,
  getFreshRefTarget,
  refCenter,
  hasRefMap,
} from '../../../dist/fast-runner-ref-map.js';
import { buildRunIOSArgs, healStaleRef } from '../../../dist/agent-device-wrapper.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';

const rect = { x: 10, y: 20, width: 100, height: 40 };

function health(capable = true) {
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

beforeEach(() => {
  clearRefMap();
  _setCapabilitiesForTest([]);
  _setRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  clearRefMap();
});

test('presence opt-in reaches the capable runner without any snapshot filters', async () => {
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V2']);
  const requests: unknown[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return health();
    const { commandId, ...body } = JSON.parse(String(init?.body));
    assert.equal(typeof commandId, 'string');
    requests.push(body);
    return Response.json({
      ok: true,
      data: {
        nodes: [{ index: 0, type: 'Button', rect }],
        snapshotGeneration: 17,
        keyboardVisible: false,
      },
    });
  });
  const result = await runIOS({
    command: 'snapshot',
    bundleId: 'com.test',
    platformPresence: true,
    presenceBudgetMs: 20_000,
    interactiveOnly: true,
    compact: true,
    depth: 2,
    scope: 'dialog',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests, [
    {
      command: 'snapshot',
      appBundleId: 'com.test',
      platformPresence: true,
      presenceBudgetMs: 20_000,
    },
  ]);
  assert.equal(Object.hasOwn(parseEnvelope(result).data, 'presenceCapture'), false);
});

test('snapshot normalization preserves opaque capture and node presence without exposing values or focus', async () => {
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V2']);
  const presenceCapture = {
    version: 2,
    appliedBudgetMs: 20_000,
    source: 'xcui-live',
    captureId: 'capture-17',
    appId: 'com.test',
    generation: 17,
    startedUptimeMs: 100,
    endedUptimeMs: 120,
    enumeration: 'raw-unfiltered',
    complete: true,
  };
  const presence = {
    captureId: 'capture-17',
    generation: 17,
    nodeIndex: 0,
    status: 'observed',
    labelSource: 'direct',
    observedUptimeMs: 110,
  };
  for (const [envelopeEvidence, nodeEvidence] of [
    [presenceCapture, presence],
    [null, false],
    ['future-envelope', ['future-node']],
    [
      { ...presenceCapture, complete: false },
      { ...presence, status: 'unknown' },
    ],
  ]) {
    _setFetchForTest(async (url) =>
      String(url).endsWith('/health')
        ? health()
        : Response.json({
            ok: true,
            data: {
              presenceCapture: envelopeEvidence,
              snapshotGeneration: 17,
              nodes: [
                {
                  index: 0,
                  type: 'Button',
                  label: 'Continue',
                  rect,
                  presence: nodeEvidence,
                  value: 'private-input',
                  focused: true,
                },
              ],
            },
          }),
    );
    const result = await runIOS({
      command: 'snapshot',
      platformPresence: true,
      presenceBudgetMs: 20_000,
    });
    assert.deepEqual(parseEnvelope(result).data, {
      nodes: [
        { ref: '@e0', index: 0, type: 'Button', label: 'Continue', rect, presence: nodeEvidence },
      ],
      normalizationDroppedNodes: 0,
      snapshotGeneration: 17,
      presenceCapture: envelopeEvidence,
    });
  }
});

test('ref healing and reused generations never inherit earlier presence proof', async () => {
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V2']);
  async function snapshot(data: Record<string, unknown>) {
    _setFetchForTest(async (url) =>
      String(url).endsWith('/health') ? health() : Response.json({ ok: true, data }),
    );
    return runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 });
  }
  await snapshot({
    snapshotGeneration: 17,
    keyboardVisible: false,
    presenceCapture: { captureId: 'old', generation: 17 },
    nodes: [
      {
        index: 3,
        type: 'Button',
        label: 'Continue',
        rect,
        presence: { captureId: 'old', generation: 17, nodeIndex: 3, status: 'observed' },
      },
    ],
  });
  assert.deepEqual(getCachedMetadata('@e3'), { type: 'Button', label: 'Continue' });
  assert.deepEqual(getCachedSignature('@e3'), {
    type: 'Button',
    label: 'Continue',
  });
  assert.equal(Object.hasOwn(getFreshRefTarget('@e3')!, 'presence'), false);

  const healed = await healStaleRef('@e3', () =>
    snapshot({
      snapshotGeneration: 17,
      keyboardVisible: false,
      nodes: [{ index: 0, type: 'Button', label: 'Continue', rect }],
    }),
  );
  assert.equal(healed.kind, 'healed');
  assert.equal(Object.hasOwn(healed, 'presence'), false);
  assert.equal(getFreshRefTarget('@e3'), null);
  assert.equal(Object.hasOwn(getFreshRefTarget('@e0')!, 'presence'), false);

  for (const nodes of [[], [{ index: 3, type: 'Button', label: 'Continue', rect }]]) {
    const current = parseEnvelope(await snapshot({ snapshotGeneration: 17, nodes }));
    assert.equal(Object.hasOwn(current.data, 'presenceCapture'), false);
    for (const node of current.data.nodes) assert.equal(Object.hasOwn(node, 'presence'), false);
  }
});

test('an older runner refuses presence without dispatching a legacy snapshot', async () => {
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V1']);
  const requests: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return health(false);
    const { commandId, ...body } = JSON.parse(String(init?.body));
    assert.equal(typeof commandId, 'string');
    requests.push(body);
    return Response.json({ ok: true, data: { nodes: [{ index: 0, type: 'Button', rect }] } });
  });
  const result = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.deepEqual(requests, []);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RN_FAST_RUNNER_STALE');
  assert.equal(result.meta?.mutation, 'none');
  assert.equal(result.meta?.dispatched, false);
  assert.equal(result.data, undefined);
});

test('presence snapshots retain true and false keyboard state and serialize exact keyboard key targets', async () => {
  for (const keyboardVisible of [true, false]) {
    const requests: Record<string, unknown>[] = [];
    _setFetchForTest(async (url, init) => {
      if (String(url).endsWith('/health')) return health();
      const { commandId, ...body } = JSON.parse(String(init?.body));
      assert.equal(typeof commandId, 'string');
      requests.push(body);
      return Response.json({
        ok: true,
        data:
          body.command === 'snapshot'
            ? {
                snapshotGeneration: 23,
                keyboardVisible,
                presenceCapture: { opaque: true },
                nodes: [
                  {
                    index: 7,
                    type: 'Key',
                    label: 'Return',
                    identifier: 'return-key',
                    rect,
                    presence: { opaque: true },
                  },
                ],
              }
            : { tapped: true },
      });
    });
    const snapshot = parseEnvelope(
      await runIOS({
        command: 'snapshot',
        bundleId: 'com.test',
        platformPresence: true,
        presenceBudgetMs: 20_000,
      }),
    );
    assert.equal(snapshot.data.keyboardVisible, keyboardVisible);
    assert.equal(snapshot.meta?.snapshotVerdict.refMapUpdated, true);
    assert.deepEqual(getFreshRefTarget('@e7'), {
      rect,
      snapshotGeneration: 23,
      snapshotNodeIndex: 7,
      snapshotElementType: 'Key',
      snapshotLabel: 'Return',
      snapshotIdentifier: 'return-key',
      keyboardStateAtSnapshot: keyboardVisible,
    });
    const press = buildRunIOSArgs(['press', '@e7'], 'com.test');
    assert.equal((await runIOS(press)).isError, undefined);
    const { guardKeyboard, ...serialized } = requests.at(-1)!;
    assert.equal(typeof guardKeyboard, 'boolean');
    assert.deepEqual(serialized, {
      command: 'tap',
      appBundleId: 'com.test',
      x: 60,
      y: 40,
      targetBounds: rect,
      snapshotGeneration: 23,
      snapshotNodeIndex: 7,
      snapshotElementType: 'Key',
      snapshotLabel: 'Return',
      snapshotIdentifier: 'return-key',
      keyboardStateAtSnapshot: keyboardVisible,
    });
  }
});

test('presence without keyboard freshness clears refs but retains unknown evidence without inventing false', async () => {
  let data: Record<string, unknown>;
  _setFetchForTest(async (url) =>
    String(url).endsWith('/health') ? health() : Response.json({ ok: true, data }),
  );
  const node = {
    index: 7,
    type: 'Key',
    label: 'Return',
    identifier: 'return-key',
    rect,
    presence: { opaque: true },
  };
  const presenceCapture = { opaque: true, complete: false };
  for (const keyboardVisible of [undefined, null, 'false', 0]) {
    data = { nodes: [node], snapshotGeneration: 23, keyboardVisible: true };
    await runIOS({
      command: 'snapshot',
      bundleId: 'com.test',
      platformPresence: true,
      presenceBudgetMs: 20_000,
    });
    assert.ok(getFreshRefTarget('@e7'));
    data = {
      nodes: [node],
      snapshotGeneration: 24,
      presenceCapture,
      ...(keyboardVisible === undefined ? {} : { keyboardVisible }),
    };
    const result = parseEnvelope(
      await runIOS({
        command: 'snapshot',
        bundleId: 'com.test',
        platformPresence: true,
        presenceBudgetMs: 20_000,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(hasRefMap(), false);
    assert.equal(refCenter('@e7'), null);
    assert.equal(getFreshRefTarget('@e7'), null);
    assert.equal(getFreshRefTarget('@e7', { allowUnknownKeyboardState: true }), null);
    assert.equal(getCachedSignature('@e7'), null);
    assert.deepEqual(buildRunIOSArgs(['press', '@e7'], 'com.test'), {
      command: 'tap',
      _staleRef: '@e7',
      bundleId: 'com.test',
    });
    assert.deepEqual(result.data.nodes, [{ ref: '@e7', ...node }]);
    assert.deepEqual(result.data.presenceCapture, presenceCapture);
    assert.equal(Object.hasOwn(result.data, 'keyboardVisible'), false);
    assert.equal(result.meta?.snapshotVerdict.refMapUpdated, false);
    assert.equal(result.meta?.snapshotVerdict.state, 'degraded');
    assert.ok(result.meta?.snapshotVerdict.reasons.includes('snapshot-ref-freshness-unknown'));
  }
});

test('presence cannot synthesize generation freshness or retain old refs from a malformed snapshot', async () => {
  let data: unknown;
  _setFetchForTest(async (url) =>
    String(url).endsWith('/health') ? health() : Response.json({ ok: true, data }),
  );
  const nodes = [{ index: 0, type: 'Button', label: 'Continue', rect }];
  for (const invalid of [
    ...[undefined, null, '17', -1, 0.5].map((snapshotGeneration) => ({
      nodes,
      keyboardVisible: false,
      snapshotGeneration,
    })),
    { keyboardVisible: false, snapshotGeneration: 17, presenceCapture: { opaque: true } },
    null,
  ]) {
    data = { nodes, keyboardVisible: false, snapshotGeneration: 17 };
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 });
    assert.ok(getFreshRefTarget('@e0'));
    data = invalid;
    const result = parseEnvelope(
      await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
    );
    assert.equal(hasRefMap(), false);
    assert.equal(result.meta?.snapshotVerdict.refMapUpdated, false);
    assert.equal(result.meta?.snapshotVerdict.state, 'degraded');
  }
});

test('default snapshots retain legacy coordinate refs when keyboard state is missing', async () => {
  _setFetchForTest(async () =>
    Response.json({ ok: true, data: { nodes: [{ index: 7, type: 'Button', rect }] } }),
  );
  const result = parseEnvelope(await runIOS({ command: 'snapshot' }));
  assert.equal(result.meta?.snapshotVerdict.refMapUpdated, true);
  assert.equal(getFreshRefTarget('@e7'), null);
  assert.deepEqual(refCenter('@e7'), { x: 60, y: 40 });
  assert.deepEqual(buildRunIOSArgs(['press', '@e7'], 'com.test'), {
    command: 'tap',
    bundleId: 'com.test',
    x: 60,
    y: 40,
  });
});

test('absent and dead runners refuse presence without cached-capability reuse or teardown', async (t) => {
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V1']);
  let requests = 0;
  _setFetchForTest(async () => {
    requests++;
    assert.fail('no runner is available to probe or capture');
  });
  _setRunnerStateForTest(null);
  const absent = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(absent.code, 'RN_FAST_RUNNER_DOWN');
  assert.equal(absent.meta?.dispatched, false);

  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  const state = getFastRunnerState();
  t.mock.method(process, 'kill', (_pid, signal) => {
    assert.equal(signal, 0, 'only process existence may be probed');
    throw new Error('ESRCH');
  });
  const dead = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(dead.code, 'RN_FAST_RUNNER_DOWN');
  assert.equal(dead.meta?.mutation, 'none');
  assert.equal(dead.meta?.dispatched, false);
  assert.equal(getFastRunnerState(), state, 'read-only health must not clear runner state');
  assert.equal(requests, 0);
});

test('presence reuses the existing health authority check and never captures on an identity mismatch', async () => {
  _setRunnerStateForTest({
    ...getFastRunnerState()!,
    sessionId: 'owned-session',
    instanceId: 'owned-instance',
    claimEpoch: 1,
  });
  const urls: string[] = [];
  _setFetchForTest(async (url) => {
    urls.push(String(url));
    return health();
  });
  const result = parseEnvelope(
    await runIOS({ command: 'snapshot', platformPresence: true, presenceBudgetMs: 20_000 }),
  );
  assert.equal(result.code, 'RUNNER_OWNERSHIP_MISMATCH');
  assert.equal(result.meta?.dispatched, false);
  assert.deepEqual(urls, ['http://127.0.0.1:22088/health']);
});

test('presence transport and native failures never retry, relayout, or reap the existing runner', async (t) => {
  const processKill = process.kill;
  const signals: unknown[] = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal !== 0) {
      signals.push(signal);
      throw new Error('process mutation forbidden');
    }
    return processKill(pid, signal);
  });
  const subprocess = t.mock.method(childProcess, 'execFileSync', () => {
    assert.fail('presence failure must not invoke process-recovery helpers');
  });
  syncBuiltinESMExports();
  t.after(() => {
    subprocess.mock.restore();
    syncBuiltinESMExports();
  });
  for (const failure of [
    'socket closed',
    'abort',
    'KEYBOARD_RELAYOUT_REQUIRED',
    'PLATFORM_PRESENCE_FAILED',
  ]) {
    const state = getFastRunnerState();
    const commands: string[] = [];
    _setFetchForTest(async (url, init) => {
      if (String(url).endsWith('/health')) return health();
      commands.push(JSON.parse(String(init?.body)).command);
      if (failure === 'socket closed') throw new Error('fetch failed');
      if (failure === 'abort') throw new DOMException('timeout', 'AbortError');
      return Response.json({ ok: false, error: { code: failure, message: failure } });
    });
    const result = parseEnvelope(
      await runIOS({
        command: 'snapshot',
        bundleId: 'com.test',
        platformPresence: true,
        presenceBudgetMs: 20_000,
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.meta?.capture, 'unknown');
    assert.equal(result.meta?.mutation, 'none');
    assert.equal(result.meta?.dispatched, true);
    assert.deepEqual(commands, ['snapshot'], failure);
    assert.equal(getFastRunnerState(), state);
    assert.deepEqual(signals, []);
    assert.equal(subprocess.mock.callCount(), 0);
  }
});

test('candidate metadata preserves the ordinary ref map and withholds trees, values and wrong-process evidence', async () => {
  _setCapabilitiesForTest(['PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1']);
  let processId = 71;
  const bodies: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1'],
      });
    const { commandId: _commandId, ...body } = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json({
      ok: true,
      data: body.labelProvenance
        ? {
            labelProvenance: [
              { index: 0, labelSource: 'descendant', value: 'private-native-canary' },
            ],
            nodes: [{ index: 99, type: 'TextField', value: 'private-native-canary', rect }],
            appProcessIdentifier: processId,
            labelProvenanceDiagnostics: {
              sampleCount: 2,
              fieldMask: 8,
              nodeIndex: 0,
              deadlineExpired: false,
              outcome: 'available',
              value: 'private-diagnostic-canary',
            },
          }
        : {
            nodes: [{ index: 0, type: 'Button', label: 'Add coverage', rect }],
            snapshotGeneration: 17,
            keyboardVisible: false,
            appProcessIdentifier: processId,
          },
    });
  });
  await runIOS({ command: 'snapshot', bundleId: 'com.test' });
  const before = getFreshRefTarget('@e0');
  const diagnostics: unknown[] = [];
  const evidence = await readIOSLabelProvenance(['@e0'], 777, 'com.test', 'sim', (event) =>
    diagnostics.push(event),
  );
  assert.deepEqual(diagnostics, [
    {
      requested: true,
      sampleCount: 2,
      nodeIndex: 0,
      differedFields: ['value'],
      deadlineExpired: false,
      outcome: 'available',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-diagnostic-canary/);
  assert.deepEqual(evidence, [{ ref: '@e0', labelSource: 'descendant' }]);
  assert.equal(JSON.stringify(evidence).includes('private-native-canary'), false);
  assert.deepEqual(getFreshRefTarget('@e0'), before);
  assert.equal(getFreshRefTarget('@e99'), null);
  assert.deepEqual(bodies[1], {
    command: 'snapshot',
    qaReadOnly: true,
    appBundleId: 'com.test',
    platformPresence: true,
    presenceBudgetMs: 777,
    labelProvenance: [0],
    snapshotGeneration: 17,
  });
  processId = 72;
  assert.equal(await readIOSLabelProvenance(['@e0'], 777, 'com.test', 'sim'), undefined);
  assert.deepEqual(getFreshRefTarget('@e0'), before);
  const requests = bodies.length;
  assert.equal(await readIOSLabelProvenance(['@e99'], 777, 'com.test', 'sim'), undefined);
  assert.equal(bodies.length, requests);
});
