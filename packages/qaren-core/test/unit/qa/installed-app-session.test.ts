import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { cancellationSignal } from '../../../dist/domain/cancellation.js';
import { QaDispatchError } from '../../../dist/domain/qa-dispatch.js';
import { HandlerError } from '../../../dist/qa/adapt.js';
import { openSession } from '../../../dist/qa/walk.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { JevError } from '../../../dist/qa/questions.js';
import { parsePlan, preparePlan } from '../../../dist/qa/plan.js';
import { failResult, okResult } from '../../../dist/utils.js';
import type { WireRequest } from '../../../dist/qa/wire.js';
import type { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const RECT = { x: 0, y: 0, width: 402, height: 874 };
const nodes = [
  { ref: 'e0', index: 0, parentIndex: -1, depth: 0, type: 'Application', rect: RECT },
  {
    ref: 'e1',
    index: 1,
    parentIndex: 0,
    depth: 1,
    type: 'Button',
    label: 'Start',
    rect: { x: 16, y: 780, width: 370, height: 48 },
  },
];
// Every read: a complete native tree of one app process, labelled as the dev launcher.
const snapshot = async () =>
  okResult(
    { appProcessIdentifier: 41, nodes, truncated: false, normalizationDroppedNodes: 0 },
    {
      meta: {
        foregroundSurface: 'dev_client_picker',
        snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
      },
    },
  );

test('an installed-app session opens without the debugger, the model or dev surfaces', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'qaren-installed-session-'));
  let serverRequests = 0;
  const server = createServer((_request, response) => {
    serverRequests++;
    response.setHeader('Content-Type', 'application/json');
    response.end('[]');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetches++;
    return realFetch(...args);
  }) as typeof fetch;
  const envKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'synthetic-environment-key';
  delete process.env.RN_KEYBOARD_GUARD;
  let close: (() => Promise<void>) | undefined;
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (envKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = envKey;
    await close?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  });
  const plan = '1. Tap "Start"';
  const request: WireRequest = {
    runId: 'synthetic-installed',
    t0: Date.now(),
    walkBudgetMs: 6000,
    attachBudgetMs: 2000,
    plan,
    prepared: preparePlan(plan, parsePlan(plan).blocks!),
    platform: 'ios',
    appId: 'com.example.synthetic',
    appRoot: root,
    runDir: scratch,
    lease: 'synthetic-installed:0123456789abcdef0123456789abcdef',
    target: {
      deviceId: '00000000-0000-0000-0000-000000000000',
      deviceName: 'Synthetic iPhone',
      metroPort: address.port,
      metroUrlForDevice: `http://127.0.0.1:${address.port}`,
      worktree: root,
    },
    appSource: 'installed',
  };
  const session = await openSession(
    request,
    () => undefined,
    () => undefined,
    (onClose) => {
      close = onClose;
    },
    new ObservedPrivacy(),
    undefined,
    () => undefined,
    'synthetic-argument-key',
    undefined,
    () => snapshot,
    async () => ({ active: false, warning: null, fromCache: false, scanMs: 0 }),
    async () => 41,
  );
  const { deps } = session;
  assert.equal(serverRequests, 0, 'nothing asked the debugger port');
  await assert.rejects(
    deps.judge.ask(
      'ready',
      { ready: { type: 'noul', instructions: 'The screen is ready.' } },
      'walk',
    ),
    (error: unknown) => error instanceof JevError && error.code === 'JEV_AUTH_FAILED',
  );
  assert.equal(fetches, 0, 'the judge made no request');
  assert.equal(deps.interruptionVeto, false);
  assert.equal(typeof deps.hideDevMenu, 'function');
  assert.equal(typeof deps.dismissKeyboard, 'function');
  for (const absent of [
    'typeFocused',
    'fillAlreadySet',
    'reactFocused',
    'setByHandler',
    'blurFocusedInput',
  ] as const)
    assert.equal(deps[absent], undefined, absent);
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  let screen;
  try {
    screen = await deps.captureScreen();
  } finally {
    process.stderr.write = write;
  }
  assert.equal(screen.front, 'app');
  assert.equal(screen.devError, undefined);
  assert.equal(screen.captureCoverage?.react, 'unknown');
  assert.doesNotMatch(written.join(''), /React coverage is unknown|interactive digest/);
  assert.equal(deps.publicationInterrupted?.(), false);
  assert.ok(!deps.continuityEvents?.().some((event) => event.signal === 'dev-client-picker'));
});

type SnapshotHandler = ReturnType<typeof createDeviceSnapshotHandler>;
type AppProcessRead = (appId: string, deviceId: string) => Promise<number | undefined>;

function start(
  handler: SnapshotHandler,
  appProcessId: AppProcessRead,
  options: {
    attachBudgetMs?: number;
    walkBudgetMs?: number;
    checkDriver?: () => Promise<unknown>;
  } = {},
) {
  const plan = '1. Tap "Start"';
  const request: WireRequest = {
    runId: 'synthetic-installed-start',
    t0: Date.now(),
    walkBudgetMs: options.walkBudgetMs ?? 6000,
    attachBudgetMs: options.attachBudgetMs ?? 2000,
    plan,
    prepared: preparePlan(plan, parsePlan(plan).blocks!),
    platform: 'ios',
    appId: 'com.example.synthetic',
    appRoot: root,
    runDir: root,
    lease: 'synthetic-installed-start:0123456789abcdef0123456789abcdef',
    target: {
      deviceId: '00000000-0000-0000-0000-000000000000',
      deviceName: 'Synthetic iPhone',
      metroPort: 65535,
      metroUrlForDevice: 'http://127.0.0.1:65535',
      worktree: root,
    },
    appSource: 'installed',
  };
  return openSession(
    request,
    () => undefined,
    () => undefined,
    () => undefined,
    new ObservedPrivacy(),
    undefined,
    () => undefined,
    undefined,
    undefined,
    () => handler,
    async () => {
      await options.checkDriver?.();
      return { active: false, warning: null, fromCache: false, scanMs: 0 };
    },
    appProcessId,
  );
}

const completeTree = (pid: number | undefined) =>
  okResult(
    { appProcessIdentifier: pid, nodes, truncated: false, normalizationDroppedNodes: 0 },
    {
      meta: {
        snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
      },
    },
  );

const processUnproven = 'INSTALLED_APP_PROCESS_UNPROVEN';
const processRead = 'process-read:com.example.synthetic:00000000-0000-0000-0000-000000000000';
const bindCall = 'bind:false';
const proofCall = 'proof-read:undefined';

function refusal(code: string, message?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HandlerError);
    assert.equal(error.code, code);
    assert.equal(error.meta, undefined);
    if (message) assert.match(error.message, message);
    return true;
  };
}

type BindingCase = {
  name: string;
  launched?: AppProcessRead;
  bind?: SnapshotHandler;
  skipBinding?: boolean;
  read?: SnapshotHandler;
  code?: string;
  message?: RegExp;
  calls: string[];
};

const bindingCases: BindingCase[] = [
  {
    name: 'binds before the first read-only capture',
    calls: [processRead, 'open', bindCall, proofCall],
  },
  {
    name: 'refuses a missing pre-open process',
    launched: async () => undefined,
    code: processUnproven,
    message: /process-read: no process/,
    calls: [processRead],
  },
  {
    name: 'refuses a failed pre-open process read',
    launched: async () => {
      throw new Error('private diagnostic');
    },
    code: processUnproven,
    message: /process-read: process read failed/,
    calls: [processRead],
  },
  ...[41, 42].map((proofPid) => ({
    name: `refuses a different process at bind before proof could return ${proofPid}`,
    bind: async () => completeTree(42),
    read: async () => completeTree(proofPid),
    code: processUnproven,
    message: /bind: process 41 became 42/,
    calls: [processRead, 'open', bindCall, 'close'],
  })),
  {
    name: 'refuses a bind without a process id',
    bind: async () => completeTree(undefined),
    code: processUnproven,
    message: /bind: no process id in the read/,
    calls: [processRead, 'open', bindCall, 'close'],
  },
  {
    name: 'reports a failed bind with its inner code',
    bind: async () => failResult('private diagnostic', 'RN_FAST_RUNNER_DOWN'),
    code: 'INSTALLED_APP_BIND_FAILED',
    message: /\(RN_FAST_RUNNER_DOWN\)$/,
    calls: [processRead, 'open', bindCall, 'close'],
  },
  {
    name: 'refuses an ordinary read that did not bind the target',
    skipBinding: true,
    code: 'INSTALLED_APP_READ_FAILED',
    message: /\(ACTION_CONTEXT_CHANGED\)$/,
    calls: [processRead, 'open', bindCall, proofCall, 'close'],
  },
  {
    name: 'refuses a different process at proof',
    read: async () => completeTree(42),
    code: processUnproven,
    message: /proof-read: process 41 became 42/,
    calls: [processRead, 'open', bindCall, proofCall, 'close'],
  },
  {
    name: 'refuses a proof without a process id',
    read: async () => completeTree(undefined),
    code: processUnproven,
    message: /proof-read: no process id in the read/,
    calls: [processRead, 'open', bindCall, proofCall, 'close'],
  },
  {
    name: 'refuses a process that exited before proof',
    read: async () =>
      failResult('private diagnostic', {
        code: 'ACTION_CONTEXT_CHANGED',
        reason: 'app-not-running',
      }),
    code: processUnproven,
    message: /proof-read: app not running/,
    calls: [processRead, 'open', bindCall, proofCall, 'close'],
  },
  {
    name: 'admits an empty truncated proof from the same process',
    read: async () => okResult({ appProcessIdentifier: 41, nodes: [], truncated: true }),
    calls: [processRead, 'open', bindCall, proofCall],
  },
];

for (const entry of bindingCases) {
  test(`installed-app start ${entry.name}`, async () => {
    const calls: string[] = [];
    let bound = false;
    const starting = start(
      async (args) => {
        if (args.action !== 'snapshot') {
          calls.push(args.action);
          if (args.action === 'open') assert.equal(args.attachOnly, false);
          return okResult({});
        }
        if (args.qaReadOnly) {
          calls.push(`proof-read:${args.leakRecovery}`);
          if (!bound) throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
          return entry.read?.(args) ?? completeTree(41);
        }
        calls.push(`bind:${args.leakRecovery}`);
        bound = !entry.skipBinding;
        return entry.bind?.(args) ?? completeTree(41);
      },
      async (appId, deviceId) => {
        calls.push(`process-read:${appId}:${deviceId}`);
        return entry.launched ? entry.launched(appId, deviceId) : 41;
      },
    );

    if (entry.code) {
      await assert.rejects(starting, refusal(entry.code, entry.message));
      assert.deepEqual(calls, entry.calls);
    } else {
      const session = await starting;
      try {
        if (!entry.read) {
          const screen = await session.deps.captureScreen();
          assert.equal(screen.appProcessIdentifier, 41);
          assert.equal(session.deps.publicationInterrupted?.(), false);
          assert.equal(calls.pop(), proofCall, 'the walk still uses a read-only capture');
        }
        assert.deepEqual(calls, entry.calls);
      } finally {
        await session.close();
      }
    }
  });
}

const openTimeout = refusal('INSTALLED_APP_OPEN_TIMEOUT', /stage session-open/);

for (const options of [
  { attachBudgetMs: 400, walkBudgetMs: 60_000, limit: 'attach budget' },
  { attachBudgetMs: 60_000, walkBudgetMs: 1700, limit: 'remaining walk budget' },
]) {
  test(
    `installed-app start uses the ${options.limit} and waits for open cleanup`,
    { timeout: 5000 },
    async () => {
      const started = performance.now();
      let abortedAt: number | undefined;
      const calls: string[] = [];
      await assert.rejects(
        start(
          async ({ action }) => {
            calls.push(action);
            assert.notEqual(action, 'snapshot');
            if (action === 'close') return okResult({});
            const signal = cancellationSignal();
            if (!signal) return new Promise(() => undefined);
            await once(signal, 'abort');
            abortedAt = performance.now() - started;
            await delay(100);
            calls.push('cleaned');
            throw signal.reason;
          },
          async () => 41,
          { ...options, checkDriver: () => delay(300) },
        ),
        openTimeout,
      );
      assert.ok(abortedAt !== undefined);
      if (options.attachBudgetMs === 400)
        assert.ok(abortedAt >= 350 && abortedAt < 650, abortedAt.toString());
      else assert.ok(performance.now() - started < 2000);
      assert.deepEqual(calls, ['open', 'cleaned', 'close']);
    },
  );
}

test(
  'installed-app start limits the wait for an open that never cleans up',
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls: string[] = [];
    let settled = false;
    const starting = start(
      async ({ action }) => {
        calls.push(action);
        if (action === 'open') return new Promise(() => undefined);
        return okResult({});
      },
      async () => 41,
      {
        attachBudgetMs: 400,
        checkDriver: () => new Promise((resolve) => setTimeout(resolve, 300)),
      },
    );
    const rejected = assert.rejects(starting, openTimeout).then(() => {
      settled = true;
    });
    t.mock.timers.tick(300);
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['open']);
    t.mock.timers.tick(150);
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.deepEqual(calls, ['open']);
    t.mock.timers.tick(35_000);
    await rejected;
    assert.deepEqual(calls, ['open', 'close']);
  },
);

test('installed-app start refuses an open that outruns its timer', { timeout: 5000 }, async () => {
  const calls: string[] = [];
  await assert.rejects(
    start(
      async ({ action }) => {
        calls.push(action);
        if (action === 'open') {
          const until = performance.now() + 500;
          while (performance.now() < until) {
            /* Keep the timer from firing before open resolves. */
          }
        }
        return completeTree(41);
      },
      async () => 41,
      { attachBudgetMs: 400 },
    ),
    openTimeout,
  );
  assert.deepEqual(calls, ['open', 'close']);
});

function captureStartLog(t: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const prefix = 'qaren-core: installed app: ';
    const line = String(chunk);
    if (line.startsWith(prefix)) {
      lines.push(line.slice(prefix.length).trimEnd());
      return true;
    }
    return Reflect.apply(write, process.stderr, [chunk, ...rest]);
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
  return lines;
}

test('installed-app start logs each stage and its process proof', async (t) => {
  // A fractional clock origin can put the deadline difference just above the budget.
  t.mock.method(performance, 'now', () => 1000.3);
  const lines = captureStartLog(t);
  const session = await start(
    async () => completeTree(41),
    async () => 41,
  );
  try {
    assert.deepEqual(
      lines.slice(0, -1).map((line) => line.replace(/\d+ ms/g, '<ms> ms')),
      [
        'start (budget 2 s)',
        'driver-check done in <ms> ms',
        'process-read done in <ms> ms, process 41',
        'session-open done in <ms> ms',
        'bind done in <ms> ms, process 41',
        'proof-read done in <ms> ms, process 41',
        'start done in <ms> ms',
      ],
    );
    assert.match(lines.at(-1)!, /^no debugger and no bundle proof/);
  } finally {
    await session.close();
  }
});

test('installed-app start logs while open is pending and stops after admission', async (t) => {
  t.mock.method(performance, 'now', () => 20_000.2);
  const lines = captureStartLog(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const starting = start(
    async ({ action }) => {
      if (action === 'open') {
        entered.resolve();
        await pending.promise;
      }
      return completeTree(41);
    },
    async () => 41,
    { attachBudgetMs: 120_000, walkBudgetMs: 125_000 },
  );
  await entered.promise;
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(10_000);
  pending.resolve();
  const session = await starting;
  try {
    t.mock.timers.tick(10_000);
    const progress = lines.filter((line) => line.includes(' running for '));
    assert.equal(progress.length, 2);
    for (const line of progress) {
      assert.match(
        line,
        /^session-open running for \d+ s of 120 s; a first start on a simulator builds or downloads the runner$/,
      );
    }
  } finally {
    await session.close();
  }
});
