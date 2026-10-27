import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  reapStaleFastRunner,
} from '../../dist/runners/rn-fast-runner-client.js';

const STATE = {
  pid: 12345,
  port: 22088,
  deviceId: 'sim-1',
  bundleId: 'com.example',
  processBirth: 'birth-12345',
};
const MATCHING = {
  status: 'present',
  birth: { pid: STATE.pid, source: 'darwin-libproc', token: STATE.processBirth },
} as const;
const ABSENT = { status: 'absent' } as const;

function probes(...results: Array<typeof MATCHING | typeof ABSENT>) {
  let index = 0;
  return () => results[Math.min(index++, results.length - 1)];
}

function harness(requestShutdown: () => Promise<boolean>) {
  const events: string[] = [];
  return {
    events,
    deps: {
      getState: () => STATE,
      requestShutdown: async () => {
        events.push('shutdown');
        return requestShutdown();
      },
      sendSignal: (_pid: number, sig: NodeJS.Signals) => {
        events.push(sig);
      },
      sleep: async (ms: number) => {
        events.push(`sleep ${ms}`);
      },
      clearState: () => {
        events.push('clear');
      },
      graceMs: 0,
    },
  };
}

afterEach(() => {
  _setFastRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
});

test('reap: an accepted shutdown that exits settles 150 ms and sends no signal', async () => {
  const { events, deps } = harness(async () => true);
  await reapStaleFastRunner({
    ...deps,
    probeProcessBirth: probes(MATCHING, MATCHING, MATCHING, ABSENT),
  });
  assert.deepEqual(events, ['shutdown', 'sleep 100', 'sleep 100', 'sleep 150', 'clear']);
});

test('reap: a runner still alive after the shutdown wait falls back to SIGTERM then SIGKILL', async () => {
  const { events, deps } = harness(async () => true);
  await reapStaleFastRunner({
    ...deps,
    shutdownWaitMs: 300,
    probeProcessBirth: probes(MATCHING, MATCHING, MATCHING, MATCHING, MATCHING, MATCHING, ABSENT),
  });
  assert.deepEqual(events, [
    'shutdown',
    'sleep 100',
    'sleep 100',
    'sleep 100',
    'SIGTERM',
    'sleep 0',
    'SIGKILL',
    'sleep 50',
    'clear',
  ]);
});

test('reap: a refused shutdown goes straight to the signal path', async () => {
  const { events, deps } = harness(async () => false);
  await reapStaleFastRunner({ ...deps, probeProcessBirth: probes(MATCHING, ABSENT) });
  assert.deepEqual(events, ['shutdown', 'SIGTERM', 'sleep 0', 'clear']);
});

test('reap: a rejected shutdown request still falls back to signals', async () => {
  const { events, deps } = harness(async () => {
    throw new Error('ECONNREFUSED');
  });
  await reapStaleFastRunner({ ...deps, probeProcessBirth: probes(MATCHING, ABSENT) });
  assert.deepEqual(events, ['shutdown', 'SIGTERM', 'sleep 0', 'clear']);
});

test('reap: unproven identity after shutdown refuses to signal', async () => {
  const { events, deps } = harness(async () => true);
  await assert.rejects(
    reapStaleFastRunner({
      ...deps,
      probeProcessBirth: probes(MATCHING, { status: 'unknown' } as never),
    }),
    /termination is unproven/,
  );
  assert.deepEqual(events, ['shutdown']);
});

test('reap: a cancelled teardown skips the shutdown request', async () => {
  const { events, deps } = harness(async () => true);
  const controller = new AbortController();
  controller.abort();
  await reapStaleFastRunner({
    ...deps,
    signal: controller.signal,
    probeProcessBirth: probes(MATCHING, ABSENT),
  });
  assert.deepEqual(events, ['SIGTERM', 'clear']);
});

test('reap: the default shutdown request posts the shutdown verb with the runner capability', async () => {
  _setFastRunnerStateForTest({ ...STATE, capability: 'c'.repeat(43) });
  const posted: Array<{ url: string; body: unknown; authorization: unknown }> = [];
  _setFetchForTest((async (url: string, init: RequestInit) => {
    posted.push({
      url,
      body: JSON.parse(String(init.body)),
      authorization: (init.headers as Record<string, string>).authorization,
    });
    return new Response(JSON.stringify({ ok: true, v: 2, data: { message: 'shutdown' } }));
  }) as typeof fetch);
  const signals: string[] = [];
  await reapStaleFastRunner({
    getState: () => STATE,
    probeProcessBirth: probes(MATCHING, ABSENT),
    sendSignal: (_pid, sig) => {
      signals.push(sig);
    },
    sleep: async () => {},
    clearState: () => {},
  });
  assert.deepEqual(posted, [
    {
      url: `http://127.0.0.1:${STATE.port}/command`,
      body: { command: 'shutdown' },
      authorization: `Bearer ${'c'.repeat(43)}`,
    },
  ]);
  assert.deepEqual(signals, []);
});
