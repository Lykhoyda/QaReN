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
type Kind = 'W2' | 'W1a' | 'W1b' | 'W1c' | 'W1d' | 'W1e' | 'W3' | 'W4' | 'T2' | 'W5' | 'T3';
// Each kind's walk budget and the watchdog that kills its child.
const budgets: Record<Kind, { walkMs: number; killMs: number }> = {
  W1a: { walkMs: 8000, killMs: 16_000 },
  W1b: { walkMs: 8000, killMs: 16_000 },
  W1c: { walkMs: 20_000, killMs: 45_000 },
  W1d: { walkMs: 8000, killMs: 16_000 },
  W1e: { walkMs: 36_000, killMs: 45_000 },
  W2: { walkMs: 20_000, killMs: 45_000 },
  W3: { walkMs: 70_000, killMs: 80_000 },
  W4: { walkMs: 90_000, killMs: 100_000 },
  T2: { walkMs: 70_000, killMs: 80_000 },
  W5: { walkMs: 260_000, killMs: 200_000 },
  T3: { walkMs: 240_000, killMs: 80_000 },
};
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
  const plan =
    kind === 'T2' || kind === 'T3' ? '1. Fill "code" with input CODE' : '1. Tap "synthetic-button"';
  const restart = kind === 'W5' || kind === 'T3';
  const counted = kind === 'W3' || kind === 'W4' || kind === 'T2' || restart;
  const requestsPath = join(scratch, 'metro.bundle-requests');
  const outcomesPath = join(scratch, 'metro.bundle-outcomes');
  if (counted) {
    // W5: a request recorded before the restart, none after it.
    await writeFile(requestsPath, kind === 'W5' ? '4\n' : '3\n');
    await writeFile(outcomesPath, '1 0\n');
  }
  const lease = 'synthetic-start:0123456789abcdef0123456789abcdef';
  const request: WireRequest = {
    runId: 'synthetic-start',
    t0: Date.now(),
    walkBudgetMs: budgets[kind].walkMs,
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
      ...(counted
        ? {
            metroBundleRequests: {
              path: requestsPath,
              atLaunch: 3,
              outcomesPath,
              completedAtLaunch: 1,
              failedAtLaunch: 0,
            },
          }
        : {}),
      ...(restart
        ? {
            androidLaunchUrl: `exp+${kind === 'T3' ? 't3canary' : 'synthetic'}://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${port}%2F%3FdisableOnboarding%3D1&disableFab=1&__expo_disable_fab=1&__expo_disable_auto_launch=1`,
          }
        : {}),
    },
  };
  const walk = new URL('../../../dist/qa/walk.js', import.meta.url);
  const privacy = new URL('../../../dist/qa/privacy.js', import.meta.url);
  const fixtureBin = join(scratch, 'fixture-bin');
  // A fixture adb first on the child's PATH; it never forwards to a real adb.
  const writeAdb = async (body: string) => {
    await mkdir(fixtureBin);
    const shim = join(fixtureBin, 'adb');
    await writeFile(
      shim,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}`,
    );
    await chmod(shim, 0o700);
  };
  if (kind === 'W2') {
    const fixtures = new URL('../../fixtures/android-first-views/', import.meta.url);
    // In launch order: no process yet, a busy process whose dump timed out, loading, first views.
    const served = ['not-running', 'timeout', 'loading', 'loaded'];
    const outputs = await Promise.all(
      ['start-not-running', 'start-timeout', 'loading', 'first-views'].map((name) =>
        readFile(new URL(`${name}.txt`, fixtures), 'utf8'),
      ),
    );
    await writeAdb(
      `if (JSON.stringify(args) !== JSON.stringify(['-s', 'synthetic-android', 'shell', 'dumpsys', 'activity', 'top'])) {
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
  }
  if (restart) {
    const [dead, picker] = await Promise.all(
      ['complete-after-kill', 'launcher'].map((name) =>
        readFile(
          new URL(`../../fixtures/android-first-views/${name}.txt`, import.meta.url),
          'utf8',
        ),
      ),
    );
    await writeAdb(
      `fs.appendFileSync(${JSON.stringify(join(scratch, 'adb-calls'))}, JSON.stringify(args) + '\\n');
      const state = ${JSON.stringify(join(scratch, 'device-state'))};
      const now = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : 'first';
      const is = (expected) => JSON.stringify(args) === JSON.stringify(expected);
      const shell = ['-s', 'synthetic-android', 'shell'];
      // W5: no process until QaReN's start; T3: a picker until the force-stop, and a start that fails.
      const running = ${JSON.stringify(kind)} === 'W5' ? now === 'started' : now === 'first';
      if (is([...shell, 'dumpsys', 'activity', 'top'])) {
        process.stdout.write(running ? ${JSON.stringify(picker)} : ${JSON.stringify(dead)});
      } else if (is([...shell, 'pidof', 'com.example.synthetic'])) {
        if (!running) process.exit(1);
        process.stdout.write('1234\\n');
      } else if (is([...shell, 'ps', '-A'])) {
        process.stdout.write('USER PID PPID VSZ RSS WCHAN ADDR S NAME\\nroot 1 0 0 0 0 0 S init\\n');
      } else if (is([...shell, 'am', 'force-stop', 'com.example.synthetic'])) {
        fs.writeFileSync(state, 'stopped');
      } else if (args[3] === 'am' && args[4] === 'start') {
        if (${JSON.stringify(kind)} === 'T3') {
          process.stderr.write('Error: Activity not started, unable to resolve Intent { dat=' + args.at(-2) + ' }\\n');
          process.exit(1);
        }
        fs.writeFileSync(state, 'started');
      } else {
        process.stderr.write('fixture adb: refused command\\n');
        process.exit(1);
      }
    `,
    );
  } else if (counted) {
    const top = await readFile(
      new URL(
        `../../fixtures/android-first-views/${kind === 'W4' ? 'complete-after-kill' : 'launcher'}.txt`,
        import.meta.url,
      ),
      'utf8',
    );
    await writeAdb(
      `fs.appendFileSync(${JSON.stringify(join(scratch, 'adb-calls'))}, JSON.stringify(args) + '\\n');
      const is = (expected) => JSON.stringify(args) === JSON.stringify(expected);
      if (is(['-s', 'synthetic-android', 'shell', 'dumpsys', 'activity', 'top'])) {
        process.stdout.write(${JSON.stringify(top)});
      } else if (is(['-s', 'synthetic-android', 'shell', 'pidof', 'com.example.synthetic'])) {
        if (${JSON.stringify(kind === 'W4')}) process.exit(1);
        process.stdout.write('1234\\n');
      } else {
        process.stderr.write('fixture adb: refused command\\n');
        process.exit(1);
      }
    `,
    );
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
      ...(kind === 'W2' || counted
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
  const timeout = setTimeout(() => child.kill('SIGKILL'), budgets[kind].killMs);

  t.after(async () => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  child.stdin.end(
    kind === 'W2' || counted
      ? `${JSON.stringify({
          v: 1,
          runId: request.runId,
          seq: 1,
          type: 'request',
          payload:
            kind === 'T2' || kind === 'T3'
              ? { ...request, inputProtocol: 1, inputs: { CODE: 'synthetic-private-value' } }
              : request,
        })}\n`
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
  const adbCalls = (await readFile(join(scratch, 'adb-calls'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const refusedAt = Date.now();
  return { started, refusedAt, lists, upgrades, reads, result, stderr, stdout, adbCalls, port };
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

const pidofCalls = (calls: string[][]) => calls.filter((args) => args.includes('pidof')).length;

test(
  'W3: the real entry refuses a start with no bundle request at the attach budget, naming a live process',
  { timeout: 90_000 },
  async (t) => {
    const r = await run(t, 'W3');
    assert.equal(r.result.code, 'CDP_NOT_CONNECTED');
    assert.ok(r.refusedAt - r.started < 45_000, `refused after ${r.refusedAt - r.started} ms`);
    assert.match(r.result.message, /app alive; bundle request not_received/);
    assert.deepEqual(r.lists, []);
    assert.equal(pidofCalls(r.adbCalls), 1);
  },
);
test(
  'W4: the real entry names a dead process after two empty reads',
  { timeout: 110_000 },
  async (t) => {
    const r = await run(t, 'W4');
    assert.equal(r.result.code, 'CDP_NOT_CONNECTED');
    assert.ok(r.refusedAt - r.started < 65_000, `refused after ${r.refusedAt - r.started} ms`);
    assert.match(r.result.message, /app dead; bundle request not_received/);
    assert.ok(r.lists.length > 0);
    assert.deepEqual(r.upgrades, []);
    assert.equal(pidofCalls(r.adbCalls), 2);
  },
);
test(
  'T2: a strict input withholds the note while the facts keep the state',
  { timeout: 90_000 },
  async (t) => {
    const r = await run(t, 'T2');
    assert.equal(r.result.message, '[private output withheld]');
    assert.equal(r.result.admission?.liveness, 'alive');
    assert.equal(r.result.admission?.bundleRequest, 'not_received');
    assert.doesNotMatch(r.stdout, /was running|at the count check/);
  },
);

const named = (calls: string[][], word: string) => calls.filter((args) => args.includes(word));

test(
  'W5: the real entry restarts a dead start once and refuses it on the rebased count once its own budget has passed',
  { timeout: 220_000 },
  async (t) => {
    const r = await run(t, 'W5');
    assert.equal(r.result.code, 'CDP_NOT_CONNECTED');
    const after = r.refusedAt - r.started;
    assert.ok(after > 100_000 && after < 130_000, `refused after ${after} ms`);
    assert.match(r.result.message, /app alive; bundle request not_received/);
    assert.match(r.result.message, /; QaReN stopped the app and issued one recovery start command/);
    assert.equal(r.result.admission?.relaunches, 1);
    assert.equal(r.result.admission?.relaunchFailed, false);
    assert.equal(named(r.adbCalls, 'ps').length, 1);
    assert.equal(named(r.adbCalls, 'force-stop').length, 1);
    const [start, ...more] = named(r.adbCalls, 'start');
    assert.deepEqual(more, []);
    assert.deepEqual(start, [
      '-s',
      'synthetic-android',
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '--ez',
      'EXDevMenuDisableAutoLaunch',
      'true',
      '-d',
      `'exp+synthetic://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${r.port}%2F%3FdisableOnboarding%3D1&disableFab=1&__expo_disable_fab=1&__expo_disable_auto_launch=1'`,
      'com.example.synthetic',
    ]);
    assert.equal(named(r.adbCalls, 'pidof').length, 7);
    const stopped = r.stderr.indexOf('android start: restart: the app was stopped at');
    const sent = r.stderr.indexOf('android start: restart: start sent at');
    assert.ok(stopped >= 0 && sent > stopped, r.stderr);
    assert.doesNotMatch(r.stderr, /expo-development-client/);
  },
);
test(
  'T3: a strict input withholds a failed restart while the facts keep it',
  { timeout: 90_000 },
  async (t) => {
    const r = await run(t, 'T3');
    assert.equal(r.result.message, '[private output withheld]');
    assert.equal(r.result.admission?.relaunches, 1);
    assert.equal(r.result.admission?.relaunchFailed, true);
    assert.equal(r.result.admission?.liveness, 'dead');
    assert.equal(r.result.admission?.bundleRequest, 'not_received');
    assert.equal(named(r.adbCalls, 'start').length, 1);
    assert.ok(r.refusedAt - r.started < 45_000, `refused after ${r.refusedAt - r.started} ms`);
    for (const text of [r.stdout, r.stderr]) {
      assert.doesNotMatch(text, /t3canary|synthetic-private-value|unable to resolve Intent/);
    }
  },
);
