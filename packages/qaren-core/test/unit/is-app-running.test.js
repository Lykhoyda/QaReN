import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppRunning } from '../../dist/handlers/device-session.js';

// B112/D641: isAppRunning dispatches to platform-specific probes. Probes
// are injectable so tests don't spawn subprocesses.

test('isAppRunning routes bundle and exact device ID to the iOS probe', async () => {
  let called = null;
  const result = await isAppRunning(
    'ios',
    'com.foo.app',
    {
      ios: async (id, deviceId) => {
        called = { id, deviceId };
        return true;
      },
      android: async () => {
        throw new Error('should not reach android');
      },
    },
    'EXACT-UDID',
  );
  assert.deepEqual(called, { id: 'com.foo.app', deviceId: 'EXACT-UDID' });
  assert.equal(result, true);
});

test('isAppRunning routes to Android probe for android platform', async () => {
  let called = null;
  const result = await isAppRunning('android', 'com.foo.app', {
    ios: async () => {
      throw new Error('should not reach ios');
    },
    android: async (id) => {
      called = id;
      return true;
    },
  });
  assert.equal(called, 'com.foo.app');
  assert.equal(result, true);
});

test('isAppRunning defaults to iOS when platform is undefined and identity is exact', async () => {
  const result = await isAppRunning(
    undefined,
    'com.foo.app',
    {
      ios: async () => true,
      android: async () => false,
    },
    'EXACT-UDID',
  );
  assert.equal(result, true);
});

test('isAppRunning refuses iOS liveness when exact identity is absent', async () => {
  let probed = false;
  const result = await isAppRunning('ios', 'com.foo.app', {
    ios: async () => {
      probed = true;
      return true;
    },
  });
  assert.equal(result, false);
  assert.equal(probed, false);
});

test('isAppRunning returns false when the exact iOS probe says no', async () => {
  const result = await isAppRunning(
    'ios',
    'com.missing.app',
    {
      ios: async () => false,
    },
    'EXACT-UDID',
  );
  assert.equal(result, false);
});

test('isAppRunning returns false when the Android probe says no', async () => {
  const result = await isAppRunning('android', 'com.missing.app', {
    android: async () => false,
  });
  assert.equal(result, false);
});

test('isAppRunning is case-insensitive on platform', async () => {
  const resultUpper = await isAppRunning('ANDROID', 'com.foo', {
    android: async () => true,
  });
  const resultMixed = await isAppRunning(
    'iOS',
    'com.foo',
    {
      ios: async () => true,
    },
    'EXACT-UDID',
  );
  assert.equal(resultUpper, true);
  assert.equal(resultMixed, true);
});
