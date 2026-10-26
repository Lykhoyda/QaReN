import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceBufferManager, makeDeviceKey, NO_DEVICE_KEY } from '../../dist/ring-buffer.js';

// ── Key helper ──

test('makeDeviceKey: combines port and targetId', () => {
  assert.equal(makeDeviceKey(8081, 'page1'), '8081-page1');
});

test('makeDeviceKey: uses sentinels for null/undefined', () => {
  assert.equal(makeDeviceKey(null, null), NO_DEVICE_KEY);
  assert.equal(makeDeviceKey(undefined, undefined), NO_DEVICE_KEY);
  assert.equal(makeDeviceKey(8081, null), '8081-notarget');
  assert.equal(makeDeviceKey(null, 'page1'), 'noport-page1');
});

test('NO_DEVICE_KEY matches the double-null form', () => {
  assert.equal(NO_DEVICE_KEY, makeDeviceKey(null, null));
});

// ── Basic push + getLast ──

test('DeviceBufferManager: pushes to the correct device bucket', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  mgr.push('ios-1', { value: 'a' });
  mgr.push('ios-1', { value: 'b' });
  mgr.push('android-1', { value: 'x' });

  assert.deepEqual(
    mgr.getLast('ios-1', 10).map((e) => e.value),
    ['a', 'b'],
  );
  assert.deepEqual(
    mgr.getLast('android-1', 10).map((e) => e.value),
    ['x'],
  );
  assert.equal(mgr.deviceCount, 2);
});

test('DeviceBufferManager: getLast on unknown device returns empty array (not error)', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  assert.deepEqual(mgr.getLast('never-seen', 10), []);
});

test('DeviceBufferManager: per-device capacity overflow evicts oldest within THAT device only', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 3 });
  for (let i = 0; i < 5; i++) mgr.push('dev-a', { i });
  mgr.push('dev-b', { x: 1 });

  assert.deepEqual(
    mgr.getLast('dev-a', 10).map((e) => e.i),
    [2, 3, 4],
  );
  assert.deepEqual(mgr.getLast('dev-b', 10), [{ x: 1 }], 'dev-b unaffected by dev-a overflow');
});

// ── maxDevices eviction ──

test('DeviceBufferManager: evicts oldest device (by last-push) when maxDevices reached', async () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10, maxDevices: 3 });

  mgr.push('d1', { x: 1 });
  await new Promise((r) => setTimeout(r, 5));
  mgr.push('d2', { x: 2 });
  await new Promise((r) => setTimeout(r, 5));
  mgr.push('d3', { x: 3 });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(mgr.deviceCount, 3);

  // Add a 4th → d1 (oldest last-push) evicted
  mgr.push('d4', { x: 4 });
  assert.equal(mgr.deviceCount, 3);
  assert.deepEqual(mgr.getLast('d1', 10), [], 'd1 evicted');
  assert.deepEqual(mgr.getLast('d4', 10), [{ x: 4 }], 'd4 present');
});

test('DeviceBufferManager: recently-pushed device survives eviction even if old', async () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10, maxDevices: 3 });

  mgr.push('d1', { x: 1 });
  mgr.push('d2', { x: 2 });
  mgr.push('d3', { x: 3 });
  await new Promise((r) => setTimeout(r, 5));

  // Re-push d1 → now d2 is the oldest by last-push
  mgr.push('d1', { x: 11 });
  mgr.push('d4', { x: 4 });

  assert.deepEqual(
    mgr.getLast('d1', 10).map((e) => e.x),
    [1, 11],
    'd1 survived because of re-push',
  );
  assert.deepEqual(mgr.getLast('d2', 10), [], 'd2 evicted as new-oldest');
});

// ── Cross-device 'all' aggregation ──

test('DeviceBufferManager: "all" merges across devices in chronological order (with timestampOf)', () => {
  const mgr = new DeviceBufferManager({
    capacityPerDevice: 10,
    timestampOf: (e) => e.ts,
  });
  mgr.push('d1', { ts: 300, label: 'd1-late' });
  mgr.push('d2', { ts: 100, label: 'd2-early' });
  mgr.push('d1', { ts: 200, label: 'd1-mid' });

  const all = mgr.getLast('all', 10);
  assert.deepEqual(
    all.map((e) => e.label),
    ['d2-early', 'd1-mid', 'd1-late'],
    'merged results are timestamp-sorted',
  );
});

test('DeviceBufferManager: "all" respects the n limit (tails to most recent)', () => {
  const mgr = new DeviceBufferManager({
    capacityPerDevice: 10,
    timestampOf: (e) => e.ts,
  });
  for (let i = 1; i <= 5; i++) mgr.push('d1', { ts: i });
  for (let i = 6; i <= 10; i++) mgr.push('d2', { ts: i });

  const last3 = mgr.getLast('all', 3);
  assert.deepEqual(
    last3.map((e) => e.ts),
    [8, 9, 10],
    '"all" limit applied after sorting',
  );
});

test('DeviceBufferManager: "all" falls back to concatenation when no timestampOf', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  mgr.push('d1', { v: 1 });
  mgr.push('d1', { v: 2 });
  mgr.push('d2', { v: 99 });

  const all = mgr.getLast('all', 10);
  // Exact order not guaranteed, but all 3 entries must be present.
  assert.equal(all.length, 3);
  const values = all.map((e) => e.v).sort((a, b) => a - b);
  assert.deepEqual(values, [1, 2, 99]);
});

// ── filter ──

test('DeviceBufferManager: filter scoped to one device', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  mgr.push('d1', { url: '/users', v: 1 });
  mgr.push('d1', { url: '/posts', v: 2 });
  mgr.push('d2', { url: '/users', v: 3 });

  const d1Users = mgr.filter('d1', (e) => e.url === '/users');
  assert.deepEqual(
    d1Users.map((e) => e.v),
    [1],
  );
});

test('DeviceBufferManager: filter with "all" merges and sorts', () => {
  const mgr = new DeviceBufferManager({
    capacityPerDevice: 10,
    timestampOf: (e) => e.ts,
  });
  mgr.push('d1', { ts: 300, url: '/users', v: 1 });
  mgr.push('d2', { ts: 100, url: '/users', v: 2 });
  mgr.push('d1', { ts: 200, url: '/posts', v: 3 });

  const users = mgr.filter('all', (e) => e.url === '/users');
  assert.deepEqual(
    users.map((e) => e.v),
    [2, 1],
    'sorted by ts',
  );
});

// ── getByKey ──

test('DeviceBufferManager: getByKey with indexKey scoped to one device', () => {
  const mgr = new DeviceBufferManager({
    capacityPerDevice: 10,
    indexKey: (e) => e.id,
  });
  mgr.push('d1', { id: 'req-1', url: '/users' });
  mgr.push('d2', { id: 'req-2', url: '/posts' });

  assert.equal(mgr.getByKey('d1', 'req-1')?.url, '/users');
  assert.equal(mgr.getByKey('d1', 'req-2'), undefined, "d1 does not see d2's req");
  assert.equal(mgr.getByKey('d2', 'req-2')?.url, '/posts');
});

test('DeviceBufferManager: getByKey("all") searches all devices', () => {
  const mgr = new DeviceBufferManager({
    capacityPerDevice: 10,
    indexKey: (e) => e.id,
  });
  mgr.push('d1', { id: 'req-1', url: '/users' });
  mgr.push('d2', { id: 'req-2', url: '/posts' });

  assert.equal(mgr.getByKey('all', 'req-1')?.url, '/users');
  assert.equal(mgr.getByKey('all', 'req-2')?.url, '/posts');
  assert.equal(mgr.getByKey('all', 'req-missing'), undefined);
});

// ── clear ──

test('DeviceBufferManager: clear(deviceKey) wipes only that device', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  mgr.push('d1', { v: 1 });
  mgr.push('d2', { v: 2 });

  mgr.clear('d1');
  assert.equal(mgr.size('d1'), 0);
  assert.equal(mgr.size('d2'), 1);
});

test('DeviceBufferManager: clear() with no args wipes every device', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  mgr.push('d1', { v: 1 });
  mgr.push('d2', { v: 2 });

  mgr.clear();
  assert.equal(mgr.deviceCount, 0);
  assert.equal(mgr.totalSize, 0);
});

// ── Size tracking ──

test('DeviceBufferManager: size/totalSize/deviceCount track correctly', () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  assert.equal(mgr.deviceCount, 0);
  assert.equal(mgr.totalSize, 0);
  assert.equal(mgr.size('never-seen'), 0);

  mgr.push('d1', { v: 1 });
  mgr.push('d1', { v: 2 });
  mgr.push('d2', { v: 3 });

  assert.equal(mgr.deviceCount, 2);
  assert.equal(mgr.totalSize, 3);
  assert.equal(mgr.size('d1'), 2);
  assert.equal(mgr.size('d2'), 1);
});

test('DeviceBufferManager: deviceKeys() returns keys in last-push order', async () => {
  const mgr = new DeviceBufferManager({ capacityPerDevice: 10 });
  mgr.push('d1', { v: 1 });
  await new Promise((r) => setTimeout(r, 5));
  mgr.push('d2', { v: 2 });
  await new Promise((r) => setTimeout(r, 5));
  mgr.push('d3', { v: 3 });
  await new Promise((r) => setTimeout(r, 5));
  mgr.push('d1', { v: 4 }); // re-push moves d1 to most-recent

  assert.deepEqual(mgr.deviceKeys(), ['d2', 'd3', 'd1']);
});

// ── Regression: the original stale-logs-across-devices bug ──

test('DeviceBufferManager: switching device no longer leaks stale entries into the new device view', () => {
  const mgr = new DeviceBufferManager({
    capacityPerDevice: 10,
    indexKey: (e) => e.id,
  });

  // Simulate iOS session
  const iosKey = makeDeviceKey(8081, 'ios-target-1');
  mgr.push(iosKey, {
    id: 'req-old',
    method: 'GET',
    url: '/stale',
    timestamp: '2026-04-01T00:00:00Z',
  });

  // Switch to Android — different key
  const androidKey = makeDeviceKey(8081, 'android-target-1');
  mgr.push(androidKey, {
    id: 'req-new',
    method: 'GET',
    url: '/fresh',
    timestamp: '2026-04-20T00:00:00Z',
  });

  assert.deepEqual(
    mgr.getLast(androidKey, 10).map((e) => e.url),
    ['/fresh'],
    'android view contains ONLY android traffic',
  );
  assert.equal(
    mgr.getByKey(androidKey, 'req-old'),
    undefined,
    'iOS request id is invisible from android device scope',
  );
});
