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
  const secretName =
    /(?:TOKEN|_API_KEY|APIKEY)$|SECRET|PASSWORD|PASSWD|_CREDENTIALS|_PRIVATE_KEY|^QAREN_INPUT_/i;
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !secretName.test(name)),
  );
  const secretEnv = {
    TYPESAFE_API_KEY: key,
    QAREN_INPUT_FIRST: slot,
    QAREN_INPUT_SECOND: slot,
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
    GITHUB_TOKEN: 'synthetic-forge',
    AWS_SECRET_ACCESS_KEY: 'synthetic-cloud',
    serviceAPIKEY: 'synthetic-service',
    appPASSWORDfile: 'synthetic-password',
    dbPASSWD: 'synthetic-passwd',
    APP_CREDENTIALS_FILE: 'synthetic-credentials',
    SIGN_PRIVATE_KEY_FILE: 'synthetic-private-key',
    qaren_input_lower: 'synthetic-lower-slot',
  };
  const preservedEnv = {
    SSH_AUTH_SOCK: 'synthetic-socket',
    ADB_VENDOR_KEYS: 'synthetic-vendor',
    ANDROID_HOME: 'synthetic-android',
    DEVELOPER_DIR: 'synthetic-developer',
    AUTH: 'synthetic-auth',
    KEY: 'synthetic-key',
    TOKEN_PATH: 'synthetic-token-path',
  };
  const scan = `JSON.stringify({ key: 'TYPESAFE_API_KEY' in process.env, slots: Object.keys(process.env).filter(k => k.startsWith('QAREN_INPUT_')).length, secrets: Object.keys(process.env).filter(k => ${secretName}.test(k)).length, values: Object.values(process.env).some(v => ${JSON.stringify(Object.values(secretEnv))}.includes(v)), kept: !!process.env.PATH && Object.entries(${JSON.stringify(preservedEnv)}).every(([k, v]) => process.env[k] === v) })`;
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
          ...secretEnv,
          ...preservedEnv,
        },
        input: `${JSON.stringify({ v: 1, phase: 'plan-preflight', inputProtocol: 1, plan, appId: 'com.example', platform: 'ios', inputs: {} })}\n`,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, `${mode}: ${result.stderr} ${result.stdout}`);
    const observed = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.deepEqual(observed.before, {
      key: true,
      slots: 2,
      secrets: Object.keys(secretEnv).length,
      values: true,
      kept: true,
    });
    assert.deepEqual(observed.inherited, {
      key: false,
      slots: 0,
      secrets: 0,
      values: false,
      kept: true,
    });
    assert.deepEqual(observed.explicit, {
      key: false,
      slots: 0,
      secrets: 0,
      values: false,
      kept: true,
    });
    assert.equal(observed.authenticated, true);
    assert.equal(observed.redacted, true);
    assert.ok(observed.calls > 0);
    assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
  }
});
