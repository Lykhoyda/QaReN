// GH #383: iOS runner state moves from /tmp/rn-fast-runner-state.json to a
// per-UDID hardened file under <stateDir>/runner-state/ios-<udid>.json.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  iosStatePath,
  parsePersistedRunnerState,
  parseLegacyRunnerState,
  adoptPersistedFastRunnerState,
  getFastRunnerState,
  _setRunnerStateForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import { getStateDir } from '../../dist/util/secure-state-file.js';

afterEach(() => _setRunnerStateForTest(null));

const VALID = {
  schemaVersion: 1,
  port: 22088,
  pid: 4242,
  deviceId: 'UDID-1',
  bundleId: 'com.example',
  startedAt: '2026-07-02T00:00:00.000Z',
  protocolVersion: 1,
};

test('gh-383 ios: state path is per-device under runner-state/', () => {
  assert.equal(iosStatePath('UDID-1'), join(getStateDir(), 'runner-state', 'ios-UDID-1.json'));
});

test('gh-383 ios: parse accepts schema v1 with a live pid', () => {
  const parsed = parsePersistedRunnerState(VALID, () => true);
  assert.deepEqual(parsed, VALID);
});

test('gh-383 ios: parse rejects dead pid, wrong schema, malformed shapes', () => {
  assert.equal(
    parsePersistedRunnerState(VALID, () => false),
    null,
  );
  assert.equal(
    parsePersistedRunnerState({ ...VALID, schemaVersion: 2 }, () => true),
    null,
  );
  assert.equal(
    parsePersistedRunnerState({ ...VALID, schemaVersion: undefined }, () => true),
    null,
  );
  assert.equal(
    parsePersistedRunnerState(null, () => true),
    null,
  );
  assert.equal(
    parsePersistedRunnerState('junk', () => true),
    null,
  );
  assert.equal(
    parsePersistedRunnerState({ ...VALID, pid: 'x' }, () => true),
    null,
  );
});

test('gh-383 ios: adopt is a no-op when in-memory state exists or deviceId missing', () => {
  _setRunnerStateForTest(VALID);
  adoptPersistedFastRunnerState('UDID-OTHER');
  assert.deepEqual(getFastRunnerState(), {
    ...VALID,
    capability: 'test-capability'.repeat(3),
  });
  _setRunnerStateForTest(null);
  adoptPersistedFastRunnerState(undefined);
  assert.equal(getFastRunnerState(), null);
});

test('gh-383 ios: legacy /tmp state parses leniently with protocolVersion 0', () => {
  // Pre-#383 shape: no schemaVersion/protocolVersion. Must be adoptable so the
  // health gate can classify the live runner 'legacy' and reap it (review
  // amendment — deleting it unseen orphans the old runner).
  const legacy = {
    pid: 4242,
    port: 22088,
    deviceId: 'UDID-1',
    bundleId: 'com.example',
    startedAt: 'x',
  };
  const parsed = parseLegacyRunnerState(legacy, () => true);
  assert.equal(parsed.protocolVersion, 0);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.deviceId, 'UDID-1');
  assert.equal(
    parseLegacyRunnerState(legacy, () => false),
    null,
  );
  assert.equal(
    parseLegacyRunnerState({ port: 1 }, () => true),
    null,
  );
});
