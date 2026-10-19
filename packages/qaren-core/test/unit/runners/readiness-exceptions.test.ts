import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _setCapabilitiesForTest,
  getFastRunnerCapabilities,
  probeFastRunnerLivenessDetailed,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';

const STATE = { pid: 12345, port: 22088, deviceId: 'sim-1', bundleId: 'com.example' };
afterEach(() => _setCapabilitiesForTest([]));

test('an injected health exception keeps the existing stale result and clears only cached capabilities', async () => {
  let processes = 0,
    health = 0,
    clears = 0;
  _setCapabilitiesForTest(['PRIVATE-cached']);
  const result = await probeFastRunnerLivenessDetailed({
    getState: () => ({ ...STATE }),
    processAlive: () => {
      processes++;
      return true;
    },
    httpProbe: async () => {
      health++;
      throw { cause: { code: 'ECONNREFUSED', message: 'PRIVATE' } };
    },
    clearState: () => {
      clears++;
    },
  });
  assert.deepEqual(result, {
    liveness: 'stale',
    staleReason: 'health',
    healthDetail: 'refused',
    readinessExceptionStage: 'http-probe',
    readinessExceptionKind: 'connection-refused',
  });
  assert.deepEqual([processes, health, clears], [1, 1, 0]);
  assert.deepEqual(getFastRunnerCapabilities(), []);
});

test('exceptions after health identify their existing operation without weakening any guard', async () => {
  for (const stage of [
    'health-evaluation',
    'authority-evaluation',
    'compatibility-evaluation',
    'state-update',
  ]) {
    const state = { ...STATE };
    const reply = {
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      commands: [...REQUIRED_IOS_COMMANDS],
      capabilities: [...REQUIRED_IOS_FEATURES],
    };
    if (stage === 'health-evaluation')
      Object.defineProperty(reply, 'ok', {
        get: () => {
          throw Error('PRIVATE');
        },
      });
    if (stage === 'authority-evaluation')
      Object.defineProperty(state, 'sessionId', {
        get: () => {
          throw Error('PRIVATE');
        },
      });
    if (stage === 'compatibility-evaluation')
      Object.defineProperty(reply, 'commands', {
        value: {
          [Symbol.iterator]() {
            throw Error('PRIVATE');
          },
        },
      });
    if (stage === 'state-update')
      Object.defineProperty(state, 'protocolVersion', { value: 1, writable: false });
    let health = 0,
      clears = 0;
    _setCapabilitiesForTest(['PRIVATE-cached']);
    const result = await probeFastRunnerLivenessDetailed({
      getState: () => state,
      processAlive: () => true,
      httpProbe: async () => {
        health++;
        return reply;
      },
      clearState: () => {
        clears++;
      },
      pluginVersion: null,
    });
    assert.deepEqual(result, {
      liveness: 'stale',
      staleReason: 'health',
      healthDetail: 'other',
      readinessExceptionStage: stage,
      readinessExceptionKind: 'other',
    });
    assert.deepEqual([health, clears], [1, 0]);
    assert.deepEqual(getFastRunnerCapabilities(), []);
  }
});
