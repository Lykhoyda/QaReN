import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForeignFlowGate, foreignGateEnabled } from '../../dist/lifecycle/foreign-flow-gate.js';

const WARNING = {
  platform: 'ios',
  code: 'IOS_XCUITEST_COMPETITOR',
  message: 'foreign maestro',
  processLines: ['1 maestro-driver'],
};

test('GH#186 gate: detection result is cached within the TTL (one scan per window)', async () => {
  let t = 0;
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return WARNING;
    },
    ttlMs: 5000,
    now: () => t,
  });
  const r1 = await gate.check('UDID-A');
  assert.equal(r1.active, true);
  assert.equal(r1.fromCache, false);
  t += 4000;
  const r2 = await gate.check('UDID-A');
  assert.equal(r2.active, true);
  assert.equal(r2.fromCache, true);
  assert.equal(scans, 1);
  t += 2000; // 6000 > ttl → rescan
  await gate.check('UDID-A');
  assert.equal(scans, 2);
});

test('GH#186 gate: a different udid busts the cache', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return null;
    },
    ttlMs: 5000,
    now: () => 0,
  });
  await gate.check('UDID-A');
  await gate.check('UDID-B');
  assert.equal(scans, 2);
});

test('GH#186 gate: detector error fails OPEN (active=false), error never escapes', async () => {
  const gate = new ForeignFlowGate({
    detect: async () => {
      throw new Error('ps timeout');
    },
    ttlMs: 5000,
    now: () => 0,
  });
  const r = await gate.check('UDID-A');
  assert.equal(r.active, false);
  assert.equal(gate.lastActive, false);
});

test('GH#186 gate: lastActive is a sync mirror of the latest check (for handler routing)', async () => {
  let result = WARNING;
  let t = 0;
  const gate = new ForeignFlowGate({ detect: async () => result, ttlMs: 5000, now: () => t });
  assert.equal(gate.lastActive, false, 'never checked → false');
  await gate.check('UDID-A');
  assert.equal(gate.lastActive, true);
  result = null;
  t += 6000;
  await gate.check('UDID-A');
  assert.equal(gate.lastActive, false);
});

test('GH#186 gate: scanMs is reported for fresh scans', async () => {
  let t = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      t += 17;
      return null;
    },
    ttlMs: 5000,
    now: () => t,
  });
  const r = await gate.check('UDID-A');
  assert.equal(r.scanMs, 17);
});

test('GH#186 gate: concurrent checks share one in-flight scan (no thundering herd)', async () => {
  let scans = 0;
  let release;
  const gate = new ForeignFlowGate({
    detect: () => {
      scans += 1;
      return new Promise((r) => {
        release = () => r(null);
      });
    },
    ttlMs: 5000,
    now: () => 0,
  });
  const p1 = gate.check('UDID-A');
  const p2 = gate.check('UDID-A');
  release();
  await Promise.all([p1, p2]);
  assert.equal(scans, 1);
});

// Plan-review SHOULD-FIX: the in-flight dedup must be udid-gated — a UDID-B
// caller must not receive UDID-A's in-flight answer.
test('GH#186 gate: a different udid does NOT share the in-flight scan', async () => {
  const releases = [];
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: () => {
      scans += 1;
      return new Promise((r) => releases.push(() => r(null)));
    },
    ttlMs: 5000,
    now: () => 0,
  });
  const p1 = gate.check('UDID-A');
  const p2 = gate.check('UDID-B');
  releases.forEach((r) => r());
  await Promise.all([p1, p2]);
  assert.equal(scans, 2);
});

test('GH#186 gate: enable knob — only RN_IOS_FOREIGN_GUARD disables the gate', () => {
  assert.equal(foreignGateEnabled({}), true, 'default on');
  assert.equal(foreignGateEnabled({ RN_IOS_FOREIGN_GUARD: '0' }), false);
  assert.equal(
    foreignGateEnabled({ RN_IOS_FOREIGN_WARN: '0' }),
    true,
    'the removed 1.x alias has no effect',
  );
});
