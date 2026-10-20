import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  classifyAndroidHealth,
  runAndroid,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { clearRefMap, getScreenPointScale } from '../../../dist/fast-runner-ref-map.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import {
  resetActiveSessionInMemoryForTest,
  setActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
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

test('the Android capture retains its point scale for scroll gesture insets', async () => {
  const fixture = androidPresenceCapture();
  Reflect.deleteProperty(fixture.data, 'pointScale');
  await capturing(() => fixture)({ platformPresence: true });
  assert.equal(getScreenPointScale(), fixture.data.presenceCapture.pointScale);
  clearRefMap();
  assert.equal(getScreenPointScale(), 1);
});

for (const platformPresence of [false, true]) {
  test(`Android snapshot density keeps scroll endpoints 48 dp from window edges with presence=${platformPresence}`, async () => {
    const fixture = androidPresenceCapture();
    if (!platformPresence) {
      Reflect.deleteProperty(fixture.data, 'presenceCapture');
      for (const node of fixture.data.nodes) Reflect.deleteProperty(node, 'presence');
    }
    await capturing(() => fixture)({ platformPresence });
    setActiveSessionInMemoryForTest({
      name: 'test-scroll-density',
      platform: 'android',
      deviceId: 'test-emulator',
      openedAt: '2026-10-19T00:00:00.000Z',
    });
    try {
      assert.equal(getScreenPointScale(), fixture.data.pointScale);
      const within = fixture.data.nodes[0].rect;
      const inset = 48 * fixture.data.pointScale;
      for (const direction of ['up', 'down'] as const) {
        const [, , y1, , y2] = buildDirectionalScrollCliArgs(
          direction,
          0.6,
          undefined,
          undefined,
          within,
        ).map(Number);
        for (const y of [y1, y2]) {
          assert.ok(y >= inset, `${y} < ${inset}`);
          assert.ok(y <= within.height - inset, `${y} > ${within.height - inset}`);
        }
      }
    } finally {
      resetActiveSessionInMemoryForTest();
    }
  });
}

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

test('an Android phrase tap resolves when both the native rule and the React hit test reach the control', async () => {
  const j = judge();
  const f = walker([], j);
  f.deps.captureScreen = capturing(androidPresenceCapture);
  const result = await runPlan(parsePlan('1. Tap the Open Pager QA button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @e3']);
  assert.equal(j.requests.length, 1);
});

// A transparent full-screen React view drawn above the button with the default pointerEvents (auto):
// the runner sees no clickable cover, but React Native gives the touch to the overlay.
function underReactOverlay(pointerEvents?: 'none') {
  const fixture = androidPresenceCapture();
  fixture.hostEvidence.hosts.push({
    role: null,
    roleSource: 'none',
    capabilities: {},
    order: 1,
    ...(pointerEvents ? { pointerEvents } : {}),
  } as (typeof fixture.hostEvidence.hosts)[number]);
  fixture.hostEvidence.typography.nodes.push({
    hostIndex: 3,
    parentHostIndex: 0,
    rootIndex: 0,
    hostType: 'RCTView',
    rect: fixture.hostEvidence.typography.nodes[0].rect,
    text: { kind: 'none' },
  } as (typeof fixture.hostEvidence.typography.nodes)[number]);
  return fixture;
}

test('an Android phrase tap on a control a React overlay covers refuses and presses nothing', async () => {
  const f = walker([], judge());
  f.deps.captureScreen = capturing(() => underReactOverlay());
  const result = await runPlan(parsePlan('1. Tap the Open Pager QA button').blocks!, f.deps);
  assert.notEqual(result.verdict, 'PASS');
  // The covered button keeps its identity but offers no press: nothing is left to choose from.
  assert.match(
    result.failure?.seen ?? '',
    /^TARGET_NOT_FOUND: the screen has no eligible candidates/,
  );
  assert.deepEqual(f.actions, []);
  const passThrough = walker([], judge());
  passThrough.deps.captureScreen = capturing(() => underReactOverlay('none'));
  const through = await runPlan(
    parsePlan('1. Tap the Open Pager QA button').blocks!,
    passThrough.deps,
  );
  assert.equal(through.verdict, 'PASS', through.failure?.seen);
  assert.deepEqual(passThrough.actions, ['press @e3']);
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

test('a runner advertising only the earlier presence rule is stale: no QA read, no snapshot', async () => {
  // A11Y_PRESENCE_V1 counted any visible view above a control as a cover; the core's React hit test
  // pairs only with the tighter V2 rule, so the earlier runner is rebuilt rather than paired.
  await assert.rejects(runAndroidPresence(['A11Y_PRESENCE_V1']), /ACTION_CONTEXT_CHANGED/);
  const health = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    commands: [...REQUIRED_ANDROID_COMMANDS],
    capabilities: [
      ...REQUIRED_ANDROID_FEATURES.filter((f) => f !== 'A11Y_PRESENCE_V2'),
      'A11Y_PRESENCE_V1',
    ],
  };
  assert.deepEqual(classifyAndroidHealth(health), {
    compatible: false,
    reason: 'missing-features',
    missing: ['A11Y_PRESENCE_V2'],
  });
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
          ...REQUIRED_ANDROID_FEATURES.filter((f) => !f.startsWith('A11Y_PRESENCE_')),
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
