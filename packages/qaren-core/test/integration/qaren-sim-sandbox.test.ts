import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The no-mistakes Test step routes device commands through this sandbox; its self-check runs here so CI exercises it.
test('qaren-sim-sandbox exposes only the fake simulator and no Android device', () => {
  const script = fileURLToPath(
    new URL('../../../../scripts/test/qaren-sim-sandbox.test.sh', import.meta.url),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
