// GH #262: best-effort lookup of a reinstallable .app snapshot in the GH #201
// bounded dir ($TMPDIR/rn-appfile-snapshots). Candidates are mtime-sorted
// NEWEST-FIRST BEFORE the ≤10 cap (readdir order is arbitrary — capping first
// could drop the newest match), then plutil-matched under a ~3s budget with
// deadline-clamped per-read timeouts. Never throws — the hint may add at most
// the bounded scan budget to an already-failed path and must never FAIL the
// report it rides on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSnapshotForBundleId,
  snapshotHintForBundleId,
} from '../../dist/handlers/resolve-ios-app-file.js';

const A = '/tmp/rn-appfile-snapshots/AppA.app';
const B = '/tmp/rn-appfile-snapshots/AppB.app';

test('findSnapshotForBundleId: matches CFBundleIdentifier; newest mtime wins', () => {
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: () => 'com.example.app',
    mtimeMs: (p) => (p === A ? 1000 : 2000),
    now: () => 10_000,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), { path: B, mtimeMs: 2000 });
});

test('findSnapshotForBundleId: sorts newest-first BEFORE the cap — newest survives a >10 dir', () => {
  // 12 decoys older than the target; readdir lists the target LAST.
  const decoys = Array.from({ length: 12 }, (_, i) => `/tmp/rn-appfile-snapshots/Decoy${i}.app`);
  const target = '/tmp/rn-appfile-snapshots/Target.app';
  const reads = [];
  const deps = {
    listSnapshots: () => [...decoys, target],
    readBundleId: (p) => {
      reads.push(p);
      return p === target ? 'com.example.app' : 'com.decoy';
    },
    mtimeMs: (p) => (p === target ? 99_000 : 1000),
    now: () => 0,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), {
    path: target,
    mtimeMs: 99_000,
  });
  assert.equal(reads[0], target, 'newest candidate is plutil-read first');
  assert.equal(reads.length, 1, 'first (newest) match short-circuits the scan');
});

test('findSnapshotForBundleId: no bundle-id match → null; at most 10 plutil reads', () => {
  let reads = 0;
  const deps = {
    listSnapshots: () =>
      Array.from({ length: 25 }, (_, i) => `/tmp/rn-appfile-snapshots/App${i}.app`),
    readBundleId: () => {
      reads += 1;
      return 'com.nomatch';
    },
    mtimeMs: () => 1000,
    now: () => 0,
  };
  assert.equal(findSnapshotForBundleId('com.example.app', deps), null);
  assert.equal(reads, 10);
});

test('findSnapshotForBundleId: unreadable Info.plist (readBundleId null) → candidate skipped', () => {
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: (p) => (p === B ? null : 'com.example.app'),
    mtimeMs: (p) => (p === A ? 1000 : 2000), // B newer but unreadable
    now: () => 0,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), { path: A, mtimeMs: 1000 });
});

test('findSnapshotForBundleId: budget overrun → stops before further plutil reads', () => {
  let reads = 0;
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: () => {
      reads += 1;
      return 'com.example.app';
    },
    mtimeMs: () => 1000,
    // First call (deadline calc) t=0; every later call is past the 3s budget.
    now: (() => {
      let calls = 0;
      return () => (calls++ === 0 ? 0 : 10_000);
    })(),
  };
  assert.equal(findSnapshotForBundleId('com.example.app', deps), null);
  assert.equal(reads, 0, 'no plutil read after budget exceeded');
});

test('findSnapshotForBundleId: per-read timeout is clamped to the remaining deadline', () => {
  const timeouts = [];
  let t = 0;
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: (p, timeoutMs) => {
      timeouts.push(timeoutMs);
      t += 1500;
      return 'com.nomatch';
    },
    mtimeMs: () => 1000,
    now: () => t,
  };
  findSnapshotForBundleId('com.example.app', deps);
  assert.equal(timeouts[0], 2000, 'full per-read timeout while budget is fresh');
  assert.ok(timeouts[1] < 2000, `second read clamped to remaining budget, got ${timeouts[1]}`);
});

test('snapshotHintForBundleId: converts mtime to ageMinutes (rounded, never negative)', () => {
  const deps = {
    listSnapshots: () => [A],
    readBundleId: () => 'com.example.app',
    mtimeMs: () => 0,
    now: () => 300_000, // 5 min later
  };
  assert.deepEqual(snapshotHintForBundleId('com.example.app', deps), { path: A, ageMinutes: 5 });
  assert.equal(snapshotHintForBundleId('com.missing', deps), null);
});

test('snapshotHintForBundleId: future mtime (clock skew) clamps to ageMinutes 0', () => {
  const deps = {
    listSnapshots: () => [A],
    readBundleId: () => 'com.example.app',
    mtimeMs: () => 600_000,
    now: () => 300_000,
  };
  assert.deepEqual(snapshotHintForBundleId('com.example.app', deps), { path: A, ageMinutes: 0 });
});

test('never throws: throwing deps → null from both functions', () => {
  const boom = () => {
    throw new Error('boom');
  };
  assert.equal(findSnapshotForBundleId('com.x', { listSnapshots: boom }), null);
  assert.equal(findSnapshotForBundleId('com.x', { listSnapshots: () => [A], mtimeMs: boom }), null);
  assert.equal(
    findSnapshotForBundleId('com.x', {
      listSnapshots: () => [A],
      mtimeMs: () => 1,
      readBundleId: boom,
    }),
    null,
  );
  assert.equal(
    findSnapshotForBundleId('com.x', { listSnapshots: () => [A], mtimeMs: () => 1, now: boom }),
    null,
  );
  assert.equal(snapshotHintForBundleId('com.x', { listSnapshots: boom }), null);
});
