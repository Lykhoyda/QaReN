import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openSession } from '../../../dist/qa/walk.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { JevError } from '../../../dist/qa/questions.js';
import { parsePlan, preparePlan } from '../../../dist/qa/plan.js';
import { okResult } from '../../../dist/utils.js';
import type { WireRequest } from '../../../dist/qa/wire.js';

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
