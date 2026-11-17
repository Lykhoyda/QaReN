import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createDeviceScrollHandler,
  createDeviceSwipeHandler,
} from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import {
  resetActiveSessionInMemoryForTest,
  setActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
} from '../../../dist/runners/qaren-ios-runner-client.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest as androidFetch,
} from '../../../dist/runners/qaren-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';

// The measured case: an iPhone 17 list band of 292 pt and a target 182 pt from the band's centre.
const BAND = { x: 0, y: 476, width: 402, height: 292 };
const END_HOLD = 'DRAG_END_HOLD_V1';
const previousSettle = process.env.RN_SETTLE;

afterEach(() => {
  if (previousSettle === undefined) delete process.env.RN_SETTLE;
  else process.env.RN_SETTLE = previousSettle;
  _setFastRunnerStateForTest(null);
  _setFetchForTest(fetch);
  _setCapabilitiesForTest([]);
  _setAndroidRunnerStateForTest(null);
  androidFetch(fetch);
  resetActiveSessionInMemoryForTest();
  clearRefMap();
});

function iphone(platform: 'ios' | 'android' = 'ios'): void {
  process.env.RN_SETTLE = '0';
  setActiveSessionInMemoryForTest({ name: 'qa', platform, appId: 'qa.app', deviceId: 'qa-device' });
  updateRefMapFromFlat(
    [{ ref: '@w', type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } }] as never,
    { snapshotGeneration: 1, keyboardVisible: false },
  );
}

// One ordered record of readiness reads, drag log lines and posted commands.
let events: string[] = [];

// cached: the capability list before the call; health: what this call's readiness check reads.
function iosRunner(cached: string[], health: string[]): Array<Record<string, unknown>> {
  events = [];
  _setFastRunnerStateForTest({
    pid: process.pid,
    port: 12345,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    capability: 'test-capability',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  } as never);
  _setCapabilitiesForTest([...REQUIRED_IOS_FEATURES, ...cached]);
  const commands: Array<Record<string, unknown>> = [];
  _setFetchForTest((async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/health')) {
      events.push('health');
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1', ...health],
      });
    }
    const { commandId: _commandId, ...body } = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    commands.push(body);
    events.push(String(body.command));
    return Response.json(
      body.command === 'snapshot' ? { ok: true, data: { nodes: [] }, v: 1 } : { ok: true },
    );
  }) as typeof fetch);
  return commands;
}

async function dragLines(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    if (String(chunk).includes('scroll drag')) events.push('log');
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return lines.filter((line) => line.includes('scroll drag'));
}

const context = () => new QaDispatchContext(10, () => 1);

const placing = (distance: number, band = BAND) =>
  createDeviceScrollHandler()({
    direction: 'down',
    distance,
    within: band,
    endAtRest: true,
    qaContext: context(),
  } as never);

const DRAG = { command: 'drag', x: 201, y: 738, x2: 201, y2: 556, durationMs: 300 };
const ANDROID_PLACING = {
  command: 'drag',
  appBundleId: 'qa.app',
  x1: 201,
  y1: 738,
  x2: 201,
  y2: 556,
  durationMs: 300,
};
const LINE =
  'qaren-core: scroll drag (201,738)->(201,556) band=(0,476,402,292) kb=none duration=300ms';

for (const { name, cached } of [
  { name: 'known before the call', cached: [END_HOLD] },
  { name: 'brought by this call’s readiness check', cached: [] },
]) {
  test(`S1 a placing scroll that covers its distance ends held (capability ${name})`, async () => {
    iphone();
    const commands = iosRunner(cached, [END_HOLD]);
    const lines = await dragLines(() => placing(182));
    assert.deepEqual(commands, [{ ...DRAG, appBundleId: 'qa.app', endHoldMs: 250 }]);
    assert.deepEqual(lines, [`${LINE} endHold=250ms\n`]);
    assert.deepEqual(events, ['health', 'log', 'drag']);
  });
}

for (const { name, cached } of [
  { name: 'never listed', cached: [] },
  { name: 'listed before the call, dropped by this call’s readiness check', cached: [END_HOLD] },
]) {
  test(`S4 a runner without the capability gets no hold and the log says so (${name})`, async () => {
    iphone();
    const commands = iosRunner(cached, []);
    const lines = await dragLines(() => placing(182));
    assert.deepEqual(commands, [{ ...DRAG, appBundleId: 'qa.app' }]);
    assert.deepEqual(lines, [`${LINE} endHold=unsupported\n`]);
    assert.deepEqual(events, ['health', 'log', 'drag']);
  });
}

test('S2 a searching scroll and a plain scroll step are sent without a hold', async () => {
  iphone();
  const commands = iosRunner([END_HOLD], [END_HOLD]);
  const lines = await dragLines(async () => {
    await createDeviceScrollHandler()({ direction: 'down', within: BAND, qaContext: context() });
    await createDeviceScrollHandler()({
      direction: 'down',
      distance: 182,
      within: BAND,
      qaContext: context(),
    });
  });
  assert.deepEqual(commands, [
    {
      command: 'drag',
      x: 201,
      y: 738,
      x2: 201,
      y2: 477,
      durationMs: 300,
      appBundleId: 'qa.app',
    },
    { ...DRAG, appBundleId: 'qa.app' },
  ]);
  assert.deepEqual(lines, [
    'qaren-core: scroll drag (201,738)->(201,477) band=(0,476,402,292) kb=none duration=300ms endHold=none\n',
    `${LINE} endHold=none\n`,
  ]);
});

test('S3 a swipe is sent without a hold', async () => {
  iphone();
  const commands = iosRunner([END_HOLD], [END_HOLD]);
  await createDeviceSwipeHandler()({ direction: 'up', qaContext: context() });
  await createDeviceSwipeHandler()({
    x1: 201,
    y1: 738,
    x2: 201,
    y2: 556,
    durationMs: 300,
    qaContext: context(),
  });
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.equal(command.command, 'drag');
    assert.equal('endHoldMs' in command, false);
  }
});

test('S5 an Android placing scroll sends the same command as before', async () => {
  iphone('android');
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 12345,
    devicePort: 12345,
    pid: process.pid,
    deviceId: 'qa-device',
    bundleId: 'qa.app',
    startedAt: '',
    protocolVersion: 2,
  });
  const commands: Array<Record<string, unknown>> = [];
  androidFetch((async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, 'QA_READ_ONLY_V1', END_HOLD],
      });
    const { commandId: _commandId, ...body } = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    commands.push(body);
    return Response.json({ ok: true });
  }) as typeof fetch);
  const result = await placing(182);
  assert.equal(JSON.parse(result.content[0].text).ok, true);
  assert.deepEqual(commands, [ANDROID_PLACING]);
});

test('S6 a placing drag the band cuts short, a horizontal one, and one a point short by rounding are sent without a hold', async () => {
  iphone();
  const commands = iosRunner([END_HOLD], [END_HOLD]);
  const lines = await dragLines(async () => {
    await placing(428);
    // A distance that rounds to 0 is covered by any travel, so only the direction keeps these unheld.
    for (const [direction, distance] of [
      ['right', 182],
      ['left', 0.4],
    ] as const)
      await createDeviceScrollHandler()({
        direction,
        distance,
        within: BAND,
        endAtRest: true,
        qaContext: context(),
      } as never);
    await placing(261, { x: 0, y: 476.5, width: 402, height: 291.5 });
  });
  assert.deepEqual(
    commands.map(({ x, y, x2, y2, endHoldMs }) => ({ x, y, x2, y2, endHoldMs })),
    [
      { x: 201, y: 738, x2: 201, y2: 477, endHoldMs: undefined },
      { x: 161, y: 622, x2: 241, y2: 622, endHoldMs: undefined },
      { x: 241, y: 622, x2: 161, y2: 622, endHoldMs: undefined },
      { x: 201, y: 738, x2: 201, y2: 478, endHoldMs: undefined },
    ],
  );
  assert.ok(commands.every((command) => !('endHoldMs' in command)));
  assert.deepEqual(
    lines.map((line) => line.slice(line.lastIndexOf(' ') + 1)),
    ['endHold=none\n', 'endHold=none\n', 'endHold=none\n', 'endHold=none\n'],
  );
});
