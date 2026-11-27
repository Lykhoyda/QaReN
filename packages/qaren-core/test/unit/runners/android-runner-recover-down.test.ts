import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  recoverDownAndroidRunner,
} from '../../../dist/runners/qaren-android-runner-client.js';

const live = {
  schemaVersion: 1,
  hostPort: 23456,
  devicePort: 7912,
  pid: 1234,
  deviceId: 'emulator-5554',
  bundleId: 'dev.fixture',
  startedAt: 'now',
  protocolVersion: 2,
} as const;

afterEach(() => {
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
});

const start = (calls: string[], answer: () => Promise<unknown>) => async (s: string, b: string) => {
  calls.push(`${s} ${b}`);
  return (await answer()) as never;
};

test('A1 no runner and no permission: down, nothing started', async () => {
  const calls: string[] = [];
  const outcome = await recoverDownAndroidRunner(
    'emulator-5554',
    'dev.fixture',
    false,
    start(calls, async () => assert.fail('no start without permission')),
  );
  assert.equal(outcome, 'down');
  assert.deepEqual(calls, []);
});

test('A2 a runner that answers healthy is alive and is not started', async () => {
  _setAndroidRunnerStateForTest(live as never);
  _setFetchForTest(async () => Response.json({ ok: true }));
  const calls: string[] = [];
  const outcome = await recoverDownAndroidRunner(
    'emulator-5554',
    'dev.fixture',
    true,
    start(calls, async () => assert.fail('a healthy runner is not started')),
  );
  assert.equal(outcome, 'alive');
  assert.deepEqual(calls, []);
});

test('A3 an unreachable runner is started once and answers relaunched', async () => {
  _setAndroidRunnerStateForTest(live as never);
  _setFetchForTest(async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  });
  const calls: string[] = [];
  const outcome = await recoverDownAndroidRunner(
    'emulator-5554',
    'dev.fixture',
    true,
    start(calls, async () => ({ ...live, hostPort: 23457 })),
    async () => assert.fail('a runner the host still knows is reaped by the start path'),
  );
  assert.equal(outcome, 'relaunched');
  assert.deepEqual(calls, ['emulator-5554 dev.fixture']);
});

test('A4 a start that fails is down', async () => {
  const calls: string[] = [];
  const outcome = await recoverDownAndroidRunner(
    'emulator-5554',
    'dev.fixture',
    true,
    start(calls, async () => {
      throw new Error('instrumentation did not start');
    }),
    async () => {},
  );
  assert.equal(outcome, 'down');
  assert.equal(calls.length, 1);
});

test('A5 a cancelled start is rethrown, never answered', async () => {
  const abort = new DOMException('stopped', 'AbortError');
  await assert.rejects(
    recoverDownAndroidRunner(
      'emulator-5554',
      'dev.fixture',
      true,
      start([], async () => {
        throw abort;
      }),
      async () => {},
    ),
    (error) => error === abort,
  );
});

test('A6 a runner the host no longer knows is reaped on the device before the one start', async () => {
  const order: string[] = [];
  const outcome = await recoverDownAndroidRunner(
    'emulator-5554',
    'dev.fixture',
    true,
    async () => {
      order.push('start');
      return live as never;
    },
    async (serial) => {
      order.push(`reap ${serial}`);
    },
  );
  assert.equal(outcome, 'relaunched');
  assert.deepEqual(order, ['reap emulator-5554', 'start']);
});

test("A7 a reply that refuses our credential is not QaReN's runner to restart", async () => {
  _setAndroidRunnerStateForTest(live as never);
  _setFetchForTest(async () => new Response('', { status: 401 }));
  const calls: string[] = [];
  const outcome = await recoverDownAndroidRunner(
    'emulator-5554',
    'dev.fixture',
    true,
    start(calls, async () => assert.fail('a foreign runner is not restarted')),
    async () => assert.fail('a foreign runner is not reaped'),
  );
  assert.equal(outcome, 'alive');
  assert.deepEqual(calls, []);
});
