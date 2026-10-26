import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const syntheticAction = resolve(import.meta.dirname, '../fixtures/proof-actions/canonical.yaml');

test('qaren does not embed a React Native proof application', () => {
  assert.equal(existsSync(resolve(repositoryRoot, 'apps', 'proof-fixture')), false);
});

test('portable proof tests use a synthetic action contract', () => {
  const action = readFileSync(syntheticAction, 'utf8');
  assert.match(action, /^appId: com\.example\.proof$/m);
  assert.match(action, /^# id: canonical-proof$/m);
  assert.match(action, /id: proof-start/);
  assert.match(action, /id: proof-result/);
});
