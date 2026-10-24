import { provenanceDiagnosticFromWire } from '../../../dist/qa/label-provenance.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDiagnostic } from '../../../dist/qa/diagnostics.js';
import { createWriter } from '../../../dist/qa/wire.js';

const event = {
  kind: 'label-provenance',
  line: 2,
  requested: true,
  sampleCount: 3,
  nodeIndex: 47,
  differedFields: ['frame', 'parentIndex'],
  deadlineExpired: true,
  outcome: 'deadline',
};
test('candidate refusal diagnostics survive the private wire without inputs and strip arbitrary data', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'diagnostic-test');
  writer.diagnostic({ ...event, value: 'private-canary', label: 'private-label' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).payload, event);
  assert.doesNotMatch(lines[0], /private-canary|private-label/);
});
for (const invalid of [
  { sampleCount: -1 },
  { nodeIndex: 1.2 },
  { differedFields: ['private-canary'] },
  { differedFields: Array(10).fill('frame') },
  { outcome: 'private-canary' },
  { deadlineExpired: 'private-canary' },
  { requested: 'yes' },
]) {
  test(`malformed provenance diagnostic ${Object.keys(invalid)[0]} is withheld`, () => {
    assert.equal(cleanDiagnostic({ ...event, ...invalid }), undefined);
  });
}

test('native provenance diagnostics whitelist field masks and fixed outcomes without changing evidence', () => {
  assert.deepEqual(
    provenanceDiagnosticFromWire({
      sampleCount: 2,
      fieldMask: 8,
      deadlineExpired: false,
      outcome: 'available',
      value: 'private-canary',
    }),
    {
      requested: true,
      sampleCount: 2,
      nodeIndex: null,
      differedFields: ['value'],
      deadlineExpired: false,
      outcome: 'available',
    },
  );
  for (const fieldMask of [-1, 1.2, 16384, 'private-canary'])
    assert.equal(
      provenanceDiagnosticFromWire({
        sampleCount: 2,
        fieldMask,
        deadlineExpired: false,
        outcome: 'available',
      }),
      undefined,
    );
});

test('containment resolution is a value-free private diagnostic with an unavailable provenance outcome', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'containment-test');
  writer.diagnostic({ ...event, resolvedBy: 'containment', value: 'private-canary' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).payload, { ...event, resolvedBy: 'containment' });
  assert.doesNotMatch(lines[0], /private-canary/);
  assert.equal(cleanDiagnostic({ ...event, resolvedBy: 'private-canary' }), undefined);
  assert.equal(
    cleanDiagnostic({ ...event, outcome: 'available', resolvedBy: 'containment' }),
    undefined,
  );
});

for (const outcome of ['deadline', 'source-changed', 'identity-mismatch']) {
  test(`candidate source facts survive diagnostics: ${outcome}`, () => {
    const wire = {
      sampleCount: 2,
      nodeIndex: 0,
      fieldMask: 256,
      deadlineExpired: true,
      outcome,
      directLabelIndices: [0, 1],
    };
    const diagnostic = provenanceDiagnosticFromWire(wire);
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.directLabelIndices, [0, 1]);
    assert.equal(diagnostic.outcome, outcome);
    const lines: string[] = [];
    createWriter((line) => lines.push(line), 'source-facts').diagnostic({
      kind: 'label-provenance',
      line: 1,
      ...diagnostic,
      label: 'private-canary',
    });
    assert.deepEqual(JSON.parse(lines[0]).payload, {
      kind: 'label-provenance',
      line: 1,
      ...diagnostic,
    });
    assert.doesNotMatch(lines[0], /private-canary/);
  });
}
for (const directLabelIndices of [
  [-1],
  [1.5],
  [1, 1],
  Array.from({ length: 65 }, (_, i) => i),
  ['private-canary'],
]) {
  test(`invalid direct-label indices are refused: ${JSON.stringify(directLabelIndices)}`, () => {
    assert.equal(cleanDiagnostic({ ...event, directLabelIndices }), undefined);
    assert.equal(
      provenanceDiagnosticFromWire({ ...event, fieldMask: 0, directLabelIndices }),
      undefined,
    );
  });
}
