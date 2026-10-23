import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseInputPreflight } from '../../../dist/qa/input-preflight.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';

const cases = JSON.parse(
  readFileSync(new URL('../../fixtures/plan-errors.json', import.meta.url), 'utf8'),
);

for (const entry of cases) {
  test(`plan diagnostic: ${entry.name}`, async () => {
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          id === 'preflight' ? { type: 'noul', noul: 0.99 } : choice(q, entry.choice),
        ]),
      ),
    );
    const result = await parseInputPreflight(
      {
        v: 1,
        phase: entry.phase ?? 'input-inventory',
        plan: entry.plan,
        platform: 'ios',
        appId: 'com.test',
        inputProtocol: 1,
        inputs: {},
      },
      judge,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PLAN_UNPARSEABLE');
    assert.ok(
      result.refused.some(
        (r) =>
          r.line === entry.line &&
          r.reason.startsWith(entry.reason) &&
          r.nextAction === entry.nextAction,
      ),
      JSON.stringify(result),
    );
    if (!entry.choice) assert.equal(judge.calls.length, 0);
  });
}

test('private stdin returns safe plan diagnostics without literal values or source text', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('../../../dist/qa/walk.js', import.meta.url).pathname, '--preflight-stdin'],
    {
      input:
        JSON.stringify({
          v: 1,
          phase: 'input-inventory',
          platform: 'ios',
          appId: 'com.test',
          plan: '### private-heading-canary\n1. Type "private-value-canary" into "field"\n### private-heading-canary\n1. Type private-unquoted-canary',
        }) + '\n',
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 4, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.code, 'PLAN_UNPARSEABLE');
  assert.equal(value.refused[0].line, 3);
  assert.equal(value.refused[1].line, 4);
  assert.ok(value.refused.every((r) => r.nextAction && !('text' in r)));
  assert.ok(!result.stdout.includes('canary'));
});
