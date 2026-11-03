import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { parsePlan, preparePlan } from '../../../dist/qa/plan.js';
import type { Envelope, Refusal, WireRequest } from '../../../dist/qa/wire.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));

async function admission(
  t: TestContext,
  afterFalse:
    | 'empty'
    | 'pending'
    | 'replacement-id'
    | 'replacement-url'
    | 'unchanged'
    | 'late-empty',
) {
  const runDir = await mkdtemp(join(tmpdir(), 'qaren-empty-targets-'));
  let falseProbes = 0;
  let falseAt = 0;
  let emptyAt = 0;
  let emptyReads = 0;
  let postFalseReads = 0;
  let setupRequests = 0;
  let port = 0;
  const server = createServer((request, response) => {
    if (request.url === '/status') return response.end('packager-status:running');
    if (request.url !== '/json/list') return response.end('{}');
    if (falseProbes > 0) {
      postFalseReads++;
      if (afterFalse === 'pending' || (afterFalse !== 'empty' && postFalseReads > 1)) return;
    }
    const replaced = falseProbes > 0;
    if (replaced && afterFalse === 'late-empty') {
      setTimeout(() => {
        emptyReads++;
        emptyAt = performance.now();
        response.setHeader('Content-Type', 'application/json');
        response.end('[]');
      }, 3000);
      return;
    }
    const empty = replaced && afterFalse === 'empty';
    if (empty) emptyReads++;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        empty
          ? []
          : [
              {
                id:
                  replaced && afterFalse === 'replacement-id'
                    ? 'synthetic-replacement'
                    : 'synthetic-target',
                title: 'com.example.synthetic',
                appId: 'com.example.synthetic',
                description: 'com.example.synthetic',
                deviceName: 'Sandbox iPhone',
                vm: 'Hermes',
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${replaced && afterFalse === 'replacement-url' ? 'replacement' : 'target'}`,
              },
            ],
      ),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    socket.on('message', (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.method !== 'Runtime.evaluate') {
        setupRequests++;
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        return;
      }
      const value = runInNewContext(
        message.params.expression,
        { __DEV__: false },
        { timeout: 100 },
      );
      if (value === 'false') {
        falseProbes++;
        falseAt = performance.now();
      }
      socket.send(
        JSON.stringify({ id: message.id, result: { result: { type: typeof value, value } } }),
      );
    });
  });
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => sockets.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    await rm(runDir, { recursive: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;

  const plan = '## QA\n\n### Admission\n1. Tap "synthetic-button"\n';
  const runId = 'synthetic-empty-targets';
  const lease = `${runId}:0123456789abcdef0123456789abcdef`;
  const request: WireRequest = {
    runId,
    t0: Date.now(),
    walkBudgetMs: 60_000,
    attachBudgetMs: 4000,
    plan,
    prepared: preparePlan(plan, parsePlan(plan).blocks),
    platform: 'ios',
    appId: 'com.example.synthetic',
    appRoot: root,
    runDir,
    lease,
    target: {
      deviceId: '5A4DB0C5-0000-4000-8000-00000000F4CE',
      deviceName: 'Sandbox iPhone',
      metroPort: port,
      metroUrlForDevice: `http://127.0.0.1:${port}`,
      worktree: root,
    },
  };
  const child = spawn(
    'bash',
    [
      join(root, 'scripts/qaren-sim-sandbox.sh'),
      process.execPath,
      ...(afterFalse === 'late-empty'
        ? [
            '--import',
            `data:text/javascript,${encodeURIComponent(`
              import childProcess from 'node:child_process';
              import { syncBuiltinESMExports } from 'node:module';
              let empty = false;
              const fetch = globalThis.fetch;
              globalThis.fetch = async (...args) => {
                const response = await fetch(...args);
                if (String(args[0]).endsWith('/json/list')) {
                  const json = response.json.bind(response);
                  response.json = async () => {
                    const targets = await json();
                    if (Array.isArray(targets) && targets.length === 0) empty = true;
                    return targets;
                  };
                }
                return response;
              };
              const execFileSync = childProcess.execFileSync;
              childProcess.execFileSync = (file, args, ...rest) => {
                if (empty && (String(file).endsWith('xcrun') || String(file).endsWith('adb'))) {
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
                  throw new Error('Slow device inventory');
                }
                return execFileSync(file, args, ...rest);
              };
              syncBuiltinESMExports();
            `)}`,
          ]
        : []),
      join(root, 'packages/qaren-core/dist/qa/walk.js'),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        QAREN_DEVICE_LEASE: lease,
        QAREN_SANDBOX_DIR: join(runDir, 'sandbox'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => (stdout += bytes));
  child.stderr.on('data', (bytes) => (stderr += bytes));
  const closed = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  t.after(async () => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  child.stdin.end(
    `${JSON.stringify({ v: 1, runId, seq: 1, type: 'request', payload: request })}\n`,
  );
  const [exit, signal] = await closed;
  const elapsedAfterFalse = performance.now() - falseAt;
  clearTimeout(timeout);
  assert.equal(signal, null, stderr);
  assert.equal(exit, 4, stderr);
  const messages = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): Envelope<Partial<Refusal> & { line?: number }> => JSON.parse(line));
  const result = messages.find((message) => message.type === 'result')?.payload;
  assert.ok(result, stderr);
  assert.equal(result.verdict, 'REFUSED');
  assert.ok(result.admission);
  assert.equal(falseProbes, 1, 'the initial complete non-dev scan is the regression precondition');
  assert.equal(setupRequests, 0);
  assert.equal(
    messages.some((message) => message.type === 'admitted'),
    false,
  );
  assert.equal(
    messages.some((message) => message.type === 'row' && (message.payload.line ?? 0) > 0),
    false,
  );
  return {
    result: { code: result.code, admission: result.admission },
    emptyReads,
    postFalseReads,
    elapsedAfterFalse,
    emptyDelay: emptyAt - falseAt,
  };
}

test(
  'completed empty Metro reads clear a prior non-dev scan before readiness returns',
  { timeout: 30_000 },
  async (t) => {
    const { result, emptyReads } = await admission(t, 'empty');
    assert.ok(emptyReads >= 2, 'sequential reads prove an empty response completed before expiry');
    assert.equal(result.code, 'CDP_NOT_CONNECTED');
    assert.equal(result.admission.inner, 'no_dev_target_unknown');
    assert.equal(result.admission.devFalse ?? 0, 0);
    assert.equal(result.admission.targetsTotal ?? 0, 0);
  },
);

test(
  'an unanswered Metro read retains the prior complete non-dev scan',
  { timeout: 30_000 },
  async (t) => {
    const { result, emptyReads } = await admission(t, 'pending');
    assert.equal(emptyReads, 0);
    assert.equal(result.code, 'DEV_TARGET_MISSING');
    assert.equal(result.admission.inner, 'non_dev_bundle');
    assert.equal(result.admission.devFalse, 1);
    assert.equal(result.admission.targetsTotal, 1);
  },
);

for (const afterFalse of ['replacement-id', 'replacement-url', 'unchanged'] as const) {
  test(
    `a completed ${afterFalse} readiness read reconciles evidence before a stalled exact read`,
    { timeout: 30_000 },
    async (t) => {
      const { result, postFalseReads } = await admission(t, afterFalse);
      assert.equal(postFalseReads, 2, 'readiness completed before the exact read stalled');
      const unchanged = afterFalse === 'unchanged';
      assert.equal(result.code, unchanged ? 'DEV_TARGET_MISSING' : 'CDP_NOT_CONNECTED');
      assert.equal(
        result.admission.inner,
        unchanged ? 'non_dev_bundle' : 'no_dev_target_unknown',
      );
      assert.equal(result.admission.devFalse ?? 0, unchanged ? 1 : 0);
      assert.equal(result.admission.targetsTotal ?? 0, unchanged ? 1 : 0);
    },
  );
}

test(
  'an empty read near attach expiry refuses on time despite slow device inventory',
  { timeout: 30_000 },
  async (t) => {
    const { result, emptyReads, elapsedAfterFalse, emptyDelay } = await admission(t, 'late-empty');
    assert.equal(emptyReads, 1);
    assert.ok(emptyDelay >= 2800, 'the completed empty read arrives near the 4000ms deadline');
    assert.ok(
      elapsedAfterFalse < 5500,
      'the attach budget allows 1500ms for scheduling and teardown',
    );
    assert.equal(result.code, 'CDP_NOT_CONNECTED');
    assert.equal(result.admission.devFalse ?? 0, 0);
    assert.equal(result.admission.targetsTotal ?? 0, 0);
  },
);
