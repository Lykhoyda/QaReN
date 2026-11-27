import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postAdmissionSnapshots } from '../../../dist/qa/capture.js';
import { okResult } from '../../../dist/utils.js';

// iOS snapshots carry the app's process; Android snapshots do not.
const iosSnapshot = (pid = 41) =>
  okResult({ appProcessIdentifier: pid, nodes: [] }, { meta: { foregroundSurface: 'app' } });
const androidSnapshot = () => okResult({ nodes: [] }, { meta: { foregroundSurface: 'app' } });

test('C1 iOS: a runner relaunch beside the same app process is recorded and not counted', async () => {
  const snapshots = postAdmissionSnapshots(async () => iosSnapshot(41), 'com.test');
  await snapshots.snapshot({});
  snapshots.admit();
  snapshots.runnerRelaunched(41, 41);
  await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), false);
  const events = snapshots.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].signal, 'runner-recovery');
  assert.equal(events[0].counted, false);
  assert.deepEqual(events[0].detail, { recoveryTier: 'runner-relaunch', fromPid: 41, toPid: 41 });
});

test('C2 Android: a proven same-process relaunch leaves no unresolved baseline behind', async () => {
  const snapshots = postAdmissionSnapshots(async () => androidSnapshot(), 'com.test');
  await snapshots.snapshot({});
  snapshots.admit();
  snapshots.runnerRelaunched(900, 900);
  await snapshots.snapshot({});
  await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), false);
  assert.equal(snapshots.events().filter((event) => event.counted).length, 0);
});

test('C3 a relaunch beside a different app process is counted', async () => {
  const snapshots = postAdmissionSnapshots(async () => iosSnapshot(41), 'com.test');
  await snapshots.snapshot({});
  snapshots.admit();
  snapshots.runnerRelaunched(41, 77);
  assert.equal(snapshots.interrupted(), true);
});

test('C4 an unproven relaunch is decided by the next snapshot that carries the process', async () => {
  for (const [next, interrupted] of [
    [41, false],
    [77, true],
  ] as const) {
    const observations = [iosSnapshot(41), iosSnapshot(next)];
    const snapshots = postAdmissionSnapshots(async () => observations.shift()!, 'com.test');
    await snapshots.snapshot({});
    snapshots.admit();
    snapshots.runnerRelaunched(41, undefined);
    await snapshots.snapshot({});
    assert.equal(snapshots.interrupted(), interrupted, `next pid ${next}`);
  }
});

test('C5 Android: an unproven relaunch is counted at the end, never assumed continuous', async () => {
  const snapshots = postAdmissionSnapshots(async () => androidSnapshot(), 'com.test');
  await snapshots.snapshot({});
  snapshots.admit();
  snapshots.runnerRelaunched(900, undefined);
  await snapshots.snapshot({});
  assert.equal(snapshots.interrupted(), true);
});
