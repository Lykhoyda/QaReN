import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELPERS_VERSION } from '../../dist/injected-helpers.js';

test('#321: HELPERS_VERSION >= 26 baseline (value-agnostic; feature branches bump freely)', () => {
  assert.ok(HELPERS_VERSION >= 26, 'HELPERS_VERSION must not regress below the #321 baseline (26)');
});
