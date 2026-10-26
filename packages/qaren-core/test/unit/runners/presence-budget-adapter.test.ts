import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  _setCapabilitiesForTest,
  _setFetchForTest,
  _setRunnerStateForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { nativeCapture } from '../qa/platform-presence-fixtures.ts';

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

function requestsWith(capabilities: string[]): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', ...capabilities],
      });
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, data: nativeCapture() });
  });
  return requests;
}

test('missing, V1 and lookalike presence capabilities refuse without legacy snapshot fallback', async () => {
  for (const capabilities of [[], ['PLATFORM_PRESENCE_V1'], ['PLATFORM_PRESENCE_V20']]) {
    const requests = requestsWith(capabilities);
    const result = parseEnvelope(
      await runIOS({
        command: 'snapshot',
        bundleId: 'com.test',
        platformPresence: true,
        presenceBudgetMs: 20_000,
      }),
    );
    assert.equal(result.ok, false, capabilities.join(','));
    assert.deepEqual(requests, [], capabilities.join(','));
    assert.equal(result.meta?.mutation, 'none');
    assert.equal(result.meta?.dispatched, false);
  }
});

test('V2 serializes the actual positive integer budget without replacing it with a policy default', async () => {
  for (const presenceBudgetMs of [1, 19_999, 20_000, 25_000]) {
    const requests = requestsWith(['PLATFORM_PRESENCE_V2']);
    const result = parseEnvelope(
      await runIOS({
        command: 'snapshot',
        bundleId: 'com.test',
        platformPresence: true,
        presenceBudgetMs,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].presenceBudgetMs, presenceBudgetMs);
    assert.equal(requests[0].platformPresence, true);
  }
});

test('missing and malformed presence budgets refuse before a snapshot send', async () => {
  for (const presenceBudgetMs of [
    undefined,
    null,
    0,
    -1,
    1.5,
    '20000',
    true,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const requests = requestsWith(['PLATFORM_PRESENCE_V2']);
    const result = parseEnvelope(
      await runIOS({
        command: 'snapshot',
        bundleId: 'com.test',
        platformPresence: true,
        presenceBudgetMs,
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.deepEqual(requests, []);
  }
});
