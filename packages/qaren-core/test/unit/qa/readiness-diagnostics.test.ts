import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDiagnostic } from '../../../dist/qa/diagnostics.js';
import { cleanTimingEvent, createTimingObserver } from '../../../dist/qa/timing.js';

const reasons = [
  'alive',
  'dead',
  'health',
  'authority-mismatch',
  'legacy',
  'protocol-older',
  'protocol-newer',
  'version-skew',
  'missing-commands',
  'missing-features',
  'unknown',
] as const;
const metric = {
  kind: 'metric',
  stage: 'native-readiness',
  edge: 'end',
  outcome: 'failed',
  at: 200,
  line: 3,
  observation: 7,
  count: 2,
} as const;

test('readiness reasons survive both timing and wire cleaners with their existing association', () => {
  for (const readinessReason of reasons) {
    const event = { ...metric, readinessReason };
    const retained: unknown[] = [];
    const timing = createTimingObserver((recorded) =>
      retained.push(
        cleanDiagnostic({
          ...recorded,
          kind: 'metric',
          raw: 'PRIVATE-health',
        }),
      ),
    );
    timing(event);
    assert.deepEqual(retained, [event]);
  }
});

test('readiness reason rejects arbitrary values and use outside native-readiness end events', () => {
  for (const readinessReason of ['PRIVATE-health', {}, [], 1, null]) {
    const event = { ...metric, readinessReason };
    assert.equal(cleanTimingEvent(event), undefined);
    assert.equal(cleanDiagnostic(event), undefined);
  }
  for (const changes of [{ stage: 'capture' }, { edge: 'start' }, { edge: 'point' }]) {
    const event = { ...metric, readinessReason: 'health', ...changes };
    assert.equal(cleanTimingEvent(event), undefined);
    assert.equal(cleanDiagnostic(event), undefined);
  }
  assert.deepEqual(cleanDiagnostic(metric), metric, 'older metrics remain valid');
});
