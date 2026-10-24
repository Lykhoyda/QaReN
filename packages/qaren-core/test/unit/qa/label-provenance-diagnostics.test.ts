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
