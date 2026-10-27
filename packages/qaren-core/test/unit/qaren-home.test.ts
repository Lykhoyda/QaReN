import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getStateDir, qarenHome } from '../../dist/util/secure-state-file.js';
import { MAESTRO_RUNNER_PIN, pinCacheRoot } from '../../dist/domain/engine-pin.js';

function withEnv(env: Record<string, string | undefined>, body: () => void): void {
  const prior = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    body();
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('QAREN_HOME moves state and the runner pin cache; XDG_STATE_HOME no longer does', () => {
  withEnv(
    { QAREN_HOME: '/side-home', XDG_STATE_HOME: '/xdg', QAREN_RUNNER_CACHE: undefined },
    () => {
      assert.equal(qarenHome(), '/side-home');
      assert.equal(getStateDir(), '/side-home/state');
      assert.equal(
        pinCacheRoot(),
        join('/side-home/runtime/maestro-runner', MAESTRO_RUNNER_PIN.version),
      );
    },
  );
});

test('an unset QAREN_HOME falls back to ~/.qaren and a relative one is refused', () => {
  for (const value of [undefined, '']) {
    withEnv({ QAREN_HOME: value, XDG_STATE_HOME: '/xdg' }, () => {
      assert.equal(qarenHome(), join(homedir(), '.qaren'));
      assert.equal(getStateDir(), join(homedir(), '.qaren', 'state'));
    });
  }
  withEnv({ QAREN_HOME: 'relative' }, () => {
    assert.throws(() => getStateDir(), /QAREN_HOME is not an absolute path/);
  });
});
