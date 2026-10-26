import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNetworkBufferManager,
  resetNetworkBufferManager,
} from '../../dist/cdp/network-buffer-manager.js';

// B128 (D657) regression: DeviceBufferManager must be process-scoped, not
// instance-scoped. Before this fix, CDPClient owned the manager; every
// cdp_connect(force:true) or cdp_restart wiped all buffers because the
// client (and its manager) got destroyed + rebuilt.

test('getNetworkBufferManager: returns the same instance across calls (singleton)', () => {
  resetNetworkBufferManager();
  const a = getNetworkBufferManager();
  const b = getNetworkBufferManager();
  assert.equal(a, b, 'singleton returns identical reference across calls');
});

test('getNetworkBufferManager: B128 regression — buffers survive simulated CDPClient rebuild', () => {
  resetNetworkBufferManager();

  // Simulate session 1 (iOS): push 3 events to device key A
  const mgr1 = getNetworkBufferManager();
  const iosKey = '8081-ios-target-1';
  mgr1.push(iosKey, { id: 'r1', method: 'GET', url: '/users', timestamp: '2026-04-20T16:00:00Z' });
  mgr1.push(iosKey, { id: 'r2', method: 'GET', url: '/posts', timestamp: '2026-04-20T16:00:01Z' });
  mgr1.push(iosKey, { id: 'r3', method: 'POST', url: '/login', timestamp: '2026-04-20T16:00:02Z' });

  assert.equal(mgr1.size(iosKey), 3, 'iOS buffer populated');

  // Simulate cdp_connect(force:true) tearing down CDPClient and rebuilding.
  // The OLD code would wipe the manager here; the NEW code returns the SAME
  // singleton on the next call, preserving the iOS buffer.
  // (In the real implementation, `new CDPClient()` calls `getNetworkBufferManager()`
  // which returns the existing singleton. No explicit destroy happens — the old
  // client just goes out of scope with its reference.)
  const mgr2 = getNetworkBufferManager();

  assert.equal(mgr1, mgr2, 'rebuild-equivalent sequence returns the same manager');
  assert.equal(mgr2.size(iosKey), 3, 'iOS buffer survives — the whole point of B128');

  // Session 2 (Android): push events to a different device key — both buffers
  // coexist, neither clobbers the other.
  const androidKey = '8081-android-target-1';
  mgr2.push(androidKey, {
    id: 'a1',
    method: 'GET',
    url: '/feed',
    timestamp: '2026-04-20T16:05:00Z',
  });
  mgr2.push(androidKey, {
    id: 'a2',
    method: 'GET',
    url: '/notifs',
    timestamp: '2026-04-20T16:05:01Z',
  });

  assert.equal(mgr2.size(iosKey), 3, 'iOS buffer unchanged by Android activity');
  assert.equal(mgr2.size(androidKey), 2, 'Android buffer populated');

  // `all` merge returns union
  const all = mgr2.getLast('all', 100);
  assert.equal(all.length, 5, 'all merge sees both device buffers');

  // Switch back to iOS — history intact
  assert.deepEqual(
    mgr2.getLast(iosKey, 10).map((e) => e.url),
    ['/users', '/posts', '/login'],
    'iOS history accessible after switching back',
  );
});

test('getNetworkBufferManager: resetNetworkBufferManager is test-only (clears state)', () => {
  const mgr1 = getNetworkBufferManager();
  mgr1.push('test-device', {
    id: 'x',
    method: 'GET',
    url: '/x',
    timestamp: '2026-04-20T00:00:00Z',
  });
  assert.equal(mgr1.size('test-device'), 1);

  resetNetworkBufferManager();

  const mgr2 = getNetworkBufferManager();
  assert.notEqual(mgr1, mgr2, 'after reset, getNetworkBufferManager returns a fresh instance');
  assert.equal(mgr2.size('test-device'), 0, 'fresh instance has no history');
});

test('getNetworkBufferManager: capacity and eviction work on the singleton', () => {
  resetNetworkBufferManager();
  const mgr = getNetworkBufferManager();

  // Default max-devices = 10; push to 11 distinct devices, confirm oldest evicted.
  // Eviction uses DeviceBufferManager's lastPush Map ordering (insertion order as
  // reinforced by strict `<` comparison of Date.now() values). Distinct
  // timestamps aren't required — Map iteration preserves insertion order and the
  // first-inserted device is evicted when capacity is exceeded.
  for (let i = 0; i < 11; i++) {
    mgr.push(`device-${i}`, {
      id: `r${i}`,
      method: 'GET',
      url: `/u${i}`,
      timestamp: `2026-04-20T00:00:0${i}Z`,
    });
  }

  // `device-0` should be evicted (oldest last-push)
  assert.equal(mgr.size('device-0'), 0, 'oldest device evicted at cap');
  assert.equal(mgr.size('device-10'), 1, 'newest device present');
});
