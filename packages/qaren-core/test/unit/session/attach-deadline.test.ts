// Within an attach deadline, connect-time reads wait on the runtime's answer until that deadline, not a fixed 5 s.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CDPClient } from '../../../dist/cdp-client.js';
import { INJECTED_HELPERS } from '../../../dist/injected-helpers.js';
import { CDPProbeTimeoutError } from '../../../dist/cdp/connect.js';
import { TargetReadinessTimeoutError } from '../../../dist/cdp/discovery.js';
import { NO_REPLY, startFakeCDP } from '../../helpers/fake-cdp-server.js';

const APP = 'com.example.app';
const DEV_CHECK = 'typeof __DEV__ !== "undefined" && __DEV__ === true';
const PAST_DEFAULT_MS = 5_600;

async function fakeApp(slow: (expression: string) => boolean) {
  const fake = await startFakeCDP(0, {
    targets: [
      {
        id: 'owned-1',
        title: `${APP} (iPhone)`,
        description: 'React Native Bridgeless [C++ connection]',
        appId: APP,
        type: 'node',
        deviceName: 'iPhone',
      },
    ],
  });
  fake.setResponse('Runtime.evaluate', async (params: unknown) => {
    const expression = (params as { expression?: string }).expression ?? '';
    if (slow(expression)) await delay(PAST_DEFAULT_MS);
    return { result: { type: 'boolean', value: true } };
  });
  return fake;
}

async function attach(port: number, deadline?: number) {
  const client = new CDPClient(port);
  try {
    await client.connectExact(
      port,
      { platform: 'ios', bundleId: APP },
      'default',
      1,
      undefined,
      deadline,
    );
    return { targetId: client.connectedTarget?.id, helpersInjected: client.helpersInjected };
  } finally {
    await client.disconnect();
  }
}

test('a dev check answering after 5 s still attaches within the attach deadline', async (t) => {
  const fake = await fakeApp((expression) => expression === DEV_CHECK);
  t.after(() => fake.close());
  const { targetId } = await attach(fake.port, performance.now() + 20_000);
  assert.equal(targetId, 'owned-1');
});

test('helper injection answering after 5 s is injected within the attach deadline', async (t) => {
  const fake = await fakeApp((expression) => expression === INJECTED_HELPERS);
  t.after(() => fake.close());
  const { helpersInjected } = await attach(fake.port, performance.now() + 20_000);
  assert.equal(helpersInjected, true);
});

test('without an attach deadline the dev check keeps its default request timeout', async (t) => {
  const fake = await fakeApp((expression) => expression === DEV_CHECK);
  t.after(() => fake.close());
  await assert.rejects(attach(fake.port), /CDP timeout \(5000ms\): Runtime\.evaluate/);
});

test('a dev check that never answers ends at the attach deadline as a readiness timeout', async (t) => {
  const fake = await fakeApp(() => false);
  fake.setResponse('Runtime.evaluate', (params: unknown) =>
    (params as { expression?: string }).expression === DEV_CHECK
      ? NO_REPLY
      : { result: { type: 'boolean', value: true } },
  );
  t.after(() => fake.close());
  const started = performance.now();
  await assert.rejects(
    attach(fake.port, started + 4_000),
    (error) =>
      error instanceof TargetReadinessTimeoutError || error instanceof CDPProbeTimeoutError,
  );
  assert.ok(performance.now() - started < 4_900);
});
