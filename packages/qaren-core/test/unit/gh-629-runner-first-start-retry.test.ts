import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';
import type { FastRunnerLivenessDetail } from '../../dist/runners/rn-fast-runner-client.js';

// GH #629: a fresh simulator's first XCTest bootstrap predictably overruns the
// warm READY window, so the first spawn dies while its side effects make an
// immediate second spawn succeed. ensureRunnerForCommand must absorb that with
// exactly one bounded internal retry — and still fail typed + bounded when the
// runner is genuinely broken.

interface Script {
  probes: FastRunnerLivenessDetail[];
  ensureCalls: Array<{ deviceId: string; attachOnly?: boolean }>;
  events: string[];
  launches: number;
}

function makeDeps(
  probeSequence: FastRunnerLivenessDetail[],
  opts: { attachOnly?: boolean; spawnExitSettles?: boolean; reachesLaunch?: boolean } = {},
) {
  const script: Script = { probes: [...probeSequence], ensureCalls: [], events: [], launches: 0 };
  const lastProbe = probeSequence[probeSequence.length - 1]!;
  return {
    script,
    deps: {
      probe: async () => script.probes.shift() ?? lastProbe,
      // ensureFastRunner swallows startFastRunner errors, so a spawn that never
      // reached the launch xcodebuild is indistinguishable here except by the
      // launch counter — which the fixture only advances when it did.
      ensure: async (deviceId: string, _bundleId: string, o?: { attachOnly?: boolean }) => {
        script.events.push('ensure');
        script.ensureCalls.push({
          deviceId,
          ...(o?.attachOnly !== undefined ? { attachOnly: o.attachOnly } : {}),
        });
        if (opts.reachesLaunch ?? true) script.launches += 1;
      },
      launchCount: () => script.launches,
      prebuilt: () => true,
      adopt: () => {},
      awaitSpawnExit: async () => {
        script.events.push('awaitSpawnExit');
        return opts.spawnExitSettles ?? true;
      },
      ...(opts.attachOnly !== undefined ? { attachOnly: opts.attachOnly } : {}),
    },
  };
}

const DEAD: FastRunnerLivenessDetail = { liveness: 'dead' };
const ALIVE: FastRunnerLivenessDetail = { liveness: 'alive' };

test('first-start transient: one bounded retry turns RN_FAST_RUNNER_DOWN into success', async () => {
  // probe #1: pre-spawn (dead) → spawn; probe #2: still dead (fresh-sim
  // bootstrap overran READY); retry spawn; probe #3: alive.
  const { script, deps } = makeDeps([DEAD, DEAD, ALIVE]);
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(script.ensureCalls.length, 2, 'exactly one internal retry spawn');
  assert.ok(
    result.ok && result.note && /retry/i.test(result.note),
    'retry is surfaced in the note',
  );
  // No stacked launches: the failed first spawn must be settled before retry.
  assert.deepEqual(script.events, ['ensure', 'awaitSpawnExit', 'ensure']);
});

test('retry is refused when the first spawn survives kill escalation (no stacked launch)', async () => {
  const { script, deps } = makeDeps([DEAD, DEAD], { spawnExitSettles: false });
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /did not become ready after auto-spawn/.test(result.message));
  assert.equal(script.ensureCalls.length, 1, 'a surviving first spawn forbids the retry');
});

test('retry is refused when the first attempt never reached the launch xcodebuild', async () => {
  // Artifact resolution / cold-build failure: ensureFastRunner swallowed the
  // error, so the probe reads dead with no staleReason — but no launch child
  // ever existed, and re-entering ensure() would re-pay the whole build window.
  const { script, deps } = makeDeps([DEAD, DEAD], { reachesLaunch: false });
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, false);
  assert.equal(script.ensureCalls.length, 1, 'a pre-launch failure must not be retried');
  assert.deepEqual(script.events, ['ensure'], 'no settle wait for a spawn that never launched');
  assert.ok(!result.ok && !/one internal retry included/.test(result.message));
});

test('retry is permitted once the first attempt did launch, and is reported as such', async () => {
  const { script, deps } = makeDeps([DEAD, DEAD, DEAD], { reachesLaunch: true });
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, false);
  assert.equal(script.ensureCalls.length, 2, 'a launched-then-dead first spawn earns the retry');
  assert.deepEqual(script.events, ['ensure', 'awaitSpawnExit', 'ensure']);
  assert.ok(!result.ok && /one internal retry included/.test(result.message));
});

test('the real settle refuses the retry when another dispatch owns the launch handle', async () => {
  // No awaitSpawnExit injected: the production settle runs. The fixture reports
  // a launch generation this process never produced — the shape a concurrent
  // device_* dispatch creates by replacing the global handle mid-settle.
  const script = { probes: [DEAD, DEAD] as FastRunnerLivenessDetail[], ensures: 0 };
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', {
    probe: async () => script.probes.shift() ?? DEAD,
    ensure: async () => {
      script.ensures += 1;
    },
    launchCount: () => script.ensures,
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(script.ensures, 1, 'a handle owned by another dispatch forbids the retry');
  assert.ok(!result.ok && !/one internal retry included/.test(result.message));
});

test('genuine runner failure stays typed and bounded: exactly two spawn attempts', async () => {
  const { script, deps } = makeDeps([DEAD, DEAD, DEAD]);
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /did not become ready after auto-spawn/.test(result.message));
  assert.equal(script.ensureCalls.length, 2, 'no unbounded retries');
});

test('healthy first spawn needs no retry and carries no retry note', async () => {
  const { script, deps } = makeDeps([DEAD, ALIVE]);
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, true);
  assert.equal(script.ensureCalls.length, 1);
  assert.equal(result.ok && result.note, undefined);
});

test('typed post-spawn staleness surfaces without burning the retry', async () => {
  const { script, deps } = makeDeps([
    DEAD,
    { liveness: 'stale', staleReason: 'protocol-older', runnerProtocolVersion: 1 },
  ]);
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === 'RUNNER_PROTOCOL_MISMATCH', JSON.stringify(result));
  assert.equal(script.ensureCalls.length, 1, 'typed failures must not trigger the transient retry');
});

test('attachOnly is preserved across the internal retry spawn', async () => {
  const { script, deps } = makeDeps([DEAD, DEAD, ALIVE], { attachOnly: true });
  const result = await ensureRunnerForCommand('SIM-UDID', 'com.example.app', deps);
  assert.equal(result.ok, true);
  assert.deepEqual(
    script.ensureCalls.map((c) => c.attachOnly),
    [true, true],
  );
});

test('device_snapshot action=open maps the exhausted-retry failure to RN_FAST_RUNNER_DOWN', async () => {
  const { createDeviceSnapshotHandler } = await import('../../dist/handlers/device-session.js');
  const deviceId = randomUUID().toUpperCase();
  const handler = createDeviceSnapshotHandler({
    isAppRunning: async () => true,
    ensureIosRunner: async () => ({
      ok: false,
      message:
        'rn-fast-runner did not become ready after auto-spawn (one internal retry included). Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.',
    }),
    stopIosRunner: async () => {},
  });
  const result = await handler({
    action: 'open',
    platform: 'ios',
    deviceId,
    appId: 'com.example.app',
    attachOnly: true,
  });
  const body = JSON.parse(result.content[0]!.text) as { ok: boolean; code?: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'RN_FAST_RUNNER_DOWN');
});
