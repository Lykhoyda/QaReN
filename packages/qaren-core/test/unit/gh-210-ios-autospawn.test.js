// GH #210 Task 2: device_* auto-spawns the rn-fast-runner from the runAgentDevice iOS
// choke point — cold-build-safe. decideRunnerSpawn is the pure decision; the runner only
// auto-starts when a prebuilt .xctestrun exists (never a silent multi-minute xcodebuild).
// ensureRunnerForCommand orchestrates probe→gate→start→re-verify and returns a STRUCTURED
// result (ensureFastRunner swallows start errors, so the re-verify is what turns a failed
// spawn into a clean message instead of the unstructured postCommand throw — A6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRunnerSpawn, ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';

// ── decideRunnerSpawn (pure) ──
test('#210 spawn-decision: runner alive → proceed (no spawn)', () => {
  assert.deepEqual(decideRunnerSpawn({ liveness: 'alive', prebuilt: false, deviceId: 'U' }), {
    action: 'proceed',
  });
});

test('#210 spawn-decision: down + prebuilt + deviceId → spawn', () => {
  assert.deepEqual(decideRunnerSpawn({ liveness: 'dead', prebuilt: true, deviceId: 'U' }), {
    action: 'spawn',
    deviceId: 'U',
  });
});

test('#210 spawn-decision: stale + prebuilt → spawn (ensureFastRunner reaps then starts)', () => {
  assert.deepEqual(decideRunnerSpawn({ liveness: 'stale', prebuilt: true, deviceId: 'U' }), {
    action: 'spawn',
    deviceId: 'U',
  });
});

test('#210 spawn-decision: down + NOT prebuilt → actionable error (no silent cold build)', () => {
  const d = decideRunnerSpawn({ liveness: 'dead', prebuilt: false, deviceId: 'U' });
  assert.equal(d.action, 'error');
  assert.match(d.message, /device_snapshot action=open/);
  assert.match(d.message, /build-for-testing|one-time|cold build/i);
});

test('#210 spawn-decision: down + prebuilt + NO deviceId → actionable error', () => {
  const d = decideRunnerSpawn({ liveness: 'dead', prebuilt: true, deviceId: null });
  assert.equal(d.action, 'error');
  assert.match(d.message, /no booted iOS simulator|device_snapshot action=open/i);
});

// ── ensureRunnerForCommand (orchestrator, structured result) ──
test('#210 ensureRunnerForCommand: alive → ok (no spawn)', async () => {
  let spawned = 0;
  const r = await ensureRunnerForCommand('U', 'com.x', {
    probe: async () => ({ liveness: 'alive' }),
    ensure: async () => {
      spawned++;
    },
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(spawned, 0);
});

test('#210 ensureRunnerForCommand: dead+prebuilt → spawns, re-verifies alive → ok', async () => {
  let n = 0;
  const r = await ensureRunnerForCommand('U', 'com.x', {
    probe: async () => (n++ === 0 ? { liveness: 'dead' } : { liveness: 'alive' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.deepEqual(r, { ok: true });
});

test('#210 ensureRunnerForCommand: attach-only reaches the native runner spawn contract', async () => {
  let n = 0;
  let observedOptions;
  const r = await ensureRunnerForCommand('U', 'com.x', {
    probe: async () => (n++ === 0 ? { liveness: 'dead' } : { liveness: 'alive' }),
    ensure: async (_deviceId, _bundleId, options) => {
      observedOptions = options;
    },
    prebuilt: () => true,
    adopt: () => {},
    attachOnly: true,
  });

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(observedOptions, { attachOnly: true });
});

test('#210 ensureRunnerForCommand: dead+NOT prebuilt → actionable error (no spawn)', async () => {
  let spawned = 0;
  const r = await ensureRunnerForCommand('U', 'com.x', {
    probe: async () => ({ liveness: 'dead' }),
    ensure: async () => {
      spawned++;
    },
    prebuilt: () => false,
    adopt: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /device_snapshot action=open/);
  assert.equal(spawned, 0);
});

test('#210 ensureRunnerForCommand: spawn does not bring it up (swallowed error) → structured fail, NOT a throw', async () => {
  const r = await ensureRunnerForCommand('U', 'com.x', {
    probe: async () => ({ liveness: 'dead' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not become ready/i);
});

test('#210 ensureRunnerForCommand: no deviceId → actionable error', async () => {
  const r = await ensureRunnerForCommand(null, 'com.x', {
    probe: async () => ({ liveness: 'dead' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /no booted iOS simulator|device_snapshot action=open/i);
});
