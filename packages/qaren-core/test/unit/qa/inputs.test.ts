import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy, MASK } from '../../../dist/qa/privacy.js';
import {
  collectInputNames,
  parsePlan,
  preparePlan,
  readPreparedPlan,
} from '../../../dist/qa/plan.js';
import { requiredInputs, parseInputPreflight } from '../../../dist/qa/input-preflight.js';
import { readPrivateLine, parsePrivateRequest } from '../../../dist/qa/wire.js';
import { InputPrivacyRefusal } from '../../../dist/qa/inputs.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializeBlock, readBlock, storedFits } from '../../../dist/qa/blocks.js';
import { scriptedJudge } from './judgment-fixtures.ts';

const source = '# Login\n1. Fill "slot-field" with input SLOT_A\n';

test('inventory honors active QA/comments and does not hash even overflowing headings', (t) => {
  const original = crypto.createHash;
  let hashes = 0;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    hashes++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = collectInputNames(
      `1. Fill "outside" with input OUTSIDE\n## QA\n### ${'a'.repeat(200)}\n<!--\n1. Fill "hidden" with input HIDDEN\n-->\n1. Fill "slot-field" with input SLOT_A (non-secret)\n2. Fill "name-field" with input USERNAME\n## Other\n1. Fill "outside" with input OTHER`,
    );
    assert.deepEqual(result.names, ['SLOT_A', 'USERNAME']);
    assert.deepEqual(result.refused, []);
    assert.equal(hashes, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('private context validates its exact bounded set without exposing values', () => {
  for (const value of [
    null,
    [],
    {},
    { SLOT_A: '' },
    { SLOT_A: 42 },
    { SLOT_A: 'okay', EXTRA: 'no' },
    { SLOT_A: { text: 'nested' } },
    { SLOT_A: 'x'.repeat(4097) },
    { SLOT_A: '\n' },
    { SLOT_A: '\t' },
    { SLOT_A: '\u007f' },
    { SLOT_A: '\ud800' },
    { SLOT_A: 'op://vault/item' },
    { SLOT_A: 'arn:resource' },
    { SLOT_A: '${REF}' },
    { SLOT_A: '$(command)' },
    { SLOT_A: '{{value}}' },
    { SLOT_A: 'z' },
    { SLOT_A: '42' },
    { SLOT_A: '   ' },
    { SLOT_A: ' ab ' },
  ]) {
    assert.throws(() => new RunInputs(value, ['SLOT_A']), /^Error: runtime inputs are invalid$/);
  }
  const privateValue = 'quoted"slash\\sentinel';
  const inputs = new RunInputs({ SLOT_A: privateValue }, ['SLOT_A']);
  assert.deepEqual(Object.keys(inputs), []);
  assert.deepEqual(Object.values(inputs), []);
  assert.equal(inspect(inputs), '[runtime inputs]');
  assert.throws(() => JSON.stringify(inputs), /runtime inputs cannot be serialized/);
  assert.equal(inputs.textFor({ input: 'SLOT_A' }), privateValue);
  assert.throws(
    () => inputs.textFor({ input: 'SLOT_A', text: 'literal' }),
    /runtime inputs are invalid/,
  );
  assert.throws(() => inputs.textFor({ input: 'MISSING' }), /runtime inputs are invalid/);
  const many = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`SLOT_${i}`, 'x'.repeat(1025)]),
  );
  assert.throws(() => new RunInputs(many, Object.keys(many)), /runtime inputs are invalid/);
});

test('input provenance masks short, numeric, escaped and normalized echoes before typing', () => {
  for (const value of ['abc', '420', 'abcd', 'abcde', 'quote"slash\\tail', 'caf\u00e9-value']) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ SLOT_A: value }, ['SLOT_A'], privacy);
    assert.equal(privacy.canScreenshot(), false);
    for (const echo of [
      value,
      value.normalize('NFC'),
      value.normalize('NFD'),
      JSON.stringify(value).slice(1, -1),
    ]) {
      assert.ok(inputs.redact(`prefix${echo}suffix`).includes(MASK));
      assert.ok(!inputs.redact(`prefix${echo}suffix`).includes(echo));
    }
  }
  const numbers = new RunInputs({ SLOT_A: '123456' }, ['SLOT_A']);
  assert.equal(numbers.redact('12-34 56'), MASK);
});

test('canonical slot blocks depend only on authored names and retain strict decoding', () => {
  const hashes: string[] = [];
  const outputs: string[] = [];
  for (const value of ['first-private-value', 'second-private-value']) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ SLOT_A: value }, ['SLOT_A'], privacy);
    withInputs(inputs, () => {
      const block = parsePlan(source).blocks![0];
      hashes.push(preparePlan(source, [block]).hash);
      const saved = serializeBlock(
        block,
        [{ block: block.slug, line: 2, outcome: 'pass', selector: { id: 'slot-field' } }],
        { appId: 'com.test', platform: 'ios' },
        privacy.privateSet(),
      );
      assert.ok('yaml' in saved);
      outputs.push(saved.yaml);
      const stored = readBlock(saved.yaml);
      assert.ok(!('invalid' in stored));
      assert.equal(stored.steps[0].input, 'SLOT_A');
      assert.equal(
        storedFits(block, stored, saved.yaml, { appId: 'com.test', platform: 'ios' }),
        true,
      );
      assert.deepEqual(requiredInputs('1. Tap "ready"', { slug: 'login', content: saved.yaml }), [
        'SLOT_A',
      ]);
      for (const replacement of [
        '{ input: "slot_a" }',
        '{ input: "SLOT_A", text: "extra" }',
        '{ input: [SLOT_A] }',
        '{ input: "OTHER" }',
      ]) {
        assert.ok('invalid' in readBlock(saved.yaml.replace('{ input: "SLOT_A" }', replacement)));
      }
      assert.ok(!saved.yaml.includes(value));
    });
  }
  assert.equal(hashes[0], hashes[1]);
  assert.equal(outputs[0], outputs[1]);
  assert.notEqual(
    preparePlan(
      source.replaceAll('SLOT_A', 'SLOT_B'),
      parsePlan(source.replaceAll('SLOT_A', 'SLOT_B')).blocks!,
    ).hash,
    hashes[0],
  );
});

test('private inventory never calls a model and admission requires matching inputs', async () => {
  const judge = scriptedJudge([]);
  const inventory = await parseInputPreflight(
    { v: 1, phase: 'input-inventory', plan: source, platform: 'ios', appId: 'com.test' },
    judge,
  );
  assert.deepEqual(inventory, { ok: true, inputProtocol: 1, requiredInputs: ['SLOT_A'] });
  assert.equal(judge.calls.length, 0);
  await assert.rejects(
    parseInputPreflight(
      {
        v: 1,
        phase: 'plan-preflight',
        plan: source,
        platform: 'ios',
        appId: 'com.test',
        inputProtocol: 1,
        inputs: {},
      },
      judge,
    ),
    /runtime inputs are invalid/,
  );
});

test('private stdin rejects an oversized stream before retaining it', async () => {
  await assert.rejects(
    readPrivateLine(Readable.from([Buffer.alloc(16 * 1024 * 1024), 'x'])),
    /private request exceeds limit/,
  );
  assert.throws(
    () => parsePrivateRequest('{"v":1,"payload":{"inputs":{"SLOT_A":"private-value"}}}'),
    (error: Error) => !error.message.includes('private-value'),
  );
});

const email = 'qa-user+tag@example.com';
const loginPlan = (extra = '') =>
  [
    '# Login',
    '1. Wait for "INTRO"',
    '2. Fill "EmailOtpFormContent_email" with input USERNAME',
    '3. Tap "submit_email_form"',
    '4. Wait for "Enter the 4-digit code"',
    '5. Fill "LoginFormContent_token" with input OTP',
    extra,
  ].join('\n');
const preflight = (plan: string) => ({
  v: 1,
  phase: 'plan-preflight',
  plan,
  platform: 'ios',
  appId: 'com.example.app',
  inputProtocol: 1,
  inputs: { OTP: '4821', USERNAME: email },
});

test('whole-value preflight admits ordinary credentials and refuses whole echoes', async () => {
  const admitted = (await parseInputPreflight(preflight(loginPlan()), scriptedJudge([]))) as {
    ok: boolean;
  };
  assert.equal(admitted.ok, true);
  const declared = (await parseInputPreflight(
    preflight(loginPlan('6. Expect input USERNAME on screen')),
    scriptedJudge([]),
  )) as { ok: boolean };
  assert.equal(declared.ok, true);
  for (const echo of [
    `6. Wait for "${email}"`,
    '6. Wait for "4 8 2 1"',
    `6. Expect input USERNAME on screen\n7. Wait for "${email}"`,
  ]) {
    await assert.rejects(
      parseInputPreflight(preflight(loginPlan(echo)), scriptedJudge([])),
      (error) => {
        assert.ok(error instanceof InputPrivacyRefusal);
        assert.equal(error.message, 'runtime input privacy refused');
        assert.ok(!String(error).includes(email) && !String(error).includes('4821'));
        return true;
      },
    );
  }
});

test('persisted decisions match slot values whole while output masking keeps fragments', () => {
  const privacy = new ObservedPrivacy();
  privacy.classifyInputs([email, '4821']);
  privacy.didFill('4821');
  const plan = '# Enter the 4-digit code\n1. Fill "LoginFormContent_token" with input OTP\n';
  const block = parsePlan(plan).blocks![0];
  const rows = [
    {
      block: block.slug,
      line: 2,
      outcome: 'pass',
      selector: { id: 'LoginFormContent_token' },
    },
  ];
  const store = { appId: 'com.example.app', platform: 'ios' };
  const saved = serializeBlock(block, rows, store, privacy.privateSet('persisted'));
  assert.ok('yaml' in saved);
  assert.ok(!saved.yaml.includes(email) && !saved.yaml.includes('4821'));
  const leaked = parsePlan(
    `# Signed in as ${email}\n1. Fill "LoginFormContent_token" with input OTP\n`,
  ).blocks![0];
  assert.ok(
    'unsavable' in
      serializeBlock(
        leaked,
        [{ ...rows[0], block: leaked.slug }],
        store,
        privacy.privateSet('persisted'),
      ),
  );
  assert.ok(privacy.redact('code 48 and 21').includes(MASK));
});

test('the preflight child reports a privacy refusal distinctly from an invalid request', () => {
  const walk = fileURLToPath(new URL('../../../dist/qa/walk.js', import.meta.url));
  const run = (input: string) =>
    spawnSync(process.execPath, [walk, '--preflight-stdin'], { input });
  const refused = run(`${JSON.stringify(preflight(loginPlan(`6. Wait for "${email}"`)))}\n`);
  assert.equal(refused.status, 4);
  assert.equal(JSON.parse(refused.stdout.toString()).message, 'runtime input privacy refused');
  assert.ok(!refused.stdout.toString().includes(email));
  const malformed = run('{"v":1}\n');
  assert.equal(malformed.status, 4);
  assert.equal(JSON.parse(malformed.stdout.toString()).message, 'runtime input preflight refused');
});

test('a filled field slot block stays name-only and value-independent', () => {
  const plan =
    '# Login\n1. Fill "login_email" with input QA_EMAIL\n2. Expect input QA_EMAIL on screen\n';
  const outputs = ['qa-synth-1234@example.test', 'other-user@example.test'].map((value) => {
    const privacy = new ObservedPrivacy();
    privacy.classifyInputs([value]);
    privacy.didFill(value);
    const block = parsePlan(plan).blocks![0];
    const saved = serializeBlock(
      block,
      [{ block: block.slug, line: 2, outcome: 'pass', selector: { id: 'login_email' } }],
      { appId: 'com.test', platform: 'ios' },
      privacy.privateSet('persisted'),
    );
    assert.ok('yaml' in saved);
    assert.ok(!saved.yaml.includes(value));
    const stored = readBlock(saved.yaml);
    assert.ok(!('invalid' in stored));
    assert.equal(stored.steps[0].input, 'QA_EMAIL');
    assert.deepEqual([stored.steps[1].kind, stored.steps[1].input], ['echo', 'QA_EMAIL']);
    return [saved.yaml, preparePlan(plan, [block]).hash];
  });
  assert.deepEqual(outputs[0], outputs[1]);
});

test('non-secret fixture passes grammar, private admission, hashing and symbolic persistence', async () => {
  const plan = source.replace('SLOT_A', 'SLOT_A (non-secret)');
  const parsed = parsePlan(plan);
  assert.ok(parsed.blocks, 'annotated Fill must parse without a model');
  const judge = scriptedJudge([]);
  assert.deepEqual(
    await parseInputPreflight(
      { v: 1, phase: 'input-inventory', plan, platform: 'ios', appId: 'com.test' },
      judge,
    ),
    {
      ok: true,
      inputProtocol: 1,
      requiredInputs: ['SLOT_A'],
      nonSecretInputs: ['SLOT_A'],
    },
  );
  const result = await parseInputPreflight(
    {
      v: 1,
      phase: 'plan-preflight',
      plan,
      platform: 'ios',
      appId: 'com.test',
      inputProtocol: 1,
      inputs: { SLOT_A: 'fixture-canary' },
    },
    judge,
  );
  assert.equal(result.ok, true);
  const { inputs, privacy } = parsePrivateRequest(
    JSON.stringify({
      v: 1,
      runId: 'check-1',
      seq: 1,
      type: 'request',
      payload: {
        runId: 'check-1',
        t0: 1770000000000,
        walkBudgetMs: 300000,
        attachBudgetMs: 120_000,
        plan,
        platform: 'ios',
        appId: 'com.test',
        appRoot: '/tmp/app',
        runDir: '/tmp/runs/check-1',
        lease: 'check-1:0123456789abcdef0123456789abcdef',
        inputProtocol: 1,
        inputs: { SLOT_A: 'fixture-canary' },
        target: {
          deviceId: 'UDID',
          deviceName: 'iPhone',
          metroPort: 8791,
          metroUrlForDevice: 'http://127.0.0.1:8791',
          worktree: '/tmp/app',
        },
      },
    }),
  );
  withInputs(inputs, () => {
    inputs.assertHashSafe('fixture-canary');
    const block = parsePlan(plan).blocks![0];
    const saved = serializeBlock(
      block,
      [{ block: block.slug, line: 2, outcome: 'pass', selector: { id: 'slot-field' } }],
      { appId: 'com.test', platform: 'ios' },
      privacy.privateSet(),
    );
    assert.ok('yaml' in saved);
    assert.ok(saved.yaml.includes('sensitivity: "non-secret"'));
    assert.ok(!saved.yaml.includes('fixture-canary'));
    const stored = readBlock(saved.yaml);
    assert.ok(!('invalid' in stored));
    assert.equal(stored.steps[0].sensitivity, 'non-secret');
    assert.ok(storedFits(block, stored, saved.yaml, { appId: 'com.test', platform: 'ios' }));
  });
  assert.equal(privacy.canScreenshot(), false);
  assert.ok(!inputs.redact('fixture-canary').includes('fixture-canary'));
  assert.equal(judge.calls.length, 0);
});

test('input policy inventory refuses conflicts and malformed annotations without a model', async () => {
  const judge = scriptedJudge([]);
  for (const plan of [
    `${source}\n### Later\n1. Fill "again" with input SLOT_A (non-secret)`,
    source.replace('SLOT_A', 'SLOT_A (secret)'),
    source.replace('SLOT_A', 'SLOT_A (nonsecret)'),
    source.replace('SLOT_A', 'SLOT_A (non-secret) trailing'),
    '1. Fill "field" with "literal" (non-secret)',
    `${source}\n2. Expect input SLOT_A on screen (non-secret)`,
    '1. Please fill "field" with input SLOT_A (non-secret)',
  ]) {
    assert.ok(parsePlan(plan).refused, plan);
    await assert.rejects(
      parseInputPreflight(
        { v: 1, phase: 'input-inventory', plan, platform: 'ios', appId: 'com.test' },
        judge,
      ),
      /runtime input inventory refused/,
    );
  }
  const valid = `outside\n## QA\n<!-- 1. Fill "hidden" with input SLOT_A -->\n${source}\n2. Fill "again" with input SLOT_A\n## Other\n1. Fill "outside" with input SLOT_A (non-secret)`;
  assert.deepEqual(requiredInputs(valid), ['SLOT_A']);
  assert.equal(judge.calls.length, 0);
});

test('login policy binds the whole run and symbolic replay rebinds current values', async () => {
  const annotated = source.replace('SLOT_A', 'SLOT_A (non-secret)');
  const build = (plan: string, nonSecret: string[]) => {
    const inputs = new RunInputs(
      { SLOT_A: 'first-fixture' },
      ['SLOT_A'],
      new ObservedPrivacy(),
      nonSecret,
    );
    return withInputs(inputs, () => {
      const block = parsePlan(plan).blocks![0];
      const saved = serializeBlock(
        block,
        [{ block: block.slug, line: 2, outcome: 'pass', selector: { id: 'slot-field' } }],
        { appId: 'com.test', platform: 'ios' },
      );
      assert.ok('yaml' in saved);
      return saved.yaml;
    });
  };
  const yaml = build(annotated, ['SLOT_A']);
  assert.match(yaml, /# planHash: ns1:[a-f0-9]{64}/);
  const current = new RunInputs({ SLOT_A: 'second-fixture' }, ['SLOT_A'], new ObservedPrivacy(), [
    'SLOT_A',
  ]);
  const stored = readBlock(yaml);
  assert.ok(!('invalid' in stored));
  assert.equal(current.textFor(stored.steps[0]), 'second-fixture');
  const request = (
    content: string,
    plan = '1. Tap "ready"',
    values = { SLOT_A: 'second-fixture' },
  ) => ({
    v: 1,
    phase: 'plan-preflight',
    plan,
    appId: 'com.test',
    platform: 'ios',
    inputProtocol: 1,
    inputs: values,
    loginSnapshot: { slug: 'login', content },
  });
  assert.equal((await parseInputPreflight(request(yaml), scriptedJudge([]))).ok, true);
  await assert.rejects(
    parseInputPreflight(request(yaml, source), scriptedJudge([])),
    /inventory refused/,
  );
  for (const stale of [
    yaml.replace(/ns1:[a-f0-9]{64}/, 'ns1:' + '0'.repeat(64)),
    yaml.replace('ns1:', 'ns2:'),
  ])
    await assert.rejects(
      parseInputPreflight(request(stale), scriptedJudge([])),
      /saved login input policy refused/,
    );
  assert.throws(
    () =>
      parsePrivateRequest(
        runtimeLine(
          '1. Tap "ready"',
          { SLOT_A: 'second-fixture' },
          {
            loginBlock: 'login',
            loginMarker: { id: 'login-screen' },
            loginSnapshot: { slug: 'login', content: yaml.replace('ns1:', 'ns2:') },
          },
        ),
      ),
    /saved login input policy refused/,
  );
  const strict = build(source, []);
  assert.equal((await parseInputPreflight(request(strict), scriptedJudge([]))).ok, true);
  await assert.rejects(
    parseInputPreflight(
      request(strict, '1. Fill "other" with input FIXTURE (non-secret)', {
        SLOT_A: 'second-fixture',
        FIXTURE: 'other-fixture',
      }),
      scriptedJudge([]),
    ),
    /saved login input policy refused/,
  );
  const strictVersioned = strict.replace(
    /# planHash: [a-f0-9]{64}/,
    '# planHash: ns1:' + '0'.repeat(64),
  );
  await assert.rejects(
    parseInputPreflight(request(strictVersioned), scriptedJudge([])),
    /saved login input policy refused/,
  );
  for (const placeholder of [
    '{ input: "SLOT_A" }',
    '{ input: "SLOT_A", sensitivity: "secret" }',
    '{ input: "SLOT_A", sensitivity: "non-secret", extra: true }',
    '{ input: "SLOT_A", sensitivity: "non-secret", text: "literal" }',
    '"literal"',
  ])
    assert.ok(
      'invalid' in
        readBlock(yaml.replace('{ input: "SLOT_A", sensitivity: "non-secret" }', placeholder)),
    );
  assert.ok(
    'invalid' in readBlock(yaml.replace('with input SLOT_A (non-secret)', 'with input SLOT_A')),
  );
});

test('prepared plan binds sensitivity and action identity includes every block policy', () => {
  const first = '### First\n1. Tap "ready"\n';
  const strict = `${first}### Second\n1. Fill "field" with input FIXTURE`;
  const annotated = strict + ' (non-secret)';
  const legacy = parsePlan(strict).blocks!;
  const policy = parsePlan(annotated).blocks!;
  assert.equal(
    legacy[0].planHash,
    crypto.createHash('sha256').update('1. Tap "ready"').digest('hex'),
  );
  assert.notEqual(policy[0].planHash, legacy[0].planHash);
  assert.match(policy[0].planHash, /^ns1:/);
  const prepared = preparePlan(annotated, policy);
  assert.deepEqual(readPreparedPlan(annotated, prepared), policy);
  for (const change of [undefined, 'secret', 'unknown']) {
    const changed = structuredClone(prepared);
    if (change === undefined) delete changed.blocks[1].items[0].sensitivity;
    else changed.blocks[1].items[0].sensitivity = change;
    assert.equal(readPreparedPlan(annotated, changed), undefined);
  }
  const forged = preparePlan(strict, legacy);
  forged.blocks[1].items[0].sensitivity = 'non-secret';
  assert.equal(readPreparedPlan(strict, forged), undefined);
});

test('non-secret fixtures stay model-masked and cannot be saved through value selectors', async () => {
  for (const value of ['fixture-canary', 'left"right', 'caf\u00e9-value', '123456']) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ FIXTURE: value }, ['FIXTURE'], privacy, ['FIXTURE']);
    for (const form of [value, value.normalize('NFD'), JSON.stringify(value).slice(1, -1)]) {
      assert.ok(!privacy.redact(form).includes(form));
      const masked = privacy.maskForModel(privacy.modelValues(), [form]);
      assert.ok(!masked.apply(form).includes(form));
    }
    assert.equal(inputs.hasInputs, true);
    assert.equal(privacy.canScreenshot(), false);
    withInputs(inputs, () => {
      const block = parsePlan('1. Fill "field" with input FIXTURE (non-secret)').blocks![0];
      assert.ok(
        'unsavable' in
          serializeBlock(
            block,
            [{ block: block.slug, line: 1, outcome: 'pass', selector: { text: value } }],
            { appId: 'com.test', platform: 'ios' },
            privacy.privateSet(),
          ),
      );
    });
  }
});

function runtimeLine(plan: string, values: Record<string, string>, extra = {}) {
  return JSON.stringify({
    v: 1,
    runId: 'check-1',
    seq: 1,
    type: 'request',
    payload: {
      runId: 'check-1',
      t0: 1770000000000,
      walkBudgetMs: 300000,
      attachBudgetMs: 120_000,
      plan,
      platform: 'ios',
      appId: 'com.test',
      appRoot: '/tmp/app',
      runDir: '/tmp/runs/check-1',
      lease: 'check-1:0123456789abcdef0123456789abcdef',
      inputProtocol: 1,
      inputs: values,
      target: {
        deviceId: 'UDID',
        deviceName: 'iPhone',
        metroPort: 8791,
        metroUrlForDevice: 'http://127.0.0.1:8791',
        worktree: '/tmp/app',
      },
      ...extra,
    },
  });
}

test('private wire derives policy from source rather than arbitrary policy or prepared fields', () => {
  const prepared = preparePlan(source, parsePlan(source).blocks!);
  prepared.blocks[0].items[0].sensitivity = 'non-secret';
  const { inputs } = parsePrivateRequest(
    runtimeLine(source, { SLOT_A: 'fixture-canary' }, { nonSecretInputs: ['SLOT_A'], prepared }),
  );
  assert.deepEqual(inputs.nonSecretNames(), []);
  assert.throws(() => inputs.assertHashSafe('fixture-canary'), InputPrivacyRefusal);
  assert.throws(
    () => new RunInputs({ SLOT_A: 'fixture-canary' }, ['SLOT_A'], undefined, ['OTHER']),
    /runtime inputs are invalid/,
  );
  for (const values of [
    {},
    { SLOT_A: 'fixture-canary', OTHER: 'extra-value' },
    { SLOT_A: 'op://vault' },
  ])
    assert.throws(
      () =>
        parsePrivateRequest(runtimeLine(source.replace('SLOT_A', 'SLOT_A (non-secret)'), values)),
      /runtime inputs are invalid/,
    );
});
