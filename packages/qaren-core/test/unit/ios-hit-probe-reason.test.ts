// AI-711: the iOS client says why a read-only hit probe gave no answer, in its own words or the runner's.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { QaDispatchContext, QaDispatchError } from '../../dist/domain/qa-dispatch.js';
import { clearRefMap, updateRefMapFromFlat } from '../../dist/fast-runner-ref-map.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  readIOSHitProbe,
  readIOSHitProbeWithReason,
  runIOS,
} from '../../dist/runners/qaren-ios-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../dist/runners/protocol.js';
import { openSession } from '../../dist/qa/walk.js';
import { ObservedPrivacy } from '../../dist/qa/privacy.js';
import { parsePlan, preparePlan } from '../../dist/qa/plan.js';
import type { WireRequest } from '../../dist/qa/wire.js';
import { okResult } from '../../dist/utils.js';
import { covered, fake, walked } from './qa/live-hit-reason-fixtures.ts';

const BUNDLE = 'dev.fixture';
const identity = { identifier: 'row', rect: { x: 20, y: 20, width: 300, height: 40 } };
let commandCount: number;
let capabilities: string[];
let reply: () => Response;
const runner = (bundleId = BUNDLE) =>
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    port: 22088,
    pid: process.pid,
    deviceId: 'hit-probe-reason',
    bundleId,
    startedAt: 'now',
    protocolVersion: 2,
  });
const seed = (generation = 7, identifier = 'row') =>
  updateRefMapFromFlat(
    [
      {
        ref: '@e6',
        type: 'Other',
        identifier,
        rect: { x: 20, y: 20, width: 300, height: 40 },
        hittable: true,
      },
    ],
    { snapshotGeneration: generation, keyboardVisible: false },
  );
const wire = (data: Record<string, unknown>) => () => Response.json({ ok: true, v: 2, data });
beforeEach(() => {
  clearRefMap();
  seed();
  commandCount = 0;
  capabilities = [
    ...REQUIRED_IOS_FEATURES,
    'QA_READ_ONLY_V1',
    'STRICT_LIVE_HIT_V1',
    'LIVE_HIT_PROBE_V1',
  ];
  reply = wire({ hitProbe: 'hittable', snapshotGeneration: 7 });
  runner();
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities,
      });
    commandCount++;
    return reply();
  });
});
afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  clearRefMap();
});
const context = (now = () => 0, cancelled = () => false) =>
  new QaDispatchContext(10_000, now, cancelled);
const read = (ctx = context(), bundle = BUNDLE) =>
  readIOSHitProbeWithReason('@e6', bundle, 7, ctx, identity);

for (const [word, expected] of [
  ['deadline', 'deadline'],
  ['ambiguous', 'ambiguous'],
  ['private-text', 'unreported'],
  [undefined, 'unreported'],
  ['no-reader', 'unreported'],
  ['runner-refused', 'unreported'],
] as const) {
  test(`C1: a runner unavailable reply with ${word ?? 'no word'} gives ${expected}`, async () => {
    reply = wire({
      hitProbe: 'unavailable',
      snapshotGeneration: 7,
      ...(word ? { liveCheckReason: word } : {}),
    });
    assert.deepEqual(await read(), { result: 'unavailable', reason: expected });
  });
}

for (const [shape, data] of [
  ['no result', { snapshotGeneration: 7, liveCheckReason: 'deadline' }],
  ['an unknown result', { hitProbe: 'weird', snapshotGeneration: 7, liveCheckReason: 'ambiguous' }],
] as const) {
  test(`C1a: a runner reply with ${shape} is unavailable and unreported, never its word`, async () => {
    reply = wire(data);
    assert.deepEqual(await read(), { result: 'unavailable', reason: 'unreported' });
  });
}

for (const [shape, envelope] of [
  [
    'no generation',
    { ok: true, v: 2, data: { hitProbe: 'unavailable', liveCheckReason: 'deadline' } },
  ],
  [
    'a string generation',
    { ok: true, v: 2, data: { hitProbe: 'hittable', snapshotGeneration: '7' } },
  ],
  ['no data', { ok: true, v: 2 }],
] as const) {
  test(`C1c: a runner reply with ${shape} shows no generation mismatch: unavailable and unreported`, async () => {
    reply = () => Response.json(envelope);
    assert.deepEqual(await read(), { result: 'unavailable', reason: 'unreported' });
  });
}

for (const [change, expected] of [
  ['identity', 'identity-changed'],
  ['gone', 'stale-ref'],
] as const) {
  test(`C1d: a ref whose ${change} changes during the read at the same generation is ${expected}`, async () => {
    reply = () => {
      if (change === 'identity') seed(7, 'different');
      else clearRefMap();
      return Response.json({
        ok: true,
        v: 2,
        data: { hitProbe: 'hittable', snapshotGeneration: 7 },
      });
    };
    assert.deepEqual(await read(), { result: 'unavailable', reason: expected });
  });
}

test('C1b: a runner word at another generation speaks for nothing', async () => {
  reply = wire({ hitProbe: 'unavailable', snapshotGeneration: 8, liveCheckReason: 'deadline' });
  assert.deepEqual(await read(), { result: 'unavailable', reason: 'generation-changed' });
});

for (const [fault, expected] of [
  ['stale-generation', 'stale-ref'],
  ['reused-index-same-generation', 'identity-changed'],
  ['reused-index', 'generation-changed'],
  ['old-runner', 'runner-refused'],
  ['runner-timeout', 'runner-refused'],
  ['transport', 'threw'],
  ['wrong-reply-generation', 'generation-changed'],
  ['no-runner', 'runner-refused'],
  ['no-read-only', 'runner-refused'],
  ['late', 'late'],
] as const) {
  test(`C2: a ${fault} read is ${expected}, and the bare reader still answers unavailable`, async () => {
    let now = 0;
    if (fault === 'stale-generation') seed(8);
    if (fault === 'reused-index-same-generation') seed(7, 'different');
    if (fault === 'old-runner')
      capabilities = capabilities.filter((c) => c !== 'LIVE_HIT_PROBE_V1');
    if (fault === 'no-read-only')
      capabilities = capabilities.filter((c) => c !== 'QA_READ_ONLY_V1');
    if (fault === 'no-runner') _setFastRunnerStateForTest(null);
    reply = () => {
      if (fault === 'reused-index') seed(8, 'different');
      if (fault === 'late') now = 10_001;
      if (fault === 'transport') throw new Error('connection reset');
      if (fault === 'runner-timeout')
        return Response.json({
          ok: false,
          v: 2,
          error: { code: 'RUNNER_TIMEOUT', message: 'timeout' },
        });
      return Response.json({
        ok: true,
        v: 2,
        data: {
          hitProbe: 'hittable',
          snapshotGeneration: fault === 'wrong-reply-generation' ? 8 : 7,
        },
      });
    };
    assert.deepEqual(await read(context(() => now)), { result: 'unavailable', reason: expected });
    now = 0;
    if (fault === 'reused-index') seed();
    assert.equal(
      await readIOSHitProbe(
        '@e6',
        BUNDLE,
        7,
        context(() => now),
        identity,
      ),
      'unavailable',
    );
  });
}

test('C2b: a changed identity answers before the clock is read, as the bare reader always did', async () => {
  seed(7, 'different');
  const clock = () => assert.fail('the clock was read');
  assert.deepEqual(await read(context(clock)), {
    result: 'unavailable',
    reason: 'identity-changed',
  });
  assert.equal(await readIOSHitProbe('@e6', BUNDLE, 7, context(clock), identity), 'unavailable');
  assert.equal(commandCount, 0);
});

test('the client reports the pre-send context refusal without a probe command', async () => {
  for (const [now, expected] of [
    [10_000, 'late'],
    [NaN, 'runner-refused'],
  ] as const) {
    const reply = await runIOS({
      command: 'hitProbe',
      bundleId: BUNDLE,
      qaContext: context(() => now),
    });
    const envelope = JSON.parse(reply.content[0].text);
    assert.equal(envelope.data.hitProbe, 'unavailable');
    assert.equal(envelope.meta.hitProbeUnavailable, expected);
    assert.equal(commandCount, 0);
  }
});

test('C3: an answered read carries no word', async () => {
  reply = wire({ hitProbe: 'not-hittable', snapshotGeneration: 7, liveCheckReason: 'deadline' });
  assert.deepEqual(await read(), { result: 'not-hittable' });
});

test('C4: a cancelled run still rejects instead of answering', async () => {
  await assert.rejects(
    read(
      context(
        () => 0,
        () => true,
      ),
    ),
    (error: unknown) => error instanceof QaDispatchError && error.code === 'RUN_CANCELLED',
  );
});

test('C5: a lost runner, read through the walker, is runner-refused, not late', async () => {
  // A Fill under the inferred cover probes once and refuses at once, far from any deadline.
  _setFastRunnerStateForTest(null);
  updateRefMapFromFlat(
    [
      {
        ref: '@e4',
        type: 'TextField',
        identifier: 'field',
        rect: { x: 21, y: 151, width: 360, height: 30 },
        hittable: true,
      },
    ],
    { snapshotGeneration: 7, keyboardVisible: false },
  );
  const f = fake(
    (ref, ctx, generation, id) => readIOSHitProbeWithReason(ref, BUNDLE, generation, ctx, id),
    () => covered({ type: 'TextField' }),
  );
  const { outcome, checks } = await walked(f, '1. Fill "field" with "x"\n');
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((c) => c !== 'capture'),
    [],
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].liveCheckReason, 'runner-refused');
});

test('W1: the production iOS session wires the reason-carrying reader', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const plan = '1. Wait for "Heading"';
  const request: WireRequest = {
    runId: 'synthetic-hit-probe-reason',
    t0: Date.now(),
    walkBudgetMs: 6000,
    attachBudgetMs: 2000,
    plan,
    prepared: preparePlan(plan, parsePlan(plan).blocks!),
    platform: 'ios',
    appId: BUNDLE,
    appRoot: root,
    runDir: root,
    lease: 'synthetic-hit-probe-reason:0123456789abcdef0123456789abcdef',
    target: {
      deviceId: '00000000-0000-0000-0000-000000000000',
      deviceName: 'Synthetic iPhone',
      metroPort: 65535,
      metroUrlForDevice: 'http://127.0.0.1:65535',
      worktree: root,
    },
    appSource: 'installed',
  };
  let close: (() => Promise<void>) | undefined;
  const snapshot = async () =>
    okResult({
      appProcessIdentifier: 41,
      nodes: [],
      truncated: false,
      normalizationDroppedNodes: 0,
    });
  const session = await openSession(
    request,
    () => undefined,
    () => undefined,
    (onClose) => (close = onClose),
    new ObservedPrivacy(),
    undefined,
    () => undefined,
    undefined,
    undefined,
    () => snapshot,
    async () => ({ active: false, warning: null, fromCache: false, scanMs: 0 }),
    async () => 41,
  );
  try {
    reply = wire({ hitProbe: 'unavailable', snapshotGeneration: 7, liveCheckReason: 'deadline' });
    assert.deepEqual(await session.deps.hitProbe!('@e6', context(), 7, identity), {
      result: 'unavailable',
      reason: 'deadline',
    });
  } finally {
    await close?.();
  }
});
