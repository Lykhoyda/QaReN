import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// GH #629: the first-start retry is permitted only when the failed attempt
// actually reached the launch xcodebuild. ensureFastRunner swallows every
// startFastRunner error, so the launch counter is the sole evidence — a
// failure BEFORE the launch step (artifact resolution, missing project, a
// failed cold build) must leave it untouched, or the retry re-pays the whole
// multi-minute build window on a deterministically broken checkout.

// The runner directory is resolved at module load, so point it at an empty
// stand-in before importing: startFastRunner then fails at project resolution,
// which is upstream of both the build steps and spawn().
const runnerRoot = mkdtempSync(join(tmpdir(), 'gh-629-runner-root-'));
mkdirSync(join(runnerRoot, 'rn-fast-runner'), { recursive: true });
process.env.QAREN_NATIVE_RUNNER_ROOT = runnerRoot;

const {
  startFastRunner,
  getRunnerLaunchCount,
  awaitSpawnedRunnerExit,
  _setFastRunnerStateForTest,
} = await import('../../dist/runners/rn-fast-runner-client.js');

test.after(() => {
  rmSync(runnerRoot, { recursive: true, force: true });
  delete process.env.QAREN_NATIVE_RUNNER_ROOT;
});

test('a start that fails before the launch step does not advance the launch count', async () => {
  const saved = process.env.QAREN_DEVICE_LEASE;
  process.env.QAREN_DEVICE_LEASE = `gh-629-${randomUUID()}:${'f'.repeat(32)}`;
  const before = getRunnerLaunchCount();
  try {
    await assert.rejects(
      startFastRunner(randomUUID().toUpperCase(), 'com.example.gh629'),
      /RnFastRunner\.xcodeproj not found/,
    );
    assert.equal(
      getRunnerLaunchCount(),
      before,
      'no launch child existed, so the retry gate must stay closed',
    );
  } finally {
    if (saved === undefined) delete process.env.QAREN_DEVICE_LEASE;
    else process.env.QAREN_DEVICE_LEASE = saved;
  }
});

test('the settle refuses when the launch handle belongs to a newer generation', async () => {
  // A concurrent dispatch's start replaces the global handle. Signalling it
  // would SIGKILL a runner this caller never launched, so a generation the
  // module no longer recognises must refuse — immediately, without settling.
  const t0 = Date.now();
  assert.equal(await awaitSpawnedRunnerExit(50, getRunnerLaunchCount() + 1), false);
  assert.ok(Date.now() - t0 < 500, 'a foreign generation must short-circuit, not wait or signal');
});

test('the settle proceeds for the generation the caller actually observed', async () => {
  assert.equal(await awaitSpawnedRunnerExit(50, getRunnerLaunchCount()), true);
});

test('a runner that came up mid-settle is not claimed as this caller settling its own launch', async () => {
  // The seam sets runnerState while nulling the handle — the shape a concurrent
  // dispatch leaves behind when its start reaches READY during our settle.
  // Without the state guard this falls through to the null handle and answers
  // true, which would let the caller retry and then report another dispatch's
  // runner as 'ready after one first-start retry'.
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: process.pid,
    port: 22088,
    deviceId: 'gh-629-concurrent',
    bundleId: 'com.example.gh629',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 2,
  } as never);
  try {
    const t0 = Date.now();
    // Generation matches, so only the live-runner guard can refuse here.
    assert.equal(await awaitSpawnedRunnerExit(50, getRunnerLaunchCount()), false);
    assert.ok(Date.now() - t0 < 500, 'a live runner must short-circuit, not settle or signal');
  } finally {
    _setFastRunnerStateForTest(null);
  }
});

test('a start refused for a missing device lease does not advance the launch count', async () => {
  const saved = process.env.QAREN_DEVICE_LEASE;
  delete process.env.QAREN_DEVICE_LEASE;
  const before = getRunnerLaunchCount();
  try {
    await assert.rejects(
      startFastRunner(randomUUID().toUpperCase(), 'com.example.gh629'),
      /DEVICE_LEASE_REQUIRED/,
    );
    assert.equal(getRunnerLaunchCount(), before);
  } finally {
    if (saved !== undefined) process.env.QAREN_DEVICE_LEASE = saved;
  }
});
