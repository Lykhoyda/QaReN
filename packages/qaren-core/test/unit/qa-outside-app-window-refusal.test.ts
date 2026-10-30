import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { _setActiveSessionForTest, runNative } from '../../dist/agent-device-wrapper.js';
import { QaDispatchContext } from '../../dist/domain/qa-dispatch.js';
import { clearRefMap, updateRefMapFromFlat } from '../../dist/fast-runner-ref-map.js';
import { _setFetchForTest } from '../../dist/runners/qaren-android-runner-client.js';

const appId = 'com.example.app';
const appHome = {
  ref: '@e1',
  type: 'android.widget.TextView',
  label: 'Home',
  identifier: 'tab-home',
  packageName: appId,
  rect: { x: 0, y: 700, width: 180, height: 80 },
};
const systemHome = {
  ref: '@e2',
  type: 'android.widget.ImageView',
  label: 'Home',
  identifier: 'home',
  packageName: 'com.android.systemui',
  rect: { x: 180, y: 780, width: 80, height: 80 },
};

afterEach(() => {
  clearRefMap();
  _setFetchForTest(globalThis.fetch);
  _setActiveSessionForTest(null);
});

test('a QA press on a system window ref refuses OUTSIDE_APP_WINDOW and leaves the dispatch context clean', async () => {
  updateRefMapFromFlat([appHome, systemHome]);
  _setActiveSessionForTest({
    name: 'outside-app-window',
    platform: 'android',
    appId,
    deviceId: 'emulator-5554',
    openedAt: '2026-10-17T00:00:00.000Z',
  });
  const posted: string[] = [];
  _setFetchForTest(async (input) => {
    posted.push(String(input));
    throw new Error(`no runner request is allowed: ${String(input)}`);
  });
  const context = new QaDispatchContext(Number.MAX_SAFE_INTEGER, () => 1);

  const result = await runNative(['press', systemHome.ref], {
    qaContext: context,
  });
  const envelope = JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    code?: string;
    meta?: Record<string, unknown>;
  };

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'OUTSIDE_APP_WINDOW');
  assert.equal(envelope.meta?.mutation, 'none');
  assert.deepEqual(posted, []);
  assert.equal(context.authorizations, 0);
  assert.doesNotThrow(() => context.assertComplete());
});
