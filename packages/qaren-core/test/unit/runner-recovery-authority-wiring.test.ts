import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reacquireIosTargetApp } from '../../dist/handlers/device-session.js';

const source = readFileSync(
  new URL('../../src/handlers/device-session.ts', import.meta.url),
  'utf8',
);

test('runner leak recovery unbinds stale authority and reuses production dependencies', () => {
  assert.match(
    source,
    /await deps\.unbindRunner\?\.\(\);[\s\S]*reopenSessionForRecovery\(appId, platform, attachOnly, deviceId, deps\)/,
  );
  assert.match(
    source,
    /return createDeviceSnapshotHandler\(dependencies\)\(\{[\s\S]*sessionName: recoveryName/,
  );
});

test('preferred runner reacquire rotates durable authority around the process restart', async () => {
  const calls: string[] = [];
  const result = await reacquireIosTargetApp('dev.example', 'SIM-1', {
    stopFastRunner: async () => {
      calls.push('stop');
    },
    unbindRunner: async () => {
      calls.push('unbind');
    },
    launchApp: async () => {
      calls.push('launch');
    },
    ensureFastRunner: async () => {
      calls.push('start');
    },
    bindRunner: async () => {
      calls.push('bind');
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['stop', 'unbind', 'launch', 'start', 'bind']);
});

test('preferred runner reacquire does not discard authority after an unproven stop', async () => {
  const calls: string[] = [];
  const result = await reacquireIosTargetApp('dev.example', 'SIM-1', {
    stopFastRunner: async () => {
      calls.push('stop');
      throw new Error('runner stop unproven');
    },
    unbindRunner: async () => {
      calls.push('unbind');
    },
    launchApp: async () => {
      calls.push('launch');
    },
    ensureFastRunner: async () => {
      calls.push('start');
    },
    bindRunner: async () => {
      calls.push('bind');
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /runner stop unproven/);
  assert.deepEqual(calls, ['stop']);
});
