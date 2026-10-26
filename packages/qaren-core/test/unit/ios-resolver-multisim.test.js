import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSimctlBootedAll, resolveIosUdid } from '../../dist/handlers/device-screenshot-raw.js';

const json = (arr) =>
  JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': arr } });

test('parseSimctlBootedAll: returns ALL booted udids, skips shutdown + partial entries', () => {
  const out = parseSimctlBootedAll(
    json([
      { udid: 'A', name: 'iPhone 15', state: 'Booted' },
      { udid: 'B', name: 'iPad', state: 'Shutdown' },
      { name: 'NoUdid', state: 'Booted' },
      { udid: 'C', name: 'iPhone 17', state: 'Booted' },
    ]),
  );
  assert.deepEqual(out, ['A', 'C']);
});
test('parseSimctlBootedAll: bad JSON → []', () => {
  assert.deepEqual(parseSimctlBootedAll('not json'), []);
});

test('resolveIosUdid: explicit wins', async () => {
  assert.equal(
    await resolveIosUdid('EXPLICIT', () =>
      Promise.resolve(json([{ udid: 'A', name: 'x', state: 'Booted' }])),
    ),
    'EXPLICIT',
  );
});
test('resolveIosUdid: single booted → that udid', async () => {
  assert.equal(
    await resolveIosUdid(undefined, () =>
      Promise.resolve(json([{ udid: 'A', name: 'x', state: 'Booted' }])),
    ),
    'A',
  );
});
test('resolveIosUdid: zero booted → undefined', async () => {
  assert.equal(await resolveIosUdid(undefined, () => Promise.resolve(json([]))), undefined);
});
test('resolveIosUdid: multiple booted → undefined (ambiguous, fail-open)', async () => {
  assert.equal(
    await resolveIosUdid(undefined, () =>
      Promise.resolve(
        json([
          { udid: 'A', name: 'x', state: 'Booted' },
          { udid: 'B', name: 'y', state: 'Booted' },
        ]),
      ),
    ),
    undefined,
  );
});
test('resolveIosUdid: probe throws → undefined', async () => {
  assert.equal(
    await resolveIosUdid(undefined, () => Promise.reject(new Error('no xcrun'))),
    undefined,
  );
});
