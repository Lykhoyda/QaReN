import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearRefMap, refCenter } from '../../../dist/fast-runner-ref-map.js';
import {
  _setFetchForTest,
  _setRunnerStateForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest as _setAndroidFetchForTest,
  runAndroid,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { QA_READ_ONLY_CAPABILITY } from '../../../dist/runners/qa-native-policy.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';

test('runIOS snapshot preserves evidenced native hierarchy and coverage without changing refs or exposing values', async (t) => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  });

  async function snapshot(data: Record<string, unknown>) {
    _setFetchForTest(async () => Response.json({ ok: true, data }));
    const result = await runIOS({ command: 'snapshot' });
    assert.equal(result.isError, undefined);
    const envelope = parseEnvelope(result);
    assert.equal(envelope.ok, true);
    return envelope;
  }

  const rect = { x: 10, y: 20, width: 100, height: 40 };
  const root = { index: 0, type: 'Application', rect, depth: 0 };
  const branch = { index: 1, type: 'Other', rect, depth: 1, parentIndex: 0 };
  const capture = await snapshot({
    nodes: [
      root,
      branch,
      { index: 2, type: 'Other', depth: 2, parentIndex: 1 },
      {
        index: 3,
        type: 'Button',
        label: 'Continue',
        identifier: 'continue',
        rect,
        enabled: false,
        hittable: false,
        depth: 4,
        parentIndex: 1,
        value: 'private-input',
        focused: true,
      },
    ],
    truncated: true,
    keyboardVisible: false,
    snapshotGeneration: 17,
  });
  assert.deepEqual(capture.data, {
    nodes: [
      { ref: '@e0', ...root },
      { ref: '@e1', ...branch },
      {
        ref: '@e3',
        index: 3,
        type: 'Button',
        label: 'Continue',
        identifier: 'continue',
        rect,
        enabled: false,
        hittable: false,
        depth: 4,
        parentIndex: 1,
      },
    ],
    normalizationDroppedNodes: 1,
    truncated: true,
    keyboardVisible: false,
    snapshotGeneration: 17,
  });
  assert.equal(capture.meta?.snapshotVerdict?.state, 'ok');
  assert.equal(capture.meta?.snapshotVerdict?.refMapUpdated, true);
  assert.deepEqual(refCenter('@e3'), { x: 60, y: 40 });
  assert.equal(refCenter('@e2'), null);

  const legacyNodes = [
    { type: 'Button', rect },
    { type: 'Other' },
    { index: 7, type: 'Other', rect },
    { type: 'TextField', rect, value: 'private-input', focused: false },
  ];
  const legacy = await snapshot({ nodes: legacyNodes });
  assert.deepEqual(legacy.data, {
    nodes: [
      { ref: '@e0', type: 'Button', rect },
      { ref: '@e7', index: 7, type: 'Other', rect },
      { ref: '@e1', type: 'TextField', rect },
    ],
    normalizationDroppedNodes: 1,
  });
  assert.deepEqual(refCenter('@e7'), { x: 60, y: 40 });
  assert.deepEqual(refCenter('@e1'), { x: 60, y: 40 });

  for (const truncated of [true, false, undefined, null, 0, 1, 'false']) {
    const envelope = await snapshot({ nodes: [root], truncated });
    assert.equal(envelope.data.normalizationDroppedNodes, 0);
    if (typeof truncated === 'boolean') {
      assert.equal(envelope.data.truncated, truncated);
    } else {
      assert.equal(Object.hasOwn(envelope.data, 'truncated'), false);
    }
  }

  for (const field of ['index', 'parentIndex', 'depth']) {
    for (const invalid of [null, '1', true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const envelope = await snapshot({ nodes: [root, { ...branch, [field]: invalid }] });
      assert.equal(envelope.data.normalizationDroppedNodes, 0);
      assert.equal(
        Object.hasOwn(envelope.data.nodes[1], field),
        false,
        `${field} must not retain ${JSON.stringify(invalid)}`,
      );
    }
  }

  for (const nodes of [
    [root, { ...branch, parentIndex: 1 }],
    [root, { ...branch, parentIndex: 2 }],
    [root, { ...branch, index: 3, parentIndex: 2 }],
    [{ index: 0, type: 'Other' }, branch],
    [{ type: 'Other', rect }, branch],
    [root, { type: 'Button', rect, parentIndex: 0 }],
  ]) {
    const envelope = await snapshot({ nodes });
    assert.equal(
      Object.hasOwn(envelope.data.nodes.at(-1), 'parentIndex'),
      false,
      'no self, forward, dangling or synthetic-index parent relationships',
    );
  }

  const empty = await snapshot({ nodes: [], truncated: false });
  assert.deepEqual(empty.data, { nodes: [], normalizationDroppedNodes: 0, truncated: false });
  assert.equal(empty.meta?.snapshotVerdict?.state, 'degraded');
  assert.equal(empty.meta?.snapshotVerdict?.refMapUpdated, false);
  assert.deepEqual(refCenter('@e0'), { x: 60, y: 40 });
});

test('runIOS snapshot reports a rectless observation dropped from 31 native nodes without changing truncation', async (t) => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  });

  const rect = { x: 10, y: 20, width: 100, height: 40 };
  const nodes = Array.from({ length: 31 }, (_, index) => ({
    index,
    type: 'Button',
    ...(index === 15 ? {} : { rect }),
  }));
  _setFetchForTest(async () => Response.json({ ok: true, data: { nodes, truncated: false } }));

  const result = await runIOS({ command: 'snapshot' });
  assert.equal(result.isError, undefined);
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.nodes.length, 30);
  assert.equal(envelope.data.truncated, false);
  assert.equal(envelope.data.normalizationDroppedNodes, 1);
  assert.equal(envelope.data.nodes[14].ref, '@e14');
  assert.equal(envelope.data.nodes[15].ref, '@e16');
  assert.equal(refCenter('@e15'), null);
  assert.deepEqual(refCenter('@e16'), { x: 60, y: 40 });
});

test('runIOS snapshot keeps the selected state a selection-only control reports', async (t) => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  });
  const rect = { x: 10, y: 20, width: 100, height: 40 };
  _setFetchForTest(async () =>
    Response.json({
      ok: true,
      data: {
        nodes: [
          { index: 0, type: 'Application', rect, depth: 0 },
          {
            index: 1,
            type: 'Button',
            label: 'Male',
            rect,
            depth: 1,
            parentIndex: 0,
            selected: true,
          },
          { index: 2, type: 'Button', label: 'Female', rect, depth: 1, parentIndex: 0 },
        ],
        truncated: false,
        keyboardVisible: false,
      },
    }),
  );
  const envelope = parseEnvelope(await runIOS({ command: 'snapshot' }));
  const nodes = (envelope.data as { nodes: { label?: string; selected?: boolean }[] }).nodes;
  assert.equal(nodes.find((n) => n.label === 'Male')?.selected, true);
  assert.equal(Object.hasOwn(nodes.find((n) => n.label === 'Female')!, 'selected'), false);
});

test('runAndroid QA snapshot keeps a reported heading and adds none where the runner reports none', async (t) => {
  clearRefMap();
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'test-emulator',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setAndroidFetchForTest(globalThis.fetch);
    _setAndroidRunnerStateForTest(null);
    clearRefMap();
  });
  const rect = { x: 0, y: 0, width: 1080, height: 200 };
  _setAndroidFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, QA_READ_ONLY_CAPABILITY],
      });
    return Response.json({
      ok: true,
      data: {
        nodes: [
          { index: 0, depth: 0, type: 'Application', rect },
          {
            index: 1,
            depth: 1,
            parentIndex: 0,
            type: 'android.view.View',
            label: 'Section title',
            visibleToUser: true,
            heading: true,
            rect,
          },
          {
            index: 2,
            depth: 1,
            parentIndex: 0,
            type: 'android.widget.TextView',
            label: 'Body',
            visibleToUser: true,
            rect,
          },
        ],
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotGeneration: 1,
        keyboardVisible: false,
      },
    });
  });
  const envelope = parseEnvelope(
    await runAndroid({
      command: 'snapshot',
      deviceId: 'test-emulator',
      bundleId: 'com.test',
      qaReadOnly: true,
    }),
  );
  const nodes = (envelope.data as { nodes: { label?: string; heading?: boolean }[] }).nodes;
  assert.equal(nodes.find((n) => n.label === 'Section title')?.heading, true);
  assert.equal(Object.hasOwn(nodes.find((n) => n.label === 'Body')!, 'heading'), false);
});

test('QA snapshots retain emitted, normalized and dropped kinds without publishing producer diagnostics', async (t) => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  });
  const rect = { x: 0, y: 0, width: 100, height: 40 };
  let snapshotDiagnostics: unknown = {
    v: 1,
    viewportSource: 'app',
    viewport: [-1.2, 2.6, 100, 200],
    label: 'SECRET-DIAGNOSTIC',
  };
  const data = () => ({
    nodes: [
      { index: 0, type: 'TextField', rect, enabled: false, hittable: false },
      { index: 1, type: 'SearchField' },
      { index: 2, type: 'SECRET-CUSTOM-TYPE', rect },
    ],
    snapshotDiagnostics,
  });
  let requests = 0;
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
      });
    requests++;
    return Response.json({ ok: true, data: data() });
  });
  const qa = parseEnvelope(await runIOS({ command: 'snapshot', qaReadOnly: true }));
  assert.equal(requests, 1);
  assert.deepEqual(qa.data.snapshotDiagnostics, {
    viewportStatus: 'collected',
    viewportSource: 'app',
    viewport: [-1, 3, 100, 200],
    emittedCount: 3,
    normalizedCount: 2,
    missingRectCount: 1,
    emittedByKind: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    normalizedByKind: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    missingRectByKind: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  });
  assert.equal(JSON.stringify(qa.data.snapshotDiagnostics).includes('SECRET'), false);
  const ordinary = parseEnvelope(await runIOS({ command: 'snapshot' }));
  assert.equal(Object.hasOwn(ordinary.data, 'snapshotDiagnostics'), false);
  assert.deepEqual(
    ordinary.data.nodes.map((n: { ref: string }) => n.ref),
    ['@e0', '@e2'],
  );
  for (const [input, status] of [
    [undefined, 'missing'],
    [null, 'invalid'],
    [{ v: 1, viewportSource: 'unbounded', viewport: null }, 'collected'],
    [{ v: 1, viewportSource: 'app', viewport: null }, 'invalid'],
  ] as const) {
    snapshotDiagnostics = input;
    const result = parseEnvelope(await runIOS({ command: 'snapshot', qaReadOnly: true }));
    assert.equal(result.data.snapshotDiagnostics.viewportStatus, status);
    assert.equal(result.data.snapshotDiagnostics.emittedCount, 3);
  }
});
