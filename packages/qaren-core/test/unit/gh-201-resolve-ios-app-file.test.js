import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowUsesClearState, resolveIosAppFile } from '../../dist/handlers/resolve-ios-app-file.js';

test('GH#201 flowUsesClearState detects clearState: true', () => {
  assert.equal(flowUsesClearState('- launchApp:\n    clearState: true\n'), true);
  assert.equal(flowUsesClearState('- launchApp:\n    clearState:   true'), true);
  assert.equal(flowUsesClearState('- tapOn: Login\n'), false);
  assert.equal(flowUsesClearState('clearState: false'), false);
});

// CONTRACT CHANGED by the GH#186 live-gate finding: the container path is
// never returned as-is anymore (clearState deletes it before the reinstall
// reads it) — a resolving container yields its SNAPSHOT.
test('GH#201 resolveIosAppFile snapshots the simctl container path when it exists', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: (id) => (id === 'com.example.app' ? '/sim/MyApp.app' : null),
    exists: (p) => p === '/sim/MyApp.app',
    snapshotApp: (src) => (src === '/sim/MyApp.app' ? '/tmp/rn-appfile-x/MyApp.app' : null),
    newestDerivedDataApp: () => assert.fail('should not fall back when container resolves'),
  });
  assert.equal(got, '/tmp/rn-appfile-x/MyApp.app');
});

test('GH#201 resolveIosAppFile falls back to newest DerivedData .app', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: () => null,
    newestDerivedDataApp: () => '/dd/Build/Products/Debug-iphonesimulator/MyApp.app',
    exists: (p) => p === '/dd/Build/Products/Debug-iphonesimulator/MyApp.app',
  });
  assert.equal(got, '/dd/Build/Products/Debug-iphonesimulator/MyApp.app');
});

test('GH#201 resolveIosAppFile returns null when nothing is found', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: () => null,
    newestDerivedDataApp: () => null,
    exists: () => false,
  });
  assert.equal(got, null);
});

// GH#186 Task 4 live-gate finding (B-entry): the resolver preferred the
// INSTALLED container path, but clearState uninstalls the app and deletes
// that container before maestro-runner reinstalls from --app-file → "No such
// file or directory" mid-flow, leaving the app uninstalled. A container-path
// resolution must be SNAPSHOTTED to a path that survives the uninstall.
test('GH#186 resolveIosAppFile: container path is snapshotted (never passed as-is into the doomed container)', () => {
  const container = '/CoreSim/Devices/UDID/data/Containers/Bundle/Application/ABC/my.app';
  const copies = [];
  const out = resolveIosAppFile('com.x.y', {
    getAppContainer: () => container,
    exists: () => true,
    snapshotApp: (src) => {
      copies.push(src);
      return '/tmp/snap-1/my.app';
    },
  });
  assert.equal(out, '/tmp/snap-1/my.app');
  assert.deepEqual(copies, [container]);
});

test('GH#186 resolveIosAppFile: snapshot failure falls through to DerivedData', () => {
  const out = resolveIosAppFile('com.x.y', {
    getAppContainer: () => '/CoreSim/.../my.app',
    exists: () => true,
    snapshotApp: () => null,
    newestDerivedDataApp: () => '/DD/Build/Products/Debug-iphonesimulator/my.app',
  });
  assert.equal(out, '/DD/Build/Products/Debug-iphonesimulator/my.app');
});
