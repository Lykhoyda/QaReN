import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createStop } from '../../../dist/qa/stop.js';
import { admit, formatAdmissionRefusal, type AdmissionSteps } from '../../../dist/qa/admission.js';
import { cleanAdmissionFacts } from '../../../dist/qa/admission-facts.js';
import { fetchTargets, waitForExactPortTargets } from '../../../dist/cdp/discovery.js';
import { DevTargetUnavailableError } from '../../../dist/domain/dev-target.js';
import { HandlerError } from '../../../dist/qa/adapt.js';
import { REACT_READY_POLL_MS, REACT_READY_TIMEOUT_MS } from '../../../dist/cdp/setup.js';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;
// Generous for a loaded host: only the read that never answers is meant to reach its limit.
const READ_MS = 10_000;
const DEVICE = 'qaren-check';
const APP = 'com.example.app';

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function answering(body: string): Promise<{ port: number; server: HttpServer }> {
  const server = createHttp((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, server };
}

function stopServer(server: HttpServer): void {
  server.closeAllConnections();
  server.close();
}

// The wait the walk wires: one readiness window of the real target-list poll (qa/walk.ts).
function steps(port: number, extra: Partial<AdmissionSteps> = {}) {
  const started = performance.now();
  const stop = createStop();
  const walkMs = 60_000;
  const remainingMs = () => Math.max(0, walkMs - (performance.now() - started));
  const wired: AdmissionSteps = {
    metroPort: port,
    readinessMs: REACT_READY_TIMEOUT_MS,
    attachBudgetMs: 20_000,
    remainingMs,
    waitTargets: async (deadline) => {
      const window = Math.max(
        1,
        Math.floor(Math.min(REACT_READY_TIMEOUT_MS, remainingMs(), deadline - performance.now())),
      );
      await waitForExactPortTargets(port, window, REACT_READY_POLL_MS, stop.signal, DEVICE, APP);
    },
    attach: async () => undefined,
    foreignDriver: async () => undefined,
    open: async () => undefined,
    prove: async () => PROVEN,
    close: async () => undefined,
    load: () => 1,
    ...extra,
  };
  return { wired, stop };
}

const iosProbes: Partial<AdmissionSteps> = {
  appAlive: async () => true,
  bundleRequested: async () => true,
  relaunch: async () => undefined,
  manifest: async () => ({ ms: 1, attempts: 1 }),
};
const androidProbes: Partial<AdmissionSteps> = {
  startCounts: () => ({ bundleRequest: 'received', bundleBuilt: 'none' }),
  startProcess: async () => true,
};

async function refusal(run: Promise<unknown>): Promise<HandlerError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof HandlerError, String(error));
    return error;
  }
  throw new Error('admitted');
}

const kindOf = async (read: Promise<unknown>): Promise<string> =>
  read.then(
    () => 'answered',
    (error: unknown) => (error as Error).constructor.name,
  );

// C1. On the base a refused connection is an ordinary Error, the same as every case of C2.
test('a refused connection to the target list has its own error', async () => {
  const port = await closedPort();
  assert.equal(await kindOf(fetchTargets(port, READ_MS)), 'TargetListUnreachableError');
  await assert.rejects(fetchTargets(port, READ_MS), {
    message: `Failed to list CDP targets on port ${port}: fetch failed`,
  });
});

// C1b. The run's port answers with a redirect to a port nothing listens on: the refused connection is not the
// requested port's, so it is an ordinary error. Fails on a build that looks at the error code alone.
test('a refusal met after a redirect to another port is not the requested port refusing', async () => {
  const elsewhere = await closedPort();
  const redirecting = createHttp((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', `http://127.0.0.1:${elsewhere}/json/list`);
    response.end();
  });
  await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
  const port = (redirecting.address() as { port: number }).port;
  try {
    assert.equal(await kindOf(fetchTargets(port, READ_MS)), 'Error');
  } finally {
    stopServer(redirecting);
  }
});

// C1c. A failure after the port has answered is never the connection's, whatever it looks like.
// Fails on a build that classifies any error caught around the read.
test('a failure after the port answered is not a refused connection', async () => {
  const { port, server } = await answering('[]');
  let calls = 0;
  try {
    const kind = await kindOf(
      fetchTargets(port, READ_MS, undefined, {
        deviceName: DEVICE,
        onPagesObserved: () => {
          if (++calls === 1)
            throw Object.assign(new Error('observer failed'), {
              cause: { code: 'ECONNREFUSED', address: '127.0.0.1', port },
            });
        },
      }),
    );
    assert.equal(kind, 'Error');
    assert.equal(calls, 2);
  } finally {
    stopServer(server);
  }
});

// C2. Fails on a build that names any failed read "unreachable".
test('every other failed target-list read keeps its class', async () => {
  for (const [name, body] of [
    ['not JSON', 'not json'],
    ['not a list', '{}'],
  ] as const) {
    const { port, server } = await answering(body);
    try {
      assert.equal(await kindOf(fetchTargets(port, READ_MS)), 'Error', name);
    } finally {
      stopServer(server);
    }
  }

  const reset: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => reset.listen(0, '127.0.0.1', resolve));
  const resetPort = (reset.address() as { port: number }).port;
  try {
    assert.equal(await kindOf(fetchTargets(resetPort, READ_MS)), 'Error', 'a reset connection');
  } finally {
    reset.close();
  }

  const held: Socket[] = [];
  const hung: Server = createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
  const hungPort = (hung.address() as { port: number }).port;
  try {
    assert.equal(
      await kindOf(fetchTargets(hungPort, 300)),
      'TargetListAttemptTimeoutError',
      'a list that never answers',
    );
  } finally {
    for (const socket of held) socket.destroy();
    hung.close();
  }
});

// C3. The admission refusal for a port that refuses from the start, as the wire carries it (iOS wiring).
test('admission names a refused target list, with the facts the CLI receives', async () => {
  const port = await closedPort();
  const { wired, stop } = steps(port, iosProbes);
  const error = await refusal(admit(wired, stop));
  assert.equal(error.code, 'CDP_NOT_CONNECTED');
  const facts = cleanAdmissionFacts(error.meta);
  assert.ok(facts, 'the facts pass the wire filter');
  const { elapsedMs, remainingMs, budgetMs, ...closed } = facts;
  assert.deepEqual(closed, {
    attempt: 1,
    lastStarted: 'attach',
    lastCompleted: 'none',
    inner: 'target_list_unreachable',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'alive',
    bundleRequest: 'received',
  });
  assert.ok(elapsedMs < 5_000 && remainingMs > 50_000 && budgetMs > 59_000);
  assert.match(
    formatAdmissionRefusal(error.meta, 'wait_targets'),
    /"inner":"target_list_unreachable"/,
  );
});

// C4. Metro answers an empty list at least once, then its port closes inside the same readiness window.
test('a port that closes during the target wait gives the same class on the first attempt', async () => {
  let answers = 0;
  let closing: ReturnType<typeof setTimeout> | undefined;
  const server = createHttp((_request, response) => {
    response.setHeader('content-type', 'application/json');
    // Close only once an empty list has been fully written, so the next poll meets a closed port.
    response.end('[]', () => {
      answers += 1;
      closing ??= setTimeout(() => stopServer(server), 100);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const { wired, stop } = steps(port, iosProbes);
  let error: HandlerError;
  try {
    error = await refusal(admit(wired, stop));
  } finally {
    clearTimeout(closing);
    stopServer(server);
  }
  assert.ok(answers >= 1, 'an empty list was answered before the port closed');
  const facts = cleanAdmissionFacts(error.meta);
  assert.equal(facts?.inner, 'target_list_unreachable');
  assert.equal(facts?.attempt, 1);
  assert.equal(facts?.lastStarted, 'attach');
  assert.equal(facts?.lastCompleted, 'none');
});

// C5. Android's wiring: the same class, with the process and Metro's counts read at the refusal.
test('android carries the same class with its process and count reads', async () => {
  const port = await closedPort();
  const { wired, stop } = steps(port, androidProbes);
  const error = await refusal(admit(wired, stop));
  const facts = cleanAdmissionFacts(error.meta);
  assert.ok(facts);
  const { elapsedMs: _elapsed, remainingMs: _remaining, budgetMs: _budget, ...closed } = facts;
  assert.deepEqual(closed, {
    attempt: 1,
    lastStarted: 'attach',
    lastCompleted: 'none',
    inner: 'target_list_unreachable',
    relaunches: 0,
    relaunchFailed: false,
    liveness: 'alive',
    bundleRequest: 'received',
    bundleBuilt: 'none',
  });
});

// C5b. The same refusal when the run has no count signal, as in the CLI's scripted full-flow rows:
// iOS reports the request as unknown; Android reports it as unknown and carries no build outcome.
test('without a count signal the request is unknown on both platforms', async () => {
  for (const [name, probes, expected] of [
    [
      'ios',
      { ...iosProbes, bundleRequested: async () => undefined },
      { liveness: 'alive', bundleRequest: 'unknown' },
    ],
    [
      'android',
      {
        startCounts: () => ({ bundleRequest: 'unknown' as const }),
        startProcess: async () => true,
      },
      { liveness: 'alive', bundleRequest: 'unknown' },
    ],
  ] as const) {
    const port = await closedPort();
    const { wired, stop } = steps(port, probes);
    const facts = cleanAdmissionFacts((await refusal(admit(wired, stop))).meta);
    assert.ok(facts, name);
    const { elapsedMs: _elapsed, remainingMs: _remaining, budgetMs: _budget, ...closed } = facts;
    assert.deepEqual(
      closed,
      {
        attempt: 1,
        lastStarted: 'attach',
        lastCompleted: 'none',
        inner: 'target_list_unreachable',
        relaunches: 0,
        relaunchFailed: false,
        ...expected,
      },
      name,
    );
  }
});

// C6. A malformed answer ends the attach with its own class, whatever happens to the port afterwards.
// Fails on a build that takes the class from the words of the failed read instead of from how it failed.
test('a malformed answer keeps its class', async () => {
  const { port, server } = await answering('{}');
  const { wired, stop } = steps(port, iosProbes);
  let error: HandlerError;
  try {
    error = await refusal(admit(wired, stop));
  } finally {
    stopServer(server);
  }
  assert.equal(cleanAdmissionFacts(error.meta)?.inner, 'untyped');
});

// C7. The limit the plan states: once a target was seen without development mode, that finding stays.
test('an earlier development-mode finding keeps its class when the port then refuses', async () => {
  const port = await closedPort();
  let waits = 0;
  const { wired, stop } = steps(port, {
    ...iosProbes,
    waitTargets: async () => {
      if (++waits > 1)
        await waitForExactPortTargets(port, 1_000, REACT_READY_POLL_MS, stop.signal, DEVICE, APP);
    },
    attach: async () => {
      throw new DevTargetUnavailableError({
        targetsTotal: 1,
        devTrue: 0,
        devFalse: 0,
        devUndefined: 0,
        devUnknown: 1,
      });
    },
  });
  const error = await refusal(admit(wired, stop));
  assert.equal(waits, 2);
  assert.equal(cleanAdmissionFacts(error.meta)?.inner, 'no_dev_target_unknown');
});
