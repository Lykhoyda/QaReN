import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { parsePlan, preparePlan } from '../../../dist/qa/plan.js';
import type { WireRequest } from '../../../dist/qa/wire.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
type Kind = 'W2' | 'W1a' | 'W1b' | 'W1c' | 'W1d' | 'W1e';
async function run(t: TestContext, kind: Kind) {
  const scratch = await mkdtemp(join(tmpdir(), 'qaren-android-start-'));
  const lists: number[] = [];
  const upgrades: number[] = [];
  const reads: { at: number; answer: string }[] = [];
  let port = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/json/list')
      return response.end(request.url === '/status' ? 'packager-status:running' : '{}');
    lists.push(Date.now());
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        kind === 'W1b' || kind === 'W2'
          ? [
              {
                id: 'synthetic-target',
                title: 'com.example.synthetic',
                appId: 'com.example.synthetic',
                description: 'com.example.synthetic',
                deviceName: 'Synthetic Android',
                vm: 'Hermes',
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/target`,
              },
            ]
          : [],
      ),
    );
  });
  server.on('upgrade', () => upgrades.push(Date.now()));
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const message = JSON.parse(String(bytes));
      const value =
        message.method === 'Runtime.evaluate'
          ? runInNewContext(message.params.expression, { __DEV__: false }, { timeout: 100 })
          : undefined;
      socket.send(
        JSON.stringify({
          id: message.id,
          result:
            message.method === 'Runtime.evaluate' ? { result: { type: typeof value, value } } : {},
        }),
      );
    }),
  );
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => sockets.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    await rm(scratch, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
  const plan = '1. Tap "synthetic-button"';
  const lease = 'synthetic-start:0123456789abcdef0123456789abcdef';
  const request: WireRequest = {
    runId: 'synthetic-start',
    t0: Date.now(),
    walkBudgetMs: kind === 'W1e' ? 36_000 : kind === 'W1c' || kind === 'W2' ? 20_000 : 8000,
    attachBudgetMs: 8000,
    plan,
    prepared: preparePlan(plan, parsePlan(plan).blocks),
    platform: kind === 'W1d' ? 'ios' : 'android',
    appId: 'com.example.synthetic',
    appRoot: root,
    runDir: scratch,
    lease,
    target: {
      deviceId: 'synthetic-android',
      deviceName: kind === 'W1d' ? 'Sandbox iPhone' : 'Synthetic Android',
      metroPort: port,
      metroUrlForDevice: `http://127.0.0.1:${port}`,
      worktree: root,
    },
  };
  const walk = new URL('../../../dist/qa/walk.js', import.meta.url);
  const privacy = new URL('../../../dist/qa/privacy.js', import.meta.url);
  const fixtureBin = join(scratch, 'fixture-bin');
  if (kind === 'W2') {
    await mkdir(fixtureBin);
    const fixtures = new URL('../../fixtures/android-first-views/', import.meta.url);
    // In launch order: no process yet, a busy process whose dump timed out, loading, first views.
    const served = ['not-running', 'timeout', 'loading', 'loaded'];
    const outputs = await Promise.all(
      ['start-not-running', 'start-timeout', 'loading', 'first-views'].map((name) =>
        readFile(new URL(`${name}.txt`, fixtures), 'utf8'),
      ),
    );
    const shim = join(fixtureBin, 'adb');
    await writeFile(
      shim,
      `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (JSON.stringify(args) !== JSON.stringify(['-s', 'synthetic-android', 'shell', 'dumpsys', 'activity', 'top'])) {
        process.stderr.write('fixture adb: refused command\\n');
        process.exit(1);
      }
      const counter = ${JSON.stringify(join(scratch, 'reads'))};
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
      fs.writeFileSync(counter, String(count + 1));
      const index = Math.min(count, 3);
      fs.appendFileSync(${JSON.stringify(join(scratch, 'reader-events'))}, JSON.stringify({at: Date.now(), answer: ${JSON.stringify(served)}[index]}) + '\\n');
      process.stdout.write(${JSON.stringify(outputs)}[index]);
    `,
    );
    await chmod(shim, 0o700);
  }
  const script = `
    import {mainRequest, openSession} from ${JSON.stringify(walk.href)};
    import {ObservedPrivacy} from ${JSON.stringify(privacy.href)};
    let reads = 0;
    const read = async (appId, serial) => {
      if (appId !== 'com.example.synthetic' || serial !== 'synthetic-android') throw new Error('unexpected reader target');
      const answer = ${JSON.stringify(kind)} === 'W1c' ? 'unknown' : (${JSON.stringify(kind)} === 'W1b' && reads++ > 0 ? 'loaded' : 'loading');
      process.stderr.write('START_READ=' + JSON.stringify({at: Date.now(), answer}) + '\\n');
      return answer;
    };
    await mainRequest(${JSON.stringify(request)}, new ObservedPrivacy(), process.ppid, undefined, (...args) => openSession(...args, read));
  `;
  const started = Date.now();
  // All native inventory and connection reads remain behind the refusing sandbox shims.
  const child = spawn(
    'bash',
    [
      join(root, 'scripts/qaren-sim-sandbox.sh'),
      process.execPath,
      ...(kind === 'W2'
        ? [
            '--input-type=module',
            '-e',
            `
            import {spawn} from 'node:child_process';
            const child = spawn(process.execPath, [${JSON.stringify(fileURLToPath(walk))}], {
              env: {...process.env, PATH: ${JSON.stringify(fixtureBin)} + ':' + process.env.PATH},
              stdio: 'inherit',
            });
            child.on('error', () => process.exit(1));
            child.on('exit', (code) => process.exit(code ?? 1));
          `,
          ]
        : ['--input-type=module', '-e', script]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TYPESAFE_API_KEY: '',
        QAREN_DEVICE_LEASE: lease,
        QAREN_SANDBOX_DIR: join(scratch, 'sandbox'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => (stdout += bytes));
  child.stderr.on('data', (bytes) => (stderr += bytes));
  const closed = once(child, 'close');
  const timeout = setTimeout(
    () => child.kill('SIGKILL'),
    kind === 'W1e' || kind === 'W1c' || kind === 'W2' ? 45_000 : 16_000,
  );
  t.after(async () => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  child.stdin.end(
    kind === 'W2'
      ? `${JSON.stringify({ v: 1, runId: request.runId, seq: 1, type: 'request', payload: request })}\n`
      : '',
  );
  const [exit, signal] = await closed;
  clearTimeout(timeout);
  assert.equal(signal, null, stderr);
  assert.equal(exit, 4, stderr + stdout);
  for (const line of stderr.split('\n'))
    if (line.startsWith('START_READ=')) reads.push(JSON.parse(line.slice('START_READ='.length)));
  if (kind === 'W2') {
    const events = await readFile(join(scratch, 'reader-events'), 'utf8').catch(() => '');
    for (const line of events.trim().split('\n').filter(Boolean)) reads.push(JSON.parse(line));
  }
  const envelopes = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = envelopes.find((row) => row.type === 'result')?.payload;
  assert.ok(result, stderr);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(
    envelopes.some((row) => row.type === 'admitted'),
    false,
  );
  return { started, lists, upgrades, reads, result, stderr };
}
function spaced(reads: { at: number }[]) {
  assert.ok(reads.length >= 2, 'at least two reads witness polling');
  for (let i = 1; i < reads.length; i++)
    assert.ok(
      reads[i].at - reads[i - 1].at >= 1900,
      `read starts only ${reads[i].at - reads[i - 1].at} ms apart`,
    );
}

test(
  'W2: production reader holds discovery through a launch until the first views',
  { timeout: 50_000 },
  async (t) => {
    const r = await run(t, 'W2');
    assert.deepEqual(
      r.reads.map(({ answer }) => answer),
      ['not-running', 'timeout', 'loading', 'loaded'],
      'production must keep asking its reader until the first views',
    );
    assert.ok(r.lists.length > 0);
    assert.ok(r.lists[0] >= r.reads[3].at, 'production discovery follows the last read');
    assert.ok(r.upgrades.length > 0, 'positive websocket witness after first views');
    assert.ok(r.upgrades.every((at) => at >= r.reads[3].at));
    const unanswered = r.stderr.indexOf('android start: first-views check not answered at ');
    const holding = r.stderr.indexOf(
      "android start: holding the debugger until the app's first views at ",
    );
    const seen = r.stderr.indexOf('android start: first views seen');
    const connect = r.stderr.indexOf('android start: debugger connect');
    assert.ok(unanswered >= 0 && holding > unanswered && seen > holding && connect > seen);
    assert.doesNotMatch(r.stderr, /first-views check unavailable/);
    assert.doesNotMatch(r.result.message, /; the first-views|; the app's first views/);
  },
);
test(
  'W1a: loading keeps the real entry away from target discovery and websockets',
  { timeout: 20_000 },
  async (t) => {
    const r = await run(t, 'W1a');
    assert.equal(r.result.code, 'CDP_NOT_CONNECTED');
    assert.ok(
      r.result.message.endsWith(
        "; the app's first views had not appeared, so no debugger was attached",
      ),
    );
    assert.deepEqual(r.lists, []);
    assert.deepEqual(r.upgrades, []);
    spaced(r.reads);
    assert.equal(r.stderr.match(/holding the debugger until the app's first views/g)?.length, 1);
    assert.doesNotMatch(r.stderr, /android start: debugger connect/);
  },
);
test(
  'W1b: real discovery and websocket connect follow the loaded answer',
  { timeout: 20_000 },
  async (t) => {
    const r = await run(t, 'W1b');
    assert.equal(r.reads.length, 2);
    assert.equal(r.reads[1].answer, 'loaded');
    assert.ok(r.lists.length > 0);
    assert.ok(r.lists[0] >= r.reads[1].at);
    assert.ok(r.upgrades.length > 0, 'positive websocket witness after loading');
    assert.ok(r.upgrades.every((at) => at >= r.reads[1].at));
    const holding = r.stderr.indexOf('holding the debugger');
    const seen = r.stderr.indexOf('first views seen');
    const connect = r.stderr.indexOf('android start: debugger connect');
    assert.ok(holding >= 0 && seen > holding && connect > seen);
    assert.match(r.stderr, /android start: target listed at \d+ ms/);
    assert.doesNotMatch(r.result.message, /; the first-views|; the app's first views/);
  },
);
test(
  'W1c: no answer releases the real target wait once, after 15 s',
  { timeout: 50_000 },
  async (t) => {
    const r = await run(t, 'W1c');
    assert.ok(r.lists.length > 0);
    assert.ok(r.lists[0] - r.reads[0].at >= 15_000, 'no target list before 15 s');
    assert.ok(r.lists[0] - r.started < 22_000, 'the first target list before 22 s');
    spaced(r.reads);
    assert.ok(
      r.reads.every(({ at }) => at <= r.lists[0]),
      'no read after the let-through',
    );
    assert.equal(
      r.stderr.match(/first-views check not answered at \d+ ms; asking again/g)?.length,
      1,
    );
    assert.equal(
      r.stderr.match(/first-views check unavailable at \d+ ms; attaching as before/g)?.length,
      1,
    );
    assert.ok(
      r.result.message.endsWith(
        '; the first-views check could not be read; attaching a debugger was allowed as before',
      ),
    );
  },
);
test(
  'W1d: iOS ignores an injected Android reader through target waiting',
  { timeout: 20_000 },
  async (t) => {
    const r = await run(t, 'W1d');
    assert.equal(r.reads.length, 0);
    assert.ok(r.lists.length > 0);
    assert.ok(r.lists[0] - r.started < 2000);
    assert.doesNotMatch(r.stderr, /android start:/);
    assert.doesNotMatch(r.result.message, /first[ -](?:screen|views)/);
  },
);
test('W1e: real retries retain one gate and its polling clock', { timeout: 50_000 }, async (t) => {
  const r = await run(t, 'W1e');
  assert.deepEqual(r.lists, []);
  assert.deepEqual(r.upgrades, []);
  assert.equal(r.stderr.match(/holding the debugger until the app's first views/g)?.length, 1);
  spaced(r.reads);
  assert.ok(r.reads.at(-1)!.at - r.reads[0].at > 30_000, 'reads reach the second readiness window');
  assert.match(r.stderr, /target_readiness_timeout/);
});
