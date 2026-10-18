import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const walk = fileURLToPath(new URL('../../../dist/qa/walk.js', import.meta.url));
const redaction = new URL('../../../dist/util/redact.js', import.meta.url).href;

test('startup keeps model authentication and redaction while scrubbing tool children', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-startup-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = '1. Visit profile';
  const planFile = join(dir, 'plan.md');
  writeFileSync(planFile, plan);
  const key = 'synthetic"model\\credential';
  const slot = 'synthetic-slot-value';
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('QAREN_INPUT_')),
  );
  const scan = `JSON.stringify({ key: 'TYPESAFE_API_KEY' in process.env, slots: Object.keys(process.env).filter(k => k.startsWith('QAREN_INPUT_')).length, values: Object.values(process.env).some(v => ${JSON.stringify([key, slot])}.includes(v)) })`;
  for (const mode of ['--preflight', '--parse', '--preflight-stdin']) {
    const receipt = join(dir, `${mode}.json`);
    const preload = `
      import { execFileSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { redactApiKey } from ${JSON.stringify(redaction)};
      const key = process.env.TYPESAFE_API_KEY;
      const scan = (env) => JSON.parse(execFileSync(process.execPath, ['-e', ${JSON.stringify(`process.stdout.write(${scan})`)}], { env, encoding: 'utf8' }));
      const before = scan(process.env);
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        const inherited = scan(undefined);
        const explicit = scan({ ...process.env });
        const authenticated = init.headers.Authorization === 'Bearer ' + key;
        const redacted = !redactApiKey(key).includes(key) && !redactApiKey(JSON.stringify({ key })).includes('synthetic');
        writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ before, inherited, explicit, authenticated, redacted, calls }));
        const { questions, model } = JSON.parse(init.body);
        const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0.99 } : { type: 'choice', choice: 'press', confidence: 0.99, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'press' ? 1 : 0])) }]));
        return Response.json({ model, answers, usage: { input_tokens: 1 } });
      };
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, walk, mode, planFile],
      {
        env: {
          ...inheritedEnv,
          TYPESAFE_API_KEY: key,
          QAREN_INPUT_FIRST: slot,
          QAREN_INPUT_SECOND: slot,
        },
        input: `${JSON.stringify({ v: 1, phase: 'plan-preflight', inputProtocol: 1, plan, appId: 'com.example', platform: 'ios', inputs: {} })}\n`,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, `${mode}: ${result.stderr} ${result.stdout}`);
    const observed = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.deepEqual(observed.before, { key: true, slots: 2, values: true });
    assert.deepEqual(observed.inherited, { key: false, slots: 0, values: false });
    assert.deepEqual(observed.explicit, { key: false, slots: 0, values: false });
    assert.equal(observed.authenticated, true);
    assert.equal(observed.redacted, true);
    assert.ok(observed.calls > 0);
    assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
  }
});
