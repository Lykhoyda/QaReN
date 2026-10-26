// Story 06 Phase B (#387): the rn-fast-runner warm-launch ready gate is
// overridable via RN_FAST_RUNNER_READY_TIMEOUT_MS so a slow CI simulator (where
// install+launch+attach of the XCUITest runner can exceed 30s) can widen it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReadyTimeoutMs } from '../../dist/runners/rn-fast-runner-client.js';

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS;
  if (value === undefined) delete process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS;
  else process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS;
    else process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS = prev;
  }
}

test('ready timeout defaults to 30s when the env var is unset', () => {
  withEnv(undefined, () => assert.equal(resolveReadyTimeoutMs(), 30_000));
});

test('ready timeout honors a positive override', () => {
  withEnv('120000', () => assert.equal(resolveReadyTimeoutMs(), 120_000));
});

test('ready timeout ignores non-numeric / non-positive values (falls back to 30s)', () => {
  withEnv('nonsense', () => assert.equal(resolveReadyTimeoutMs(), 30_000));
  withEnv('0', () => assert.equal(resolveReadyTimeoutMs(), 30_000));
  withEnv('-5', () => assert.equal(resolveReadyTimeoutMs(), 30_000));
});
