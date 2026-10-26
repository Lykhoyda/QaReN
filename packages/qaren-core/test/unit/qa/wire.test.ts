import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  STARTUP_ROW_FIELDS,
  WIRE_VERSION,
  createWriter,
  exitCodeFor,
  missingResult,
  parseEnvelope,
  parseRequest,
  readRequest,
  startupRow,
  verdictAgrees,
  WireError,
} from '../../../dist/qa/wire.js';
import type { WireRequest } from '../../../dist/qa/wire.js';
import { buildLedger } from '../../../dist/qa/ledger.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';

const request: WireRequest = {
  runId: 'check-1',
  t0: 1_770_000_000_000,
  walkBudgetMs: 300_000,
  attachBudgetMs: 120_000,
  plan: '1. Tap "A"\n',
  platform: 'ios',
  appId: 'com.example.app',
  appRoot: '/tmp/qaren/app',
  runDir: '/tmp/qaren/runs/check-1',
  lease: 'check-1:0123456789abcdef0123456789abcdef',
  target: {
    deviceId: 'UDID',
    deviceName: 'iPhone 17',
    metroPort: 8791,
    metroUrlForDevice: 'http://127.0.0.1:8791',
    worktree: '/tmp/app',
  },
};

const row = (line: number): LedgerRow => ({
  block: 'plan',
  line,
  text: `${line}. Tap "A"`,
  attempt: 1,
  kind: 'step',
  resolvedBy: 'exact',
  ref: '@e1',
  screenshot: `screenshots/0${line}-line${line}.png`,
  t: line * 100,
  outcome: 'pass',
});

test('envelopes round-trip with increasing seq after the request', async () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'check-1');
  writer.row(startupRow());
  writer.admitted();
  writer.row(row(1));
  const exit = writer.result(
    buildLedger([{ key: 'plan', outcome: 'pass', source: 'discovered' }], [row(1)]),
  );
  assert.equal(exit, 0);
  assert.equal(writer.seq, 5);
  const parsed = lines.map((l) => parseEnvelope(l.trim()));
  assert.deepEqual(
    parsed.map((e) => [e?.v, e?.runId, e?.seq, e?.type]),
    [
      [WIRE_VERSION, 'check-1', 2, 'row'],
      [WIRE_VERSION, 'check-1', 3, 'admitted'],
      [WIRE_VERSION, 'check-1', 4, 'row'],
      [WIRE_VERSION, 'check-1', 5, 'result'],
    ],
  );
  assert.ok(
    lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')),
    'one JSON object per line',
  );

  const requestLine = `${JSON.stringify({ v: 1, runId: 'check-1', seq: 1, type: 'request', payload: request })}\n`;
  assert.deepEqual(parseRequest(requestLine.trim()), request);
  assert.deepEqual(
    await readRequest(Readable.from([requestLine.slice(0, 20), requestLine.slice(20)])),
    request,
  );
});

test('a step start envelope carries only the value-free line identity', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'check-1');
  writer.start({
    operationId: 3,
    line: 2,
    kind: 'step',
    t: 500,
    text: 'Type "secret" into "Email"',
  } as Parameters<typeof writer.start>[0]);
  const envelope = parseEnvelope(lines[0].trim());
  assert.equal(envelope?.type, 'start');
  assert.deepEqual(envelope?.payload, { operationId: 3, line: 2, kind: 'step', t: 500 });
});

test('the result verdict and the exit code agree', () => {
  const pass = buildLedger([], []);
  const fail = buildLedger([], [row(1)], { step: 1, seen: 'nothing' });
  assert.equal(exitCodeFor(pass), 0);
  assert.equal(exitCodeFor(fail), 1);
  assert.equal(
    exitCodeFor({
      verdict: 'REFUSED',
      code: 'METRO_ORIGIN_MISMATCH',
      message: 'port',
      lease: request.lease,
    }),
    4,
  );
  for (const [verdict, exit, agrees] of [
    ['PASS', 0, true],
    ['FAIL', 1, true],
    ['REFUSED', 4, true],
    ['PASS', 1, false],
    ['FAIL', 0, false],
    ['REFUSED', 0, false],
    ['PASS', 4, false],
  ] as const) {
    assert.equal(verdictAgrees(verdict, exit), agrees, `${verdict}/${exit}`);
  }
});

test('a missing result is a FAIL attributed to the last row, and the startup row carries the required fields', () => {
  const rows = [startupRow(), row(1), row(2)];
  const ledger = missingResult(rows, 'the child died');
  assert.equal(ledger.verdict, 'FAIL');
  assert.deepEqual(ledger.failure, {
    step: 2,
    seen: 'the child died',
    screenshot: 'screenshots/02-line2.png',
  });
  assert.equal(ledger.steps.length, 3);
  assert.equal(exitCodeFor(ledger), 1);

  const onlyStartup = missingResult([startupRow()], 'died at startup');
  assert.deepEqual(onlyStartup.failure, { step: 0, seen: 'died at startup' });
  const startup = startupRow() as unknown as Record<string, unknown>;
  for (const field of STARTUP_ROW_FIELDS) assert.ok(field in startup, field);
  assert.equal(startup.line, 0);
  assert.equal(startup.outcome, 'pass');
});

test('a missing result names the in-flight step when one had started', () => {
  const rows = [startupRow(), row(7)];
  assert.equal(missingResult(rows, 'refused mid-step', 8).failure?.step, 8);
  assert.equal(missingResult(rows, 'refused mid-step').failure?.step, 7);
});

test('malformed envelopes and requests are rejected', () => {
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(
    parseEnvelope(JSON.stringify({ v: 2, runId: 'x', seq: 1, type: 'row', payload: {} })),
    null,
  );
  assert.equal(
    parseEnvelope(JSON.stringify({ v: 1, runId: 'x', seq: 1, type: 'bogus', payload: {} })),
    null,
  );
  assert.throws(
    () => parseRequest(JSON.stringify({ v: 1, runId: 'x', seq: 1, type: 'row', payload: {} })),
    /expected a request/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          v: 1,
          runId: 'x',
          seq: 1,
          type: 'request',
          payload: { ...request, target: undefined },
        }),
      ),
    /missing required fields/,
  );
  for (const appRoot of [undefined, 'relative/app'])
    assert.throws(
      () =>
        parseRequest(
          JSON.stringify({
            v: 1,
            runId: 'x',
            seq: 1,
            type: 'request',
            payload: { ...request, appRoot },
          }),
        ),
      /missing required fields/,
    );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({ v: 1, runId: 'other', seq: 1, type: 'request', payload: request }),
      ),
    /names another run/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({ v: 1, runId: 'check-1', seq: 2, type: 'request', payload: request }),
      ),
    /seq 1/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          v: 1,
          runId: 'check-1',
          seq: 1,
          type: 'request',
          payload: { ...request, target: { ...request.target, metroPort: 70000 } },
        }),
      ),
    /missing required fields/,
  );
  for (const deviceName of [undefined, '', '  '])
    assert.throws(
      () =>
        parseRequest(
          JSON.stringify({
            v: 1,
            runId: 'check-1',
            seq: 1,
            type: 'request',
            payload: { ...request, target: { ...request.target, deviceName } },
          }),
        ),
      /missing required fields/,
    );
});

test('the target may carry the value-free Metro bundle-request signal', () => {
  const line = (metroBundleRequests: unknown) =>
    JSON.stringify({
      v: 1,
      runId: 'check-1',
      seq: 1,
      type: 'request',
      payload: { ...request, target: { ...request.target, metroBundleRequests } },
    });
  const signal = { path: '/tmp/qaren/runs/check-1/logs/metro.bundle-requests', atLaunch: 0 };
  assert.deepEqual(parseRequest(line(signal)).target.metroBundleRequests, signal);
  for (const bad of [
    null,
    { path: 'relative', atLaunch: 0 },
    { path: signal.path, atLaunch: -1 },
    { path: signal.path, atLaunch: 1.5 },
    { atLaunch: 0 },
  ])
    assert.throws(() => parseRequest(line(bad)), /missing required fields/);
});

test('the target may carry the CLI manifest warm-up as counts only', () => {
  const line = (manifestWarm: unknown) =>
    JSON.stringify({
      v: 1,
      runId: 'check-1',
      seq: 1,
      type: 'request',
      payload: { ...request, target: { ...request.target, manifestWarm } },
    });
  const warm = { ms: 4_200, attempts: 2 };
  assert.deepEqual(parseRequest(line(warm)).target.manifestWarm, warm);
  for (const bad of [
    null,
    { ms: -1, attempts: 2 },
    { ms: 1.5, attempts: 2 },
    { ms: 4_200, attempts: 0 },
    { ms: '4200', attempts: 2 },
    { attempts: 2 },
  ])
    assert.throws(() => parseRequest(line(bad)), /missing required fields/);
});

test('a multibyte character split across chunks still decodes', async () => {
  const line = `${JSON.stringify({ v: 1, runId: 'check-1', seq: 1, type: 'request', payload: { ...request, plan: '✓ "Tasks"\n' } })}\n`;
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.indexOf(Buffer.from('✓', 'utf8')) + 1;
  const parsed = await readRequest(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]));
  assert.equal(parsed.plan, '✓ "Tasks"\n');
});

test('nothing may follow the result line', () => {
  const writer = createWriter(() => undefined, 'check-1');
  writer.result(buildLedger([], []));
  assert.throws(() => writer.row(row(1)), /already written/);
  assert.throws(() => writer.result(buildLedger([], [])), /already written/);
});

test('preflight accounting round-trips and rejects malformed or walk-scoped entries', () => {
  const preflightCalls = [
    {
      scope: 'preflight',
      questionIds: ['preflight'],
      inputTokens: 12,
      ms: 15,
      outcome: 'ok',
      status: 200,
    },
  ];
  const encoded = (calls: unknown) =>
    JSON.stringify({
      v: 1,
      runId: request.runId,
      seq: 1,
      type: 'request',
      payload: { ...request, preflightCalls: calls },
    });
  assert.deepEqual(parseRequest(encoded(preflightCalls)).preflightCalls, preflightCalls);
  const bounded = [
    { ...preflightCalls[0], outcome: 'deadline', diagnostic: 'retry-after-outside-window' },
  ];
  assert.deepEqual(parseRequest(encoded(bounded)).preflightCalls, bounded);
  for (const calls of [
    null,
    {},
    [null],
    [{ ...preflightCalls[0], ms: -1 }],
    [{ ...preflightCalls[0], scope: 'walk' }],
    [{ ...preflightCalls[0], questionIds: ['private text not an id'] }],
    [{ ...preflightCalls[0], inputTokens: -5 }],
    [{ ...preflightCalls[0], diagnostic: 'private transport message' }],
    [{ ...preflightCalls[0], diagnostic: 42 }],
  ])
    assert.throws(() => parseRequest(encoded(calls)), /missing required fields/);
});

test('a login block needs a marker with exactly one of id or text', () => {
  const line = (payload: object) =>
    JSON.stringify({
      v: 1,
      runId: 'check-1',
      seq: 1,
      type: 'request',
      payload: { ...request, ...payload },
    });
  const accepted = parseRequest(
    line({ loginBlock: 'log-in', loginMarker: { id: 'login-screen' } }),
  );
  assert.equal(accepted.loginBlock, 'log-in');
  assert.deepEqual(parseRequest(line({ loginMarker: { text: 'Sign in' } })).loginMarker, {
    text: 'Sign in',
  });
  for (const bad of [
    { loginBlock: 'log-in' },
    { loginBlock: '../x', loginMarker: { id: 'a' } },
    { loginBlock: 'log-in', loginMarker: { id: 'a', text: 'b' } },
    { loginBlock: 'log-in', loginMarker: { id: '' } },
    { loginMarker: { label: 'a' } },
  ])
    assert.throws(() => parseRequest(line(bad)), WireError);
});

test('a spawned runner driver is announced as a resource envelope before the result only', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'check-1');
  writer.runnerDriver(4242);
  writer.result(buildLedger([], []));
  writer.runnerDriver(4343);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        v: WIRE_VERSION,
        runId: 'check-1',
        seq: 2,
        type: 'resource',
        payload: { kind: 'runner_driver', pid: 4242 },
      },
      JSON.parse(lines[1]),
    ],
  );
  assert.equal(JSON.parse(lines[1]).type, 'result');
});
