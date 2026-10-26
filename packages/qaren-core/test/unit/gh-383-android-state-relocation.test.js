import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  androidStatePath,
  parsePersistedAndroidState,
  parseLegacyAndroidState,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import { getStateDir } from '../../dist/util/secure-state-file.js';

afterEach(() => _setAndroidRunnerStateForTest(null));

const VALID = {
  schemaVersion: 1,
  hostPort: 22089,
  devicePort: 22089,
  pid: 999,
  deviceId: 'emulator-5554',
  startedAt: '2026-07-02T00:00:00.000Z',
  protocolVersion: 1,
};

test('gh-383 android: per-serial path (no default key — review amendment)', () => {
  assert.equal(
    androidStatePath('emulator-5554'),
    join(getStateDir(), 'runner-state', 'android-emulator-5554.json'),
  );
});

test('gh-383 android: parse accepts schema v1 live pid, rejects everything else', () => {
  assert.deepEqual(
    parsePersistedAndroidState(VALID, () => true),
    VALID,
  );
  assert.equal(
    parsePersistedAndroidState(VALID, () => false),
    null,
  );
  assert.equal(
    parsePersistedAndroidState({ ...VALID, schemaVersion: 0 }, () => true),
    null,
  );
  assert.equal(
    parsePersistedAndroidState({ ...VALID, hostPort: 'x' }, () => true),
    null,
  );
  assert.equal(
    parsePersistedAndroidState(null, () => true),
    null,
  );
});

test('gh-383 android: legacy /tmp state parses leniently with protocolVersion 0', () => {
  const legacy = {
    hostPort: 22089,
    devicePort: 22089,
    pid: 999,
    deviceId: 'emulator-5554',
    startedAt: 'x',
  };
  const parsed = parseLegacyAndroidState(legacy, () => true);
  assert.equal(parsed.protocolVersion, 0);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(
    parseLegacyAndroidState(legacy, () => false),
    null,
  );
  assert.equal(
    parseLegacyAndroidState({ hostPort: 1 }, () => true),
    null,
  );
});
