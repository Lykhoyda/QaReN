// DISPATCH_OCCLUSION_GUARD_V1: an Android runner without the occlusion guard is stale and rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAndroidHealth } from '../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  REQUIRED_IOS_FEATURES,
} from '../../dist/runners/protocol.js';

test('an Android runner without DISPATCH_OCCLUSION_GUARD_V1 classifies for rebuild', () => {
  const health = {
    protocolVersion: 2,
    commands: [...REQUIRED_ANDROID_COMMANDS],
    capabilities: [
      'APP_SCOPED_EXACT_INTERACTION',
      'FILL_EVIDENCE_V1',
      'QA_READ_ONLY_V1',
      'SYSTEM_ALERT_TAP_V1',
      'A11Y_PRESENCE_V2',
    ],
  };
  assert.deepEqual(classifyAndroidHealth(health), {
    compatible: false,
    reason: 'missing-features',
    missing: ['DISPATCH_OCCLUSION_GUARD_V1'],
  });
  assert.deepEqual(
    classifyAndroidHealth({
      ...health,
      capabilities: [...health.capabilities, 'DISPATCH_OCCLUSION_GUARD_V1'],
    }),
    { compatible: true },
  );
});

test('the Android guard token is distinct from the iOS hit-tested dispatch token', () => {
  assert.ok(
    (REQUIRED_ANDROID_FEATURES as readonly string[]).includes('DISPATCH_OCCLUSION_GUARD_V1'),
  );
  assert.ok(!(REQUIRED_ANDROID_FEATURES as readonly string[]).includes('HIT_TESTED_DISPATCH_V1'));
  assert.ok(!(REQUIRED_IOS_FEATURES as readonly string[]).includes('DISPATCH_OCCLUSION_GUARD_V1'));
});
