import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy, MASK } from '../../../dist/qa/privacy.js';
import { collectInputNames, parsePlan, preparePlan } from '../../../dist/qa/plan.js';
import { requiredInputs, parseInputPreflight } from '../../../dist/qa/input-preflight.js';
import { readPrivateLine, parsePrivateRequest } from '../../../dist/qa/wire.js';
import { serializeBlock, readBlock, storedFits } from '../../../dist/qa/blocks.js';
import { scriptedJudge } from './judgment-fixtures.ts';

const source = '# Login\n1. Fill "password-field" with input PASSWORD\n';

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
      `1. Fill "outside" with input OUTSIDE\n## QA\n### ${'a'.repeat(200)}\n<!--\n1. Fill "hidden" with input HIDDEN\n-->\n1. Fill "password-field" with input PASSWORD\n2. Fill "name-field" with input USERNAME\n## Other\n1. Fill "outside" with input OTHER`,
    );
    assert.deepEqual(result.names, ['PASSWORD', 'USERNAME']);
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
    { PASSWORD: '' },
    { PASSWORD: 42 },
    { PASSWORD: 'okay', EXTRA: 'no' },
    { PASSWORD: { text: 'nested' } },
    { PASSWORD: 'x'.repeat(4097) },
    { PASSWORD: '\n' },
    { PASSWORD: '\t' },
    { PASSWORD: '\u007f' },
    { PASSWORD: '\ud800' },
    { PASSWORD: 'op://vault/item' },
    { PASSWORD: 'arn:resource' },
    { PASSWORD: '${REF}' },
    { PASSWORD: '$(command)' },
    { PASSWORD: '{{value}}' },
  ]) {
    assert.throws(() => new RunInputs(value, ['PASSWORD']), /^Error: runtime inputs are invalid$/);
  }
  const privateValue = 'quoted"slash\\sentinel';
  const inputs = new RunInputs({ PASSWORD: privateValue }, ['PASSWORD']);
  assert.deepEqual(Object.keys(inputs), []);
  assert.deepEqual(Object.values(inputs), []);
  assert.equal(inspect(inputs), '[runtime inputs]');
  assert.throws(() => JSON.stringify(inputs), /runtime inputs cannot be serialized/);
  assert.equal(inputs.textFor({ input: 'PASSWORD' }), privateValue);
  assert.equal(
    new RunInputs({ PASSWORD: '   ' }, ['PASSWORD']).textFor({ input: 'PASSWORD' }),
    '   ',
  );
  assert.throws(
    () => inputs.textFor({ input: 'PASSWORD', text: 'literal' }),
    /runtime inputs are invalid/,
  );
  assert.throws(() => inputs.textFor({ input: 'MISSING' }), /runtime inputs are invalid/);
  const many = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`SLOT_${i}`, 'x'.repeat(1025)]),
  );
  assert.throws(() => new RunInputs(many, Object.keys(many)), /runtime inputs are invalid/);
});

test('input provenance masks short, numeric, escaped and normalized echoes before typing', () => {
  for (const value of ['x', '42', 'abcd', 'abcde', 'quote"slash\\tail', 'caf\u00e9-value']) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ PASSWORD: value }, ['PASSWORD'], privacy);
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
  const numbers = new RunInputs({ PASSWORD: '123456' }, ['PASSWORD']);
  assert.equal(numbers.redact('12-34 56'), MASK);
});

test('canonical slot blocks depend only on authored names and retain strict decoding', () => {
  const hashes: string[] = [];
  const outputs: string[] = [];
  for (const value of ['first-private-value', 'second-private-value']) {
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ PASSWORD: value }, ['PASSWORD'], privacy);
    withInputs(inputs, () => {
      const block = parsePlan(source).blocks![0];
      hashes.push(preparePlan(source, [block]).hash);
      const saved = serializeBlock(
        block,
        [{ block: block.slug, line: 2, outcome: 'pass', selector: { id: 'password-field' } }],
        { appId: 'com.test', platform: 'ios' },
        privacy.privateSet(),
      );
      assert.ok('yaml' in saved);
      outputs.push(saved.yaml);
      const stored = readBlock(saved.yaml);
      assert.ok(!('invalid' in stored));
      assert.equal(stored.steps[0].input, 'PASSWORD');
      assert.equal(
        storedFits(block, stored, saved.yaml, { appId: 'com.test', platform: 'ios' }),
        true,
      );
      assert.deepEqual(requiredInputs('1. Tap "ready"', { slug: 'login', content: saved.yaml }), [
        'PASSWORD',
      ]);
      for (const replacement of [
        '{ input: "password" }',
        '{ input: "PASSWORD", text: "extra" }',
        '{ input: [PASSWORD] }',
        '{ input: "OTHER" }',
      ]) {
        assert.ok('invalid' in readBlock(saved.yaml.replace('{ input: "PASSWORD" }', replacement)));
      }
      assert.ok(!saved.yaml.includes(value));
    });
  }
  assert.equal(hashes[0], hashes[1]);
  assert.equal(outputs[0], outputs[1]);
  assert.notEqual(
    preparePlan(
      source.replaceAll('PASSWORD', 'USERNAME'),
      parsePlan(source.replaceAll('PASSWORD', 'USERNAME')).blocks!,
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
  assert.deepEqual(inventory, { ok: true, inputProtocol: 1, requiredInputs: ['PASSWORD'] });
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
    () => parsePrivateRequest('{"v":1,"payload":{"inputs":{"PASSWORD":"private-value"}}}'),
    (error: Error) => !error.message.includes('private-value'),
  );
});
