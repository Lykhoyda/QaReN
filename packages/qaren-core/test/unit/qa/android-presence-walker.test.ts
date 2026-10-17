import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { QA_READ_ONLY_CAPABILITY } from '../../../dist/runners/qa-native-policy.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';
import { androidPresenceCapture } from './platform-presence-fixtures.ts';

beforeEach(() => {
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'test-emulator',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});
afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setAndroidRunnerStateForTest(null);
  clearRefMap();
});

type Fixture = ReturnType<typeof androidPresenceCapture>;

// The Android runner's wire through the real client mapper and capture, as the walk reads it.
function capturing(
  fixture: () => Fixture,
  capabilities: string[] = [],
  requests: Record<string, unknown>[] = [],
) {
  return async (options?: { platformPresence?: boolean }) => {
    const { data, hostEvidence } = fixture();
    _setFetchForTest(async (url, init) => {
      if (String(url).endsWith('/health'))
        return Response.json({
          ok: true,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          runnerVersion: getPluginVersion(),
          commands: REQUIRED_ANDROID_COMMANDS,
          capabilities: [...REQUIRED_ANDROID_FEATURES, QA_READ_ONLY_CAPABILITY, ...capabilities],
        });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      assert.equal(body.command, 'snapshot');
      return Response.json({ ok: true, data });
    });
    return captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      platformPresence: options?.platformPresence,
      now: () => 0,
      native: async (presenceBudgetMs) => {
        const result = parseEnvelope(
          await runAndroid({
            command: 'snapshot',
            deviceId: 'test-emulator',
            bundleId: 'com.test',
            qaReadOnly: true,
            ...(options?.platformPresence ? { platformPresence: true, presenceBudgetMs } : {}),
          }),
        );
        assert.equal(result.ok, true, JSON.stringify(result));
        return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence,
      }),
    });
  };
}

// The strict cover rule: transparent full-screen chrome drawn above React content leaves controls not-hittable.
function coveredByChrome() {
  const fixture = androidPresenceCapture();
  for (const node of fixture.data.nodes.slice(2))
    node.presence = {
      ...node.presence,
      status: 'unknown',
      unknownReason: 'not-hittable',
    } as typeof node.presence;
  for (const node of fixture.data.nodes)
    delete (node.presence as { observedUptimeMs?: number }).observedUptimeMs;
  return fixture;
}

const judge = () =>
  scriptedJudge((q) =>
    Object.fromEntries(Object.entries(q).map(([key, question]) => [key, choice(question)])),
  );

test('an Android phrase tap on a visible unique control refuses with the presence gap and presses nothing', async () => {
  const requests: Record<string, unknown>[] = [];
  const j = judge();
  const f = walker([], j);
  f.deps.captureScreen = capturing(coveredByChrome, undefined, requests);
  const result = await runPlan(parsePlan('1. Tap the Open Pager QA button').blocks!, f.deps);
  assert.notEqual(result.verdict, 'PASS');
  // The real Test App's Home refuses with this gap: its hosts cannot anchor to not-hittable nodes.
  assert.match(
    result.failure?.seen ?? '',
    /SCREEN_EVIDENCE_INCOMPLETE: an observation has unknown press capability \(.*interactive React hosts? unassociated\)/,
  );
  assert.doesNotMatch(result.failure?.seen ?? '', /NATIVE_PRESENCE_UNUSABLE/);
  assert.deepEqual(f.actions, []);
  assert.equal(j.requests.length, 0);
  assert.equal(requests[0].platformPresence, true);
  assert.equal(requests[0].presenceBudgetMs, 20_000);
});

test('an incomplete or stale Android capture is unusable before any action', async () => {
  for (const spoil of [
    (f: Fixture) => void (f.data.presenceCapture.complete = false),
    (f: Fixture) => void (f.data.presenceCapture.generation = 3),
    (f: Fixture) => void (f.data.nodes[3].presence.generation = 3),
  ]) {
    const f = walker([], judge());
    f.deps.captureScreen = capturing(() => {
      const fixture = androidPresenceCapture();
      spoil(fixture);
      return fixture;
    });
    const result = await runPlan(parsePlan('1. Tap the Open Pager QA button').blocks!, f.deps);
    assert.notEqual(result.verdict, 'PASS');
    assert.match(result.failure?.seen ?? '', /NATIVE_PRESENCE_UNUSABLE/);
    assert.deepEqual(f.actions, []);
  }
});

test('a runner without the presence pass serves no QA read and is sent no snapshot', async () => {
  await assert.rejects(runAndroidPresence([]), /ACTION_CONTEXT_CHANGED/);
});

test('a literal Android step needs no presence and is unchanged', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  f.deps.captureScreen = capturing(coveredByChrome, undefined, requests);
  const result = await runPlan(parsePlan('1. Tap "home-pager-qa-btn"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @e3']);
  assert.equal(requests[0].platformPresence, undefined);
});

async function runAndroidPresence(capabilities: string[]) {
  const sent: string[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [
          ...REQUIRED_ANDROID_FEATURES.filter((f) => f !== 'A11Y_PRESENCE_V1'),
          QA_READ_ONLY_CAPABILITY,
          ...capabilities,
        ],
      });
    sent.push(JSON.parse(String(init?.body)).command);
    return Response.json({ ok: true, data: androidPresenceCapture().data });
  });
  try {
    return parseEnvelope(
      await runAndroid({
        command: 'snapshot',
        deviceId: 'test-emulator',
        bundleId: 'com.test',
        qaReadOnly: true,
        platformPresence: true,
        presenceBudgetMs: 20_000,
      }),
    );
  } finally {
    assert.deepEqual(sent, []);
  }
}
