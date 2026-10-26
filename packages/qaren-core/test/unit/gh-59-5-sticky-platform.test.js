import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stickyPlatformFilters } from '../../dist/cdp/connect.js';

// GH #59 #5: after auto-detect connect resolves to platform X, _connectFilters
// must be updated so that subsequent softReconnect (cdp_reload) lands on the
// same platform. Explicit filters from the caller (B111/D643/G7) already
// survive; this closes the auto-detect gap.

test('stickyPlatformFilters: pins resolved platform when no explicit filter', () => {
  assert.deepEqual(
    stickyPlatformFilters({}, 'ios'),
    { platform: 'ios' },
    'auto-detect → ios sticks the resolved platform',
  );
});

test('stickyPlatformFilters: preserves other filters when pinning platform', () => {
  assert.deepEqual(
    stickyPlatformFilters({ bundleId: 'com.example' }, 'android'),
    { bundleId: 'com.example', platform: 'android' },
    'must merge with existing filters, not replace',
  );
});

test('stickyPlatformFilters: returns null when platform is already set', () => {
  // Explicit filters take precedence — never overwrite a user-pinned platform.
  assert.equal(
    stickyPlatformFilters({ platform: 'android' }, 'ios'),
    null,
    'never overwrites a user-supplied platform filter',
  );
});

test('stickyPlatformFilters: returns null when resolvedPlatform is missing', () => {
  // Some discovery paths may not surface platform — skip the update silently.
  assert.equal(stickyPlatformFilters({}, undefined), null);
});

test('stickyPlatformFilters: returns null when current has other filters but resolvedPlatform missing', () => {
  // Don't touch existing filters when there's nothing to sticky.
  assert.equal(stickyPlatformFilters({ bundleId: 'com.example' }, undefined), null);
});

test('stickyPlatformFilters: empty resolvedPlatform string is treated as missing', () => {
  // Defensive: an empty platform shouldn't leak into filters.
  assert.equal(stickyPlatformFilters({}, ''), null);
});
