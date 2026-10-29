import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  resetActiveSessionInMemoryForTest,
  setActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { createDeviceScrollHandler } from '../../../dist/handlers/device-interact.js';
import {
  buildAndroidProbes,
  buildIosProbes,
  waitForSettle,
} from '../../../dist/lifecycle/settle.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest as setAndroidFetch,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest as setIosFetch,
} from '../../../dist/runners/qaren-ios-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const failedProbe = () =>
  Response.json({
    ok: false,
    error: { code: 'ACTION_CONTEXT_CHANGED', message: 'snapshot unavailable', mutation: 'none' },
  });

beforeEach(() => {
  _setFastRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  setActiveSessionInMemoryForTest({
    name: 'settle-test',
    platform: 'ios',
    deviceId: 'sim',
    appId: 'com.test',
    openedAt: 'now',
  });
  setIosFetch(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
      });
    return failedProbe();
  });
});

afterEach(() => {
  setIosFetch(globalThis.fetch);
  setAndroidFetch(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  _setAndroidRunnerStateForTest(null);
  resetActiveSessionInMemoryForTest();
});

async function failedIosSettle(context: QaDispatchContext) {
  let now = 0;
  return waitForSettle({
    platform: 'ios',
    capabilities: [],
    probes: {
      ...buildIosProbes('com.test', context),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  });
}

test('failed iOS settle probes time out without refusing an acknowledged dispatch', async () => {
  const context = new QaDispatchContext(10_000, () => 0);
  context.authorize();
  const outcome = await failedIosSettle(context);
  assert.equal(outcome.method, 'timeout');
  assert.equal(outcome.settled, false);
  assert.equal(outcome.hierarchyChanged, undefined);
  assert.equal(context.refusal, undefined);
  assert.equal(context.authorizations, 1);
  context.assertComplete();
});

for (const readable of [true, false]) {
  test(`after-capture ${readable ? 'passes' : 'refuses'} after an acknowledged tap with failed settle probes`, async () => {
    const after = screen([element('@saved', 'Saved')]);
    if (!readable) after.coverage = { native: 'incomplete', react: 'complete' };
    const f = walker(
      [screen([element('@save', 'Save')]), after],
      scriptedJudge(() => ({})),
    );
    let sends = 0;
    f.deps.press = async (_ref, context) => {
      context.authorize();
      sends++;
      await failedIosSettle(context);
      return { ok: true, proven: false };
    };
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, readable ? 'PASS' : 'FAIL');
    if (!readable) assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
    assert.doesNotMatch(JSON.stringify(result), /ACTION_OUTCOME_UNCERTAIN/);
    assert.equal(sends, 1);
    assert.equal(f.captures(), 2);
  });
}

test('a refused iOS swipe response still raises ACTION_OUTCOME_UNCERTAIN', async () => {
  const f = walker(
    [screen([])],
    scriptedJudge(() => ({})),
  );
  let sends = 0;
  setIosFetch(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: REQUIRED_IOS_FEATURES,
      });
    assert.equal(JSON.parse(String(init?.body)).command, 'drag');
    sends++;
    return Response.json({ ok: false, error: { code: 'DRAG_FAILED', message: 'drag refused' } });
  });
  const scroll = createDeviceScrollHandler();
  f.deps.scroll = async (direction, context) => {
    await scroll({ direction, qaContext: context });
    assert.fail('refused swipe must throw');
  };
  const result = await runPlan(parsePlan('1. Scroll down').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /ACTION_OUTCOME_UNCERTAIN/);
  assert.equal(sends, 1);
  assert.equal(f.captures(), 1);
});

test('Android settle probes retain dispatch-context invalidation on host-port changes', async () => {
  const state = {
    schemaVersion: 1,
    hostPort: 23456,
    devicePort: 7100,
    pid: process.pid,
    startedAt: 'now',
    protocolVersion: 1,
  };
  _setAndroidRunnerStateForTest(state);
  setAndroidFetch(async () => assert.fail('changed host port must not receive a probe'));
  const context = new QaDispatchContext(10_000, () => 0);
  context.authorize();
  const probes = buildAndroidProbes('com.test', context);
  _setAndroidRunnerStateForTest({ ...state, hostPort: 29999 });
  assert.equal(await probes.snapshotHash(), null);
  assert.throws(() => context.assertComplete(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(context.authorizations, 1);
});
