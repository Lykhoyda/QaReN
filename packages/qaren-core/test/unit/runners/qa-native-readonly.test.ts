import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import { buildIosProbes, buildAndroidProbes } from '../../../dist/lifecycle/settle.js';
import {
  runIOS,
  _setFastRunnerStateForTest,
  _setFetchForTest as iosFetch,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  runAndroid,
  _setAndroidRunnerStateForTest,
  _setFetchForTest as androidFetch,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../../dist/runners/protocol.js';

afterEach(() => {
  _setFastRunnerStateForTest(null);
  _setAndroidRunnerStateForTest(null);
  iosFetch(fetch);
  androidFetch(fetch);
});

function fixture(
  platform: 'ios' | 'android',
  capable = true,
  response: unknown = { ok: true, data: {} },
) {
  const state = {
    pid: process.pid,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    startedAt: 'now',
    protocolVersion: 2,
  };
  _setFastRunnerStateForTest({ ...state, port: 12345 });
  _setAndroidRunnerStateForTest({ ...state, schemaVersion: 1, hostPort: 12345, devicePort: 12345 });
  const requests: Record<string, unknown>[] = [];
  const mock: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: platform === 'ios' ? REQUIRED_IOS_COMMANDS : REQUIRED_ANDROID_COMMANDS,
        capabilities: [
          ...(platform === 'ios' ? REQUIRED_IOS_FEATURES : REQUIRED_ANDROID_FEATURES),
          'PLATFORM_PRESENCE_V2',
          ...(capable ? ['QA_READ_ONLY_V1'] : []),
        ],
      });
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(response);
  };
  (platform === 'ios' ? iosFetch : androidFetch)(mock);
  return { requests, run: platform === 'ios' ? runIOS : runAndroid };
}

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} settle reads ${platform === 'ios' ? 'omit the dispatch context' : 'propagate QA no-activation policy'}`, async () => {
    const { requests } = fixture(platform);
    const context = new QaDispatchContext(10, () => 1);
    const probes = (platform === 'ios' ? buildIosProbes : buildAndroidProbes)('qa.app', context);
    await probes.snapshotHash();
    if (platform === 'ios') await probes.snapshotHash();
    else await probes.isWindowUpdating!(100);
    assert.equal(requests.length, 2);
    assert.ok(
      requests.every((request) => request.qaReadOnly === (platform === 'ios' ? undefined : true)),
    );
  });
  test(`${platform} settle without read-only capability ${platform === 'ios' ? 'leaves the dispatch context intact' : 'invalidates the QA context'}`, async () => {
    const { requests } = fixture(platform, false);
    const context = new QaDispatchContext(10, () => 1);
    const probes = (platform === 'ios' ? buildIosProbes : buildAndroidProbes)('qa.app', context);
    await probes.snapshotHash();
    if (platform === 'ios') {
      assert.equal(requests.length, 1);
      assert.doesNotThrow(() => context.assertComplete());
    } else {
      assert.deepEqual(requests, []);
      assert.throws(() => context.assertComplete(), /ACTION_CONTEXT_CHANGED/);
    }
  });
  test(`${platform} post-dispatch settle reads do not retrospectively expire completed work`, async () => {
    const { requests, run } = fixture(platform);
    let now = 1;
    const context = new QaDispatchContext(10, () => now);
    await run({ command: 'back', bundleId: 'qa.app', qaContext: context });
    now = 11;
    const probes = (platform === 'ios' ? buildIosProbes : buildAndroidProbes)('qa.app', context);
    await probes.snapshotHash();
    if (platform === 'ios') await probes.snapshotHash();
    else await probes.isWindowUpdating!(100);
    assert.equal(requests.length, 3);
    assert.equal(context.authorizations, 1);
    assert.doesNotThrow(() => context.assertComplete());
  });
  for (const command of ['snapshot', 'verifyInput'] as const) {
    test(`${platform} QA ${command} carries native no-activation policy`, async () => {
      const { requests, run } = fixture(platform);
      await run({ command, bundleId: 'qa.app', qaContext: new QaDispatchContext(10, () => 1) });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].qaReadOnly, true);
    });
  }
  test(`${platform} explicit capture read policy does not require an action context`, async () => {
    const { requests, run } = fixture(platform);
    await run({ command: 'snapshot', bundleId: 'qa.app', qaReadOnly: true });
    assert.equal(requests[0]?.qaReadOnly, true);
  });
  test(`${platform} a sent mutation does not acquire the native read-only policy`, async () => {
    const { requests, run } = fixture(platform);
    await run({
      command: 'back',
      bundleId: 'qa.app',
      qaContext: new QaDispatchContext(10, () => 1),
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].qaReadOnly, undefined);
  });
  test(`${platform} refuses old native without no-activation capability before sending a read`, async () => {
    const { requests, run } = fixture(platform, false);
    const context = new QaDispatchContext(10, () => 1);
    await assert.rejects(
      run({ command: 'snapshot', bundleId: 'qa.app', qaContext: context }),
      /ACTION_CONTEXT_CHANGED/,
    );
    assert.deepEqual(requests, []);
    assert.throws(() => context.assertComplete(), /ACTION_CONTEXT_CHANGED/);
  });
  for (const code of [
    'KEYBOARD_TARGET_STALE',
    'STALE_REF',
    'NO_TEXT_INPUT_TARGET',
    'TEXT_TARGET_FOCUS_FAILED',
    'ACTION_CONTEXT_CHANGED',
  ]) {
    for (const mutation of ['none', 'possible']) {
      test(`${platform} native ${code} with mutation ${mutation} latches invalidation after an authorized send`, async () => {
        const { requests, run } = fixture(platform, true, {
          ok: false,
          error: { code, message: code, mutation },
        });
        const context = new QaDispatchContext(10, () => 1);
        await assert.rejects(
          run({ command: 'tap', x: 1, y: 2, bundleId: 'qa.app', qaContext: context }),
          /ACTION_CONTEXT_CHANGED/,
        );
        assert.equal(requests.length, 1);
        assert.equal(context.authorizations, 1);
        assert.throws(() => context.assertComplete(), /ACTION_CONTEXT_CHANGED/);
        assert.equal(
          context.refusedBeforeMutation,
          mutation === 'none' &&
            ['KEYBOARD_TARGET_STALE', 'STALE_REF', 'NO_TEXT_INPUT_TARGET'].includes(code),
        );
      });
    }
  }
  for (const verifyVerdict of ['target-lost', 'ambiguous']) {
    test(`${platform} ${verifyVerdict} verification invalidates the retained target`, async () => {
      const { run } = fixture(platform, true, {
        ok: true,
        data: { verifyVerdict, verifyStable: false },
      });
      const context = new QaDispatchContext(10, () => 1);
      await assert.rejects(
        run({ command: 'verifyInput', bundleId: 'qa.app', qaContext: context }),
        /ACTION_CONTEXT_CHANGED/,
      );
      assert.equal(context.authorizations, 0);
    });
  }
  test(`${platform} unread verification of a field that left the screen keeps the dispatch context`, async () => {
    const { run } = fixture(platform, true, {
      ok: true,
      data: { verifyVerdict: 'unreadable', verifyStable: false },
    });
    const context = new QaDispatchContext(10, () => 1);
    const result = await run({ command: 'verifyInput', bundleId: 'qa.app', qaContext: context });
    assert.doesNotThrow(() => context.assertComplete());
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text).data;
    assert.equal(data.verifyVerdict, 'unreadable');
    assert.equal(data.verifyStable, false);
  });
}

for (const reason of [
  'exact-target-missing',
  'exact-target-ambiguous',
  'exact-target-unresolved',
  'exact-target-not-hittable',
  'app-window-unavailable',
]) {
  test(`Android ${reason} cannot enter ordinary failure handling`, async () => {
    const { run } = fixture('android', true, {
      ok: false,
      error: { code: 'INTERACTION_NOT_ACTUATED', reason, message: reason, mutation: 'none' },
    });
    const context = new QaDispatchContext(10, () => 1);
    await assert.rejects(
      run({ command: 'tap', bundleId: 'qa.app', qaContext: context }),
      /ACTION_CONTEXT_CHANGED/,
    );
    assert.equal(context.authorizations, 1);
    assert.equal(context.refusedBeforeMutation, reason.startsWith('exact-target-'));
  });
}

test('Android ordinary accessibility-action rejection is not identity invalidation', async () => {
  const { run } = fixture('android', true, {
    ok: false,
    error: {
      code: 'INTERACTION_NOT_ACTUATED',
      reason: 'accessibility-action-rejected',
      message: 'rejected',
      mutation: 'none',
    },
  });
  const context = new QaDispatchContext(10, () => 1);
  const result = await run({ command: 'tap', bundleId: 'qa.app', qaContext: context });
  assert.equal(result.isError, true);
  assert.doesNotThrow(() => context.assertComplete());
});

for (const platform of ['ios', 'android'] as const) {
  for (const command of ['snapshot', 'verifyInput'] as const) {
    test(`${platform} refused QA ${command} neither retries nor activates`, async () => {
      const { requests, run } = fixture(platform, true, {
        ok: false,
        error: { code: 'ACTION_CONTEXT_CHANGED', message: 'app is backgrounded' },
      });
      const context = new QaDispatchContext(10, () => 1);
      await assert.rejects(
        run({ command, bundleId: 'qa.app', qaContext: context }),
        /ACTION_CONTEXT_CHANGED/,
      );
      assert.deepEqual(
        requests.map((request) => request.command),
        [command],
      );
      assert.equal(requests[0].qaReadOnly, true);
      assert.equal(context.authorizations, 0);
      assert.throws(() => context.assertComplete(), /ACTION_CONTEXT_CHANGED/);
    });
  }
}
