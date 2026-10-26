import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterValidTargets, selectTarget } from '../../dist/cdp/discovery.js';

test('filterValidTargets drops targets without webSocketDebuggerUrl', () => {
  const out = filterValidTargets([
    { id: '1', vm: 'Hermes' },
    { id: '2', vm: 'Hermes', webSocketDebuggerUrl: 'ws://127.0.0.1:8081/a' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '2');
});

test('filterValidTargets drops Experimental targets', () => {
  const out = filterValidTargets([
    { id: '1', title: 'Experimental JS', vm: 'Hermes', webSocketDebuggerUrl: 'ws://x/a' },
    { id: '2', vm: 'Hermes', webSocketDebuggerUrl: 'ws://x/b' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '2');
});

test('filterValidTargets accepts React Native targets without Hermes VM', () => {
  const out = filterValidTargets([
    { id: '1', title: 'React Native Bridge', webSocketDebuggerUrl: 'ws://x/a' },
    { id: '2', description: 'React Native: whatever', webSocketDebuggerUrl: 'ws://x/b' },
    { id: '3', title: 'Chrome tab', webSocketDebuggerUrl: 'ws://x/c' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.id).sort(), ['1', '2']);
});

test('filterValidTargets rewrites IPv6 localhost to 127.0.0.1', () => {
  const out = filterValidTargets([
    { id: '1', vm: 'Hermes', webSocketDebuggerUrl: 'ws://[::1]:8081/abc' },
    { id: '2', vm: 'Hermes', webSocketDebuggerUrl: 'ws://[::]:8081/def' },
  ]);
  assert.ok(out[0].webSocketDebuggerUrl.includes('127.0.0.1'));
  assert.ok(!out[0].webSocketDebuggerUrl.includes('[::1]'));
  assert.ok(out[1].webSocketDebuggerUrl.includes('127.0.0.1'));
});

test('selectTarget sorts by page id descending (newest session first)', () => {
  const targets = [
    { id: 'page-1', platform: 'ios' },
    { id: 'page-3', platform: 'ios' },
    { id: 'page-2', platform: 'ios' },
  ];
  const { targets: sorted } = selectTarget(targets);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['page-3', 'page-2', 'page-1'],
  );
});

test('selectTarget with platform filter returns matching targets only', () => {
  const targets = [
    { id: 'page-1', platform: 'ios' },
    { id: 'page-2', platform: 'android' },
    { id: 'page-3', platform: 'ios' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, 'ios');
  assert.equal(sorted.length, 2);
  assert.equal(warning, undefined);
  assert.ok(sorted.every((t) => t.platform === 'ios'));
});

test('selectTarget refuses title-only platform guesses under an explicit filter', () => {
  const targets = [
    { id: 'page-1', title: 'Hermes ios', description: 'org.foo.ios' },
    { id: 'page-2', title: 'Android Metro' },
  ];
  const { targets: sorted, errorCode, warning } = selectTarget(targets, 'ios');
  assert.equal(sorted.length, 0);
  assert.equal(errorCode, 'PLATFORM_TARGET_NOT_FOUND');
  assert.match(warning, /cannot be proven/);
});

test('selectTarget returns warning when platform filter matches nothing', () => {
  const targets = [
    { id: 'page-1', platform: 'ios', description: 'org.foo.a' },
    { id: 'page-2', platform: 'ios', description: 'org.foo.b' },
  ];
  const { targets: sorted, warning, errorCode } = selectTarget(targets, 'android');
  assert.equal(sorted.length, 0);
  assert.equal(errorCode, 'PLATFORM_TARGET_NOT_FOUND');
  assert.ok(warning);
  assert.match(warning, /android/);
});

test('selectTarget with no filter returns every target sorted with a best-available warning', () => {
  const targets = [
    { id: 'page-1', platform: 'ios' },
    { id: 'page-2', platform: 'android' },
  ];
  const { targets: sorted, warning } = selectTarget(targets);
  assert.equal(sorted.length, 2);
  assert.match(warning, /No platform filter/);
});

// ── B111 / D635: targetId + bundleId filters ──────────────────────────

test('selectTarget with targetId returns only the exact-id match', () => {
  const targets = [
    { id: '008aba-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '008aba-2', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { targetId: '6f8d21-2' });
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, '6f8d21-2');
  assert.equal(warning, undefined);
});

test('selectTarget with unknown targetId hard-fails (B111/D643: was silent fallthrough)', () => {
  const targets = [
    { id: '008aba-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { targetId: 'does-not-exist' });
  assert.equal(sorted.length, 0);
  assert.ok(warning);
  assert.match(warning, /targetId "does-not-exist" not found/);
  assert.match(warning, /008aba-1/);
  assert.match(warning, /6f8d21-2/);
});

test('selectTarget with bundleId filters zombie targets out', () => {
  const targets = [
    { id: '008aba-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '008aba-2', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted } = selectTarget(targets, { bundleId: 'com.rndevagent.testapp' });
  assert.equal(sorted.length, 2);
  assert.ok(sorted.every((t) => t.description === 'com.rndevagent.testapp'));
  // Sort still picks the highest page id within the bundle
  assert.equal(sorted[0].id, '6f8d21-2');
});

test('selectTarget with unknown bundleId hard-fails (B111/D643: was silent fallthrough)', () => {
  const targets = [
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { bundleId: 'com.different.app' });
  assert.equal(sorted.length, 0);
  assert.ok(warning);
  assert.match(warning, /bundleId "com.different.app" not found/);
  assert.match(warning, /com.rndevagent.testapp/);
});

test('selectTarget preferredBundleId is soft filter — only applies when it narrows', () => {
  const targets = [
    { id: '008aba-2', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  // Preferred matches one target → narrows to it
  const { targets: narrowed } = selectTarget(targets, {
    preferredBundleId: 'com.rndevagent.testapp',
  });
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0].description, 'com.rndevagent.testapp');

  // Preferred matches nothing → doesn't eliminate candidates
  const { targets: fallthrough } = selectTarget(targets, { preferredBundleId: 'com.other.app' });
  assert.equal(fallthrough.length, 2);
});

test('selectTarget: targetId takes precedence over bundleId', () => {
  const targets = [
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted } = selectTarget(targets, {
    targetId: '6f8d21-1',
    bundleId: 'com.rndevagent.testapp',
  });
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, '6f8d21-1');
});

test('selectTarget: legacy string signature still works', () => {
  const targets = [
    { id: '1', platform: 'ios' },
    { id: '2', platform: 'android' },
  ];
  const { targets: sorted } = selectTarget(targets, 'ios');
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, '1');
});

// ── B111 / D643: zombie target hardening (Phase 91) ───────────────────

test('selectTarget: bundleId hard-fails on single-target mismatch (B111/D643)', () => {
  // Pre-D643, the bundleId check was guarded by `length > 1` and silently
  // skipped this case — connecting to the wrong app. Now hard-fails.
  const targets = [{ id: 'aaa-1', platform: 'ios', description: 'com.zombie.app' }];
  const { targets: sorted, warning } = selectTarget(targets, { bundleId: 'com.realapp' });
  assert.equal(sorted.length, 0);
  assert.match(warning, /bundleId "com.realapp" not found/);
  assert.match(warning, /com.zombie.app/);
});

test('selectTarget: bundleId match is case-insensitive (B111/D643/G4)', () => {
  const targets = [
    { id: 'aaa-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: 'bbb-1', platform: 'ios', description: 'host.exp.exponent' },
  ];
  const { targets: sorted } = selectTarget(targets, { bundleId: 'HOST.EXP.EXPONENT' });
  assert.equal(sorted.length, 2);
  assert.ok(sorted.every((t) => t.description?.toLowerCase() === 'host.exp.exponent'));
});

test('selectTarget: preferredBundleId match is case-insensitive (B111/D643/G4)', () => {
  const targets = [
    { id: 'aaa-1', platform: 'ios', description: 'HOST.EXP.EXPONENT' },
    { id: 'bbb-1', platform: 'ios', description: 'com.myapp' },
  ];
  const { targets: sorted } = selectTarget(targets, { preferredBundleId: 'host.exp.exponent' });
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, 'aaa-1');
});

test('selectTarget: zombie tie-break — preferredBundleId picks fresh over zombie at equal page (B111/D643/G3)', () => {
  // Core B111 regression. Both targets have page-id `1` so the numeric sort
  // is a tie. Without preferredBundleId, JS sort stability dictates which wins —
  // a flake. With preferredBundleId pointing at the real app, fresh always wins.
  const targets = [
    { id: 'aaaaaaa-1', platform: 'ios', description: 'host.exp.Exponent', title: 'Hermes' },
    { id: 'bbbbbbb-1', platform: 'ios', description: 'com.myapp', title: 'Hermes' },
  ];
  const { targets: sorted } = selectTarget(targets, { preferredBundleId: 'com.myapp' });
  assert.equal(sorted[0].description, 'com.myapp');
  // narrowed via soft filter — only matching target survives
  assert.equal(sorted.length, 1);
});

test('selectTarget: lexicographic id tie-break is deterministic when no preferredBundleId (B111/D643/G5)', () => {
  // Same page-id, no preferredBundleId — fall back to ascending lex by full id
  // for a stable, repeatable result. This is determinism, not zombie-avoidance
  // (zombie-avoidance is preferredBundleId's job — see G3 above).
  const targets = [
    { id: 'zzz-5', platform: 'ios', description: 'com.appA' },
    { id: 'aaa-5', platform: 'ios', description: 'com.appB' },
  ];
  const { targets: sorted } = selectTarget(targets);
  assert.equal(sorted.length, 2);
  // ascending lex by id: 'aaa-5' before 'zzz-5'
  assert.equal(sorted[0].id, 'aaa-5');
  assert.equal(sorted[1].id, 'zzz-5');
});

test('selectTarget: warning includes available ids when targetId not found (B111/D643/G9)', () => {
  const targets = [
    { id: 'real-1', platform: 'ios', description: 'com.app' },
    { id: 'real-2', platform: 'ios', description: 'com.app' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { targetId: 'phantom-99' });
  assert.equal(sorted.length, 0);
  assert.ok(warning);
  // Caller-actionable: tells them what's actually available
  assert.match(warning, /Available ids: real-1, real-2/);
});

// ── B116 / D639: platform inference via simctl listapps + adb pm list ──

import {
  parseSimctlListapps,
  inferPlatforms,
  inferPlatformFromDeviceName,
} from '../../dist/cdp/discovery.js';

test('parseSimctlListapps extracts top-level bundle IDs only', () => {
  const input = `{
    "com.apple.Bridge" =     {
        CFBundleIdentifier = "com.apple.Bridge";
        GroupContainers =         {
            "group.com.apple.bridge" = "file:///...";
            "243LU875E5.groups.com.apple.podcasts" = "file:///...";
        };
    };
    "com.rndevagent.testapp" =     {
        CFBundleIdentifier = "com.rndevagent.testapp";
    };
}`;
  const ids = parseSimctlListapps(input);
  assert.deepEqual([...ids].sort(), ['com.apple.Bridge', 'com.rndevagent.testapp']);
});

test('parseSimctlListapps skips nested GroupContainers entries', () => {
  const input = `    "com.real" =     {
        GroupContainers = {
            "group.com.fake" = "...";
        };
    };`;
  const ids = parseSimctlListapps(input);
  assert.equal(ids.has('com.real'), true);
  assert.equal(ids.has('group.com.fake'), false);
});

test('parseSimctlListapps handles empty input', () => {
  assert.equal(parseSimctlListapps('').size, 0);
  assert.equal(parseSimctlListapps('{}').size, 0);
});

test('inferPlatforms tags android-only bundle as android', () => {
  const targets = [{ id: '1', description: 'com.android.only' }];
  inferPlatforms(targets, {
    readAndroid: () => new Set(['com.android.only']),
    readIOS: () => new Set(),
  });
  assert.equal(targets[0].platform, 'android');
  assert.equal(targets[0].ambiguousPlatform, undefined);
});

test('inferPlatforms tags iOS-only bundle as ios (was wrongly tagged android pre-B116)', () => {
  const targets = [{ id: '1', description: 'com.ios.only' }];
  inferPlatforms(targets, {
    readAndroid: () => new Set(), // adb running but this bundle not installed on Android
    readIOS: () => new Set(['com.ios.only']),
  });
  assert.equal(targets[0].platform, 'ios');
  assert.equal(targets[0].ambiguousPlatform, undefined);
});

test('inferPlatforms marks ambiguous when bundleId is on both platforms', () => {
  const targets = [
    { id: '1', description: 'com.dual.app' },
    { id: '2', description: 'com.dual.app' },
  ];
  inferPlatforms(targets, {
    readAndroid: () => new Set(['com.dual.app']),
    readIOS: () => new Set(['com.dual.app']),
  });
  // Default to ios, but flag for downstream disambiguation
  for (const t of targets) {
    assert.equal(t.platform, 'ios');
    assert.equal(t.ambiguousPlatform, true);
  }
});

test('inferPlatforms defaults to ios when both readers return null (no tooling)', () => {
  const targets = [{ id: '1', description: 'com.some.app' }];
  inferPlatforms(targets, {
    readAndroid: () => null,
    readIOS: () => null,
  });
  assert.equal(targets[0].platform, 'ios');
});

test('inferPlatforms defaults to ios when bundle is in neither set', () => {
  const targets = [{ id: '1', description: 'com.unknown.app' }];
  inferPlatforms(targets, {
    readAndroid: () => new Set(['com.other.app']),
    readIOS: () => new Set(['com.different.app']),
  });
  assert.equal(targets[0].platform, 'ios');
});

test('inferPlatforms handles mixed targets correctly', () => {
  const targets = [
    { id: '1', description: 'com.android.only' },
    { id: '2', description: 'com.ios.only' },
    { id: '3', description: 'com.dual.app' },
    { id: '4', description: 'com.unknown' },
  ];
  inferPlatforms(targets, {
    readAndroid: () => new Set(['com.android.only', 'com.dual.app']),
    readIOS: () => new Set(['com.ios.only', 'com.dual.app']),
  });
  assert.equal(targets[0].platform, 'android');
  assert.equal(targets[1].platform, 'ios');
  assert.equal(targets[2].platform, 'ios');
  assert.equal(targets[2].ambiguousPlatform, true);
  assert.equal(targets[3].platform, 'ios');
});

// ── B131 / D660: deviceName-based platform inference ──

test('inferPlatformFromDeviceName: detects iOS simulator names', () => {
  assert.equal(inferPlatformFromDeviceName('iPhone 17 Pro'), 'ios');
  assert.equal(inferPlatformFromDeviceName('iPhone 15'), 'ios');
  assert.equal(inferPlatformFromDeviceName('iPad Pro (12.9-inch)'), 'ios');
  assert.equal(inferPlatformFromDeviceName('iPod touch'), 'ios');
});

test('inferPlatformFromDeviceName: detects Android emulator names', () => {
  assert.equal(inferPlatformFromDeviceName('sdk_gphone16k_arm64 - 17 - API 37'), 'android');
  assert.equal(inferPlatformFromDeviceName('sdk_gphone_x86'), 'android');
  assert.equal(inferPlatformFromDeviceName('emulator-5554'), 'android');
  assert.equal(inferPlatformFromDeviceName('Pixel 7'), 'android');
  assert.equal(inferPlatformFromDeviceName('Galaxy S23'), 'android');
});

test('inferPlatformFromDeviceName: case-insensitive', () => {
  assert.equal(inferPlatformFromDeviceName('IPHONE 17 PRO'), 'ios');
  assert.equal(inferPlatformFromDeviceName('sdk_gphone_ARM64'), 'android');
});

test('inferPlatformFromDeviceName: returns null for empty / unrecognized', () => {
  assert.equal(inferPlatformFromDeviceName(undefined), null);
  assert.equal(inferPlatformFromDeviceName(''), null);
  assert.equal(inferPlatformFromDeviceName('Unknown Device'), null);
  assert.equal(inferPlatformFromDeviceName('React Native Bridgeless'), null);
});

test('inferPlatforms: B131 regression — deviceName overrides package-list inference for dual-install bundle', () => {
  // The exact B131 scenario: com.rndevagent.testapp installed on both iOS and
  // Android. Old code marked the android target `platform: ios, ambiguousPlatform: true`.
  // New code reads deviceName and assigns correctly.
  const targets = [
    { id: 'ios1', description: 'com.rndevagent.testapp', deviceName: 'iPhone 17 Pro' },
    {
      id: 'and1',
      description: 'com.rndevagent.testapp',
      deviceName: 'sdk_gphone16k_arm64 - 17 - API 37',
    },
  ];
  inferPlatforms(targets, {
    readAndroid: () => new Set(['com.rndevagent.testapp']),
    readIOS: () => new Set(['com.rndevagent.testapp']),
  });
  assert.equal(targets[0].platform, 'ios');
  assert.equal(targets[1].platform, 'android');
  // Critically: ambiguousPlatform should NOT be set because deviceName disambiguated
  assert.notEqual(targets[0].ambiguousPlatform, true);
  assert.notEqual(targets[1].ambiguousPlatform, true);
});

test('inferPlatforms: falls back to package-list when deviceName is unrecognized', () => {
  const targets = [{ id: '1', description: 'com.app', deviceName: 'Mystery Device' }];
  inferPlatforms(targets, {
    readAndroid: () => new Set(['com.app']),
    readIOS: () => new Set(),
  });
  assert.equal(targets[0].platform, 'android', 'falls back to package-list → android');
});

test('inferPlatforms: falls back to package-list when deviceName absent', () => {
  const targets = [
    { id: '1', description: 'com.ios.only' }, // no deviceName
  ];
  inferPlatforms(targets, {
    readAndroid: () => new Set(),
    readIOS: () => new Set(['com.ios.only']),
  });
  assert.equal(targets[0].platform, 'ios');
});

// ── Value-free inference evidence carried on a selection refusal ──

import { discoverExactPort } from '../../dist/cdp/discovery.js';

function countingReaders(values) {
  const calls = { readAndroid: 0, readIOS: 0, readIOSDeviceNames: 0, readAndroidDeviceModels: 0 };
  const readers = Object.fromEntries(
    Object.keys(calls).map((key) => [
      key,
      () => {
        calls[key]++;
        return values[key] ?? null;
      },
    ]),
  );
  return { calls, readers };
}

const evidenceOf = (summary) =>
  summary.targets.map(({ name, identity, packages, confidence }) => ({
    name,
    identity,
    packages,
    confidence,
  }));

test('inference summary: every reader null leaves a tokenless target defaulted and says so', () => {
  const targets = [{ id: '1', description: 'com.private.app', deviceName: 'Office Phone' }];
  const { calls, readers } = countingReaders({});
  const summary = inferPlatforms(targets, readers);
  assert.equal(targets[0].platform, 'ios');
  assert.equal(targets[0].platformInference, 'defaulted');
  assert.deepEqual(summary.readers, {
    androidPackages: 'null',
    iosPackages: 'null',
    iosDeviceNames: 'null',
    androidDeviceModels: 'null',
  });
  assert.deepEqual(summary.targets, [
    {
      token: 'none',
      name: 'neither',
      identity: 'present',
      packages: 'neither',
      confidence: 'defaulted',
    },
  ]);
  assert.deepEqual(calls, {
    readAndroid: 1,
    readIOS: 1,
    readIOSDeviceNames: 1,
    readAndroidDeviceModels: 1,
  });
});

test('inference summary: a null lazy reader is re-read per tokenless target, a nonempty one once', () => {
  const targets = [
    { id: '1', description: 'com.app', deviceName: 'Office Phone' },
    { id: '2', description: 'com.app', deviceName: 'Desk Phone' },
  ];
  const { calls, readers } = countingReaders({
    readAndroid: new Set(),
    readIOS: new Set(),
    readIOSDeviceNames: new Set(['lab device']),
  });
  const summary = inferPlatforms(targets, readers);
  assert.equal(calls.readIOSDeviceNames, 1);
  assert.equal(calls.readAndroidDeviceModels, 2);
  assert.deepEqual(summary.readers, {
    androidPackages: 'empty',
    iosPackages: 'empty',
    iosDeviceNames: 'nonempty',
    androidDeviceModels: 'null',
  });
});

test('inference summary: a one-sided inventory name proves the platform before packages', () => {
  const targets = [{ id: '1', description: 'com.app', deviceName: 'Office Phone' }];
  const { readers } = countingReaders({ readIOSDeviceNames: new Set(['office phone']) });
  const summary = inferPlatforms(targets, readers);
  assert.equal(targets[0].platformInference, 'probed');
  assert.deepEqual(evidenceOf(summary), [
    { name: 'ios_only', identity: 'not_reached', packages: 'not_reached', confidence: 'probed' },
  ]);
});

test('inference summary: a name in both inventories falls through to the package branch', () => {
  const targets = [{ id: '1', description: 'com.dual.app', deviceName: 'Pixel Lab' }];
  const { readers } = countingReaders({
    readAndroid: new Set(['com.dual.app']),
    readIOS: new Set(['com.dual.app']),
    readIOSDeviceNames: new Set(['pixel lab']),
    readAndroidDeviceModels: new Set(['pixel lab']),
  });
  const summary = inferPlatforms(targets, readers);
  assert.equal(targets[0].platformInference, 'probed', 'pixel is an Android name token');
  const tokenless = [{ id: '2', description: 'com.dual.app', deviceName: 'Lab Unit' }];
  const both = countingReaders({
    readAndroid: new Set(['com.dual.app']),
    readIOS: new Set(['com.dual.app']),
    readIOSDeviceNames: new Set(['lab unit']),
    readAndroidDeviceModels: new Set(['lab unit']),
  });
  assert.equal(summary.targets[0].token, 'android');
  assert.deepEqual(evidenceOf(inferPlatforms(tokenless, both.readers)), [
    { name: 'both', identity: 'present', packages: 'both', confidence: 'ambiguous' },
  ]);
  assert.equal(tokenless[0].ambiguousPlatform, true);
});

test('inference summary: a conflicting bundle identity is missing, and absent names are absent', () => {
  const targets = [{ id: '1', appId: 'com.first.app', description: 'com.second.app' }];
  const { calls, readers } = countingReaders({ readAndroid: new Set(['com.first.app']) });
  const summary = inferPlatforms(targets, readers);
  assert.equal(targets[0].platformInference, 'defaulted');
  assert.deepEqual(evidenceOf(summary), [
    { name: 'absent', identity: 'missing', packages: 'not_reached', confidence: 'defaulted' },
  ]);
  assert.equal(calls.readIOSDeviceNames, 0);
  assert.equal(summary.readers.iosDeviceNames, 'not_consumed');
});

test('inference summary: name tokens never consume the lazy device readers', () => {
  const targets = [
    { id: '1', description: 'com.app', deviceName: 'iPhone 17 Pro' },
    { id: '2', description: 'com.app', deviceName: 'sdk_gphone64_arm64 - 16 - API 36' },
  ];
  const { calls, readers } = countingReaders({});
  const summary = inferPlatforms(targets, readers);
  assert.deepEqual(
    summary.targets.map((entry) => [entry.token, entry.name]),
    [
      ['ios', 'not_reached'],
      ['android', 'not_reached'],
    ],
  );
  assert.equal(summary.readers.iosDeviceNames, 'not_consumed');
  assert.equal(summary.readers.androidDeviceModels, 'not_consumed');
  assert.equal(calls.readIOSDeviceNames + calls.readAndroidDeviceModels, 0);
});

test('inference summary carries no target ids, titles, app ids, device names or URLs', () => {
  const targets = [
    {
      id: 'PRIVATE-target-1',
      title: 'com.private.app (Private Phone)',
      appId: 'com.private.app',
      description: 'com.private.app',
      deviceName: 'Private Phone',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=PRIVATE',
    },
  ];
  const { readers } = countingReaders({ readIOS: new Set(['com.private.app']) });
  const text = JSON.stringify(inferPlatforms(targets, readers));
  for (const sentinel of ['PRIVATE', 'private', 'ws:', '8081']) assert.ok(!text.includes(sentinel));
});

test('exact-port selection refusal carries index-aligned device and bundle matches', async () => {
  const port = 8342;
  const target = (id, deviceName, appId) => ({
    id,
    title: `${appId} (${deviceName})`,
    description: 'React Native Bridgeless [C++ connection]',
    appId,
    type: 'node',
    deviceName,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=${id}&page=1`,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => [
      target('a-1', 'iPhone 17 Pro', 'com.example.app'),
      target('b-1', 'iPhone 16', 'com.other.app'),
    ],
  });
  try {
    const result = await discoverExactPort(port, {
      platform: 'android',
      bundleId: 'com.example.app',
      deviceName: 'iPhone 17 Pro',
    });
    assert.equal(result.errorCode, 'PLATFORM_TARGET_NOT_FOUND');
    assert.deepEqual(
      result.inference.targets.map(({ token, deviceMatch, bundleMatch }) => ({
        token,
        deviceMatch,
        bundleMatch,
      })),
      [
        { token: 'ios', deviceMatch: true, bundleMatch: true },
        { token: 'ios', deviceMatch: false, bundleMatch: false },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
