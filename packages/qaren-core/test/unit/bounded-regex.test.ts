import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterWithBoundedRegex } from '../../dist/domain/bounded-regex.js';

test('bounded regex filtering preserves ordinary regex matching', async () => {
  const result = await filterWithBoundedRegex(
    ['login.yaml', 'checkout.yml', 'profile.yaml'],
    'login|checkout',
    1_000,
  );

  assert.deepEqual(result, { ok: true, matches: ['login.yaml', 'checkout.yml'] });
});

test('bounded regex filtering terminates catastrophic patterns', async () => {
  const startedAt = Date.now();
  const result = await filterWithBoundedRegex([`${'a'.repeat(240)}.yaml`], '(a+)+$', 100);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reason, 'timeout');
  assert.ok(Date.now() - startedAt < 2_000);
});
